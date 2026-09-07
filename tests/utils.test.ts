/**
 * 工具模块单元测试
 *
 * 使用 Node.js 内置 test runner (node:test + node:assert)
 * 运行: npx tsx tests/utils.test.ts
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";

import { escapeHTML } from "../src/utils/escape.js";
import { assertSafeOutputPath } from "../src/utils/path-guard.js";
import { isRetryableError } from "../src/utils/retry.js";
import { assertValidId, assertValidProjectId, assertValidImageId } from "../src/utils/validate.js";
import { parseRGBA, parseStyle, guessType, round, to1x } from "../src/parser/style.js";

// ─── escapeHTML ────────────────────────────────────────

describe("escapeHTML", () => {
  it("应转义所有关键字符", () => {
    assert.equal(escapeHTML(`<script>alert("xss")</script>`),
      `&lt;script&gt;alert(&quot;xss&quot;)&lt;/script&gt;`);
  });

  it("应转义 & 符号", () => {
    assert.equal(escapeHTML("a & b"), "a &amp; b");
  });

  it("应转义单引号", () => {
    assert.equal(escapeHTML("it's"), "it&#39;s");
  });

  it("空字符串返回空", () => {
    assert.equal(escapeHTML(""), "");
  });

  it("无特殊字符不变", () => {
    assert.equal(escapeHTML("hello world"), "hello world");
  });
});

// ─── assertSafeOutputPath ──────────────────────────────

describe("assertSafeOutputPath", () => {
  it("允许相对路径解析", () => {
    const result = assertSafeOutputPath("./output/design");
    assert.ok(result.includes("output/design") || result.includes("output\\design"));
  });

  it("拒绝 /etc 目录", () => {
    assert.throws(() => assertSafeOutputPath("/etc"), /禁止写入系统目录/);
  });

  it("拒绝 /etc/passwd", () => {
    assert.throws(() => assertSafeOutputPath("/etc/passwd"), /禁止写入系统目录/);
  });

  it("拒绝 /usr/local", () => {
    assert.throws(() => assertSafeOutputPath("/usr/local/bin"), /禁止写入系统目录/);
  });

  it("拒绝 /System (macOS)", () => {
    assert.throws(() => assertSafeOutputPath("/System/Library"), /禁止写入系统目录/);
  });

  it("拒绝用户主目录本身", () => {
    assert.throws(() => assertSafeOutputPath(process.env.HOME || "~"), /禁止写入用户主目录/);
  });
});

// ─── isRetryableError ──────────────────────────────────

describe("isRetryableError", () => {
  it("超时错误可重试", () => {
    assert.ok(isRetryableError({ code: "ETIMEDOUT" }));
    assert.ok(isRetryableError({ code: "ECONNABORTED" }));
  });

  it("连接错误可重试", () => {
    assert.ok(isRetryableError({ code: "ECONNRESET" }));
    assert.ok(isRetryableError({ code: "ECONNREFUSED" }));
  });

  it("5xx 错误可重试", () => {
    assert.ok(isRetryableError({ response: { status: 500 } }));
    assert.ok(isRetryableError({ response: { status: 503 } }));
  });

  it("4xx 错误不可重试", () => {
    assert.ok(!isRetryableError({ response: { status: 400 } }));
    assert.ok(!isRetryableError({ response: { status: 404 } }));
  });

  it("null/undefined 不可重试", () => {
    assert.ok(!isRetryableError(null));
    assert.ok(!isRetryableError(undefined));
  });
});

// ─── assertValidId ─────────────────────────────────────

describe("assertValidId", () => {
  it("接受合法 UUID", () => {
    assert.doesNotThrow(() => assertValidId("550e8400-e29b-41d4-a716-446655440000", "testId"));
  });

  it("接受合法短 ID", () => {
    assert.doesNotThrow(() => assertValidId("abc123def456", "testId"));
  });

  it("拒绝空字符串", () => {
    assert.throws(() => assertValidId("", "testId"), /不能为空/);
  });

  it("拒绝过短的 ID", () => {
    assert.throws(() => assertValidId("abc", "testId"), /格式不合法/);
  });

  it("拒绝含特殊字符的 ID", () => {
    assert.throws(() => assertValidId("abc/../etc", "testId"), /格式不合法/);
  });
});

// ─── parser/style ──────────────────────────────────────

describe("parseRGBA", () => {
  it("解析标准 RGBA", () => {
    const result = parseRGBA({ r: 255, g: 128, b: 0, a: 0.5 });
    assert.equal(result.r, 255);
    assert.equal(result.g, 128);
    assert.equal(result.b, 0);
    assert.equal(result.a, 0.5);
    assert.equal(result.value, "rgba(255,128,0,0.5)");
  });

  it("缺少字段时默认 0/1", () => {
    const result = parseRGBA({ r: 100 });
    assert.equal(result.g, 0);
    assert.equal(result.b, 0);
    assert.equal(result.a, 1);
  });
});

describe("round", () => {
  it("四舍五入到两位小数", () => {
    assert.equal(round(3.14159), 3.14);
    assert.equal(round(2.555), 2.56);
    // 注意：IEEE 754 浮点精度 — 1.005 * 100 = 100.4999... 所以 round 为 1
    assert.equal(round(1.005), 1);
    assert.equal(round(1.006), 1.01);
  });
});

describe("to1x", () => {
  it("scale > 1 时除以 scale", () => {
    assert.equal(to1x(100, 2), 50);
    assert.equal(to1x(75, 3), 25);
  });

  it("scale <= 1 时不转换", () => {
    assert.equal(to1x(100, 1), 100);
    assert.equal(to1x(100, 0.5), 100);
  });
});

describe("guessType", () => {
  it("有 text.text 字段 → text", () => {
    assert.equal(guessType({ text: { text: "hello" } }), "text");
  });

  it("有 ddsType artboard-group → artboard", () => {
    assert.equal(guessType({ ddsType: "artboard-group" }), "artboard");
  });

  it("有 image fill → image", () => {
    assert.equal(guessType({ fills: [{ type: "image" }] }), "image");
  });

  it("有 layers → group", () => {
    assert.equal(guessType({ layers: [{}] }), "group");
  });

  it("形状名称 → shape", () => {
    assert.equal(guessType({ name: "矩形" }), "shape");
    assert.equal(guessType({ name: "Vector" }), "shape");
  });

  it("无法识别 → unknown", () => {
    assert.equal(guessType({}), "unknown");
  });
});

describe("parseStyle", () => {
  it("解析空 raw 返回默认值", () => {
    const style = parseStyle({}, 1);
    assert.deepEqual(style.fills, []);
    assert.deepEqual(style.borders, []);
    assert.deepEqual(style.shadows, []);
    assert.equal(style.opacity, 1);
    assert.equal(style.visible, true);
  });

  it("解析颜色填充", () => {
    const style = parseStyle({ fills: [{ type: "color", color: { r: 255, g: 0, b: 0, a: 1 } }] }, 1);
    assert.equal(style.fills.length, 1);
    assert.equal(style.fills[0].type, "color");
    assert.equal(style.fills[0].color?.r, 255);
  });
});

console.log("\n✅ 所有测试运行完成\n");
