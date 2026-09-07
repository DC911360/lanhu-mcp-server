/**
 * DDS 代码生成器
 *
 * 基于蓝湖 DDS 语义化 UI 组件树，生成 Vue 3 / HTML 代码。
 * 完全在 Node.js 中运行，无需浏览器。
 */
import { escapeHTML } from "./utils/escape.js";

export interface DDSNode {
  uiType?: string;
  type?: string;
  eleName?: string;
  componentName?: string;
  style?: Record<string, any>;
  data?: Record<string, any>;
  children?: DDSNode[];
  [key: string]: any;
}

interface CodeResult {
  files: Array<{ name: string; content: string }>;
}

/**
 * 从 DDS schema 生成 Vue 3 SFC 代码
 */
export function generateVueCode(schema: DDSNode, options?: { projectName?: string }): CodeResult {
  const name = options?.projectName || schema.data?.name || 'DesignPage';
  const children = schema.children || [];

  // 生成 template
  const template = children.map(c => renderVueTemplate(c, 2)).join('\n');

  // 生成 script
  const script = `<script setup lang="ts">
// 自动从蓝湖 DDS 生成
</script>`;

  // 生成 style
  const style = `<style scoped>
.page {
  width: ${schema.style?.width || 375}px;
  min-height: ${schema.style?.height || 892}px;
  margin: 0 auto;
  font-family: -apple-system, BlinkMacSystemFont, "PingFang SC", sans-serif;
  background: ${cssColor(schema.style?.backgroundColor)};
  overflow-x: hidden;
}
</style>`;

  return {
    files: [
      { name: `${name}.vue`, content: `<template>\n  <div class="page">\n${template}\n  </div>\n</template>\n\n${script}\n\n${style}` },
    ],
  };
}

/**
 * 从 DDS schema 生成纯 HTML 代码
 */
export function generateHTMLCode(schema: DDSNode): CodeResult {
  const w = schema.style?.width || 375;
  const h = schema.style?.height || 892;
  const bg = cssColor(schema.style?.backgroundColor);
  const children = schema.children || [];
  const body = children.map(c => renderHTMLElement(c, 1)).join('\n');

  const html = `<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>${escapeHTML(schema.data?.name || 'Design')}</title>
<style>
* { margin: 0; padding: 0; box-sizing: border-box; }
body { font-family: -apple-system, BlinkMacSystemFont, "PingFang SC", sans-serif; max-width: ${w}px; margin: 0 auto; background: ${bg}; overflow-x: hidden; }
</style>
</head>
<body>
${body}
</body>
</html>`;

  return { files: [{ name: 'index.html', content: html }] };
}

// ─── 统一节点渲染 ─────────────────────────────────────

/**
 * 渲染 DDS 节点为 HTML/Vue 模板字符串
 *
 * @param variant - "vue" 输出带语义 CSS class 的模板；"html" 输出纯 HTML
 */
function renderNode(node: DDSNode, indent: number, variant: "vue" | "html"): string {
  const pad = '  '.repeat(indent);
  const uiType = node.uiType || node.type || 'div';
  const style = node.style || {};
  const children = node.children || [];
  const text = getNodeText(node);
  const isCol = node.type === 'col';
  const isRow = node.type === 'row';
  const isVue = variant === "vue";

  let tag = 'div';
  let attrs = '';

  // 语义组件映射（Vue 模式附加 CSS class）
  switch (uiType) {
    case 'NavBar':     tag = 'nav';   if (isVue) attrs = ' class="navbar"'; break;
    case 'lanhutext':
    case 'TextGroup':  tag = 'span';  if (isVue) attrs = ' class="text"'; break;
    case 'lanhuimage':
    case 'Icon':       tag = 'img'; break;
    case 'SingleAvatar':
    case 'SingleAvatarBlock': tag = 'img'; if (isVue) attrs = ' class="avatar"'; break;
    case 'Input':      tag = 'div';   if (isVue) attrs = ' class="input-field"'; break;
    case 'InputArea':  tag = 'input'; if (isVue) attrs = ' class="input-area"'; break;
    case 'ImageText':  tag = 'div';   if (isVue) attrs = ' class="image-text"'; break;
    case 'lanhublock':
      if (isVue) attrs = ` class="block ${isCol ? 'col' : isRow ? 'row' : ''}"`;
      break;
  }

  // 内联样式
  const styles = buildStyleString(style, isCol, isRow);
  if (styles) attrs += ` style="${styles}"`;

  // img 自闭合
  if (tag === 'img') {
    return `${pad}<img${attrs} src="" alt="${escapeHTML(text)}">`;
  }

  // input 自闭合
  if (tag === 'input') {
    return `${pad}<input${attrs} placeholder="${escapeHTML(text)}" readonly>`;
  }

  // 容器元素
  let html = `${pad}<${tag}${attrs}>`;

  if (children.length > 0) {
    html += '\n';
    for (const child of children) {
      html += renderNode(child, indent + 1, variant) + '\n';
    }
    html += `${pad}</${tag}>`;
  } else if (text && !isInternalId(text)) {
    html += `${escapeHTML(text)}</${tag}>`;
  } else {
    html += `</${tag}>`;
  }

  return html;
}

/** Vue 模板渲染（向后兼容包装） */
function renderVueTemplate(node: DDSNode, indent: number): string {
  return renderNode(node, indent, "vue");
}

/** HTML 元素渲染（向后兼容包装） */
function renderHTMLElement(node: DDSNode, indent: number): string {
  return renderNode(node, indent, "html");
}

// ─── 工具函数 ──────────────────────────────────────────

/** CSS 安全颜色名白名单 */
const CSS_COLOR_NAMES = new Set([
  "transparent", "currentColor",
  "black", "white", "red", "green", "blue", "yellow", "orange", "purple",
  "pink", "gray", "grey", "brown", "cyan", "magenta", "lime", "navy",
  "teal", "aqua", "maroon", "olive", "silver", "fuchsia",
]);

function cssColor(rgba: string | undefined): string {
  if (!rgba) return 'transparent';
  // 仅允许安全格式：#hex, rgba(...), rgb(...), 或已知颜色名
  if (/^#[0-9a-fA-F]{3,8}$/.test(rgba)) return rgba;
  if (/^rgba?\(\s*[\d.]+(\s*,\s*[\d.]+){2,3}\s*\)$/.test(rgba)) return rgba;
  if (CSS_COLOR_NAMES.has(rgba.toLowerCase())) return rgba;
  return 'transparent';
}

/** CSS flex 属性白名单 */
const FLEX_ALIGN_VALUES = new Set([
  "center", "flex-start", "flex-end", "stretch", "baseline",
  "space-between", "space-around", "space-evenly",
  "start", "end", "self-start", "self-end", "left", "right",
]);

/** 安全的 CSS 数值（仅允许有限数字） */
function safePx(val: any): string | null {
  const num = typeof val === "number" ? val : parseFloat(val);
  if (!Number.isFinite(num) || num < 0) return null;
  return `${num}px`;
}

function buildStyleString(style: Record<string, any>, isCol: boolean, isRow: boolean): string {
  const parts: string[] = [];
  const w = safePx(style.width);
  if (w) parts.push(`width: ${w}`);
  const h = safePx(style.height);
  if (h) parts.push(`height: ${h}`);
  if (style.backgroundColor) parts.push(`background: ${cssColor(style.backgroundColor)}`);
  const br = safePx(style.borderRadius);
  if (br) parts.push(`border-radius: ${br}`);
  const fs = safePx(style.fontSize);
  if (fs) parts.push(`font-size: ${fs}`);
  if (style.fontWeight) {
    const fw = parseInt(style.fontWeight);
    if (Number.isFinite(fw) && fw > 0) parts.push(`font-weight: ${fw}`);
  }
  if (style.color) parts.push(`color: ${cssColor(style.color)}`);
  if (isCol || isRow) {
    parts.push('display: flex');
    parts.push(`flex-direction: ${isCol ? 'column' : 'row'}`);
    if (style.alignItems && FLEX_ALIGN_VALUES.has(style.alignItems)) {
      parts.push(`align-items: ${style.alignItems}`);
    }
    if (style.justifyContent && FLEX_ALIGN_VALUES.has(style.justifyContent)) {
      parts.push(`justify-content: ${style.justifyContent}`);
    }
  }
  return parts.join('; ');
}

/**
 * 提取节点文本内容
 *
 * 优先使用 data.text（真实文本），
 * 其次 eleName / componentName，
 * 过滤掉 DDS 内部 ID 格式。
 */
function getNodeText(node: DDSNode): string {
  return node.data?.text || node.eleName || node.componentName || '';
}

function isInternalId(text: string): boolean {
  return /^(Text|Image|Block|row|col|NavBar|Icon|Input|ImageText|TextGroup|SingleAvatar)\w*$/.test(text) || /^\w+_\d+_\d+$/.test(text);
}
