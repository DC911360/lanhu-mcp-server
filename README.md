# 蓝湖 MCP Server

让 AI 编程工具（Claude Code / Cursor / Cline 等）直接读取蓝湖设计稿数据，实现 Design to Code 自动化。

## 功能

- **项目浏览** — 列出团队项目、设计稿列表、分区信息
- **精确设计数据** — 获取完整图层树（@1x 绝对坐标、全量样式 fill/border/shadow/typography）
- **DDS 语义化组件树** — 获取蓝湖 AI 识别的 UI 组件结构（NavBar / Avatar / Input / ImageText 等），包含 row/col 布局和精确样式
- **代码生成** — 基于 DDS 语义数据生成 Vue 3 SFC 或纯 HTML 代码
- **一键下载** — 通过 Puppeteer 提取 DDS 官方生成的 Vue/CSS 代码 + 下载所有切图 + 替换为本地路径
- **Design Tokens** — 自动提取颜色、字体、间距、圆角等设计变量
- **资源下载** — 封面图、切图、导出图片下载

## 安装

```bash
npm install -g dc-lanhu-mcp-server
```

或免安装直接使用：

```bash
npx dc-lanhu-mcp-server
```

## 配置方式

### 快速开始（30 秒）

**个人开发者** — 一行命令注册到 Claude Code：

```bash
claude mcp add lanhu-mcp \
  -e LANHU_COOKIE="你的cookie" \
  -e LANHU_AUTHORIZATION="你的token" \
  -- npx dc-lanhu-mcp-server
```

**团队协作** — 项目根目录创建 `.mcp.json`，配置随代码走：

```json
{
  "mcpServers": {
    "lanhu-mcp": {
      "type": "stdio",
      "command": "npx",
      "args": ["dc-lanhu-mcp-server"],
      "env": {
        "LANHU_COOKIE": "你的cookie",
        "LANHU_AUTHORIZATION": "你的token"
      }
    }
  }
}
```

### 配置方式对比

| 方式 | 适用场景 | 配置位置 | 特点 |
|------|---------|---------|------|
| **CLI 注册** | 个人开发 | `~/.claude/settings.json` | 一行命令，全局生效 |
| **项目级配置** | 团队协作 | 项目 `.mcp.json` | 可提交 git，团队共享 |
| **环境变量** | CI/CD、临时测试 | `process.env` | 运行时注入，最高优先级 |
| **交互引导** | 首次使用 | `.env` 或 `settings.json` | 无配置时自动提示 |
| **手动编辑** | 高级用户 | 任意配置文件 | 完全控制 |

### 方式 1：CLI 注册（推荐个人使用）

通过 Claude Code CLI 注册，配置写入全局 `~/.claude/settings.json`：

```bash
# 使用 npx（免安装）
claude mcp add lanhu-mcp \
  -e LANHU_COOKIE="你的cookie" \
  -e LANHU_AUTHORIZATION="你的token" \
  -- npx dc-lanhu-mcp-server

# 使用本地安装路径（更快启动）
claude mcp add lanhu-mcp \
  -e LANHU_COOKIE="你的cookie" \
  -- node /path/to/dc-lanhu-mcp-server/dist/index.js

# 验证是否添加成功
claude mcp list
```

### 方式 2：项目级配置（推荐团队使用）

在项目根目录创建 `.mcp.json`，配置随项目走，可提交到 git：

```json
{
  "mcpServers": {
    "lanhu-mcp": {
      "type": "stdio",
      "command": "npx",
      "args": ["dc-lanhu-mcp-server"],
      "env": {
        "LANHU_COOKIE": "你的cookie",
        "LANHU_AUTHORIZATION": "你的token",
        "LANHU_PROJECT_ID": "可选：默认项目 ID"
      }
    }
  }
}
```

**优势：**
- ✅ 配置跟随项目，新成员 clone 后即可使用
- ✅ 可加入 `.gitignore` 保护敏感信息，或用环境变量替换
- ✅ Server 启动时自动发现，零配置运行

**支持路径：**
- `.mcp.json`（标准）
- `.cursor/mcp.json`（Cursor 专用）

### 方式 3：环境变量注入

通过环境变量传递，适用于 CI/CD 或临时测试：

```bash
# 临时设置
export LANHU_COOKIE="你的cookie"
export LANHU_AUTHORIZATION="你的token"
npx dc-lanhu-mcp-server

# 或一行命令
LANHU_COOKIE="你的cookie" LANHU_AUTHORIZATION="你的token" npx dc-lanhu-mcp-server
```

**优先级最高** — 会覆盖所有配置文件中的值。

### 方式 4：交互引导

首次运行时无任何配置，Server 会自动进入交互引导：

```bash
npx dc-lanhu-mcp-server
```

引导流程：
1. 提示输入 Cookie 和 Authorization
2. 选择写入位置（`.env` / `settings.json` / 两者）
3. 自动保存，下次启动无需重复输入

### 方式 5：手动编辑配置文件

直接编辑配置文件，适合高级用户：

**Claude Code** — `~/.claude/settings.json`：

```json
{
  "mcpServers": {
    "lanhu-mcp": {
      "command": "npx",
      "args": ["dc-lanhu-mcp-server"],
      "env": {
        "LANHU_COOKIE": "你的cookie",
        "LANHU_AUTHORIZATION": "你的token"
      }
    }
  }
}
```

**Cursor** — `~/.cursor/mcp.json` 或项目 `.cursor/mcp.json`：

```json
{
  "mcpServers": {
    "lanhu-mcp": {
      "command": "npx",
      "args": ["dc-lanhu-mcp-server"],
      "env": {
        "LANHU_COOKIE": "你的cookie",
        "LANHU_AUTHORIZATION": "你的token"
      }
    }
  }
}
```

**Cline (VS Code)** — Cline 设置 → MCP Servers

**Windsurf** — `~/.codeium/windsurf/mcp_config.json`

### 配置优先级

多个配置源共存时，按以下优先级加载（局部 > 全局）：

```
process.env → .mcp.json → .env → settings.json → 交互引导
     ↑            ↑          ↑         ↑             ↑
  环境变量     项目级配置   本地env   Claude全局    首次兜底
```

**示例：**
- 同时有 `.mcp.json` 和 `.env` → 使用 `.mcp.json`
- 同时有环境变量和配置文件 → 使用环境变量
- 只有 `settings.json` → 自动回填 `.env`

## 获取蓝湖凭证

1. 登录 [蓝湖网页版](https://lanhuapp.com)
2. F12 打开开发者工具
3. 进入 **Network** 标签
4. 刷新页面，选择任意 Fetch/XHR 请求
5. 在 **Request Headers** 中复制：
   - `Cookie` → `LANHU_COOKIE`
   - `Authorization` → `LANHU_AUTHORIZATION`（可选，部分接口需要）

## MCP Tools

| Tool | 说明 |
|------|------|
| `lanhu_list_projects` | 列出团队项目/文件夹 |
| `lanhu_get_designs` | 获取项目下的设计稿列表 |
| `lanhu_get_design_detail` | 获取设计稿详情（尺寸、预览图、版本） |
| `lanhu_get_design_document` | 获取完整精确结构化设计数据（核心） |
| `lanhu_get_annotations` | 获取标注数据（图层树） |
| `lanhu_get_preview` | 获取预览图 URL |
| `lanhu_get_tokens` | 提取 Design Tokens |
| `lanhu_get_sectors` | 获取项目分区信息 |
| `lanhu_get_dds_schema` | 获取 DDS 语义化 UI 组件树 |
| `lanhu_generate_code` | 基于 DDS 数据生成 Vue / HTML 代码 |
| `lanhu_download_design` | 一键下载设计稿（DDS 代码 + 切图） |
| `lanhu_download_cover` | 下载设计稿封面图 |
| `lanhu_download_image` | 下载任意图片到本地 |

## 环境变量

| 变量 | 必需 | 说明 |
|------|------|------|
| `LANHU_COOKIE` | 是 | 蓝湖登录 Cookie |
| `LANHU_AUTHORIZATION` | 否 | Authorization Token（部分接口需要） |
| `LANHU_TENANT_ID` | 否 | 租户 ID（列出项目时需要） |
| `LANHU_PROJECT_ID` | 否 | 默认项目 ID（不传则需每次指定） |
| `CHROME_PATH` | 否 | Chrome 路径（`lanhu_download_design` 需要，默认自动检测） |

## 测试

### 方式一：MCP Inspector（推荐）

[MCP Inspector](https://github.com/modelcontextprotocol/inspector) 是官方调试工具，提供 Web UI 可以直接调用 Tools：

```bash
# 设置环境变量
export LANHU_COOKIE="你的cookie"
export LANHU_AUTHORIZATION="你的token"

# 启动 Inspector
npx @modelcontextprotocol/inspector node dist/index.js
```

浏览器会打开 `http://localhost:5173`，可以：
- 查看所有注册的 Tools
- 手动调用每个 Tool 并查看返回结果
- 调试输入参数

### 方式二：直接在 Claude Code 中测试

```bash
# 1. 添加 MCP Server
claude mcp add lanhu-mcp -e LANHU_COOKIE="你的cookie" -- node $(pwd)/dist/index.js

# 2. 启动 Claude Code，直接对话测试
claude

# 然后在对话中说：
# "列出我的蓝湖项目"
# "获取设计稿 xxx 的数据"
```

### 方式三：命令行快速验证

```bash
# 确认 Server 能正常启动（会等待 stdio 输入）
echo '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2024-11-05","capabilities":{},"clientInfo":{"name":"test","version":"0.1.0"}}}' | LANHU_COOKIE="你的cookie" node dist/index.js
```

### 方式四：开发模式 + Inspector

```bash
# 使用 tsx 直接运行，改代码无需重新构建
npx @modelcontextprotocol/inspector npx tsx src/index.ts
```

## 项目结构

```
src/
├── index.ts          # MCP Server 入口（首次配置引导 + stdio 启动）
├── client.ts         # 蓝湖 API 客户端（图层解析、DDS、下载）
├── tools.ts          # MCP Tools 注册
├── dds-codegen.ts    # DDS → Vue / HTML 代码生成器
├── dds-puppeteer.ts  # Puppeteer 提取 DDS 官方代码 + 切图下载
└── types.ts          # 类型定义
```

## 参考

- [蓝湖官网](https://lanhuapp.com)
- [MCP 协议规范](https://modelcontextprotocol.io)
- [@modelcontextprotocol/sdk](https://www.npmjs.com/package/@modelcontextprotocol/sdk)
- [MCP Inspector](https://github.com/modelcontextprotocol/inspector) — 官方调试工具
- [dsphper/lanhu-mcp](https://github.com/dsphper/lanhu-mcp) — 社区参考实现
- [Puppeteer](https://pptr.dev) — DDS 代码提取依赖
