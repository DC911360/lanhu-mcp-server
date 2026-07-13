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

> **只需 2 个字段**：`LANHU_COOKIE` + `LANHU_AUTHORIZATION`。
> `tenantId` 自动发现为 `"0"`（已验证可用），`projectId` 通过 `lanhu_set_project` 从 URL 自动提取，或在工具参数中直接传入。

### 5 种配置方式总览

| # | 方式 | 优先级 | 配置位置 | 适用场景 |
|---|------|--------|---------|---------|
| ① | 环境变量 | 最高 | `process.env` | CI/CD、Docker、临时测试 |
| ② | `.mcp.json` | 高 | 项目根目录 | 团队协作，配置随代码走 |
| ③ | `.env` | 中 | 包安装目录 | 本地开发，不提交 git |
| ④ | `settings.json` | 低 | `~/.claude/settings.json` | 个人开发者，全局生效 |
| ⑤ | 交互引导 | 兜底 | 运行时输入 | 首次使用，零配置启动 |

```
优先级：① > ② > ③ > ④ > ⑤（高优先级覆盖低优先级）
```

---

### ① 环境变量（优先级最高）

通过进程环境变量注入，适用于 CI/CD、Docker 容器或临时测试：

```bash
# 方式 A：export 后启动
export LANHU_COOKIE="你的cookie"
export LANHU_AUTHORIZATION="你的token"
npx dc-lanhu-mcp-server

# 方式 B：一行命令
LANHU_COOKIE="你的cookie" LANHU_AUTHORIZATION="你的token" npx dc-lanhu-mcp-server

# 方式 C：Docker / CI 环境变量
# 在 Dockerfile 或 CI 配置中设置 LANHU_COOKIE 和 LANHU_AUTHORIZATION
```

会覆盖所有配置文件中的值。

---

### ② `.mcp.json` 项目级配置（推荐团队使用）

在项目根目录创建 `.mcp.json`，配置随代码走，可提交到 git：

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

**优势：**
- ✅ 只需 2 个字段，`tenantId`/`projectId` 自动发现
- ✅ 配置跟随项目，新成员 clone 后即可使用
- ✅ 可加入 `.gitignore` 保护敏感信息

**支持路径：**
- `.mcp.json`（标准，Claude Code / Cursor 通用）
- `.cursor/mcp.json`（Cursor 专用）

---

### ③ `.env` 本地文件

在 `dc-lanhu-mcp-server` 包安装目录下创建 `.env` 文件：

```env
LANHU_COOKIE=你的cookie
LANHU_AUTHORIZATION=你的token
```

文件权限自动设为 `600`（仅所有者可读写）。

适用：本地开发，不想污染全局配置。

---

### ④ `settings.json` 全局配置（推荐个人使用）

通过 Claude Code CLI 注册，配置写入 `~/.claude/settings.json`，所有项目通用：

```bash
# 注册
claude mcp add lanhu-mcp \
  -e LANHU_COOKIE="你的cookie" \
  -e LANHU_AUTHORIZATION="你的token" \
  -- npx dc-lanhu-mcp-server

# 验证
claude mcp list

# 使用本地安装路径（更快启动）
claude mcp add lanhu-mcp \
  -e LANHU_COOKIE="你的cookie" \
  -e LANHU_AUTHORIZATION="你的token" \
  -- node /path/to/dc-lanhu-mcp-server/dist/index.js
```

也支持手动编辑 `~/.claude/settings.json`：

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

---

### ⑤ 交互引导（首次兜底）

无任何配置时，首次运行自动进入交互引导：

```bash
npx dc-lanhu-mcp-server
```

引导流程：
1. 提示输入 `LANHU_COOKIE`
2. 提示输入 `LANHU_AUTHORIZATION`（可选，直接回车跳过）
3. 提示输入 `tenantId`（可选，直接回车跳过 → 自动发现）
4. 粘贴蓝湖项目 URL（可选，直接回车跳过 → 通过 `lanhu_set_project` 设置）
5. 选择写入位置（`.env` / `settings.json` / 两者）
6. 自动保存，下次启动无需重复输入

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
   - `Cookie` → `LANHU_COOKIE`（必需）
   - `Authorization` → `LANHU_AUTHORIZATION`（推荐，部分接口需要）

> 只需这 2 个凭证，`tenantId` 和 `projectId` 不需要手动获取。

## 使用流程

```
配置凭证（2 个字段）→ 设置项目（URL 自动提取）→ 获取设计数据
```

**第一步：配置凭证** — 选择上述 5 种方式之一，只需 `LANHU_COOKIE` + `LANHU_AUTHORIZATION`

**第二步：设置项目** — 两种方式任选：
- 调用 `lanhu_set_project` 传入蓝湖 URL，自动提取 `projectId`（推荐）
- 或在每个工具调用中直接传 `projectId` 参数

**第三步：获取设计数据** — 调用 `lanhu_get_design_document` 等工具

```
# 示例：在 Claude Code 中对话

> "从这个蓝湖链接获取设计稿并生成 Vue 组件：
>  https://lanhuapp.com/web/#/item/project/detailDetach?pid=xxx&project_id=xxx&image_id=yyy"

# MCP Server 自动完成：
# 1. 从 URL 提取 projectId 和 imageId
# 2. autoDiscover() 设置 tenantId = "0"
# 3. 调用 getDesignDocument(imageId, projectId)
# 4. 返回完整设计数据（图层树 + 样式 + Design Tokens）
```

## MCP Tools

| Tool | 说明 |
|------|------|
| `lanhu_set_project` | 从蓝湖 URL 中提取并设置默认 projectId（设置后后续工具免传） |
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
| `LANHU_TENANT_ID` | 否 | 租户 ID（不配置则自动发现，默认 `"0"` 已验证可用） |
| `LANHU_PROJECT_ID` | 否 | 默认项目 ID（不配置则通过工具参数传入，或使用 `lanhu_set_project` 设置） |
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

### 使用流程

1. **配置凭证** — `.mcp.json` 中只需 `LANHU_COOKIE` + `LANHU_AUTHORIZATION`
2. **设置项目**（二选一）：
   - 调用 `lanhu_set_project` 传入蓝湖 URL，自动提取 `projectId`
   - 或在每个工具调用中直接传 `projectId` 参数
3. **获取设计数据** — 调用 `lanhu_get_design_document` 等工具

```
# 示例对话流程：
> "从这个蓝湖链接获取设计稿：https://lanhuapp.com/web/#/item/project/detailDetach?pid=xxx&project_id=xxx&image_id=yyy"

# MCP Server 自动：
# 1. 提取 projectId 和 imageId
# 2. 调用 getDesignDocument(imageId, projectId)
# 3. 返回完整设计数据
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
