/*
 * SPDX-License-Identifier: GPL-3.0-only
 * Copyright (c) 2026 宝螺 / Baoluo contributors
 * 本文件属于「宝螺 / Baoluo」。除 GPL-3.0 外还适用 ADDITIONAL_TERMS.md 里的附加条款：
 * 分发时须保留来源署名；修改版对外分发时不得沿用「宝螺」名称与图标。
 */
/**
 * ai-client — 主进程侧的 OpenAI 兼容小客户端。
 *
 * 只做两件事（真正的业务调用仍在 storyboard/ai.ts 等三处）：
 *   1) listModels：GET {baseUrl}/models —— 设置页"拉取模型列表"用
 *   2) testChat：  POST {baseUrl}/chat/completions（1 token 的最小请求）—— 设置页"测试连接"用
 *
 * 这样「换模型/换服务商」不用先跑一遍完整分镜才知道配没配对。
 */
import { net } from "electron";
import type { AiSettings } from "./ai-types";

function trimBase(baseUrl: string): string {
  return (baseUrl || "").trim().replace(/\/+$/, "");
}

function headers(s: AiSettings): Record<string, string> {
  const h: Record<string, string> = { "Content-Type": "application/json" };
  // 本地网关（Ollama/LM Studio）通常不需要 key：留空就不带 Authorization
  if (s.apiKey.trim()) h.Authorization = `Bearer ${s.apiKey.trim()}`;
  return h;
}

/** 把常见的失败翻成用户能看懂的话（区分连不上 / 鉴权失败 / 服务端错误） */
function describeFailure(status: number | null, detail: string): string {
  if (status === null) {
    return `连不上 AI 服务（${detail || "网络错误"}）。检查 Base URL 与端口；本地网关要先把服务跑起来。`;
  }
  if (status === 401 || status === 403) {
    return "鉴权失败：API Key 无效，或这个服务不需要/不认识这个 Key。";
  }
  if (status === 404) {
    return "路径不对（404）：确认 Base URL 以 /v1 之类结尾、且服务商支持 OpenAI 兼容接口。";
  }
  return `服务返回 HTTP ${status}${detail ? `：${detail}` : ""}`;
}

async function readError(res: Response): Promise<string> {
  try {
    const j = (await res.json()) as { error?: { message?: string }; message?: string };
    return j?.error?.message ?? j?.message ?? "";
  } catch {
    /* 响应不是 JSON 时忽略 */
  }
  try {
    return (await res.text()).slice(0, 200);
  } catch {
    return "";
  }
}

export interface AiModelListResult {
  ok: boolean;
  models: string[];
  error?: string;
}

export async function listModels(s: AiSettings, timeoutMs = 12_000): Promise<AiModelListResult> {
  const base = trimBase(s.baseUrl);
  if (!base) return { ok: false, models: [], error: "先填 Base URL。" };
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await net.fetch(base + "/models", {
      method: "GET",
      signal: controller.signal,
      headers: headers(s),
    });
    if (!res.ok) return { ok: false, models: [], error: describeFailure(res.status, await readError(res)) };
    const data = (await res.json()) as {
      data?: Array<{ id?: string }>;
      models?: Array<{ name?: string }>; // Ollama 原生 /api/tags 风格（/v1/models 也返回 data，这里兜一层）
    };
    const ids = (data.data ?? []).map((m) => m.id ?? "").filter(Boolean);
    const ollamaNames = (data.models ?? []).map((m) => m.name ?? "").filter(Boolean);
    const models = [...new Set([...ids, ...ollamaNames])].sort((a, b) => a.localeCompare(b));
    if (!models.length) return { ok: false, models: [], error: "服务没返回任何模型（可能还没拉取/加载模型）。" };
    return { ok: true, models };
  } catch (e: any) {
    const msg = e?.name === "AbortError" ? "超时" : e?.message ?? String(e);
    return { ok: false, models: [], error: describeFailure(null, msg) };
  } finally {
    clearTimeout(timer);
  }
}

export interface AiTestResult {
  ok: boolean;
  /** 成功时返回模型回的话（一般是一句应答），失败时为空 */
  reply?: string;
  error?: string;
}

/** 最小的 chat 请求：只为了验证「地址 + key + 模型名」三件套都通 */
export async function testChat(s: AiSettings, timeoutMs = 30_000): Promise<AiTestResult> {
  const base = trimBase(s.baseUrl);
  if (!base) return { ok: false, error: "先填 Base URL。" };
  if (!s.model.trim()) return { ok: false, error: "先选/填模型名。" };
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await net.fetch(base + "/chat/completions", {
      method: "POST",
      signal: controller.signal,
      headers: headers(s),
      body: JSON.stringify({
        model: s.model.trim(),
        messages: [{ role: "user", content: "回复：连接成功" }],
        // 推理模型（GLM / DeepSeek-R1 类）先输出 reasoning_content：
        // max_tokens 给太小会全部花在思考上、content 仍是 null，被误判成"没返回内容"。
        max_tokens: 512,
        stream: false,
      }),
    });
    if (!res.ok) return { ok: false, error: describeFailure(res.status, await readError(res)) };
    const data = (await res.json()) as {
      choices?: Array<{
        message?: { content?: string | null; reasoning_content?: string | null };
        finish_reason?: string;
      }>;
    };
    const msg = data.choices?.[0]?.message;
    // 推理模型的"答案"可能只落在 reasoning_content（content 为 null）：请求本身是通的
    const reply = (msg?.content ?? "") + (msg?.reasoning_content ?? "");
    if (!reply.trim()) {
      // 别把锅甩给"模型名"：推理模型 + max_tokens 太小（答案全在 reasoning 里被截断）、
    // 或者路由组导到了空响应的成员，都会走到这里。
    return {
      ok: false,
      error: "请求通了，但模型没返回文字。多半是推理模型把内容写进了思考区并被截断，换个非推理模型或稍后再试。",
    };
    }
    const note = data.choices?.[0]?.finish_reason === "length" ? "（输出被 max_tokens 截断，属正常）" : "";
    return { ok: true, reply: reply.trim().slice(0, 120) + note };
  } catch (e: any) {
    const msg = e?.name === "AbortError" ? "超时（本地大模型首响应可能较慢，可再试一次）" : e?.message ?? String(e);
    return { ok: false, error: describeFailure(null, msg) };
  } finally {
    clearTimeout(timer);
  }
}
