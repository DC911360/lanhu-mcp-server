/**
 * 全局配置常量
 *
 * 集中管理所有超时、阈值、默认值，避免魔法数字散落各处。
 */
export const CONFIG = {
  // ─── HTTP 超时（毫秒）───────────────────────────
  /** 蓝湖 API 请求超时 */
  apiTimeout: 15_000,
  /** Puppeteer 页面加载超时 */
  puppeteerTimeout: 30_000,
  /** 单张图片下载超时 */
  imageDownloadTimeout: 10_000,

  // ─── Puppeteer 等待超时 ─────────────────────────
  /** 等待 CodeMirror 编辑器加载 */
  codeMirrorWaitTimeout: 30_000,
  /** 等待 CodeMirror 实例初始化（有内容） */
  codeMirrorInitTimeout: 30_000,
  /** 等待模式切换后重新渲染 */
  modeSwitchTimeout: 30_000,

  // ─── 设计稿解析 ──────────────────────────────────
  /** getDesignDocument 默认展开深度 */
  defaultDepth: 2,
  /** 间距提取时的最大阈值（过滤异常值） */
  maxGapThreshold: 200,

  // ─── 缓存 ────────────────────────────────────────
  /** 设计文档缓存 TTL（5 分钟） */
  docCacheTTL: 5 * 60 * 1000,
  /** 缓存最大条目数 */
  maxCacheSize: 50,
} as const;
