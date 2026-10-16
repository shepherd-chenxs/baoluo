/*
 * SPDX-License-Identifier: GPL-3.0-only
 * Copyright (c) 2026 宝螺 / Baoluo contributors
 * 本文件属于「宝螺 / Baoluo」。除 GPL-3.0 外还适用 ADDITIONAL_TERMS.md 里的附加条款：
 * 分发时须保留来源署名；修改版对外分发时不得沿用「宝螺」名称与图标。
 */
/**
 * AI 意图分类：规则分流拿不准时，把用户这句话交给配置好的模型判一次。
 *
 * 边界（按产品要求）：只做「听懂指令 + 抽主题」，不闲聊、不执行、不编造内容。
 * 输出是一个受约束的小 JSON（intent + topic），解析走全项目统一的 parseAiJson。
 *
 * 失败策略：没配 Key / 请求失败 / 超时 / 返回不可信 → 一律返回 null，
 * 由调用方（router.parseInstructionSmart）退回规则结果。AI 是增强，不是依赖。
 */
import { net } from "electron";
import { withNetworkRetry } from "../net-retry";
import { parseAiJson } from "../ai-json";
import * as settings from "../dialogue/settings";
import type { AgentIntent } from "../../shared/agent-types";

/** 分类是小事：15 秒足够，等久了不如直接退回规则结果 */
const REQUEST_TIMEOUT_MS = 15_000;

/** 模型能选的意图（unknown 也算一种答案：模型明确说"我也没听懂"） */
const INTENTS: AgentIntent[] = [
  "dialogue-video",
  "narration-video",
  "voice-convert",
  "tts",
  "asr",
  "sniff",
  "unknown",
];

function systemPrompt(): string {
  return `你是视频创作工具「宝螺」的指令分流器。用户说一句话，你判断他想用哪个功能，并抽出主题。

可选功能（intent 只能填这些英文值）：
- dialogue-video：做一个「甲方/乙方双人对话」形式的视频
- narration-video：做一个「单人图文解说」形式的视频（一张图一段旁白，AI 出分镜）
- voice-convert：把已有音视频里的人声换成另一个音色重新念
- tts：把一段文字念成音频
- asr：把音视频文件识别成文字
- sniff：拆解一段爆款视频、总结可复用的方法
- unknown：以上都不像，或你拿不准

规则：
1. 只输出一个 JSON，形如 {"intent":"narration-video","topic":"职场内耗"}，不要任何解释。
2. topic 是用户真正想做的主题/对象（去掉"帮我""这个视频"之类的口水词），没有就填 ""。
3. 用户话里带「解说」「口播」「热点」「图文」→ narration-video；带「对话」「双人」「一问一答」→ dialogue-video。
4. 只给了一个主题、没提任何形式（如「职场焦虑」）→ dialogue-video（本工具的默认出片方式）。
5. 提到「拆解」「爆款」「学它」→ sniff。
6. 提到「识别/转文字/字幕」→ asr。
7. 只是想让文字发声（「念出来」「配音」）→ tts。
8. 提到「下载」「扒视频」→ unknown（本工具不解析、不下载平台视频，只能处理用户已有的本地文件）。
9. 拿不准就 unknown，不要硬猜。

【重要】下面会给一份"这句话里检测到的确定信息"。这些是程序解析出来的事实，比你的猜测可靠：
- 检测到**本地音视频文件**时：只要用户想对这段素材做处理（换声音/换音色/识别/转文字/加字幕/拆方法），
  一律选 voice-convert / asr / sniff，**不要选 dialogue-video/narration-video**——
  那些是"从头做一条新视频"，而用户手上已经有素材了。
- 只检测到**链接**、没有本地文件时：本工具无法从链接取内容，选 unknown。`;
}

export interface IntentGuess {
  intent: AgentIntent;
  topic: string;
}

/**
 * 规则层已经解析出来的确定信息。
 * 把它交给模型当"事实"用——模型从文字里猜"有没有文件"不如程序解析准，
 * 「把这声音换成小雅 D:\a.mp3」被判成 dialogue-video 就是这么来的（踩过）。
 */
export interface IntentFacts {
  /** 句子里检测到的本地音视频文件路径 */
  filePath?: string | null;
  /** 句子里检测到的链接 */
  link?: string | null;
  /** 句子里检测到的时长（秒） */
  durationSec?: number | null;
  /** 句子里检测到的画面比例 */
  resolution?: "landscape" | "portrait" | null;
}

/**
 * 把事实写成人话给模型看；没有事实就返回空串。
 * 导出是为了单测（这段拼装错了，模型会拿到空事实，判定就退化成猜）。
 */
export function factsBlock(f?: IntentFacts): string {
  if (!f) return "";
  const lines: string[] = [];
  if (f.filePath) lines.push(`- 检测到本地音视频文件：${f.filePath}`);
  if (f.link) lines.push(`- 检测到链接：${f.link}`);
  if (f.durationSec) lines.push(`- 用户要求的时长：${f.durationSec} 秒`);
  if (f.resolution) {
    lines.push(`- 用户要求的画面：${f.resolution === "landscape" ? "横版 16:9" : "竖版 9:16"}`);
  }
  if (!lines.length) return "";
  return `\n\n这句话里检测到的确定信息：\n${lines.join("\n")}`;
}

/** 解析不出可信结果时返回 null（调用方退回规则） */
function sanitize(v: unknown): IntentGuess | null {
  if (!v || typeof v !== "object") return null;
  const o = v as { intent?: unknown; topic?: unknown };
  const intent = typeof o.intent === "string" ? (o.intent.trim() as AgentIntent) : null;
  if (!intent || !INTENTS.includes(intent)) return null;
  const topic = typeof o.topic === "string" ? o.topic.trim().slice(0, 40) : "";
  return { intent, topic };
}

/**
 * 问一次模型：这句话要干什么。抛错/超时/不可信 → null。
 *
 * `facts` 是规则层已经解析出的确定信息（文件/链接/时长/比例）——
 * 交给模型当事实用，比让它从文字里猜准得多。
 */
export async function classifyIntent(text: string, facts?: IntentFacts): Promise<IntentGuess | null> {
  const trimmed = (text ?? "").trim();
  if (!trimmed) return null;
  const s = settings.getSettings();
  if (!s.apiKey?.trim()) return null;
  const base = (s.baseUrl || "https://api.deepseek.com/v1").replace(/\/+$/, "");

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  try {
    const res = await withNetworkRetry(undefined, () =>
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
            { role: "system", content: systemPrompt() },
            { role: "user", content: `用户说：${trimmed.slice(0, 500)}${factsBlock(facts)}` },
          ],
          temperature: 0,
          max_tokens: 60,
          stream: false,
        }),
      })
    );
    if (!res.ok) return null;
    const data = (await res.json()) as {
      choices?: Array<{ message?: { content?: string | null; reasoning_content?: string | null } }>;
    };
    const msg = data.choices?.[0]?.message ?? {};
    // content 优先、reasoning 仅兜底（拼接会弄脏 JSON，实测踩过）
    const raw = String(msg.content ?? "").trim() || String(msg.reasoning_content ?? "");
    if (!raw) return null;
    return sanitize(parseAiJson(raw));
  } catch {
    // 超时/断网/解析不了：静默退回规则，不打扰用户
    return null;
  } finally {
    clearTimeout(timer);
  }
}
