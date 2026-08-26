import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import type { LanhuClient } from "./client.js";
import { generateVueCode, generateHTMLCode } from "./dds-codegen.js";
import { downloadDesign } from "./dds-puppeteer.js";
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";

// ─── 错误日志工具 ────────────────────────────────────────

const LOG_DIR = path.join(os.homedir(), ".lanhu-mcp");
const LOG_FILE = path.join(LOG_DIR, "error.log");

function ensureLogDir(): void {
  if (!fs.existsSync(LOG_DIR)) {
    fs.mkdirSync(LOG_DIR, { recursive: true });
  }
}

function logToolError(toolName: string, error: Error | string, args?: Record<string, unknown>): void {
  try {
    ensureLogDir();
    const timestamp = new Date().toISOString();
    const message = error instanceof Error ? error.message : error;
    const stack = error instanceof Error ? error.stack || "" : "";
    const argsStr = args ? `\nArgs: ${JSON.stringify(args, null, 2)}` : "";
    const logEntry = `[${timestamp}] TOOL_ERROR [${toolName}]: ${message}\n${stack}${argsStr}\n${"─".repeat(80)}\n`;
    fs.appendFileSync(LOG_FILE, logEntry, "utf-8");
  } catch (e) {
    console.error("日志写入失败:", e);
  }
}

/**
 * 包装 tool handler，自动捕获错误并记录日志
 */
function withErrorLogging<T extends Record<string, unknown>>(
  toolName: string,
  handler: (args: T) => Promise<{ content: Array<{ type: "text"; text: string }> }>
): (args: T) => Promise<{ content: Array<{ type: "text"; text: string }>; isError?: boolean }> {
  return async (args: T) => {
    try {
      return await handler(args);
    } catch (error) {
      const err = error instanceof Error ? error : new Error(String(error));
      logToolError(toolName, err, args);
      return {
        content: [{ type: "text" as const, text: `❌ ${toolName} 执行失败: ${err.message}` }],
        isError: true,
      };
    }
  };
}

/**
 * 注册所有蓝湖 MCP Tools
 *
 * 核心接口：lanhu_get_design_document
 * 返回完整精确的结构化设计数据（图层树 + 绝对坐标 + 全量样式），
 * 供 iOS / Android / Flutter / Web / H5 代码生成器使用。
 */
export function registerTools(server: McpServer, client: LanhuClient): void {

  // ─── ★★★ 核心：精确设计文档 ★★★ ───────────────────

  server.tool(
    "lanhu_get_design_document",
    "获取设计稿的结构化数据。返回图层树摘要（图层名、坐标、尺寸、类型）+ Design Tokens。默认只展开 2 层，按需调用 lanhu_get_layer_detail 获取子图层完整样式。",
    {
      imageId: z.string().describe("设计稿 image_id"),
      projectId: z.string().optional().describe("项目 UUID"),
      depth: z.number().default(2).describe("展开深度（默认 2），设为 99 可获取全部图层"),
      includeStyles: z.boolean().default(true).describe("是否包含样式数据（fill/border/shadow/typography）"),
      includeRaw: z.boolean().default(false).describe("是否包含原始 raw 数据（体积大，默认 false）"),
    },
    withErrorLogging("lanhu_get_design_document", async ({ imageId, projectId, depth, includeStyles, includeRaw }) => {
      const doc = await client.getDesignDocument(imageId, projectId, { depth, includeStyles, includeRaw });
      return {
        content: [{ type: "text", text: JSON.stringify(doc, null, 2) }],
      };
    })
  );

  // ─── ★★★ 按需获取子图层详情 ★★★ ────────────────────

  server.tool(
    "lanhu_get_layer_detail",
    "获取单个图层的完整详情（含全量样式和原始数据）。先用 lanhu_get_design_document 查看图层结构，再用此工具按需获取具体图层的详细信息。",
    {
      imageId: z.string().describe("设计稿 image_id"),
      layerId: z.string().describe("图层 ID（从 lanhu_get_design_document 的返回结果中获取）"),
      projectId: z.string().optional().describe("项目 UUID"),
    },
    withErrorLogging("lanhu_get_layer_detail", async ({ imageId, layerId, projectId }) => {
      const layer = await client.getLayerDetail(imageId, layerId, projectId);
      if (!layer) {
        return { content: [{ type: "text", text: `❌ 未找到图层: ${layerId}` }] };
      }
      return {
        content: [{ type: "text", text: JSON.stringify(layer, null, 2) }],
      };
    })
  );

  // ─── 项目/文件夹 ──────────────────────────────────────

  server.tool(
    "lanhu_list_projects",
    "列出蓝湖团队下的所有项目/文件夹，返回 ID 和名称。parentId=0 表示根目录。",
    {
      parentId: z.number().optional().describe("父文件夹 ID，默认 0（根目录）"),
    },
    async ({ parentId }) => {
      const files = await client.getWorkbenchFiles(parentId ?? 0);
      return {
        content: [{
          type: "text",
          text: files.length
            ? files.map((f: any) => `- [${f.sourceType}] ${f.sourceName} (id: ${f.id}, sourceId: ${f.sourceId})`).join("\n")
            : "未找到项目，请检查 Cookie 和 tenantId",
        }],
      };
    }
  );

  // ─── 设计稿 ───────────────────────────────────────────

  server.tool(
    "lanhu_get_designs",
    "获取项目下的设计稿列表。使用项目的 UUID（sourceId）作为 projectId。",
    {
      projectId: z.string().optional().describe("项目 UUID（sourceId），不传则使用配置的默认项目"),
    },
    async ({ projectId }) => {
      const designs = await client.getDesigns(projectId);
      if (!designs.length) {
        return { content: [{ type: "text", text: "未找到设计稿" }] };
      }
      const lines = designs.map((d: any) =>
        `- ${d.name} (image_id: ${d.image_id || d.id})`
      );
      return {
        content: [{ type: "text", text: `共 ${designs.length} 个设计稿：\n${lines.join("\n")}` }],
      };
    }
  );

  server.tool(
    "lanhu_get_design_detail",
    "获取设计稿详情，包含尺寸、预览图 URL、版本信息、json_url（标注数据地址）。",
    {
      imageId: z.string().describe("设计稿 image_id"),
      projectId: z.string().optional().describe("项目 UUID，不传则使用默认项目"),
    },
    async ({ imageId, projectId }) => {
      const detail = await client.getDesignDetail(imageId, projectId);
      return {
        content: [{ type: "text", text: JSON.stringify(detail, null, 2) }],
      };
    }
  );

  // ── 标注/图层 ───────────────────────────────────────

  server.tool(
    "lanhu_get_annotations",
    "获取设计稿的标注数据（图层列表），包含每个元素的尺寸、位置、颜色、字体等参数。支持按图层名过滤，默认只返回关键样式摘要。",
    {
      imageId: z.string().describe("设计稿 image_id"),
      projectId: z.string().optional().describe("项目 UUID"),
      filter: z.string().optional().describe("按图层名过滤（模糊匹配，如 Button 或 Icon）"),
      includeStyles: z.boolean().default(true).describe("是否包含样式数据"),
    },
    async ({ imageId, projectId, filter, includeStyles }) => {
      const annotations = await client.getAnnotations(imageId, projectId, { filter, includeStyles });
      if (!annotations.length) {
        return { content: [{ type: "text", text: `无标注数据${filter ? `（匹配 "${filter}"）` : ""}` }] };
      }
      return {
        content: [{
          type: "text",
          text: `共 ${annotations.length} 个标注元素：\n${JSON.stringify(annotations, null, 2)}`,
        }],
      };
    }
  );

  // ─── 预览图 ───────────────────────────────────────────

  server.tool(
    "lanhu_get_preview",
    "获取设计稿的预览图 URL。",
    {
      imageId: z.string().describe("设计稿 image_id"),
      projectId: z.string().optional().describe("项目 UUID"),
    },
    async ({ imageId, projectId }) => {
      const url = await client.getPreviewUrl(imageId, projectId);
      return {
        content: [{ type: "text", text: url || "无预览图" }],
      };
    }
  );

  // ─── Design Tokens ───────────────────────────────────

  server.tool(
    "lanhu_get_tokens",
    "从设计稿标注数据中提取 Design Tokens（颜色变量等）。",
    {
      projectId: z.string().optional().describe("项目 UUID"),
    },
    async ({ projectId }) => {
      const tokens = await client.getDesignTokens(projectId);
      return {
        content: [{
          type: "text",
          text: tokens.length
            ? `共 ${tokens.length} 个 Token：\n${JSON.stringify(tokens, null, 2)}`
            : "无 Token 数据",
        }],
      };
    }
  );

  // ── 项目分区 ────────────────────────────────────────

  server.tool(
    "lanhu_get_sectors",
    "获取项目的分区（分组）信息，了解设计稿的组织结构。",
    {
      projectId: z.string().optional().describe("项目 UUID"),
    },
    async ({ projectId }) => {
      const sectors = await client.getProjectSectors(projectId);
      return {
        content: [{ type: "text", text: JSON.stringify(sectors, null, 2) }],
      };
    }
  );

  // ── 设置项目（从 URL 自动提取 projectId）★★★ ────────

  server.tool(
    "lanhu_set_project",
    "从蓝湖项目 URL 中提取并设置默认 projectId。之后所有工具调用无需再传 projectId。支持格式：完整 URL 或直接粘贴 projectId UUID。",
    {
      url: z.string().describe("蓝湖项目 URL 或 projectId UUID。例如：https://lanhuapp.com/web/#/item/project/detailDetach?pid=xxx&project_id=xxx"),
    },
    async ({ url }) => {
      const trimmed = url.trim();
      let projectId: string | null = null;

      // 尝试从 URL 中提取 project_id 或 pid
      const projectMatch = trimmed.match(/[?&](?:project_id|pid)=([a-f0-9-]+)/i);
      if (projectMatch) {
        projectId = projectMatch[1];
      } else if (/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i.test(trimmed)) {
        // 直接是 UUID
        projectId = trimmed;
      } else {
        // 尝试从 URL 末尾提取
        const segments = trimmed.split("/");
        const last = segments[segments.length - 1];
        if (/^[a-f0-9-]{8,}$/i.test(last)) projectId = last;
      }

      if (!projectId) {
        return { content: [{ type: "text", text: `❌ 无法从 URL 中提取 projectId，请检查 URL 格式：\n${trimmed}` }] };
      }

      client.setProjectId(projectId);
      // 同时触发自动发现 tenantId
      await client.autoDiscover();

      return { content: [{ type: "text", text: `✅ 已设置默认项目：\n  projectId: ${projectId}\n  tenantId: ${client.getTenantId() || "0"}\n\n后续工具调用无需再传 projectId。` }] };
    }
  );

  // ── DDS 语义化 UI 组件树 ★★★ ────────────────────────

  server.tool(
    "lanhu_get_dds_schema",
    "获取蓝湖 DDS 语义化 UI 组件树。返回经过 AI 识别的 UI 组件结构（NavBar/Avatar/Input/ImageText 等），包含 row/col 布局和精确样式。用于 300% 精确还原设计稿。",
    {
      imageId: z.string().describe("设计稿 image_id"),
      versionId: z.string().optional().describe("版本 ID（不传则自动获取最新版）"),
    },
    async ({ imageId, versionId }) => {
      const schema = await client.getDDSSchema(versionId, imageId, client.getProjectId());
      return { content: [{ type: "text", text: JSON.stringify(schema, null, 2) }] };
    }
  );

  // ── DDS 代码生成 ★★★ ─────────────────────────────────

  server.tool(
    "lanhu_generate_code",
    "基于蓝湖 DDS 语义化数据生成前端代码。支持 Vue 3 SFC (.vue) 和 HTML 输出。",
    {
      imageId: z.string().describe("设计稿 image_id"),
      format: z.enum(["vue", "html"]).default("vue").describe("输出格式：vue 或 html"),
      outputPath: z.string().optional().describe("输出目录（不传则返回代码内容）"),
    },
    async ({ imageId, format, outputPath }) => {
      const schema = await client.getDDSSchema(undefined, imageId, client.getProjectId()) as any;

      let result;
      if (format === "vue") {
        result = generateVueCode(schema, { projectName: schema.data?.name || "DesignPage" });
      } else {
        result = generateHTMLCode(schema);
      }

      // 如果指定了输出目录，写入文件
      if (outputPath) {
        const dir = path.resolve(outputPath);
        fs.mkdirSync(dir, { recursive: true });
        for (const file of result.files) {
          fs.writeFileSync(path.join(dir, file.name), file.content, "utf-8");
        }
        return { content: [{ type: "text", text: `代码已生成到 ${dir}：\n${result.files.map(f => `  ${f.name} (${f.content.length} bytes)`).join("\n")}` }] };
      }

      return { content: result.files.map(f => ({ type: "text" as const, text: `=== ${f.name} ===\n${f.content}` })) };
    }
  );

  // ── ★★★ 一键下载设计稿（DDS 官方代码 + 图片）★★★ ─────

  server.tool(
    "lanhu_download_design",
    "一键下载蓝湖设计稿：通过 Puppeteer 从 DDS 页面提取官方生成的 HTML/CSS 代码 + 下载所有 CDN 切图并替换为本地路径。输出 index.html / index.css / flexible.js / common.css + img/。",
    {
      imageId: z.string().describe("设计稿 image_id（从蓝湖 URL 中获取）"),
      outputPath: z.string().describe("输出目录路径（如 ~/Desktop/my-design）"),
      projectId: z.string().optional().describe("项目 UUID（不传则使用默认配置）"),
    },
    withErrorLogging("lanhu_download_design", async ({ imageId, outputPath, projectId }) => {
      const pid = projectId || client.getProjectId();
      if (!pid) throw new Error("请提供 projectId 或配置默认项目");

      const cookie = process.env.LANHU_COOKIE || "";
      const authorization = process.env.LANHU_AUTHORIZATION || "";

      const result = await downloadDesign(imageId, pid, cookie, authorization, outputPath);

      return {
        content: [{
          type: "text",
          text: [
            `✅ 设计稿已下载到 ${result.outputDir}`,
            ``,
            `文件:`,
            ...result.files.map(f => `  ${path.basename(f)} (${(fs.statSync(f).size / 1024).toFixed(1)}KB)`),
            ``,
            `图片: ${result.images} 个`,
            `HTML: ${result.htmlSize} bytes`,
            `CSS: ${result.cssSize} bytes`,
          ].join("\n"),
        }],
      };
    })
  );

  // ─ 下载 ─────────────────────────────────────────────

  server.tool(
    "lanhu_download_cover",
    "下载设计稿封面图（完整设计截图）到本地目录。",
    {
      imageId: z.string().describe("设计稿 image_id"),
      outputPath: z.string().describe("输出目录路径"),
      projectId: z.string().optional().describe("项目 UUID"),
    },
    async ({ imageId, outputPath, projectId }) => {
      const filePath = await client.downloadCover(imageId, outputPath, projectId);
      return {
        content: [{ type: "text", text: `封面图已下载：${filePath}` }],
      };
    }
  );

  server.tool(
    "lanhu_download_image",
    "下载任意图片 URL 到本地目录。",
    {
      url: z.string().describe("图片 URL"),
      fileName: z.string().describe("保存文件名"),
      outputPath: z.string().describe("输出目录路径"),
    },
    async ({ url, fileName, outputPath }) => {
      const filePath = await client.downloadSlice(url, fileName, outputPath);
      return {
        content: [{ type: "text", text: `图片已下载：${filePath}` }],
      };
    }
  );
}
