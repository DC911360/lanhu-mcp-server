#!/usr/bin/env node
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { config } from "dotenv";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import * as readline from "node:readline";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";
import { LanhuClient } from "./client.js";
import { registerTools } from "./tools.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const rootDir = path.resolve(__dirname, "..");
const require = createRequire(import.meta.url);
const pkg = require("../package.json") as { version: string };

/** Claude Code 配置文件路径 */
const CLAUDE_SETTINGS_PATH = path.join(os.homedir(), ".claude", "settings.json");

/** 配置写入目标 */
type ConfigTarget = "env" | "claude" | "both";

/**
 * 将蓝湖 MCP 配置写入 ~/.claude/settings.json
 *
 * 等效于运行:
 *   claude mcp add lanhu-mcp -e LANHU_COOKIE="..." -e LANHU_AUTHORIZATION="..." -- npx dc-lanhu-mcp-server
 */
function writeClaudeConfig(opts: {
  cookie: string;
  authorization?: string;
  tenantId?: string;
  projectId?: string;
}): void {
  let settings: Record<string, unknown> = {};
  if (fs.existsSync(CLAUDE_SETTINGS_PATH)) {
    try {
      settings = JSON.parse(fs.readFileSync(CLAUDE_SETTINGS_PATH, "utf-8"));
    } catch {
      console.error(`警告: ${CLAUDE_SETTINGS_PATH} 解析失败，将创建新文件`);
      settings = {};
    }
  }

  // 构造 env 对象
  const env: Record<string, string> = {
    LANHU_COOKIE: opts.cookie,
  };
  if (opts.authorization) env.LANHU_AUTHORIZATION = opts.authorization;
  if (opts.tenantId) env.LANHU_TENANT_ID = opts.tenantId;
  if (opts.projectId) env.LANHU_PROJECT_ID = opts.projectId;

  // 构造 mcpServers 条目
  const mcpServers =
    ((settings as Record<string, unknown>).mcpServers as Record<string, unknown>) || {};
  mcpServers["lanhu-mcp"] = {
    command: "npx",
    args: ["dc-lanhu-mcp-server"],
    env,
  };
  (settings as Record<string, unknown>).mcpServers = mcpServers;

  // 确保目录存在
  const dir = path.dirname(CLAUDE_SETTINGS_PATH);
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }

  fs.writeFileSync(
    CLAUDE_SETTINGS_PATH,
    JSON.stringify(settings, null, 2) + "\n",
    "utf-8"
  );
}

/**
 * 检查 Claude settings.json 中是否已有 lanhu-mcp 配置
 */
function hasClaudeConfig(): boolean {
  if (!fs.existsSync(CLAUDE_SETTINGS_PATH)) return false;
  try {
    const settings = JSON.parse(fs.readFileSync(CLAUDE_SETTINGS_PATH, "utf-8"));
    return !!settings?.mcpServers?.["lanhu-mcp"]?.env?.LANHU_COOKIE;
  } catch {
    return false;
  }
}

/**
 * 从项目 .mcp.json 中读取 lanhu-mcp 的环境变量配置
 *
 * .mcp.json 是项目级 MCP 配置，被 Cursor / Claude Code / Cline 等工具识别。
 * 查找路径：process.cwd()/.mcp.json（当前工作目录）
 *
 * 返回 env 对象，未找到或缺少 Cookie 时返回 null
 */
function readMcpJsonConfig(): Record<string, string> | null {
  // 支持 .mcp.json 和 .cursor/mcp.json 两种常见位置
  const candidates = [
    path.join(process.cwd(), ".mcp.json"),
    path.join(process.cwd(), ".cursor", "mcp.json"),
  ];

  for (const mcpJsonPath of candidates) {
    if (!fs.existsSync(mcpJsonPath)) continue;
    try {
      const mcpJson = JSON.parse(fs.readFileSync(mcpJsonPath, "utf-8"));
      // 遍历 mcpServers 找到 lanhu 相关配置（键名可能不完全是 "lanhu-mcp"）
      const servers = mcpJson?.mcpServers;
      if (!servers || typeof servers !== "object") continue;

      for (const [key, value] of Object.entries(servers)) {
        const entry = value as Record<string, unknown> | null;
        const env = entry?.env as Record<string, string> | undefined;
        if (env?.LANHU_COOKIE) {
          console.error(`已从 ${mcpJsonPath} (${key}) 读取配置`);
          return env;
        }
      }
    } catch {
      // 解析失败，跳过
    }
  }
  return null;
}

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
 * 启动前配置加载 / 交互式引导
 *
 * 配置读取优先级（从高到低，局部 > 全局）：
 *   1. process.env        — 父进程注入（claude mcp add -e / 手动 export）
 *   2. .mcp.json          — 项目级配置（process.cwd()/.mcp.json 或 .cursor/mcp.json）
 *   3. .env               — 本地环境变量文件（package 级）
 *   4. settings.json      — Claude 全局配置（~/.claude/settings.json）
 *   5. 交互式引导          — 以上均无时，引导用户选择写入目标
 *
 * 配置写入目标（首次引导时可选）：
 *   1. .env 文件（本地环境变量）
 *   2. ~/.claude/settings.json（等同于 claude mcp add 命令）
 *   3. 两者都写
 */
async function promptConfig(): Promise<{
  cookie: string;
  authorization?: string;
  tenantId?: string;
  projectId?: string;
}> {
  const envPath = path.join(rootDir, ".env");

  // 最高优先级：进程环境变量已有 Cookie（由父进程 / claude mcp add -e 注入）
  // 直接加载 .env（补充缺失项）后返回，无需任何交互
  if (process.env.LANHU_COOKIE) {
    if (fs.existsSync(envPath)) config({ path: envPath });
    return {
      cookie: process.env.LANHU_COOKIE,
      authorization: process.env.LANHU_AUTHORIZATION,
      tenantId: process.env.LANHU_TENANT_ID,
      projectId: process.env.LANHU_PROJECT_ID,
    };
  }

  // 第二优先级：项目 .mcp.json（项目级配置，随项目走）
  const mcpJsonEnv = readMcpJsonConfig();
  if (mcpJsonEnv) {
    return {
      cookie: mcpJsonEnv.LANHU_COOKIE,
      authorization: mcpJsonEnv.LANHU_AUTHORIZATION,
      tenantId: mcpJsonEnv.LANHU_TENANT_ID,
      projectId: mcpJsonEnv.LANHU_PROJECT_ID,
    };
  }

  const envExists = fs.existsSync(envPath);
  const envContent = envExists ? fs.readFileSync(envPath, "utf-8") : "";
  const envHasCookie = /^LANHU_COOKIE\s*=.+$/m.test(envContent);
  const claudeHasConfig = hasClaudeConfig();

  // 两个配置文件都已有有效 Cookie → 直接加载返回
  if (envHasCookie && claudeHasConfig) {
    config({ path: envPath });
    return {
      cookie: process.env.LANHU_COOKIE || "",
      authorization: process.env.LANHU_AUTHORIZATION,
      tenantId: process.env.LANHU_TENANT_ID,
      projectId: process.env.LANHU_PROJECT_ID,
    };
  }

  // 只有 .env 有 Cookie，Claude 配置缺失 → 询问是否补写
  if (envHasCookie && !claudeHasConfig) {
    config({ path: envPath });

    // 非交互模式（stdio/MCP client）直接返回，不询问
    if (!process.stdin.isTTY) {
      return {
        cookie: process.env.LANHU_COOKIE || "",
        authorization: process.env.LANHU_AUTHORIZATION,
        tenantId: process.env.LANHU_TENANT_ID,
        projectId: process.env.LANHU_PROJECT_ID,
      };
    }

    const rl = readline.createInterface({
      input: process.stdin,
      output: process.stderr,
    });
    const ask = (q: string) => new Promise<string>((r) => rl.question(q, r));

    console.error("");
    console.error("蓝湖 MCP Server — 检测到 .env 已配置，但 Claude 配置文件未同步");
    console.error("");

    const choice = await ask(
      " 是否也写入 ~/.claude/settings.json？(y/N): "
    );
    rl.close();

    if (choice.trim().toLowerCase() === "y") {
      writeClaudeConfig({
        cookie: process.env.LANHU_COOKIE || "",
        authorization: process.env.LANHU_AUTHORIZATION,
        tenantId: process.env.LANHU_TENANT_ID,
        projectId: process.env.LANHU_PROJECT_ID,
      });
      console.error(`已写入 ${CLAUDE_SETTINGS_PATH}`);
    }
    console.error("");

    return {
      cookie: process.env.LANHU_COOKIE || "",
      authorization: process.env.LANHU_AUTHORIZATION,
      tenantId: process.env.LANHU_TENANT_ID,
      projectId: process.env.LANHU_PROJECT_ID,
    };
  }

  // 只有 Claude 配置存在但 .env 缺失 → 从 Claude 配置回填 .env
  if (!envHasCookie && claudeHasConfig) {
    const settings = JSON.parse(fs.readFileSync(CLAUDE_SETTINGS_PATH, "utf-8"));
    const env = settings.mcpServers["lanhu-mcp"].env as Record<string, string>;

    // 用 Claude 配置写入 .env
    const envLines: string[] = [
      "# 蓝湖认证配置（从 Claude settings.json 同步）",
      `LANHU_COOKIE=${env.LANHU_COOKIE}`,
    ];
    if (env.LANHU_AUTHORIZATION) {
      envLines.push(`LANHU_AUTHORIZATION=${env.LANHU_AUTHORIZATION}`);
    }
    if (env.LANHU_TENANT_ID) {
      envLines.push(`LANHU_TENANT_ID=${env.LANHU_TENANT_ID}`);
    }
    if (env.LANHU_PROJECT_ID) {
      envLines.push(`LANHU_PROJECT_ID=${env.LANHU_PROJECT_ID}`);
    }
    fs.writeFileSync(envPath, envLines.join("\n") + "\n", "utf-8");
    fs.chmodSync(envPath, 0o600);

    return {
      cookie: env.LANHU_COOKIE,
      authorization: env.LANHU_AUTHORIZATION,
      tenantId: env.LANHU_TENANT_ID,
      projectId: env.LANHU_PROJECT_ID,
    };
  }

  // —— 首次配置：两个文件都没有 ——
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
  console.error("请选择配置写入位置：");
  console.error("  1. .env 文件（本地环境变量，所有工具通用）");
  console.error("  2. Claude 配置文件（~/.claude/settings.json）");
  console.error("     等效: claude mcp add lanhu-mcp -e LANHU_COOKIE=... -- npx dc-lanhu-mcp-server");
  console.error("  3. 两者都写");
  console.error("");

  const targetChoice = await ask("请选择 (1/2/3，默认 3): ");
  let target: ConfigTarget;
  if (targetChoice.trim() === "1") target = "env";
  else if (targetChoice.trim() === "2") target = "claude";
  else target = "both";

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

  const configData = {
    cookie: cookie.trim(),
    authorization: authorization.trim() || undefined,
    tenantId: tenantId.trim() || undefined,
    projectId,
  };

  // 写入 .env
  if (target === "env" || target === "both") {
    const envLines: string[] = [
      "# 蓝湖认证配置（由首次引导自动生成）",
      `LANHU_COOKIE=${configData.cookie}`,
    ];
    if (configData.authorization) {
      envLines.push(`LANHU_AUTHORIZATION=${configData.authorization}`);
    }
    if (configData.tenantId) {
      envLines.push(`LANHU_TENANT_ID=${configData.tenantId}`);
    }
    if (configData.projectId) {
      envLines.push(`LANHU_PROJECT_ID=${configData.projectId}`);
    }
    fs.writeFileSync(envPath, envLines.join("\n") + "\n", "utf-8");
    fs.chmodSync(envPath, 0o600);
    console.error("");
    console.error(`配置已写入 ${envPath}（权限 600）`);
  }

  // 写入 Claude settings.json
  if (target === "claude" || target === "both") {
    writeClaudeConfig(configData);
    console.error("");
    console.error(`配置已写入 ${CLAUDE_SETTINGS_PATH}`);
    console.error("  等效命令: claude mcp add lanhu-mcp -e LANHU_COOKIE=\"...\" -e LANHU_AUTHORIZATION=\"...\" -- npx dc-lanhu-mcp-server");
  }

  if (configData.projectId) console.error(`  项目 ID: ${configData.projectId}`);
  console.error("");

  return configData;
}

// ─── 错误监控 & 日志 ─────────────────────────────────────

const LOG_DIR = path.join(os.homedir(), ".lanhu-mcp");
const LOG_FILE = path.join(LOG_DIR, "error.log");

/**
 * 确保日志目录存在
 */
function ensureLogDir(): void {
  if (!fs.existsSync(LOG_DIR)) {
    fs.mkdirSync(LOG_DIR, { recursive: true });
  }
}

/**
 * 写入错误日志
 */
function logError(type: string, error: Error | string, context?: Record<string, unknown>): void {
  try {
    ensureLogDir();
    const timestamp = new Date().toISOString();
    const message = error instanceof Error ? error.message : error;
    const stack = error instanceof Error ? error.stack || "" : "";
    const ctx = context ? `\nContext: ${JSON.stringify(context, null, 2)}` : "";
    const logEntry = `[${timestamp}] ${type}: ${message}\n${stack}${ctx}\n${"─".repeat(80)}\n`;
    fs.appendFileSync(LOG_FILE, logEntry, "utf-8");
  } catch (e) {
    // 日志写入失败不影响主流程
    console.error("日志写入失败:", e);
  }
}

/**
 * 设置全局错误捕获
 */
function setupErrorHandlers(): void {
  // 未捕获的异常
  process.on("uncaughtException", (error) => {
    logError("UNCAUGHT_EXCEPTION", error, { pid: process.pid });
    console.error("[FATAL] 未捕获的异常，已记录到", LOG_FILE);
    console.error(error);
    process.exit(1);
  });

  // 未处理的 Promise 拒绝
  process.on("unhandledRejection", (reason, promise) => {
    const error = reason instanceof Error ? reason : new Error(String(reason));
    logError("UNHANDLED_REJECTION", error, { pid: process.pid });
    console.error("[ERROR] 未处理的 Promise 拒绝，已记录到", LOG_FILE);
    console.error(error);
  });

  // 进程退出前记录
  process.on("exit", (code) => {
    if (code !== 0) {
      logError("PROCESS_EXIT", `进程退出，退出码: ${code}`, { pid: process.pid });
    }
  });

  // 信号处理（SIGTERM, SIGINT）
  process.on("SIGTERM", () => {
    logError("SIGTERM", "收到 SIGTERM 信号，准备退出", { pid: process.pid });
    process.exit(0);
  });

  process.on("SIGINT", () => {
    logError("SIGINT", "收到 SIGINT 信号，准备退出", { pid: process.pid });
    process.exit(0);
  });
}

// 启动错误监控
setupErrorHandlers();

/**
 * 蓝湖 MCP Server 入口
 *
 * 启动方式：
 *   npm run dev        # 开发模式（tsx）
 *   npm run build && npm start  # 生产模式
 *
 * Claude Code 配置：
 *   claude mcp add lanhu-mcp -- node dist/index.js
 *
 * 错误日志：
 *   ~/.lanhu-mcp/error.log
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

  // 创建 MCP Server（版本号从 package.json 动态读取，始终与发布版本一致）
  const server = new McpServer({
    name: "lanhu-mcp-server",
    version: pkg.version,
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
