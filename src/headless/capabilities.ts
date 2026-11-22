/**
 * capabilities — headless 作业的能力包装：扁平参数 → 原模块调用。
 *
 * 原模块一律**动态 import**：入口已在最早时刻 setupUserDataDir()，
 * 但 genie-manager 这类模块 import 即建目录/单例（test-genie-install-env.cjs
 * 记录过的坑），动态 import 保证顺序永远是「数据目录先就位」。
 *
 * 进度统一成 emit({percent?, message?})；产物路径口径与 GUI 一致
 * （下载进 agent/materials，合成进设置的 outputDir，文本产物进 agent/output），
 * params.outDir 有值时覆盖默认。
 */
import fs from "node:fs";
import path from "node:path";
import { currentDataDir } from "../main/userData";
import type { ComposeRequest, VideoResolution } from "../shared/dialogue-types";
import type { JobKind } from "./jobs";

export interface CapContext {
  jobId: string;
  signal: AbortSignal;
  emit: (p: { percent?: number; message?: string }) => void;
}

export interface CapResult {
  note: string;
  outputPath?: string;
  resultKind?: "video" | "audio" | "text";
  /** 顺带给调用方的结构化信息（写进 job 文件的 data 字段） */
  data?: Record<string, unknown>;
}

type Emit = CapContext["emit"];

const str = (v: unknown): string => String(v ?? "").trim();
const num = (v: unknown): number => (Number.isFinite(Number(v)) ? Number(v) : 0);

function agentRoot(): string {
  return path.join(currentDataDir(), "agent");
}
function outputRoot(): string {
  return path.join(agentRoot(), "output");
}
function resolveOutDir(params: Record<string, unknown>, fallback: string): string {
  const p = str(params.outDir);
  return p || fallback;
}

export async function parseLink(link: string, signal: AbortSignal): Promise<CapResult> {
  if (!link) throw new Error("把分享文本或链接贴进来（link）——抖音 / 快手 / B站 / 小红书都行。");
  const { parseMedia } = await import("../main/parser");
  const meta = await parseMedia(link);
  signal.throwIfAborted();
  return {
    note: `${meta.title || "未命名"} · ${fmtDuration(meta.duration)}`,
    data: {
      meta: {
        platform: meta.platform,
        title: meta.title,
        author: meta.author,
        duration: meta.duration,
        playUrl: meta.playUrl,
      },
    },
  };
}

async function downloadJob(params: Record<string, unknown>, signal: AbortSignal, emit: Emit): Promise<CapResult> {
  const link = str(params.link);
  if (!link) throw new Error("把分享文本或链接贴进来（link）。");
  emit({ message: "正在解析链接…" });
  const { parseMedia } = await import("../main/parser");
  const meta = await parseMedia(link);
  signal.throwIfAborted();
  const { downloadVideo, safeFileName } = await import("../main/downloader");
  const dir = resolveOutDir(params, path.join(agentRoot(), "materials"));
  fs.mkdirSync(dir, { recursive: true });
  const savePath = path.join(
    dir,
    `${safeFileName(meta.author)}-${safeFileName(meta.title, 30)}-${meta.id}.mp4`
  );
  emit({ message: "正在下载原片…" });
  let lastPct = -1;
  await downloadVideo({
    url: meta.playUrl,
    savePath,
    platform: meta.platform,
    audioUrl: meta.audioUrl,
    signal,
    onProgress: (p) => {
      if (p.percent === lastPct) return;
      lastPct = p.percent;
      emit({
        percent: p.percent,
        message: p.stage === "merge" ? "正在合并音视频…" : `下载中 ${p.percent}%`,
      });
    },
  });
  if (!fs.existsSync(savePath)) throw new Error("下载结束了但没看到文件，换个链接或重试一次。");
  return {
    note: `已下载原片 · ${meta.title || "未命名"}`,
    outputPath: savePath,
    resultKind: "video",
    data: { videoPath: savePath },
  };
}

async function transcribeJob(params: Record<string, unknown>, signal: AbortSignal, emit: Emit): Promise<CapResult> {
  const videoPath = str(params.inputPath);
  if (!videoPath) throw new Error("要识别的文件没给（inputPath，音视频文件的完整路径）。");
  if (!fs.existsSync(videoPath)) throw new Error(`文件找不到了：${videoPath}`);
  const language = str(params.language) || "zh";
  emit({ message: "正在识别文案（本地跑，不联网）…" });
  const { transcribeVideo } = await import("../main/transcribe");
  const r = await transcribeVideo({
    videoPath,
    language,
    signal,
    onProgress: (p) => emit({ message: p.line ? `识别中：${p.line}` : "正在识别文案…" }),
  });
  const text = (r.text ?? "").trim();
  if (!text) throw new Error("没识别出文案，这段可能没有人声。");
  const dir = resolveOutDir(params, path.dirname(videoPath));
  fs.mkdirSync(dir, { recursive: true });
  const out = path.join(dir, "transcript.txt");
  fs.writeFileSync(out, text, "utf-8");
  return { note: `${text.length} 字`, outputPath: out, resultKind: "text", data: { transcript: text } };
}

async function writeScriptJob(params: Record<string, unknown>, signal: AbortSignal, emit: Emit): Promise<CapResult> {
  const topic = str(params.topic);
  const transcript = str(params.transcript);
  if (!topic && !transcript) throw new Error("给个主题（topic），或先用 baoluo_transcribe 出文案我照着改。");
  emit({ message: "AI 正在写对话脚本…" });
  const { writeDialogueScript } = await import("../main/agent/script-writer");
  const script = await writeDialogueScript({
    topic,
    transcript: transcript || undefined,
    durationSeconds: num(params.durationSeconds) || 45,
  });
  const dir = resolveOutDir(params, outputRoot());
  fs.mkdirSync(dir, { recursive: true });
  const out = path.join(dir, "script.txt");
  fs.writeFileSync(out, script, "utf-8");
  return {
    note: `${script.split("\n").filter(Boolean).length} 行`,
    outputPath: out,
    resultKind: "text",
    data: { script },
  };
}

async function ttsJob(
  params: Record<string, unknown>,
  signal: AbortSignal,
  emit: Emit,
  jobId: string
): Promise<CapResult> {
  const text = str(params.text);
  if (!text) throw new Error("把要念的文字写进来（text）。");
  // 音色不传就落宝螺设置的默认甲方音色（与 compose_dialogue 同一口径）
  let voice = str(params.voice);
  if (!voice) {
    const { getSettings } = await import("../main/dialogue/settings");
    voice = getSettings().voiceFortune;
  }
  if (!voice) throw new Error("没给音色（voice），宝螺设置里也没有默认音色 —— 给 voice 传一个，比如 zh-CN-XiaoxiaoNeural。");
  // 引擎的产物名固定（line_000.mp3）—— 默认目录按作业分子目录，不然两次作业互相覆盖
  const dir = path.join(resolveOutDir(params, outputRoot()), "tts", jobId);
  fs.mkdirSync(dir, { recursive: true });
  emit({ message: `正在合成语音（${text.length} 字）…` });

  // 克隆音色走本机 Genie（语速由模型决定），在线音色走 Edge
  const { cloneIdFromVoice, findCloneVoice, synthCloneSingle } = await import(
    "../main/dialogue/clone-voice"
  );
  const cloneId = cloneIdFromVoice(voice);
  let resultPath = "";
  if (cloneId) {
    let cv;
    try {
      cv = findCloneVoice(cloneId);
    } catch {
      throw new Error(`找不到克隆音色 ${cloneId} —— 到宝螺「设置 → 声音克隆」确认它存在，或者换在线音色。`);
    }
    const r = await synthCloneSingle({ voice: cv, text, outputDir: dir, timeoutMs: 120_000 });
    resultPath = r.path;
  } else {
    const { prosodyPercent, TtsEngine } = await import("../main/dialogue/tts");
    const r = await new TtsEngine({
      outputDir: dir,
      betweenDelayMs: 0,
      timeoutMs: 120_000,
      maxRetries: 2,
    }).generateSingle({
      index: 0,
      text,
      voice,
      rate: prosodyPercent(num(params.rate)),
      pitch: prosodyPercent(0),
      volume: prosodyPercent(0),
    });
    if (!r?.path) throw new Error("语音合成失败，请稍后重试。");
    resultPath = r.path;
  }
  if (!resultPath || !fs.existsSync(resultPath)) throw new Error("语音合成失败，请稍后重试。");
  return { note: `${text.length} 字`, outputPath: resultPath, resultKind: "audio" };
}

async function composeDialogueJob(
  params: Record<string, unknown>,
  signal: AbortSignal,
  emit: Emit,
  jobId: string
): Promise<CapResult> {
  const inlineScript = str(params.script);
  const scriptPath = str(params.scriptPath);
  let script = inlineScript;
  if (!script && scriptPath) {
    if (!fs.existsSync(scriptPath)) throw new Error(`脚本文本找不到了：${scriptPath}`);
    script = fs.readFileSync(scriptPath, "utf-8").trim();
  }
  if (!script) throw new Error("给脚本文本（script），或给脚本文件路径（scriptPath）。");

  let imageFortune = str(params.imageFortune);
  let imageCustomer = str(params.imageCustomer);
  if (!imageFortune || !imageCustomer) {
    // 没给图就落内置模板的两张形象图（与「对话模式」页出厂默认同源）
    const { builtinTemplateConfig } = await import("../main/dialogue/builtin-template");
    const cfg = builtinTemplateConfig();
    imageFortune = imageFortune || cfg.imageFortune || "";
    imageCustomer = imageCustomer || cfg.imageCustomer || "";
  }
  if (!imageFortune || !imageCustomer) {
    throw new Error("还缺人物图：给 imageFortune / imageCustomer 各传一张角色图的完整路径（内置形象图也没找到）。");
  }
  for (const [label, p] of [["甲方图", imageFortune], ["乙方图", imageCustomer]] as const) {
    if (!fs.existsSync(p)) throw new Error(`${label}找不到了：${p}`);
  }

  const { getSettings, getAppSettings } = await import("../main/dialogue/settings");
  const dw = getSettings();
  const app = getAppSettings();
  const { defaultOutputDir } = await import("../main/dialogue/compose");
  const outputDir = resolveOutDir(params, app.outputDir?.trim() || defaultOutputDir());
  fs.mkdirSync(outputDir, { recursive: true });

  const req: ComposeRequest = {
    name: str(params.name) || `mcp_${jobId}`,
    mode: "dialogue",
    resolution: (str(params.resolution) === "landscape" ? "landscape" : "portrait") as VideoResolution,
    script,
    imageFortune,
    imageCustomer,
    outputDir,
    voiceFortune: str(params.voiceFortune) || dw.voiceFortune,
    voiceCustomer: str(params.voiceCustomer) || dw.voiceCustomer,
    prosody: {
      a: {
        rate: num(params.rateA) || dw.prosody.a.rate,
        pitch: num(params.pitchA) || dw.prosody.a.pitch,
        volume: num(params.volumeA) || dw.prosody.a.volume,
      },
      b: {
        rate: num(params.rateB) || dw.prosody.b.rate,
        pitch: num(params.pitchB) || dw.prosody.b.pitch,
        volume: num(params.volumeB) || dw.prosody.b.volume,
      },
      narrator: dw.prosody.narrator,
    },
    // 运镜与「对话模式」页出厂默认一致：推近 25%
    motionMode: "zoom-in",
    motionAmount: 25,
    motionA: { mode: "zoom-in", amount: 25 },
    motionB: { mode: "zoom-in", amount: 25 },
    subtitle: dw.subtitle,
  };

  emit({ message: "正在逐句配音 + 拼接画面…" });
  const { runCompose, cancelCompose } = await import("../main/dialogue/compose");
  const requestId = `mcp-${jobId}`;
  // 合成是整条链路最慢的一步，取消要能真的打断它
  const onAbort = () => cancelCompose(requestId);
  signal.addEventListener("abort", onAbort);
  try {
    const r = await runCompose({ ...req, requestId });
    return { note: `已生成 · ${path.basename(r.outputPath)}`, outputPath: r.outputPath, resultKind: "video" };
  } finally {
    signal.removeEventListener("abort", onAbort);
  }
}

async function sniffJob(params: Record<string, unknown>, signal: AbortSignal, emit: Emit, jobId: string): Promise<CapResult> {
  const link = str(params.link);
  if (!link) throw new Error("拆解爆款要先把链接贴进来（link）。");
  const { runSniff } = await import("../main/sniff/pipeline");
  const { renderSniffReport } = await import("../main/sniff/format");
  const rec = await runSniff({
    link,
    niche: str(params.niche) || undefined,
    requestId: `mcp-${jobId}`,
    signal,
    onStage: (stage, message) => emit({ message }),
  });
  const report = renderSniffReport(rec);
  const dir = resolveOutDir(params, outputRoot());
  fs.mkdirSync(dir, { recursive: true });
  const out = path.join(dir, "爆款拆解.txt");
  fs.writeFileSync(out, report, "utf-8");
  return {
    note: `${rec.analysis.trigger} · ${rec.source.title.slice(0, 14)}`,
    outputPath: out,
    resultKind: "text",
    data: { topics: rec.analysis.topics ?? [], analysis: rec.analysis },
  };
}

async function writeStoryboardJob(
  params: Record<string, unknown>,
  signal: AbortSignal,
  emit: Emit
): Promise<CapResult> {
  const topic = str(params.topic);
  if (!topic) throw new Error("给个主题或热点（topic），我才知道要写什么。");
  const resolution = (str(params.resolution) === "landscape" ? "landscape" : "portrait") as VideoResolution;
  emit({ message: "AI 正在写分镜与画面提示词…" });
  const { generateAiDraft } = await import("../main/storyboard/ai");
  const draft = await generateAiDraft(
    { topic, resolution, durationSeconds: num(params.durationSeconds) || 60 },
    (_phase, message) => emit({ message }),
    signal
  );
  const { createStoryboard } = await import("../main/storyboard/store");
  const sb = createStoryboard(draft, null, resolution);
  const dir = resolveOutDir(params, outputRoot());
  fs.mkdirSync(dir, { recursive: true });
  const out = path.join(dir, "分镜提示词.txt");
  const lines = sb.shots.map(
    (s: any, i: number) => `第 ${i + 1} 镜（${s.durationHint ?? "?"} 秒）\n旁白：${s.caption}\n生图：${s.imagePrompt}`
  );
  fs.writeFileSync(
    out,
    [`标题：${sb.title}`, `钩子：${sb.hook}`, `风格：${sb.style}`, "", ...lines].join("\n"),
    "utf-8"
  );
  return { note: `${sb.shots.length} 镜`, outputPath: out, resultKind: "text", data: { storyboardId: sb.id } };
}

async function generateImageJob(
  params: Record<string, unknown>,
  signal: AbortSignal,
  emit: Emit
): Promise<CapResult> {
  const prompt = str(params.prompt);
  if (!prompt) throw new Error("把画面描述写进来（prompt）。");
  const { currentImageProvider, generateImageForPrompt } = await import("../main/imagegen");
  if (currentImageProvider() !== "modelscope") {
    throw new Error(
      "当前生图引擎是豆包 —— 豆包要在宝螺界面里用（登录 + 浏览器窗口），headless 只支持 ModelScope。" +
        "到宝螺「设置 → 生图」把引擎切到 ModelScope 并填好 ms- 访问令牌，再试。"
    );
  }
  emit({ message: "ModelScope 正在生图…" });
  const img = await generateImageForPrompt(prompt, {
    resolution: str(params.resolution) === "landscape" ? "landscape" : "portrait",
    timeoutMs: 300_000,
    signal,
    onPhase: (m) => emit({ message: m }),
  });
  const dir = path.join(resolveOutDir(params, outputRoot()), "images");
  fs.mkdirSync(dir, { recursive: true });
  const out = path.join(dir, `img_${Date.now().toString(36)}${img.ext || ".png"}`);
  fs.writeFileSync(out, Buffer.from(img.base64, "base64"));
  return { note: "已生成图片", outputPath: out };
}

/** 作业 kind → 能力函数的总分派 */
export async function runJob(
  kind: JobKind,
  params: Record<string, unknown>,
  ctx: CapContext
): Promise<CapResult> {
  switch (kind) {
    case "download":
      return downloadJob(params, ctx.signal, ctx.emit);
    case "transcribe":
      return transcribeJob(params, ctx.signal, ctx.emit);
    case "write_script":
      return writeScriptJob(params, ctx.signal, ctx.emit);
    case "tts":
      return ttsJob(params, ctx.signal, ctx.emit, ctx.jobId);
    case "compose_dialogue":
      return composeDialogueJob(params, ctx.signal, ctx.emit, ctx.jobId);
    case "sniff":
      return sniffJob(params, ctx.signal, ctx.emit, ctx.jobId);
    case "write_storyboard":
      return writeStoryboardJob(params, ctx.signal, ctx.emit);
    case "generate_image":
      return generateImageJob(params, ctx.signal, ctx.emit);
    default:
      throw new Error(`不认识的作业类型：${String(kind)}`);
  }
}

/** 两位数的时长秒 → 「1分23秒」 */
function fmtDuration(seconds: number): string {
  const s = Math.max(0, Math.round(seconds));
  if (s < 60) return `${s}秒`;
  return `${Math.floor(s / 60)}分${String(s % 60).padStart(2, "0")}秒`;
}
