/**
 * 输入校验工具
 *
 * 防止无效 ID 直接拼入 API 请求。
 */

/** 通用 ID 格式：字母数字下划线连字符，6~64 位 */
const ID_RE = /^[\w-]{6,64}$/;

/** UUID 格式 */
const UUID_RE = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i;

/**
 * 校验通用 ID（imageId 等）
 * @throws Error 无效时抛出
 */
export function assertValidId(value: string, name: string): void {
  if (!value || typeof value !== "string") {
    throw new Error(`${name} 不能为空`);
  }
  if (!ID_RE.test(value) && !UUID_RE.test(value)) {
    throw new Error(`无效的 ${name}: "${value}"（格式不合法）`);
  }
}

/**
 * 校验 projectId（UUID 或短 ID）
 */
export function assertValidProjectId(value: string): void {
  assertValidId(value, "projectId");
}

/**
 * 校验 imageId
 */
export function assertValidImageId(value: string): void {
  assertValidId(value, "imageId");
}
