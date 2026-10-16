/*
 * SPDX-License-Identifier: GPL-3.0-only
 * Copyright (c) 2026 宝螺 / Baoluo contributors
 * 本文件属于「宝螺 / Baoluo」。除 GPL-3.0 外还适用 ADDITIONAL_TERMS.md 里的附加条款：
 * 分发时须保留来源署名；修改版对外分发时不得沿用「宝螺」名称与图标。
 */
/**
 * clone-voice — 克隆音色的公共辅助（语音合成 / 变声器 / 视频生成共用）。
 *
 * 这里只做三件事：把 `clone:<id>` 音色值解析成配置里的 CloneVoice、
 * 把用户选的模型目录纠正成 Genie 真正要的那一层、用本地 Genie 服务合成一句。
 * 之前这些逻辑写在 ipc.ts 里，变声器要用时会被迫重复一份，所以抽出来。
 */
import fs from "node:fs";
import path from "node:path";
import { GenieTtsEngine, genieCharacterName } from "./genie";
import * as settings from "./settings";
import { DEFAULT_LOCAL_TTS_HOST, DEFAULT_LOCAL_TTS_PORT } from "../../shared/settings-defaults";
import type { CloneVoice } from "../../shared/dialogue-types";

/** 音色值里的克隆前缀：clone:<id> */
export const CLONE_PREFIX = "clone:";

/** 音色值是否是克隆音色（clone:<id>）；是则返回 id，否则 null */
export function cloneIdFromVoice(v: string): string | null {
  return v.startsWith(CLONE_PREFIX) ? v.slice(CLONE_PREFIX.length) : null;
}

/** 本地语音服务的 baseUrl（设置里可改 host/port） */
export function localTtsBaseUrl(): string {
  return `http://${DEFAULT_LOCAL_TTS_HOST}:${DEFAULT_LOCAL_TTS_PORT}`;
}

/** 查克隆音色；找不到时抛明确错误 */
export function findCloneVoice(id: string): CloneVoice {
  const voice = (settings.getAppSettings().cloneVoices ?? []).find((v) => v.id === id);
  if (!voice) throw new Error("克隆音色不存在，请到「设置 → 声音克隆」里检查。");
  return voice;
}

/**
 * Genie 期望的模型目录是“直接包含 t2s_encoder_fp32.onnx”的那一层。
 * 角色根目录（feibi）下还有 tts_models 子目录，这里自动纠正。
 */
export function resolveGenieModelDir(modelDir: string): string {
  if (fs.existsSync(path.join(modelDir, "t2s_encoder_fp32.onnx"))) {
    return modelDir;
  }
  const sub = path.join(modelDir, "tts_models");
  if (fs.existsSync(path.join(sub, "t2s_encoder_fp32.onnx"))) {
    return sub;
  }
  throw new Error(
    "这个目录里找不到模型文件，请选择模型目录下带 tts_models 的那一层（在「模型库」里重新下载也能解决）。"
  );
}

/**
 * 用克隆音色合成一句（参考音频 + 文本 → 本地 Genie 服务）。
 * 单句场景（试听 / 语音合成页）用；整批场景走 GenieTtsEngine.loadCharacter 一次再逐句合成。
 */
export async function synthCloneSingle(opts: {
  voice: CloneVoice;
  text: string;
  outputDir: string;
  timeoutMs?: number;
}): Promise<{ path: string }> {
  const engine = new GenieTtsEngine({
    baseUrl: localTtsBaseUrl(),
    timeoutMs: opts.timeoutMs ?? 90_000,
  });
  const name = genieCharacterName(opts.voice.id);
  const modelDir = resolveGenieModelDir(opts.voice.modelDir);
  try {
    await engine.loadCharacter(name, modelDir, opts.voice.language);
    await engine.setReferenceAudio(
      name,
      opts.voice.audioPath,
      opts.voice.audioText,
      opts.voice.language
    );
    const r = await engine.synthesize(
      { index: 0, text: opts.text, characterName: name },
      path.join(opts.outputDir, "line_000.wav")
    );
    return { path: r.path };
  } finally {
    /*
     * 用完必须卸载：Genie 每次 load_character 都会新加载一份 ONNX 模型（几百 MB），
     * 不卸载的话连着试听几次服务就会 OOM，之后 /tts 返回空流（试听没声音、合成空音频）。
     */
    await engine.unloadCharacter(name);
  }
}
