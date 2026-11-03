/**
 * v0.6.0 嗅探主流程：解析链接 → 下载 → 转写 → AI 拆解。
 * 轻量工具：全程只用临时目录，拆解结果只回传前端，不落盘任何记录。
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";
import type { WebContents } from "electron";
import { parseMedia } from "../parser";
import { downloadVideo } from "../downloader";
import { transcribeVideo } from "../transcribe";
import type { SniffProgress, SniffRecord } from "../../shared/sniff-types";
import { analyzeTranscript } from "./analyzer";

export interface RunSniffInput {
  link: string;
  niche?: string;
  /** 取消信号：解析后的下载/转写/拆解都会停 */
  signal?: AbortSignal;
  webContents?: WebContents;
  requestId?: string;
}

function send(
  webContents: WebContents | undefined,
  requestId: string | undefined,
  p: Omit<SniffProgress, "requestId">
) {
  if (webContents && !webContents.isDestroyed()) {
    webContents.send("sniff:progress", { requestId, ...p });
  }
}

export async function runSniff(input: RunSniffInput): Promise<SniffRecord> {
  // abort 检查点：解析本身很快，从这里开始的长活都要能停
  const signal = input.signal;
  const requestId = input.requestId;
  send(input.webContents, requestId, { stage: "parse", message: "正在解析视频链接…" });
  const meta = await parseMedia(input.link.trim());

  // 轻量工具：全程只用临时目录，视频等中间产物随用随删。
  const workDir = fs.mkdtempSync(path.join(os.tmpdir(), "bee-sniff-"));
  const videoPath = path.join(workDir, "source.mp4");
  try {
    send(input.webContents, requestId, { stage: "download", message: "正在下载视频…" });
    await downloadVideo({
      url: meta.playUrl,
      savePath: videoPath,
      signal,
      webContents: input.webContents,
      requestId,
      platform: meta.platform,
      audioUrl: meta.audioUrl,
      durationMs: meta.duration,
    });

    send(input.webContents, requestId, { stage: "transcribe", message: "正在提取口播文案（首次会先准备本地模型）…" });
    const transcript = await transcribeVideo({
      videoPath,
      signal,
      webContents: input.webContents,
      requestId,
      language: "zh",
    });

    send(input.webContents, requestId, { stage: "analyze", message: "正在拆解爆款方法…" });
    signal?.throwIfAborted();
    const analysis = await analyzeTranscript({
      title: meta.title,
      niche: (input.niche ?? "").trim(),
      transcript: transcript.text,
    });

    const record: SniffRecord = {
      id: randomUUID(),
      createdAt: Date.now(),
      niche: (input.niche ?? "").trim(),
      source: {
        url: input.link.trim(),
        title: meta.title,
        author: meta.author,
        platform: meta.platform,
      },
      transcript: transcript.text,
      analysis,
    };
    send(input.webContents, requestId, { stage: "done", message: "拆解完成" });
    return record;
  } finally {
    // 下载的视频与转写中间产物一律不留，嗅探完即清空
    try {
      fs.rmSync(workDir, { recursive: true, force: true });
    } catch {
      /* 临时目录可能已被系统清理，忽略 */
    }
  }
}
