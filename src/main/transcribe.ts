/*
 * SPDX-License-Identifier: GPL-3.0-only
 * Copyright (c) 2026 宝螺 / Baoluo contributors
 * 本文件属于「宝螺 / Baoluo」。除 GPL-3.0 外还适用 ADDITIONAL_TERMS.md 里的附加条款：
 * 分发时须保留来源署名；修改版对外分发时不得沿用「宝螺」名称与图标。
 */
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { spawn } from "node:child_process";
import { app, net, type WebContents } from "electron";
// eslint-disable-next-line @typescript-eslint/no-var-requires
const OpenCC = require("opencc-js");

// Whisper 中文模型默认容易输出繁体，用 OpenCC 统一转简体。
// tw→cn 使用完整的繁体（含台湾用词习惯）→ 大陆用词，覆盖 t2s + tw2sp。
const toSimplified: (s: string) => string = OpenCC.Converter({ from: "tw", to: "cn" });

/**
 * 视频文案提取（Whisper 本地 ASR）流程：
 *   mp4 → ffmpeg 抽 16kHz 单声道 WAV → whisper-cli 转录 → 纯文本
 *
 * 二进制布局：
 *   - ffmpeg：ffmpeg-static 模块提供，dev/prod 都能用 require('ffmpeg-static')
 *   - whisper-cli + 一堆 ggml*.dll + libopenblas.dll：resources/whisper/Release/
 *     dev 时直接是 <cwd>/resources/whisper/Release/
 *     prod 时 electron-builder 的 extraResources 会把这一整个目录复制到 app.getPath('exe')/../resources/
 *   - 模型 ggml-base.bin：首启时从 huggingface 镜像下载到 userData 目录，永久缓存
 */

const MODEL_NAME = "ggml-base.bin"; // ~150 MB，中英文混合场景足够
// 只走 hf-mirror.com 国内镜像，不直连国外
const MODEL_URL =
  "https://hf-mirror.com/ggerganov/whisper.cpp/resolve/main/ggml-base.bin";
const MODEL_EXPECTED_SIZE = 148_000_000; // 用于识别不完整的下载残留

// ------------ 路径解析 ------------

/** whisper.cpp 二进制目录 */
function whisperBinDir(): string {
  if (app.isPackaged) {
    // electron-builder extraResources 会放到这里
    return path.join(process.resourcesPath, "whisper", "Release");
  }
  return path.join(app.getAppPath(), "resources", "whisper", "Release");
}

function whisperCliPath(): string {
  return path.join(whisperBinDir(), "whisper-cli.exe");
}

/** ffmpeg-static 的路径。打包后 asar 里跑不了 exe，需要 asarUnpack 出来。 */
function ffmpegPath(): string {
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const raw: string = require("ffmpeg-static");
  // 打包后 asar 里的 exe 无法执行，electron-builder 的 asarUnpack 规则会解压到 app.asar.unpacked/
  return raw.replace("app.asar", "app.asar.unpacked");
}

/** 模型缓存路径（userData 目录，跨启动持久化） */
function modelPath(): string {
  return path.join(app.getPath("userData"), "models", MODEL_NAME);
}

// ------------ 首启下载模型 ------------

export function isModelReady(): boolean {
  const p = modelPath();
  if (!fs.existsSync(p)) return false;
  const stat = fs.statSync(p);
  // 至少 100 MB 才算不是残留（正常 148 MB）
  return stat.size > 100_000_000;
}

export async function downloadModel(
  onProgress?: (info: { received: number; total: number; percent: number }) => void,
  signal?: AbortSignal
): Promise<void> {
  const target = modelPath();
  fs.mkdirSync(path.dirname(target), { recursive: true });

  // 用临时文件，成功再 rename，避免半截文件被当"已就绪"
  const tmp = target + ".part";
  if (fs.existsSync(tmp)) fs.unlinkSync(tmp);

  const tryDownload = (url: string) =>
    new Promise<void>((resolve, reject) => {
      const req = net.request({ method: "GET", url, redirect: "follow" });
      const onAbort = () => {
        req.abort();
        reject(new Error("已取消"));
      };
      if (signal) {
        if (signal.aborted) {
          onAbort();
          return;
        }
        signal.addEventListener("abort", onAbort, { once: true });
      }
      req.on("response", (res) => {
        if (res.statusCode >= 400) {
          signal?.removeEventListener("abort", onAbort);
          reject(new Error(`HTTP ${res.statusCode} from ${url}`));
          return;
        }
        const total = Number(res.headers["content-length"] ?? MODEL_EXPECTED_SIZE);
        const out = fs.createWriteStream(tmp);
        let received = 0;
        res.on("data", (chunk: Buffer) => {
          received += chunk.length;
          out.write(chunk);
          if (onProgress)
            onProgress({
              received,
              total,
              percent: total > 0 ? Math.min(100, (received / total) * 100) : 0,
            });
        });
        res.on("end", () => {
          out.end();
          out.on("finish", () => {
            signal?.removeEventListener("abort", onAbort);
            resolve();
          });
        });
        res.on("error", (e: Error) => {
          signal?.removeEventListener("abort", onAbort);
          reject(e);
        });
      });
      req.on("error", (e) => {
        signal?.removeEventListener("abort", onAbort);
        reject(e);
      });
      req.end();
    });

  await tryDownload(MODEL_URL);
  fs.renameSync(tmp, target);
}

// ------------ 音频抽取 ------------

/**
 * 用 ffmpeg 把视频抽成 16kHz 单声道 s16le WAV（Whisper 要求的格式）。
 * 只取音频，不要视频轨。
 */
export async function extractAudioToWav(
  videoPath: string,
  signal?: AbortSignal
): Promise<string> {
  const outDir = path.join(os.tmpdir(), "baoluo-transcribe");
  fs.mkdirSync(outDir, { recursive: true });
  // 用纯 ASCII 文件名：whisper.cpp 的 miniaudio 在 Windows 上按 ANSI 读文件，
  // 文件名带中文会打不开（乱码/读取失败）
  const wavPath = path.join(
    outDir,
    `audio-${Date.now()}-${Math.floor(Math.random() * 100000)}.wav`
  );

  const args = [
    "-y",              // overwrite
    "-i", videoPath,
    "-vn",             // no video
    "-acodec", "pcm_s16le",
    "-ar", "16000",    // 16 kHz
    "-ac", "1",        // mono
    "-f", "wav",
    wavPath,
  ];

  await runCmd(ffmpegPath(), args, { quiet: true, signal });
  return wavPath;
}

// ------------ 主流程 ------------

/** 进度事件（与渲染层的 TranscribeProgress 同构，但主进程侧不依赖 preload 类型） */
export interface TranscribeProgressEvent {
  stage: string;
  requestId?: string;
  received?: number;
  total?: number;
  percent?: number;
  line?: string;
}

export interface TranscribeOptions {
  videoPath: string;
  webContents?: WebContents;
  requestId?: string;
  language?: string; // 默认 zh
  /** 取消信号：中止时停止下载/抽音频/识别 */
  signal?: AbortSignal;
  /**
   * 进度回调。给「不需要把进度发到某个渲染进程」的调用方用（如变声器：
   * 它有自己的进度通道，不希望转写进度串到语音识别页的 UI 上）。
   */
  onProgress?: (p: TranscribeProgressEvent) => void;
}

export interface TranscribeResult {
  text: string;
  segments: Array<{ start: number; end: number; text: string }>;
}

export async function transcribeVideo(opts: TranscribeOptions): Promise<TranscribeResult> {
  const send = (stage: string, extra: Record<string, unknown> = {}) => {
    if (opts.onProgress) {
      opts.onProgress({ stage, ...extra } as TranscribeProgressEvent);
    }
    if (opts.webContents && !opts.webContents.isDestroyed()) {
      opts.webContents.send("transcribe:progress", {
        requestId: opts.requestId,
        stage,
        ...extra,
      });
    }
  };

  // 1. 检查/下载模型
  if (!isModelReady()) {
    if (opts.signal?.aborted) throw new Error("已取消");
    send("model-download-start");
    await downloadModel((p) => send("model-download", p), opts.signal);
    send("model-download-done");
  }

  // 2. 抽音频
  if (opts.signal?.aborted) throw new Error("已取消");
  send("extract-audio");
  const wavPath = await extractAudioToWav(opts.videoPath, opts.signal);

  try {
    // 3. 跑 Whisper
    if (opts.signal?.aborted) throw new Error("已取消");
    send("transcribe-start");
    const lang = opts.language ?? "zh";
    const result = await runWhisper(wavPath, lang, (line) => {
      // whisper 输出形如: [00:00:00.000 --> 00:00:04.000]  你好世界
      // 实时行也做简繁转换，保证 UI 显示一致
      send("transcribe-line", { line: lang === "zh" ? toSimplified(line) : line });
    }, opts.signal);
    send("transcribe-done");
    return result;
  } finally {
    try { fs.unlinkSync(wavPath); } catch {}
  }
}

async function runWhisper(
  wavPath: string,
  language: string,
  onLine: (line: string) => void,
  signal?: AbortSignal
): Promise<TranscribeResult> {
  const outBase = wavPath.replace(/\.wav$/i, ""); // whisper 会写 outBase.txt / outBase.json
  const args = [
    "-m", modelPath(),
    "-l", language,
    "-t", String(Math.max(2, Math.min(8, os.cpus().length - 1))), // 线程数
    // 大幅提高 beam / best-of 让识别更精细，Whisper 中文对标点的输出概率会跟着上升
    "-bo", "8",
    "-bs", "8",
    // Prompt 里塞一段"带标点、简体、分句"的样板文本 —— Whisper 会模仿这个风格续写。
    // 关键：范文里必须自然带上，，。？！等标点，而且中文行文密度接近实际短视频文案。
    "--prompt",
      "以下是普通话短视频的文案，请用简体中文并添加标点。今天我们要聊的是一个很有意思的话题。大家有没有发现，其实在生活中，很多事情都不是我们想象的那样。举个例子，你以为你懂了，可实际上呢？根本没懂。所以说，学习最重要的一步就是承认自己不懂。",
    // 强制按 ~15 字符切分成多段，方便后处理补标点
    "--max-len", "15",
    "--output-txt",
    "--output-json",
    "-of", outBase,
    "--no-prints",
    wavPath,
  ];

  await runCmd(whisperCliPath(), args, {
    cwd: whisperBinDir(),
    signal,
    onStdout: (chunk) => {
      const lines = chunk.split(/\r?\n/).filter(Boolean);
      for (const l of lines) onLine(l);
    },
  });

  const txtFile = outBase + ".txt";
  const jsonFile = outBase + ".json";

  let segments: TranscribeResult["segments"] = [];
  if (fs.existsSync(jsonFile)) {
    try {
      const j = JSON.parse(fs.readFileSync(jsonFile, "utf-8"));
      const raw = j.transcription ?? j.segments ?? [];
      segments = raw.map((s: any) => {
        const t = String(s.text ?? "").trim();
        return {
          start: Number(s.offsets?.from ?? s.start ?? 0) / 1000,
          end: Number(s.offsets?.to ?? s.end ?? 0) / 1000,
          text: language === "zh" ? toSimplified(t) : t,
        };
      }).filter((s: any) => s.text);
    } catch {}
  }

  // 组合最终文本：优先用 segments + 智能标点，若没有 segments 则退回 txt 文件
  let text: string;
  if (language === "zh" && segments.length > 0) {
    text = joinSegmentsWithPunctuation(segments);
  } else {
    const rawText = fs.existsSync(txtFile) ? fs.readFileSync(txtFile, "utf-8").trim() : "";
    text = language === "zh" ? toSimplified(rawText) : rawText;
  }

  // 清理临时文件
  try { fs.unlinkSync(txtFile); } catch {}
  try { fs.unlinkSync(jsonFile); } catch {}

  return { text, segments };
}

// ------------ 中文标点修复 ------------

/**
 * Whisper base 模型对中文标点原生输出很少，且时间戳基本连续无静音信息。
 * 我们的策略：在使用 --max-len 15 强制切成 ~15 字符片段之后，按简单规律补标点：
 *   - 每 3 段之末补句号（或问号，若疑问词收尾）
 *   - 其他段之末补逗号
 *   - 整体末尾兜底句号
 * 若某段末尾已经有 Whisper 输出的标点，就不再重复补。
 */
function joinSegmentsWithPunctuation(
  segments: Array<{ start: number; end: number; text: string }>
): string {
  const ENDING_PUNCT = /[，。！？；：,.\?!;:、~—…]$/;
  const QUESTION_HINT = /(吗|呢|嘛|吧|么|啥|谁|哪|怎|何)[”"'）)』」]?$/;

  let out = "";
  const sentenceEveryN = 3;
  for (let i = 0; i < segments.length; i++) {
    const seg = segments[i];
    let clean = seg.text.replace(/^[\s，,]+|[\s]+$/g, "");
    if (!clean) continue;
    if (i < segments.length - 1) {
      if (!ENDING_PUNCT.test(clean)) {
        const shouldPeriod = (i + 1) % sentenceEveryN === 0;
        clean += shouldPeriod ? (QUESTION_HINT.test(clean) ? "？" : "。") : "，";
      }
    }
    out += clean;
  }

  if (out && !ENDING_PUNCT.test(out)) {
    out += QUESTION_HINT.test(out) ? "？" : "。";
  }
  return out;
}

// ------------ 通用子进程执行 ------------
interface RunCmdOptions {
  cwd?: string;
  quiet?: boolean;
  onStdout?: (chunk: string) => void;
  signal?: AbortSignal;
}

function runCmd(cmd: string, args: string[], opt: RunCmdOptions = {}): Promise<void> {
  return new Promise((resolve, reject) => {
    if (!fs.existsSync(cmd)) {
      reject(new Error(`可执行文件不存在：${cmd}`));
      return;
    }
    let settled = false;
    const proc = spawn(cmd, args, {
      cwd: opt.cwd,
      windowsHide: true,
    });
    const onAbort = () => {
      if (settled) return;
      settled = true;
      try {
        proc.kill();
      } catch {
        /* noop */
      }
      reject(new Error("已取消"));
    };
    if (opt.signal) {
      if (opt.signal.aborted) {
        onAbort();
        return;
      }
      opt.signal.addEventListener("abort", onAbort, { once: true });
    }
    let stderrTail = "";
    proc.stdout.on("data", (buf: Buffer) => {
      if (opt.onStdout) opt.onStdout(buf.toString("utf-8"));
    });
    proc.stderr.on("data", (buf: Buffer) => {
      stderrTail = (stderrTail + buf.toString("utf-8")).slice(-4000);
      if (!opt.quiet && opt.onStdout) opt.onStdout(buf.toString("utf-8"));
    });
    proc.on("error", (e) => {
      opt.signal?.removeEventListener("abort", onAbort);
      if (settled) return;
      settled = true;
      reject(e);
    });
    proc.on("exit", (code) => {
      opt.signal?.removeEventListener("abort", onAbort);
      if (settled) return;
      settled = true;
      if (code === 0) resolve();
      else reject(new Error(`${path.basename(cmd)} exit ${code}\n${stderrTail}`));
    });
  });
}
