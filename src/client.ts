import axios, { type AxiosInstance } from "axios";
import * as fs from "node:fs";
import * as path from "node:path";
import type {
  DesignDocument,
  DesignLayer,
  LayerType,
  LayerStyle,
  Fill,
  Border,
  Shadow,
  Typography,
  RGBA,
  Rect,
} from "./types.js";

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
      timeout: 15000,
      headers: {
        Cookie: cookie,
        "Content-Type": "application/json",
        Accept: "application/json, text/plain, */*",
        ...(authorization && { Authorization: authorization }),
      },
    });

    this.http.interceptors.response.use(
      (res) => res,
      (err) => {
        if (err.response?.status === 401) throw new Error("蓝湖认证失败（401）");
        if (err.response?.status === 403) throw new Error("蓝湖权限不足（403）");
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
   * 策略：
   * 1. 调用 workbench API 获取团队信息，提取 tenantId
   * 2. 从团队信息中提取第一个项目的 projectId
   */
  async autoDiscover(): Promise<{ tenantId: string; projectId?: string }> {
    // 尝试用 tenantId=0 调用 workbench API，从返回数据中提取真实 tenantId
    try {
      const res = await this.http.post("/workbench/api/workbench/abstractfile/list", {
        tenantId: 0, parentId: 0,
      });
      const data = res.data?.data || [];
      if (Array.isArray(data) && data.length > 0) {
        // 从返回的项目中提取 tenantId（sourceId 即 projectId）
        const first = data[0];
        if (first.sourceId) {
          this.projectId = this.projectId || first.sourceId;
        }
        // workbench API 不直接返回 tenantId，但成功说明 tenantId=0 可用
        if (!this.tenantId) {
          this.tenantId = "0";
        }
      }
    } catch {
      // workbench API 失败，tenantId 默认用 "0"（已验证可用）
      if (!this.tenantId) this.tenantId = "0";
    }

    return { tenantId: this.tenantId || "0", projectId: this.projectId };
  }

  // ─── Workbench API ───────────────────────────────────

  async getWorkbenchFiles(parentId = 0) {
    // 自动发现 tenantId
    if (!this.tenantId) await this.autoDiscover();
    const res = await this.http.post("/workbench/api/workbench/abstractfile/list", {
      tenantId: parseInt(this.tenantId || "0"), parentId,
    });
    return res.data?.data || [];
  }

  // ─── Project API ─────────────────────────────────────

  async getDesigns(projectId?: string) {
    const pid = projectId || this.projectId;
    if (!pid) throw new Error("projectId 未指定（可通过 lanhu_set_project 设置，或在工具参数中传入）");
    // 自动发现 tenantId（默认 "0" 已验证可用）
    if (!this.tenantId) await this.autoDiscover();
    const res = await this.http.get("/api/project/images", {
      params: { project_id: pid, team_id: parseInt(this.tenantId || "0"), dds_status: 1, position: 1, show_cb_src: 1, comment: 1 },
    });
    const code = res.data?.code;
    if (code !== "00000" && code !== 0) throw new Error(`获取设计稿失败: ${res.data?.msg}`);
    const images = res.data?.data?.images || res.data?.data?.list || res.data?.data;
    return Array.isArray(images) ? images : [];
  }

  async getDesignDetail(imageId: string, projectId?: string) {
    const pid = projectId || this.projectId;
    if (!pid) throw new Error("projectId 未指定");
    const res = await this.http.get("/api/project/image", { params: { pid, image_id: imageId } });
    const code = res.data?.code;
    if (code !== "00000" && code !== 0) throw new Error(`获取详情失败: ${res.data?.msg}`);
    return res.data?.result || res.data?.data || {};
  }

  // ═══════════════════════════════════════════════════
  //  ★★★ 精确图层树解析 ★★★
  // ═══════════════════════════════════════════════════

  async getDesignDocument(imageId: string, projectId?: string): Promise<DesignDocument> {
    const detail = await this.getDesignDetail(imageId, projectId);
    const versions = (detail as any)?.versions || [];
    const latestVersion = versions[0];
    if (!latestVersion?.json_url) throw new Error(`设计稿 ${imageId} 没有标注数据`);

    const res = await this.http.get(latestVersion.json_url);
    const raw = typeof res.data === "string" ? JSON.parse(res.data) : res.data;

    const scale = raw.ArtboardScale || 2;
    const info = raw.info || [];

    const flatLayers = info.map((ab: any) => this._parseArtboard(ab, scale, null, 0));
    const layers = this._rebuildHierarchy(flatLayers);
    const tokens = this._extractTokens(layers);

    return {
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
  }

  private _parseArtboard(ab: any, scale: number, parentId: string | null, depth: number): DesignLayer {
    // 提取 artboard 级别的导出图片
    const abDdsImg = ab.ddsImage || ab.image;
    const abImageUrl = abDdsImg?.imageUrl || undefined;
    const abImgSize = abDdsImg?.size ? { width: abDdsImg.size.width || 0, height: abDdsImg.size.height || 0 } : undefined;

    return {
      id: ab.id || "",
      name: ab.name || "",
      type: "artboard",
      rect: {
        x: this._round(this._to1x(ab.position_x ?? ab.left ?? 0, scale)),
        y: this._round(this._to1x(ab.position_y ?? ab.top ?? 0, scale)),
        width: this._round(ab.width || 0),
        height: this._round(ab.height || 0),
      },
      style: this._parseStyle(ab, scale),
      imageUrl: abImageUrl,
      imageSize: abImgSize,
      children: (ab.layers || []).map((c: any) =>
        this._parseLayer(c, scale, ab.id || null, depth + 1,
          this._to1x(ab.position_x ?? ab.left ?? 0, scale),
          this._to1x(ab.position_y ?? ab.top ?? 0, scale)
        )
      ),
      metadata: {
        depth, parentId,
        hasExportImage: !!ab.hasExportDDSImage,
        exportFormats: this._getExportFormats(ab),
      },
      raw: ab,
    };
  }

  private _parseLayer(layer: any, scale: number, parentId: string | null, depth: number, pAbsX: number, pAbsY: number): DesignLayer {
    const relX = this._to1x(layer.left ?? layer.position_x ?? 0, scale);
    const relY = this._to1x(layer.top ?? layer.position_y ?? 0, scale);
    const absX = pAbsX + relX;
    const absY = pAbsY + relY;

    // 提取导出图片 URL
    const ddsImg = layer.ddsImage || layer.image;
    const imageUrl = ddsImg?.imageUrl || undefined;
    const imgSize = ddsImg?.size ? { width: ddsImg.size.width || 0, height: ddsImg.size.height || 0 } : undefined;

    const children = (layer.layers || []).map((c: any) =>
      this._parseLayer(c, scale, layer.id || null, depth + 1, absX, absY)
    );

    return {
      id: layer.id || "",
      name: layer.name || "",
      type: this._guessType(layer),
      rect: {
        x: this._round(absX),
        y: this._round(absY),
        width: this._round(this._to1x(layer.width || 0, scale)),
        height: this._round(this._to1x(layer.height || 0, scale)),
      },
      style: this._parseStyle(layer, scale),
      imageUrl,
      imageSize: imgSize,
      children,
      metadata: {
        depth, parentId,
        hasExportImage: !!layer.hasExportDDSImage,
        exportFormats: this._getExportFormats(layer),
      },
      raw: layer,
    };
  }

  // ─── 样式解析 ────────────────────────────────────────

  private _parseStyle(raw: any, scale: number): LayerStyle {
    return {
      fills: this._parseFills(raw.fills, scale),
      borders: this._parseBorders(raw.borders, scale),
      shadows: this._parseShadows(raw.shadows, scale),
      opacity: raw.style?.opacity ?? raw.opacity ?? 1,
      blendMode: raw.style?.blendMode || "normal",
      visible: raw.isVisible ?? raw.visible ?? true,
      locked: raw.isLocked ?? raw.locked ?? false,
      rotation: raw.rotation ?? raw.style?.rotation ?? 0,
      typography: this._parseTypography(raw, scale),
    };
  }

  private _parseFills(rawFills: any[], _scale: number): Fill[] {
    if (!rawFills?.length) return [];
    return rawFills.map((f: any): Fill => {
      if (f.type === "color") {
        return { type: "color", color: f.color ? this._parseRGBA(f.color) : undefined, opacity: f.opacity ?? 1 };
      }
      if (f.type === "gradient") {
        return {
          type: "gradient",
          gradient: {
            type: f.gradientType || "linear",
            from: { x: f.from?.x || 0, y: f.from?.y || 0 },
            to: { x: f.to?.x || 1, y: f.to?.y || 1 },
            stops: (f.stops || []).map((s: any) => ({ color: this._parseRGBA(s.color), position: s.position || 0 })),
          },
          opacity: f.opacity ?? 1,
        };
      }
      if (f.type === "image") {
        return { type: "image", image: { url: f.image?.url, mode: f.fillMode || "fill" }, opacity: f.opacity ?? 1 };
      }
      return { type: "color", opacity: f.opacity ?? 1 };
    });
  }

  private _parseBorders(rawBorders: any[], scale: number): Border[] {
    if (!rawBorders?.length) return [];
    return rawBorders.map((b: any): Border => ({
      color: b.color ? this._parseRGBA(b.color) : undefined,
      width: this._round(this._to1x(b.thickness ?? b.width ?? 1, scale)),
      style: b.dashPattern?.length ? "dashed" : "solid",
      radius: this._round(this._to1x(b.radius ?? 0, scale)),
    }));
  }

  private _parseShadows(rawShadows: any[], scale: number): Shadow[] {
    if (!rawShadows?.length) return [];
    return rawShadows.map((s: any): Shadow => ({
      color: this._parseRGBA(s.color || { r: 0, g: 0, b: 0, a: 0.25 }),
      offsetX: this._round(this._to1x(s.offsetX ?? s.x ?? 0, scale)),
      offsetY: this._round(this._to1x(s.offsetY ?? s.y ?? 0, scale)),
      blur: this._round(this._to1x(s.blurRadius ?? s.blur ?? 0, scale)),
      spread: this._round(this._to1x(s.spread ?? 0, scale)),
      inset: !!s.inset,
    }));
  }

  /**
   * 排版解析 — 只在有真实文本数据时才返回
   * 关键修复：不再 fallback 到 layer.name
   */
  private _parseTypography(raw: any, scale: number): Typography | undefined {
    const style = raw.style || {};
    const textContent = raw.text?.text;

    // 非文本元素名称黑名单
    const nonTextPatterns = [
      /^蒙版$/, /^矩形$/, /^圆形$/, /^椭圆$/,
      /^编组(\s*\d+)?$/, /^路径(\s*\d+)?$/,
      /^形状$/, /^箭头$/, /^防护$/,
      /^Border$/, /^Cap$/, /^Capacity$/, /^Wifi$/,
      /^Vector$/, /^Group\s*\d+$/, /^Rectangle\s*\d+$/,
      /^顶部背景$/, /^浅色状态栏$/, /^底部栏/,
      /^形状结合$/, /^花瓣素材/, /^91977b5d/,
      /^B1\.\d/,  // 设计稿名称如 "B1.0客户管理-默认样式"
    ];

    // 有明确字体数据 → 一定是文本
    if (style.fontSize || style.fontFamily || style.lineHeight || style.textColor) {
      if (nonTextPatterns.some(p => p.test(raw.name)) && !textContent) return undefined;
      return this._buildTypography(raw, style, textContent, scale);
    }

    // 无字体数据，但 name 像文本（非形状/容器名，且尺寸像文本）
    if (textContent || (!nonTextPatterns.some(p => p.test(raw.name)) && raw.name && raw.name.length <= 30 && (raw.width || 0) < 200 && (raw.height || 0) < 40)) {
      if (nonTextPatterns.some(p => p.test(raw.name))) return undefined;
      return this._buildTypography(raw, style, textContent, scale);
    }

    return undefined;
  }

  private _buildTypography(raw: any, style: any, textContent: string | undefined, scale: number): Typography {
    return {
      fontFamily: style.fontFamily || "PingFang SC",
      fontSize: this._round(this._to1x(style.fontSize || 14, scale)),
      fontWeight: style.fontWeight || 400,
      lineHeight: this._round(this._to1x(style.lineHeight || style.fontSize || 14, scale)),
      letterSpacing: this._round(this._to1x(style.kerning ?? style.letterSpacing ?? 0, scale)),
      textAlign: style.textAlign || "left",
      color: style.textColor ? this._parseRGBA(style.textColor) : { r: 26, g: 26, b: 26, a: 1, value: "#1A1A1A" },
      text: textContent || raw.name || "",
    };
  }

  // ─── 工具方法 ────────────────────────────────────────

  private _to1x(value: number, scale: number): number {
    return scale > 1 ? value / scale : value;
  }

  private _round(v: number): number {
    return Math.round(v * 100) / 100;
  }

  private _parseRGBA(c: any): RGBA {
    const r = Math.round(c.r ?? 0);
    const g = Math.round(c.g ?? 0);
    const b = Math.round(c.b ?? 0);
    const a = c.a ?? 1;
    return { r, g, b, a, value: `rgba(${r},${g},${b},${a})` };
  }

  private _guessType(raw: any): LayerType {
    // 文本判断：有 text.text 字段
    if (raw.text?.text !== undefined) return "text";
    // 有字体样式且名称像文本
    if (raw.style?.fontSize && !this._isShapeName(raw.name)) return "text";
    if (raw.ddsType === "artboard-group") return "artboard";
    if (raw.fills?.some((f: any) => f.type === "image")) return "image";
    if (raw.layers?.length) return "group";
    if (raw.symbolID) return "symbol";
    if (raw.points || raw.shapeType) return "shape";
    // 名称暗示类型
    if (this._isShapeName(raw.name)) return "shape";
    return "unknown";
  }

  private _isShapeName(name: string): boolean {
    return /^(矩形|圆形|椭圆|路径|形状|编组|蒙版|Border|Cap|Vector|Group|Rectangle)/.test(name);
  }

  private _getExportFormats(raw: any): string[] {
    const exports = raw.exportOptions || raw.exportFormats || [];
    if (Array.isArray(exports)) return exports.map((e: any) => e.format || e.type || "png");
    if (raw.hasExportDDSImage) return ["png"];
    return [];
  }

  // ─── 层级重建（扁平 → 树）────────────────────────────

  /**
   * 从扁平 artboard 列表重建图层树
   *
   * 算法：
   * 1. 计算每个元素的边界框（绝对坐标）
   * 2. 按面积从小到大排序（小元素更可能是子元素）
   * 3. 对每个元素，找能完全包含它的最小元素作为父级
   * 4. 构建 children 关系
   */
  private _rebuildHierarchy(layers: DesignLayer[]): DesignLayer[] {
    if (layers.length <= 1) return layers;

    // 计算面积
    const area = (l: DesignLayer) => l.rect.width * l.rect.height;

    // 按面积从小到大排序
    const sorted = [...layers].sort((a, b) => area(a) - area(b));

    // 判断 b 是否完全包含 a（留 1px 余量）
    const contains = (parent: DesignLayer, child: DesignLayer): boolean => {
      const margin = 1;
      return (
        parent.rect.x <= child.rect.x + margin &&
        parent.rect.y <= child.rect.y + margin &&
        parent.rect.x + parent.rect.width >= child.rect.x + child.rect.width - margin &&
        parent.rect.y + parent.rect.height >= child.rect.y + child.rect.height - margin &&
        area(parent) > area(child) // 父级必须更大
      );
    };

    // 为每个元素找父级
    const parentMap = new Map<string, DesignLayer | null>();
    for (const child of sorted) {
      let bestParent: DesignLayer | null = null;
      let bestArea = Infinity;

      for (const candidate of sorted) {
        if (candidate.id === child.id) continue;
        if (contains(candidate, child) && area(candidate) < bestArea) {
          bestParent = candidate;
          bestArea = area(candidate);
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

    // 设置 children 和 depth
    const setChildren = (node: DesignLayer, depth: number) => {
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
        if (gap > 0 && gap < 200) spacingSet.add(gap); // 过滤异常值
      }

      for (const l of ls) {
        for (const fill of l.style.fills) {
          if (fill.color) { const k = fill.color.value; if (!colorMap.has(k)) colorMap.set(k, fill.color); }
        }
        if (l.style.typography) {
          const t = l.style.typography;
          fontSet.add(`${t.fontFamily}|${t.fontSize}|${t.fontWeight}`);
        }
        for (const b of l.style.borders) { if (b.radius > 0) radiusSet.add(Math.round(b.radius)); }
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

  async getAnnotations(imageId: string, projectId?: string) {
    const doc = await this.getDesignDocument(imageId, projectId);
    const flat: any[] = [];
    const walk = (ls: DesignLayer[]) => {
      for (const l of ls) {
        flat.push({
          layer_id: l.id, name: l.name, type: l.type,
          width: l.rect.width, height: l.rect.height,
          x: l.rect.x, y: l.rect.y,
          styles: {
            color: l.style.fills[0]?.color?.value,
            background_color: l.style.fills[0]?.color?.value,
            font_size: l.style.typography?.fontSize,
            font_weight: l.style.typography?.fontWeight,
            opacity: l.style.opacity,
            border_radius: l.style.borders[0]?.radius,
          },
          text: l.style.typography?.text,
        });
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
    const filePath = path.join(dir, fileName);
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

    const ddsHeaders = {
      "User-Agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36",
      "Accept": "application/json, text/plain, */*",
      "Referer": "https://dds.lanhuapp.com/",
      "Cookie": this.cookie,
      "Authorization": this.authorization || "Basic dW5kZWZpbmVkOg==",
    };

    const revRes = await axios.get("https://dds.lanhuapp.com/api/dds/image/store_schema_revise", {
      params: { version_id: vid },
      headers: ddsHeaders,
      timeout: 15000,
    });

    const code = revRes.data?.code;
    if (code !== "00000" && code !== 0) {
      throw new Error(`DDS schema 获取失败: ${revRes.data?.msg || "未知错误"} (code=${code})`);
    }

    const schemaUrl = revRes.data?.data?.data_resource_url;
    if (!schemaUrl) throw new Error("DDS 未返回 data_resource_url");

    const schemaRes = await axios.get(schemaUrl, {
      headers: { "Cookie": this.cookie, "Referer": "https://dds.lanhuapp.com/" },
      timeout: 15000,
    });

    return typeof schemaRes.data === "string" ? JSON.parse(schemaRes.data) : schemaRes.data;
  }
}
