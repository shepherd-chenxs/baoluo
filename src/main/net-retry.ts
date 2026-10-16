/*
 * SPDX-License-Identifier: GPL-3.0-only
 * Copyright (c) 2026 宝螺 / Baoluo contributors
 * 本文件属于「宝螺 / Baoluo」。除 GPL-3.0 外还适用 ADDITIONAL_TERMS.md 里的附加条款：
 * 分发时须保留来源署名；修改版对外分发时不得沿用「宝螺」名称与图标。
 */
/**
 * 瞬时网络错误的识别与自动重试。
 *
 * 背景：Chromium 在系统睡眠/唤醒的过渡期会把网络服务进程挂起，
 * 这期间发的请求直接失败，错误形如 `TypeError: net::ERR_NETWORK_IO_SUSPENDED`；
 * 唤醒后立刻重试就会成功 —— 这类错误不该原样抛给用户，更不该被当成"AI 出错了"。
 */
const TRANSIENT_NET_ERRORS: Array<{ pattern: RegExp; label: string }> = [
  { pattern: /ERR_NETWORK_IO_SUSPENDED/i, label: "系统刚从睡眠恢复，网络还被挂起过" },
  { pattern: /ERR_NETWORK_CHANGED/i, label: "网络刚切换过（Wi-Fi/有线）" },
  { pattern: /ERR_INTERNET_DISCONNECTED/i, label: "网络断开过" },
  { pattern: /ERR_CONNECTION_TIMED_OUT|ERR_TIMED_OUT/i, label: "连接超时" },
  { pattern: /ERR_CONNECTION_REFUSED/i, label: "目标服务拒接连接（本地网关可能没在跑）" },
];

export interface TransientNetCheck {
  transient: boolean;
  /** 给用户看的人话（不带"重试"字样，重试由调用方决定） */
  hint?: string;
}

export function describeNetworkError(e: unknown): TransientNetCheck {
  const text = `${(e as Error)?.message ?? ""} ${(e as Error)?.cause ?? ""}`;
  for (const { pattern, label } of TRANSIENT_NET_ERRORS) {
    if (pattern.test(text)) return { transient: true, hint: label };
  }
  return { transient: false };
}

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

/**
 * 带一次性自动重试的执行器：瞬时网络错误 → 等 RETRY_DELAY_MS 再试一次；
 * 用户取消（signal 已 abort）从不重试。
 */
export async function withNetworkRetry<T>(
  signal: AbortSignal | undefined,
  fn: () => Promise<T>
): Promise<T> {
  try {
    return await fn();
  } catch (e: unknown) {
    if (signal?.aborted) throw e;
    const { transient, hint } = describeNetworkError(e);
    if (!transient) throw e;
    await sleep(2_000);
    if (signal?.aborted) throw new Error("已取消");
    try {
      return await fn();
    } catch (e2: unknown) {
      // 重试还失败：带上第一手的网络状态说明，用户知道该看哪里
      if (signal?.aborted) throw new Error("已取消");
      const { hint: hint2 } = describeNetworkError(e2);
      throw new Error(`网络中断（${hint2 ?? hint ?? "瞬时网络错误"}），已自动重试仍失败，请检查网络后重试。`);
    }
  }
}
