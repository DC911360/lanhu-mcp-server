import * as path from "node:path";
import * as os from "node:os";

/**
 * 禁止写入的系统目录前缀
 *
 * 所有路径解析为绝对路径后，若以此列表中任一项为前缀，则拒绝写入。
 */
const BLOCKED_PREFIXES: string[] = [
  // Linux
  "/etc", "/usr", "/var", "/sys", "/proc", "/dev",
  "/root", "/boot", "/sbin", "/lib", "/bin",
  // macOS
  "/System", "/Library", "/private/var",
];

// Windows 系统目录（仅在 Windows 平台追加）
if (process.platform === "win32") {
  BLOCKED_PREFIXES.push(
    "C:\\Windows", "C:\\Program Files", "C:\\Program Files (x86)",
    "C:\\ProgramData",
  );
}

/**
 * 校验输出路径是否安全
 *
 * 拒绝写入：
 * - 系统目录（/etc、/usr、/System 等）
 * - ~/.ssh、~/.gnupg 等敏感目录
 * - 用户主目录本身（防止覆盖文件）
 *
 * @throws Error 路径不安全时抛出
 * @returns 解析后的绝对路径
 */
export function assertSafeOutputPath(raw: string): string {
  const resolved = path.resolve(raw);
  const home = os.homedir();

  // 系统目录
  for (const prefix of BLOCKED_PREFIXES) {
    if (resolved === prefix || resolved.startsWith(prefix + path.sep)) {
      throw new Error(`禁止写入系统目录: ${resolved}`);
    }
  }

  // 敏感用户目录
  const sensitiveDirs = [
    path.join(home, ".ssh"),
    path.join(home, ".gnupg"),
    path.join(home, ".aws"),
    path.join(home, ".config"),
    path.join(home, ".kube"),
    path.join(home, ".docker"),
    path.join(home, ".gcloud"),
    path.join(home, ".npm"),
    path.join(home, ".nvm"),
    // Shell 配置文件
    path.join(home, ".bashrc"),
    path.join(home, ".zshrc"),
    path.join(home, ".bash_profile"),
    path.join(home, ".zshenv"),
    path.join(home, ".profile"),
  ];
  for (const dir of sensitiveDirs) {
    if (resolved === dir || resolved.startsWith(dir + path.sep)) {
      throw new Error(`禁止写入敏感目录: ${resolved}`);
    }
  }

  // 用户主目录本身
  if (resolved === home) {
    throw new Error(`禁止写入用户主目录，请指定子目录`);
  }

  return resolved;
}
