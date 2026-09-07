/**
 * HTTP 开发服务器
 *
 * 用于浏览器测试 MCP 工具，绕过 stdio 传输层。
 * 直接调用 LanhuClient 方法，通过 REST API 暴露给前端。
 *
 * 凭证通过页面输入（Cookie / Authorization），也可通过环境变量预填。
 *
 * 启动: npm run dev:server
 * 访问: http://localhost:3900
 */
import * as http from "node:http";
import * as fs from "node:fs";
import * as path from "node:path";
import * as url from "node:url";
import { LanhuClient } from "./client.js";
import { generateVueCode, generateHTMLCode, type DDSNode } from "./dds-codegen.js";
import type { DesignDocument, DesignLayer } from "./types.js";
import { downloadDesign } from "./dds-puppeteer.js";
import * as os from "node:os";

const PORT = parseInt(process.env.LANHU_DEV_PORT || "3900", 10);
const PUBLIC_DIR = path.join(path.dirname(url.fileURLToPath(import.meta.url)), "..", "public");

// ─── 多客户端缓存（按 cookie+auth+projectId 键）────────

const clientCache = new Map<string, LanhuClient>();

function getClientKey(cookie: string, auth: string, projectId?: string): string {
  return `${cookie}:${auth}:${projectId || ""}`;
}

function getClient(cookie: string, auth?: string, projectId?: string): LanhuClient {
  if (!cookie) {
    throw new Error("Cookie 未设置，请在页面左上角输入蓝湖 Cookie");
  }
  const key = getClientKey(cookie, auth || "", projectId);
  let client = clientCache.get(key);
  if (!client) {
    client = new LanhuClient(cookie, auth, undefined, projectId);
    clientCache.set(key, client);
  }
  return client;
}

// ─── 从请求参数提取凭证 ───────────────────────────────

function extractCredentials(params: any): { cookie: string; auth?: string } {
  const cookie = params.__cookie || process.env.LANHU_COOKIE || "";
  const auth = params.__auth || process.env.LANHU_AUTHORIZATION || "";
  // 清理内部字段
  delete params.__cookie;
  delete params.__auth;
  return { cookie, auth: auth || undefined };
}

// ─── 从图层树收集所有图片 URL ────────────────────────

function collectImageUrls(layers: DesignLayer[]): string[] {
  const urls: string[] = [];
  function walk(nodes: DesignLayer[]) {
    for (const node of nodes) {
      if (node.imageUrl) urls.push(node.imageUrl);
      if (node.children) walk(node.children);
    }
  }
  walk(layers);
  return urls;
}

// ─── 将图片 URL 注入生成的 HTML（替换空 src=""）──────

function injectImageUrls(html: string, imageUrls: string[]): string {
  if (!imageUrls.length) return html;
  let idx = 0;
  return html.replace(/(<img[^>]*?)src=""/g, (_match, prefix: string) => {
    const url = imageUrls[idx++] || "";
    return `${prefix}src="${url}"`;
  });
}

// ─── 工具方法映射 ──────────────────────────────────────

const TOOL_HANDLERS: Record<string, (params: any, cookie: string, auth?: string) => Promise<any>> = {
  lanhu_list_projects: async ({ parentId }, cookie, auth) => {
    return getClient(cookie, auth).getWorkbenchFiles(parentId || "0");
  },

  lanhu_get_designs: async ({ projectId }, cookie, auth) => {
    return getClient(cookie, auth, projectId).getDesigns(projectId);
  },

  lanhu_get_design_detail: async ({ imageId, projectId }, cookie, auth) => {
    return getClient(cookie, auth, projectId).getDesignDetail(imageId, projectId);
  },

  lanhu_get_design_document: async ({ imageId, projectId, depth, includeStyles, includeRaw }, cookie, auth) => {
    return getClient(cookie, auth, projectId).getDesignDocument(imageId, projectId, {
      depth: depth ?? 2,
      includeStyles: includeStyles ?? true,
      includeRaw: includeRaw ?? false,
    });
  },

  lanhu_get_layer_detail: async ({ imageId, layerId, projectId }, cookie, auth) => {
    return getClient(cookie, auth, projectId).getLayerDetail(imageId, layerId, projectId);
  },

  lanhu_get_annotations: async ({ imageId, projectId, filter, includeStyles }, cookie, auth) => {
    return getClient(cookie, auth, projectId).getAnnotations(imageId, projectId, {
      filter,
      includeStyles: includeStyles ?? true,
    });
  },

  lanhu_get_dds_schema: async ({ imageId, versionId, projectId }, cookie, auth) => {
    return getClient(cookie, auth, projectId).getDDSSchema(versionId, imageId, projectId);
  },

  lanhu_generate_code: async ({ imageId, format, projectId }, cookie, auth) => {
    // 使用 Puppeteer 提取 DDS 页面真实代码（接近原稿效果）
    const outDir = path.join(os.homedir(), `Desktop/lanhu-gen-${Date.now()}`);
    const result = await downloadDesign(imageId, projectId || "", cookie, "", outDir);

    // 读取生成的 HTML/CSS 文件
    const htmlContent = fs.readFileSync(path.join(outDir, "index.html"), "utf-8");
    const cssContent = fs.readFileSync(path.join(outDir, "index.css"), "utf-8");

    // 将本地相对路径替换为 dev server 可访问的 URL
    const base = `/api/files/${outDir}`;
    const fullHtml = htmlContent
      // 先替换 ../ 路径（避免被 ./ 误匹配）
      .replace(/\.\.\/(?!\/)/g, `${base}/`)
      // 再替换 ./ 路径（不匹配 https:// 等协议）
      .replace(/(?<!:)\.\/(?!\/)/g, `${base}/`);

    const fmt = format || "html";
    if (fmt === "vue") {
      // Vue 模式仍用语义树生成
      const client = getClient(cookie, auth, projectId);
      const [schema, doc] = await Promise.all([
        client.getDDSSchema(undefined, imageId, projectId) as Promise<DDSNode>,
        client.getDesignDocument(imageId, projectId, { depth: 99, includeStyles: true }),
      ]);
      const imageUrls = collectImageUrls(doc.layers);
      const vueResult = generateVueCode(schema);
      vueResult.files.forEach(f => { f.content = injectImageUrls(f.content, imageUrls); });
      return { ...vueResult, previewHtml: fullHtml, previewCss: cssContent };
    }

    return {
      files: [{ name: "index.html", content: fullHtml }],
      images: result.images,
      outputDir: outDir,
    };
  },

  lanhu_get_preview: async ({ imageId, projectId }, cookie, auth) => {
    return getClient(cookie, auth, projectId).getPreviewUrl(imageId, projectId);
  },

  lanhu_get_tokens: async ({ projectId }, cookie, auth) => {
    return getClient(cookie, auth, projectId).getDesignTokens(projectId);
  },

  lanhu_get_sectors: async ({ projectId }, cookie, auth) => {
    return getClient(cookie, auth, projectId).getProjectSectors(projectId);
  },

  lanhu_set_project: async ({ url }, cookie, auth) => {
    const match = url.match(/[?&](?:project_id|pid)=([a-f0-9-]+)/i)
      || url.match(/\/project\/([a-f0-9-]+)/i)
      || url.match(/[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}/i);
    if (match) {
      getClient(cookie, auth, match[1]); // 缓存带 projectId 的客户端
      return { success: true, projectId: match[1] };
    }
    throw new Error(`无法从 URL 中提取 projectId: ${url}`);
  },

  lanhu_download_cover: async ({ imageId, outputPath, projectId }, cookie, auth) => {
    const out = outputPath || path.join(os.homedir(), "Desktop/lanhu-covers");
    return getClient(cookie, auth, projectId).downloadCover(imageId, out, projectId);
  },

  lanhu_download_design: async ({ imageId, outputPath, projectId }, cookie) => {
    const out = outputPath || path.join(os.homedir(), "Desktop/lanhu-designs");
    return downloadDesign(imageId, projectId || "", cookie, "", out);
  },
};

// ─── HTTP 服务器 ───────────────────────────────────────

const server = http.createServer(async (req, res) => {
  // CORS
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");

  if (req.method === "OPTIONS") {
    res.writeHead(204);
    return res.end();
  }

  const parsedUrl = url.parse(req.url || "/", true);
  const pathname = parsedUrl.pathname || "/";

  try {
    // GET / → 返回测试页面
    if (req.method === "GET" && pathname === "/") {
      const htmlPath = path.join(PUBLIC_DIR, "test.html");
      if (!fs.existsSync(htmlPath)) {
        res.writeHead(404, { "Content-Type": "text/plain" });
        return res.end("test.html not found. Run: npm run dev:server");
      }
      res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
      return fs.createReadStream(htmlPath).pipe(res);
    }

    // GET /api/files/* → 提供生成代码的静态资源（图片/CSS/JS）
    if (req.method === "GET" && pathname.startsWith("/api/files/")) {
      const filePath = pathname.replace("/api/files/", "");
      const resolved = path.resolve(filePath);
      // 安全检查：只允许访问 tmp 或 Desktop 目录下的文件
      const desktopDir = path.join(os.homedir(), "Desktop");
      if (!resolved.startsWith(os.tmpdir()) && !resolved.startsWith(desktopDir)) {
        res.writeHead(403, { "Content-Type": "text/plain" });
        return res.end("Access denied");
      }
      if (!fs.existsSync(resolved)) {
        res.writeHead(404, { "Content-Type": "text/plain" });
        return res.end("File not found");
      }
      const ext = path.extname(resolved).toLowerCase();
      const mimeTypes: Record<string, string> = {
        ".html": "text/html; charset=utf-8",
        ".css": "text/css; charset=utf-8",
        ".js": "application/javascript; charset=utf-8",
        ".png": "image/png",
        ".jpg": "image/jpeg",
        ".jpeg": "image/jpeg",
        ".gif": "image/gif",
        ".svg": "image/svg+xml",
        ".webp": "image/webp",
      };
      res.writeHead(200, { "Content-Type": mimeTypes[ext] || "application/octet-stream" });
      return fs.createReadStream(resolved).pipe(res);
    }

    // POST /api/tools/:toolName
    if (req.method === "POST" && pathname.startsWith("/api/tools/")) {
      const toolName = pathname.replace("/api/tools/", "");
      const handler = TOOL_HANDLERS[toolName];

      if (!handler) {
        res.writeHead(404, { "Content-Type": "application/json" });
        return res.end(JSON.stringify({ error: `Unknown tool: ${toolName}` }));
      }

      // 解析请求体
      const body = await readBody(req);
      const params: any = body ? JSON.parse(body) : {};

      // 提取凭证
      const { cookie, auth } = extractCredentials(params);

      console.log(`[DEV] ${toolName} called with:`, JSON.stringify(params));

      const result = await handler(params, cookie, auth);
      res.writeHead(200, { "Content-Type": "application/json; charset=utf-8" });
      return res.end(JSON.stringify(result, null, 2));
    }

    // 404
    res.writeHead(404, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ error: `Not found: ${pathname}` }));
  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error);
    console.error(`[DEV ERROR] ${pathname}:`, msg);
    res.writeHead(500, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ error: msg }));
  }
});

function readBody(req: http.IncomingMessage): Promise<string> {
  return new Promise((resolve) => {
    const chunks: Buffer[] = [];
    req.on("data", (chunk) => chunks.push(chunk));
    req.on("end", () => resolve(Buffer.concat(chunks).toString()));
  });
}

// ── 启动 ──────────────────────────────────────────────

server.listen(PORT, () => {
  const hasEnv = process.env.LANHU_COOKIE ? "（已预填环境变量凭证）" : "（请在页面输入 Cookie）";
  console.log(`
╔═══════════════════════════════════════════════╗
║   蓝湖 MCP Server - 开发测试页面               ║
╠═══════════════════════════════════════════════╣
║   http://localhost:${PORT}                        ║
║   ${hasEnv}
╚═══════════════════════════════════════════════╝
  `);
});

server.on("error", (err) => {
  console.error("Server error:", err);
  process.exit(1);
});
