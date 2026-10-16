/*
 * SPDX-License-Identifier: GPL-3.0-only
 * Copyright (c) 2026 宝螺 / Baoluo contributors
 * 本文件属于「宝螺 / Baoluo」。除 GPL-3.0 外还适用 ADDITIONAL_TERMS.md 里的附加条款：
 * 分发时须保留来源署名；修改版对外分发时不得沿用「宝螺」名称与图标。
 */
/**
 * 任务执行器：按顺序跑步骤，每步跑完就把结果写进任务卡并推给界面。
 *
 * 两条使用方式：
 *   runTask(id)               从第一个没做完的步骤开始，一路跑到底
 *   runTask(id, { stepId })   只重跑某一步（并把后面的步骤打回未开始，因为它们的结果可能已经过期）
 */
import type { WebContents } from "electron";
import type { AgentProgress, AgentStep, AgentTask } from "../../shared/agent-types";
import { getTask, saveTask } from "./store";
import { getTool, type AgentToolContext } from "./tools";

/** 同一时间只跑一个任务：几路 TTS / ffmpeg 同时抢 CPU 只会两边都慢 */
let runningTaskId: string | null = null;
const controllers = new Map<string, AbortController>();

export interface RunTaskOptions {
  /** 只重跑这一步 */
  stepId?: string;
  webContents: WebContents;
  onProgress: (p: AgentProgress) => void;
}

export function runningTask(): string | null {
  return runningTaskId;
}

/**
 * 推给界面的一律是快照，不是活引用。
 * 步骤对象在跑下一步时会被改写；直接把引用塞进事件里，
 * 界面拿到的"正在合成"会在下一帧变成"失败"，看起来像状态回跳。
 */
function stepSnapshot(step: AgentStep): AgentStep {
  return { ...step, params: step.params?.map((p) => ({ ...p })) };
}

function taskSnapshot(task: AgentTask): AgentTask {
  return { ...task, steps: task.steps.map(stepSnapshot) };
}

/** 取消任务：当前步骤收到 abort，链路在这里断掉 */
export function cancelTask(taskId: string): boolean {
  const c = controllers.get(taskId);
  if (!c) return false;
  c.abort();
  return true;
}

/**
 * 强制释放某个任务的"占用位"：
 * 删除正在跑的任务时，abort 只是信号，真正让出 runningTaskId 要等当前 await 抛出。
 * 在这个时间窗里用户开新任务会被"已经有一个任务在跑"挡住 —— 任务都删了，占位必须立刻让出来。
 */
export function forceRelease(taskId: string): void {
  if (runningTaskId === taskId) runningTaskId = null;
  controllers.delete(taskId);
}

export async function runTask(taskId: string, opts: RunTaskOptions): Promise<AgentTask> {
  const task = getTask(taskId);
  if (!task) throw new Error("任务不存在，可能已经被删掉了。");
  if (runningTaskId === taskId) throw new Error("这个任务正在跑。");
  if (runningTaskId) {
    /*
     * 占位指向的任务可能已经被删了（abort 后当前 await 还没抛完、占位还没让出来）。
     * 这时候不该拦着新任务：被删的任务永远不会再回来让位，否则只能重启应用。
     */
    if (!getTask(runningTaskId)) {
      const stale = runningTaskId;
      runningTaskId = null;
      controllers.delete(stale);
    } else {
      throw new Error("已经有一个任务在跑了，等它结束再开下一个。");
    }
  }

  const only = Boolean(opts.stepId);
  const startIndex = only
    ? task.steps.findIndex((s) => s.id === opts.stepId)
    : task.steps.findIndex((s) => s.status !== "done");
  if (only && startIndex < 0) throw new Error("找不到这一步。");
  // 没有待跑的步骤：直接返回，不报错（重复点「执行」不该弹错）
  if (startIndex < 0) return task;

  runningTaskId = taskId;
  const controller = new AbortController();
  controllers.set(taskId, controller);

  const state = { ...(task.state ?? {}) };
  task.status = "running";
  task.updatedAt = Date.now();
  saveTask(task);

  const emit = (step: AgentStep | null, extra: Partial<AgentProgress> = {}) => {
    opts.onProgress({
      taskId: task.id,
      status: step ? step.status : task.status === "running" ? "running" : "done",
      ...(step ? { stepId: step.id, step: stepSnapshot(step) } : {}),
      ...extra,
    });
  };

  try {
    for (let i = startIndex; i < task.steps.length; i++) {
      const step = task.steps[i];
      if (only && i !== startIndex) break;
      if (!only && step.status === "done") continue;

      // 重跑某一步 = 承认"下游结果已经不对了"，把它们打回未开始
      if (only) {
        for (let j = i + 1; j < task.steps.length; j++) {
          const next = task.steps[j];
          next.status = "pending";
          next.note = undefined;
          next.outputPath = undefined;
          next.error = undefined;
        }
      }

      step.status = "running";
      step.error = undefined;
      step.note = undefined;
      saveTask(task);
      emit(step, { message: "开始…" });

      const ctx: AgentToolContext = {
        task,
        workDir: task.workDir,
        state,
        signal: controller.signal,
        webContents: opts.webContents,
        emit: (p) => emit(step, { message: p.message, percent: p.percent }),
      };

      try {
        const result = await getTool(step.kind).run(ctx, step);
        if (controller.signal.aborted) throw new Error("已取消");
        step.status = "done";
        step.note = result.note ?? step.note;
        step.outputPath = result.outputPath;
        Object.assign(state, result.patch ?? {});
        task.state = { ...state };
        if (result.resultKind) task.resultKind = result.resultKind;
        if (result.outputPath) task.resultPath = result.outputPath;
        task.updatedAt = Date.now();
        saveTask(task);
        emit(step, { percent: 100, message: undefined });
      } catch (e: unknown) {
        const message = e instanceof Error ? e.message : String(e);
        step.status = "failed";
        step.error = message;
        task.status = controller.signal.aborted ? "cancelled" : "failed";
        task.updatedAt = Date.now();
        saveTask(task);
        emit(step, { message });
        opts.onProgress({ taskId: task.id, status: step.status, task: taskSnapshot(task) });
        return task;
      }
    }

    task.status = "done";
    task.updatedAt = Date.now();
    saveTask(task);
    opts.onProgress({ taskId: task.id, status: "done", task: taskSnapshot(task) });
    return task;
  } finally {
    controllers.delete(taskId);
    runningTaskId = null;
  }
}
