/*
 * SPDX-License-Identifier: GPL-3.0-only
 * Copyright (c) 2026 宝螺 / Baoluo contributors
 * 本文件属于「宝螺 / Baoluo」。除 GPL-3.0 外还适用 ADDITIONAL_TERMS.md 里的附加条款：
 * 分发时须保留来源署名；修改版对外分发时不得沿用「宝螺」名称与图标。
 */
import { contextBridge, ipcRenderer, webUtils } from "electron";
import type {
  AppSettings,
  CloneVoice,
  ComposeProgress,
  ComposeRequest,
  ComposeSnapshot,
  DialogueLine,
  DialogueSettings,
  LocalTtsEnv,
  LocalTtsProgress,
  LocalTtsStatus,
  LocalTtsTaskResult,
  LocalTtsTaskSnapshot,
  TemplateConfig,
  VideoMode,
  VoiceConvertProgress,
  VoiceConvertRequest,
  VoiceConvertResult,
} from "../shared/dialogue-types";
import type {
  HotItem,
  HotSource,
  Storyboard,
  StoryboardSummary,
  StoryGenerateRequest,
  StoryProgress,
} from "../shared/storyboard-types";
import type {
  AgentCreateResult,
  AgentProgress,
  AgentTask,
} from "../shared/agent-types";
import type {
  SniffProgress,
  SniffRecord,
  SniffRunRequest,
} from "../shared/sniff-types";
import type { ImageProviderInfo } from "../shared/image-providers";
import type {
  BatchState,
  BatchStartResult,
  GenerateShotResult,
} from "../shared/image-batch-types";
import type {
  WorkRecord,
  WorkRecordKind,
  WorkRecordSaveRequest,
  WorkRecordSummary,
} from "../shared/record-types";

export type {
  VoiceConvertProgress,
  VoiceConvertResult,
} from "../shared/dialogue-types";

export interface TranscribeProgress {
  requestId?: string;
  stage:
    | "model-download-start"
    | "model-download"
    | "model-download-done"
    | "extract-audio"
    | "transcribe-start"
    | "transcribe-line"
    | "transcribe-done";
  received?: number;
  total?: number;
  percent?: number;
  line?: string;
}

export interface TranscribeResult {
  text: string;
  segments: Array<{ start: number; end: number; text: string }>;
}

const baoluoApi = {
  transcribe: {
    isModelReady: (): Promise<boolean> =>
      ipcRenderer.invoke("transcribe:isModelReady"),
    run: (params: {
      videoPath: string;
      requestId?: string;
      language?: string;
    }): Promise<TranscribeResult> => ipcRenderer.invoke("transcribe:run", params),
    onProgress: (cb: (p: TranscribeProgress) => void) => {
      const listener = (_e: unknown, p: TranscribeProgress) => cb(p);
      ipcRenderer.on("transcribe:progress", listener);
      return () => ipcRenderer.removeListener("transcribe:progress", listener);
    },
  },
  /** 诊断日志位置与打开所在目录（「关于」页用） */
  logInfo: (): Promise<{ dir: string; file: string }> => ipcRenderer.invoke("app:logInfo"),
  openLogDir: (): Promise<{ ok: boolean; error?: string }> =>
    ipcRenderer.invoke("app:openLogDir"),
};

/** 本工具不解析、不下载平台视频：只处理用户已有的本地文件。 */

const dialogueApi = {
  parse: (
    text: string,
    opts?: { mode?: VideoMode; imageCount?: number }
  ): Promise<{ lines: DialogueLine[]; warnings: string[] }> =>
    ipcRenderer.invoke("dialogue:parse", text, opts),

  getSettings: (): Promise<DialogueSettings> =>
    ipcRenderer.invoke("dialogue:getSettings"),

  /** 内置对话模板（应用自带、只能用不能改）：模板库列表显示它，应用时读它的配置 */
  builtinTemplate: (): Promise<{
    id: string;
    title: string;
    subtitle: string;
    payload: TemplateConfig;
  }> => ipcRenderer.invoke("dialogue:builtinTemplate"),
  saveSettings: (s: DialogueSettings): Promise<DialogueSettings> =>
    ipcRenderer.invoke("dialogue:saveSettings", s),

  /*
   * AI 服务商辅助：拉模型列表 / 测试连接。
   * 传的是表单当前值（未保存也行），主进程不落盘。
   */
  aiListModels: (s: { apiKey: string; baseUrl: string; model: string }): Promise<{
    ok: boolean;
    models: string[];
    error?: string;
  }> => ipcRenderer.invoke("ai:listModels", s),
  aiTest: (s: { apiKey: string; baseUrl: string; model: string }): Promise<{
    ok: boolean;
    reply?: string;
    error?: string;
  }> => ipcRenderer.invoke("ai:test", s),

  /** 按主题让 AI 写一段甲方/乙方对话脚本（返回纯文本，一行一句） */
  writeScript: (req: {
    topic: string;
    transcript?: string;
    durationSeconds?: number;
  }): Promise<string> => ipcRenderer.invoke("dialogue:writeScript", req),

  chooseImage: (currentPath: string | null): Promise<string | null> =>
    ipcRenderer.invoke("dialogue:chooseImage", currentPath),
  chooseOutputDir: (currentPath: string | null): Promise<string | null> =>
    ipcRenderer.invoke("dialogue:chooseOutputDir", currentPath),
  defaultOutputDir: (): Promise<string> =>
    ipcRenderer.invoke("dialogue:defaultOutputDir"),
  openOutputDir: (): Promise<{ ok: boolean; path: string; error?: string }> =>
    ipcRenderer.invoke("dialogue:openOutputDir"),
  showInFolder: (filePath: string): Promise<{ ok: boolean; error?: string }> =>
    ipcRenderer.invoke("dialogue:showInFolder", filePath),

  runCompose: (req: ComposeRequest & { requestId?: string }) =>
    ipcRenderer.invoke("dialogue:runCompose", req),

  /** 真人解说：把录好的音频落盘（转码 mp3），返回绝对路径 + 主进程探测的时长（秒） */
  saveRecording: (buf: ArrayBuffer): Promise<{ path: string; durationSec: number }> =>
    ipcRenderer.invoke("dialogue:saveRecording", buf),
  /** 重录/清除时回收录音文件 */
  deleteRecording: (filePath: string): Promise<void> =>
    ipcRenderer.invoke("dialogue:deleteRecording", filePath),
  /** 探测录音时长（秒，读不出 0）：老录音没记时长时的兜底 */
  audioDuration: (filePath: string): Promise<number> =>
    ipcRenderer.invoke("dialogue:audioDuration", filePath),
  /** 「生成字幕」：把录音交给本地 Whisper 识别成解说词（不广播进度） */
  transcribeAudio: (filePath: string): Promise<TranscribeResult> =>
    ipcRenderer.invoke("dialogue:transcribeAudio", filePath),
  cancelCompose: (requestId: string): Promise<void> =>
    ipcRenderer.invoke("dialogue:cancelCompose", requestId),
  /**
   * 合成的现状（在跑 / 刚跑完 / 失败）。
   * 界面切任务卡或切页会卸载重挂，广播会错过——挂载时用它把进度和成片入口接回来。
   */
  composeState: (): Promise<ComposeSnapshot | null> =>
    ipcRenderer.invoke("dialogue:composeState"),
  previewVoice: (req: {
    voice: string;
    rate?: number;
    pitch?: number;
    volume?: number;
    text?: string;
  }): Promise<{ path: string }> => ipcRenderer.invoke("dialogue:previewVoice", req),

  onComposeProgress: (cb: (p: ComposeProgress) => void) => {
    const listener = (_e: unknown, p: ComposeProgress) => cb(p);
    ipcRenderer.on("dialogue:progress", listener);
    return () => ipcRenderer.removeListener("dialogue:progress", listener);
  },
};

/** v0.5.0 热点成片：热点榜 + AI 分镜 + 草稿工作台 */
const storyboardApi = {
  hotSources: (): Promise<HotSource[]> => ipcRenderer.invoke("hot:sources"),
  hotList: (source: string): Promise<HotItem[]> => ipcRenderer.invoke("hot:list", source),
  generate: (req: StoryGenerateRequest): Promise<Storyboard> =>
    ipcRenderer.invoke("story:generate", req),
  /** 中止正在跑的分镜生成（generate 的进度事件里会带回 requestId） */
  cancelGenerate: (requestId: string): Promise<void> =>
    ipcRenderer.invoke("story:cancelGenerate", requestId),
  regeneratePrompt: (req: { boardId: string; shotId: string }): Promise<Storyboard> =>
    ipcRenderer.invoke("story:regeneratePrompt", req),
  list: (): Promise<StoryboardSummary[]> => ipcRenderer.invoke("story:list"),
  get: (id: string): Promise<Storyboard> => ipcRenderer.invoke("story:get", id),
  save: (sb: Storyboard): Promise<Storyboard> => ipcRenderer.invoke("story:save", sb),
  remove: (id: string): Promise<void> => ipcRenderer.invoke("story:delete", id),
  chooseImage: (currentPath: string | null): Promise<string | null> =>
    ipcRenderer.invoke("story:chooseImage", currentPath),
  attachImage: (req: { boardId: string; shotId: string; srcPath: string }): Promise<Storyboard> =>
    ipcRenderer.invoke("story:attachImage", req),
  openDir: (id: string): Promise<{ ok: boolean; path: string; error?: string }> =>
    ipcRenderer.invoke("story:openDir", id),
  onProgress: (cb: (p: StoryProgress) => void): (() => void) => {
    const listener = (_e: unknown, p: StoryProgress) => cb(p);
    ipcRenderer.on("story:progress", listener);
    return () => ipcRenderer.removeListener("story:progress", listener);
  },
};

const settingsApi = {
  get: (): Promise<AppSettings> => ipcRenderer.invoke("settings:getApp"),
  update: (patch: Partial<AppSettings>): Promise<AppSettings> =>
    ipcRenderer.invoke("settings:updateApp", patch),
};

/**
 * 作品记录：图文解说 / 对话模式 / 爆款嗅探 左侧那个历史列表。
 * 列表只要摘要，点开某一条才去 get 整份内容。
 */
const recordsApi = {
  list: (kind: WorkRecordKind): Promise<WorkRecordSummary[]> =>
    ipcRenderer.invoke("records:list", kind),
  get: <T = unknown>(kind: WorkRecordKind, id: string): Promise<WorkRecord<T> | null> =>
    ipcRenderer.invoke("records:get", { kind, id }),
  save: (req: WorkRecordSaveRequest): Promise<WorkRecord> =>
    ipcRenderer.invoke("records:save", req),
  remove: (kind: WorkRecordKind, id: string): Promise<void> =>
    ipcRenderer.invoke("records:remove", { kind, id }),
};
export type RecordsApi = typeof recordsApi;

/**
 * 生图引擎状态：当前用的是哪个引擎、能不能开跑、缺什么。
 * 判断逻辑只留在主进程（跟实际分派必须一致），界面只负责显示这句话。
 */
const imageApi = {
  providerInfo: (): Promise<ImageProviderInfo> => ipcRenderer.invoke("image:providerInfo"),
  generateShot: (req: { boardId: string; shotId: string }): Promise<GenerateShotResult> =>
    ipcRenderer.invoke("image:generateShot", req),
  startBatch: (req: { boardId: string }): Promise<BatchStartResult> =>
    ipcRenderer.invoke("image:startBatch", req),
  cancelBatch: (): Promise<BatchState> => ipcRenderer.invoke("image:cancelBatch"),
  getBatchState: (): Promise<BatchState> => ipcRenderer.invoke("image:getBatchState"),
  /** 批量生图进度广播（主进程 → 渲染层），队列在主进程跑、切页面也不中断 */
  onBatchProgress: (cb: (s: BatchState) => void): (() => void) => {
    const listener = (_e: unknown, s: BatchState) => cb(s);
    ipcRenderer.on("image:batchProgress", listener);
    return () => ipcRenderer.removeListener("image:batchProgress", listener);
  },
};

/** 数据目录（模型/运行时都在这里，可换到别的盘） */
export interface DataDirProgress {
  copied: number;
  total: number;
  bytes: number;
  percent: number;
  file: string;
}

const dataDirApi = {
  get: (): Promise<{
    current: string;
    defaultDir: string;
    isCustom: boolean;
    sizeBytes: number;
  }> => ipcRenderer.invoke("data-dir:get"),
  choose: (currentPath?: string): Promise<string | null> =>
    ipcRenderer.invoke("data-dir:choose", currentPath),
  /** 复制数据到新目录并切换（move=true 时复制成功后会清空旧目录） */
  migrate: (req: {
    target: string;
    move?: boolean;
  }): Promise<{
    copied: number;
    bytes: number;
    skippedCount: number;
    failedClearCount: number;
    current: string;
  }> => ipcRenderer.invoke("data-dir:migrate", req),
  /** 重启应用；开发模式下主进程不会真重启（会把 vite 带走），返回 { dev: true } */
  relaunch: (): Promise<{ dev: boolean }> => ipcRenderer.invoke("app:relaunch"),
  onProgress: (cb: (p: DataDirProgress) => void) => {
    const listener = (_e: unknown, p: DataDirProgress) => cb(p);
    ipcRenderer.on("data-dir:progress", listener);
    return () => ipcRenderer.removeListener("data-dir:progress", listener);
  },
};

const voiceApi = {
  synth: (params: {
    text: string;
    voice: string;
    rate?: number;
    pitch?: number;
    volume?: number;
  }): Promise<{ path: string }> => ipcRenderer.invoke("voice:synth", params),
  saveMp3: (srcPath: string): Promise<string | null> =>
    ipcRenderer.invoke("voice:saveMp3", srcPath),
};

const asrApi = {
  chooseFile: (): Promise<string | null> => ipcRenderer.invoke("asr:chooseFile"),
  isModelReady: (): Promise<boolean> => ipcRenderer.invoke("transcribe:isModelReady"),
  run: (params: {
    videoPath: string;
    requestId?: string;
    language?: string;
  }): Promise<TranscribeResult> => ipcRenderer.invoke("transcribe:run", params),
  cancel: (requestId: string): Promise<void> =>
    ipcRenderer.invoke("transcribe:cancel", requestId),
  onProgress: (cb: (p: TranscribeProgress) => void) => {
    const listener = (_e: unknown, p: TranscribeProgress) => cb(p);
    ipcRenderer.on("transcribe:progress", listener);
    return () => ipcRenderer.removeListener("transcribe:progress", listener);
  },
  saveText: (text: string): Promise<string | null> =>
    ipcRenderer.invoke("asr:saveText", { text }),
};

const localTtsApi = {
  status: (): Promise<LocalTtsStatus> => ipcRenderer.invoke("local-tts:status"),
  env: (): Promise<LocalTtsEnv> => ipcRenderer.invoke("local-tts:env"),
  /** 后台任务快照（不起子进程，可高频轮询） */
  task: (): Promise<LocalTtsTaskSnapshot> => ipcRenderer.invoke("local-tts:task"),
  /** 开始下载：立即受理返回，进度看 onProgress、结局看 onTaskDone */
  download: (characterKey?: string): Promise<void> =>
    ipcRenderer.invoke("local-tts:download", characterKey),
  cancelDownload: (): Promise<void> => ipcRenderer.invoke("local-tts:cancelDownload"),
  deleteModel: (key: string): Promise<LocalTtsEnv> =>
    ipcRenderer.invoke("local-tts:deleteModel", key),
  start: (): Promise<LocalTtsEnv> => ipcRenderer.invoke("local-tts:start"),
  disable: (): Promise<LocalTtsEnv> => ipcRenderer.invoke("local-tts:disable"),
  chooseAudio: (): Promise<string | null> => ipcRenderer.invoke("local-tts:chooseAudio"),
  save: (v: {
    id?: string;
    name: string;
    modelDir: string;
    audioPath: string;
    audioText: string;
    language: string;
  }): Promise<CloneVoice[]> => ipcRenderer.invoke("local-tts:save", v),
  remove: (id: string): Promise<CloneVoice[]> =>
    ipcRenderer.invoke("local-tts:delete", id),
  preview: (req: { voice: CloneVoice; text?: string }): Promise<{ path: string }> =>
    ipcRenderer.invoke("local-tts:preview", req),
  onProgress: (cb: (p: LocalTtsProgress) => void) => {
    const listener = (_e: unknown, p: LocalTtsProgress) => cb(p);
    ipcRenderer.on("local-tts:progress", listener);
    return () => ipcRenderer.removeListener("local-tts:progress", listener);
  },
  /** 后台下载的结局（完成/取消/失败）；任何页面都能收到 */
  onTaskDone: (cb: (r: LocalTtsTaskResult) => void) => {
    const listener = (_e: unknown, r: LocalTtsTaskResult) => cb(r);
    ipcRenderer.on("local-tts:taskDone", listener);
    return () => ipcRenderer.removeListener("local-tts:taskDone", listener);
  },
};

/**
 * 变声器（方案 A：识别原音频文案 → 用指定音色重新配音）。
 * 与「语音合成」的区别：输入是音频/视频而不是文字。
 */
const voiceConvertApi = {
  chooseFile: (): Promise<string | null> =>
    ipcRenderer.invoke("voice-convert:chooseFile"),
  run: (req: VoiceConvertRequest): Promise<VoiceConvertResult> =>
    ipcRenderer.invoke("voice-convert:run", req),
  cancel: (requestId: string): Promise<void> =>
    ipcRenderer.invoke("voice-convert:cancel", requestId),
  /** 保存结果：选 mp3 会转码，选 wav 直接复制 */
  saveAudio: (srcPath: string): Promise<string | null> =>
    ipcRenderer.invoke("voice-convert:saveAudio", srcPath),
  /** 在资源管理器里定位结果文件 */
  showInFolder: (filePath: string): Promise<{ ok: boolean; error?: string }> =>
    ipcRenderer.invoke("dialogue:showInFolder", filePath),
  onProgress: (cb: (p: VoiceConvertProgress) => void) => {
    const listener = (_e: unknown, p: VoiceConvertProgress) => cb(p);
    ipcRenderer.on("voice-convert:progress", listener);
    return () => ipcRenderer.removeListener("voice-convert:progress", listener);
  },
};

/** 爆款嗅探：本地音视频 → 转写 → AI 拆解（一次性，服务端不保存任何记录） */
const sniffApi = {
  run: (req: SniffRunRequest): Promise<SniffRecord> =>
    ipcRenderer.invoke("sniff:run", req),
  onProgress: (cb: (p: SniffProgress) => void): (() => void) => {
    const listener = (_e: unknown, p: SniffProgress) => cb(p);
    ipcRenderer.on("sniff:progress", listener);
    return () => ipcRenderer.removeListener("sniff:progress", listener);
  },
};

/** 工作台（agent 模式）：一句话 → 任务卡 → 逐步执行 */
const agentApi = {
  create: (instruction: string, hot?: HotItem): Promise<AgentCreateResult> =>
    ipcRenderer.invoke("agent:create", instruction, hot),
  list: (): Promise<AgentTask[]> => ipcRenderer.invoke("agent:list"),
  get: (id: string): Promise<AgentTask | null> => ipcRenderer.invoke("agent:get", id),
  remove: (id: string): Promise<void> => ipcRenderer.invoke("agent:remove", id),
  updateParams: (req: {
    taskId: string;
    stepId: string;
    params: Array<{ key: string; value: string }>;
  }): Promise<AgentTask> => ipcRenderer.invoke("agent:updateParams", req),
  run: (req: { taskId: string; stepId?: string }): Promise<AgentTask> =>
    ipcRenderer.invoke("agent:run", req),
  /** 记中间状态（分镜工作台把方案 id 写回任务，下次打开续上） */
  patchState: (req: {
    taskId: string;
    patch: { storyboardId?: string; hotRanAt?: number };
  }): Promise<AgentTask> => ipcRenderer.invoke("agent:patchState", req),
  cancel: (taskId: string): Promise<boolean> => ipcRenderer.invoke("agent:cancel", taskId),
  chooseFile: (req: { kind: "image" | "media"; currentPath?: string }): Promise<string | null> =>
    ipcRenderer.invoke("agent:chooseFile", req),
  openPath: (p: string): Promise<void> => ipcRenderer.invoke("agent:openPath", p),
  onProgress: (cb: (p: AgentProgress) => void): (() => void) => {
    const listener = (_e: unknown, p: AgentProgress) => cb(p);
    ipcRenderer.on("agent:progress", listener);
    return () => ipcRenderer.removeListener("agent:progress", listener);
  },
};

contextBridge.exposeInMainWorld("baoluo", baoluoApi);
contextBridge.exposeInMainWorld("media", {
  toUrl: (p: string): Promise<string> => ipcRenderer.invoke("media:toUrl", p),
  filePath: (file: File): string => webUtils.getPathForFile(file),
});
contextBridge.exposeInMainWorld("dialogue", dialogueApi);
contextBridge.exposeInMainWorld("storyboard", storyboardApi);
contextBridge.exposeInMainWorld("settings", settingsApi);
contextBridge.exposeInMainWorld("records", recordsApi);
contextBridge.exposeInMainWorld("image", imageApi);
contextBridge.exposeInMainWorld("dataDir", dataDirApi);
contextBridge.exposeInMainWorld("voice", voiceApi);
contextBridge.exposeInMainWorld("asr", asrApi);
contextBridge.exposeInMainWorld("localTts", localTtsApi);
contextBridge.exposeInMainWorld("voiceConvert", voiceConvertApi);
contextBridge.exposeInMainWorld("sniff", sniffApi);
contextBridge.exposeInMainWorld("agent", agentApi);

export type BaoluoApi = typeof baoluoApi;
export type DialogueApi = typeof dialogueApi;
export type StoryboardApi = typeof storyboardApi;

export interface MediaApi {
  toUrl: (filePath: string) => Promise<string>;
  filePath: (file: File) => string;
}

export type SettingsApi = typeof settingsApi;
export type ImageApi = typeof imageApi;
export type DataDirApi = typeof dataDirApi;
export type VoiceApi = typeof voiceApi;
export type AsrApi = typeof asrApi;
export type LocalTtsApi = typeof localTtsApi;
export type VoiceConvertApi = typeof voiceConvertApi;
export type SniffApi = typeof sniffApi;
export type AgentApi = typeof agentApi;
