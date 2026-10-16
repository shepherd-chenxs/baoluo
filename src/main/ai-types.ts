/*
 * SPDX-License-Identifier: GPL-3.0-only
 * Copyright (c) 2026 宝螺 / Baoluo contributors
 * 本文件属于「宝螺 / Baoluo」。除 GPL-3.0 外还适用 ADDITIONAL_TERMS.md 里的附加条款：
 * 分发时须保留来源署名；修改版对外分发时不得沿用「宝螺」名称与图标。
 */
/**
 * 「AI 服务」这一小组设置在 DialogueSettings 里的形状。
 * 单独拎出来：ai-client（主进程）和设置页（渲染进程）都要用，
 * 不想把整个 DialogueSettings（带着一堆音色/字幕字段）都拽进来。
 */
export interface AiSettings {
  apiKey: string;
  baseUrl: string;
  model: string;
}
