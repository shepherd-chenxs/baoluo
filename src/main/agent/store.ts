/*
 * SPDX-License-Identifier: GPL-3.0-only
 * Copyright (c) 2026 宝螺 / Baoluo contributors
 * 本文件属于「宝螺 / Baoluo」。除 GPL-3.0 外还适用 ADDITIONAL_TERMS.md 里的附加条款：
 * 分发时须保留来源署名；修改版对外分发时不得沿用「宝螺」名称与图标。
 */
/**
 * 工作台任务的落盘：userData/agent/tasks.json。
 *
 * 存的是"任务卡 + 中间产物路径"，不存大文件本身——
 * 文案、脚本、成片都躺在 userData/agent 下，任务卡只是索引。
 */
import fs from "node:fs";
import path from "node:path";
import { app } from "electron";
import type { AgentTask } from "../../shared/agent-types";

/** 只保留最近这么多个任务，避免 tasks.json 无限长 */
const MAX_TASKS = 50;

export function agentRoot(): string {
  return path.join(app.getPath("userData"), "agent");
}

/** 合成出来的成片 */
export function agentOutputDir(): string {
  return path.join(agentRoot(), "output");
}

/** 单个任务的中间产物目录（文案、脚本、临时音频） */
export function taskWorkDir(id: string): string {
  return path.join(agentRoot(), "tasks", id);
}

export function tasksFile(): string {
  return path.join(agentRoot(), "tasks.json");
}

export function ensureDir(dir: string): void {
  try {
    fs.mkdirSync(dir, { recursive: true });
  } catch {
    /* 建不出来让后续的读写去报错，错误信息更具体 */
  }
}

export function newTaskId(): string {
  return `t-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`;
}

let cache: AgentTask[] | null = null;

/**
 * 老任务卡的数据迁移：参数布局是后加的字段，之前存下的卡上没有，
 * 不补的话「选图 + 合成」里解说员音色还会跟镜头挤在同一行。
 */
function normalize(task: AgentTask): AgentTask {
  for (const step of task.steps ?? []) {
    if (step.kind !== "compose-narration") continue;
    for (const p of step.params ?? []) {
      if (p.key === "voiceNarrator") p.ownLine = true;
    }
  }
  return task;
}

function load(): AgentTask[] {
  if (cache) return cache;
  try {
    const arr = JSON.parse(fs.readFileSync(tasksFile(), "utf-8")) as AgentTask[];
    cache = Array.isArray(arr) ? arr.map(normalize) : [];
  } catch {
    // 首次使用没有这个文件，或者文件坏了——都从空开始，不影响使用
    cache = [];
  }
  return cache;
}

function persist(list: AgentTask[]): void {
  try {
    ensureDir(agentRoot());
    fs.writeFileSync(tasksFile(), JSON.stringify(list.slice(0, MAX_TASKS), null, 2), "utf-8");
  } catch {
    /* 写不进去不影响本次会话 */
  }
}

export function listTasks(): AgentTask[] {
  return load()
    .slice()
    .sort((a, b) => b.updatedAt - a.updatedAt);
}

export function getTask(id: string): AgentTask | null {
  return load().find((t) => t.id === id) ?? null;
}

export function saveTask(task: AgentTask): AgentTask {
  const list = load();
  const i = list.findIndex((t) => t.id === task.id);
  if (i >= 0) list[i] = task;
  else list.unshift(task);
  list.sort((a, b) => b.updatedAt - a.updatedAt);
  if (list.length > MAX_TASKS) list.length = MAX_TASKS;
  persist(list);
  return task;
}

export function removeTask(id: string): void {
  const list = load();
  const i = list.findIndex((t) => t.id === id);
  if (i < 0) return;
  list.splice(i, 1);
  persist(list);
}
