import fs from "node:fs";
import path from "node:path";
import { net, type WebContents } from "electron";
import type { MediaPlatform } from "../shared/dialogue-types";
import { runFfmpeg } from "./dialogue/ffmpeg";

const UA_MOBILE =
  "Mozilla/5.0 (iPhone; CPU iPhone OS 17_2 like Mac OS X) AppleWebKit/605.1.15 " +
  "(KHTML, like Gecko) Version/17.2 Mobile/15E148 Safari/604.1";

export interface DownloadOptions {
  url: string;
  savePath: string;
  webContents?: WebContents; // 用于回推进度事件
  requestId?: string;
  platform?: MediaPlatform;
  /** 音视频分离时的音频流（B站 DASH），下载后由 ffmpeg 合并 */
  audioUrl?: string;
  /** 视频总时长（ms），HLS 拉流时用于换算进度 */
  durationMs?: number;
  /** 取消信号：中止时停下载、杀 ffmpeg */
  signal?: AbortSignal;
}

const PLATFORM_REFERERS: Record<MediaPlatform, string> = {
  douyin: "https://www.douyin.com/",
  kuaishou: "https://www.kuaishou.com/",
  bilibili: "https://www.bilibili.com/",
  xiaohongshu: "https://www.xiaohongshu.com/",
  generic: "",
};

/**
 * 用 Electron 主进程的 net.fetch 下载视频（走 Chromium 网络栈，DNS/TLS/HTTP2
 * 与真实浏览器一致，且会自动跟随 302）。返回标准 Response，再通过
 * ReadableStream reader 分片写入磁盘并回推进度。
 */
export async function downloadVideo(opts: DownloadOptions): Promise<void> {
  const { url, savePath, webContents, requestId, platform, audioUrl, signal } = opts;
  ensureDir(path.dirname(savePath));

  const referer = PLATFORM_REFERERS[platform ?? "generic"];
  const headers: Record<string, string> = {
    "User-Agent": UA_MOBILE,
    ...(referer ? { Referer: referer } : {}),
  };

  // B站 DASH：视频/音频分开下载，再合并
  if (audioUrl) {
    const videoTmp = savePath + ".video.tmp";
    const audioTmp = savePath + ".audio.tmp";
    try {
      await downloadStream(url, videoTmp, headers, signal, (p) => {
        sendProgress(webContents, requestId, p.received, p.total);
      });
      sendStage(webContents, requestId, "merge");
      await downloadStream(audioUrl, audioTmp, headers, signal);
      const res = await runFfmpeg([
        "-y",
        "-i", videoTmp,
        "-i", audioTmp,
        "-c", "copy",
        savePath,
      ], { signal });
      if (res.code !== 0) {
        throw new Error(`ffmpeg 合并失败：${res.stderr.slice(-500)}`);
      }
    } finally {
      try { fs.unlinkSync(videoTmp); } catch { /* noop */ }
      try { fs.unlinkSync(audioTmp); } catch { /* noop */ }
    }
    return;
  }

  // 快手等平台的 HLS 流（m3u8）：用 ffmpeg 直接拉流转 mp4
  if (/\.m3u8(\?|#|$)/i.test(url)) {
    await downloadHls(url, savePath, headers, {
      webContents,
      requestId,
      durationMs: opts.durationMs ?? 0,
      signal,
    });
    return;
  }

  await downloadStream(url, savePath, headers, signal, (p) => {
    sendProgress(webContents, requestId, p.received, p.total);
  });
}

async function downloadHls(
  url: string,
  savePath: string,
  headers: Record<string, string>,
  opts: {
    webContents?: WebContents;
    requestId?: string;
    durationMs: number;
    signal?: AbortSignal;
  }
): Promise<void> {
  const headerStr = Object.entries(headers)
    .map(([k, v]) => `${k}: ${v}`)
    .join("\r\n");
  const args = [
    "-y",
    "-headers", headerStr,
    "-i", url,
    "-c", "copy",
    "-progress", "pipe:1",
    savePath,
  ];
  const res = await runFfmpeg(args, {
    signal: opts.signal,
    progressSink: "stdout",
    onProgress: ({ time }) => {
      const pct =
        opts.durationMs > 0
          ? Math.min(100, Math.round((time * 1000) / opts.durationMs * 100))
          : 0;
      sendProgress(opts.webContents, opts.requestId, 0, 0, pct);
    },
  });
  if (res.code !== 0) {
    throw new Error(`HLS 下载失败：${res.stderr.slice(-500)}`);
  }
  sendProgress(opts.webContents, opts.requestId, 0, 0, 100);
}

function sendProgress(
  webContents: WebContents | undefined,
  requestId: string | undefined,
  received: number,
  total: number,
  percentOverride?: number
) {
  if (webContents && !webContents.isDestroyed()) {
    webContents.send("download:progress", {
      requestId,
      stage: "download",
      received,
      total,
      percent:
        percentOverride ??
        (total > 0 ? Math.min(100, (received / total) * 100) : 0),
    });
  }
}

function sendStage(
  webContents: WebContents | undefined,
  requestId: string | undefined,
  stage: "merge"
) {
  if (webContents && !webContents.isDestroyed()) {
    webContents.send("download:progress", {
      requestId,
      stage,
      received: 0,
      total: 0,
      percent: 100,
    });
  }
}

async function downloadStream(
  url: string,
  savePath: string,
  headers: Record<string, string>,
  signal?: AbortSignal,
  onProgress?: (p: { received: number; total: number }) => void
): Promise<void> {
  const res = await net.fetch(url, {
    method: "GET",
    headers,
    signal,
  });

  if (!res.ok || !res.body) {
    throw new Error(`下载失败: HTTP ${res.status}`);
  }

  const total = Number(res.headers.get("content-length") ?? 0);
  const reader = res.body.getReader();
  const fileStream = fs.createWriteStream(savePath);
  let received = 0;

  try {
    while (true) {
      // abort 时 net.fetch 的 body 会自己报错，这里再兜一层（写入侧主动停）
      signal?.throwIfAborted();
      const { done, value } = await reader.read();
      if (done) break;
      const chunk = Buffer.from(value);
      received += chunk.length;
      if (!fileStream.write(chunk)) {
        await new Promise<void>((r) => fileStream.once("drain", r));
      }
      onProgress?.({ received, total });
    }
    fileStream.end();
    await new Promise<void>((resolve, reject) => {
      fileStream.on("finish", resolve);
      fileStream.on("error", reject);
    });
  } catch (e) {
    fileStream.destroy();
    throw e;
  }
}

function ensureDir(dir: string) {
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
}

/** 把 title/author 组装成合法的 Windows 文件名 */
export function safeFileName(input: string, maxLen = 80): string {
  const cleaned = input
    .replace(/[\\/:*?"<>|\r\n\t]/g, "_")
    .replace(/\s+/g, " ")
    .trim();
  if (!cleaned) return "video";
  return cleaned.length > maxLen ? cleaned.slice(0, maxLen) : cleaned;
}
