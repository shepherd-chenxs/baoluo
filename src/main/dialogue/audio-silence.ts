/*
 * SPDX-License-Identifier: GPL-3.0-only
 * Copyright (c) 2026 宝螺 / Baoluo contributors
 * 本文件属于「宝螺 / Baoluo」。除 GPL-3.0 外还适用 ADDITIONAL_TERMS.md 里的附加条款：
 * 分发时须保留来源署名；修改版对外分发时不得沿用「宝螺」名称与图标。
 */
/**
 * audio-silence — 用静音检测裁掉音频首尾的静音。
 *
 * 给「拿不到逐词时间轴」的音色用（本地 Genie 克隆音色的输出就没有词级数据）。
 * 在线音色走 TtsEngine.trimEdgeSilence：它用 Edge 返回的逐词时间轴精确裁剪；
 * 这里退一步，用 ffmpeg 的 silencedetect 找首尾静音，精度差一点但足够对齐字幕。
 */
import fs from "node:fs";
import path from "node:path";
import { probeAudioDuration, runFfmpeg } from "./ffmpeg";

/** 判定静音的阈值与最短时长 */
const NOISE_DB = -45;
const MIN_SILENCE_SEC = 0.35;
/** 裁剪后保留的余量 */
const KEEP_LEAD_SEC = 0.12;
const KEEP_TAIL_SEC = 0.2;
/** 裁剪后至少要有这么长，否则认为检测结果不可靠，放弃裁剪 */
const MIN_KEEP_SEC = 0.3;

export interface SilenceSpan {
  start: number;
  end: number;
}

/** 跑 silencedetect，返回静音区间（秒） */
export async function detectSilences(
  file: string,
  signal?: AbortSignal
): Promise<SilenceSpan[]> {
  const res = await runFfmpeg(
    [
      "-hide_banner",
      "-i", file,
      "-af", `silencedetect=noise=${NOISE_DB}dB:d=${MIN_SILENCE_SEC}`,
      "-f", "null",
      "-",
    ],
    { timeoutMs: 120_000, signal }
  );
  const starts = [...res.stderr.matchAll(/silence_start:\s*([\d.]+)/g)].map((m) => +m[1]);
  const ends = [...res.stderr.matchAll(/silence_end:\s*([\d.]+)/g)].map((m) => +m[1]);
  const spans: SilenceSpan[] = [];
  const n = Math.min(starts.length, ends.length);
  for (let i = 0; i < n; i++) spans.push({ start: starts[i], end: ends[i] });
  return spans;
}

/**
 * 裁掉首尾静音（原地覆盖）。返回是否真的裁了。
 * wav 走无损 PCM 重编码，mp3 走 64kbps 重编码。
 */
export async function trimSilenceByDetect(
  file: string,
  signal?: AbortSignal
): Promise<boolean> {
  const ext = path.extname(file).toLowerCase();
  if (ext !== ".wav" && ext !== ".mp3") return false;
  const total = await probeAudioDuration(file);
  if (!(total > 0)) return false;
  const spans = await detectSilences(file, signal);
  if (!spans.length) return false;

  // 首部静音：从 0 开始的那一段
  const leading = spans[0].start <= 0.05 ? spans[0] : null;
  // 尾部静音：一直持续到结尾的那一段
  const last = spans[spans.length - 1];
  const trailing = last.end >= total - 0.05 ? last : null;
  if (!leading && !trailing) return false;

  const start = Math.max(0, (leading ? leading.end : 0) - KEEP_LEAD_SEC);
  const end = Math.min(total, (trailing ? trailing.start : total) + KEEP_TAIL_SEC);
  const keep = end - start;
  if (keep < MIN_KEEP_SEC || keep > total - 0.15) return false;

  const tmp = `${file}.trim${ext}`;
  try {
    if (fs.existsSync(tmp)) fs.unlinkSync(tmp);
  } catch {
    /* noop */
  }
  const codecArgs =
    ext === ".wav"
      ? ["-c:a", "pcm_s16le"]
      : ["-c:a", "libmp3lame", "-b:a", "64k", "-ar", "24000", "-ac", "1"];
  const res = await runFfmpeg(
    [
      "-y",
      "-i", file,
      "-ss", start.toFixed(3),
      "-t", keep.toFixed(3),
      ...codecArgs,
      tmp,
    ],
    { timeoutMs: 120_000, signal }
  );
  if (res.code !== 0 || !fs.existsSync(tmp) || fs.statSync(tmp).size === 0) {
    try {
      if (fs.existsSync(tmp)) fs.unlinkSync(tmp);
    } catch {
      /* noop */
    }
    return false;
  }
  try {
    fs.copyFileSync(tmp, file);
    fs.unlinkSync(tmp);
    return true;
  } catch {
    return false;
  }
}
