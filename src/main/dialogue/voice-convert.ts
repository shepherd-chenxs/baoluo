/*
 * SPDX-License-Identifier: GPL-3.0-only
 * Copyright (c) 2026 宝螺 / Baoluo contributors
 * 本文件属于「宝螺 / Baoluo」。除 GPL-3.0 外还适用 ADDITIONAL_TERMS.md 里的附加条款：
 * 分发时须保留来源署名；修改版对外分发时不得沿用「宝螺」名称与图标。
 */
/**
 * voice-convert — 变声器（方案 A：识别 → 用指定音色重新配音）。
 *
 * 流程：源文件（音频/视频）→ ffmpeg 抽 16kHz 人声 → whisper.cpp 识别成句 →
 *       用用户选的音色（Edge 在线音色 / 本地 Genie 克隆音色）逐句重新配音 →
 *       ffmpeg 统一采样率后拼成一条 wav。
 *
 * 与 B 方案（RVC 等真·语音转换）的区别：不保留原声的语气、停顿、语速，
 * 只是"照着重念一遍"。好处是零新增依赖、纯 CPU、复用已有的克隆音色体系。
 *
 * 进度按阶段加权：识别 0~45，配音 45~95，拼接 95~100。
 */
import fs from "node:fs";
import path from "node:path";
import { transcribeVideo } from "../transcribe";
import { GenieTtsEngine, genieCharacterName } from "./genie";
import { TtsEngine, prosodyPercent } from "./tts";
import { probeAudioDuration, runFfmpeg } from "./ffmpeg";
import {
  cloneIdFromVoice,
  findCloneVoice,
  localTtsBaseUrl,
  resolveGenieModelDir,
} from "./clone-voice";
import type {
  VoiceConvertProgress,
  VoiceConvertResult,
  VoiceConvertStage,
} from "../../shared/dialogue-types";

/** 拼接前的统一采样率：与 Genie 输出一致，避免重采样二次损失 */
const SEG_SAMPLE_RATE = 32000;

/** 阶段进度权重 */
const P_TRANSCRIBE_DONE = 45;
const P_SYNTH_START = 45;
const P_SYNTH_SPAN = 50;
const P_MERGE = 95;

export interface VoiceConvertOptions {
  inputPath: string;
  voice: string;
  rate?: number;
  pitch?: number;
  volume?: number;
  /** 本次任务的独立输出目录（调用方负责创建/清理） */
  outputDir: string;
  requestId?: string;
  signal?: AbortSignal;
  onProgress?: (p: VoiceConvertProgress) => void;
}

/** 取 ffmpeg stderr 的最后一行，用于报错时给出可读原因 */
function stderrTail(stderr: string): string {
  const lines = stderr.split(/\r?\n/).filter((l) => l.trim());
  return lines.length ? lines[lines.length - 1].trim().slice(0, 200) : "";
}

/**
 * 跑完整条变声流水线。失败时抛中文错误（界面直接展示）。
 * 中间产物（切句、归一化音频）跑完即删，只留 outputDir/voice.wav。
 */
export async function runVoiceConvert(opts: VoiceConvertOptions): Promise<VoiceConvertResult> {
  const emit = (
    stage: VoiceConvertStage,
    percent: number,
    extra: Omit<Partial<VoiceConvertProgress>, "stage" | "percent"> = {}
  ): void => {
    opts.onProgress?.({ requestId: opts.requestId, stage, percent, ...extra });
  };
  const throwIfAborted = (): void => {
    if (opts.signal?.aborted) throw new Error("已取消");
  };

  if (!opts.inputPath || !fs.existsSync(opts.inputPath)) {
    throw new Error("源文件不存在或已被移动。");
  }
  if (!opts.voice) throw new Error("请先选择要变的目标音色。");

  const segDir = path.join(opts.outputDir, "seg");
  const normDir = path.join(opts.outputDir, "norm");
  fs.mkdirSync(segDir, { recursive: true });
  fs.mkdirSync(normDir, { recursive: true });

  try {
    // ---------------- 1. 识别 ----------------
    emit("transcribe", 2, { message: "正在识别原文件里的人声…" });
    const transcription = await transcribeVideo({
      videoPath: opts.inputPath,
      language: "zh",
      signal: opts.signal,
      onProgress: (p) => {
        switch (p.stage) {
          case "model-download-start":
            emit("model-download", 1, {
              message: "首次使用：正在下载本地识别模型（约 150 MB），下载后长期保存",
            });
            break;
          case "model-download":
            emit("model-download", 1, { received: p.received, total: p.total });
            break;
          case "extract-audio":
            emit("extract-audio", 5, { message: "正在从原文件里提取人声…" });
            break;
          case "transcribe-start":
            emit("transcribe", 8, { message: "正在识别文字…" });
            break;
          case "transcribe-line":
            emit("transcribe", 30, { message: "正在识别文字…", line: p.line });
            break;
          default:
            break;
        }
      },
    });
    throwIfAborted();

    // 空句（纯音乐/杂音）直接丢掉，否则会合成出一堆空白音频
    const segments = transcription.segments
      .map((s) => ({ text: (s.text ?? "").trim(), start: s.start, end: s.end }))
      .filter((s) => s.text);
    if (!segments.length) {
      const whole = (transcription.text ?? "").trim();
      if (!whole) {
        throw new Error("没有识别到可用的人声，请换一段有人声的音频或视频试试。");
      }
      segments.push({ text: whole, start: 0, end: 0 });
    }
    emit("transcribe", P_TRANSCRIBE_DONE, {
      message: `识别到 ${segments.length} 句，开始用新音色重新配音`,
      totalLines: segments.length,
    });

    // ---------------- 2. 逐句重新配音 ----------------
    const total = segments.length;
    const rawParts: Array<string | null> = new Array(total).fill(null);
    const cloneId = cloneIdFromVoice(opts.voice);

    if (!cloneId) {
      // 在线音色：整批交给 TtsEngine（自带重试，单句失败跳过）
      const engine = new TtsEngine({
        outputDir: segDir,
        signal: opts.signal,
        timeoutMs: 30_000,
        maxRetries: 2,
        betweenDelayMs: 0,
      });
      const results = await engine.generateAll(
        segments.map((s, i) => ({
          index: i,
          text: s.text,
          voice: opts.voice,
          rate: prosodyPercent(opts.rate ?? 0),
          pitch: prosodyPercent(opts.pitch ?? 0),
          volume: prosodyPercent(opts.volume ?? 0),
        })),
        (current, all) => {
          emit("synthesize", P_SYNTH_START + Math.round((current / all) * P_SYNTH_SPAN), {
            current,
            totalLines: all,
            message: `正在用新音色重新配音（${current}/${all}）`,
          });
        }
      );
      results.forEach((r, i) => {
        rawParts[i] = r?.path ?? null;
      });
    } else {
      // 克隆音色：本地 Genie 服务，加载一次角色后逐句合成
      const voice = findCloneVoice(cloneId);
      const engine = new GenieTtsEngine({
        baseUrl: localTtsBaseUrl(),
        signal: opts.signal,
        timeoutMs: 120_000,
      });
      const name = genieCharacterName(voice.id);
      try {
        await engine.loadCharacter(name, resolveGenieModelDir(voice.modelDir), voice.language);
        await engine.setReferenceAudio(
          name,
          voice.audioPath,
          voice.audioText,
          voice.language
        );
      } catch (e) {
        await engine.stop();
        if (opts.signal?.aborted) throw new Error("已取消");
        throw new Error(
          `克隆音色「${voice.name}」加载失败：${e instanceof Error ? e.message : String(e)}` +
            "（请先在「设置 → 声音克隆」点「启动服务」，并确认模型和参考音频都在）"
        );
      }
      try {
        for (let i = 0; i < total; i++) {
          throwIfAborted();
          try {
            const r = await engine.synthesize(
              { index: i, text: segments[i].text, characterName: name },
              path.join(segDir, `line_${String(i).padStart(3, "0")}.wav`)
            );
            rawParts[i] = r.path;
          } catch (e) {
            if (opts.signal?.aborted) {
              await engine.stop();
              throw new Error("已取消");
            }
            // 单句失败：跳过该句，继续后面的（与视频生成的处理一致）
            rawParts[i] = null;
          }
          emit("synthesize", P_SYNTH_START + Math.round(((i + 1) / total) * P_SYNTH_SPAN), {
            current: i + 1,
            totalLines: total,
            message: `正在用新音色重新配音（${i + 1}/${total}）`,
          });
        }
      } finally {
        // 用完卸载：Genie 每加载一个角色占几百 MB，不卸载会在连续任务后 OOM（空音频）
        await engine.unloadCharacter(name);
      }
    }
    throwIfAborted();

    const doneParts = rawParts.filter((p): p is string => !!p);
    if (!doneParts.length) {
      throw new Error(
        "所有句子都没能合成成功。若用的是克隆音色，请确认「设置 → 声音克隆」里本地语音服务已启动。"
      );
    }

    // ---------------- 3. 归一化 + 拼接 ----------------
    emit("merge", P_MERGE, { message: "正在拼接音频…" });
    const normParts: string[] = [];
    for (let i = 0; i < doneParts.length; i++) {
      throwIfAborted();
      const out = path.join(normDir, `n_${String(i).padStart(3, "0")}.wav`);
      // 在线音色是 24kHz mp3、克隆音色是 32kHz 裸 wav，统一成同格式才能无缝拼接
      const r = await runFfmpeg(
        [
          "-y",
          "-i",
          doneParts[i],
          "-ar",
          String(SEG_SAMPLE_RATE),
          "-ac",
          "1",
          "-c:a",
          "pcm_s16le",
          out,
        ],
        { signal: opts.signal, timeoutMs: 120_000 }
      );
      if (r.code === 0 && fs.existsSync(out)) normParts.push(out);
    }
    if (!normParts.length) throw new Error("音频转码失败，请确认源文件能正常播放。");

    const outputPath = path.join(opts.outputDir, "voice.wav");
    if (normParts.length === 1) {
      fs.copyFileSync(normParts[0], outputPath);
    } else {
      const listPath = path.join(opts.outputDir, "concat.txt");
      // concat demuxer 的路径一定要正斜杠；单引号按 ffmpeg 规则转义
      const listBody = normParts
        .map((p) => `file '${p.replace(/\\/g, "/").replace(/'/g, "'\\''")}'`)
        .join("\n");
      fs.writeFileSync(listPath, listBody, "utf-8");
      const r = await runFfmpeg(
        ["-y", "-f", "concat", "-safe", "0", "-i", listPath, "-c:a", "pcm_s16le", outputPath],
        { signal: opts.signal, timeoutMs: 300_000 }
      );
      if (r.code !== 0 || !fs.existsSync(outputPath)) {
        throw new Error(`音频拼接失败：${stderrTail(r.stderr) || "未知原因"}`);
      }
    }

    const durationSec = await probeAudioDuration(outputPath);
    emit("done", 100, {
      message: `完成，共 ${doneParts.length} 句`,
      current: doneParts.length,
      totalLines: total,
    });
    return {
      audioPath: outputPath,
      segmentCount: total,
      doneCount: doneParts.length,
      durationSec,
    };
  } finally {
    // 中间产物（切句 mp3/wav、归一化 wav、concat 列表）跑完即清，别堆在用户目录里
    for (const dir of [segDir, normDir]) {
      try {
        fs.rmSync(dir, { recursive: true, force: true });
      } catch {
        /* 被占用时留给下次清理 */
      }
    }
    try {
      const listPath = path.join(opts.outputDir, "concat.txt");
      if (fs.existsSync(listPath)) fs.unlinkSync(listPath);
    } catch {
      /* noop */
    }
  }
}
