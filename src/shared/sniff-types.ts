import type { ViralTrigger } from "./viral-triggers";

/** 嗅探任务进度（主进程按阶段回推） */
export interface SniffProgress {
  requestId?: string;
  stage:
    | "parse"
    | "download"
    | "transcribe"
    | "analyze"
    | "done"
    | "error";
  message: string;
  percent?: number;
}

/** AI 从一条爆款里拆出的“方法” */
export interface SniffAnalysis {
  trigger: ViralTrigger;
  /** 原视频开头 3 秒/第一个钩子做了什么 */
  hook: string;
  /** 叙事结构，按顺序描述 */
  structure: string[];
  /** 一句话可复用方法论 */
  reusable: string;
  /** 它怎么诱导互动/埋评论 */
  commentBait?: string;
  /** 基于同一方法给用户挑的新选题（3~5 个） */
  topics?: string[];
}

/**
 * 一次嗅探的完整结果（只在内存与进程间传递，不落盘）
 */
export interface SniffRecord {
  id: string;
  createdAt: number;
  niche: string;
  source: {
    url: string;
    title: string;
    author: string;
    platform: string;
  };
  transcript: string;
  analysis: SniffAnalysis;
}

/** sniff:run 入参 */
export interface SniffRunRequest {
  link: string;
  niche?: string;
  requestId?: string;
}
