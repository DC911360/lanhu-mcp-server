/**
 * DDS 完整设计稿下载器
 *
 * 流程（按顺序）：
 * 1. 通过 image_id 获取 version_id
 * 2. Puppeteer 加载 DDS 页面
 * 3. 从 CodeMirror 编辑器提取完整 Vue + CSS 代码
 * 4. 提取所有 CDN 图片 URL 并下载到本地
 * 5. 替换代码中的 CDN URL 为本地相对路径
 * 6. 保存 DesignPage.vue / index.html / style.css + images/
 */
import puppeteer from "puppeteer-core";
import axios from "axios";
import * as fs from "node:fs";
import * as path from "node:path";

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
          `${process.env.LOCAPPDATA}\\Google\\Chrome\\Application\\chrome.exe`,
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
  const outputDir = path.resolve(outputPath);
  const imgDir = path.join(outputDir, "img");
  fs.mkdirSync(imgDir, { recursive: true });

  // ─── Step 1: 获取 version_id ───────────────────────────
  const detailRes = await axios.get("https://lanhuapp.com/api/project/image", {
    params: { pid: projectId, image_id: imageId },
    headers: { Cookie: cookie },
    timeout: 15000,
  });
  const versions = detailRes.data?.result?.versions || [];
  const versionId = versions[0]?.id;
  if (!versionId) throw new Error("无法获取 version_id");

  // ─── Step 2-3: Puppeteer 提取 CodeMirror 完整代码 ──────
  const browser = await puppeteer.launch({
    executablePath: getChromePath(),
    headless: true,
    args: ["--no-sandbox", "--disable-setuid-sandbox"],
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
      timeout: 20000,
    });

    // 等待代码生成完成
    await new Promise((r) => setTimeout(r, 8000));

    // 切换到 HTML 格式（H5）
    await page.evaluate(() => {
      const htmlBtn = [...document.querySelectorAll("*")].find(
        (el) => el.textContent?.trim() === "HTML" && el.className?.includes("el-cascader")
      );
      if (htmlBtn) (htmlBtn as HTMLElement).click();
    });
    await new Promise((r) => setTimeout(r, 3000));

    // 从 CodeMirror 实例提取完整代码（HTML + CSS）
    const { htmlCode, cssCode } = await page.evaluate(() => {
      let html = "";
      let css = "";
      const cmElements = document.querySelectorAll(".CodeMirror");
      cmElements.forEach((cmEl) => {
        const cm = (cmEl as any).CodeMirror;
        if (cm) {
          const content = cm.getValue();
          const mode = cm.getMode?.().name || "";
          if (mode === "htmlmixed" || content.includes("<!DOCTYPE")) html = content;
          if (mode === "css" || content.includes(".page")) css = content;
        }
      });
      return { htmlCode: html, cssCode: css };
    });

    if (!htmlCode && !cssCode) {
      throw new Error("未能从 DDS 页面提取代码");
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
          timeout: 10000,
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
