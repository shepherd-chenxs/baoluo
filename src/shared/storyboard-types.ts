/*
 * SPDX-License-Identifier: GPL-3.0-only
 * Copyright (c) 2026 宝螺 / Baoluo contributors
 * 本文件属于「宝螺 / Baoluo」。除 GPL-3.0 外还适用 ADDITIONAL_TERMS.md 里的附加条款：
 * 分发时须保留来源署名；修改版对外分发时不得沿用「宝螺」名称与图标。
 */
/**
 * v0.5.0「热点成片」业务类型：
 * 热点源 → AI 分镜（文案 + 图文 prompt）→ 用户手动生图 → 图文视频合成。
 */
import type { VideoResolution } from "./dialogue-types";
import type { ViralTrigger } from "./viral-triggers";

/** 一个可选的榜单来源 */
export interface HotSource {
  key: string;
  name: string;
}

/** 一条热点：从任何榜单源抓取后统一归一成此结构 */
export interface HotItem {
  id: string;                  // source + 榜单序号拼成，唯一
  title: string;               // 热点标题
  source: string;              // 来源显示名，如 "微博"
  rank: number;
  heat?: string;               // 热度文本，如 "874万"；接口只给数字时前端再格式化
  url?: string;
  fetchedAt: number;
}

/** 一个镜头：文案与画面一一对应 */
export interface Shot {
  id: string;                  // 本地随机 id，用于编辑、重排、定向重生成
  caption: string;             // 旁白文案 = 配音文本 = 字幕文本
  imagePrompt: string;         // 用于生图的画面提示词，已拼好风格与约束
  imagePath: string | null;    // 用户生图后拖入的图片；null = 未放图
  motion: {
    mode: "none" | "zoom-in" | "zoom-out" | "pan-left" | "pan-right";
    amount: number;
  };
  durationHint?: number;       // AI 建议秒数，仅供参考，实际以配音时长为准
}

/** 一份成片方案 = AI 草稿 + 用户后续填图 */
export interface Storyboard {
  id: string;
  title: string;               // 发布用标题（可编辑）
  hook: string;                // 开头钩子（可编辑）
  style: string;               // 画面统一风格，AI 生成并拼进每个 prompt
  /** 本期引爆观众心理的主类型（7 类里选 1，AI 生成时写入） */
  trigger?: string;
  /** 画面方向：竖屏 9:16 / 横屏 16:9（生成分镜时决定，旧方案缺省竖屏） */
  resolution?: VideoResolution;
  sourceHot?: HotItem;         // 来自哪条热点；手动输入时为空
  shots: Shot[];
  /**
   * 这份方案最近一次合成出来的成片路径。
   *
   * 合成本身是主进程的活儿，但「这份方案出过哪条片子」得跟着方案走：
   * 否则切个任务卡、或者重启应用，刚渲染好的片子就从界面上消失了
   * （文件还在输出目录里，只是没有任何地方能点开它）。
   */
  lastVideoPath?: string;
  createdAt: number;
  updatedAt: number;
}

/** 历史列表里的摘要（不含 shots，避免大文件反复传输） */
export interface StoryboardSummary {
  id: string;
  title: string;
  createdAt: number;
  updatedAt: number;
  shotCount: number;
  filledCount: number;         // 已放入图片的镜头数
  /** 这份方案已经出过成片（列表上给个标记，免得用户不记得哪份渲染过） */
  hasVideo?: boolean;
}

/** DeepSeek 只输出的原始草稿（前端/主进程负责补 id/motion/imagePath） */
export interface AiStoryboardDraft {
  title: string;
  hook: string;
  style: string;
  trigger?: string;
  shots: Array<{
    caption: string;
    imagePrompt: string;
    durationHint?: number;
  }>;
}

/** storyboard:generate 的入参 */
export interface StoryGenerateRequest {
  /** 手动输入的主题；与 hot 二选一，同时给时以 hot 为主 */
  topic?: string;
  /** 从热点列表选中的条目 */
  hot?: HotItem | null;
  /** 画面方向，默认竖屏 9:16 */
  resolution?: VideoResolution;
  /** 仿写爆款时参考的方法（v0.6 嗅探结果，与 hot/topic 一起给时仍以实际主题为准） */
  method?: {
    trigger: ViralTrigger;
    hook: string;
    structure: string[];
    reusable: string;
    commentBait?: string;
  };
  /** 用户内容赛道，如 "情感" / "职场" / "历史"（可选） */
  niche?: string;
  /** 目标时长（秒），默认 30，AI 按此决定镜头数 */
  durationSeconds?: number;
}

/** AI 生成阶段进度（story:progress） */
export interface StoryProgress {
  phase: "thinking" | "writing" | "done" | "error";
  message: string;
  /** 本次生成的标识：中止（cancelGenerate）时要带上 */
  requestId?: string;
}
