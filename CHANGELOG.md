# Changelog

All notable changes to this project will be documented in this file.

## [1.3.0] - 2026-09-07

### 🆕 新增功能

- **浏览器测试页面**：`npm run dev:server` 启动 HTTP 测试服务器（`http://localhost:3900`），可视化测试全部 14 个工具
- **URL 自动解析**：测试页面支持粘贴蓝湖 URL 自动提取 `imageId` / `projectId`，字段自动只读
- **`lanhu_get_layer_detail` 工具**：按需获取单个图层的完整详情（样式 + 原始数据）
- **错误日志系统**：所有工具调用自动记录到 `~/.lanhu-mcp/error.log`
- **LRU 缓存**：设计文档和 DDS Schema 自动缓存，5 分钟 TTL，最大 50 条
- **自动重试机制**：可重试网络错误自动指数退避重试（最多 2 次）
- **`LANHU_DEBUG` 调试模式**：环境变量开启后输出详细调试信息

###  性能优化

- **Puppeteer 懒加载**：从硬依赖改为动态导入，13/14 个工具启动无需加载 ~40MB 的 puppeteer-core
- **CodeMirror 轮询等待**：从固定 `setTimeout(8000ms)` 改为轮询检测内容就绪，快的设计稿提前完成
- **精确 DOM 选择**：HTML 模式切换从 `querySelectorAll("*")` 改为 `.el-cascader` 精确选择
- **autoDiscover 三级策略**：用户 API → workbench API → 兜底，首次连接更快更稳

### 🔧 改进

- **`lanhu_generate_code` 新增 `projectId` 参数**：修复 projectId 传不进去的 bug，支持显式指定项目
- **CodeMirror 提取精度提升**：严格过滤设计代码，不再抓取 DDS 页面的 SVG 图标
- **错误提示改进**：提取失败时包含原因分析（设计集/D2C未开启）和 debug 信息
- **`getDesignDocument` 新增参数**：`depth`（默认 2 层）、`includeStyles`、`includeRaw`
- **`lanhu_get_annotations` 新增 `filter` 参数**：支持按图层名模糊搜索

### 🔒 安全加固

- **SSRF 防护**：`lanhu_download_image` 仅允许 HTTPS + 蓝湖域名白名单
- **路径安全校验**：所有 outputPath 经 `assertSafeOutputPath()` 校验，防止路径穿越
- **Puppeteer 沙箱**：默认启用沙箱，仅 Docker 环境关闭

###  Bug 修复

- `lanhu_generate_code` 的 `projectId` 参数无法传递（新增参数 + 优先级逻辑）
- CodeMirror 提取抓到 DDS 页面的 SVG 图标而非设计代码
- DOM 降级提取返回垃圾内容（改为清晰报错）
- `LOCALAPPDATA` 环境变量拼写错误（`LOCAPPDATA` → `LOCALAPPDATA`）

### 📦 默认路径变更

- 下载/生成默认输出路径从 `/tmp` 改为 `~/Desktop`，方便手动清理

---

## [1.2.2] - 2026-08-26

- 优化工具返回数据量，支持按需获取
- 错误监控 + 多 Agent 接入指南 + bug 修复

## [1.2.1] - 2026-08-25

- 初始版本发布
