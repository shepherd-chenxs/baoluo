/*
 * SPDX-License-Identifier: GPL-3.0-only
 * Copyright (c) 2026 宝螺 / Baoluo contributors
 * 本文件属于「宝螺 / Baoluo」。除 GPL-3.0 外还适用 ADDITIONAL_TERMS.md 里的附加条款：
 * 分发时须保留来源署名；修改版对外分发时不得沿用「宝螺」名称与图标。
 */
/**
 * 作品记录：图文解说 / 对话模式 / 爆款嗅探 三个页面的「历史列表」用。
 *
 * 热点成片早就有这么一份东西（方案列表），但那套是分镜专用的。
 * 这里做一个通用的：**一条记录 = 一次做完的作品**，各页把自己那份内容塞进 payload。
 *
 * 只存"索引 + 内容"，成片、原片这类大文件仍在各自目录里，记录里只留路径。
 */

/**
 * 三类作品记录 + 一类配置库（对话模板），各存一份文件、互不干扰。
 * 模板跟作品放同一套机制里：都是"有名字、能列表、能取回的一段内容"，
 * 差别只在内容是什么（模板存的是配置，不是脚本/报告）。
 */
export type WorkRecordKind = "narration" | "dialogue" | "sniff" | "template";

/** 列表只用摘要，不必把整份内容读出来 */
export interface WorkRecordSummary {
  id: string;
  kind: WorkRecordKind;
  /** 列表主行：成片名 / 原视频标题 */
  title: string;
  /** 次行摘要：几镜、多长、哪个平台 */
  subtitle?: string;
  createdAt: number;
  updatedAt: number;
  /** 成片路径：有就标「已成片」，可预览、可在目录中显示 */
  outputPath?: string;
}

export interface WorkRecord<T = unknown> extends WorkRecordSummary {
  /** 各页自己的内容（脚本/场景/拆解报告…），只有点开时才需要 */
  payload: T;
}

/** 存一条：没 id 就是新建（主进程补 id 和 createdAt），有 id 就是更新 */
export interface WorkRecordSaveRequest {
  id?: string;
  kind: WorkRecordKind;
  title: string;
  subtitle?: string;
  outputPath?: string;
  payload: unknown;
}
