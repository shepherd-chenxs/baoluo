/*
 * SPDX-License-Identifier: GPL-3.0-only
 * Copyright (c) 2026 宝螺 / Baoluo contributors
 * 本文件属于「宝螺 / Baoluo」。除 GPL-3.0 外还适用 ADDITIONAL_TERMS.md 里的附加条款：
 * 分发时须保留来源署名；修改版对外分发时不得沿用「宝螺」名称与图标。
 */
import { app, BrowserWindow, protocol, net, session } from "electron";
import path from "node:path";
import fs from "node:fs";
import { registerIpc } from "./ipc";
import { setupUserDataDir } from "./userData";
import { genieManager } from "./dialogue/genie-manager";

// 统一数据目录（见 src/main/userData.ts）
setupUserDataDir();

// 必须提前注册协议（必须在 app.ready 之前）
protocol.registerSchemesAsPrivileged([
  { scheme: "baoluo-file", privileges: { standard: true, secure: true, supportFetchAPI: true, stream: true, bypassCSP: true } },
]);

const isDev = process.env.NODE_ENV === "development";

/** 窗口/任务栏图标：优先打包资源，其次开发目录下的透明 ICO */
function resolveWindowIcon(): string | undefined {
  const candidates = [
    path.join(process.resourcesPath, "icon.ico"),
    path.join(__dirname, "..", "..", "build", "icon.ico"),
  ];
  for (const p of candidates) {
    if (fs.existsSync(p)) return p;
  }
  return undefined;
}

// 兜底：不让瞬时文件锁（如杀软扫描）等可恢复错误直接弹崩溃框/退出进程
process.on("uncaughtException", (err) => {
  console.error("[main] uncaughtException:", err);
});
process.on("unhandledRejection", (reason) => {
  console.error("[main] unhandledRejection:", reason);
});

/** 自定义协议：baoluo-file://local/<encoded-absolute-path> → 返回本地文件流 */
function registerBaoluoFileProtocol() {
  protocol.handle("baoluo-file", async (req) => {
    try {
      const url = new URL(req.url);
      // pathname 长这样: "/E:/xxx"（Chromium 可能已解码，也可能保留 %xx）
      let p = url.pathname.replace(/^\//, "");
      try {
        p = decodeURIComponent(p);
      } catch {
        /* 已是明文路径 */
      }
      // Windows 上 URL 可能带斜杠形式 "E:/..."，fs 也能识别
      if (process.platform === "win32" && /^[A-Za-z]:\//.test(p)) {
        p = p.replace(/\//g, "\\");
      }
      if (!fs.existsSync(p)) return new Response("not found", { status: 404 });
      const stat = fs.statSync(p);
      const ext = path.extname(p).toLowerCase();
      const mimeMap: Record<string, string> = {
        ".mp4": "video/mp4",
        ".webm": "video/webm",
        ".mov": "video/quicktime",
        ".mp3": "audio/mpeg",
        ".wav": "audio/wav",
        ".m4a": "audio/mp4",
        ".aac": "audio/aac",
        ".ogg": "audio/ogg",
        ".flac": "audio/flac",
        ".jpg": "image/jpeg",
        ".jpeg": "image/jpeg",
        ".png": "image/png",
        ".webp": "image/webp",
        ".bmp": "image/bmp",
      };
      const mime = mimeMap[ext] ?? "application/octet-stream";

      // 关键：range 请求支持，让 <video> 能拖进度条
      const range = req.headers.get("range");
      let stream: fs.ReadStream;
      let status = 200;
      let headers: Record<string, string> = {
        "Content-Type": mime,
        "Content-Length": String(stat.size),
        "Accept-Ranges": "bytes",
      };
      if (range) {
        const m = /bytes=(\d+)-(\d*)/.exec(range);
        if (m) {
          const start = +m[1];
          const end = m[2] ? +m[2] : stat.size - 1;
          status = 206;
          headers["Content-Range"] = `bytes ${start}-${end}/${stat.size}`;
          headers["Content-Length"] = String(end - start + 1);
          stream = fs.createReadStream(p, { start, end });
        } else {
          stream = fs.createReadStream(p);
        }
      } else {
        stream = fs.createReadStream(p);
      }
      // Electron 30+ protocol.handle 期望返回 Response with Web stream
      const { Readable } = require("node:stream");
      const webStream = Readable.toWeb(stream) as ReadableStream;
      return new Response(webStream, { status, headers });
    } catch (e: any) {
      return new Response(String(e?.message ?? e), { status: 500 });
    }
  });
}

/**
 * 顶部菜单条的高度。
 *
 * 它同时是系统绘制的最小化/最大化/关闭按钮那一行的高度：主进程这里定死，
 * 渲染层用 env(titlebar-area-height) 取同一个值（取不到就用同值兜底），
 * 菜单才会和三个按钮在同一行、同一高度上对齐。
 */
const TOPBAR_HEIGHT = 46;

function createWindow() {
  const win = new BrowserWindow({
    // 1280 起步：三区式布局下中间的对话区才有富余（1100 时对话区只剩 ~320px）
    width: 1280,
    height: 760,
    minWidth: 880,
    minHeight: 600,
    // 版本号取自 package.json（app.getVersion()），不再在这里写死
    title: `宝螺 - v${app.getVersion()}`,
    icon: resolveWindowIcon(),
    autoHideMenuBar: true,
    // 隐藏原生标题栏，把这一行让给页面自己画（菜单 + 授权徽标），
    // 右上角那三个按钮仍由系统绘制，于是就能和菜单并排一行。
    titleBarStyle: "hidden",
    titleBarOverlay: {
      color: "#ffffff",
      symbolColor: "#3a3a3c",
      height: TOPBAR_HEIGHT,
    },
    webPreferences: {
      preload: path.join(__dirname, "..", "preload", "index.js"),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
    },
  });

  // 页面里的 <title> 不参与窗口标题，避免出现第二个版本号来源
  win.on("page-title-updated", (e) => e.preventDefault());

  if (isDev) {
    win.loadURL("http://localhost:5173");
    // win.webContents.openDevTools({ mode: "detach" });
  } else {
    win.loadFile(path.join(__dirname, "..", "renderer", "index.html"));
  }
}

app.whenReady().then(() => {
  registerBaoluoFileProtocol();
  registerIpc();

  /*
   * 真人解说要录麦克风：Electron 默认拒绝 getUserMedia，不放行则录音直接失败、
   * 报错还很隐晦。这里放行 media（麦克风）——只对本应用自己的窗口，用户点录音才触发。
   *
   * 注意必须一并放行 fullscreen：Chromium 把 HTML5 <video> 全屏也当成一种权限请求，
   * 一旦设了这个 handler 又只放行 media，成片预览的全屏按钮就会点了没反应。
   */
  const ses = session.defaultSession;
  ses.setPermissionRequestHandler((_wc, permission, callback) => {
    callback(permission === "media" || permission === "fullscreen");
  });

  createWindow();

  app.on("activate", () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on("window-all-closed", () => {
  if (process.platform !== "darwin") app.quit();
});

/**
 * 退出前收尾：后台下载是"不 await 继续跑"的，进程退出不会等它。
 * python / pip 是独立子进程，不杀就会留在系统里继续占带宽和目录；
 * 已下到一半的数据保留在缓存里，下次点下载接着续传。
 */
app.on("before-quit", () => {
  genieManager.shutdown();
});
