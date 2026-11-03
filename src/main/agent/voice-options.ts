/**
 * 音色下拉选项：常用在线音色 + 用户克隆好的音色。
 * 工作台的「合成」「变声」这些步骤共用一份，免得两处各写一遍。
 */
import type { AgentParam } from "../../shared/agent-types";
import { VOICE_OPTIONS } from "../../shared/voices";
import * as settings from "../dialogue/settings";

export function voiceOptions(): AgentParam["options"] {
  const clones = settings.getAppSettings().cloneVoices ?? [];
  return [
    ...VOICE_OPTIONS,
    ...clones.map((c) => ({ value: `clone:${c.id}`, label: `克隆·${c.name}` })),
  ];
}
