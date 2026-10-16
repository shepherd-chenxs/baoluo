/*
 * SPDX-License-Identifier: GPL-3.0-only
 * Copyright (c) 2026 宝螺 / Baoluo contributors
 * 本文件属于「宝螺 / Baoluo」。除 GPL-3.0 外还适用 ADDITIONAL_TERMS.md 里的附加条款：
 * 分发时须保留来源署名；修改版对外分发时不得沿用「宝螺」名称与图标。
 */
/**
 * 解析 AI 返回的 JSON —— 全项目唯一的出口。
 *
 * 根源问题：格式正确性没法寄托在模型自觉上。设置里可换任意 OpenAI 兼容服务商，
 * response_format 只是"请求"，很多服务商不支持或忽略；中文模型还爱输出全角引号/
 * 冒号、键名忘加引号、代码块包裹、前后带解释。所以解析必须自己做容错。
 *
 * 层级：先直接 parse（不碰原文）；不行再上 jsonrepair（成熟库，专修 LLM 的坏 JSON）；
 * 再不行做全角字符归一后再试一轮。任何一级成功就返回，全失败抛最原始的错误（带位置信息）。
 */
import { jsonrepair } from "jsonrepair";

/** 从模型输出里剥掉代码块围栏、截出 {…} 主体（前后带解释文字也没关系） */
export function stripFenceAndExtract(text: string): string {
  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/i);
  const body = fenced ? fenced[1] : text;
  const start = body.indexOf("{");
  const end = body.lastIndexOf("}");
  if (start < 0 || end <= start) {
    throw new Error("AI 返回内容里没有 JSON 对象。");
  }
  return body.slice(start, end + 1);
}

/** 全角结构符归一：中文模型偶尔把引号/冒号/逗号写成全角。会动到字符串值里的内容，只作最后的兜底 */
function normalizeFullWidth(s: string): string {
  return s
    .replace(/﻿/g, "")
    .replace(/[“”„‟]/g, '"')
    .replace(/[‘’‚‛]/g, "'")
    .replace(/：/g, ":")
    .replace(/，/g, ",");
}

export function parseAiJson(text: string): unknown {
  const body = stripFenceAndExtract(text);
  try {
    return JSON.parse(body);
  } catch (original) {
    const candidates: string[] = [];
    try {
      candidates.push(jsonrepair(body));
    } catch {
      /* jsonrepair 修不动就算了 */
    }
    const fw = normalizeFullWidth(body);
    if (fw !== body) {
      try {
        candidates.push(jsonrepair(fw));
      } catch {
        /* 同上 */
      }
    }
    for (const c of candidates) {
      try {
        return JSON.parse(c);
      } catch {
        /* 这一级修不好，试下一级 */
      }
    }
    throw original;
  }
}
