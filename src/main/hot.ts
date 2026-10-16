/*
 * SPDX-License-Identifier: GPL-3.0-only
 * Copyright (c) 2026 宝螺 / Baoluo contributors
 * 本文件属于「宝螺 / Baoluo」。除 GPL-3.0 外还适用 ADDITIONAL_TERMS.md 里的附加条款：
 * 分发时须保留来源署名；修改版对外分发时不得沿用「宝螺」名称与图标。
 */
/**
 * 热点雷达：聚合各平台公开热榜，无需登录凭证。
 * 数据源与解析逻辑参考作者另一项目的同类实现，全部为公开接口直连。
 */
import type { HotItem, HotSource } from "../shared/storyboard-types";
import { fetchJson } from "./http";

export const HOT_SOURCES: HotSource[] = [
  { key: "douyin", name: "抖音" },
  { key: "weibo", name: "微博" },
  { key: "zhihu", name: "知乎" },
  { key: "baidu", name: "百度" },
  { key: "toutiao", name: "头条" },
  { key: "bilibili", name: "B站" },
];

const CACHE_TTL_MS = 120_000;
const cache = new Map<string, { at: number; items: HotItem[] }>();

function sourceName(key: string): string {
  return HOT_SOURCES.find((s) => s.key === key)?.name ?? key;
}

function trimText(s: string): string {
  return s.split(/\s+/).filter(Boolean).join(" ");
}

async function weibo(): Promise<Array<[string, string, string]>> {
  const v = await fetchJson(
    "https://weibo.com/ajax/side/hotSearch",
    { Referer: "https://weibo.com/" }
  );
  const realtime = Array.isArray(v?.data?.realtime) ? v.data.realtime : [];
  const items: Array<[string, string, string]> = [];
  for (const it of realtime) {
    const word = String(it?.word ?? "").trim();
    if (!word) continue;
    const heat = it?.num != null ? String(it.num) : "";
    const url = `https://s.weibo.com/weibo?q=${encodeURIComponent("#" + word + "#")}`;
    items.push([word, heat, url]);
  }
  return items;
}

async function zhihu(): Promise<Array<[string, string, string]>> {
  const v = await fetchJson("https://api.zhihu.com/topstory/hot-list?limit=50");
  const list = Array.isArray(v?.data) ? v.data : [];
  const items: Array<[string, string, string]> = [];
  for (const it of list) {
    const title = String(it?.target?.title ?? "").trim();
    if (!title) continue;
    // api.zhihu.com/questions/123 → www.zhihu.com/question/123
    const raw = String(it?.target?.url ?? "");
    const last = String(raw).split("/").filter(Boolean).pop() ?? "";
    const url = last
      ? `https://www.zhihu.com/question/${last}`
      : "https://www.zhihu.com/hot";
    items.push([trimText(title), String(it?.detail_text ?? ""), url]);
  }
  return items;
}

async function douyin(): Promise<Array<[string, string, string]>> {
  const v = await fetchJson(
    "https://www.douyin.com/aweme/v1/web/hot/search/list/?source=6&pc_client_type=1",
    { Referer: "https://www.douyin.com/" }
  );
  const list = Array.isArray(v?.data?.word_list) ? v.data.word_list : [];
  const items: Array<[string, string, string]> = [];
  for (const it of list) {
    const word = String(it?.word ?? "").trim();
    if (!word) continue;
    const heat = it?.hot_value != null ? String(it.hot_value) : "";
    items.push([word, heat, String(it?.event_url ?? "")]);
  }
  return items;
}

/** 递归收集 JSON 中所有带 "word" 字段的对象（百度热榜结构嵌套不稳定，用此兜底） */
function collectWordObjects(value: unknown, out: Array<Record<string, unknown>>): void {
  if (Array.isArray(value)) {
    for (const v of value) collectWordObjects(v, out);
    return;
  }
  if (value && typeof value === "object") {
    const o = value as Record<string, unknown>;
    if (typeof o.word === "string") out.push(o);
    for (const k of Object.keys(o)) collectWordObjects(o[k], out);
  }
}

async function baidu(): Promise<Array<[string, string, string]>> {
  const v = await fetchJson("https://top.baidu.com/api/board?platform=wise&tab=realtime");
  const objs: Array<Record<string, unknown>> = [];
  collectWordObjects(v?.data?.cards, objs);
  const items: Array<[string, string, string]> = [];
  for (const it of objs) {
    const word = String(it.word ?? "").trim();
    if (!word) continue;
    const heat = it.hot_score != null ? String(it.hot_score) : "";
    items.push([trimText(word), heat, String(it.url ?? "")]);
  }
  return items;
}

async function toutiao(): Promise<Array<[string, string, string]>> {
  const v = await fetchJson("https://www.toutiao.com/hot-event/hot-board/?origin=toutiao_pc");
  const list = Array.isArray(v?.data) ? v.data : [];
  const items: Array<[string, string, string]> = [];
  for (const it of list) {
    const title = String(it?.Title ?? "").trim();
    if (!title) continue;
    const heat = it?.HotValue != null ? String(it.HotValue) : "";
    items.push([trimText(title), heat, String(it?.Url ?? "")]);
  }
  return items;
}

async function bilibili(): Promise<Array<[string, string, string]>> {
  const v = await fetchJson(
    "https://api.bilibili.com/x/web-interface/search/square?limit=50",
    { Referer: "https://www.bilibili.com/" }
  );
  const list = Array.isArray(v?.data?.trending?.list) ? v.data.trending.list : [];
  const items: Array<[string, string, string]> = [];
  for (const it of list) {
    const raw = String(it?.show_name ?? it?.keyword ?? "").trim().replace(/^#+|#+$/g, "");
    if (!raw || raw === "#") continue;
    const heat = it?.hot_score != null ? String(it.hot_score) : "";
    items.push([raw, heat, `https://search.bilibili.com/all?keyword=${encodeURIComponent(raw)}`]);
  }
  return items;
}

async function fetchRaw(key: string): Promise<Array<[string, string, string]>> {
  switch (key) {
    case "weibo":
      return weibo();
    case "zhihu":
      return zhihu();
    case "douyin":
      return douyin();
    case "baidu":
      return baidu();
    case "toutiao":
      return toutiao();
    case "bilibili":
      return bilibili();
    default:
      throw new Error(`未知的热榜源：${key}`);
  }
}

export function getHotSources(): HotSource[] {
  return HOT_SOURCES.map((s) => ({ ...s }));
}

export async function getHotList(key: string): Promise<HotItem[]> {
  if (!HOT_SOURCES.some((s) => s.key === key)) {
    throw new Error(`未知的热榜源：${key}`);
  }
  const hit = cache.get(key);
  if (hit && Date.now() - hit.at < CACHE_TTL_MS) {
    return hit.items.map((i) => ({ ...i }));
  }

  const raw = await fetchRaw(key);
  if (!raw.length) {
    throw new Error("热榜返回为空，该源可能暂时不可用，请稍后重试。");
  }
  const now = Date.now();
  const name = sourceName(key);
  const items: HotItem[] = raw
    .slice(0, 50)
    .map(([title, heat, url], i) => ({
      id: `${key}-${i + 1}`,
      title,
      source: name,
      rank: i + 1,
      heat,
      url,
      fetchedAt: now,
    }));
  cache.set(key, { at: now, items });
  return items.map((i) => ({ ...i }));
}
