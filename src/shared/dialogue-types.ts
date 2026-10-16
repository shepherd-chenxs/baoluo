/*
 * SPDX-License-Identifier: GPL-3.0-only
 * Copyright (c) 2026 宝螺 / Baoluo contributors
 * 本文件属于「宝螺 / Baoluo」。除 GPL-3.0 外还适用 ADDITIONAL_TERMS.md 里的附加条款：
 * 分发时须保留来源署名；修改版对外分发时不得沿用「宝螺」名称与图标。
 */
/**
 * 前后端共享的"对话视频生成"业务类型。
 * 主进程 IPC contract 与 renderer 通过这套类型对齐。
 */
import type { ImageProviderKey } from "./image-providers";

/** 对话角色：a=第一个说话人，b=第二个说话人；unknown=无法归属 */
export type SpeakerType = "a" | "b" | "unknown";

/** 视频生成模式：narration=解说（一图或多图，解说员配音），dialogue=双人对话 */
export type VideoMode = "narration" | "dialogue";

/** 画布方向 */
export type VideoResolution = "landscape" | "portrait";

/** 图片适配方式 */
export type ImageFit = "contain" | "cover";

/** 画面运镜模式 */
export type MotionMode = "none" | "zoom-in" | "zoom-out" | "pan-left" | "pan-right";

/** 一组运镜配置 */
export interface MotionConfig {
  mode: MotionMode;
  amount: number;
}

/** 多图模式的一个场景：一张图片 + 一段解说文本 */
export interface DialogueImageScene {
  path: string;
  text: string;
  /**
   * 这一镜的声音模式：record = 真人解说（合成用 audioPath 的录音），
   * 缺省 / tts = 语音合成（用音色那行）。镜头卡「解说词 / 字幕」标题右侧的单选切它。
   */
  audioMode?: "record" | "tts";
  /**
   * 真人解说：这一镜录好的音频文件（绝对路径）。
   * 有它合成时就直接用这段录音（跳过 TTS、字幕按录音时长均分），
   * 没它才走音色配置——允许一部分镜头真人、一部分镜头机器，混着来。
   */
  audioPath?: string;
}

export interface DialogueLine {
  speaker: string;          // 显示名（用户原话里的称呼）
  speakerType: SpeakerType;
  text: string;             // 该句台词
  index: number;            // 0-based 序号
  /** 该句所属的图片序号（0-based，对应图片列表顺序）；无图标签时为 undefined */
  sceneId?: number;
}

/** Edge TTS 词级时间戳（毫秒，相对本句音频起点） */
export interface WordCue {
  part: string;
  start: number;
  end: number;
}

/** 可选的 TTS 音色 */
export interface VoiceOption {
  id: string;               // edge-tts voice id, e.g. "zh-CN-YunyangNeural"
  label: string;            // 显示标签
  gender: "male" | "female";
}

export interface SubtitleSettings {
  fontSize: number;
  positionPct: number;      // 0..1，竖向位置（0=顶，1=底）
  color: string;            // "#FFFFFF"
  backgroundColor: string;  // "#000000"，或 "transparent" = 无色（不画字幕底色）
  /**
   * 字幕底色的透明度：0=完全不透明，1=完全透明（等于无色）。
   * 注意 ASS 的 Alpha 是反的（00=不透明 / FF=透明），这里按用户视角命名。
   */
  backgroundOpacity: number;// 0..1
}

/** 单个角色的语音参数（百分比偏移，0 = 默认） */
export interface VoiceProsody {
  rate: number;    // 语速：-50..100
  pitch: number;   // 音调：-50..50
  volume: number;  // 音量：-100..0
}

/**
 * 图文解说：单个镜头的解说员配置（一镜一个）。
 * 想在两个镜头里用两个音色，就分别设置，而不是在一个镜头里塞 A/B 两个解说员。
 */
export interface SceneNarrator {
  /** 音色值：Edge 音色 ID 或 clone:<id> */
  voice: string;
  prosody: VoiceProsody;
}

export interface DialogueSettings {
  apiKey: string;
  baseUrl: string;
  model: string;
  /**
   * 每家服务商各自的 API Key（key = ai-providers.ts 里的预设 key，如 deepseek/moonshot）。
   * apiKey 始终等于"当前服务商"的 key —— 三个 AI 调用点只读 apiKey，不用关心哪家。
   * 旧配置没有这个字段：首次进设置页时把原 apiKey 归到识别出的服务商名下。
   */
  aiKeys?: Record<string, string>;
  voiceFortune: string;
  voiceCustomer: string;
  voiceNarrator: string;
  /** 图文解说的解说员数量：1=单个解说员，2=双解说员（默认 2，兼容旧配置） */
  narratorCount?: 1 | 2;
  prosody: {
    a: VoiceProsody;
    b: VoiceProsody;
    narrator: VoiceProsody;
  };
  subtitle: SubtitleSettings;
}

/** 项目里保存的音色配置（与 DialogueSettings 的音色部分同构） */
export interface ProjectVoices {
  voiceFortune: string;
  voiceCustomer: string;
  voiceNarrator: string;
  prosody: DialogueSettings["prosody"];
}

/** 通用设置（settings.json 的 app 分区） */
export interface AppSettings {
  /** 视频输出路径；为空时使用默认 userData/dialogue-output */
  outputDir?: string;
  /** 每个模板类型各保存一份配置（两人对话 / 图文解说，无需命名） */
  savedTemplates?: Partial<Record<VideoMode, TemplateConfig>>;
  /**
   * 默认模板（模板库里的某一份 id）：工作台建「对话视频」卡时自动套用这套配置。
   * 不设就按设置里的音色/运镜默认值来。图文解说走的是另一条链路（分镜工作台），暂不用它。
   */
  defaultTemplateId?: string;
  /** 用户勾选的常用音色 ID；为空数组/未设置时显示全部音色 */
  favoriteVoices?: string[];
  /** 本地声音克隆服务（Genie-TTS / GPT-SoVITS）地址 */
  localTts?: {
    host: string;
    port: number;
  };
  /** 用户保存的克隆音色列表 */
  cloneVoices?: CloneVoice[];
  /**
   * 生图引擎：modelscope = ModelScope API-Inference（官方 HTTP 接口）。
   *
   * 界面上是可切换的一个开关，主进程按它分派到不同的生图实现，
   * 但两边对界面暴露的契约一致（GenerateShotOutcome / BatchState）。
   */
  imageProvider?: ImageProviderKey;
  /** ModelScope 生图配置（生图引擎选 modelscope 时生效） */
  modelscopeImage?: ModelScopeImageSettings;
}

/** ModelScope API-Inference 生图配置 */
export interface ModelScopeImageSettings {
  /** ModelScope SDK Token（API-Inference 鉴权）；没填就生不了图 */
  token?: string;
  /** 模型 id，如 Tongyi-MAI/Z-Image-Turbo；留空用默认 */
  model?: string;
  /** 出图尺寸 WxH（如 720x1280）；留空按分镜画面比例自动选 */
  size?: string;
}

/** 一个本地声音克隆音色：参考音频 + 对应文本 + 基础模型目录（Genie-TTS） */
export interface CloneVoice {
  /** 唯一 ID（用于音色下拉里的 value = "clone:" + id） */
  id: string;
  /** 用户起的名字 */
  name: string;
  /** Genie-TTS 角色 ONNX 模型目录（load_character 的 onnx_model_dir） */
  modelDir: string;
  /** 参考音频本地路径（3~10 秒，wav/flac/ogg/aiff） */
  audioPath: string;
  /** 参考音频对应的文本 */
  audioText: string;
  /** 参考音频语言：zh / en / jp / kr */
  language: string;
  createdAt: number;
}

/** 本地声音克隆服务状态 */
export interface LocalTtsStatus {
  online: boolean;
  error?: string;
}

/** 本地 Genie 服务生命周期状态 */
export type LocalTtsState =
  | "idle"
  | "installing"
  | "downloading"
  | "starting"
  | "running"
  | "stopping"
  | "error";

/** 一键启用/停用本地服务后的环境信息 */
export interface LocalTtsEnv {
  /** 找到的 Python，如 "python" / "py -3"；未安装为 null */
  python: string | null;
  genieInstalled: boolean;
  modelReady: boolean;
  /** 默认中文基础模型目录（feibi），未下载时为 null */
  defaultModelDir: string | null;
  /** 本地已下载/放置的 Genie 角色模型下拉列表 */
  modelOptions: Array<{ label: string; modelDir: string }>;
  /** 服务端口当前是否在线 */
  online: boolean;
  /** 服务是否由本应用启动的子进程管理 */
  managed: boolean;
  state: LocalTtsState;
  message?: string;
  /**
   * 正在下载的角色模型 key（无下载任务时为 null）。
   * 下载任务由主进程持有，界面据此恢复「下载中」状态——
   * 切走再回来时组件 state 已丢失，只能以主进程为准。
   */
  downloadingKey: string | null;
  /** 当前下载任务最近一次进度（无任务时为 null），用于重进页面后接着显示进度条 */
  progress?: LocalTtsProgress | null;
}

/** 启用/停用过程中的实时进度 */
export interface LocalTtsProgress {
  phase: "install" | "download" | "start" | "stop";
  message: string;
  /** 实时输出最后一行（pip / 下载日志） */
  detail?: string;
  /** 0~100 的下载进度（模型下载阶段可用时提供） */
  percent?: number;
}

/**
 * 后台下载任务的轻量快照。
 *
 * 与 LocalTtsEnv 的区别：**不探测 Python、不 ping 服务**，只读主进程内存里的任务状态，
 * 所以界面（任何页面）可以每 2 秒轮询一次而不产生任何子进程开销。
 * env() 每次都要起 python 自检，下载期间高频轮询会平白拖慢机器。
 */
export interface LocalTtsTaskSnapshot {
  /** 正在下载的角色模型 key；无任务时为 null */
  downloadingKey: string | null;
  /** 最近一次进度（无任务或刚开始时为 null） */
  progress: LocalTtsProgress | null;
  state: LocalTtsState;
  message?: string;
}

/** 后台下载任务的收尾通知（完成 / 取消 / 失败），广播给所有窗口 */
export interface LocalTtsTaskResult {
  /** 本次任务的角色模型 key */
  key: string;
  ok: boolean;
  /** 用户点「取消」而收尾 */
  cancelled?: boolean;
  /** 给用户看的一句话（失败时是归类后的原因） */
  message: string;
}

/** 一份模板配置 = 当前左侧配置面板的全部参数（不含脚本） */
export interface TemplateConfig {
  imageFortune: string | null;
  imageCustomer: string | null;
  images: DialogueImageScene[];
  /** 图文解说：每个镜头的解说员配置（与 images 顺序对齐） */
  imageNarrators?: SceneNarrator[];
  narratorCount: 1 | 2;
  resolution: VideoResolution;
  imageFit: ImageFit;
  motionMode: MotionMode;
  motionAmount: number;
  motionRoleA: MotionConfig;
  motionRoleB: MotionConfig;
  motionPerImage: boolean;
  imageMotions: MotionConfig[];
  voices: ProjectVoices;
}

export interface ComposeRequest {
  name: string;
  mode: VideoMode;
  /**
   * 发起方带过来的分镜 id（分镜工作台会带）。
   *
   * 用处只有一个：合成在主进程跑，界面切任务卡 / 切页会把组件卸载，
   * 重新挂载时靠这个 id 认领「是自己那份分镜的合成」——否则一张卡上会画出别的分镜的进度。
   */
  boardId?: string;
  resolution?: VideoResolution;
  imageFit?: ImageFit;
  motionMode?: MotionMode;
  motionAmount?: number;
  /** 图文解说：按图设置运镜（与 images 顺序对齐），缺省回退到 motionMode/motionAmount */
  imageMotions?: Array<{ mode: MotionMode; amount: number }>;
  /** 图文解说：按镜头设置解说员（与 images 顺序对齐），缺省回退到全局音色 */
  imageNarrators?: Array<SceneNarrator | undefined>;
  /** 对话模式：甲方/乙方各自的运镜（缺省回退到全局 motionMode/motionAmount） */
  motionA?: Partial<MotionConfig>;
  motionB?: Partial<MotionConfig>;
  script: string;
  imageFortune: string;
  imageCustomer: string;
  images?: DialogueImageScene[];
  /**
   * 对话模式：按句录的真人配音。
   *
   * `index` 是这句在脚本解析结果里的序号，`text` 是录的时候那句台词。
   * 合成时会核对 text：**对不上就忽略这条录音、这句回退合成音**——
   * 录完又改了台词的话，宁可听机器声，也不能把旧录音配到新台词上。
   */
  lineRecordings?: Array<{ index: number; text: string; path: string }>;
  outputDir: string;          // 输出目录
  voiceFortune: string;
  voiceCustomer: string;
  voiceNarrator?: string;
  narratorCount?: 1 | 2;
  prosody: {
    a: VoiceProsody;
    b: VoiceProsody;
    narrator: VoiceProsody;
  };
  subtitle: SubtitleSettings;
}

export interface ComposeResult {
  outputPath: string;         // 最终 mp4 路径
  durationMs: number;
}

export type ComposeStage =
  | "parse"
  | "tts"
  | "compose"
  | "done"
  | "error";

export interface ComposeProgress {
  requestId?: string;
  stage: ComposeStage;
  /** 当前阶段内的进度，0..100。stage=done 时为 100 */
  percent: number;
  /** 当前在处理的台词序号（stage=tts 时） */
  currentLine?: number;
  totalLines?: number;
  message?: string;
  error?: string;
}

/**
 * 最近一次合成（在跑或刚结束）的快照。
 *
 * 合成的活儿在主进程跑（切页、关抽屉都不中断），但进度原本只走广播：
 * 界面切任务卡 / 切页会把组件卸载，重挂之后就错过了所有广播，表现成
 * 「后台还在合成，界面上什么都没有」；成片路径也只留在被卸载的那个实例里，
 * 于是刚渲染好的片子从界面上找不到入口。所以主进程留一份快照，界面重挂时认领。
 *
 * 放在 shared 是因为 preload 要转给渲染层，而 preload 不能 import 主进程模块。
 */
export interface ComposeSnapshot {
  requestId: string;
  /** 发起方带的分镜 id：界面拿它判断这条快照是不是自己那份分镜的 */
  boardId: string | null;
  name: string;
  running: boolean;
  stage: ComposeStage;
  percent: number;
  message: string;
  currentLine?: number;
  totalLines?: number;
  outputPath: string | null;
  error: string | null;
  /** 开始时刻：界面切回来时秒表要接着走，不能从 0 重来 */
  startedAt: number;
  updatedAt: number;
}

/**
 * 变声器（方案 A）：把一段音频/视频里的人声转成文字，再用指定音色重新合成。
 * 与 B 方案（真·语音转换 SVC）的区别：不保留原声语气/停顿/语速，但不需要任何新模型或显卡。
 */
export type VoiceConvertStage =
  /** 首次使用：下载本地识别模型（约 150 MB） */
  | "model-download"
  /** 从原文件里抽 16kHz 单声道人声 */
  | "extract-audio"
  /** Whisper 识别文字 */
  | "transcribe"
  /** 用新音色逐句重新配音 */
  | "synthesize"
  /** 拼接成一条音频 */
  | "merge"
  | "done";

export interface VoiceConvertRequest {
  /** 源文件：音频或视频（视频会自动抽音轨） */
  inputPath: string;
  /** 音色值：Edge 音色 ID 或 clone:<id> */
  voice: string;
  /** 以下三个只对在线音色生效（克隆音色的语速/音调由模型决定） */
  rate?: number;
  pitch?: number;
  volume?: number;
  requestId?: string;
}

export interface VoiceConvertProgress {
  requestId?: string;
  stage: VoiceConvertStage;
  /** 整条流水线进度 0..100（阶段加权：识别 0~45、配音 45~95、拼接 95~100） */
  percent: number;
  /** 识别模型下载进度（stage=model-download 时可用） */
  received?: number;
  total?: number;
  /** 已重配音句数 / 总句数（stage=synthesize 时可用） */
  current?: number;
  totalLines?: number;
  /** 识别过程中的实时文本行 */
  line?: string;
  message?: string;
}

export interface VoiceConvertResult {
  /** 变声后的音频（wav，32kHz 单声道） */
  audioPath: string;
  /** 识别出的句子数 */
  segmentCount: number;
  /** 成功重新配音的句子数 */
  doneCount: number;
  /** 成品时长（秒） */
  durationSec: number;
}
