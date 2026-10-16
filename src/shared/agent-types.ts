/*
 * SPDX-License-Identifier: GPL-3.0-only
 * Copyright (c) 2026 宝螺 / Baoluo contributors
 * 本文件属于「宝螺 / Baoluo」。除 GPL-3.0 外还适用 ADDITIONAL_TERMS.md 里的附加条款：
 * 分发时须保留来源署名；修改版对外分发时不得沿用「宝螺」名称与图标。
 */
/**
 * 工作台（agent 模式）共享类型。
 *
 * 设计见 doc/Agent化改造-产品形态设计.md：
 * 用户说一句话 → 生成一张任务卡（若干步骤）→ 逐步执行；
 * 每一步的产物都落盘、都能单独重跑，中间产物本身就是资产。
 */
import type { SniffAnalysis } from "./sniff-types";
import type { HotItem } from "./storyboard-types";

/**
 * 一句话指令被分到的意图。
 * 由规则分流器（src/main/agent/router.ts）判定——这一层不花 token。
 */
export type AgentIntent =
  /** 主题 → 对话视频 */
  | "dialogue-video"
  /** 主题 → 图文解说（v1 只提示，不自动执行） */
  | "narration-video"
  /** 音频/视频 → 换音色重新念 */
  | "voice-convert"
  /** 一段文字 → 用指定音色念出来 */
  | "tts"
  /** 音视频文件 → 文案 */
  | "asr"
  /** 本地音视频 → 拆解可复用的方法 */
  | "sniff"
  | "unknown";

export type AgentTaskStatus = "draft" | "running" | "done" | "failed" | "cancelled";
export type AgentStepStatus = "pending" | "running" | "done" | "failed" | "skipped";

/** 步骤种类 = 工具名，一个步骤调一个工具 */
export type AgentStepKind =
  | "transcribe"
  | "write-script"
  | "write-storyboard"
  /** 对话视频：两个角色的图 / 音色 / 音量 / 运镜 / 画面比例（只配置，工具是空操作） */
  | "dialogue-config"
  | "compose"
  | "compose-narration"
  /** 热点成片/图文解说：编辑和执行都在任务卡内嵌的分镜工作台里，工具本身是空操作 */
  | "hot-story"
  | "voice-convert"
  | "tts"
  | "sniff";

export interface AgentParamOption {
  value: string;
  label: string;
}

/** 步骤的可编辑参数：渲染层按 type 决定用什么控件 */
export interface AgentParam {
  key: string;
  label: string;
  value: string;
  type?: "text" | "number" | "select" | "image" | "file" | "textarea";
  options?: AgentParamOption[];
  placeholder?: string;
  /** 独占一行：不跟同一步的其它参数挤在同一行（如「选图 + 合成」里的解说员音色） */
  ownLine?: boolean;
  /** 从这个参数起换一行排（如「生成分镜」里的音色+语速一组挪到第二行） */
  breakBefore?: boolean;
  /** 控件宽度提示：wide=下拉放宽（长音色名不截断），narrow=数字框收窄（语速这类小数字） */
  width?: "wide" | "narrow";
}

export interface AgentStep {
  id: string;
  kind: AgentStepKind;
  title: string;
  status: AgentStepStatus;
  /** 一句话结果（产物摘要），显示在步骤右边 */
  note?: string;
  /** 产物路径：能预览、能打开 */
  outputPath?: string;
  error?: string;
  params?: AgentParam[];
  /** 能不能单独重跑（默认 true） */
  rerunnable?: boolean;
}

/** 步骤之间传递的中间状态：只存路径和短文本，方便持久化 */
export interface AgentRunState {
  videoPath?: string;
  transcript?: string;
  script?: string;
  /** 热点成片/图文解说生成的那份分镜（id 指向 storyboard store） */
  storyboardId?: string;
  /**
   * 这张卡在工作台里点过「成片」的时间。
   *
   * 为什么需要它：工作区卡的执行走的是**工作台内部**的流水线，不经过 agent:run，
   * 所以任务状态会一直停在 draft。但界面需要知道"开跑过没有"——
   * 跑过之后这一整块就只当过程看（只读），要改去「热点成片」页。
   */
  hotRanAt?: number;
  /** 爆款拆解的报告正文（拆完直接摊在工作台里看，不用去翻文件） */
  sniffReport?: string;
  /** 拆解给出的候选选题：工作台里点一个，接着按同一套方法出分镜方案 */
  sniffTopics?: string[];
  /** 拆解出的爆款方法：出分镜时带上，仿结构不抄内容 */
  sniffMethod?: SniffAnalysis;
  outputPath?: string;
}

export interface AgentTask {
  id: string;
  title: string;
  /** 用户原话 */
  instruction: string;
  intent: AgentIntent;
  status: AgentTaskStatus;
  createdAt: number;
  updatedAt: number;
  /** 这次任务的中间产物目录 */
  workDir: string;
  steps: AgentStep[];
  state?: AgentRunState;
  /** 这条任务是从哪条热点来的（工作台里点热点建的卡），分镜会记下来源 */
  hot?: HotItem;
  /** 最终产物 */
  resultPath?: string;
  resultKind?: "video" | "audio" | "text";
}

/** 规则分流的结果（agent:create 内部用，也用于单测） */
export interface AgentParseResult {
  intent: AgentIntent;
  title: string;
  /** 分流阶段能确定的参数（链接、主题、文件路径…） */
  params: Record<string, string>;
  /** 还缺什么输入，界面按这个提示用户 */
  missing: string[];
  /** 一句话说明：直接显示成对话里的第一条回复 */
  summary: string;
}

/** 一句话 → 任务卡。认不出来的指令只回话、不建卡（task 为 null） */
export interface AgentCreateResult {
  parse: AgentParseResult;
  task: AgentTask | null;
}

/** 主进程 → 渲染层的任务进度（agent:progress） */
export interface AgentProgress {
  taskId: string;
  stepId?: string;
  status: AgentStepStatus;
  percent?: number;
  message?: string;
  /** 步骤的最新快照：渲染层直接按 id 替换 */
  step?: AgentStep;
  /** 任务级快照（跑完/失败时给一份完整的） */
  task?: AgentTask;
}
