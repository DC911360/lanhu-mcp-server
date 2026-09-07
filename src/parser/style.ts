/**
 * 样式解析器
 *
 * 从蓝湖原始图层数据中解析结构化样式：
 * fill / border / shadow / typography / 类型推断
 */
import type {
  LayerStyle, Fill, Border, Shadow, Typography,
  RGBA, LayerType,
} from "../types.js";

// ─── 工具函数 ────────────────────────────────────────

export function to1x(value: number, scale: number): number {
  return scale > 1 ? value / scale : value;
}

export function round(v: number): number {
  return Math.round(v * 100) / 100;
}

export function parseRGBA(c: any): RGBA {
  const r = Math.round(c.r ?? 0);
  const g = Math.round(c.g ?? 0);
  const b = Math.round(c.b ?? 0);
  const a = c.a ?? 1;
  return { r, g, b, a, value: `rgba(${r},${g},${b},${a})` };
}

// ─── 样式解析 ────────────────────────────────────────

export function parseStyle(raw: any, scale: number): LayerStyle {
  return {
    fills: parseFills(raw.fills, scale),
    borders: parseBorders(raw.borders, scale),
    shadows: parseShadows(raw.shadows, scale),
    opacity: raw.style?.opacity ?? raw.opacity ?? 1,
    blendMode: raw.style?.blendMode || "normal",
    visible: raw.isVisible ?? raw.visible ?? true,
    locked: raw.isLocked ?? raw.locked ?? false,
    rotation: raw.rotation ?? raw.style?.rotation ?? 0,
    typography: parseTypography(raw, scale),
  };
}

export function parseFills(rawFills: any[], _scale: number): Fill[] {
  if (!rawFills?.length) return [];
  return rawFills.map((f: any): Fill => {
    if (f.type === "color") {
      return { type: "color", color: f.color ? parseRGBA(f.color) : undefined, opacity: f.opacity ?? 1 };
    }
    if (f.type === "gradient") {
      return {
        type: "gradient",
        gradient: {
          type: f.gradientType || "linear",
          from: { x: f.from?.x || 0, y: f.from?.y || 0 },
          to: { x: f.to?.x || 1, y: f.to?.y || 1 },
          stops: (f.stops || []).map((s: any) => ({ color: parseRGBA(s.color), position: s.position || 0 })),
        },
        opacity: f.opacity ?? 1,
      };
    }
    if (f.type === "image") {
      return { type: "image", image: { url: f.image?.url, mode: f.fillMode || "fill" }, opacity: f.opacity ?? 1 };
    }
    return { type: "color", opacity: f.opacity ?? 1 };
  });
}

export function parseBorders(rawBorders: any[], scale: number): Border[] {
  if (!rawBorders?.length) return [];
  return rawBorders.map((b: any): Border => ({
    color: b.color ? parseRGBA(b.color) : undefined,
    width: round(to1x(b.thickness ?? b.width ?? 1, scale)),
    style: b.dashPattern?.length ? "dashed" : "solid",
    radius: round(to1x(b.radius ?? 0, scale)),
  }));
}

export function parseShadows(rawShadows: any[], scale: number): Shadow[] {
  if (!rawShadows?.length) return [];
  return rawShadows.map((s: any): Shadow => ({
    color: parseRGBA(s.color || { r: 0, g: 0, b: 0, a: 0.25 }),
    offsetX: round(to1x(s.offsetX ?? s.x ?? 0, scale)),
    offsetY: round(to1x(s.offsetY ?? s.y ?? 0, scale)),
    blur: round(to1x(s.blurRadius ?? s.blur ?? 0, scale)),
    spread: round(to1x(s.spread ?? 0, scale)),
    inset: !!s.inset,
  }));
}

// ─── 排版解析 ────────────────────────────────────────

/** 非文本元素名称黑名单 */
const nonTextPatterns = [
  /^蒙版$/, /^矩形$/, /^圆形$/, /^椭圆$/,
  /^编组(\s*\d+)?$/, /^路径(\s*\d+)?$/,
  /^形状$/, /^箭头$/, /^防护$/,
  /^Border$/, /^Cap$/, /^Capacity$/, /^Wifi$/,
  /^Vector$/, /^Group\s*\d+$/, /^Rectangle\s*\d+$/,
  /^顶部背景$/, /^浅色状态栏$/, /^底部栏/,
  /^形状结合$/, /^花瓣素材/, /^91977b5d/,
  /^B1\.\d/,
];

export function parseTypography(raw: any, scale: number): Typography | undefined {
  const style = raw.style || {};
  const textContent = raw.text?.text;

  // 有明确字体数据 → 一定是文本
  if (style.fontSize || style.fontFamily || style.lineHeight || style.textColor) {
    if (nonTextPatterns.some(p => p.test(raw.name)) && !textContent) return undefined;
    return buildTypography(raw, style, textContent, scale);
  }

  // 无字体数据，但 name 像文本（非形状/容器名，且尺寸像文本）
  if (textContent || (!nonTextPatterns.some(p => p.test(raw.name)) && raw.name && raw.name.length <= 30 && (raw.width || 0) < 200 && (raw.height || 0) < 40)) {
    if (nonTextPatterns.some(p => p.test(raw.name))) return undefined;
    return buildTypography(raw, style, textContent, scale);
  }

  return undefined;
}

function buildTypography(raw: any, style: any, textContent: string | undefined, scale: number): Typography {
  return {
    fontFamily: style.fontFamily || "PingFang SC",
    fontSize: round(to1x(style.fontSize || 14, scale)),
    fontWeight: style.fontWeight || 400,
    lineHeight: round(to1x(style.lineHeight || style.fontSize || 14, scale)),
    letterSpacing: round(to1x(style.kerning ?? style.letterSpacing ?? 0, scale)),
    textAlign: style.textAlign || "left",
    color: style.textColor ? parseRGBA(style.textColor) : { r: 26, g: 26, b: 26, a: 1, value: "#1A1A1A" },
    text: textContent || raw.name || "",
  };
}

// ─── 类型推断 ────────────────────────────────────────

function isShapeName(name: string): boolean {
  return /^(矩形|圆形|椭圆|路径|形状|编组|蒙版|Border|Cap|Vector|Group|Rectangle)/.test(name);
}

export function guessType(raw: any): LayerType {
  if (raw.text?.text !== undefined) return "text";
  if (raw.style?.fontSize && !isShapeName(raw.name)) return "text";
  if (raw.ddsType === "artboard-group") return "artboard";
  if (raw.fills?.some((f: any) => f.type === "image")) return "image";
  if (raw.layers?.length) return "group";
  if (raw.symbolID) return "symbol";
  if (raw.points || raw.shapeType) return "shape";
  if (isShapeName(raw.name)) return "shape";
  return "unknown";
}

export function getExportFormats(raw: any): string[] {
  const exports = raw.exportOptions || raw.exportFormats || [];
  if (Array.isArray(exports)) return exports.map((e: any) => e.format || e.type || "png");
  if (raw.hasExportDDSImage) return ["png"];
  return [];
}
