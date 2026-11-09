/**
 * v0.6.0 爆款嗅探：把一条爆款视频的转写文案拆成“可复用方法”。
 * 只分析结构和方法，不产出可照搬的文案。
 */
import { parseAiJson } from "../ai-json";
import { VIRAL_TRIGGERS, isViralTrigger } from "../../shared/viral-triggers";
import type { SniffAnalysis } from "../../shared/sniff-types";
import { llmComplete, llmRoute } from "../llm";

const REQUEST_TIMEOUT_MS = 240_000;

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
4. 你是在拆解"方法"，不要把原文案原句抄回来，也不要评价视频本身是否违规。
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

  const route = llmRoute();
  if (route.source === "none") throw new Error(route.message ?? "还没有能写文案的模型。");

  let lastError: Error | null = null;
  for (let attempt = 0; attempt < 2; attempt++) {
    input.signal?.throwIfAborted();
    // 第二次把「上次格式不对」告诉它：原样再问一遍大概率还是同样的坏格式
    const prompt =
      attempt === 0
        ? user
        : `${user}

注意：上一次输出无法解析（${lastError?.message ?? "格式错误"}）。这次请严格只输出一个合法的 JSON 对象：以 { 开头、} 结尾，所有键名和字符串值都用半角双引号，不要 Markdown 代码块，不要任何解释。`;
    const raw = await llmComplete({
      system: SYSTEM_PROMPT,
      user: prompt,
      json: true,
      temperature: 0.5,
      maxTokens: 4096,
      timeoutMs: REQUEST_TIMEOUT_MS,
      signal: input.signal,
      label: "拆解爆款",
    });
    try {
      return normalize(parseAiJson(raw));
    } catch (e: any) {
      lastError = e;
      // 格式问题自动重试一次；连不上/取消之类直接抛给上层
      if (!/JSON|缺少必要字段/.test(e?.message ?? "")) throw e;
    }
  }
  throw lastError ?? new Error("AI 拆解结果无法解析，请重试。");
}
