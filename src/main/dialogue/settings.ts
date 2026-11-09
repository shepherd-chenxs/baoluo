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
 *   1) 旧版扁平文件 %APPDATA%/Baoluo/dialogue-settings.json（含从 XiaoMiFeng/bee 迁移来的）
 *   2) laodeng 原版项目内 settings.json
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
import { ALL_PLUGIN_KEYS, isPluginKey } from "../../shared/plugins";
import { normalizePrefs, type RuntimeId, type RuntimePrefs } from "../../shared/runtime-types";

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

/** laodeng 原版默认项目内 settings.json —— 仅在开发期或源码目录可访问，用于迁移 */
function legacySettingsPathCandidates(): string[] {
  return [
    path.join(app.getAppPath(), "settings.json"),
    path.join(app.getPath("documents"), "laodeng", "settings.json"),
  ];
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

  // 3) laodeng 原版 settings.json
  for (const cand of legacySettingsPathCandidates()) {
    if (fs.existsSync(cand)) {
      try {
        const raw = JSON.parse(fs.readFileSync(cand, "utf-8"));
        const migrated: AppSettingsFile = { dialogue: mergeDialogue(raw), app: {} };
        persist(migrated);
        return migrated;
      } catch {
        break;
      }
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

/**
 * 「生图时自动发送」是否开着（T-004 标准 1）。
 *
 * 已固定开启：设置页去掉了这个开关，老配置里显式关过的（落盘 false）也按开处理。
 */
export function isAutoSubmitImageEnabled(): boolean {
  return true;
}

/**
 * 运行时偏好表（每个运行时各一份模型/权限）：只留认得的运行时 + 合法字段。
 * 手改配置文件写坏了也不至于让对话区崩掉——认不出的值一律回到默认。
 */
function normalizeRuntimePrefs(
  raw: Partial<Record<string, Partial<RuntimePrefs>>> | undefined
): Partial<Record<RuntimeId, RuntimePrefs>> | null {
  if (!raw || typeof raw !== "object") return null;
  const out: Partial<Record<RuntimeId, RuntimePrefs>> = {};
  for (const id of ["codex", "claude", "gemini"] as RuntimeId[]) {
    const one = raw[id];
    if (one && typeof one === "object") out[id] = normalizePrefs(one);
  }
  return Object.keys(out).length ? out : null;
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

  if ("materialsDir" in patch) {
    if (patch.materialsDir && patch.materialsDir.trim()) {
      nextApp.materialsDir = patch.materialsDir.trim();
    } else {
      delete nextApp.materialsDir;
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
   * 生图自动发送：这里必须**显式落盘 true**，不能用「假就删键」的写法。
   * 该键的默认值是 true（见 isAutoSubmitImageEnabled），删键等于又变回开，
   * 用户关掉的开关会在重启后自己弹回来。
   */
  if ("autoSubmitImage" in patch) {
    nextApp.autoSubmitImage = patch.autoSubmitImage === true;
  }
  /*
   * 生图引擎：这里必须**显式落盘**（同 autoSubmitImage 的道理）。
   * 值的合法性也在这里收口：认不出来的值一律存成 doubao，
   * 免得配置文件被手改成乱七八糟的字符串后，主进程分派层到处判空。
   */
  if ("imageProvider" in patch) {
    nextApp.imageProvider = patch.imageProvider === "modelscope" ? "modelscope" : "doubao";
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
  /*
   * 集成运行时（设置 → 运行时）：**只存一个 id**，应用新的就覆盖旧的。
   * 传空/null = 取消应用 —— 界面只在"已应用的那个已经从本机卸载了"时才给这个口子，
   * 正常切换不需要先取消（切新的即等于取消旧的）。
   */
  if ("runtime" in patch) {
    const id = patch.runtime?.activeId;
    if (id === "codex" || id === "claude" || id === "gemini") {
      // 偏好按运行时分开存；没传就沿用文件里已有的那份（换运行时不该丢上一个人的设置）
      const prevPrefs = (nextApp.runtime ?? {}) as {
        prefs?: Partial<Record<RuntimeId, Partial<RuntimePrefs>>>;
      };
      const prefs = normalizeRuntimePrefs(patch.runtime?.prefs ?? prevPrefs.prefs);
      nextApp.runtime = prefs ? { activeId: id, prefs } : { activeId: id };
    } else {
      delete nextApp.runtime;
    }
  }
  // 豆包生图当日用量（日期 + 张数），跨天归零由 doubao-quota 负责
  if (patch.doubaoGenDaily) {
    nextApp.doubaoGenDaily = {
      date: String(patch.doubaoGenDaily.date ?? "").slice(0, 10),
      count: Math.max(0, Math.floor(Number(patch.doubaoGenDaily.count) || 0)),
    };
  }
  /*
   * 插件安装列表（shared/plugins.ts）：**空数组是合法值**（全卸），不能当 falsy 丢掉。
   * 只收认得的 key，脏数据直接滤掉；没传这个字段就不动它（= 老配置继续全装）。
   */
  if ("installedPlugins" in patch) {
    const raw = patch.installedPlugins;
    nextApp.installedPlugins = Array.isArray(raw)
      ? [...new Set(raw.map(String).filter((k) => isPluginKey(k)))]
      : [];
    /*
     * 同时把「这次写盘时认识的全部 key」记下来（不是界面上传的，所以不放进白名单判断）。
     * 以后版本新增插件 key 时，它不在这份名单里 → 读配置时会被当作新插件自动装上；
     * 而用户卸掉的 key 早就在名单中，不会被装回来。
     */
    nextApp.knownPlugins = [...ALL_PLUGIN_KEYS];
  }
  cached.app = nextApp;
  persist(cached);
  return cached.app as AppSettings;
}
