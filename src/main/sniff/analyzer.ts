/*
 * SPDX-License-Identifier: GPL-3.0-only
 * Copyright (c) 2026 宝螺 / Baoluo contributors
 * 本文件属于「宝螺 / Baoluo」。除 GPL-3.0 外还适用 ADDITIONAL_TERMS.md 里的附加条款：
 * 分发时须保留来源署名；修改版对外分发时不得沿用「宝螺」名称与图标。
 */
/**
 * 爆款嗅探：把一段爆款视频的转写文案拆成“可复用方法”。
 * 只分析结构和方法，不产出可照搬的文案。
 */
import { net } from "electron";
import { withNetworkRetry } from "../net-retry";
import { parseAiJson } from "../ai-json";
import { VIRAL_TRIGGERS, isViralTrigger } from "../../shared/viral-triggers";
import type { SniffAnalysis } from "../../shared/sniff-types";
import * as settings from "../dialogue/settings";

const REQUEST_TIMEOUT_MS = 120_000;

const SYSTEM_PROMPT = `你是短视频爆款拆解师，专门帮创作者看懂"这条视频为什么能爆"。
请严格遵守：
1. 只输出一个 JSON 对象，不要 Markdown 代码块，不要多余解释。
2. JSON 结构：
{
  "hook": "开头 3 秒它做了什么/说了什么，让观众为什么停下（30 字内概括套路，不照抄原句）",
  "trigger": "主类型名",
  "structure": ["叙事环节1（方法层面概括）", "叙事环节2", "..."],
  "reusable": "一句话说明这条最能复用的方法",
  "commentBait": "它故意留了什么让观众想反驳/补充/支招的点",
  "topics": ["基于同一方法、适合该赛道写的 3~5 个新选题"]
}
3. trigger 只能从下面 7 类里原样选 1 个：
${VIRAL_TRIGGERS.map((t) => `- ${t}`).join("\n")}
4. 你是在拆解"方法"，不要把原文案原句抄回来。
5. 如果转写稿有残缺，基于能看到的内容给出最合理的拆解。`;

function normalize(raw: unknown): SniffAnalysis {
  const o = (raw ?? {}) as Record<string, unknown>;
  const hook = String(o.hook ?? "").trim();
  const rawTrigger = String(o.trigger ?? o.trafficType ?? o.audienceType ?? "").trim();
  const trigger = isViralTrigger(rawTrigger) ? rawTrigger : undefined;
  const structure = Array.isArray(o.structure)
    ? o.structure.map((s) => String(s ?? "").trim()).filter(Boolean).slice(0, 8)
    : [];
  const reusable = String(o.reusable ?? "").trim();
  const topics = Array.isArray(o.topics)
    ? o.topics.map((s) => String(s ?? "").trim()).filter(Boolean).slice(0, 5)
    : [];
  if (!hook || !trigger || !structure.length || !reusable || topics.length < 3) {
    throw new Error("拆解结果缺少必要字段（hook/trigger/structure/reusable/topics）。");
  }
  return {
    hook,
    trigger,
    structure,
    reusable,
    ...(String(o.commentBait ?? "").trim()
      ? { commentBait: String(o.commentBait).trim() }
      : {}),
    topics,
  };
}

export async function analyzeTranscript(input: {
  title: string;
  niche: string;
  transcript: string;
  /** 取消信号（agent 工作台用）：与内部超时一起控制这次请求 */
  signal?: AbortSignal;
}): Promise<SniffAnalysis> {
  const text = input.transcript.trim();
  if (!text) throw new Error("转写文案为空，可能视频没有口播内容，无法拆解。");
  const transcript = text.length > 8000 ? text.slice(0, 8000) : text;
  const user = `视频标题：${input.title || "未知"}
赛道（可选）：${input.niche || "未知"}
转写文案：
${transcript}`;

  const s = settings.getSettings();
  if (!s.apiKey?.trim()) {
    throw new Error("还没有配置 AI 服务（API Key），请先到「设置 → AI 服务」填写。");
  }
  const base = (s.baseUrl || "https://api.deepseek.com/v1").replace(/\/+$/, "");
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  const onExternalAbort = () => controller.abort();
  input.signal?.addEventListener("abort", onExternalAbort, { once: true });
  let lastError: Error | null = null;
  try {
    for (let attempt = 0; attempt < 2; attempt++) {
      const res = await withNetworkRetry(input.signal, () =>
        net.fetch(base + "/chat/completions", {
          method: "POST",
          signal: controller.signal,
          headers: {
            "Content-Type": "application/json",
            Authorization: `Bearer ${s.apiKey.trim()}`,
          },
          body: JSON.stringify({
            model: s.model || "deepseek-chat",
            messages: [
              { role: "system", content: SYSTEM_PROMPT },
              { role: "user", content: user },
            ],
            temperature: 0.5,
            response_format: { type: "json_object" },
            max_tokens: 4096,
            stream: false,
          }),
        })
      );
      if (!res.ok) {
        let detail = "";
        try {
          const err = (await res.json()) as { error?: { message?: string } };
          detail = err?.error?.message ?? "";
        } catch {
          /* noop */
        }
        if (res.status === 401) {
          throw new Error("AI 服务鉴权失败（Key 无效，或这个服务商不需要 Key），请到「设置 → AI 服务」检查。");
        }
        throw new Error(`AI 服务请求失败（HTTP ${res.status}）${detail ? `：${detail}` : ""}`);
      }
      const data = (await res.json()) as {
        choices?: Array<{ message?: { content?: string | null; reasoning_content?: string | null } }>;
      };
      const raw = data.choices?.[0]?.message ?? {};
      // content 优先（干净 JSON），reasoning 只在 content 为空时兜底 —— 拼接会弄脏 JSON（实测踩过）
const content = String(raw.content ?? "").trim() || String(raw.reasoning_content ?? "").trim();
      if (!content.trim()) throw new Error("AI 返回为空，请稍后重试。");
      try {
        return normalize(parseAiJson(content));
      } catch (e: any) {
        lastError = e;
        if (!/JSON|缺少必要字段/.test(e?.message ?? "")) throw e;
      }
    }
  } catch (e: any) {
    // 先判"用户取消"再判超时：两个来源都抛 AbortError，顺序反了取消会被说成超时
    if (input.signal?.aborted) throw new Error("已取消");
    if (e?.name === "AbortError" || String(e?.message ?? "").includes("aborted")) {
      throw new Error("AI 拆解超时，请重试或检查网络。");
    }
    throw e;
  } finally {
    clearTimeout(timer);
    input.signal?.removeEventListener("abort", onExternalAbort);
  }
  throw lastError ?? new Error("AI 拆解结果无法解析，请重试。");
}
