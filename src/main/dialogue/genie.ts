/*
 * SPDX-License-Identifier: GPL-3.0-only
 * Copyright (c) 2026 宝螺 / Baoluo contributors
 * 本文件属于「宝螺 / Baoluo」。除 GPL-3.0 外还适用 ADDITIONAL_TERMS.md 里的附加条款：
 * 分发时须保留来源署名；修改版对外分发时不得沿用「宝螺」名称与图标。
 */
/**
 * genie — 本地声音克隆服务（Genie-TTS，GPT-SoVITS 的 ONNX CPU 引擎）。
 *
 * Genie-TTS 内置一个 FastAPI 服务（本应用固定用 127.0.0.1:45231），
 * 接口：
 *   POST /load_character        { character_name, onnx_model_dir, language }
 *   POST /set_reference_audio   { character_name, audio_path, audio_text, language }
 *   POST /tts                   { character_name, text, split_sentence?, save_path? } → audio/wav 流
 *   POST /unload_character      { character_name }
 *   POST /stop
 * 本类封装这些调用，供语音合成 / 视频生成共用。模型与参考音频都在本地，不联网。
 */
import fs from "node:fs";
import path from "node:path";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { trimSilenceByDetect } from "./audio-silence";

export interface GenieTtsOptions {
  /** 例如 http://127.0.0.1:45231 */
  baseUrl: string;
  /** 单次请求超时（ms），默认 60s（CPU 合成一句可能较慢） */
  timeoutMs?: number;
  /** 取消信号：中止时立即停止 */
  signal?: AbortSignal;
}

/** 克隆音色的合成参数（characterName 需已加载并设置参考音频） */
export interface GenieSegment {
  index: number;
  text: string;
  characterName: string;
}

export interface GenieResult {
  path: string;
}

const DEFAULT_TIMEOUT_MS = 60_000;

/** Genie 流式返回的是 32kHz / 单声道 / 16-bit 的裸 PCM，需要补 WAV 头 */
function wrapRawPcmAsWav(pcm: Buffer, sampleRate = 32000): Buffer {
  const channels = 1;
  const bitsPerSample = 16;
  const dataSize = pcm.length;
  const blockAlign = (channels * bitsPerSample) / 8;
  const byteRate = (sampleRate * channels * bitsPerSample) / 8;
  const header = Buffer.alloc(44);
  header.write("RIFF", 0, "ascii");
  header.writeUInt32LE(36 + dataSize, 4);
  header.write("WAVE", 8, "ascii");
  header.write("fmt ", 12, "ascii");
  header.writeUInt32LE(16, 16);
  header.writeUInt16LE(1, 20); // PCM
  header.writeUInt16LE(channels, 22);
  header.writeUInt32LE(sampleRate, 24);
  header.writeUInt32LE(byteRate, 28);
  header.writeUInt16LE(blockAlign, 32);
  header.writeUInt16LE(bitsPerSample, 34);
  header.write("data", 36, "ascii");
  header.writeUInt32LE(dataSize, 40);
  return Buffer.concat([header, pcm]);
}

/** 角色名只保留小写字母数字和连字符，避免特殊字符进 URL/请求体 */
export function genieCharacterName(id: string): string {
  return "clone-" + (id || "").replace(/[^a-zA-Z0-9-]/g, "").toLowerCase() || "clone";
}

export class GenieTtsEngine {
  private readonly baseUrl: string;
  private readonly timeoutMs: number;
  private readonly signal?: AbortSignal;

  constructor(opts: GenieTtsOptions) {
    this.baseUrl = opts.baseUrl.replace(/\/+$/, "");
    this.timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    this.signal = opts.signal;
  }

  /** 请求级 AbortSignal：合并外部取消信号与超时 */
  private requestSignal(): { signal: AbortSignal; cleanup: () => void } {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    const onAbort = () => controller.abort();
    if (this.signal) {
      if (this.signal.aborted) controller.abort();
      else this.signal.addEventListener("abort", onAbort, { once: true });
    }
    return {
      signal: controller.signal,
      cleanup: () => {
        clearTimeout(timer);
        this.signal?.removeEventListener("abort", onAbort);
      },
    };
  }

  private async post<T>(p: { path: string; body?: unknown }): Promise<T> {
    const { signal, cleanup } = this.requestSignal();
    try {
      const res = await fetch(this.baseUrl + p.path, {
        method: "POST",
        headers: p.body !== undefined ? { "Content-Type": "application/json" } : undefined,
        body: p.body !== undefined ? JSON.stringify(p.body) : undefined,
        signal,
      });
      if (!res.ok) {
        const detail = await res.text().catch(() => "");
        throw new Error(`本地语音服务错误 ${res.status}：${(detail || res.statusText).slice(0, 300)}`);
      }
      return (await res.json()) as T;
    } finally {
      cleanup();
    }
  }

  /** 服务是否在线：FastAPI 自带 /openapi.json，能拿到就说明服务活着 */
  async ping(): Promise<boolean> {
    const { signal, cleanup } = this.requestSignal();
    try {
      const res = await fetch(this.baseUrl + "/openapi.json", {
        method: "GET",
        signal,
      });
      return res.ok;
    } catch {
      return false;
    } finally {
      cleanup();
    }
  }

  /** 加载一个角色模型（克隆音色必须先用基础模型目录注册） */
  async loadCharacter(characterName: string, modelDir: string, language: string): Promise<void> {
    await this.post<{ status: string }>({
      path: "/load_character",
      body: { character_name: characterName, onnx_model_dir: modelDir, language },
    });
  }

  /** 为角色设置参考音频（声音克隆的"样本"） */
  async setReferenceAudio(
    characterName: string,
    audioPath: string,
    audioText: string,
    language: string
  ): Promise<void> {
    await this.post<{ status: string }>({
      path: "/set_reference_audio",
      body: {
        character_name: characterName,
        audio_path: audioPath,
        audio_text: audioText,
        language,
      },
    });
  }

  /** 合成一句：POST /tts 返回 wav 流，写入 outputPath */
  async synthesize(seg: GenieSegment, outputPath: string): Promise<GenieResult> {
    fs.mkdirSync(path.dirname(outputPath), { recursive: true });
    const { signal, cleanup } = this.requestSignal();
    try {
      const res = await fetch(this.baseUrl + "/tts", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          character_name: seg.characterName,
          text: seg.text,
          split_sentence: false,
        }),
        signal,
      });
      if (!res.ok) {
        const detail = await res.text().catch(() => "");
        throw new Error(`本地语音合成失败 ${res.status}：${(detail || res.statusText).slice(0, 300)}`);
      }
      if (!res.body) throw new Error("本地语音服务没有返回音频数据。");
      await pipeline(Readable.fromWeb(res.body as any), fs.createWriteStream(outputPath));
      const raw = fs.readFileSync(outputPath);
      if (raw.length === 0) throw new Error("本地语音服务返回了空音频。");
      // 兼容两种情况：服务端已返回标准 WAV，或只返回裸 PCM（Genie 默认行为）
      const final = raw.length > 12 && raw.toString("ascii", 0, 4) === "RIFF" ? raw : wrapRawPcmAsWav(raw);
      fs.writeFileSync(outputPath, final);
      // 克隆音色的输出没有逐词时间轴，尾部静音只能靠静音检测裁：
      // 不裁的话字幕会一直挂到静音结束（看起来慢半拍），成片也多出死时间。
      // 裁剪失败不影响结果，原音频照常返回。
      try {
        await trimSilenceByDetect(outputPath, this.signal);
      } catch {
        /* 保持原音频 */
      }
      return { path: outputPath };
    } finally {
      cleanup();
    }
  }

  /** 停止当前合成任务（取消时调用，尽力而为） */
  async stop(): Promise<void> {
    try {
      await this.post<{ status: string }>({ path: "/stop" });
    } catch {
      /* 服务未在线时忽略 */
    }
  }

  /** 卸载角色模型，释放内存 */
  async unloadCharacter(characterName: string): Promise<void> {
    try {
      await this.post<{ status: string }>({
        path: "/unload_character",
        body: { character_name: characterName },
      });
    } catch {
      /* 卸载失败不阻塞 */
    }
  }
}
