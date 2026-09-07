/**
 * 重试工具
 *
 * 用于蓝湖 API 偶发超时场景，提升用户体验。
 */

/**
 * 判断是否为可重试的网络错误
 */
export function isRetryableError(err: unknown): boolean {
  if (!err || typeof err !== "object") return false;
  const e = err as any;
  // 超时
  if (e.code === "ECONNABORTED" || e.code === "ETIMEDOUT") return true;
  // 网络错误
  if (e.code === "ECONNRESET" || e.code === "ECONNREFUSED") return true;
  // 5xx 服务端错误
  if (e.response?.status >= 500) return true;
  return false;
}
