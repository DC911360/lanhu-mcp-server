/**
 * HTML 实体转义
 *
 * 防止设计稿图层名称等不可信数据注入到生成的 HTML 中。
 * 转义 5 个关键字符: & < > " '
 */
export function escapeHTML(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}
