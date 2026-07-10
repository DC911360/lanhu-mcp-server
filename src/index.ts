#!/usr/bin/env node
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { config } from "dotenv";
import * as fs from "node:fs";
import * as path from "node:path";
import * as readline from "node:readline";
import { fileURLToPath } from "node:url";
import { LanhuClient } from "./client.js";
import { registerTools } from "./tools.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const rootDir = path.resolve(__dirname, "..");

/**
 * 从蓝湖项目 URL 中提取 projectId
 *
 * 支持的 URL 格式：
 *   https://lanhuapp.com/web/#/item/{teamId}/project/{projectId}
 *   https://lanhuapp.com/project/{projectId}
 *   或直接输入 projectId
 */
function extractProjectId(input: string): string | null {
  const trimmed = input.trim();

  // 直接是 projectId（纯数字或 UUID）
  if (/^[\w-]{8,}$/.test(trimmed)) {
    return trimmed;
  }

  // 从 URL 中提取 /project/ 后面的 ID
  const projectMatch = trimmed.match(/\/project\/([a-f0-9-]+)/i);
  if (projectMatch) return projectMatch[1];

  // 匹配 URL 末尾的 ID 段
  const lastSegment = trimmed.split("/").pop() || "";
  if (/^[\w-]{8,}$/.test(lastSegment)) {
    return lastSegment;
  }

  return null;
}

/**
 * 启动前交互式引导用户配置
 *
 * MCP Server 使用 stdio 传输协议，
 * 因此交互式提示仅在首次 setup 阶段（stdio 连接之前）进行。
 */
async function promptConfig(): Promise<{
  cookie: string;
  authorization?: string;
  tenantId?: string;
  projectId?: string;
}> {
  const envPath = path.join(rootDir, ".env");

  // 如果 .env 已存在且包含有效 Cookie，检查是否也需要更新项目
  if (fs.existsSync(envPath)) {
    const envContent = fs.readFileSync(envPath, "utf-8");
    const hasCookie = /^LANHU_COOKIE\s*=.+$/m.test(envContent);
    const hasProject = /^LANHU_PROJECT_ID\s*=.+$/m.test(envContent);

    if (hasCookie) {
      config({ path: envPath });

      // Cookie 已有但缺少项目 URL → 只问项目
      if (!hasProject) {
        const rl = readline.createInterface({
          input: process.stdin,
          output: process.stderr,
        });
        const ask = (q: string) => new Promise<string>((r) => rl.question(q, r));

        console.error("");
        console.error("蓝湖 MCP Server — 补充项目配置");
        console.error("");

        const projectUrl = await ask(
          " 请粘贴蓝湖项目 URL（或 projectId，直接回车跳过）: "
        );
        rl.close();

        let projectId: string | undefined;
        if (projectUrl.trim()) {
          projectId = extractProjectId(projectUrl) || undefined;
          if (projectId) {
            fs.appendFileSync(envPath, `LANHU_PROJECT_ID=${projectId}\n`, "utf-8");
            console.error(`已保存项目 ID: ${projectId}`);
          } else {
            console.error("无法从 URL 解析 projectId，将使用全项目模式");
          }
        }

        return {
          cookie: process.env.LANHU_COOKIE || "",
          authorization: process.env.LANHU_AUTHORIZATION,
          tenantId: process.env.LANHU_TENANT_ID,
          projectId,
        };
      }

      // Cookie 和项目都有 → 直接返回
      return {
        cookie: process.env.LANHU_COOKIE || "",
        authorization: process.env.LANHU_AUTHORIZATION,
        tenantId: process.env.LANHU_TENANT_ID,
        projectId: process.env.LANHU_PROJECT_ID,
      };
    }
  }

  // 交互式引导
  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stderr,
  });

  const ask = (question: string): Promise<string> =>
    new Promise((resolve) => rl.question(question, resolve));

  console.error("");
  console.error("=== 蓝湖 MCP Server - 首次配置引导 ===");
  console.error("");
  console.error("获取方式：F12 -> Network -> 任意 api 请求 -> Request Headers");
  console.error("  Cookie:        复制 Cookie 整行值");
  console.error("  Authorization: 复制 Authorization 整行值");
  console.error("  tenantId:      从请求 body 中获取（可选）");
  console.error("  项目 URL:      从浏览器地址栏复制（可选）");
  console.error("");

  const cookie = await ask("请输入你的蓝湖 Cookie: ");

  const authorization = await ask(
    "请输入 Authorization Token（可选，直接回车跳过）: "
  );

  const tenantId = await ask(
    "请输入 tenantId（可选，从任意请求 body 中获取，直接回车跳过）: "
  );

  const projectUrl = await ask(
    "请粘贴蓝湖项目 URL（可选，直接回车跳过）: "
  );

  rl.close();

  // 解析 projectId
  let projectId: string | undefined;
  if (projectUrl.trim()) {
    projectId = extractProjectId(projectUrl) || undefined;
    if (!projectId) {
      console.error(" 无法从 URL 解析 projectId，将使用全项目模式");
    }
  }

  // 写入 .env 文件，避免下次重复输入
  const envLines: string[] = [
    "# 蓝湖认证配置（由首次引导自动生成）",
    `LANHU_COOKIE=${cookie.trim()}`,
  ];
  if (authorization.trim()) {
    envLines.push(`LANHU_AUTHORIZATION=${authorization.trim()}`);
  }
  if (tenantId.trim()) {
    envLines.push(`LANHU_TENANT_ID=${tenantId.trim()}`);
  }
  if (projectId) {
    envLines.push(`LANHU_PROJECT_ID=${projectId}`);
  }
  fs.writeFileSync(envPath, envLines.join("\n") + "\n", "utf-8");
  fs.chmodSync(envPath, 0o600); // 仅 owner 可读写

  console.error("");
  console.error(`配置已写入 ${envPath}（权限 600）`);
  if (projectId) console.error(`  项目 ID: ${projectId}`);
  console.error("");

  return {
    cookie: cookie.trim(),
    authorization: authorization.trim() || undefined,
    tenantId: tenantId.trim() || undefined,
    projectId,
  };
}

/**
 * 蓝湖 MCP Server 入口
 *
 * 启动方式：
 *   npm run dev        # 开发模式（tsx）
 *   npm run build && npm start  # 生产模式
 *
 * Claude Code 配置：
 *   claude mcp add lanhu-mcp -- node dist/index.js
 */
async function main() {
  // 启动前交互式配置
  const { cookie, authorization, tenantId, projectId } = await promptConfig();

  if (!cookie) {
    console.error("Cookie 为空，请重新运行并输入有效的蓝湖 Cookie");
    process.exit(1);
  }

  // 创建蓝湖 API 客户端
  const client = new LanhuClient(cookie, authorization, tenantId, projectId);

  // 创建 MCP Server
  const server = new McpServer({
    name: "lanhu-mcp-server",
    version: "1.0.0",
  });

  // 注册所有 Tools
  registerTools(server, client);

  // 通过 stdio 连接（Claude Code / Cursor 等使用 stdio 传输）
  const transport = new StdioServerTransport();
  await server.connect(transport);

  console.error(
    `蓝湖 MCP Server 已启动` +
    (projectId ? ` (项目: ${projectId})` : "") +
    "，等待连接..."
  );
}

main().catch((err) => {
  console.error("启动失败:", err.message);
  process.exit(1);
});
