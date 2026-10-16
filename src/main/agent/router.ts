/*
 * SPDX-License-Identifier: GPL-3.0-only
 * Copyright (c) 2026 宝螺 / Baoluo contributors
 * 本文件属于「宝螺 / Baoluo」。除 GPL-3.0 外还适用 ADDITIONAL_TERMS.md 里的附加条款：
 * 分发时须保留来源署名；修改版对外分发时不得沿用「宝螺」名称与图标。
 */
/**
 * 分流器：一句话指令 → 意图 + 参数。
 *
 * 规则层是「0 token 层」：@点名、关键词、链接/文件的正则提取，快且可控。
 * 规则落到 unknown 时才问模型（intent-ai.ts，只做意图分类 + 主题提取）；
 * 两边的结果都从这里构造（resultForIntent），文案与缺输入校验只有一份。
 */
import type { IntentGuess } from "./intent-ai";
import type { AgentIntent, AgentParseResult } from "../../shared/agent-types";

const MEDIA_EXT = "mp4|mov|mkv|avi|webm|flv|mp3|wav|m4a|flac|aac|ogg";

/**
 * 从指令里揪出一个 http(s) 链接。
 *
 * 本工具不做平台解析/下载，这里认链接只为两件事：
 *   1) 抽主题时把 URL 剔掉（否则主题里会混进一长串地址）；
 *   2) 用户贴了链接时给一句明确回应，而不是装作没看见。
 */
const ANY_URL_RE = /https?:\/\/[^\s'"<>，。、！？；：）】〕》」』\]}]+/i;

export function extractAnyUrl(text: string): string | null {
  if (!text) return null;
  const m = text.match(ANY_URL_RE);
  return m ? m[0].trim() : null;
}

/** 从指令里揪出一个本地音视频文件路径（拖进来或粘贴都能认） */
export function extractFilePath(text: string): string | null {
  const win = text.match(new RegExp(`[a-zA-Z]:\\\\[^\\s"'<>|]*?\\.(?:${MEDIA_EXT})`, "i"));
  if (win) return win[0];
  const posix = text.match(new RegExp(`/[^\\s"'<>|]*?\\.(?:${MEDIA_EXT})`, "i"));
  return posix ? posix[0] : null;
}

/**
 * 动作词与语气词：抽主题时要扔掉，否则「把这个链接做成对话视频」会变成一个长长的主题。
 *
 * 顺序敏感：像「做个 / 来个」这种"动词+量词"的组合必须整体列在前面。
 * 只列「做」会把「做个对话视频」削成「个对话视频」，主题就成了"个"（踩过）。
 * 「个」不能单独列进词表——主题里「个人成长」这类词会被削坏。
 */
const STOP_WORDS =
  /(帮我|给我|请|麻烦|做个|作个|来个|弄个|出个|搞个|生成|做成|做|把|这个|那个|这条|那条|这段|上面|刚才|一下|来一?条|来一?个|基于|根据|按照|用|要|我想|我要|需要|可以|能不能|视频|链接|脚本|文案|无水印|下载|提取|解析|转录|转文字|模式|风格|对话|双人|两个人|图文|解说|变声|换音色|重新配|重配|语音|合成|朗读|念一段|念一下|念一遍|读出来|转成|转|变成|讲讲|讲|聊聊|说说|话题|主题|关于|内容)/g;

/**
 * 从指令里抽「目标时长（秒）」。认得的口径：
 *   120s / 120秒 / 时长120 / 目标时长 120 / 两分钟 / 1分30秒 / 1:30 / 一分钟半
 * 抽不到返回 null（调用方用参数默认值）。
 */
export function extractDuration(text: string): number | null {
  // 中文数字先归一成阿拉伯数字，后面就只用一套规则（「两分钟」=「2分钟」）
  const CN: Record<string, string> = {
    零: "0", 一: "1", 二: "2", 两: "2", 三: "3", 四: "4",
    五: "5", 六: "6", 七: "7", 八: "8", 九: "9", 十: "10",
  };
  const cnNum = (s: string): number => {
    if (/^\d+$/.test(s)) return Number(s);
    // 「十」单用 = 10；「二十」= 20；「十五」= 15；「二十五」= 25
    const m = /^([一二两三四五六七八九])?十([一二三四五六七八九])?$/.exec(s);
    if (m) {
      const tens = m[1] ? Number(CN[m[1]]) : 1;
      const ones = m[2] ? Number(CN[m[2]]) : 0;
      return tens * 10 + ones;
    }
    return CN[s] ? Number(CN[s]) : NaN;
  };
  const t = text.replace(/([零一二两三四五六七八九十]+)\s*(?=分|秒)/g, (m) => {
    const n = cnNum(m);
    return Number.isFinite(n) ? String(n) : m;
  });

  // 1分30秒 / 2分钟 / 2分
  const minSec = t.match(/(\d+)\s*分(?:钟)?\s*(\d+)?\s*秒?/);
  if (minSec) {
    const sec = Number(minSec[1]) * 60 + (minSec[2] ? Number(minSec[2]) : 0);
    if (sec > 0) return sec;
  }
  // 1:30
  const colon = t.match(/(\d{1,2})\s*[:：]\s*(\d{2})(?!\d)/);
  if (colon) {
    const sec = Number(colon[1]) * 60 + Number(colon[2]);
    if (sec > 0) return sec;
  }
  // 120s / 120 秒 / 时长 120（带"时长/秒/s"这类信号词才认，免得把别处的数字当秒数）
  const num = t.match(/(?:目标)?时长\s*[:：]?\s*(\d{1,4})\s*(?:s|秒)?|(\d{1,4})\s*(?:s\b|秒)/i);
  if (num) {
    const sec = Number(num[1] ?? num[2]);
    // 4 小时以内的才算合理时长，超过当噪声
    if (sec > 0 && sec <= 4 * 3600) return sec;
  }
  return null;
}

/**
 * 从指令里抽「画面比例」。认得：横版/横屏/16:9/16：9 → landscape；竖版/竖屏/9:16 → portrait。
 * 抽不到返回 null（调用方用默认值）。
 */
export function extractResolution(text: string): "landscape" | "portrait" | null {
  // 16:9 这种数字写法优先（用户可能写"横板16：9"——"板"是常见错别字，一并认）
  if (/(16\s*[:：]\s*9)/.test(text)) return "landscape";
  if (/(9\s*[:：]\s*16)/.test(text)) return "portrait";
  if (/横(版|板|屏|向)/.test(text)) return "landscape";
  if (/竖(版|板|屏|向)/.test(text)) return "portrait";
  return null;
}

/**
 * 参数词：抽主题时要扔掉，别让"目标时长120s 横板16:9"混进主题。
 * 中文数字也认（「两分钟」）；量词后的「的」一起吃掉（「两分钟的」不留残渣）。
 * 「横板」的"板"是常见错别字，和"版/屏/向"一并认。
 *
 * 「分钟」写成「分[钟]?」：只写「分」时，"两分钟"会被吃成"两分"、剩个"钟"（踩过）。
 */
const PARAM_WORDS =
  /(目标)?时长\s*[:：]?\s*[\d零一二两三四五六七八九十]{1,4}\s*(?:s|秒)?|[\d零一二两三四五六七八九十]{1,4}\s*(?:s\b|秒)|[\d零一二两三四五六七八九十]{1,3}\s*分(?:钟)?[\d零一二两三四五六七八九十]{0,3}\s*秒?的?|\d{1,2}\s*[:：]\s*\d{2}(?!\d)|横(版|板|屏|向)|竖(版|板|屏|向)|16\s*[:：]\s*9|9\s*[:：]\s*16/g;

/** 抽出主题：去掉链接、文件路径、动作词、参数词后剩下的实词 */
export function extractTopic(raw: string, link: string | null, filePath: string | null): string {
  let text = raw;
  // @下载 / @对话 这些是"点名"，不是主题
  text = text.replace(/@[^\s@]+/g, " ");
  if (link) text = text.split(link).join(" ");
  if (filePath) text = text.split(filePath).join(" ");
  /*
   * 「以……为主题」这种句式先抽（必须在 STOP_WORDS 之前）：
   * 词表里有「主题」，先删的话句式就散了、匹配不到，只剩「以xx为」（踩过）。
   */
  const asTopic = /以\s*([^，。！？,.!?]{1,30}?)\s*(?:为主题|为题目|为题|为主题目)/.exec(text);
  if (asTopic && asTopic[1].trim()) {
    text = asTopic[1];
  } else {
    text = text.replace(PARAM_WORDS, " ").replace(STOP_WORDS, " ");
  }
  text = text.replace(/[，。！？、,.!?；;：:"'“”‘’（）()\[\]【】]/g, " ");
  // 被参数词/动作词切碎后残留的单个虚词（「两分钟的」→「的」），清掉
  text = text.replace(/(?:^|\s)[的了吗呢啊吧呀哦嗯]+(?=\s|$)/g, " ");
  return text.replace(/\s+/g, " ").trim().slice(0, 40);
}

/**
 * 显式点名：「@对话 事业运」里 @ 后面的词直接决定走哪条剧本，不再靠猜。
 * 输入框里打 @ 会弹出这份名单（见 WorkspaceView 的 MENTIONS）。
 */
const AT_INTENTS: Array<[RegExp, AgentIntent]> = [
  [/@(对话|双人)/, "dialogue-video"],
  [/@(图文|解说|成片|热点)/, "narration-video"],
  [/@(变声|配音)/, "voice-convert"],
  [/@(语音|朗读|念)/, "tts"],
  [/@(识别|听写|字幕)/, "asr"],
  [/@(爆款|嗅探|拆解)/, "sniff"],
];

export function intentFromMention(text: string): AgentIntent | null {
  for (const [re, intent] of AT_INTENTS) {
    if (re.test(text)) return intent;
  }
  return null;
}

/** 主题 → 对话视频 / 图文解说 */
function scripted(
  intent: "dialogue-video" | "narration-video",
  topic: string,
  extra: { durationSec?: number | null; resolution?: "landscape" | "portrait" | null } = {}
): AgentParseResult {
  const params: Record<string, string> = { topic };
  /* 用户在话里说了时长/画面比例就带上（工作台的参数默认值会被它覆盖） */
  if (extra.durationSec) params.duration = String(extra.durationSec);
  if (extra.resolution) params.resolution = extra.resolution;
  const kind = intent === "dialogue-video" ? "对话视频" : "图文解说";
  return {
    intent,
    title: `主题 → ${kind}`,
    params,
    missing: topic ? [] : ["主题"],
    summary:
      intent === "narration-video"
        ? `按「生成分镜 → 合成」走：先出旁白和每镜的画面提示词，缺图自动生图，图齐了直接合成成片。`
        : `按「写对话脚本 → 合成」走：台词和角色画面我自动配好（人物形象用模板里的），跑到「合成视频」停下，你看过脚本再点出片。`,
  };
}

/** 爆款拆解：一个本地音视频进去，一份方法论出来 */
function sniffResult(filePath: string | null): AgentParseResult {
  return {
    intent: "sniff",
    title: "音视频 → 可复用的方法",
    params: filePath ? { inputPath: filePath } : {},
    missing: filePath ? [] : ["音视频文件"],
    summary: filePath
      ? "把这段爆款拆开：开头钩子、叙事结构、可复用的方法，顺带给你几个同方法的选题。"
      : "拆解要先把音视频文件给我（拖进来或贴路径），我在本机转成文案再拆方法。",
  };
}

/**
 * 一句话 → 意图 + 参数。纯函数，不碰磁盘、不联网，方便单测。
 * 拿不准的（confident=false）交给 parseInstructionSmart 问模型。
 */
export function parseInstruction(raw: string): AgentParseResult {
  return parseByRules(raw).result;
}

/** 规则分流的结果 + 「这一版有没有把握」 */
export interface RuleParse {
  result: AgentParseResult;
  /** true = 规则已经判明白（点名/关键词命中/裸链接），不用再问模型 */
  confident: boolean;
}

export function parseByRules(raw: string): RuleParse {
  const text = (raw ?? "").trim();
  const link = extractAnyUrl(text);
  const filePath = extractFilePath(text);
  const topic = extractTopic(text, link, filePath);
  /* 话里说了时长/画面比例就抽出来（免费且快）；没说的用参数默认值 */
  const durationSec = extractDuration(text);
  const resolution = extractResolution(text);
  const extra = { durationSec, resolution };

  const wantsVoice = /变声|换声|换音色|重新配|重配|改.{0,4}声音|克隆音色/.test(text);
  const wantsTts = /语音合成|合成语音|朗读|念一遍|念一段|念一下|读出来|配音|tts/i.test(text);
  const wantsAsr = /语音识别|识别文字|转文字|转录|听写|提取文字|出字幕/.test(text);
  // 「热点成片」和「图文解说」是同一条链路：AI 出分镜（旁白 + 画面提示词）→ 用户生图 → 合成
  const wantsNarration = /图文|解说|单人口播|一张图|热点|选题|分镜|口播|成片/.test(text);
  const wantsSniff = /爆款|嗅探|拆解/.test(text);
  const wantsDialogue = /对话|双人|两个人|一问一答|你来我往/.test(text);
  // 显式 @ 点名优先于关键词猜测
  const forced = intentFromMention(text);

  // 1) 变声：必须有本地文件
  if ((wantsVoice || forced === "voice-convert") && filePath) {
    return {
      confident: true,
      result: {
        intent: "voice-convert",
        title: "音频 → 换音色重念",
        params: { inputPath: filePath },
        missing: [],
        summary: "把这段音视频里的人声识别出来，再用你选的音色重新念一遍。",
      },
    };
  }

  // 1.5) 语音识别：手上已经有本地文件了，直接出文案
  if ((forced === "asr" || wantsAsr) && filePath) {
    return {
      confident: true,
      result: {
        intent: "asr",
        title: "音视频 → 文案",
        params: { inputPath: filePath },
        missing: [],
        summary: "本地跑 Whisper，把这段话识别成文字，识别过程和结果都留在工作台里。",
      },
    };
  }

  // 2) 成片类：图文解说优先于对话（「图文解说」里也含「解说」两个字，顺序不能反）
  // 「爆款」排在前面：说「拆解这个爆款」时不该被「成片」抢走
  if (forced === "sniff" || (!forced && wantsSniff))
    return { confident: true, result: sniffResult(filePath) };
  if (forced === "narration-video" || wantsNarration)
    return { confident: true, result: scripted("narration-video", topic, extra) };
  if (forced === "dialogue-video" || wantsDialogue)
    return { confident: true, result: scripted("dialogue-video", topic, extra) };

  // 2.5) 语音合成：一段文字 → 一条音频（带文件的那种是「变声」，上面已经拦下了）
  if (forced === "tts" || (wantsTts && !filePath)) {
    return {
      confident: true,
      result: {
        intent: "tts",
        title: topic ? `${topic} → 语音` : "文字 → 语音",
        params: { text: topic },
        missing: topic ? [] : ["要念的文本"],
        summary: "按你选的音色把这段文字念出来，产物是一条音频。",
      },
    };
  }

  // 3) 只给了链接：本工具不做平台解析/下载，如实说明，不静默失败
  if (link && !filePath) {
    return {
      confident: true,
      result: {
        intent: "unknown",
        title: "这里不能从链接取视频",
        params: {},
        missing: ["音视频文件"],
        summary:
          "宝螺不解析、不下载平台视频。请先把音视频文件弄到本地，再拖进来或把路径贴给我：" +
          "「@识别」出文案、「@变声」换音色、「@爆款」拆方法。",
      },
    };
  }

  // 4) 只给了文件，没说干什么：话可能说得很随意（「把这声音换成小雅」），问模型
  if (filePath) {
    return {
      confident: false,
      result: {
        intent: "unknown",
        title: "这个文件要做什么？",
        params: { inputPath: filePath },
        missing: ["要做什么"],
        summary: `收到文件了：${filePath}\n想拿它做什么？说「变声」可以直接换音色重念。`,
      },
    };
  }

  // 5) 说了动作但缺关键输入（模型也变不出文件，不用再问）
  // 拆解类不用在这儿拦：上面第 2 步的 sniffResult 已经按「有没有文件」给了缺输入提示。
  if (forced === "voice-convert" || wantsVoice)
    return { confident: true, result: missingInput("变声需要先给一个文件", "音视频文件", "变声要先把音频或视频拖进来（或把路径贴给我）。") };
  if (forced === "asr" || wantsAsr)
    return { confident: true, result: missingInput("语音识别需要先给一个音视频文件", "音视频文件", "把音频或视频拖进来（或把路径贴给我），我在本机把它识别成文字。") };

  // 6) 光给了主题：规则只会猜「对话视频」，恰恰最容易猜错——问模型
  if (topic)
    return { confident: false, result: scripted("dialogue-video", topic, extra) };

  return { confident: false, result: noIdea() };
}

/** 动作认出来了但缺输入：统一的 unknown 结果（params 空，界面按 missing 提示） */
function missingInput(title: string, missing: string, summary: string): AgentParseResult {
  return { intent: "unknown", title, params: {}, missing: [missing], summary };
}

/** 完全没认出来的兜底话术 */
function noIdea(): AgentParseResult {
  return {
    intent: "unknown",
    title: "没太看懂这条指令",
    params: {},
    missing: ["指令"],
    summary:
      "给一个主题（我写对话脚本并成片），或给音视频文件说「变声」「识别」「拆解」，也可以给一段文字说「语音合成」。",
  };
}

/**
 * 意图 → 完整分流结果（卡片文案与缺输入校验只有一份）。
 * 规则层和 AI 层判出意图后都走这里，保证两条路产出的卡一模一样。
 */
export function resultForIntent(
  intent: AgentIntent,
  ctx: {
    topic: string;
    /** 仅作事实记录（日志用）：本工具不从链接取内容 */
    link: string | null;
    filePath: string | null;
    /** 从原话里抽到的时长/画面比例（没抽到就不带，用参数默认值） */
    durationSec?: number | null;
    resolution?: "landscape" | "portrait" | null;
  }
): AgentParseResult {
  const { topic, filePath } = ctx;
  const extra = { durationSec: ctx.durationSec, resolution: ctx.resolution };
  switch (intent) {
    case "dialogue-video":
      return scripted("dialogue-video", topic, extra);
    case "narration-video":
      return scripted("narration-video", topic, extra);
    case "sniff":
      return sniffResult(filePath);
    case "voice-convert":
      return filePath
        ? {
            intent: "voice-convert",
            title: "音频 → 换音色重念",
            params: { inputPath: filePath },
            missing: [],
            summary: "把这段音视频里的人声识别出来，再用你选的音色重新念一遍。",
          }
        : missingInput("变声需要先给一个文件", "音视频文件", "变声要先把音频或视频拖进来（或把路径贴给我）。");
    case "asr":
      return filePath
        ? {
            intent: "asr",
            title: "音视频 → 文案",
            params: { inputPath: filePath },
            missing: [],
            summary: "本地跑 Whisper，把这段话识别成文字，识别过程和结果都留在工作台里。",
          }
        : missingInput("语音识别需要先给一个音视频文件", "音视频文件", "把音频或视频拖进来（或把路径贴给我），我在本机把它识别成文字。");
    case "tts":
      return {
        intent: "tts",
        title: topic ? `${topic} → 语音` : "文字 → 语音",
        params: { text: topic },
        missing: topic ? [] : ["要念的文本"],
        summary: "按你选的音色把这段文字念出来，产物是一条音频。",
      };
    default:
      return noIdea();
  }
}

/**
 * 规则 + AI 的完整分流：规则拿不准时问一次配置好的模型（只做意图分类 + 主题提取）。
 * 模型出错/超时/没配 Key 都静默退回规则结果——AI 是增强，不是依赖。
 *
 * intent-ai 用动态 import：它顶层依赖 electron/settings，同步分流路径（含单测）
 * 不该被它牵连进 electron 环境；只有真要问模型时才加载。
 */
export async function parseInstructionSmart(raw: string): Promise<AgentParseResult> {
  const { result, confident } = parseByRules(raw);
  if (confident) return result;
  const text = (raw ?? "").trim();
  /* 规则层已经抽出来的确定信息：当事实喂给模型，比让它从文字里猜准得多 */
  const link = extractAnyUrl(text);
  const filePath = extractFilePath(text);
  const durationSec = extractDuration(text);
  const resolution = extractResolution(text);
  let guess: IntentGuess | null = null;
  try {
    const { classifyIntent } = await import("./intent-ai");
    guess = await classifyIntent(text, { link, filePath, durationSec, resolution });
  } catch {
    /* 模型不可用：按规则的结果走，功能不炸 */
  }
  if (!guess) return result;
  if (guess.intent === "unknown") {
    // 模型也认不出：规则本来给的就是 unknown（比如只给了文件）就保留它，
    // 规则硬猜出来的卡（主题→对话）换成兜底话术，别建一张没根据的卡
    return result.intent === "unknown" ? result : noIdea();
  }
  /*
   * 留一条判定记录：AI 判错时能追溯"它当时看到什么、判成什么"。
   * 规则与 AI 结论不一致时前面加个 ⚠，扫日志一眼能挑出来。
   */
  const disagree = result.intent !== guess.intent && result.intent !== "unknown";
  console.info(
    `[agent/intent-ai]${disagree ? " ⚠ 与规则不一致" : ""} 原话="${text.slice(0, 60)}" ` +
      `规则=${result.intent} AI=${guess.intent} topic="${guess.topic}" ` +
      `事实={file:${filePath ? "有" : "无"}, link:${link ? "有" : "无"}, dur:${durationSec ?? "-"}, res:${resolution ?? "-"}}`
  );
  const topic = guess.topic || extractTopic(text, link, filePath);
  /* 时长/画面比例仍从原话里抽（模型只判意图和主题，这两项规则更稳） */
  return resultForIntent(guess.intent, {
    topic,
    link,
    filePath,
    durationSec: extractDuration(text),
    resolution: extractResolution(text),
  });
}

/** 意图 → 中文名（界面、日志里用） */
export function intentLabel(intent: AgentIntent): string {
  switch (intent) {
    case "dialogue-video":
      return "对话视频";
    case "narration-video":
      return "图文解说";
    case "voice-convert":
      return "变声";
    case "tts":
      return "语音合成";
    case "asr":
      return "语音识别";
    case "sniff":
      return "爆款拆解";
    default:
      return "待确认";
  }
}
