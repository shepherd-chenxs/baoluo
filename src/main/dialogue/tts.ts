/*
 * SPDX-License-Identifier: GPL-3.0-only
 * Copyright (c) 2026 宝螺 / Baoluo contributors
 * 本文件属于「宝螺 / Baoluo」。除 GPL-3.0 外还适用 ADDITIONAL_TERMS.md 里的附加条款：
 * 分发时须保留来源署名；修改版对外分发时不得沿用「宝螺」名称与图标。
 */
// eslint-disable-next-line @typescript-eslint/no-var-requires
const { EdgeTTS } = require("node-edge-tts");

import fs from "node:fs";
import path from "node:path";
import type { WordCue } from "../../shared/dialogue-types";
import { probeAudioDuration, runFfmpeg } from "./ffmpeg";

/** 待合成的一条语音：文本 + 音色 */
export interface TtsSegment {
  index: number;
  text: string;
  voice: string;
  /** Edge prosody 字符串，如 "+10%" / "-5%"；缺省用默认 */
  rate?: string;
  pitch?: string;
  volume?: string;
}

/** 把数值偏移（0=默认）转成 Edge prosody 字符串 */
export function prosodyPercent(n: number): string {
  if (!n) return "default";
  return `${n > 0 ? "+" : ""}${n}%`;
}

export interface TtsEngineOptions {
  /** 默认输出目录：实际 mp3 文件会写到 {outputDir}/line_NNN.mp3 */
  outputDir: string;
  /** 取消信号：中止时尽快停止后续合成 */
  signal?: AbortSignal;
  /** 默认 'zh-CN'，与 edge-tts 一致 */
  lang?: string;
  /** 单次请求超时（ms），默认 30s */
  timeoutMs?: number;
  /** 失败最大重试次数，默认 3 */
  maxRetries?: number;
  /** 行间间隔（ms），默认 500 */
  betweenDelayMs?: number;
}

export type TtsProgressCallback = (current: number, total: number) => void;

/** 一条合成结果：音频路径 + 词级时间轴（毫秒） */
export interface TtsResult {
  path: string;
  cues: WordCue[];
}

const DEFAULT_BETWEEN_DELAY_MS = 500;
const DEFAULT_TIMEOUT_MS = 30_000;
const MAX_RETRIES = 3;

/** 裁首尾静音时保留的余量（毫秒）：留一点呼吸，别把字切掉 */
const TRIM_LEAD_KEEP_MS = 120;
const TRIM_TAIL_KEEP_MS = 150;
/** 首/尾静音小于这个值就不折腾转码了 */
const TRIM_SKIP_MS = 200;

export class TtsEngine {
  private readonly outputDir: string;
  private readonly lang: string;
  private readonly timeoutMs: number;
  private readonly maxRetries: number;
  private readonly betweenDelayMs: number;
  private readonly signal?: AbortSignal;

  constructor(opts: TtsEngineOptions) {
    this.outputDir = path.resolve(opts.outputDir);
    this.lang = opts.lang ?? "zh-CN";
    this.timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    this.maxRetries = opts.maxRetries ?? MAX_RETRIES;
    this.betweenDelayMs = opts.betweenDelayMs ?? DEFAULT_BETWEEN_DELAY_MS;
    this.signal = opts.signal;
    fs.mkdirSync(this.outputDir, { recursive: true });
  }

  /** 可中止的等待；signal 触发时立即抛「已取消」 */
  private async waitOrAbort(ms: number): Promise<void> {
    const signal = this.signal;
    if (!signal) {
      await new Promise((r) => setTimeout(r, ms));
      return;
    }
    await new Promise<void>((resolve, reject) => {
      let timer: ReturnType<typeof setTimeout> | undefined;
      const onAbort = () => {
        if (timer) clearTimeout(timer);
        reject(new Error("已取消"));
      };
      timer = setTimeout(() => {
        signal.removeEventListener("abort", onAbort);
        resolve();
      }, ms);
      signal.addEventListener("abort", onAbort, { once: true });
    });
  }

  private throwIfAborted(): void {
    if (this.signal?.aborted) throw new Error("已取消");
  }

  /** 合成长文本里掺 \n 时，edge-tts 把它读成停顿 —— 保留原始换行，不替换 */
  private async synthesizeOnce(seg: TtsSegment, outputPath: string): Promise<void> {
    const tts = new EdgeTTS({
      voice: seg.voice,
      lang: this.lang,
      outputFormat: "audio-24khz-48kbitrate-mono-mp3",
      saveSubtitles: true,
      timeout: this.timeoutMs,
      rate: seg.rate ?? "default",
      pitch: seg.pitch ?? "default",
      volume: seg.volume ?? "default",
    });
    await tts.ttsPromise(seg.text, outputPath);
  }

  /**
   * 按词级时间轴裁掉首尾静音（在线音色专用）。
   *
   * Edge 服务返回的音频尾部自带约 0.9 秒静音（实测 volumedetect -91dB），
   * 不裁会有两个后果：
   *   1) 每句后面都多出近 1 秒死时间，整片节奏被拖慢；
   *   2) 字幕按整段音频时长排，会一直挂到静音结束，看起来就是「字幕比声音慢半拍」。
   * 没有词级时间轴（如本地克隆音色）时原样返回，不做猜测式裁剪。
   */
  private async trimEdgeSilence(
    audioPath: string,
    cues: WordCue[]
  ): Promise<{ path: string; cues: WordCue[] }> {
    if (!cues.length) return { path: audioPath, cues };
    const totalMs = (await probeAudioDuration(audioPath)) * 1000;
    const firstStart = cues[0].start;
    const lastEnd = cues[cues.length - 1].end;
    // 首尾本来就没多少静音时跳过，省一次转码
    if (firstStart <= TRIM_LEAD_KEEP_MS + TRIM_SKIP_MS && totalMs - lastEnd <= TRIM_TAIL_KEEP_MS + TRIM_SKIP_MS) {
      return { path: audioPath, cues };
    }
    const startMs = Math.max(0, firstStart - TRIM_LEAD_KEEP_MS);
    const endMs = Math.min(totalMs > 0 ? totalMs : lastEnd + TRIM_TAIL_KEEP_MS, lastEnd + TRIM_TAIL_KEEP_MS);
    if (endMs - startMs < 200) return { path: audioPath, cues };

    const tmp = audioPath + ".trim.mp3";
    try {
      if (fs.existsSync(tmp)) fs.unlinkSync(tmp);
    } catch {
      /* noop */
    }
    const res = await runFfmpeg(
      [
        "-y",
        "-i", audioPath,
        "-ss", (startMs / 1000).toFixed(3),
        "-t", ((endMs - startMs) / 1000).toFixed(3),
        "-c:a", "libmp3lame",
        // 源是 48kbps；二次编码给到 64kbps，尽量不引入可听的损失
        "-b:a", "64k",
        "-ar", "24000",
        "-ac", "1",
        tmp,
      ],
      { timeoutMs: 60_000, signal: this.signal }
    );
    if (res.code !== 0 || !fs.existsSync(tmp) || fs.statSync(tmp).size === 0) {
      try {
        if (fs.existsSync(tmp)) fs.unlinkSync(tmp);
      } catch {
        /* noop */
      }
      return { path: audioPath, cues };
    }
    try {
      fs.copyFileSync(tmp, audioPath);
      fs.unlinkSync(tmp);
    } catch {
      return { path: audioPath, cues };
    }
    return {
      path: audioPath,
      cues: cues.map((c) => ({ ...c, start: c.start - startMs, end: c.end - startMs })),
    };
  }

  /** 单条语音 → 单文件，含重试。空文本返回 null。 */
  async generateSingle(seg: TtsSegment): Promise<TtsResult | null> {
    if (!seg.text.trim()) return null;
    this.throwIfAborted();

    const outputPath = path.join(this.outputDir, `line_${String(seg.index).padStart(3, "0")}.mp3`);
    const subPath = outputPath + ".json";
    const voice = seg.voice;

    let lastErr: unknown = null;
    for (let attempt = 0; attempt < this.maxRetries; attempt++) {
      try {
        // 清理上一次遗留的 0 字节/被锁文件，避免 createWriteStream 打开已存在文件时报 EPERM
        if (fs.existsSync(outputPath)) {
          try {
            fs.unlinkSync(outputPath);
          } catch {
            /* 仍被锁时留给重试 */
          }
        }
        await this.synthesizeOnce(seg, outputPath);
        const stat = fs.statSync(outputPath);
        if (stat.size === 0) throw new Error("Generated audio is empty");
        // 读取词级时间轴（node-edge-tts saveSubtitles 写的 {part,start,end} 毫秒）
        let cues: WordCue[] = [];
        try {
          if (fs.existsSync(subPath)) {
            const raw = JSON.parse(fs.readFileSync(subPath, "utf-8"));
            if (Array.isArray(raw)) {
              cues = raw
                .filter((c) => c && typeof c.part === "string")
                .map((c) => ({ part: c.part, start: +c.start || 0, end: +c.end || 0 }));
            }
          }
        } catch {
          /* 时间轴读取失败不阻塞，退回按字数均分 */
        }
        const trimmed = await this.trimEdgeSilence(outputPath, cues);
        return { path: trimmed.path, cues: trimmed.cues };
      } catch (e) {
        lastErr = e;
        for (const p of [outputPath, subPath]) {
          if (fs.existsSync(p)) {
            try {
              fs.unlinkSync(p);
            } catch {
              /* noop */
            }
          }
        }
        // 最后一次失败不重试
        if (attempt < this.maxRetries - 1) {
          const wait = Math.min(2 ** attempt * 2_000, 8_000);
          await this.waitOrAbort(wait);
        }
      }
    }
    throw lastErr instanceof Error ? lastErr : new Error(String(lastErr));
  }

  /** 顺序合成所有语音；空文本返回 null。结束后回调 (current, total)。 */
  async generateAll(
    segments: TtsSegment[],
    onProgress?: TtsProgressCallback
  ): Promise<(TtsResult | null)[]> {
    const total = segments.length;
    const results: (TtsResult | null)[] = [];
    for (let i = 0; i < total; i++) {
      this.throwIfAborted();
      try {
        const p = await this.generateSingle(segments[i]);
        results.push(p);
      } catch (e) {
        if (this.signal?.aborted) throw e;
        // 单行失败：跳过（composaer 同步找音频，没有就跳过对应片段）
        results.push(null);
        // 继续下一行，不中断整批
      }
      onProgress?.(i + 1, total);
      if (i < total - 1 && this.betweenDelayMs > 0) {
        await this.waitOrAbort(this.betweenDelayMs);
      }
    }
    return results;
  }

  /** 清理本 outputDir 里的所有 line_*.mp3。调用方在重新生成前可主动清缓存。 */
  clearOutputDir(): number {
    let n = 0;
    if (!fs.existsSync(this.outputDir)) return 0;
    for (const f of fs.readdirSync(this.outputDir)) {
      if (/^line_\d+\.mp3$/.test(f)) {
        try {
          fs.unlinkSync(path.join(this.outputDir, f));
          n++;
        } catch {
          /* noop */
        }
      }
    }
    return n;
  }
}
