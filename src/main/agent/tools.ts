/*
 * SPDX-License-Identifier: GPL-3.0-only
 * Copyright (c) 2026 宝螺 / Baoluo contributors
 * 本文件属于「宝螺 / Baoluo」。除 GPL-3.0 外还适用 ADDITIONAL_TERMS.md 里的附加条款：
 * 分发时须保留来源署名；修改版对外分发时不得沿用「宝螺」名称与图标。
 */
/**
 * 工具表：任务卡里的每一步都对应这里的一个工具。
 *
 * 每个工具都是「确定性代码」——参数进来，产物出去，顺便把结果路径写回中间状态。
 * 只有 write-script 会调模型。
 *
 * 这张表同时也是将来接 LLM 规划器的接口：工具名 + 一句话描述 + 参数 schema
 * （见 TOOL_SPECS），到时候把描述喂给模型就能让它自己排步骤。
 */
import fs from "node:fs";
import path from "node:path";
import type { WebContents } from "electron";
import type {
  AgentRunState,
  AgentStep,
  AgentStepKind,
  AgentTask,
} from "../../shared/agent-types";
import type {
  ComposeRequest,
  DialogueImageScene,
  MotionMode,
  VideoResolution,
} from "../../shared/dialogue-types";
import { transcribeVideo } from "../transcribe";
import { cancelCompose, defaultOutputDir, runCompose } from "../dialogue/compose";
import { runVoiceConvert } from "../dialogue/voice-convert";
import { runSniff } from "../sniff/pipeline";
import { prosodyPercent, TtsEngine } from "../dialogue/tts";
import { cloneIdFromVoice, findCloneVoice, synthCloneSingle } from "../dialogue/clone-voice";
import type { SniffRecord } from "../../shared/sniff-types";
import type { Storyboard } from "../../shared/storyboard-types";
import { generateAiDraft } from "../storyboard/ai";
import { createStoryboard, getStoryboard, saveStoryboard } from "../storyboard/store";
import * as settings from "../dialogue/settings";
import { ensureDir } from "./store";
import { writeDialogueScript } from "./script-writer";
import { attachShotImageBytes } from "../storyboard/store";
import { generateImageForPrompt, describeImageFailure, imageProviderBlocked } from "../imagegen";

export interface AgentToolContext {
  /** 当前任务卡：上一步产出了什么，后面的步骤要跟着变（比如按镜头数补选图参数） */
  task: AgentTask;
  workDir: string;
  /** 上一步留下的东西：链接、元信息、原片路径、文案、脚本… */
  state: AgentRunState;
  signal: AbortSignal;
  webContents: WebContents;
  /** 往界面回一句话进度（渲染层显示在步骤下面） */
  emit: (p: { percent?: number; message?: string }) => void;
}

export interface AgentToolResult {
  /** 一句话结果，显示在步骤右边 */
  note?: string;
  /** 产物路径：能预览、能打开 */
  outputPath?: string;
  resultKind?: "video" | "audio" | "text";
  /** 写回中间状态，供后面的步骤用 */
  patch?: Partial<AgentRunState>;
}

export interface AgentToolSpec {
  kind: AgentStepKind;
  description: string;
  run: (ctx: AgentToolContext, step: AgentStep) => Promise<AgentToolResult>;
}

/** 读步骤参数；没有就返回空串 */
function param(step: AgentStep, key: string): string {
  return step.params?.find((p) => p.key === key)?.value?.trim() ?? "";
}

/** 数字参数：非法值当 0 */
function numParam(step: AgentStep, key: string): number {
  const n = Number(param(step, key));
  return Number.isFinite(n) ? n : 0;
}

/**
 * 带默认值的数字参数：参数不存在（老任务卡）就回落到设置里保存的那套。
 * 直接用 numParam 会把"没这个参数"当成 0，把用户调好的默认值悄悄改掉。
 */
function numOr(step: AgentStep, key: string, fallback: number): number {
  const raw = param(step, key);
  if (raw === "") return fallback;
  const n = Number(raw);
  return Number.isFinite(n) ? n : fallback;
}

/**
 * 从整张任务卡上找参数。
 * 画面比例这类「整条视频的设定」挂在第一步上，执行它的却是后面某一步，
 * 所以不能只看当前这一步的参数。
 */
function taskParam(ctx: AgentToolContext, key: string): string {
  for (const s of ctx.task.steps) {
    const v = param(s, key);
    if (v) return v;
  }
  return "";
}

/**
 * 跟 numOr 一样（缺参数就回落到默认值），但**跨步骤找**。
 * 角色/画面参数挂在「角色与画面」那一步，执行的是后面的「合成视频」，
 * 拆开之后合成这一步自己身上一个角色参数都没有。
 */
function numOrTask(ctx: AgentToolContext, key: string, fallback: number): number {
  const raw = taskParam(ctx, key);
  if (raw === "") return fallback;
  const n = Number(raw);
  return Number.isFinite(n) ? n : fallback;
}

const VC_STAGE_LABEL: Record<string, string> = {
  "model-download": "首次使用，正在下载识别模型…",
  "extract-audio": "正在提取人声…",
  transcribe: "正在识别文案…",
  synthesize: "正在逐句重新配音…",
  merge: "正在拼接…",
  done: "完成",
};

/** 提取文案（本地 Whisper，不联网） */
const transcribeTool: AgentToolSpec = {
  kind: "transcribe",
  description: "本地 Whisper 识别音视频人声，输出文案 txt",
  async run(ctx, step) {
    const videoPath = param(step, "inputPath") || ctx.state.videoPath;
    if (!videoPath) throw new Error("还没有文件：先选一个音视频。");
    if (!fs.existsSync(videoPath)) throw new Error(`文件找不到了：${videoPath}`);
    const language = param(step, "language") || "zh";
    ctx.emit({ message: "正在识别文案（本地跑，不联网）…" });
    const r = await transcribeVideo({
      videoPath,
      language,
      signal: ctx.signal,
      onProgress: (p) => {
        ctx.emit({ message: p.line ? `识别中：${p.line}` : "正在识别文案…" });
      },
    });
    const text = (r.text ?? "").trim();
    if (!text) throw new Error("没识别出文案，这段可能没有人声。");
    ensureDir(ctx.workDir);
    const out = path.join(ctx.workDir, "transcript.txt");
    fs.writeFileSync(out, text, "utf-8");
    return {
      note: `${text.length} 字`,
      outputPath: out,
      resultKind: "text",
      patch: { transcript: text },
    };
  },
};

/** 写对话脚本（唯一花 token 的一步） */
const writeScriptTool: AgentToolSpec = {
  kind: "write-script",
  description: "用配置的大模型把主题或现有文案写成 8~14 行双人对话脚本",
  async run(ctx, step) {
    const topic = param(step, "topic") || "";
    const transcript = ctx.state.transcript;
    if (!topic && !transcript) throw new Error("给个主题，或者先有文案我照着改。");
    ctx.emit({ message: "AI 正在写对话脚本…" });
    const script = await writeDialogueScript({
      topic,
      transcript,
      durationSeconds: numParam(step, "duration") || 45,
    });
    ensureDir(ctx.workDir);
    const out = path.join(ctx.workDir, "script.txt");
    fs.writeFileSync(out, script, "utf-8");
    const lines = script.split("\n").filter(Boolean).length;
    return {
      // 行数交给卡片上「脚本文案」那一行右对齐显示，这里不再重复
      note: undefined,
      outputPath: out,
      resultKind: "text",
      patch: { script },
    };
  },
};

/** 合成视频（逐句配音 + 拼画面 + 字幕） */
const composeTool: AgentToolSpec = {
  kind: "compose",
  description: "按脚本配音、配图、加字幕，合成一条 mp4",
  async run(ctx, step) {
    /*
     * 卡片上「模板配置」排在「写对话脚本」前面（跟「对话模式」页一致：先配好两个角色）。
     * 所以直接点「执行」跑到这一步时，脚本可能还没写——那就顺手写掉，
     * 并把脚本那一步标成已完成，卡片上看到的和实际发生的对得上。
     */
    let script = ctx.state.script;
    if (!script) {
      const topic = taskParam(ctx, "topic") || "";
      const transcript = ctx.state.transcript;
      if (!topic && !transcript) {
        throw new Error("还没有脚本，也没有主题：在「写对话脚本」那一步填个主题，或先跑那一步。");
      }
      ctx.emit({ message: "还没有脚本，先替你写一段…" });
      script = await writeDialogueScript({
        topic,
        transcript,
        durationSeconds: Number(taskParam(ctx, "duration")) || 45,
      });
      ctx.state.script = script;
      const scriptStep = ctx.task.steps.find((s) => s.kind === "write-script");
      if (scriptStep) {
        ensureDir(ctx.workDir);
        const out = path.join(ctx.workDir, "script.txt");
        fs.writeFileSync(out, script, "utf-8");
        scriptStep.status = "done";
        scriptStep.note = "合成时一起写的";
        scriptStep.outputPath = out;
      }
    }
    /*
     * 角色/画面参数现在挂在**上一步**（「角色与画面」）上，所以用 taskParam 跨步骤找。
     * 老卡片（拆之前建的）把它们放在这一步自己身上——taskParam 一样能找到。
     */
    const imageFortune = taskParam(ctx, "imageFortune");
    const imageCustomer = taskParam(ctx, "imageCustomer");
    if (!imageFortune || !imageCustomer) {
      /*
       * 正常情况下走不到这里：内置模板带了两张形象图，建卡时就配好了。
       * 会缺图的是这几种情况——用户把图清了、用了自己那套没存图的模板、
       * 或者内置形象图复制失败。所以文案要说清"图是可以配的"，不是"你得自己找"。
       */
      throw new Error(
        "还缺人物图：在「角色与画面」那一步给甲方/乙方各选一张（用上面的「选择模板」套回内置模板，形象图就回来了）。"
      );
    }
    for (const [label, p] of [["甲方图", imageFortune], ["乙方图", imageCustomer]] as const) {
      if (!fs.existsSync(p)) throw new Error(`${label}找不到了：${p}`);
    }
    const dw = settings.getSettings();
    const app = settings.getAppSettings();
    const outputDir = app.outputDir?.trim() || defaultOutputDir();
    ensureDir(outputDir);

    const req: ComposeRequest = {
      name: path.basename(ctx.workDir),
      mode: "dialogue",
      // 画面比例挂在第一步上，这里得从整张卡上取
      resolution: (taskParam(ctx, "resolution") || "portrait") as VideoResolution,
      script,
      imageFortune,
      imageCustomer,
      outputDir,
      voiceFortune: param(step, "voiceFortune") || dw.voiceFortune,
      voiceCustomer: param(step, "voiceCustomer") || dw.voiceCustomer,
      // 卡片上就摆在音色旁边的那三根滑杆；老卡片没有这几个参数时回落到设置里的默认
      prosody: {
        a: {
          rate: numOrTask(ctx, "rateA", dw.prosody.a.rate),
          pitch: numOrTask(ctx, "pitchA", dw.prosody.a.pitch),
          volume: numOrTask(ctx, "volumeA", dw.prosody.a.volume),
        },
        b: {
          rate: numOrTask(ctx, "rateB", dw.prosody.b.rate),
          pitch: numOrTask(ctx, "pitchB", dw.prosody.b.pitch),
          volume: numOrTask(ctx, "volumeB", dw.prosody.b.volume),
        },
        narrator: dw.prosody.narrator,
      },
      // 运镜：卡片上每个角色一套（缺省推近 25%）；全局那对是兜底
      motionMode: "zoom-in",
      motionAmount: 25,
      motionA: {
        mode: (taskParam(ctx, "motionModeA") || "zoom-in") as MotionMode,
        amount: numOrTask(ctx, "motionAmountA", 25),
      },
      motionB: {
        mode: (taskParam(ctx, "motionModeB") || "zoom-in") as MotionMode,
        amount: numOrTask(ctx, "motionAmountB", 25),
      },
      subtitle: dw.subtitle,
    };
    ctx.emit({ message: "正在逐句配音 + 拼接画面…" });
    const requestId = `agent-${Date.now()}`;
    // 合成是整条链路里最慢的一步，取消要能真的打断它（不是等它跑完再看标志位）
    const onAbort = () => cancelCompose(requestId);
    ctx.signal.addEventListener("abort", onAbort);
    let outputPath: string;
    try {
      const r = await runCompose({ ...req, requestId, webContents: ctx.webContents });
      outputPath = r.outputPath;
    } finally {
      ctx.signal.removeEventListener("abort", onAbort);
    }
    return {
      note: `已生成 · ${path.basename(outputPath)}`,
      outputPath,
      resultKind: "video",
      patch: { outputPath },
    };
  },
};

/** 截断成参数标签用的短标题 */
function shortLabel(text: string, max = 14): string {
  const t = text.replace(/\s+/g, " ").trim();
  return t.length > max ? `${t.slice(0, max)}…` : t;
}

/**
 * 生成分镜（热点成片 / 图文解说）：
 * 主题或热点 → 标题 + 钩子 + 统一风格 + 每个镜头的旁白与画面提示词。
 * 画面提示词另存一份 txt，方便用户拿去任意生图工具出图，
 * 工作台也内置了一键生图（走官方 HTTP 接口）。
 */
const writeStoryboardTool: AgentToolSpec = {
  kind: "write-storyboard",
  description: "按主题/热点写分镜：旁白 + 每镜的画面提示词，导出成可拿去生图的清单",
  async run(ctx, step) {
    const topic = param(step, "topic") || ctx.state.transcript?.slice(0, 40) || "";
    if (!topic) throw new Error("给个主题或热点，我才知道要写什么。");
    const dw = settings.getSettings();
    if (!dw.apiKey?.trim()) throw new Error("还没配置 AI 服务（API Key），请先到「设置 → AI 服务」填写。");
    const resolution = (param(step, "resolution") || "portrait") as VideoResolution;
    ctx.emit({ message: "AI 正在写分镜与画面提示词…" });
    const draft = await generateAiDraft(
      {
        topic,
        resolution,
        durationSeconds: numParam(step, "duration") || 60,
        // 从「拆解爆款」来的任务：套用那套爆款方法写自己的主题
        ...(ctx.state.sniffMethod ? { method: ctx.state.sniffMethod } : {}),
      },
      (_phase, message) => ctx.emit({ message }),
      ctx.signal
    );
    // 从工作台点热点建的任务，分镜要记下来源，「热点成片」页里才看得出是哪条热点
    const sb = createStoryboard(draft, ctx.task.hot ?? null, resolution);

    ensureDir(ctx.workDir);
    const out = path.join(ctx.workDir, "分镜提示词.txt");
    const lines = sb.shots.map((s, i) => `第 ${i + 1} 镜（${s.durationHint ?? "?"} 秒）\n旁白：${s.caption}\n生图：${s.imagePrompt}`);
    fs.writeFileSync(
      out,
      [`标题：${sb.title}`, `钩子：${sb.hook}`, `风格：${sb.style}`, "", ...lines].join("\n"),
      "utf-8"
    );

    // 分镜出来了才知道有几个镜头：下游「生图 + 合成」按镜头数补齐选图参数
    // （音色挂在第一步「生成分镜」上，不在这儿）
    const compose = ctx.task.steps.find((s) => s.kind === "compose-narration");
    if (compose) {
      compose.params = [
        ...sb.shots.map((s, i) => ({
          key: `shot-${s.id}`,
          label: `第 ${i + 1} 镜 · ${shortLabel(s.caption) || "（无旁白）"}`,
          value: s.imagePath ?? "",
          type: "image" as const,
        })),
      ];
      compose.note = `${sb.shots.length} 镜 · 执行时缺图会自动生成`;
    }

    return {
      note: `${sb.shots.length} 镜 · ${shortLabel(sb.title, 16)}`,
      outputPath: out,
      resultKind: "text",
      patch: { storyboardId: sb.id },
    };
  },
};

/**
 * 缺图的镜头自动生图：走官方 HTTP 生图接口（ModelScope），
 * 逐镜生成并把字节写回分镜（attachShotImageBytes 落盘）。
 * 跑完还有缺图就抛人话错误，卡上点「重跑」只补缺的那几镜。
 */
async function autoGenerateShots(ctx: AgentToolContext, boardId: string): Promise<void> {
  const blocked = imageProviderBlocked();
  if (blocked) throw new Error(`自动生图没法开跑：${blocked.message}`);

  const sb = getStoryboard(boardId);
  const missing = sb.shots.filter((s) => !s.imagePath);
  if (!missing.length) return;

  ctx.emit({ message: `正在用生图引擎生成 ${missing.length} 张图…` });
  const total = missing.length;
  let done = 0;
  for (const shot of missing) {
    if (ctx.signal.aborted) throw new Error("已取消生图。");
    done += 1;
    ctx.emit({
      percent: Math.round((done / total) * 100),
      message: `生图中 ${done}/${total}（第 ${sb.shots.indexOf(shot) + 1} 镜）…`,
    });
    const img = await generateImageForPrompt(shot.imagePrompt, {
      resolution: sb.resolution,
      signal: ctx.signal,
      onPhase: (m) => ctx.emit({ message: `第 ${sb.shots.indexOf(shot) + 1} 镜：${m}` }),
    });
    attachShotImageBytes(boardId, shot.id, img.base64);
  }
}

/**
 * 把分镜里已有的图写回步骤的空图参数。
 * 任务卡上的缩略图读的是参数值：生图只写 shot.imagePath 的话，
 * 卡上第二步永远是一排空框——图跟没生成一样（实测踩过）。
 */
function syncImageParams(step: AgentStep, sb: Storyboard): void {
  for (const p of step.params ?? []) {
    if (p.type !== "image" || p.value) continue;
    const shot = sb.shots.find((s) => `shot-${s.id}` === p.key);
    if (shot?.imagePath) p.value = shot.imagePath;
  }
}

/**
 * 合成解说视频：把每一镜的图 + 旁白金起来配音成片。
 * 图从两处取：工作台这一步选的，或者已经在「热点成片」页里放好的（imagePath）。
 * 缺图不再拦着让人选——自动生图补齐（走官方 HTTP 生图接口），图齐了直接合成。
 */
const composeNarrationTool: AgentToolSpec = {
  kind: "compose-narration",
  description: "把每镜的图与旁白合成一条解说视频（缺图自动生图，配音 + 字幕 + 运镜）",
  async run(ctx, step) {
    const id = ctx.state.storyboardId;
    if (!id) throw new Error("还没有分镜，先跑「生成分镜」。");
    let sb = getStoryboard(id);
    if (!sb.shots.length) throw new Error("这份分镜一个镜头都没有，重新生成一份。");

    const missingShots = () =>
      sb.shots
        .map((s, i) => ({ shot: s, index: i + 1 }))
        .filter(({ shot }) => !(param(step, `shot-${shot.id}`) || shot.imagePath || ""));

    let missing = missingShots();
    if (missing.length) {
      ctx.emit({
        message: `第 ${missing.map((m) => m.index).join("、")} 镜缺图，自动生图…`,
      });
      await autoGenerateShots(ctx, id);
      // 生好的图已写回分镜（shot.imagePath）：重读一遍再往下走
      sb = getStoryboard(id);
      missing = missingShots();
      // 生成好的图同步回参数：重跑补缺时卡上也能立刻看到已生成的缩略图
      syncImageParams(step, sb);
    }
    if (missing.length) {
      throw new Error(
        `第 ${missing.map((m) => m.index).join("、")} 镜还是没图。点「重跑」再试一次，或手动放图。`
      );
    }

    const images: DialogueImageScene[] = [];
    sb.shots.forEach((shot) => {
      const picked = param(step, `shot-${shot.id}`) || shot.imagePath || "";
      if (!fs.existsSync(picked)) throw new Error(`有一镜的图找不到了：${picked}`);
      images.push({ path: picked, text: shot.caption });
    });
    // 最终用的这批图（选的或生成的）落回参数，卡上缩略图和实际合成的画面保持一致
    (step.params ?? []).forEach((p) => {
      if (p.type !== "image") return;
      const idx = sb.shots.findIndex((s) => `shot-${s.id}` === p.key);
      if (idx >= 0) p.value = images[idx]?.path ?? p.value;
    });

    // 顺手把选中的图写回分镜：这样「热点成片」页里看到的也是同一批图
    sb.shots.forEach((shot, i) => {
      shot.imagePath = images[i].path;
    });
    sb.updatedAt = Date.now();
    saveStoryboard(sb);

    const dw = settings.getSettings();
    const app = settings.getAppSettings();
    const outputDir = app.outputDir?.trim() || defaultOutputDir();
    ensureDir(outputDir);
    // 语速挂在第一步「生成分镜」上；老任务卡没有这个参数时回落到设置里保存的值
    const narratorRateRaw = taskParam(ctx, "rateNarrator");

    const req: ComposeRequest = {
      name: sb.title || "narration",
      mode: "narration",
      resolution: sb.resolution ?? "portrait",
      // 旁白逐镜给在 images[].text 里，所以脚本留空（合成器会按老格式逐图朗读）
      script: "",
      images,
      imageFortune: images[0].path,
      imageCustomer: "",
      outputDir,
      voiceFortune: dw.voiceFortune,
      voiceCustomer: dw.voiceCustomer,
      // 音色挂在第一步「生成分镜」上，从整张卡上取；老卡片仍看这一步自己的参数
      voiceNarrator: taskParam(ctx, "voiceNarrator") || param(step, "voiceNarrator") || dw.voiceNarrator,
      narratorCount: 1,
      // 语速同样挂在第一步；老任务卡没有这个参数时回落到设置里保存的值
      prosody: {
        a: dw.prosody.a,
        b: dw.prosody.b,
        narrator:
          narratorRateRaw === ""
            ? dw.prosody.narrator
            : { ...dw.prosody.narrator, rate: Number(narratorRateRaw) || 0 },
      },
      subtitle: dw.subtitle,
    };
    ctx.emit({ message: `正在逐镜配音 + 拼接（共 ${images.length} 镜）…` });
    const requestId = `agent-${Date.now()}`;
    const onAbort = () => cancelCompose(requestId);
    ctx.signal.addEventListener("abort", onAbort);
    let outputPath: string;
    try {
      const r = await runCompose({ ...req, requestId, webContents: ctx.webContents });
      outputPath = r.outputPath;
    } finally {
      ctx.signal.removeEventListener("abort", onAbort);
    }
    return {
      note: `${images.length} 镜 · ${path.basename(outputPath)}`,
      outputPath,
      resultKind: "video",
      patch: { outputPath },
    };
  },
};

/**
 * 热点成片（无链接的图文解说同链路）：任务卡里内嵌的是「热点成片」页同一个
 * 分镜工作台（HotStoryWorkbench），选题、生图、合成都在界面侧直接操作。
 * 这个工具没有活干——它的存在只是让任务卡的「执行」有个着落、不报「没有这种工具」。
 */
const hotStoryTool: AgentToolSpec = {
  kind: "hot-story",
  description: "热点成片：分镜编辑与生图合成都内嵌在任务卡里，直接在工作台上操作",
  async run() {
    return { note: "在下面的分镜工作台里点「成片」开始" };
  },
};

/**
 * 对话视频的「角色与画面」：只管配置（甲方/乙方的图、音色、语速语调音量、运镜），
 * 真正的合成在下一步。跟 hotStoryTool 一样，工具本身没有活干——
 * 它的存在只是让任务卡上的步骤能跑过去、参数有个可编辑的落脚点。
 */
const dialogueConfigTool: AgentToolSpec = {
  kind: "dialogue-config",
  description: "对话视频的角色与画面：人物形象、音色与运镜（默认由模板配好，可改），合成在下一步",
  async run() {
    return { note: "配好两个角色就往下走" };
  },
};

/** 爆款拆解报告：摊成纯文本，工作台里直接读，也能拿去当写脚本的输入 */
function renderSniffReport(rec: SniffRecord): string {
  const a = rec.analysis;
  const lines: string[] = [
    `素材文件：${rec.source.title}`,
    `来源路径：${rec.source.path}`,
    "",
    `引爆类型：${a.trigger}`,
    `开头钩子：${a.hook}`,
    "",
    "叙事结构：",
    ...a.structure.map((s, i) => `  ${i + 1}. ${s}`),
    "",
    `可复用方法：${a.reusable}`,
  ];
  if (a.commentBait) lines.push("", `互动埋点：${a.commentBait}`);
  if (a.topics?.length) {
    lines.push("", "同方法的选题：", ...a.topics.map((t) => `  · ${t}`));
  }
  lines.push("", "——— 原片文案 ———", rec.transcript);
  return lines.join("\n");
}

/** 爆款嗅探：一个本地音视频 → 钩子 / 结构 / 可复用方法 */
const sniffTool: AgentToolSpec = {
  kind: "sniff",
  description: "拆解一段爆款：开头钩子、叙事结构、可复用方法，并给几个同方法选题",
  async run(ctx, step) {
    const filePath = param(step, "inputPath") || ctx.state.videoPath || "";
    if (!filePath) throw new Error("拆解爆款要先给一个音视频文件。");
    if (!fs.existsSync(filePath)) throw new Error(`文件找不到了：${filePath}`);
    ctx.emit({ message: "正在提取口播文案…" });
    const rec = await runSniff({
      filePath,
      niche: param(step, "niche") || undefined,
      requestId: `agent-${Date.now()}`,
      webContents: ctx.webContents,
      signal: ctx.signal,
    });
    const report = renderSniffReport(rec);
    ensureDir(ctx.workDir);
    const out = path.join(ctx.workDir, "爆款拆解.txt");
    fs.writeFileSync(out, report, "utf-8");
    return {
      note: `${rec.analysis.trigger} · ${shortLabel(rec.source.title, 14)}`,
      outputPath: out,
      resultKind: "text",
      // 选题和方法一起存下来：界面上点一个选题，紧接着就是「出分镜方案」那一步
      patch: {
        sniffReport: report,
        sniffTopics: rec.analysis.topics ?? [],
        sniffMethod: rec.analysis,
      },
    };
  },
};

/** 语音合成：一段文字 → 一条音频 */
const ttsTool: AgentToolSpec = {
  kind: "tts",
  description: "把文本用指定音色念出来，产出一条音频",
  async run(ctx, step) {
    const text = (param(step, "text") || ctx.state.transcript || "").trim();
    if (!text) throw new Error("把要念的文字写进来。");
    const voice = param(step, "voice");
    if (!voice) throw new Error("先选一个音色。");
    const outDir = path.join(ctx.workDir, "tts");
    ensureDir(outDir);
    ctx.emit({ message: `正在合成语音（${text.length} 字）…` });

    // 克隆音色走本机 Genie（语速由模型决定），在线音色走 Edge
    const cloneId = cloneIdFromVoice(voice);
    const result = cloneId
      ? await synthCloneSingle({ voice: findCloneVoice(cloneId), text, outputDir: outDir })
      : await new TtsEngine({
          outputDir: outDir,
          betweenDelayMs: 0,
          timeoutMs: 30_000,
          maxRetries: 2,
        }).generateSingle({
          index: 0,
          text,
          voice,
          rate: prosodyPercent(numParam(step, "rate")),
          pitch: prosodyPercent(0),
          volume: prosodyPercent(0),
        });
    if (!result?.path || !fs.existsSync(result.path)) throw new Error("语音合成失败，请稍后重试。");
    return {
      note: `${text.length} 字`,
      outputPath: result.path,
      resultKind: "audio",
      patch: { outputPath: result.path },
    };
  },
};

/** 变声：识别原文案 → 用目标音色重新念 */
const voiceConvertTool: AgentToolSpec = {
  kind: "voice-convert",
  description: "把音视频里的人声识别出来，用指定音色重新念一遍",
  async run(ctx, step) {
    const inputPath = param(step, "inputPath") || ctx.state.videoPath || "";
    if (!inputPath) throw new Error("先选一个音频或视频文件。");
    if (!fs.existsSync(inputPath)) throw new Error(`文件找不到了：${inputPath}`);
    const voice = param(step, "voice");
    if (!voice) throw new Error("先选一个目标音色。");
    const outputDir = path.join(ctx.workDir, "voice-convert");
    ensureDir(outputDir);
    ctx.emit({ message: "正在处理…" });
    const r = await runVoiceConvert({
      inputPath,
      voice,
      rate: numParam(step, "rate"),
      outputDir,
      requestId: `agent-${Date.now()}`,
      signal: ctx.signal,
      onProgress: (p) => {
        const base = VC_STAGE_LABEL[p.stage] ?? "正在处理…";
        const msg = p.current && p.totalLines ? `${base}（第 ${p.current}/${p.totalLines} 句）` : base;
        ctx.emit({ percent: p.percent, message: msg });
      },
    });
    return {
      note: `${r.durationSec.toFixed(1)} 秒 · ${r.doneCount}/${r.segmentCount} 句`,
      outputPath: r.audioPath,
      resultKind: "audio",
      patch: { outputPath: r.audioPath },
    };
  },
};

const TOOLS: Record<AgentStepKind, AgentToolSpec> = {
  transcribe: transcribeTool,
  "write-script": writeScriptTool,
  "write-storyboard": writeStoryboardTool,
  "dialogue-config": dialogueConfigTool,
  compose: composeTool,
  "compose-narration": composeNarrationTool,
  "hot-story": hotStoryTool,
  "voice-convert": voiceConvertTool,
  tts: ttsTool,
  sniff: sniffTool,
};

export function getTool(kind: AgentStepKind): AgentToolSpec {
  const tool = TOOLS[kind];
  if (!tool) throw new Error(`内部错误：没有叫 ${kind} 的工具。`);
  return tool;
}

/** 工具清单（给将来的 LLM 规划器和调试用） */
export function toolSpecs(): Array<{ kind: AgentStepKind; description: string }> {
  return (Object.keys(TOOLS) as AgentStepKind[]).map((k) => ({
    kind: k,
    description: TOOLS[k].description,
  }));
}
