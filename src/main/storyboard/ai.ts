/*
 * SPDX-License-Identifier: GPL-3.0-only
 * Copyright (c) 2026 宝螺 / Baoluo contributors
 * 本文件属于「宝螺 / Baoluo」。除 GPL-3.0 外还适用 ADDITIONAL_TERMS.md 里的附加条款：
 * 分发时须保留来源署名；修改版对外分发时不得沿用「宝螺」名称与图标。
 */
/**
 * AI 分镜生成（OpenAI 兼容协议，任意服务商）：给定热点/主题 → 标题 + 钩子 + 统一风格 + 镜头列表。
 * 复用的 AI 连接配置来自「设置 → AI 服务」（settings.json 的 dialogue 分区）。
 */
import { net } from "electron";
import { withNetworkRetry } from "../net-retry";
import { parseAiJson } from "../ai-json";
import type {
  AiStoryboardDraft,
  StoryGenerateRequest,
} from "../../shared/storyboard-types";
import type { VideoResolution } from "../../shared/dialogue-types";
import { VIRAL_TRIGGERS } from "../../shared/viral-triggers";
import * as settings from "../dialogue/settings";

export type AiPhase = "thinking" | "writing" | "done" | "error";
export type OnAiPhase = (phase: AiPhase, message: string) => void;

const REQUEST_TIMEOUT_MS = 120_000;

function aspectText(resolution?: VideoResolution): string {
  return resolution === "landscape" ? "横屏 16:9" : "竖屏 9:16";
}

function buildSystemPrompt(resolution?: VideoResolution): string {
  const aspect = aspectText(resolution);
  return `你是短视频编导，帮新手自媒体人做"热点成片"方案。请严格遵守：
1. 只输出一个 JSON 对象，不要 Markdown 代码块，不要任何解释。
2. JSON 结构：
{
  "title": "发布用标题（15 字以内，抓人）",
  "hook": "开头钩子句（口播第一句，15 字以内）",
  "style": "整篇统一的画面风格描述（20 字内，如：治愈系手绘插画、暖色调）",
  "trigger": "主类型名（见第 7 条，只能从 7 类中选 1 个原词）",
  "shots": [
    { "caption": "旁白文案", "imagePrompt": "图文提示词", "durationHint": 6 },
    ...
  ]
}
3. shots 默认 5 镜左右（约 30 秒），每段 caption 是口语化旁白，约 40~70 字，能念 8~15 秒。
4. caption 不要出现"图1""大家好"这类提示词；hook 可单独成第一句，但不要和第一镜 caption 完全重复。
5. imagePrompt 用中文，覆盖：主体、场景、构图/镜头、光线氛围，并始终以"${aspect}，无文字无水印，{style}"结尾。
6. 内容要适合用 AI 静态图表达，避免新闻现场、真人肖像、明星、商标等；宁可侧面表达，不要画真人脸。
7. 从下面 7 类"观众心理"中，针对当前热点选 1 个最能引爆传播的类型，只允许选 1 个，不要贪多：
   - 观众想纠正你：抛一个看似有漏洞/有争议的判断，逼观众想反驳。
   - 观众想看结果：把期待压在一个明确的最终结果上，过程尽量吊胃口。
   - 观众想看翻车：暗示事情可能搞砸，让观众等那个"果然翻了"的时刻。
   - 观众想辩论真伪：给出反常识结论或说法，引观众查证、争论。
   - 观众想证明自己：把门槛说得不高，让观众觉得"我也能做到/我早就知道"。
   - 观众想给你支招：把方案或选择故意做得"差一口气"，引观众替你补。
   - 观众想代入自己：把痛点/处境还原成观众自己的日常，引发"这不就是我吗"。
8. 把选中的类型原样写进 JSON 根字段 "trigger"，不要改动用词。
9. 标题、hook、每段 caption 的冲突和结尾都必须持续强化这 1 个类型；只服务一个主类型，避免同时满足多个。`;
}

function normalizeDraft(raw: unknown): AiStoryboardDraft {
  const o = (raw ?? {}) as Record<string, unknown>;
  const shots = Array.isArray(o.shots)
    ? o.shots
        .flatMap((s) => {
          const shot = (s ?? {}) as Record<string, unknown>;
          const caption = String(shot.caption ?? "").trim();
          const imagePrompt = String(shot.imagePrompt ?? "").trim();
          if (!caption || !imagePrompt) return [];
          const d = Number(shot.durationHint);
          return [{
            caption,
            imagePrompt,
            durationHint: Number.isFinite(d) && d > 0 ? d : undefined,
          }];
        })
        .slice(0, 12)
    : [];
  const title = String(o.title ?? "").trim();
  const hook = String(o.hook ?? "").trim();
  const style = String(o.style ?? "").trim();
  const rawTrigger = String(o.trigger ?? o.trafficType ?? o.audienceType ?? "").trim();
  const trigger = (VIRAL_TRIGGERS as readonly string[]).includes(rawTrigger)
    ? rawTrigger
    : undefined;
  if (!title || !hook || !trigger || !shots.length) {
    throw new Error("AI 返回的分镜缺少必要字段（标题/钩子/trigger/镜头）。");
  }
  return {
    title,
    hook,
    style,
    trigger,
    shots,
  };
}

function buildUserPrompt(req: StoryGenerateRequest): string {
  const hot = req.hot;
  const topic = hot?.title || req.topic || "";
  if (!topic.trim()) throw new Error("请先选择热点或输入主题。");
  const sourceLine = hot ? `来源：${hot.source} 热搜第 ${hot.rank} 名。` : "来源：用户自定义主题。";
  const niche = (req.niche ?? "").trim();
  const nicheLine = niche ? `内容赛道：${niche}，请按这个方向找角度。` : "没有指定赛道，请选最容易让普通观众共鸣的角度。";
  const duration = Math.max(15, Math.min(120, req.durationSeconds ?? 30));
  const method = req.method;
  const methodLine = method
    ? `仿写参考（只保留方法，不许照抄原话/原素材）：
主类型：${method.trigger}
原钩子套路：${method.hook || "无"}
原结构：${(method.structure ?? []).map((s, i) => `${i + 1}. ${s}`).join("\n") || "无"}
可复用方法：${method.reusable || "无"}`
    : "";
  return `${sourceLine}
热点/主题：${topic}
${nicheLine}
${methodLine}
目标时长：${duration} 秒，请据此安排镜头数。`;
}

/** 发送一次 chat 请求并返回原始文本 */
async function chatOnce(
  userPrompt: string,
  focus: "full" | "shot",
  context?: string,
  resolution?: VideoResolution,
  signal?: AbortSignal
): Promise<string> {
  const s = settings.getSettings();
  if (!s.apiKey?.trim()) {
    throw new Error("还没有配置 AI 服务（API Key），请先到「设置 → AI 服务」填写。");
  }
  const base = (s.baseUrl || "https://api.deepseek.com/v1").replace(/\/+$/, "");
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  const onExternalAbort = () => controller.abort();
  signal?.addEventListener("abort", onExternalAbort, { once: true });
  try {
    let system = buildSystemPrompt(resolution);
    let user = userPrompt;
    if (focus === "shot") {
      system = `你是短视频分镜提示词优化师。只输出 JSON：{"imagePrompt":"..."}，不要 Markdown。
imagePrompt 用中文描述一个静态画面的主体/场景/构图/光线，并保证${aspectText(resolution)}、无文字无水印、统一风格。`;
      user = `当前方案：
标题：${context?.split("\n")[0] ?? ""}
统一风格：${context?.split("\n")[1] ?? ""}
需要重新出图的镜头旁白：${context?.split("\n")[2] ?? ""}
请围绕这段旁白生成一条全新的画面提示词。`;
    }
    // 瞬时网络错误（睡眠唤醒/切换网络）自动重试一次；controller.signal 保证超时与取消仍然优先
    const res = await withNetworkRetry(signal, () =>
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
            { role: "system", content: system },
            { role: "user", content: user },
          ],
          temperature: 0.8,
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
    // 推理模型（GLM / R1 类）的答案可能全在 reasoning_content、content 为 null：此时才用思考区兜底。
    // **不能无脑拼接**：思考文本里的引号/大括号会把 content 里的干净 JSON 弄脏（实测踩过）。
    const raw = data.choices?.[0]?.message ?? {};
    const content = String(raw.content ?? "").trim() || String(raw.reasoning_content ?? "").trim();
    if (!content) throw new Error("AI 返回为空，请稍后重试。");
    return content;
  } catch (e: any) {
    /*
     * 顺序必须是「先看是不是用户取消」：内部超时和外部 abort 都会让 fetch 抛 AbortError，
     * 先判 AbortError 的话，用户点取消也会被翻成"AI 生成超时"。
     */
    if (signal?.aborted) throw new Error("已取消");
    if (e?.name === "AbortError" || e?.message?.includes("aborted")) {
      throw new Error("AI 生成超时，请重试或检查网络。");
    }
    throw e;
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener("abort", onExternalAbort);
  }
}

function requestContext(boardTitle: string, style: string, caption: string): string {
  return [boardTitle, style, caption].join("\n");
}

export async function generateAiDraft(
  req: StoryGenerateRequest,
  onPhase?: OnAiPhase,
  signal?: AbortSignal
): Promise<AiStoryboardDraft> {
  onPhase?.("thinking", "AI 正在理解热点与选题方向…");
  const userPrompt = buildUserPrompt(req);
  onPhase?.("writing", "正在撰写旁白与画面提示词…");

  let lastParseError: Error | null = null;
  for (let attempt = 0; attempt < 2; attempt++) {
    signal?.throwIfAborted();
    // 第二次重试时把「上次输出不合法」反馈给模型：原样再问一遍大概率还是同样的坏格式
    const prompt =
      attempt === 0
        ? userPrompt
        : `${userPrompt}
注意：上一次输出无法解析（${lastParseError?.message ?? "格式错误"}）。这次请严格只输出一个合法的 JSON 对象：以 { 开头、} 结尾，所有键名和字符串值都用半角双引号，不要 Markdown 代码块，不要任何解释。`;
    const text = await chatOnce(prompt, "full", undefined, req.resolution, signal);
    try {
      const parsed = parseAiJson(text);
      const draft = normalizeDraft(parsed);
      onPhase?.("done", "分镜生成完成");
      return draft;
    } catch (e: any) {
      lastParseError = e;
      // 留个现场：再遇到坏 JSON，终端里能直接看到模型吐了什么
      console.warn("[storyboard] AI 输出解析失败：", e?.message, "\n原文开头：\n", text.slice(0, 500));
      // JSON 解析类问题自动重试一次；连接错误直接抛给上层
      if (!/JSON|缺少必要字段/.test(e?.message ?? "")) throw e;
    }
  }
  throw lastParseError ?? new Error("AI 返回格式无法解析，请重试。");
}

export async function regenerateShotPrompt(
  boardTitle: string,
  style: string,
  caption: string,
  resolution?: VideoResolution
): Promise<{ imagePrompt: string }> {
  const text = await chatOnce("", "shot", requestContext(boardTitle, style, caption), resolution);
  const parsed = parseAiJson(text) as Record<string, unknown>;
  const imagePrompt = String(parsed.imagePrompt ?? "").trim();
  if (!imagePrompt) throw new Error("AI 返回的画面提示词为空，请重试。");
  return { imagePrompt };
}
