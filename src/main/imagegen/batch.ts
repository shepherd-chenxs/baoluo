/*
 * SPDX-License-Identifier: GPL-3.0-only
 * Copyright (c) 2026 宝螺 / Baoluo contributors
 * 本文件属于「宝螺 / Baoluo」。除 GPL-3.0 外还适用 ADDITIONAL_TERMS.md 里的附加条款：
 * 分发时须保留来源署名；修改版对外分发时不得沿用「宝螺」名称与图标。
 */
/**
 * 批量生图（走官方 HTTP 接口，ModelScope）。
 *
 * 队列在主进程跑：界面只提交 boardId、按广播更新进度、按需中止。
 * 每镜一次请求，所以进度口径是「已请求 N 次」。
 */
import * as storyStore from "../storyboard/store";
import { attachShotImageBytes } from "../storyboard/store";
import {
  currentImageProvider,
  describeImageFailure,
  generateImageForPrompt,
  imageProviderBlocked,
  sizeForResolution,
} from "./index";
import type { BatchItem, BatchStartResult, BatchState, GenerateShotResult } from "../../shared/image-batch-types";
import type { Storyboard } from "../../shared/storyboard-types";

type Emitter = (s: BatchState) => void;

let emit: Emitter = () => {};
let state: BatchState = emptyState(null);

function emptyState(boardId: string | null): BatchState {
  return {
    running: false,
    boardId,
    provider: currentImageProvider(),
    cancelling: false,
    total: 0,
    doneCount: 0,
    items: [],
    summary: "",
    submitted: 0,
    note: "",
  };
}

function snapshot(): BatchState {
  return state;
}

export function setBatchEmitter(fn: Emitter): void {
  emit = fn;
  emit(snapshot());
}

export function getBatchState(): BatchState {
  return snapshot();
}

let abortRequested = false;
let waite: ((s: BatchState) => void) | null = null;

export function waitBatchDone(): Promise<BatchState> {
  return new Promise((resolve) => {
    if (!state.running) {
      resolve(snapshot());
      return;
    }
    waite = resolve;
  });
}

function markDone(s: BatchState) {
  state = s;
  emit(s);
  if (waite && !s.running) {
    const w = waite;
    waite = null;
    w(s);
  }
}

/** 单镜生图：出图后绑定到镜头槽，返回结构化结果 */
export async function generateShot(boardId: string, shotId: string): Promise<GenerateShotResult> {
  const blocked = imageProviderBlocked();
  if (blocked) return { ok: false, code: blocked.code, message: blocked.message };
  const sb = storyStore.getStoryboard(boardId);
  const shot = sb.shots.find((s) => s.id === shotId);
  if (!shot) return { ok: false, code: "shot-missing", message: "镜头不存在，请刷新后重试。" };
  const result = await generateImageForPrompt(shot.imagePrompt, {
    resolution: sb.resolution,
    // 只在批量跑的过程中把阶段提示广播出去；单独生图时由界面自己显示固定文案
    onPhase: (m) => {
      if (state.running) {
        state = { ...state, note: m };
        emit(state);
      }
    },
  });
  const board = attachShotImageBytes(boardId, shotId, result.base64);
  return { ok: true, board };
}

/**
 * 批量生图：把缺图的镜头依次出图并绑定。
 *
 * 这个函数**只负责开工前的判断**，不等队列跑完就返回：
 * 界面（一键成片）靠它先拿到「有没有真的启动」，再靠广播等收工。
 * 要是把它 await 到底，那条 await 会把 IPC 一起吊住，界面就再也等不到收工信号了。
 */
export async function startBatch(boardId: string): Promise<BatchStartResult> {
  if (state.running) {
    return { started: false, state: snapshot(), code: "busy", error: "批量生图已经在跑了。" };
  }
  const blocked = imageProviderBlocked();
  if (blocked) {
    state = { ...emptyState(boardId), summary: blocked.message, note: blocked.message };
    markDone(state);
    return { started: false, state: snapshot(), code: blocked.code, error: blocked.message };
  }

  const sb: Storyboard = storyStore.getStoryboard(boardId);
  const missing = sb.shots.filter((s) => !s.imagePath && s.imagePrompt?.trim());
  const items: BatchItem[] = missing.map((s, i) => ({
    shotId: s.id,
    index: i + 1,
    state: "pending",
    via: "api",
  }));

  abortRequested = false;
  state = {
    running: true,
    boardId,
    provider: currentImageProvider(),
    cancelling: false,
    total: items.length,
    doneCount: 0,
    items,
    summary: "",
    submitted: 0,
    note: "准备中…",
  };
  markDone(state);

  // 队列在后台跑，进度靠 emit 广播；这里的 promise 只用来收尾，不吊住调用方
  void runQueue(boardId, items).catch((e) => {
    state = {
      ...state,
      running: false,
      cancelling: false,
      summary: describeImageFailure(e).message,
      note: describeImageFailure(e).message,
    };
    markDone(state);
  });

  return { started: true, state: snapshot() };
}

/** 队列本体：一张一张出图，每张的结果都广播出去 */
async function runQueue(boardId: string, items: BatchItem[]): Promise<void> {
  /*
   * 先让出一拍再动：startBatch 是同步把「已启动」返回给界面的，界面在那之后才挂上
   * 「等收工」的钩子。要是队列一张都不用跑（这批其实不缺图），它会当场收工，
   * 那条 running=false 的广播就会赶在钩子挂上之前发掉 —— 界面从此干等。
   * 让到下一个宏任务，保证 IPC 的回包先走。
   */
  await new Promise((r) => setImmediate(r));

  let submitted = 0;
  let okCount = 0;
  const failedIndexes: number[] = [];

  for (let i = 0; i < items.length; i++) {
    if (abortRequested) {
      // 把还没开始的标成 skipped
      for (let j = i; j < items.length; j++) {
        if (items[j].state === "pending") items[j].state = "skipped";
      }
      break;
    }
    const item = items[i];
    item.state = "running";
    item.attempts = 1;
    state = {
      ...state,
      items: [...items],
      note: `正在生成第 ${item.index} / 共 ${items.length} 张（第 ${item.index} 镜）`,
    };
    markDone(state);

    try {
      submitted += 1;
      state = { ...state, submitted };
      const res = await generateShot(boardId, item.shotId);
      if (!res.ok) {
        item.state = "failed";
        item.error = res.message ?? "生图失败";
      } else {
        item.state = "done";
        okCount += 1;
      }
    } catch (e) {
      item.state = "failed";
      item.error = describeImageFailure(e).message;
    }
    state = {
      ...state,
      items: [...items],
      doneCount: state.doneCount + 1,
    };
    markDone(state);
  }

  const failed = items.filter((it) => it.state === "failed");
  failedIndexes.push(...failed.map((it) => it.index));
  const aborted = abortRequested;
  const summary = buildSummary(okCount, items.length, failedIndexes, aborted);

  state = {
    ...state,
    running: false,
    cancelling: false,
    summary,
    note: summary,
  };
  markDone(state);
}

function buildSummary(ok: number, total: number, failedIndexes: number[], aborted: boolean): string {
  if (total === 0) return "没有需要生成的镜头。";
  const parts = [`成功 ${ok} / 共 ${total}`];
  if (failedIndexes.length) parts.push(`失败：第 ${failedIndexes.join("、")} 镜`);
  if (aborted) parts.push("已中止");
  return parts.join("，") + "。";
}

/** 中止批量生图（当前这张跑完就停） */
export function cancelBatch(): BatchState {
  if (state.running) {
    abortRequested = true;
    state = { ...state, cancelling: true, note: "正在停止（等当前这张跑完）…" };
    markDone(state);
  }
  return snapshot();
}
