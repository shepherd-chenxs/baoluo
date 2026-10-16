/*
 * SPDX-License-Identifier: GPL-3.0-only
 * Copyright (c) 2026 宝螺 / Baoluo contributors
 * 本文件属于「宝螺 / Baoluo」。除 GPL-3.0 外还适用 ADDITIONAL_TERMS.md 里的附加条款：
 * 分发时须保留来源署名；修改版对外分发时不得沿用「宝螺」名称与图标。
 */
/**
 * 批量生图的数据结构（ModelScope 官方接口路径）。
 *
 * 放 shared 是因为主进程要产出、preload/渲染层要消费，
 * 而 preload 不能 import 主进程模块。
 */
import type { ImageProviderKey } from "./image-providers";

export interface BatchItem {
  shotId: string;
  /** 第几镜（从 1 开始，给用户看的序号） */
  index: number;
  /** done=已出图并绑定；failed=重试到上限仍失败；skipped=中止时还没开始 */
  state: "pending" | "running" | "done" | "failed" | "skipped";
  error?: string;
  /** 过程留痕（不覆盖 error） */
  note?: string;
  /** 第几次尝试（1 起），用于「重试中」的显示 */
  attempts?: number;
  /** 这一镜最终是怎么出图的：api = 直接调接口出图 */
  via?: "api";
}

export interface BatchState {
  running: boolean;
  boardId: string | null;
  /** 这一轮用的生图引擎。界面据此换文案。 */
  provider?: ImageProviderKey;
  /** 已请求中止，但当前这张还在跑 */
  cancelling: boolean;
  total: number;
  /** 已处理完的张数（含失败） */
  doneCount: number;
  items: BatchItem[];
  /** 结束时的人话汇总，例如「成功 3 / 共 5，失败：第 2、4 镜，已中止」 */
  summary: string;
  /** 本次已向接口提交的请求次数 */
  submitted: number;
  /** 当前阶段的提示，给界面显示用 */
  note: string;
}

export interface BatchStartResult {
  started: boolean;
  state: BatchState;
  error?: string;
  /** 机器可读的拒绝原因（界面据此决定要不要提示去填 Token） */
  code?: string;
}

/** 单镜生图结果（界面据此决定换图 / 提示 / 报错） */
export interface GenerateShotResult {
  ok: boolean;
  board?: import("./storyboard-types").Storyboard;
  message?: string;
  code?: string;
}
