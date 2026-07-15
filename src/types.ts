/**
 * 蓝湖设计稿精确数据类型定义
 *
 * 设计目标：为 iOS / Android / Flutter / Web / H5 代码生成器提供
 * 100% 精确的设计稿结构化数据，消除还原偏差。
 *
 * 核心原则：
 * - 所有坐标为 @1x 逻辑像素（从蓝湖 @2x 原始数据转换）
 * - 保留完整图层树层级（parent → children）
 * - 每个元素都有绝对坐标（累加所有父级偏移）
 * - 全量样式数据（fill / border / shadow / typography / effect）
 */

// ─── 基础类型 ──────────────────────────────────────────

/** RGBA 颜色 */
export interface RGBA {
  r: number;
  g: number;
  b: number;
  a: number;
  value: string; // "rgba(r,g,b,a)"
}

/** 点 */
export interface Point {
  x: number;
  y: number;
}

/** 矩形区域 */
export interface Rect {
  x: number;   // @1x 绝对 X
  y: number;   // @1x 绝对 Y
  width: number;  // @1x
  height: number; // @1x
}

// ─── 样式类型 ──────────────────────────────────────────

/** 填充 */
export interface Fill {
  type: "color" | "gradient" | "image";
  color?: RGBA;
  gradient?: {
    type: "linear" | "radial";
    from: Point;
    to: Point;
    stops: Array<{ color: RGBA; position: number }>;
  };
  image?: {
    url?: string;
    mode?: "fill" | "fit" | "tile";
  };
  opacity?: number;
}

/** 边框 */
export interface Border {
  color?: RGBA;
  width: number;    // @1x
  style: "solid" | "dashed" | "dotted" | "none";
  radius: number;   // @1x 圆角
}

/** 阴影 */
export interface Shadow {
  color: RGBA;
  offsetX: number;  // @1x
  offsetY: number;  // @1x
  blur: number;     // @1x
  spread: number;   // @1x
  inset: boolean;
}

/** 排版 */
export interface Typography {
  fontFamily: string;
  fontSize: number;     // @1x pt
  fontWeight: number;   // 400=regular, 700=bold
  lineHeight: number;   // @1x pt
  letterSpacing: number;// @1x pt
  textAlign: "left" | "center" | "right";
  color: RGBA;
  text: string;
}

/** 完整样式集合 */
export interface LayerStyle {
  fills: Fill[];
  borders: Border[];
  shadows: Shadow[];
  opacity: number;
  blendMode: string;
  visible: boolean;
  locked: boolean;
  rotation: number;     // 旋转角度
  typography?: Typography;
}

// ─── 图层树 ────────────────────────────────────────────

/**
 * 设计图层（树形结构）
 *
 * 每个图层包含：
 * - 绝对坐标（已累加所有父级偏移，@1x 逻辑像素）
 * - 完整样式数据
 * - 子图层递归
 * - 原始数据透传（供特殊场景使用）
 */
export interface DesignLayer {
  // 标识
  id: string;
  name: string;
  type: LayerType;

  // 坐标与尺寸（@1x 绝对坐标）
  rect: Rect;

  // 完整样式
  style: LayerStyle;

  // 导出图片 URL（ddsImage 或 image）
  imageUrl?: string;
  imageSize?: { width: number; height: number };

  // 子图层
  children: DesignLayer[];

  // 元信息
  metadata: {
    depth: number;
    parentId: string | null;
    hasExportImage: boolean;
    exportFormats: string[];
  };

  raw: Record<string, unknown>;
}

/** 图层类型 */
export type LayerType =
  | "artboard"    // 画板（根节点）
  | "group"       // 编组
  | "shape"       // 形状（矩形/圆形/路径等）
  | "text"        // 文本
  | "image"       // 图片
  | "symbol"      // 组件/符号
  | "slice"       // 切片
  | "unknown";    // 未识别

// ─── 设计稿描述 ────────────────────────────────────────

/** 设计稿完整结构化数据 */
export interface DesignDocument {
  // 基本信息
  name: string;
  imageId: string;
  projectId: string;

  // 画布信息
  canvas: {
    width: number;   // @1x 逻辑宽度
    height: number;  // @1x 逻辑高度
    scale: number;   // 原始 scale（通常 2）
    device: string;  // "iOS @1x" 等
  };

  // 图层树
  layers: DesignLayer[];

  // Design Tokens（自动提取）
  tokens: {
    colors: Array<{ name: string; value: RGBA }>;
    fonts: Array<{ name: string; family: string; size: number; weight: number }>;
    spacings: number[];
    radii: number[];
  };
}
