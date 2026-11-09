/**
 * llm —— 所有"要模型写一段字"的地方的唯一出口。
 *
 * 从前这些活（分镜、对话脚本、爆款拆解、意图识别）各自直连 OpenAI 兼容接口，
 * 于是没填 API Key 就整条流程瘫在那儿。现在改成两条路，按顺序挑：
 *
 *   1) 「设置 → 运行时」应用了某个 CLI（Codex / Claude Code / Gemini）→ 交给它跑。
 *      这是首选：用户已经登录过、模型也配过，不用再买一份 Key。
 *   2) 没接运行时、但「设置 → AI 服务」填了 Key → 走老路（保留，做兜底）。
 *
 * 两条路对上层是同一个函数：给 system + user，要回一段文本（或者一段 JSON 文本）。
 * 传输细节、报错措辞、取消/超时都在这里收口，业务代码不用再关心走的是哪条。
 */
import { net } from "electron";
import { withNetworkRetry } from "./net-retry";
import * as settings from "./dialogue/settings";
import { RUNTIME_LABELS, type RuntimeId } from "../shared/runtime-types";
import type { LlmRoute } from "../shared/llm-types";
import { runRuntimeOneShot } from "./runtime/chat";

export type { LlmRoute, LlmSource } from "../shared/llm-types";

const NO_ROUTE_MESSAGE =
  "还没有能写文案的模型：到「设置 → 运行时」应用一个（推荐），或到「设置 → AI 服务」填个 Key。";

/** 当前会走哪条路（同步读设置，不探测 CLI——探测是调用时的事） */
export function llmRoute(): LlmRoute {
  const activeId = (settings.getAppSettings().runtime?.activeId ?? null) as RuntimeId | null;
  if (activeId) {
    return { source: "runtime", runtimeId: activeId, label: RUNTIME_LABELS[activeId] ?? activeId };
  }
  const s = settings.getSettings();
  if (s.apiKey?.trim()) {
    return {
      source: "api",
      runtimeId: null,
      label: `AI 服务 · ${s.model || "默认模型"}`,
    };
  }
  return { source: "none", runtimeId: null, label: "", message: NO_ROUTE_MESSAGE };
}

export interface LlmRequest {
  system: string;
  user: string;
  /** 要 JSON：CLI 那边没有 response_format，只能明确叮嘱一句 */
  json?: boolean;
  temperature?: number;
  maxTokens?: number;
  timeoutMs?: number;
  signal?: AbortSignal;
  /** 报错时用来说明是在干什么：「写分镜」 */
  label?: string;
}

const DEFAULT_TIMEOUT_MS = 180_000;

/** 给运行时的提示词：system 和 user 拼成一段（CLI 只吃一段 stdin） */
function promptFor(req: LlmRequest): string {
  const jsonRule = req.json
    ? `【输出格式】只输出一个 JSON 对象：以 { 开头、} 结尾，键名和字符串值都用半角双引号；
不要 Markdown 代码块（\`\`\`），不要在 JSON 前后写任何解释。`
    : "";
  return [req.system.trim(), jsonRule, req.user.trim()].filter(Boolean).join("\n\n");
}

/**
 * 跑一次生成，返回模型给的原文（没解析）。
 * 失败一定抛错——上层要么重试，要么把这句话原样显示给用户。
 */
export async function llmComplete(req: LlmRequest): Promise<string> {
  const route = llmRoute();
  if (route.source === "none") throw new Error(route.message ?? NO_ROUTE_MESSAGE);

  const timeoutMs = req.timeoutMs ?? DEFAULT_TIMEOUT_MS;

  if (route.source === "runtime") {
    try {
      const run = await runRuntimeOneShot(promptFor(req), {
        timeoutMs,
        signal: req.signal,
      });
      const text = run.text.trim();
      if (!text) throw new Error(`运行时「${run.label}」返回了空内容。`);
      return text;
    } catch (e: any) {
      if (req.signal?.aborted) throw new Error("已取消");
      /*
       * 运行时彻底起不来（被卸载 / 路径变了），而老的 AI 服务还留着 Key：
       * 别让用户白等一轮——静默退回兜底那条路，终端里留一句现场。
       * 只对"根本起不来"生效；超时/格式问题照样抛，免得等 4 分钟后悄悄换了模型。
       */
      if (/起不来|还没应用/.test(e?.message ?? "") && settings.getSettings().apiKey?.trim()) {
        console.warn("[llm] 运行时不可用，退回 AI 服务：", e.message);
        return apiComplete(req, timeoutMs);
      }
      throw e;
    }
  }

  return apiComplete(req, timeoutMs);
}

/* ------------------------------------------------------------------ *
 * 老路：OpenAI 兼容接口（没有接运行时的机器继续用）
 * ------------------------------------------------------------------ */

function trimBase(baseUrl: string): string {
  return (baseUrl || "https://api.deepseek.com/v1").replace(/\/+$/, "");
}

async function apiComplete(req: LlmRequest, timeoutMs: number): Promise<string> {
  const s = settings.getSettings();
  const base = trimBase(s.baseUrl);
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  const onExternalAbort = () => controller.abort();
  req.signal?.addEventListener("abort", onExternalAbort, { once: true });
  try {
    const res = await withNetworkRetry(req.signal, () =>
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
            { role: "system", content: req.system },
            { role: "user", content: req.user },
          ],
          temperature: req.temperature ?? 0.8,
          ...(req.json ? { response_format: { type: "json_object" } } : {}),
          max_tokens: req.maxTokens ?? 4096,
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
        /* 拿不到细节就用状态码 */
      }
      if (res.status === 401) {
        throw new Error("AI 服务鉴权失败（Key 无效，或这个服务商不需要 Key），请到「设置 → AI 服务」检查。");
      }
      throw new Error(`${req.label ?? "AI 服务"}请求失败（HTTP ${res.status}）${detail ? `：${detail}` : ""}`);
    }
    const data = (await res.json()) as {
      choices?: Array<{ message?: { content?: string | null; reasoning_content?: string | null } }>;
    };
    const raw = data.choices?.[0]?.message ?? {};
    // content 优先（干净 JSON）；reasoning 只在 content 为空时兜底 —— 拼接会弄脏 JSON（实测踩过）
    const content = String(raw.content ?? "").trim() || String(raw.reasoning_content ?? "").trim();
    if (!content) throw new Error("AI 返回为空，请稍后重试。");
    return content;
  } catch (e: any) {
    // 先判"用户取消"再判超时：两边都抛 AbortError，顺序反了取消会被说成超时
    if (req.signal?.aborted) throw new Error("已取消");
    if (e?.name === "AbortError" || String(e?.message ?? "").includes("aborted")) {
      throw new Error(`${req.label ?? "AI 生成"}超时，请重试或检查网络。`);
    }
    throw e;
  } finally {
    clearTimeout(timer);
    req.signal?.removeEventListener("abort", onExternalAbort);
  }
}
