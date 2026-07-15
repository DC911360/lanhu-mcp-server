/**
 * DDS 代码生成器
 *
 * 基于蓝湖 DDS 语义化 UI 组件树，生成 Vue 3 / HTML 代码。
 * 完全在 Node.js 中运行，无需浏览器。
 */

interface DDSNode {
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
<title>${schema.data?.name || 'Design'}</title>
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

// ─── Vue Template 渲染 ─────────────────────────────────

function renderVueTemplate(node: DDSNode, indent: number): string {
  const pad = '  '.repeat(indent);
  const uiType = node.uiType || node.type || 'div';
  const style = node.style || {};
  const children = node.children || [];
  const text = getNodeText(node);
  const isCol = node.type === 'col';
  const isRow = node.type === 'row';

  let tag = 'div';
  let attrs = '';
  let innerContent = '';

  // 语义组件映射
  switch (uiType) {
    case 'NavBar': tag = 'nav'; attrs = ' class="navbar"'; break;
    case 'lanhutext': case 'TextGroup': tag = 'span'; attrs = ' class="text"'; break;
    case 'lanhuimage': case 'Icon': tag = 'img'; break;
    case 'SingleAvatar': case 'SingleAvatarBlock': tag = 'img'; attrs = ' class="avatar"'; break;
    case 'Input': tag = 'div'; attrs = ' class="input-field"'; break;
    case 'InputArea': tag = 'input'; attrs = ` class="input-area" placeholder="${text}" readonly`; break;
    case 'ImageText': tag = 'div'; attrs = ' class="image-text"'; break;
    case 'lanhublock': attrs = ` class="block ${isCol ? 'col' : isRow ? 'row' : ''}"`; break;
  }

  // 内联样式
  const styles = buildStyleString(style, isCol, isRow);
  if (styles) attrs += ` style="${styles}"`;

  if (tag === 'img') {
    return `${pad}<img${attrs} src="" alt="${text}">`;
  }

  if (tag === 'input') {
    return `${pad}<input${attrs}>`;
  }

  let html = `${pad}<${tag}${attrs}>`;

  if (children.length > 0) {
    html += '\n';
    for (const child of children) {
      html += renderVueTemplate(child, indent + 1) + '\n';
    }
    html += `${pad}</${tag}>`;
  } else if (text && !isInternalId(text)) {
    html += `${text}</${tag}>`;
  } else {
    html += `</${tag}>`;
  }

  return html;
}

// ─── HTML 元素渲染 ─────────────────────────────────────

function renderHTMLElement(node: DDSNode, indent: number): string {
  const pad = '  '.repeat(indent);
  const uiType = node.uiType || node.type || 'div';
  const style = node.style || {};
  const children = node.children || [];
  const text = getNodeText(node);
  const isCol = node.type === 'col';
  const isRow = node.type === 'row';

  let tag = 'div';
  let attrs = '';

  switch (uiType) {
    case 'NavBar': tag = 'nav'; break;
    case 'lanhutext': case 'TextGroup': tag = 'span'; break;
    case 'lanhuimage': case 'Icon': tag = 'img'; break;
    case 'SingleAvatar': tag = 'img'; break;
    case 'InputArea': tag = 'input'; break;
  }

  const styles = buildStyleString(style, isCol, isRow);
  if (styles) attrs += ` style="${styles}"`;

  if (tag === 'img') return `${pad}<img${attrs} src="" alt="${text}">`;
  if (tag === 'input') return `${pad}<input${attrs} placeholder="${text}" readonly>`;

  let html = `${pad}<${tag}${attrs}>`;
  if (children.length > 0) {
    html += '\n';
    for (const child of children) {
      html += renderHTMLElement(child, indent + 1) + '\n';
    }
    html += `${pad}</${tag}>`;
  } else if (text && !isInternalId(text)) {
    html += `${text}</${tag}>`;
  } else {
    html += `</${tag}>`;
  }
  return html;
}

// ─── 工具函数 ──────────────────────────────────────────

function cssColor(rgba: string | undefined): string {
  if (!rgba) return 'transparent';
  return rgba;
}

function buildStyleString(style: Record<string, any>, isCol: boolean, isRow: boolean): string {
  const parts: string[] = [];
  if (style.width) parts.push(`width: ${style.width}px`);
  if (style.height) parts.push(`height: ${style.height}px`);
  if (style.backgroundColor) parts.push(`background: ${cssColor(style.backgroundColor)}`);
  if (style.borderRadius) parts.push(`border-radius: ${style.borderRadius}px`);
  if (style.fontSize) parts.push(`font-size: ${style.fontSize}px`);
  if (style.fontWeight) parts.push(`font-weight: ${style.fontWeight}`);
  if (style.color) parts.push(`color: ${cssColor(style.color)}`);
  if (isCol || isRow) {
    parts.push('display: flex');
    parts.push(`flex-direction: ${isCol ? 'column' : 'row'}`);
    if (style.alignItems) parts.push(`align-items: ${style.alignItems}`);
    if (style.justifyContent) parts.push(`justify-content: ${style.justifyContent}`);
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
