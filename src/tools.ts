import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import type { LanhuClient } from "./client.js";
import { generateVueCode, generateHTMLCode } from "./dds-codegen.js";
import { downloadDesign } from "./dds-puppeteer.js";
import * as fs from "node:fs";
import * as path from "node:path";

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
    "获取设计稿的完整精确结构化数据。返回图层树（绝对坐标@1x、全量样式fill/border/shadow/typography）、Design Tokens。供 iOS/Android/Flutter/Web/H5 代码生成器使用。",
    {
      imageId: z.string().describe("设计稿 image_id"),
      projectId: z.string().optional().describe("项目 UUID"),
    },
    async ({ imageId, projectId }) => {
      const doc = await client.getDesignDocument(imageId, projectId);
      return {
        content: [{ type: "text", text: JSON.stringify(doc, null, 2) }],
      };
    }
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

  // ─── 标注/图层 ────────────────────────────────────────

  server.tool(
    "lanhu_get_annotations",
    "获取设计稿的标注数据（图层树），包含每个元素的尺寸、位置、颜色、字体等精确参数。",
    {
      imageId: z.string().describe("设计稿 image_id"),
      projectId: z.string().optional().describe("项目 UUID"),
    },
    async ({ imageId, projectId }) => {
      const annotations = await client.getAnnotations(imageId, projectId);
      return {
        content: [{
          type: "text",
          text: annotations.length
            ? `共 ${annotations.length} 个标注元素：\n${JSON.stringify(annotations, null, 2)}`
            : "无标注数据",
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
    "一键下载蓝湖设计稿：获取 DDS 官方生成的 Vue/CSS 代码 + 下载所有切图 + 替换为本地路径。输出 DesignPage.vue / index.html / style.css + images/。",
    {
      imageId: z.string().describe("设计稿 image_id（从蓝湖 URL 中获取）"),
      outputPath: z.string().describe("输出目录路径（如 ~/Desktop/my-design）"),
      projectId: z.string().optional().describe("项目 UUID（不传则使用默认配置）"),
    },
    async ({ imageId, outputPath, projectId }) => {
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
    }
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
