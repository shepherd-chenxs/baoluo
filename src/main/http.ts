/*
 * SPDX-License-Identifier: GPL-3.0-only
 * Copyright (c) 2026 宝螺 / Baoluo contributors
 * 本文件属于「宝螺 / Baoluo」。除 GPL-3.0 外还适用 ADDITIONAL_TERMS.md 里的附加条款：
 * 分发时须保留来源署名；修改版对外分发时不得沿用「宝螺」名称与图标。
 */
import { net } from "electron";

export const UA_DESKTOP =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 " +
  "(KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36";

/** 用 Electron 主进程的网络栈（net.fetch）请求公开 JSON 接口 */
export async function fetchJson(
  url: string,
  headers: Record<string, string> = {}
): Promise<any> {
  const res = await net.fetch(url, {
    headers: {
      "User-Agent": UA_DESKTOP,
      "Accept-Language": "zh-CN,zh;q=0.9",
      Accept: "application/json,text/plain,*/*",
      ...headers,
    },
  });
  if (!res.ok) throw new Error(`接口请求失败: HTTP ${res.status} ${res.statusText}`);
  return await res.json();
}
