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
