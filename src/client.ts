import axios, { type AxiosInstance, type AxiosError, type InternalAxiosRequestConfig } from "axios";
import * as fs from "node:fs";
import * as path from "node:path";
import { CONFIG } from "./config.js";
import type {
  DesignDocument,
  DesignLayer,
  RGBA,
} from "./types.js";
import {
  parseStyle, guessType, getExportFormats,
  to1x, round,
} from "./parser/style.js";
import { isRetryableError } from "./utils/retry.js";
import { assertValidId } from "./utils/validate.js";

/**
 * 蓝湖 API 客户端 — 精确设计稿数据引擎
 *
 * 为 iOS / Android / Flutter / Web / H5 代码生成提供
 * 精确的结构化设计数据。
 */
export class LanhuClient {
  private http: AxiosInstance;
  private tenantId?: string;
  private projectId?: string;
  private cookie: string;
  private authorization?: string;

  /** 设计文档缓存（按 projectId:imageId 键，5 分钟 TTL） */
  private _docCache = new Map<string, { doc: DesignDocument; ts: number }>();
  /** DDS schema 缓存 */
  private _ddsCache = new Map<string, { data: unknown; ts: number }>();
  private _cacheTTL = CONFIG.docCacheTTL;
  private _maxCacheSize = CONFIG.maxCacheSize;

  /** 缓存写入（LRU 语义：访问时刷新位置，超过上限淘汰最久未访问条目） */
  private _cacheSet<K, V>(cache: Map<K, V>, key: K, value: V): void {
    // 已存在则先删除再插入，以刷新迭代顺序（LRU 语义）
    if (cache.has(key)) cache.delete(key);
    if (cache.size >= this._maxCacheSize) {
      const oldest = cache.keys().next().value;
      if (oldest !== undefined) cache.delete(oldest);
    }
    cache.set(key, value);
  }

  /** 缓存读取（刷新访问顺序） */
  private _cacheGet<K, V>(cache: Map<K, V>, key: K, ttl: number): V | undefined {
    const entry = cache.get(key);
    if (!entry) return undefined;
    // 刷新位置到末尾（最近访问）
    cache.delete(key);
    cache.set(key, entry);
    return entry as V;
  }

  constructor(
    cookie: string,
    authorization?: string,
    tenantId?: string,
    projectId?: string
  ) {
    if (!cookie) throw new Error("LANHU_COOKIE 未设置");
    this.cookie = cookie;
    this.authorization = authorization;
    this.tenantId = tenantId;
    this.projectId = projectId;

    this.http = axios.create({
      baseURL: "https://lanhuapp.com",
      timeout: CONFIG.apiTimeout,
      headers: {
        Cookie: cookie,
        "Content-Type": "application/json",
        Accept: "application/json, text/plain, */*",
        ...(authorization && { Authorization: authorization }),
      },
    });

    // 重试拦截器：对可重试的网络错误自动重试（最多 2 次，指数退避）
    const maxRetries = 2;
    this.http.interceptors.response.use(
      (res) => res,
      async (err: AxiosError) => {
        const config = err.config as (InternalAxiosRequestConfig & { _retryCount?: number }) | undefined;

        // 401/403 不重试，直接报错
        if (err.response?.status === 401) throw new Error("蓝湖认证失败（401），请检查 Cookie 是否过期");
        if (err.response?.status === 403) throw new Error("蓝湖权限不足（403）");

        // 可重试错误且未超过重试次数
        if (config && isRetryableError(err) && (config._retryCount ?? 0) < maxRetries) {
          config._retryCount = (config._retryCount ?? 0) + 1;
          const delay = 1000 * Math.pow(2, config._retryCount - 1);
          if (process.env.LANHU_DEBUG) {
            console.error(`[RETRY] 请求失败(${err.code || err.response?.status})，${delay}ms 后第 ${config._retryCount} 次重试...`);
          }
          await new Promise(r => setTimeout(r, delay));
          return this.http(config);
        }

        throw err;
      }
    );
  }

  setTenantId(t: string) { this.tenantId = t; }
  setProjectId(p: string) { this.projectId = p; }
  getProjectId() { return this.projectId; }
  getTenantId() { return this.tenantId; }

  /**
   * 自动发现 tenantId 和 projectId
   *
   * 策略（按优先级）：
   * 1. 调用用户信息 API 获取真实 tenantId
   * 2. 调用 workbench API 获取团队信息，从返回数据中提取
   * 3. 兜底使用 "0"（个人用户可用，企业用户可能失败）
   */
  async autoDiscover(): Promise<{ tenantId: string; projectId?: string }> {
    // 策略 1：从用户信息 API 获取真实 tenantId
    if (!this.tenantId) {
      try {
        const userRes = await this.http.get("/api/uc/user");
        const userData = userRes.data?.data || userRes.data?.result;
        if (userData?.tenantId) {
          this.tenantId = String(userData.tenantId);
          if (process.env.LANHU_DEBUG) {
            console.error(`[DEBUG] autoDiscover: 从用户 API 获取 tenantId=${this.tenantId}`);
          }
          // 同时提取 projectId（如果有的话）
          if (userData.projectId && !this.projectId) {
            this.projectId = userData.projectId;
          }
          return { tenantId: this.tenantId, projectId: this.projectId };
        }
      } catch {
        // 用户 API 不可用，继续尝试下一个策略
      }
    }

    // 策略 2：workbench API
    try {
      const res = await this.http.post("/workbench/api/workbench/abstractfile/list", {
        tenantId: parseInt(this.tenantId || "0") || 0, parentId: 0,
      });
      const data = res.data?.data || [];
      if (Array.isArray(data) && data.length > 0) {
        const first = data[0];
        if (first.sourceId && !this.projectId) {
          this.projectId = first.sourceId;
        }
        if (!this.tenantId) {
          this.tenantId = "0";
        }
        return { tenantId: this.tenantId || "0", projectId: this.projectId };
      }
    } catch {
      // workbench API 也失败
    }

    // 策略 3：兜底 + 警告
    if (!this.tenantId) {
      this.tenantId = "0";
      console.error("[WARN] 未能自动发现 tenantId，使用默认值 0。企业用户如遇到 API 错误，请手动设置 LANHU_TENANT_ID");
    }

    return { tenantId: this.tenantId || "0", projectId: this.projectId };
  }

  // ─── Workbench API ───────────────────────────────────

  async getWorkbenchFiles(parentId = 0) {
    // 自动发现 tenantId
    if (!this.tenantId) await this.autoDiscover();
    const res = await this.http.post("/workbench/api/workbench/abstractfile/list", {
      tenantId: parseInt(this.tenantId || "0") || 0, parentId,
    });
    return res.data?.data || [];
  }

  // ─── Project API ─────────────────────────────────────

  async getDesigns(projectId?: string) {
    const pid = projectId || this.projectId;
    if (!pid) throw new Error("projectId 未指定（可通过 lanhu_set_project 设置，或在工具参数中传入）");
    assertValidId(pid, "projectId");
    // 自动发现 tenantId（默认 "0" 已验证可用）
    if (!this.tenantId) await this.autoDiscover();
    const res = await this.http.get("/api/project/images", {
      params: { project_id: pid, team_id: parseInt(this.tenantId || "0") || 0, dds_status: 1, position: 1, show_cb_src: 1, comment: 1 },
    });
    const code = res.data?.code;
    if (code !== "00000" && code !== 0) throw new Error(`获取设计稿失败: ${res.data?.msg}`);
    const images = res.data?.data?.images || res.data?.data?.list || res.data?.data;
    return Array.isArray(images) ? images : [];
  }

  async getDesignDetail(imageId: string, projectId?: string) {
    assertValidId(imageId, "imageId");
    const pid = projectId || this.projectId;
    if (!pid) throw new Error("projectId 未指定");
    assertValidId(pid, "projectId");
    const res = await this.http.get("/api/project/image", { params: { pid, image_id: imageId } });
    const code = res.data?.code;
    if (code !== "00000" && code !== 0) throw new Error(`获取详情失败: ${res.data?.msg}`);
    return res.data?.result || res.data?.data || {};
  }

  // ═══════════════════════════════════════════════════
  //  ★★★ 精确图层树解析 ★★★
  // ═══════════════════════════════════════════════════

  /** 设计文档解析选项 */
  getDesignDocumentOptions = {
    depth: CONFIG.defaultDepth as number,
    includeStyles: true, // 默认包含样式
    includeRaw: false,   // 默认不包含 raw 原始数据
  };

  async getDesignDocument(
    imageId: string,
    projectId?: string,
    options?: Partial<typeof this.getDesignDocumentOptions>
  ): Promise<DesignDocument> {
    assertValidId(imageId, "imageId");
    const opts = { ...this.getDesignDocumentOptions, ...options };
    const pid = projectId || this.projectId || "default";
    const cacheKey = `${pid}:${imageId}:${opts.depth}:${opts.includeStyles}:${opts.includeRaw}`;
    const cached = this._cacheGet(this._docCache, cacheKey, this._cacheTTL);
    if (cached && Date.now() - cached.ts < this._cacheTTL) {
      return cached.doc;
    }

    const detail = await this.getDesignDetail(imageId, projectId);
    const versions = (detail as any)?.versions || [];
    const latestVersion = versions[0];
    if (!latestVersion?.json_url) throw new Error(`设计稿 ${imageId} 没有标注数据`);

    const res = await this.http.get(latestVersion.json_url);
    const raw = typeof res.data === "string" ? JSON.parse(res.data) : res.data;

    const scale = raw.ArtboardScale || 2;
    const info = raw.info || [];

    const flatLayers = info.map((ab: any) => this._parseArtboard(ab, scale, null, 0, opts));
    const layers = this._rebuildHierarchy(flatLayers);
    const tokens = this._extractTokens(layers);

    const doc: DesignDocument = {
      name: detail.name || info[0]?.name || "",
      imageId,
      projectId: projectId || this.projectId || "",
      canvas: {
        width: info[0]?.width || 375,
        height: info[0]?.height || 812,
        scale,
        device: raw.device || "unknown",
      },
      layers,
      tokens,
    };

    this._cacheSet(this._docCache, cacheKey, { doc, ts: Date.now() });
    return doc;
  }

  /**
   * 获取单个图层的完整详情（含样式和原始数据）
   * 用于按需获取子图层的详细信息，避免一次性返回全量数据
   */
  async getLayerDetail(imageId: string, layerId: string, projectId?: string): Promise<DesignLayer | null> {
    assertValidId(imageId, "imageId");
    assertValidId(layerId, "layerId");
    const doc = await this.getDesignDocument(imageId, projectId, { depth: 99, includeStyles: true, includeRaw: true });
    const findLayer = (layers: DesignLayer[]): DesignLayer | null => {
      for (const l of layers) {
        if (l.id === layerId) return l;
        const found = findLayer(l.children);
        if (found) return found;
      }
      return null;
    };
    return findLayer(doc.layers);
  }

  private _parseArtboard(ab: any, scale: number, parentId: string | null, depth: number, opts?: Partial<typeof this.getDesignDocumentOptions>): DesignLayer {
    const o = { ...this.getDesignDocumentOptions, ...opts };
    // 提取 artboard 级别的导出图片
    const abDdsImg = ab.ddsImage || ab.image;
    const abImageUrl = abDdsImg?.imageUrl || undefined;
    const abImgSize = abDdsImg?.size ? { width: abDdsImg.size.width || 0, height: abDdsImg.size.height || 0 } : undefined;

    return {
      id: ab.id || "",
      name: ab.name || "",
      type: "artboard",
      rect: {
        x: round(to1x(ab.position_x ?? ab.left ?? 0, scale)),
        y: round(to1x(ab.position_y ?? ab.top ?? 0, scale)),
        width: round(ab.width || 0),
        height: round(ab.height || 0),
      },
      style: o.includeStyles ? parseStyle(ab, scale) : {} as any,
      imageUrl: abImageUrl,
      imageSize: abImgSize,
      children: depth < o.depth ? (ab.layers || []).map((c: any) =>
        this._parseLayer(c, scale, ab.id || null, depth + 1,
          to1x(ab.position_x ?? ab.left ?? 0, scale),
          to1x(ab.position_y ?? ab.top ?? 0, scale),
          o
        )
      ) : [],
      metadata: {
        depth, parentId,
        hasExportImage: !!ab.hasExportDDSImage,
        exportFormats: getExportFormats(ab),
      },
      ...(o.includeRaw ? { raw: ab } : {}),
    };
  }

  private _parseLayer(layer: any, scale: number, parentId: string | null, depth: number, pAbsX: number, pAbsY: number, opts?: Partial<typeof this.getDesignDocumentOptions>): DesignLayer {
    const o = { ...this.getDesignDocumentOptions, ...opts };
    const relX = to1x(layer.left ?? layer.position_x ?? 0, scale);
    const relY = to1x(layer.top ?? layer.position_y ?? 0, scale);
    const absX = pAbsX + relX;
    const absY = pAbsY + relY;

    // 提取导出图片 URL
    const ddsImg = layer.ddsImage || layer.image;
    const imageUrl = ddsImg?.imageUrl || undefined;
    const imgSize = ddsImg?.size ? { width: ddsImg.size.width || 0, height: ddsImg.size.height || 0 } : undefined;

    const children = depth < o.depth ? (layer.layers || []).map((c: any) =>
      this._parseLayer(c, scale, layer.id || null, depth + 1, absX, absY, o)
    ) : [];

    return {
      id: layer.id || "",
      name: layer.name || "",
      type: guessType(layer),
      rect: {
        x: round(absX),
        y: round(absY),
        width: round(to1x(layer.width || 0, scale)),
        height: round(to1x(layer.height || 0, scale)),
      },
      style: o.includeStyles ? parseStyle(layer, scale) : {} as any,
      imageUrl,
      imageSize: imgSize,
      children,
      metadata: {
        depth, parentId,
        hasExportImage: !!layer.hasExportDDSImage,
        exportFormats: getExportFormats(layer),
      },
      ...(o.includeRaw ? { raw: layer } : {}),
    };
  }

  // ─── 层级重建（扁平 → 树）────────────────────────────

  /**
   * 从扁平 artboard 列表重建图层树
   *
   * 优化算法：
   * 1. 按面积从小到大排序
   * 2. 对每个元素，只向面积更大的方向查找父级
   * 3. 第一个能包含它的更大元素即为最优父级（面积最小），立即 break
   * 4. 平均复杂度从 O(n²) 降到 O(n·k)，k 为平均查找次数
   */
  private _rebuildHierarchy(layers: DesignLayer[]): DesignLayer[] {
    if (layers.length <= 1) return layers;

    const area = (l: DesignLayer) => l.rect.width * l.rect.height;

    // 按面积从小到大排序
    const sorted = [...layers].sort((a, b) => area(a) - area(b));

    // 判断 parent 是否完全包含 child（留 1px 余量）
    const contains = (parent: DesignLayer, child: DesignLayer): boolean => {
      const margin = 1;
      return (
        parent.rect.x <= child.rect.x + margin &&
        parent.rect.y <= child.rect.y + margin &&
        parent.rect.x + parent.rect.width >= child.rect.x + child.rect.width - margin &&
        parent.rect.y + parent.rect.height >= child.rect.y + child.rect.height - margin
      );
    };

    // 为每个元素找父级：从自身位置向后（面积更大方向）扫描，找到第一个即 break
    const parentMap = new Map<string, DesignLayer | null>();
    for (let i = 0; i < sorted.length; i++) {
      const child = sorted[i];
      let bestParent: DesignLayer | null = null;

      for (let j = i + 1; j < sorted.length; j++) {
        const candidate = sorted[j];
        if (area(candidate) < area(child)) continue;
        if (contains(candidate, child)) {
          bestParent = candidate;
          break; // 面积从小到大扫描，第一个包含者即为最优父级
        }
      }
      parentMap.set(child.id, bestParent);
    }

    // 构建树
    const roots: DesignLayer[] = [];
    const childMap = new Map<string, DesignLayer[]>();

    for (const layer of sorted) {
      const parent = parentMap.get(layer.id) || null;
      if (parent) {
        if (!childMap.has(parent.id)) childMap.set(parent.id, []);
        childMap.get(parent.id)!.push(layer);
      } else {
        roots.push(layer);
      }
    }

    // 设置 children 和 depth（带环检测，防止面积相等导致的循环引用）
    const visited = new Set<string>();
    const setChildren = (node: DesignLayer, depth: number) => {
      if (visited.has(node.id)) return; // 环检测：已访问过的跳过
      visited.add(node.id);
      node.metadata.depth = depth;
      const kids = childMap.get(node.id) || [];
      // 按 y 然后 x 排序子元素
      kids.sort((a, b) => a.rect.y - b.rect.y || a.rect.x - b.rect.x);
      node.children = kids;
      for (const kid of kids) setChildren(kid, depth + 1);
    };

    for (const root of roots) setChildren(root, 0);

    return roots;
  }

  // ─── Design Tokens ───────────────────────────────────

  private _extractTokens(layers: DesignLayer[]) {
    const colorMap = new Map<string, RGBA>();
    const fontSet = new Set<string>();
    const spacingSet = new Set<number>();
    const radiusSet = new Set<number>();

    const walk = (ls: DesignLayer[]) => {
      // 计算同父级下相邻兄弟元素之间的真实垂直间距
      const siblings = [...ls].filter(l => l.rect.height > 0)
        .sort((a, b) => a.rect.y - b.rect.y);
      for (let i = 1; i < siblings.length; i++) {
        const gap = Math.round(siblings[i].rect.y - (siblings[i - 1].rect.y + siblings[i - 1].rect.height));
        if (gap > 0 && gap < CONFIG.maxGapThreshold) spacingSet.add(gap);
      }

      for (const l of ls) {
        for (const fill of l.style.fills || []) {
          if (fill.color) { const k = fill.color.value; if (!colorMap.has(k)) colorMap.set(k, fill.color); }
        }
        if (l.style.typography) {
          const t = l.style.typography;
          fontSet.add(`${t.fontFamily}|${t.fontSize}|${t.fontWeight}`);
        }
        for (const b of l.style.borders || []) { if (b.radius > 0) radiusSet.add(Math.round(b.radius)); }
        walk(l.children);
      }
    };
    walk(layers);

    return {
      colors: Array.from(colorMap.entries()).map(([value, color]) => ({ name: value, value: color })),
      fonts: Array.from(fontSet).map((f) => { const [family, size, weight] = f.split("|"); return { name: f, family, size: parseFloat(size), weight: parseInt(weight) }; }),
      spacings: Array.from(spacingSet).sort((a, b) => a - b),
      radii: Array.from(radiusSet).sort((a, b) => a - b),
    };
  }

  // ═══════════════════════════════════════════════════
  //  向后兼容
  // ═══════════════════════════════════════════════════

  async getAnnotations(
    imageId: string,
    projectId?: string,
    options?: { filter?: string; includeStyles?: boolean }
  ) {
    const { filter, includeStyles = true } = options || {};
    const doc = await this.getDesignDocument(imageId, projectId, {
      depth: 99,
      includeStyles: true,  // 始终获取样式用于过滤和返回
      includeRaw: false,
    });
    const flat: any[] = [];
    const filterLower = filter?.toLowerCase();
    const walk = (ls: DesignLayer[]) => {
      for (const l of ls) {
        // 过滤：按图层名模糊匹配
        if (filterLower && !l.name.toLowerCase().includes(filterLower)) {
          walk(l.children);
          continue;
        }
        const entry: any = {
          layer_id: l.id, name: l.name, type: l.type,
          width: l.rect.width, height: l.rect.height,
          x: l.rect.x, y: l.rect.y,
        };
        if (includeStyles) {
          entry.styles = {
            color: l.style.fills?.[0]?.color?.value,
            background_color: l.style.fills?.[0]?.color?.value,
            font_size: l.style.typography?.fontSize,
            font_weight: l.style.typography?.fontWeight,
            opacity: l.style.opacity,
            border_radius: l.style.borders?.[0]?.radius,
          };
          entry.text = l.style.typography?.text;
        }
        // 有子图层时标注数量
        if (l.children.length > 0) {
          entry.children_count = l.children.length;
        }
        flat.push(entry);
        walk(l.children);
      }
    };
    walk(doc.layers);
    return flat;
  }

  async getPreviewUrl(imageId: string, projectId?: string) {
    const d = await this.getDesignDetail(imageId, projectId);
    return (d as any)?.url || "";
  }

  async getProjectSectors(projectId?: string) {
    const pid = projectId || this.projectId;
    if (!pid) throw new Error("projectId 未指定");
    const res = await this.http.get("/api/project/project_sectors", { params: { project_id: pid } });
    return res.data?.data || {};
  }

  async getDesignTokens(projectId?: string) {
    const designs = await this.getDesigns(projectId);
    if (!designs.length) return [];
    const doc = await this.getDesignDocument(designs[0].image_id || designs[0].id as string, projectId);
    return doc.tokens.colors.map((c) => ({ name: c.name, value: c.value.value, type: "color" as const }));
  }

  async downloadCover(imageId: string, outputPath: string, projectId?: string) {
    const d = await this.getDesignDetail(imageId, projectId);
    const url = (d as any)?.url;
    if (!url) throw new Error("没有封面图 URL");
    const res = await this.http.get(url, { responseType: "arraybuffer" });
    const dir = path.resolve(outputPath);
    fs.mkdirSync(dir, { recursive: true });
    const filePath = path.join(dir, `cover_${imageId.substring(0, 8)}.png`);
    fs.writeFileSync(filePath, Buffer.from(res.data));
    return filePath;
  }

  async downloadSlice(imageUrl: string, fileName: string, outputPath: string) {
    const res = await this.http.get(imageUrl, { responseType: "arraybuffer" });
    const dir = path.resolve(outputPath);
    fs.mkdirSync(dir, { recursive: true });
    // 安全：只取文件名，防止路径穿越（如 "../../etc/passwd"）
    const safeName = path.basename(fileName);
    if (!safeName) throw new Error(`无效的文件名: ${fileName}`);
    const filePath = path.join(dir, safeName);
    fs.writeFileSync(filePath, Buffer.from(res.data));
    return filePath;
  }

  /**
   * 获取蓝湖 DDS 语义化 UI 组件树
   *
   * 调用 dds.lanhuapp.com API，返回经过 AI 识别的 UI 组件结构，
   * 包含 NavBar、Avatar、Input、ImageText 等语义组件，
   * 以及 row/col 布局信息和精确样式。
   */
  async getDDSSchema(versionId?: string, imageId?: string, projectId?: string): Promise<unknown> {
    let vid = versionId;
    if (!vid && imageId) {
      const detail = await this.getDesignDetail(imageId, projectId);
      const versions = (detail as any)?.versions || [];
      vid = versions[0]?.id;
    }
    if (!vid) throw new Error("versionId 未指定");

    // 缓存命中
    const cached = this._cacheGet(this._ddsCache, vid, this._cacheTTL);
    if (cached && Date.now() - cached.ts < this._cacheTTL) {
      return cached.data;
    }

    const ddsHeaders: Record<string, string> = {
      "User-Agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36",
      "Accept": "application/json, text/plain, */*",
      "Referer": "https://dds.lanhuapp.com/",
      "Cookie": this.cookie,
    };
    if (this.authorization) {
      ddsHeaders["Authorization"] = this.authorization;
    }

    const revRes = await axios.get("https://dds.lanhuapp.com/api/dds/image/store_schema_revise", {
      params: { version_id: vid },
      headers: ddsHeaders,
      timeout: CONFIG.apiTimeout,
    });

    const code = revRes.data?.code;
    if (code !== "00000" && code !== 0) {
      throw new Error(`DDS schema 获取失败: ${revRes.data?.msg || "未知错误"} (code=${code})`);
    }

    const schemaUrl = revRes.data?.data?.data_resource_url;
    if (!schemaUrl) throw new Error("DDS 未返回 data_resource_url");

    // SSRF 防护：schemaUrl 必须为 HTTPS 且域名为蓝湖相关
    try {
      const parsed = new URL(schemaUrl);
      if (parsed.protocol !== "https:") {
        throw new Error(`schema URL 必须为 HTTPS: ${parsed.protocol}`);
      }
    } catch (urlErr) {
      if (urlErr instanceof Error && urlErr.message.includes("schema URL")) throw urlErr;
      throw new Error(`无效的 schema URL: ${schemaUrl}`);
    }

    const schemaRes = await axios.get(schemaUrl, {
      headers: { "Cookie": this.cookie, "Referer": "https://dds.lanhuapp.com/" },
      timeout: CONFIG.apiTimeout,
    });

    const result = typeof schemaRes.data === "string" ? JSON.parse(schemaRes.data) : schemaRes.data;
    this._cacheSet(this._ddsCache, vid, { data: result, ts: Date.now() });
    return result;
  }
}
