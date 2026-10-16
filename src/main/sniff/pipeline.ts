/*
 * SPDX-License-Identifier: GPL-3.0-only
 * Copyright (c) 2026 宝螺 / Baoluo contributors
 * 本文件属于「宝螺 / Baoluo」。除 GPL-3.0 外还适用 ADDITIONAL_TERMS.md 里的附加条款：
 * 分发时须保留来源署名；修改版对外分发时不得沿用「宝螺」名称与图标。
 */
/**
 * 嗅探主流程：本地音视频 → 转写 → AI 拆解。
 *
 * 输入是用户自己提供的文件（拖进来或选路径），本模块不联网取任何内容；
 * 拆解结果只回传前端，不落盘任何记录。
 */
import path from "node:path";
import { randomUUID } from "node:crypto";
import type { WebContents } from "electron";
import { transcribeVideo } from "../transcribe";
import type { SniffProgress, SniffRecord } from "../../shared/sniff-types";
import { analyzeTranscript } from "./analyzer";

export interface RunSniffInput {
  /** 本地音视频文件路径 */
  filePath: string;
  niche?: string;
  /** 取消信号：转写/拆解都会停 */
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
  const signal = input.signal;
  const requestId = input.requestId;
  const filePath = (input.filePath ?? "").trim();

  if (!filePath) throw new Error("要先给一个音视频文件。");

  send(input.webContents, requestId, {
    stage: "transcribe",
    message: "正在提取口播文案（首次会先准备本地模型）…",
  });
  const transcript = await transcribeVideo({
    videoPath: filePath,
    signal,
    webContents: input.webContents,
    requestId,
    language: "zh",
  });

  send(input.webContents, requestId, { stage: "analyze", message: "正在拆解爆款方法…" });
  signal?.throwIfAborted();
  const analysis = await analyzeTranscript({
    title: path.basename(filePath, path.extname(filePath)),
    niche: (input.niche ?? "").trim(),
    transcript: transcript.text,
  });

  const record: SniffRecord = {
    id: randomUUID(),
    createdAt: Date.now(),
    niche: (input.niche ?? "").trim(),
    source: {
      path: filePath,
      title: path.basename(filePath, path.extname(filePath)),
    },
    transcript: transcript.text,
    analysis,
  };
  send(input.webContents, requestId, { stage: "done", message: "拆解完成" });
  return record;
}
