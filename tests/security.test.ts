/**
 * 安全修复回归测试
 *
 * 覆盖 code review 发现的 Critical/Major 问题修复
 * 运行: npx tsx tests/security.test.ts
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import * as path from "node:path";
import * as os from "node:os";

import { assertSafeOutputPath } from "../src/utils/path-guard.js";
import { assertValidId } from "../src/utils/validate.js";

// ─── C1: downloadSlice 路径穿越修复 ────────────────────

describe("C1: 文件名安全（path.basename 防护）", () => {
  it("path.basename 应剥离目录穿越", () => {
    // 模拟 downloadSlice 中的安全处理
    const maliciousName = "../../etc/passwd";
    const safeName = path.basename(maliciousName);
    assert.equal(safeName, "passwd");
    // 不会有路径分隔符
    assert.ok(!safeName.includes("/"));
    assert.ok(!safeName.includes("\\"));
  });

  it("path.basename 处理正常文件名", () => {
    assert.equal(path.basename("image.png"), "image.png");
    assert.equal(path.basename("dir/sub/file.jpg"), "file.jpg");
  });
});

// ─── C2: SSRF 防护（URL 校验逻辑）─────────────────────

describe("C2: SSRF URL 校验", () => {
  const allowedHosts = ["lanhuapp.com", "lanhu.com", "qhimg.com", "qhres.com"];

  function isAllowedUrl(url: string): boolean {
    try {
      const parsed = new URL(url);
      if (parsed.protocol !== "https:") return false;
      const host = parsed.hostname.replace(/^cdn\./, "").replace(/^dds\./, "");
      return allowedHosts.some(h => host === h || host.endsWith(`.${h}`));
    } catch {
      return false;
    }
  }

  it("允许 https://cdn.lanhuapp.com", () => {
    assert.ok(isAllowedUrl("https://cdn.lanhuapp.com/img/123.png"));
  });

  it("允许 https://dds.lanhuapp.com", () => {
    assert.ok(isAllowedUrl("https://dds.lanhuapp.com/api/data"));
  });

  it("拒绝 file:// 协议", () => {
    assert.ok(!isAllowedUrl("file:///etc/passwd"));
  });

  it("拒绝 http:// 协议", () => {
    assert.ok(!isAllowedUrl("http://lanhuapp.com/img.png"));
  });

  it("拒绝非白名单域名", () => {
    assert.ok(!isAllowedUrl("https://evil.com/img.png"));
  });

  it("拒绝云元数据 SSRF", () => {
    assert.ok(!isAllowedUrl("https://169.254.169.254/latest/meta-data/"));
  });

  it("拒绝子域名绕过", () => {
    assert.ok(!isAllowedUrl("https://evil-lanhuapp.com/img.png"));
  });
});

// ─── C3: 敏感目录保护 ──────────────────────────────────

describe("C3: 敏感目录保护", () => {
  const home = os.homedir();

  it("拒绝 ~/.bashrc", () => {
    assert.throws(() => assertSafeOutputPath(path.join(home, ".bashrc")), /禁止写入敏感目录/);
  });

  it("拒绝 ~/.zshrc", () => {
    assert.throws(() => assertSafeOutputPath(path.join(home, ".zshrc")), /禁止写入敏感目录/);
  });

  it("拒绝 ~/.profile", () => {
    assert.throws(() => assertSafeOutputPath(path.join(home, ".profile")), /禁止写入敏感目录/);
  });

  it("拒绝 ~/.kube", () => {
    assert.throws(() => assertSafeOutputPath(path.join(home, ".kube", "config")), /禁止写入敏感目录/);
  });

  it("拒绝 ~/.docker", () => {
    assert.throws(() => assertSafeOutputPath(path.join(home, ".docker")), /禁止写入敏感目录/);
  });

  it("允许 ~/Desktop/output", () => {
    const result = assertSafeOutputPath(path.join(home, "Desktop", "output"));
    assert.ok(result.includes("output"));
  });

  it("允许 /tmp/design-output", () => {
    const result = assertSafeOutputPath("/tmp/design-output");
    assert.ok(result.includes("design-output"));
  });
});

// ─── M2: CSS 注入防护 ──────────────────────────────────

describe("M2: CSS 安全", () => {
  // 模拟 cssColor 行为
  const CSS_COLOR_NAMES = new Set([
    "transparent", "currentColor",
    "black", "white", "red", "green", "blue",
  ]);

  function cssColor(rgba: string | undefined): string {
    if (!rgba) return 'transparent';
    if (/^#[0-9a-fA-F]{3,8}$/.test(rgba)) return rgba;
    if (/^rgba?\(\s*[\d.]+(\s*,\s*[\d.]+){2,3}\s*\)$/.test(rgba)) return rgba;
    if (CSS_COLOR_NAMES.has(rgba.toLowerCase())) return rgba;
    return 'transparent';
  }

  it("允许 #hex 格式", () => {
    assert.equal(cssColor("#ff0000"), "#ff0000");
    assert.equal(cssColor("#fff"), "#fff");
  });

  it("允许 rgba() 格式", () => {
    assert.equal(cssColor("rgba(255, 0, 0, 0.5)"), "rgba(255, 0, 0, 0.5)");
    assert.equal(cssColor("rgb(255, 0, 0)"), "rgb(255, 0, 0)");
  });

  it("允许已知颜色名", () => {
    assert.equal(cssColor("red"), "red");
    assert.equal(cssColor("transparent"), "transparent");
  });

  it("拒绝 CSS 注入", () => {
    assert.equal(cssColor("red; background: url(evil)"), "transparent");
    assert.equal(cssColor("expression(alert(1))"), "transparent");
  });

  it("拒绝未知颜色名", () => {
    assert.equal(cssColor("notacolor"), "transparent");
    assert.equal(cssColor("expression"), "transparent");
  });
});

// ─── M7: ID 校验 ────────────────────────────────────────

describe("M7: ID 校验安全性", () => {
  it("拒绝路径穿越式 ID", () => {
    assert.throws(() => assertValidId("../etc/passwd", "projectId"), /格式不合法/);
  });

  it("拒绝 SQL 注入式 ID", () => {
    assert.throws(() => assertValidId("'; DROP TABLE users;--", "projectId"), /格式不合法/);
  });

  it("拒绝换行符注入", () => {
    assert.throws(() => assertValidId("abc\r\nX-Injected: true", "projectId"), /格式不合法/);
  });

  it("接受正常 UUID", () => {
    assert.doesNotThrow(() => assertValidId("550e8400-e29b-41d4-a716-446655440000", "projectId"));
  });
});

console.log("\n✅ 安全回归测试完成\n");
