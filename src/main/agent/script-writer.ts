/*
 * SPDX-License-Identifier: GPL-3.0-only
 * Copyright (c) 2026 宝螺 / Baoluo contributors
 * 本文件属于「宝螺 / Baoluo」。除 GPL-3.0 外还适用 ADDITIONAL_TERMS.md 里的附加条款：
 * 分发时须保留来源署名；修改版对外分发时不得沿用「宝螺」名称与图标。
 */
/**
 * 「写对话脚本」这一步：拿主题（或一段现成文案）让当前配置的大模型写成双人对话。
 *
 * 这是整条工作流里**唯一**要花 token 的地方——其他步骤都是确定性代码。
 * 提示词的写法：甲方问、乙方答，短句、能念得顺。
 */
import { net } from "electron";
import { withNetworkRetry } from "../net-retry";
import * as settings from "../dialogue/settings";

const REQUEST_TIMEOUT_MS = 120_000;

export interface DialogueScriptRequest {
  /** 主题，如「事业运」；给了 transcript 时可以只当补充说明 */
  topic: string;
  /** 参考文案（从原视频里提的），有就照着改写成对话 */
  transcript?: string;
  /** 目标时长（秒），AI 据此决定行数 */
  durationSeconds?: number;
}

/**
 * 时长 → 行数的换算：合成出来的片子，一句的长度 ≈ 这句的字数 ÷ 念稿速度，
 * 句与句之间还有约 1 秒的停顿（crossfade 那条路径给每段开头垫的静音）。
 *
 * 系数是用真实成片校准的（deepseek + Edge 音色，横版两人对话）：
 *   30s 目标 → 脚本 116 字 → 成片 28.1s；120s 目标 → 脚本 433 字 → 成片 106.7s，
 *   也就是含停顿的整片速度约 4.1 字/秒。模型基本照计划字数写（差 5% 以内），
 *   所以直接按 4.1 字/秒计划最准（3.8 会短 6~11%，4.2 会长 10% 上下）。
 */
const SPEAK_CHARS_PER_SEC = 4.1;
const CHARS_PER_LINE = 18;
const MIN_LINES = 4;
const MAX_LINES = 32;

/** 目标秒数换算成「多少字 / 多少行」；秒数不合法时用原来那套（约 45 秒） */
export function scriptLengthFor(durationSeconds?: number): {
  totalChars: number;
  lines: number;
} {
  const sec =
    durationSeconds && durationSeconds > 0 ? Math.round(durationSeconds) : 45;
  const totalChars = Math.round(sec * SPEAK_CHARS_PER_SEC);
  const lines = Math.max(
    MIN_LINES,
    Math.min(MAX_LINES, Math.round(totalChars / CHARS_PER_LINE))
  );
  return { totalChars, lines };
}

/** 把「要几行、多少字」写进系统提示词：模型对行数和字数的感觉比对秒数准得多 */
function systemPrompt(durationSeconds?: number): string {
  const { totalChars, lines } = scriptLengthFor(durationSeconds);
  return `你是短视频脚本写手，专写"甲方 / 乙方"的双人对话口播稿。

要求：
1. 每一行都是「说话人：内容」，说话人只用「甲方」和「乙方」两个，交替出现。
2. 一共 ${lines} 行（可以差一两行），每句 10~25 个字，能直接念出来。
3. 全篇念出来的总字数控制在 ${totalChars} 字上下（不含说话人名和冒号），这是成片的时长依据。
4. 开头一句要抓人（戳痛点或反常识），中间给具体可感的解释，最后给一句安心的收尾。
5. 说人话，不要术语堆砌，不要"首先/其次"，不要念稿感。
6. 只输出脚本本身，一行一句，不要任何解释、标题、编号或 Markdown 符号。`;
}

/** 去掉模型偶尔带出来的代码块、编号、多余空行，保证是一行一句的干净脚本 */
export function normalizeScript(raw: string): string {
  const text = (raw ?? "").replace(/```[a-zA-Z]*\n?/g, "").replace(/```/g, "");
  const lines = text
    .split(/\r?\n/)
    .map((l) => l.trim().replace(/^\d+[.、)]\s*/, ""))
    .filter(Boolean);
  const kept = lines.filter((l) => /[:：]/.test(l));
  return (kept.length >= 2 ? kept : lines).join("\n");
}

export async function writeDialogueScript(req: DialogueScriptRequest): Promise<string> {
  const s = settings.getSettings();
  if (!s.apiKey?.trim()) {
    throw new Error("还没配置 AI 服务（API Key），请先到「设置 → AI 服务」填写。");
  }
  const base = (s.baseUrl || "https://api.deepseek.com/v1").replace(/\/+$/, "");
  const duration = req.durationSeconds && req.durationSeconds > 0 ? Math.round(req.durationSeconds) : 45;
  const { lines } = scriptLengthFor(duration);

  const userText = [
    req.topic ? `主题：${req.topic}` : "",
    `目标时长：念完约 ${duration} 秒，所以按 ${lines} 行来写。`,
    req.transcript
      ? `参考文案（保持原意，改写成对话）：\n${req.transcript.slice(0, 1200)}`
      : "",
  ]
    .filter(Boolean)
    .join("\n");

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
            { role: "system", content: systemPrompt(duration) },
            { role: "user", content: userText },
          ],
          temperature: 1.0,
          // 行数多时别让输出被截在半句上：每行留 40 token，再给点余量
          max_tokens: Math.min(4000, 200 + lines * 40),
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
      if (res.status === 401) throw new Error("AI 服务鉴权失败（Key 无效，或这个服务商不需要 Key），请到「设置 → AI 服务」检查。");
      throw new Error(`写脚本失败（HTTP ${res.status}）${detail ? "：" + detail : ""}`);
    }
    const data = (await res.json()) as {
      choices?: Array<{ message?: { content?: string | null; reasoning_content?: string | null } }>;
    };
    const raw = data.choices?.[0]?.message ?? {};
    const script = normalizeScript(String(raw.content ?? "").trim() || String(raw.reasoning_content ?? ""));
    if (!script) throw new Error("AI 没有返回内容，再点一次「重写」试试。");
    return script;
  } catch (e: unknown) {
    if (e instanceof Error && e.name === "AbortError") {
      throw new Error("写脚本超时了（超过 2 分钟），检查一下网络再试。");
    }
    throw e;
  } finally {
    clearTimeout(timer);
  }
}
