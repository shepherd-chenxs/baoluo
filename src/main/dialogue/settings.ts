/*
 * SPDX-License-Identifier: GPL-3.0-only
 * Copyright (c) 2026 宝螺 / Baoluo contributors
 * 本文件属于「宝螺 / Baoluo」。除 GPL-3.0 外还适用 ADDITIONAL_TERMS.md 里的附加条款：
 * 分发时须保留来源署名；修改版对外分发时不得沿用「宝螺」名称与图标。
 */
/**
 * settings — 读写通用 settings.json（userData 下）。
 *
 * 结构按分区命名，方便后续扩展：
 *   {
 *     "dialogue": { ...DialogueSettings },   // 对话视频相关（音色/字幕/AI）
 *     "app":      { ... }                     // 预留：全局设置
 *   }
 *
 * 兼容迁移：
 *   1) 旧版扁平文件 %APPDATA%/Baoluo/dialogue-settings.json
 *
 * 注意：不再从应用安装目录（app.getAppPath()）读取 settings.json —— 那条路径会把
 * 仓库/安装目录里误放的配置文件（可能含 API Key）吞进用户数据，属于不该保留的口子。
 */
import { app } from "electron";
import fs from "node:fs";
import path from "node:path";
import type { AppSettings, DialogueSettings, SubtitleSettings } from "../../shared/dialogue-types";
import {
  DEFAULT_AI,
  DEFAULT_LOCAL_TTS_HOST,
  DEFAULT_LOCAL_TTS_PORT,
  DEFAULT_PROSODY,
  DEFAULT_SUBTITLE,
  DEFAULT_VOICE_NARRATOR,
} from "../../shared/settings-defaults";

const DEFAULT_SETTINGS: DialogueSettings = {
  ...DEFAULT_AI,
  voiceFortune: "zh-CN-YunjianNeural",
  voiceCustomer: "zh-CN-XiaoxiaoNeural",
  voiceNarrator: DEFAULT_VOICE_NARRATOR,
  narratorCount: 2,
  prosody: DEFAULT_PROSODY,
  subtitle: DEFAULT_SUBTITLE,
};

interface AppSettingsFile {
  dialogue: DialogueSettings;
  app: Record<string, unknown>;
}

let cached: AppSettingsFile | null = null;

function settingsPath(): string {
  return path.join(app.getPath("userData"), "settings.json");
}

/** 旧版扁平结构文件（一次性迁移） */
function legacyDialogueSettingsPath(): string {
  return path.join(app.getPath("userData"), "dialogue-settings.json");
}

function mergeDialogue(raw: unknown): DialogueSettings {
  const r = (raw ?? {}) as Partial<DialogueSettings>;
  return {
    ...DEFAULT_SETTINGS,
    ...r,
    /*
     * aiKeys：每家服务商一份 key。整体覆盖式合并（键值对简单，不需要逐键合并）；
     * 旧配置没有该字段 → 空对象，渲染进程首次进设置页会把原 apiKey 归到识别出的服务商名下。
     */
    aiKeys: { ...(r.aiKeys ?? {}) },
    narratorCount: r.narratorCount === 1 ? 1 : 2,
    prosody: {
      a: { ...DEFAULT_PROSODY.a, ...(r.prosody?.a ?? {}) },
      b: { ...DEFAULT_PROSODY.b, ...(r.prosody?.b ?? {}) },
      narrator: { ...DEFAULT_PROSODY.narrator, ...(r.prosody?.narrator ?? {}) },
    },
    subtitle: { ...DEFAULT_SETTINGS.subtitle, ...(r.subtitle ?? {}) },
  };
}

function persist(s: AppSettingsFile) {
  const p = settingsPath();
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, JSON.stringify(s, null, 2), "utf-8");
}

function loadFile(): AppSettingsFile {
  // 1) 新版 settings.json
  const p = settingsPath();
  if (fs.existsSync(p)) {
    try {
      const raw = JSON.parse(fs.readFileSync(p, "utf-8")) as Partial<AppSettingsFile>;
      if (raw && typeof raw === "object" && raw.dialogue) {
        return { dialogue: mergeDialogue(raw.dialogue), app: raw.app ?? {} };
      }
    } catch {
      /* 文件损坏时继续走迁移/默认 */
    }
  }

  // 2) 旧版扁平 dialogue-settings.json
  const old = legacyDialogueSettingsPath();
  if (fs.existsSync(old)) {
    try {
      const raw = JSON.parse(fs.readFileSync(old, "utf-8"));
      const migrated: AppSettingsFile = { dialogue: mergeDialogue(raw), app: {} };
      persist(migrated);
      return migrated;
    } catch {
      /* noop */
    }
  }

  const fresh: AppSettingsFile = { dialogue: DEFAULT_SETTINGS, app: {} };
  persist(fresh);
  return fresh;
}

export function getSettings(): DialogueSettings {
  if (!cached) cached = loadFile();
  return cached.dialogue;
}

export function saveSettings(s: DialogueSettings): DialogueSettings {
  if (!cached) cached = loadFile();
  cached.dialogue = mergeDialogue(s);
  persist(cached);
  return cached.dialogue;
}

export function updateSettings(patch: Partial<DialogueSettings>): DialogueSettings {
  return saveSettings({ ...getSettings(), ...patch });
}

export function updateSubtitle(patch: Partial<SubtitleSettings>): DialogueSettings {
  const cur = getSettings();
  return saveSettings({
    ...cur,
    subtitle: { ...cur.subtitle, ...patch },
  });
}

export function getAppSettings(): AppSettings {
  if (!cached) cached = loadFile();
  return (cached.app ?? {}) as AppSettings;
}

export function updateAppSettings(patch: Partial<AppSettings>): AppSettings {
  if (!cached) cached = loadFile();
  const nextApp: Record<string, unknown> = { ...(cached.app ?? {}) };
  if ("outputDir" in patch) {
    if (patch.outputDir && patch.outputDir.trim()) {
      nextApp.outputDir = patch.outputDir.trim();
    } else {
      delete nextApp.outputDir;
    }
  }

  if (patch.savedTemplates) {
    nextApp.savedTemplates = patch.savedTemplates;
  }
  /*
   * 默认模板（工作台建对话卡时套用）：空串/未给 = 取消默认，删键回到"按设置默认值来"。
   * 注意这里必须显式处理——本函数是逐字段白名单，漏掉就会被静默丢弃（踩过）。
   */
  if ("defaultTemplateId" in patch) {
    const id = String(patch.defaultTemplateId ?? "").trim();
    if (id) nextApp.defaultTemplateId = id;
    else delete nextApp.defaultTemplateId;
  }
  if (Array.isArray(patch.favoriteVoices)) {
    nextApp.favoriteVoices = [...patch.favoriteVoices];
  }
  if (patch.localTts) {
    nextApp.localTts = {
      host: String(patch.localTts.host ?? DEFAULT_LOCAL_TTS_HOST).trim() || DEFAULT_LOCAL_TTS_HOST,
      port: Math.max(1, Math.min(65535, Math.floor(+patch.localTts.port || DEFAULT_LOCAL_TTS_PORT))),
    };
  }
  if (Array.isArray(patch.cloneVoices)) {
    nextApp.cloneVoices = patch.cloneVoices.map((v) => ({ ...v }));
  }
  /*
   * 生图引擎：这里必须**显式落盘**。
   * 值的合法性也在这里收口：认不出来的值一律存成 modelscope，
   * 免得配置文件被手改成乱七八糟的字符串后，主进程分派层到处判空。
   */
  if ("imageProvider" in patch) {
    nextApp.imageProvider = "modelscope";
  }
  /*
   * ModelScope 配置：三项都可空。
   * 全空就把整个键删掉（别留一个空对象在配置里），有值才存，顺带 trim。
   */
  if ("modelscopeImage" in patch) {
    const m = (patch.modelscopeImage ?? {}) as { token?: string; model?: string; size?: string };
    const next: Record<string, string> = {};
    const token = String(m.token ?? "").trim();
    const model = String(m.model ?? "").trim();
    const size = String(m.size ?? "").trim();
    if (token) next.token = token;
    if (model) next.model = model;
    if (size) next.size = size;
    if (Object.keys(next).length) nextApp.modelscopeImage = next;
    else delete nextApp.modelscopeImage;
  }
  cached.app = nextApp;
  persist(cached);
  return cached.app as AppSettings;
}
