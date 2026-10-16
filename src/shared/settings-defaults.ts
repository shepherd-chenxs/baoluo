/*
 * SPDX-License-Identifier: GPL-3.0-only
 * Copyright (c) 2026 宝螺 / Baoluo contributors
 * 本文件属于「宝螺 / Baoluo」。除 GPL-3.0 外还适用 ADDITIONAL_TERMS.md 里的附加条款：
 * 分发时须保留来源署名；修改版对外分发时不得沿用「宝螺」名称与图标。
 */
import type { SubtitleSettings, VoiceProsody } from "./dialogue-types";

export const DEFAULT_SUBTITLE: SubtitleSettings = {
  fontSize: 50,
  positionPct: 0.85,
  color: "#FFFFFF",
  /** 默认不画字幕底色（"transparent" = 无色） */
  backgroundColor: "transparent",
  backgroundOpacity: 0,
};

export const DEFAULT_AI = {
  apiKey: "",
  baseUrl: "https://api.deepseek.com/v1",
  model: "deepseek-chat",
};

/** 单图/多图模式的解说员音色默认值 */
export const DEFAULT_VOICE_NARRATOR = "zh-CN-YunxiNeural";

/** 本地声音克隆服务（Genie-TTS）固定地址：高位端口，基本不会与常用服务冲突 */
export const DEFAULT_LOCAL_TTS_HOST = "127.0.0.1";
export const DEFAULT_LOCAL_TTS_PORT = 45231;

const defaultProsody: VoiceProsody = { rate: 0, pitch: 0, volume: 0 };

export const DEFAULT_PROSODY = {
  a: { ...defaultProsody },
  b: { ...defaultProsody },
  narrator: { ...defaultProsody },
};
