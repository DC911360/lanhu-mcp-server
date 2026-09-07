/**
 * DDS 完整设计稿下载器
 *
 * 流程（按顺序）：
 * 1. 通过 image_id 获取 version_id
 * 2. Puppeteer 加载 DDS 页面
 * 3. 从 CodeMirror 编辑器提取完整 Vue + CSS 代码
 * 4. 提取所有 CDN 图片 URL 并下载到本地
 * 5. 替换代码中的 CDN URL 为本地相对路径
 * 6. 保存 index.html / index.css / flexible.js / common.css + img/
 */
import axios from "axios";
import * as fs from "node:fs";
import * as path from "node:path";
import { CONFIG } from "./config.js";
import { assertValidId } from "./utils/validate.js";

/**
 * 懒加载 puppeteer-core（可选依赖，约 40MB）
 *
 * 只有 lanhu_download_design 需要 Puppeteer，
 * 其他 13 个工具不需要安装它。
 */
async function loadPuppeteer() {
  try {
    const mod = await import("puppeteer-core");
    return mod.default;
  } catch {
    throw new Error(
      "puppeteer-core 未安装。lanhu_download_design 需要此依赖。\n" +
      "请运行: npm install puppeteer-core"
    );
  }
}

/**
 * Chrome 可执行文件路径
 *
 * 优先读取环境变量 CHROME_PATH，
 * 否则按平台自动检测常见安装位置。
 */
function getChromePath(): string {
  if (process.env.CHROME_PATH) return process.env.CHROME_PATH;

  const platform = process.platform;
  const candidates = platform === "darwin"
    ? [
        "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
        "/Applications/Chromium.app/Contents/MacOS/Chromium",
        `${process.env.HOME}/Applications/Google Chrome.app/Contents/MacOS/Google Chrome`,
      ]
    : platform === "win32"
      ? [
          `${process.env.PROGRAMFILES}\\Google\\Chrome\\Application\\chrome.exe`,
          `${process.env["PROGRAMFILES(X86)"]}\\Google\\Chrome\\Application\\chrome.exe`,
          `${process.env.LOCALAPPDATA}\\Google\\Chrome\\Application\\chrome.exe`,
        ]
      : [
          "/usr/bin/google-chrome",
          "/usr/bin/google-chrome-stable",
          "/usr/bin/chromium",
          "/usr/bin/chromium-browser",
        ];

  for (const p of candidates) {
    if (p && fs.existsSync(p)) return p;
  }

  throw new Error(
    `未找到 Chrome，请设置环境变量 CHROME_PATH 指向 Chrome 可执行文件。\n` +
    `已检测: ${candidates.join(", ")}`
  );
}

export interface DownloadResult {
  outputDir: string;
  files: string[];
  images: number;
  htmlSize: number;
  cssSize: number;
}

/**
 * 完整下载流程：DDS 代码 + 图片 → 本地文件
 */
export async function downloadDesign(
  imageId: string,
  projectId: string,
  cookie: string,
  authorization: string,
  outputPath: string
): Promise<DownloadResult> {
  assertValidId(imageId, "imageId");
  assertValidId(projectId, "projectId");
  const outputDir = path.resolve(outputPath);
  const imgDir = path.join(outputDir, "img");
  fs.mkdirSync(imgDir, { recursive: true });

  // ─── Step 1: 获取 version_id ───────────────────────────
  const detailRes = await axios.get("https://lanhuapp.com/api/project/image", {
    params: { pid: projectId, image_id: imageId },
    headers: { Cookie: cookie },
    timeout: CONFIG.apiTimeout,
  });
  if (process.env.LANHU_DEBUG) {
    console.error("[DEBUG] detailRes.data:", JSON.stringify(detailRes.data));
  }
  const detail = detailRes.data?.result || detailRes.data?.data || {};
  const versions = detail?.versions || [];
  const versionId = versions[0]?.id;
  if (!versionId) throw new Error(`无法获取 version_id，API返回: ${JSON.stringify(detailRes.data)}`);

  // ─── Step 2-3: Puppeteer 提取 CodeMirror 完整代码 ──────
  // 沙箱默认启用；仅在 Docker 或显式设置 LANHU_PUPPETEER_NO_SANDBOX=1 时关闭
  const noSandbox = process.env.LANHU_PUPPETEER_NO_SANDBOX === "1"
    || process.env.DOCKER === "true";
  const puppeteer = await loadPuppeteer();
  const browser = await puppeteer.launch({
    executablePath: getChromePath(),
    headless: true,
    args: noSandbox ? ["--no-sandbox", "--disable-setuid-sandbox"] : [],
  });

  try {
    const page = await browser.newPage();
    await page.setUserAgent(
      "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36"
    );

    // 注入 Cookie
    const cookies = cookie
      .split(";")
      .map((c) => {
        const [name, ...rest] = c.trim().split("=");
        return {
          name: name.trim(),
          value: rest.join("=").trim(),
          domain: ".lanhuapp.com",
          path: "/",
        };
      })
      .filter((c) => c.name && c.value);
    await page.setCookie(...cookies);

    // 导航到 DDS 页面
    await page.goto(`https://dds.lanhuapp.com/#/?version_id=${versionId}`, {
      waitUntil: "domcontentloaded",
      timeout: CONFIG.puppeteerTimeout,
    });

    // 等待 CodeMirror 编辑器加载完成（代码生成就绪）
    await page.waitForSelector(".CodeMirror", { timeout: CONFIG.codeMirrorWaitTimeout });
    // 轮询等待 CodeMirror 有实际内容（DDS 页面代码异步加载）
    let codeReady = false;
    for (let attempt = 0; attempt < 20; attempt++) {
      codeReady = await page.evaluate(() => {
        const cms = document.querySelectorAll(".CodeMirror");
        return [...cms].some(el => {
          const cm = (el as any).CodeMirror;
          return cm && cm.getValue?.()?.length > 0;
        });
      });
      if (codeReady) break;
      if (process.env.LANHU_DEBUG) console.error(`[DEBUG] CodeMirror 内容等待 ${attempt + 1}/20...`);
      await new Promise(r => setTimeout(r, 2000));
    }
    if (!codeReady && process.env.LANHU_DEBUG) {
      console.error("[DEBUG] CodeMirror 内容轮询结束，仍为空，继续尝试提取");
    }

    // 切换到 HTML 格式（H5）— 使用精确选择器代替 querySelectorAll("*")
    await page.evaluate(() => {
      const candidates = document.querySelectorAll(".el-cascader");
      for (const el of candidates) {
        if (el.textContent?.trim() === "HTML") {
          (el as HTMLElement).click();
          break;
        }
      }
    });
    // 等待切换后 CodeMirror 重新渲染为 HTML 模式（增加超时，失败不阻塞）
    try {
      await page.waitForFunction(
        () => {
          const cms = document.querySelectorAll(".CodeMirror");
          return [...cms].some((el) => {
            const cm = (el as any).CodeMirror;
            return cm && (cm.getMode?.().name === "htmlmixed" || cm.getValue?.()?.includes("<!DOCTYPE"));
          });
        },
        { timeout: CONFIG.modeSwitchTimeout * 2 },
      );
    } catch {
      if (process.env.LANHU_DEBUG) console.error("[DEBUG] HTML 模式切换超时，尝试提取当前代码");
    }

    // 从 CodeMirror 实例提取完整代码（HTML + CSS）
    const { htmlCode, cssCode, debugInfo } = await page.evaluate(() => {
      let html = "";
      let css = "";
      const cmElements = document.querySelectorAll(".CodeMirror");
      const debug: string[] = [];
      cmElements.forEach((cmEl, i) => {
        const cm = (cmEl as any).CodeMirror;
        if (cm) {
          const content = cm.getValue();
          const mode = cm.getMode?.().name || "unknown";
          debug.push(`CM[${i}] mode=${mode} len=${content.length} preview=${content.slice(0, 100)}`);
          // 严格过滤：只接受真正的 HTML 设计代码（非页面 UI 的 SVG/图标）
          const looksLikeDesign = content.includes("<!DOCTYPE") || content.includes("<html") || content.includes("<div class=\"page\"") || content.includes("<div class=\"container\"") || content.includes("<div class=\"artboard\"");
          if (mode === "htmlmixed" || mode === "html") {
            html = content;
          } else if (looksLikeDesign && content.length > 200) {
            html = content;
          }
          // CSS 过滤：排除极短内容
          if (mode === "css" && content.length > 50) {
            css = content;
          } else if (content.includes(".page") || content.includes("body {") || content.includes("flex")) {
            if (content.length > 50) css = content;
          }
        } else {
          debug.push(`CM[${i}] no CodeMirror instance`);
        }
      });
      debug.push(`total CM elements: ${cmElements.length}`);
      return { htmlCode: html, cssCode: css, debugInfo: debug.join("\n") };
    });

    if (process.env.LANHU_DEBUG) {
      console.error("[DEBUG] CodeMirror extraction:", debugInfo);
    }

    if (!htmlCode && !cssCode) {
      throw new Error(
        `未能从 DDS 页面提取代码。` +
        `可能原因：该设计稿是设计集（type=set）或没有开启 D2C 代码生成。\n` +
        `Debug: ${debugInfo}`
      );
    }

    // ─── Step 4: 提取并下载所有 CDN 图片 ────────────────
    const allCode = (htmlCode || "") + (cssCode || "");
    const cdnUrls = [
      ...new Set(
        allCode.match(/https:\/\/lanhu[^\s"')]+/g) || []
      ),
    ];

    const urlToLocal = new Map<string, string>();
    let imgIdx = 0;

    for (const url of cdnUrls) {
      try {
        const res = await axios.get(url, {
          responseType: "arraybuffer",
          timeout: CONFIG.imageDownloadTimeout,
        });
        const name = `img_${imgIdx++}.png`;
        fs.writeFileSync(path.join(imgDir, name), Buffer.from(res.data));
        urlToLocal.set(url, `./img/${name}`);
      } catch {
        // 跳过失败的图片
      }
    }

    // ─── Step 5: 替换 CDN URL → 本地路径 ─────────────────
    let finalHtml = htmlCode || "";
    let finalCss = cssCode || "";

    for (const [url, local] of urlToLocal) {
      finalHtml = finalHtml.split(url).join(local);
      finalCss = finalCss.split(url).join(local);
    }

    // ─── Step 6: 保存文件 ────────────────────────────────
    const files: string[] = [];

    // 添加 flexible.js 脚本引用（在 common.css 之前）
    let htmlWithFlexible = finalHtml;
    if (!htmlWithFlexible.includes("flexible.js")) {
      htmlWithFlexible = htmlWithFlexible.replace(
        /(<link rel="stylesheet" type="text\/css" href="\.\.\/common\.css" \/>)/,
        `<script src="./flexible.js"></script>\n    $1`
      );
      // 如果上面的正则没匹配（因为路径是./而不是../），尝试另一个正则
      if (htmlWithFlexible === finalHtml) {
        htmlWithFlexible = htmlWithFlexible.replace(
          /(<link rel="stylesheet" type="text\/css" href="\.\/common\.css" \/>)/,
          `<script src="./flexible.js"></script>\n    $1`
        );
      }
    }

    // HTML 文件
    const htmlPath = path.join(outputDir, "index.html");
    fs.writeFileSync(htmlPath, htmlWithFlexible, "utf-8");
    files.push(htmlPath);

    // CSS 文件
    const cssPath = path.join(outputDir, "index.css");
    fs.writeFileSync(cssPath, finalCss, "utf-8");
    files.push(cssPath);

    // flexible.js — 自适应布局脚本
    const flexibleJs = `(function flexible(window, document) {
  function resetFontSize() {
    const size = (document.documentElement.clientWidth / 375) * 37.5;
    document.documentElement.style.fontSize = size + 'px';
  }

  // reset root font size on page show or resize
  window.addEventListener('pageshow', resetFontSize);
  window.addEventListener('resize', resetFontSize);
})(window, document);`;
    const flexiblePath = path.join(outputDir, "flexible.js");
    fs.writeFileSync(flexiblePath, flexibleJs, "utf-8");
    files.push(flexiblePath);

    // common.css — 通用样式
    const commonCss = `* {
  margin: 0;
  padding: 0;
  box-sizing: border-box;
}

body {
  font-family: -apple-system, BlinkMacSystemFont, "PingFang SC", "Hiragino Sans GB", "Microsoft YaHei", sans-serif;
  -webkit-font-smoothing: antialiased;
}

.flex-col {
  display: flex;
  flex-direction: column;
}

.flex-row {
  display: flex;
  flex-direction: row;
}

.justify-between {
  justify-content: space-between;
}

.justify-center {
  justify-content: center;
}

.align-center {
  align-items: center;
}

img {
  max-width: 100%;
  height: auto;
}`;
    const commonPath = path.join(outputDir, "common.css");
    fs.writeFileSync(commonPath, commonCss, "utf-8");
    files.push(commonPath);

    return {
      outputDir,
      files,
      images: imgIdx,
      htmlSize: finalHtml.length,
      cssSize: finalCss.length,
    };
  } finally {
    await browser.close();
  }
}
