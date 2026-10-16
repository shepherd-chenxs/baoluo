/*
 * SPDX-License-Identifier: GPL-3.0-only
 * Copyright (c) 2026 宝螺 / Baoluo contributors
 * 本文件属于「宝螺 / Baoluo」。除 GPL-3.0 外还适用 ADDITIONAL_TERMS.md 里的附加条款：
 * 分发时须保留来源署名；修改版对外分发时不得沿用「宝螺」名称与图标。
 */
/** 可引爆的 7 类观众心理：整篇只允许选 1 个主类型（v0.5 与 v0.6 共用） */
export const VIRAL_TRIGGERS = [
  "观众想纠正你",
  "观众想看结果",
  "观众想看翻车",
  "观众想辩论真伪",
  "观众想证明自己",
  "观众想给你支招",
  "观众想代入自己",
] as const;

export type ViralTrigger = (typeof VIRAL_TRIGGERS)[number];

export function isViralTrigger(value: string): value is ViralTrigger {
  return (VIRAL_TRIGGERS as readonly string[]).includes(value);
}
