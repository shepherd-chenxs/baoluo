/*
 * SPDX-License-Identifier: GPL-3.0-only
 * Copyright (c) 2026 宝螺 / Baoluo contributors
 * 本文件属于「宝螺 / Baoluo」。除 GPL-3.0 外还适用 ADDITIONAL_TERMS.md 里的附加条款：
 * 分发时须保留来源署名；修改版对外分发时不得沿用「宝螺」名称与图标。
 */
import type { ViralTrigger } from "./viral-triggers";

/** 嗅探任务进度（主进程按阶段回推） */
export interface SniffProgress {
  requestId?: string;
  stage: "transcribe" | "analyze" | "done" | "error";
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
    /** 被拆解的本地音视频文件路径 */
    path: string;
    /** 文件名（去掉扩展名），界面当标题显示 */
    title: string;
  };
  transcript: string;
  analysis: SniffAnalysis;
}

/** sniff:run 入参 */
export interface SniffRunRequest {
  /** 本地音视频文件路径 */
  filePath: string;
  niche?: string;
  requestId?: string;
}
