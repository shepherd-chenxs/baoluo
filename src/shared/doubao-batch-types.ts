/**
 * 批量生图（T-003）的数据结构。
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
  /**
   * 过程留痕（不覆盖 error）：例如「组内张数不符，退回单发：这一组要 3 张，实到 2 张。」
   * 标准 5 要求写明退回单发的原因，而 error 会被后续补发的失败原因覆盖，所以单独放一个字段。
   */
  note?: string;
  /** 第几次尝试（1 起），用于「重试中」的显示 */
  attempts?: number;
  /**
   * 这一镜最终是怎么出图的：
   *   group  = 按组一次发送后归位（豆包）；
   *   single = 退回单发补发（豆包）；
   *   api    = 直接调接口出图（ModelScope 等 API 引擎，一镜一次请求）。
   */
  via?: "group" | "single" | "api";
}

export interface BatchState {
  running: boolean;
  boardId: string | null;
  /**
   * 这一轮用的生图引擎。界面据此换文案：
   * 豆包那条路是「向豆包提交了几条消息」（拼组），API 引擎是「提交了几次请求」。
   */
  provider?: ImageProviderKey;
  /** 已请求中止，但当前这一组还在跑 */
  cancelling: boolean;
  total: number;
  /** 已处理完的张数（含失败） */
  doneCount: number;
  items: BatchItem[];
  /** 结束时的人话汇总，例如「成功 3 / 共 5，失败：第 2、4 镜，已中止」 */
  summary: string;
  /**
   * 本次已向豆包提交的消息条数（T-003 标准 2）。
   * 用户要能核对「没有退化成逐张提交」：10 个缺图镜头、组大小 3 时必须 ≤ 4。
   */
  submitted: number;
  /** 本次用的组大小（研发参数，由前置实验定；界面只用来解释提交条数） */
  groupSize: number;
  /** 有几组因为「张数不符」整组退回了单发（T-003 标准 5，要留痕） */
  fallbackGroups: number;
  /** 当前阶段的提示（如「正在把 3 段提示词写进豆包…」），给界面显示用 */
  note: string;
}

export interface BatchStartResult {
  started: boolean;
  state: BatchState;
  error?: string;
  /** 机器可读的拒绝原因（界面据此决定要不要把抽屉打开，例如 not-logged-in） */
  code?: string;
}
