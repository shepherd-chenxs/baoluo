/**
 * 作品记录：图文解说 / 对话模式 / 爆款嗅探 三个页面的「历史列表」用。
 *
 * 热点成片早就有这么一份东西（方案列表），但那套是分镜专用的。
 * 这里做一个通用的：**一条记录 = 一次做完的作品**，各页把自己那份内容塞进 payload。
 *
 * 只存"索引 + 内容"，成片、原片这类大文件仍在各自目录里，记录里只留路径。
 */
import type { VideoMeta } from "./dialogue-types";

/**
 * 三类作品记录 + 两类配置库（对话模板 / 图文解说分镜模板），各存一份文件、互不干扰。
 * 模板跟作品放同一套机制里：都是"有名字、能列表、能取回的一段内容"，
 * 差别只在内容是什么（模板存的是配置，不是脚本/报告）。
 */
export type WorkRecordKind =
  | "narration"
  | "dialogue"
  | "sniff"
  | "material"
  | "template"
  | "narration-template";

/**
 * 素材捕手的一条下载记录（kind = "material"）。
 *
 * 原片不搬进来：记录只是"书签"——记住这条素材长什么样、从哪个链接来、落到哪个文件。
 * 文件被用户删了，记录还在（列表看得出来，重新下载就行）。
 */
export interface MaterialRecordPayload {
  meta: VideoMeta;
  /** 本地文件路径；解析了但没下载时为空 */
  savedPath?: string;
  /** 原始分享链接（重新打开时填回输入框，方便再解析一次） */
  source?: string;
}

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
