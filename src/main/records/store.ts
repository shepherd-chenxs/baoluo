/*
 * SPDX-License-Identifier: GPL-3.0-only
 * Copyright (c) 2026 宝螺 / Baoluo contributors
 * 本文件属于「宝螺 / Baoluo」。除 GPL-3.0 外还适用 ADDITIONAL_TERMS.md 里的附加条款：
 * 分发时须保留来源署名；修改版对外分发时不得沿用「宝螺」名称与图标。
 */
/**
 * 命名条目的落盘：userData/records/<kind>.json。
 *
 * 装两类东西：作品记录（图文解说 / 对话模式 / 爆款嗅探的历史列表）和对话模板库。
 * 它们都是"有名字、能列表、能取回的一段内容"，机制完全一样，分成两套代码没必要。
 *
 * 为什么一个 kind 一个文件：列表天然是"最近改的在前"，
 * 一次读全、改一条重写一次，简单够用（跟工作台的 tasks.json 一个思路）。
 * 数量封顶，免得文件无限长。
 */
import fs from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { app } from "electron";
import type {
  WorkRecord,
  WorkRecordKind,
  WorkRecordSaveRequest,
  WorkRecordSummary,
} from "../../shared/record-types";

/** 每一种记录最多留这么多条 */
const MAX_PER_KIND = 100;

const KINDS: WorkRecordKind[] = ["narration", "dialogue", "sniff", "template"];

export function recordsRoot(): string {
  return path.join(app.getPath("userData"), "records");
}

function kindFile(kind: WorkRecordKind): string {
  return path.join(recordsRoot(), `${kind}.json`);
}

function assertKind(kind: unknown): asserts kind is WorkRecordKind {
  if (!KINDS.includes(kind as WorkRecordKind)) throw new Error(`未知的记录类型：${String(kind)}`);
}

function readAll(kind: WorkRecordKind): WorkRecord[] {
  try {
    const raw = fs.readFileSync(kindFile(kind), "utf-8");
    const parsed = JSON.parse(raw) as WorkRecord[];
    return Array.isArray(parsed) ? parsed.filter((r) => r && typeof r.id === "string") : [];
  } catch {
    /* 文件不存在或坏了都当作空 */
    return [];
  }
}

function writeAll(kind: WorkRecordKind, list: WorkRecord[]): void {
  fs.mkdirSync(recordsRoot(), { recursive: true });
  const capped = list.slice(0, MAX_PER_KIND);
  fs.writeFileSync(kindFile(kind), JSON.stringify(capped, null, 2), "utf-8");
}

/** 列表用摘要：按最近改动倒序，不返回 payload */
export function listRecords(kind: WorkRecordKind): WorkRecordSummary[] {
  assertKind(kind);
  return readAll(kind)
    .map(({ payload: _payload, ...rest }) => rest)
    .sort((a, b) => b.updatedAt - a.updatedAt);
}

export function getRecord<T = unknown>(kind: WorkRecordKind, id: string): WorkRecord<T> | null {
  assertKind(kind);
  if (!id) return null;
  return (readAll(kind).find((r) => r.id === id) as WorkRecord<T> | undefined) ?? null;
}

/** 存一条：带 id 就更新那一条，否则新建 */
export function saveRecord(req: WorkRecordSaveRequest): WorkRecord {
  assertKind(req.kind);
  const list = readAll(req.kind);
  const now = Date.now();
  const idx = req.id ? list.findIndex((r) => r.id === req.id) : -1;
  if (idx >= 0) {
    const next: WorkRecord = {
      ...list[idx],
      title: req.title,
      subtitle: req.subtitle,
      outputPath: req.outputPath ?? list[idx].outputPath,
      payload: req.payload,
      updatedAt: now,
    };
    list[idx] = next;
    writeAll(req.kind, list);
    return next;
  }
  const created: WorkRecord = {
    id: req.id || randomUUID(),
    kind: req.kind,
    title: req.title,
    subtitle: req.subtitle,
    outputPath: req.outputPath,
    payload: req.payload,
    createdAt: now,
    updatedAt: now,
  };
  // 新的排最前，列表天然"最近做的在上"
  writeAll(req.kind, [created, ...list]);
  return created;
}

export function removeRecord(kind: WorkRecordKind, id: string): void {
  assertKind(kind);
  writeAll(
    kind,
    readAll(kind).filter((r) => r.id !== id)
  );
}
