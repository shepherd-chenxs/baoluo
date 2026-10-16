/*
 * SPDX-License-Identifier: GPL-3.0-only
 * Copyright (c) 2026 宝螺 / Baoluo contributors
 * 本文件属于「宝螺 / Baoluo」。除 GPL-3.0 外还适用 ADDITIONAL_TERMS.md 里的附加条款：
 * 分发时须保留来源署名；修改版对外分发时不得沿用「宝螺」名称与图标。
 */
/**
 * composer — 用 ffmpeg-static 组装视频。
 *
 * 流水线：
 *   1. 把 line 级段按 sceneId 分组（对话模式每行一组，解说模式每张图一组）
 *   2. 每组：拼接本组音频 → 生成带时间轴的 .ass 字幕 → 渲染成一段视频
 *      （含 Ken Burns 推近动效 + 横版/竖版 + 图片 contain/cover 适配）
 *   3. 解说模式多组之间用 xfade/acrossfade 做交叉淡入淡出；否则 concat 拼接
 */
import fs from "node:fs";
import path from "node:path";
import type { MotionMode, SubtitleSettings, WordCue } from "../../shared/dialogue-types";
import { runFfmpeg, probeAudioDuration } from "./ffmpeg";

/** 一个 line 级视频段：文本（字幕）+ 音频 + 图片 */
export interface ComposeSegment {
  text: string;
  audioPath: string;
  imagePath: string;
  /** 同一张图的一组行共用一个 sceneId；缺省每行独立成组 */
  sceneId?: number;
  /** 该段的运镜配置；缺省用 VideoComposer 的全局配置 */
  motionMode?: MotionMode;
  motionAmount?: number;
  /** 词级时间轴（毫秒，相对本句音频起点）；只用来给字幕定时间，不做逐词高亮 */
  cues?: WordCue[];
}

export interface VideoComposerOptions {
  resolution?: { width: number; height: number };
  fps?: number;
  imageFit?: "contain" | "cover";
  /** 是否启用 Ken Burns 推近动效 */
  motion?: boolean;
  motionMode?: MotionMode;
  /** 动效幅度（百分比，默认 25） */
  motionAmount?: number;
  /** 交叉淡入淡出时长（秒） */
  transitionDuration?: number;
  preset?: string;
  crf?: number;
}

export type ComposeProgressCallback = (percent: number) => void;

/** 默认字体路径候选（Windows 自带） */
const FONT_CANDIDATES = [
  "C:/Windows/Fonts/msyh.ttc",
  "C:/Windows/Fonts/msyhbd.ttc",
  "C:/Windows/Fonts/simhei.ttf",
  "C:/Windows/Fonts/simsun.ttc",
];

function findFont(): string {
  for (const p of FONT_CANDIDATES) {
    if (fs.existsSync(p)) return p;
  }
  return "Microsoft YaHei";
}

/** ASS 颜色：&H AABBGGRR；Alpha 00=不透明, FF=透明 */
function hexToAss(hex: string, opacity = 0): string {
  const raw = (hex ?? "").trim().toLowerCase();
  // 「无色」：字幕不画底色（Alpha=FF 即全透明）
  if (raw === "transparent" || raw === "none" || raw === "") return `&HFF000000`;
  let h = raw.replace("#", "");
  if (h.length === 3) h = h.split("").map((c) => c + c).join("");
  if (h.length !== 6) return `&H00FFFFFF`;
  const r = parseInt(h.slice(0, 2), 16);
  const g = parseInt(h.slice(2, 4), 16);
  const b = parseInt(h.slice(4, 6), 16);
  const a = Math.max(0, Math.min(255, Math.round(opacity * 255)));
  return `&H${a.toString(16).padStart(2, "0")}${b.toString(16).padStart(2, "0")}${g
    .toString(16)
    .padStart(2, "0")}${r.toString(16).padStart(2, "0")}`;
}

function secToAssTime(sec: number): string {
  const h = Math.floor(sec / 3600);
  const mm = Math.floor((sec % 3600) / 60);
  const ss = (sec % 3600) % 60;
  const cs = Math.round((ss - Math.floor(ss)) * 100);
  return `${h}:${String(mm).padStart(2, "0")}:${String(Math.floor(ss)).padStart(2, "0")}.${String(cs).padStart(2, "0")}`;
}

function assDialogue(start: number, end: number, text: string): string {
  // 文本由调用方预先转义（现在没有 {\kNN} 了，但保留这条约定，免得以后加标签又踩坑）
  return `Dialogue: 0,${secToAssTime(start)},${secToAssTime(end)},Default,,0,0,0,,${text}`;
}

/** 单条字幕最大字符数上限（中文按字符计）；实际用多少由 maxCharsPerLine 按分辨率与字号算 */
const MAX_SUBTITLE_CHARS = 30;

/** 同一场景内两句解说之间的停顿（秒）。 */
const SCENE_LINE_GAP = 0.3;

/**
 * 镜头之间的停顿（秒）：加在**每一段的开头**（第一段除外）。
 *
 * 为什么加在开头而不是结尾：这一段和上一段是用 xfade/acrossfade 交叉淡化的，
 * 淡化那 0.5 秒正好落在开头的静音里——画面在停顿中淡入下一镜，
 * 上一句的尾音和下一句的开头都不会被淡化掉。实际听到的停顿 ≈ 这个值 − 淡化时长。
 */
const SCENE_LEAD_GAP_SEC = 1.2;

/**
 * 一行字幕最多放几个字：按画面宽度、字号和左右边距算。
 *
 * 以前固定 30 字（`MAX_SUBTITLE_CHARS`），竖屏 1080 宽、字号 50 时一行只放得下约 19 字，
 * 30 字的字幕在 libass 里既不换行也被裁掉——用户看到的就是「字幕没显示完」（左右都被切）。
 */
export function maxCharsPerLine(
  width: number,
  fontSize: number,
  marginL = 40,
  marginR = 40
): number {
  const usable = Math.max(120, width - marginL - marginR);
  // 中文全角字宽 ≈ 字号；留 4% 余量给描边和字距
  return Math.max(6, Math.floor(usable / (fontSize * 1.04)));
}

/** 转义 ASS 纯文本（花括号留给调用方，方便以后要加标签时不打架） */
function escapeAssPlain(text: string): string {
  return text.replace(/\\/g, "\\\\").replace(/\r?\n/g, "\\N");
}

/** 比较用归一化：去掉空白和换行，只留可见字符 */
function normalizeForCompare(text: string): string {
  return text.replace(/\s+/g, "");
}

/** 最长公共子序列长度（字符级），用来容忍 TTS 把数字/标点改写过的少量差异 */
function lcsLength(a: string, b: string): number {
  const x = Array.from(a);
  const y = Array.from(b);
  if (!x.length || !y.length) return 0;
  let prev = new Array<number>(y.length + 1).fill(0);
  let cur = new Array<number>(y.length + 1).fill(0);
  for (let i = 1; i <= x.length; i++) {
    for (let j = 1; j <= y.length; j++) {
      cur[j] = x[i - 1] === y[j - 1] ? prev[j - 1] + 1 : Math.max(prev[j], cur[j - 1]);
    }
    const swap = prev;
    prev = cur;
    cur = swap;
    cur.fill(0);
  }
  return prev[y.length];
}

/**
 * 词级时间轴和这一句的文本是不是同一句。
 *
 * 字幕文字**只从 cues 拼**（cues 带每个词的起止时间，用来切分短语和定时间）。
 * 一旦 cues 与文本不是同一句（比如沿用了别的镜头的音频/时间轴），字幕就会“张冠李戴”：
 * 声音是这一句，字幕却是另一句，甚至整句像没进字幕。所以不合就丢掉 cues，退回按文本拆分。
 */
export function cuesMatchText(cues: WordCue[], text: string): boolean {
  const joined = normalizeForCompare(cues.map((c) => c.part).join(""));
  const target = normalizeForCompare(text);
  if (!joined || !target) return false;
  if (joined === target) return true;
  return lcsLength(joined, target) / Array.from(target).length >= 0.8;
}

/**
 * 按词级时间轴生成字幕事件（时间相对本句起点，秒）：
 * - 有 cues：按标点/字数分短语，每短语一个事件——**只借 cues 定时间，不做逐词高亮**
 * - 无 cues：退回按字数均分
 *
 * 为什么不做卡拉 OK：整句同时出现、到点整句换掉，看起来最干净；
 * 逐词填充一旦和读音差一点点（词与停顿的边界很难完全准），反而像字幕在"赶"。
 */
export function buildSubtitleEntries(
  line: {
    seg: ComposeSegment;
    durationSec: number;
  },
  opts: { maxChars?: number } = {}
): AssEntry[] {
  const maxChars = Math.max(6, opts.maxChars ?? MAX_SUBTITLE_CHARS);
  const rawCues = (line.seg.cues ?? []).filter((c) => c.end > c.start && c.part.trim());
  const cues =
    rawCues.length && cuesMatchText(rawCues, line.seg.text ?? "") ? rawCues : [];
  if (rawCues.length && !cues.length) {
    // 时间轴和文本对不上：宁可丢掉逐词高亮，也不能让字幕显示成别的句子
    console.warn(
      "[composer] 字幕时间轴与文本不匹配，已退回按文本拆分：",
      JSON.stringify((line.seg.text ?? "").slice(0, 20))
    );
  }
  if (cues.length) {
    const phrases: WordCue[][] = [];
    let cur: WordCue[] = [];
    let chars = 0;
    for (const c of cues) {
      const len = [...c.part].length;
      /*
       * 先判「加上这个词会不会超行宽」，超了就把上一条收掉——
       * 老写法是加满 30 个字再切，会在词中间断开（例如「整个人都」|「在发光。」），
       * 断出来的那半句同样过宽、照样被裁。
       */
      if (cur.length && chars + len > maxChars) {
        phrases.push(cur);
        cur = [];
        chars = 0;
      }
      cur.push(c);
      chars += len;
      // 句末标点一定断句：一句话说完就换一屏
      if (/[。！？!?；;]/.test(c.part)) {
        phrases.push(cur);
        cur = [];
        chars = 0;
      }
    }
    if (cur.length) phrases.push(cur);

    return clampEntries(
      phrases.map((ph) => {
        const startSec = ph[0].start / 1000;
        const endSec = ph[ph.length - 1].end / 1000;
        const text = ph.map((c) => escapeAssPlain(c.part)).join("");
        return { text, startSec, endSec };
      }),
      line.durationSec
    );
  }

  const parts = splitSubtitleText(line.seg.text || "（无字幕）", maxChars);
  const totalChars = parts.reduce((n, p) => n + [...p].length, 0) || 1;
  const out: AssEntry[] = [];
  let t = 0;
  for (const part of parts) {
    const partLen = Math.max(1, [...part].length);
    const partEnd = t + (line.durationSec * partLen) / totalChars;
    out.push({ text: escapeAssPlain(part), startSec: t, endSec: partEnd });
    t = partEnd;
  }
  return clampEntries(out, line.durationSec);
}

/**
 * 把字幕条目夹进这一段的时间范围里。
 *
 * 为什么必须夹：字幕是按 cues（词级时间轴）排的，而画面长度是音频时长。
 * 最后一句的 cues 很可能排在音频末尾之后（实测：第 1 句最后 4 个字 start=6.06s，
 * 而这一段画面只有 5.5s）——那条字幕整条都放不出来，用户看到的就是「少了一句」。
 * 现在把它并进上一条：宁可与上一句同屏一会儿，也不丢字。
 */
function clampEntries(entries: AssEntry[], durationSec: number): AssEntry[] {
  const out: AssEntry[] = [];
  for (const e of entries) {
    const startSec = Math.max(0, Math.min(e.startSec, Math.max(0, durationSec - 0.2)));
    const endSec = Math.max(startSec + 0.05, Math.min(e.endSec, durationSec));
    if (startSec >= durationSec - 0.05 && out.length) {
      out[out.length - 1].text += e.text;
      out[out.length - 1].endSec = Math.max(out[out.length - 1].endSec, durationSec);
      continue;
    }
    out.push({ text: e.text, startSec, endSec });
  }
  return out;
}

/**
 * 把一行台词拆成多条字幕：
 * 先按换行分段，段落过长时优先在句号/感叹号/问号处断，其次逗号/顿号，
 * 最后按最大字符数硬断。
 */
export function splitSubtitleText(text: string, maxChars = MAX_SUBTITLE_CHARS): string[] {
  const limit = Math.max(6, maxChars);
  const paragraphs = text
    .split(/\r?\n/)
    .map((s) => s.trim())
    .filter(Boolean);
  if (!paragraphs.length) return ["（无字幕）"];
  const out: string[] = [];
  for (const para of paragraphs) {
    const chars = [...para];
    if (chars.length <= limit) {
      out.push(para);
      continue;
    }
    let cur = "";
    for (const ch of chars) {
      cur += ch;
      const len = [...cur].length;
      if (/[。！？!?；;]/.test(ch)) {
        out.push(cur);
        cur = "";
      } else if (/[，,、]/.test(ch) && len >= Math.min(12, limit)) {
        out.push(cur);
        cur = "";
      } else if (len >= limit) {
        out.push(cur);
        cur = "";
      }
    }
    if (cur) out.push(cur);
  }
  return out;
}

interface AssEntry {
  text: string;
  startSec: number;
  endSec: number;
}

export function writeAssFile(opts: {
  outPath: string;
  entries: AssEntry[];
  fontPath: string;
  fontSize: number;
  textColor: string;
  backgroundColor: string;
  backgroundOpacity: number;
  positionPct: number;
  width: number;
  height: number;
}): void {
  const primary = hexToAss(opts.textColor, 0);
  const outline = "&H00000000";
  const back = hexToAss(opts.backgroundColor, opts.backgroundOpacity);
  // 字幕不做卡拉 OK 了，SecondaryColour 用不上；保留字段（ASS 格式要求），取值与正文同色
  const karaoke = primary;
  const styleLine =
    `Style: Default,${opts.fontPath.split(/[\\\\/]/).pop()},${opts.fontSize},${primary},${karaoke},${outline},${back},-1,0,0,0,100,100,0,0,4,3,0,2,40,40,${Math.round(opts.height * (1 - opts.positionPct) - 20)},1`;

  const fontName = opts.fontPath.replace(/^.*[\\/]/, "").replace(/\.(ttf|ttc|otf)$/i, "");
  const safeFontName = /[A-Za-z0-9 _-]/.test(fontName) ? fontName : "Microsoft YaHei";

  const styles = `Format: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding
${styleLine.replace(opts.fontPath.split(/[\\/]/).pop()!, safeFontName)}`;

  const events = opts.entries.map((e) => assDialogue(e.startSec, e.endSec, e.text)).join("\n");
  const content = `[Script Info]
ScriptType: v4.00+
PlayResX: ${opts.width}
PlayResY: ${opts.height}
WrapStyle: 2
ScaledBorderAndShadow: yes

[V4+ Styles]
${styles}

[Events]
Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text
${events}
`;

  fs.writeFileSync(opts.outPath, content, "utf-8");
}

/**
 * 交叉淡化链里每一次 xfade 的 offset（秒）。
 *
 * 这是**累加**的：第 k 次 xfade 的 offset = 链上目前的长度 − 淡化时长，
 * 而链上长度每接一段就增加「本段音频 − 淡化时长」。
 *
 * 老实现把 cum 的更新写在了用 offset 之后、而且加的是**当前**段的时长，
 * 于是从第 3 段起 offset 少了「第 2 段的时长」——后一段被提前好几秒插进来，
 * 盖住前一段的画面与字幕（实测：5 镜的片子第 2 镜完全不出现、第 2 句字幕整句看不到）。
 * 抽成纯函数是为了让用例能直接断言 offset。
 */
export function crossfadeOffsets(audioSecs: number[], transitionSec: number): number[] {
  const f = Math.max(0, transitionSec);
  const out: number[] = [];
  if (!audioSecs.length) return out;
  let cum = audioSecs[0] ?? 0;
  for (let i = 1; i < audioSecs.length; i++) {
    out.push(Math.max(0, cum - f));
    cum = cum + (audioSecs[i] ?? 0) - f;
  }
  return out;
}

/**
 * 交叉淡化的时长（秒）：不早于「最短那段旁白走完 3/4」才开始淡化。
 *
 * 因为 xfade 的 offset = 本段旁白 − 淡化时长，淡化越长，下一镜插得越早、本镜露脸越短。
 *
 * 上限取的是**最短旁白的 1/4**。老实现取 1/2，看着更柔，但旁白一短就出事：
 * 旁白约 1 秒时淡化算成 0.47 秒，实测 1.28 秒的第 1 镜画面只露 0.51 秒、
 * 其中 0.47 秒还都在淡化里——第 1 镜等于一闪而过（测试用例：短旁白那组）。
 *
 * 真实脚本每镜 8~15 秒，1/4 和 1/2 都够不着 0.5 秒这个上限，行为完全不变；
 * 只有极短旁白会拿到更短的淡化，把画面时间还给镜头。
 * 抽成纯函数是为了让用例能直接断言（同 crossfadeOffsets）。
 */
export function crossfadeDuration(audioSecs: number[], transitionSec: number): number {
  if (!audioSecs.length) return Math.max(0, transitionSec);
  const shortest = Math.min(...audioSecs.map((s) => Math.max(0.05, s)));
  return Math.max(0.1, Math.min(transitionSec, shortest / 4, 2));
}

export class VideoComposer {
  private readonly resolution: { width: number; height: number };
  private readonly fps: number;
  private readonly imageFit: "contain" | "cover";
  private readonly motion: boolean;
  private readonly motionMode: MotionMode;
  private readonly motionAmount: number;
  private readonly transitionDuration: number;
  private readonly preset: string;
  private readonly crf: number;

  constructor(opts: VideoComposerOptions = {}) {
    this.resolution = opts.resolution ?? { width: 1920, height: 1080 };
    this.fps = opts.fps ?? 24;
    this.imageFit = opts.imageFit ?? "contain";
    this.motion = opts.motion ?? true;
    this.motionMode = opts.motionMode ?? "zoom-in";
    this.motionAmount = opts.motionAmount ?? 25;
    this.transitionDuration = opts.transitionDuration ?? 0.5;
    this.preset = opts.preset ?? "fast";
    this.crf = opts.crf ?? 23;
  }

  private buildKenBurnsFilter(
    assName: string,
    durationSec: number,
    motionMode?: MotionMode,
    motionAmount?: number
  ): string {
    const { width: W, height: H } = this.resolution;
    const base =
      this.imageFit === "cover"
        ? `scale=${W * 2}:${H * 2}:force_original_aspect_ratio=increase,crop=${W * 2}:${H * 2}`
        : `scale=${W * 2}:${H * 2}:force_original_aspect_ratio=decrease,pad=${W * 2}:${H * 2}:(ow-iw)/2:(oh-ih)/2:black`;
    const mode = motionMode ?? this.motionMode;
    const amount = motionAmount ?? this.motionAmount;
    if (!this.motion || mode === "none") {
      const staticVf =
        this.imageFit === "cover"
          ? `scale=${W}:${H}:force_original_aspect_ratio=increase,crop=${W}:${H}`
          : `scale=${W}:${H}:force_original_aspect_ratio=decrease,pad=${W}:${H}:(ow-iw)/2:(oh-ih)/2:black`;
      // 输入是单张图（没有 -loop），不复制帧的话这一整段就只有 1 帧：
      // 单段还能靠 -t 撑住时长，但多段走 xfade 时直接产出坏视频（实测只剩 0.6 秒/2 帧）。
      // 这里用 zoompan 把这一帧按 fps 复制成 durationSec 长度，zoom 固定 1（等于静止）。
      const totalFrames = Math.max(2, Math.round(durationSec * this.fps));
      const holdStill = `zoompan=z='1':d=${totalFrames}:x='0':y='0':s=${W}x${H}:fps=${this.fps}`;
      return `${staticVf},${holdStill},ass=${assName}`;
    }
    // 单帧输入 + d=总帧数，用 on（输出帧号）线性推近，动效稳定可见
    const totalFrames = Math.max(2, Math.round(durationSec * this.fps));
    const target = 1 + amount / 100;
    const incr = (target - 1) / (totalFrames - 1);
    let z: string;
    let x = "iw/2-(iw/zoom/2)";
    const y = "ih/2-(ih/zoom/2)";
    switch (mode) {
      case "zoom-out":
        z = `max(${target}-${incr}*on,1)`;
        break;
      case "pan-left":
        z = String(target);
        x = `(iw-iw/zoom)*(1-on/${totalFrames - 1})`;
        break;
      case "pan-right":
        z = String(target);
        x = `(iw-iw/zoom)*(on/${totalFrames - 1})`;
        break;
      case "zoom-in":
      default:
        z = `min(1+${incr}*on,${target})`;
        break;
    }
    const zoompan =
      `zoompan=z='${z}':d=${totalFrames}:x='${x}':y='${y}':s=${W}x${H}:fps=${this.fps}`;
    return `${base},${zoompan},ass=${assName}`;
  }

  /**
   * 生成与素材同格式的静音片段（句间停顿用）。
   * 只支持 mp3（在线音色）/ wav（本地克隆音色）这两种实际来源；其余格式返回 null（跳过插静音）。
   */
  private async makeGapSilence(
    sampleOf: string,
    cwd: string,
    signal?: AbortSignal,
    seconds: number = SCENE_LINE_GAP,
    name = "silence-gap"
  ): Promise<string | null> {
    const ext = path.extname(sampleOf).toLowerCase();
    const isWav = ext === ".wav";
    if (!isWav && ext !== ".mp3") return null;
    const out = path.join(cwd, isWav ? `${name}.wav` : `${name}.mp3`);
    const args = isWav
      ? [
          "-y", "-f", "lavfi", "-i", "anullsrc=r=32000:cl=mono",
          "-t", seconds.toFixed(3), "-c:a", "pcm_s16le", out,
        ]
      : [
          "-y", "-f", "lavfi", "-i", "anullsrc=r=24000:cl=mono",
          "-t", seconds.toFixed(3), "-c:a", "libmp3lame", "-b:a", "48k", out,
        ];
    const res = await runFfmpeg(args, { timeoutMs: 60_000, cwd, signal });
    return res.code === 0 && fs.existsSync(out) ? out : null;
  }

  /**
   * 把静音接在音频**前面**（镜头之间的停顿用）。
   * 用 concat demuxer + -c copy：与 concatAudio / concatCopy 同一套路，不重编码。
   */
  private async prependSilence(
    silencePath: string,
    audioPath: string,
    outPath: string,
    cwd: string,
    signal?: AbortSignal
  ): Promise<boolean> {
    const listFile = path.join(cwd, "lead_list.txt");
    fs.writeFileSync(
      listFile,
      [silencePath, audioPath]
        .map((a) => `file '${path.resolve(a).replace(/\\/g, "/").replace(/'/g, "'\\''")}'`)
        .join("\n") + "\n",
      "utf-8"
    );
    const res = await runFfmpeg(
      ["-y", "-f", "concat", "-safe", "0", "-i", "lead_list.txt", "-c", "copy", path.resolve(outPath)],
      { cwd, signal }
    );
    return res.code === 0 && fs.existsSync(outPath) && fs.statSync(outPath).size > 0;
  }

  /**
   * 把一段里的多句音频拼成一个文件，**句间插入真实的静音**。
   *
   * 字幕时间轴按「上一句时长 + SCENE_LINE_GAP」推进，而 concat demuxer 本身不加停顿；
   * 不插静音就会出现「字幕比声音慢半拍」的累积偏移（第 N 句晚 (N-1)×GAP），所以要在这里补上。
   */
  private async concatAudio(audios: string[], outPath: string, cwd: string, signal?: AbortSignal): Promise<void> {
    const silence = await this.makeGapSilence(audios[0], cwd, signal);
    const items: string[] = [];
    audios.forEach((a, i) => {
      if (i > 0 && silence) items.push(path.resolve(silence));
      items.push(path.resolve(a));
    });
    const listFile = path.join(cwd, "audio_list.txt");
    fs.writeFileSync(
      listFile,
      items
        .map((a) => `file '${a.replace(/\\/g, "/").replace(/'/g, "'\\''")}'`)
        .join("\n") + "\n",
      "utf-8"
    );
    const res = await runFfmpeg(
      ["-y", "-f", "concat", "-safe", "0", "-i", "audio_list.txt", "-c", "copy", path.basename(outPath)],
      { cwd, signal }
    );
    if (res.code !== 0) throw new Error(`音频拼接失败：${res.stderr.split("\n").slice(-10).join("\n")}`);
  }

  /** 渲染一个场景片段（Ken Burns + 字幕 + 组音频） */
  private async renderScene(opts: {
    imagePath: string;
    audioPath: string;
    durationSec: number;
    assPath: string;
    outputPath: string;
    cwd: string;
    motionMode?: MotionMode;
    motionAmount?: number;
    signal?: AbortSignal;
  }): Promise<void> {
    const assName = path.basename(opts.assPath);
    const vf = this.buildKenBurnsFilter(
      assName,
      opts.durationSec,
      opts.motionMode,
      opts.motionAmount
    );
    const args = [
      "-y",
      "-i", opts.imagePath,
      "-i", opts.audioPath,
      "-vf", vf,
      "-t", opts.durationSec.toFixed(3),
      "-c:v", "libx264",
      "-preset", this.preset,
      "-crf", String(this.crf),
      "-pix_fmt", "yuv420p",
      "-c:a", "aac",
      "-b:a", "128k",
      "-ar", "44100",
      "-ac", "2",
      "-progress", "pipe:2",
      path.basename(opts.outputPath),
    ];
    const res = await runFfmpeg(args, { timeoutMs: 5 * 60 * 1000, cwd: opts.cwd, signal: opts.signal });
    if (res.code !== 0) {
      throw new Error(`FFmpeg 片段渲染失败：\n${res.stderr.split("\n").slice(-15).join("\n")}`);
    }
  }

  /** 组间交叉淡入淡出（xfade 视频 + acrossfade 音频） */
  private async concatWithCrossfade(opts: {
    clips: Array<{ path: string; durationSec: number; audioSec: number }>;
    outputPath: string;
    cwd: string;
    signal?: AbortSignal;
  }): Promise<void> {
    const { clips, outputPath, cwd, signal } = opts;
    /*
     * 时间轴以**音频**为准：xfade 的 offset 和 acrossfade 的推进都用 audioSec。
     *
     * 画面本身比音频长（sceneDur 留了 0.3 秒尾巴），如果视频按 durationSec 累加、
     * 音频按自己的长度累加，每过一段画面就多走 0.3 秒——字幕是烧在画面里的，
     * 于是越往后字幕越滞后（实测：两段各差 2 秒时，第二段声音比画面早 1.9 秒；
     * 成片素材每段差 0.3 秒，第 N 段就滞后 (N-1)×0.3 秒）。
     * 用同一个时钟后，多出来的那点尾巴只是被下一段覆盖掉，同步不再漂。
     */
    const step = (c: { durationSec: number; audioSec: number }) =>
      Math.max(0.05, c.audioSec || c.durationSec);
    const f = crossfadeDuration(clips.map((c) => step(c)), this.transitionDuration);

    const inputs: string[] = [];
    for (const c of clips) inputs.push("-i", path.basename(c.path));

    const offsets = crossfadeOffsets(clips.map((c) => step(c)), f);
    let vf = `[0:v][1:v]xfade=transition=fade:duration=${f}:offset=${offsets[0].toFixed(3)}[v1]`;
    let af = `[0:a][1:a]acrossfade=d=${f}:c1=tri:c2=tri[a1]`;
    for (let i = 2; i < clips.length; i++) {
      vf += `;[v${i - 1}][${i}:v]xfade=transition=fade:duration=${f}:offset=${offsets[i - 1].toFixed(3)}[v${i}]`;
      af += `;[a${i - 1}][${i}:a]acrossfade=d=${f}:c1=tri:c2=tri[a${i}]`;
    }
    const last = clips.length - 1;
    const args = [
      "-y",
      ...inputs,
      "-filter_complex", `${vf};${af}`,
      "-map", `[v${last}]`,
      "-map", `[a${last}]`,
      "-c:v", "libx264",
      "-preset", this.preset,
      "-crf", String(this.crf),
      "-pix_fmt", "yuv420p",
      "-c:a", "aac",
      "-b:a", "128k",
      "-ar", "44100",
      "-ac", "2",
      "-movflags", "+faststart",
      outputPath,
    ];
    const res = await runFfmpeg(args, { timeoutMs: 5 * 60 * 1000, cwd, signal });
    if (res.code !== 0) {
      throw new Error(`FFmpeg 转场拼接失败：\n${res.stderr.split("\n").slice(-15).join("\n")}`);
    }
  }

  /** 普通 concat demuxer 拼接（-c copy） */
  private async concatCopy(clips: Array<{ path: string }>, outputPath: string, cwd: string, signal?: AbortSignal): Promise<void> {
    const listFile = path.join(cwd, "list.txt");
    fs.writeFileSync(
      listFile,
      clips.map((c) => `file '${path.basename(c.path).replace(/'/g, "'\\''")}'`).join("\n") + "\n",
      "utf-8"
    );
    const res = await runFfmpeg(
      ["-y", "-f", "concat", "-safe", "0", "-i", "list.txt", "-c", "copy", "-movflags", "+faststart", outputPath],
      { timeoutMs: 3 * 60 * 1000, cwd, signal }
    );
    if (res.code !== 0) {
      throw new Error(`FFmpeg 拼接失败：\n${res.stderr.split("\n").slice(-15).join("\n")}`);
    }
  }

  async compose(params: {
    segments: ComposeSegment[];
    crossfade?: boolean;
    outputPath: string;
    subtitle: SubtitleSettings;
    onProgress?: ComposeProgressCallback;
    signal?: AbortSignal;
  }): Promise<{ outputPath: string; durationSec: number }> {
    const { segments: inputSegments, crossfade = false, outputPath, subtitle, onProgress, signal } = params;
    const throwIfAborted = () => {
      if (signal?.aborted) throw new Error("已取消");
    };

    fs.mkdirSync(path.dirname(outputPath), { recursive: true });

    // 1. 过滤有效 line 段，并探测每条音频时长
    type Line = { seg: ComposeSegment; audio: string; durationSec: number };
    const lines: Line[] = [];
    for (const seg of inputSegments) {
      if (!seg.audioPath || !fs.existsSync(seg.audioPath) || fs.statSync(seg.audioPath).size === 0) continue;
      const dur = await probeAudioDuration(seg.audioPath);
      lines.push({ seg, audio: seg.audioPath, durationSec: Math.max(0.5, dur) });
    }
    if (!lines.length) throw new Error("没有可用的对话段（全部 silent 或音频文件缺失）");

    // 2. 按 sceneId 分组（缺省每行一组）
    const groups: Line[][] = [];
    let curGroupKey: number | undefined;
    for (const line of lines) {
      const key = line.seg.sceneId ?? groups.length;
      if (key !== curGroupKey) {
        groups.push([line]);
        curGroupKey = key;
      } else {
        groups[groups.length - 1].push(line);
      }
    }

    onProgress?.(0);
    /*
     * 每次合成用独立的临时目录：字幕文件（scene_NNN.ass）和片段视频都是按序号命名的，
     * 两次合成共用同一个目录时，后来的那次会在前一次「写完字幕、还没渲染」的间隙把文件换掉，
     * 结果就是某一段画面和声音是这句、字幕却是另一句。
     */
    const runTag = `${Date.now().toString(36)}-${Math.floor(Math.random() * 1e6).toString(36)}`;
    const tmpDir = path.join(path.dirname(outputPath), `_tmp_segments_${runTag}`);
    // 清掉历史遗留目录（老版本固定用 _tmp_segments，崩溃时会留下）
    fs.rmSync(path.join(path.dirname(outputPath), "_tmp_segments"), { recursive: true, force: true });
    fs.mkdirSync(tmpDir, { recursive: true });

    const fontPath = findFont();
    const { width, height } = this.resolution;
    // 组内行间字幕/音频间隔（秒）：音频拼接时会真的插入这段静音，两边必须同源
    const GAP = SCENE_LINE_GAP;
    /*
     * 每个片段记两个时长：
     *   durationSec = 画面长度（sceneDur，比音频多一点尾巴）
     *   audioSec    = 这段音频的**真实**长度
     * 交叉淡化拼接时两者必须用同一个时钟累加，否则画面按前一个、声音按后一个，
     * 每过一段就错开 (durationSec - audioSec) 秒，字幕越往后越滞后。
     */
    const clips: Array<{ path: string; durationSec: number; audioSec: number }> = [];
    let totalDur = 0;

    for (let gi = 0; gi < groups.length; gi++) {
      throwIfAborted();
      const group = groups[gi];
      const idx = String(gi).padStart(3, "0");
      const imagePath = group[0].seg.imagePath;
      if (!fs.existsSync(imagePath)) throw new Error(`图片不存在：${imagePath}`);

      // 组音频：单行直接用，多行 concat
      const sceneAudio = path.join(tmpDir, `scene_${idx}.mp3`);
      if (group.length === 1) {
        fs.copyFileSync(group[0].audio, sceneAudio);
      } else {
        await this.concatAudio(group.map((l) => l.audio), sceneAudio, tmpDir, signal);
      }

      /*
       * 镜头之间的停顿：给「不是第一段」的每一段开头垫一段静音。
       * 垫在开头而不是结尾，是为了让交叉淡化那几帧落在静音里——
       * 上一句刚说完、画面边淡变下一镜、静音过后下一句才开口。
       */
      let leadGap = 0;
      if (crossfade && gi > 0) {
        const silence = await this.makeGapSilence(sceneAudio, tmpDir, signal, SCENE_LEAD_GAP_SEC, "silence-lead");
        if (silence) {
          const withLead = path.join(tmpDir, `scene_${idx}.lead.mp3`);
          if (await this.prependSilence(silence, sceneAudio, withLead, tmpDir, signal)) {
            fs.copyFileSync(withLead, sceneAudio);
            leadGap = SCENE_LEAD_GAP_SEC;
          }
        }
      }
      throwIfAborted();
      const audioDur = Math.max(0.5, await probeAudioDuration(sceneAudio));

      // 一行字幕放几个字：按画面宽度与字号算（竖屏 1080/字号 50 ≈ 19 字）
      const maxChars = maxCharsPerLine(width, subtitle.fontSize);

      // 组字幕：按行累计时间（记得加上开头那段静音的偏移，否则字幕会比声音早）
      const entries: AssEntry[] = [];
      let cursor = 0;
      for (const line of group) {
        const start = leadGap + cursor;
        const end = start + line.durationSec;
        const parts = buildSubtitleEntries(line, { maxChars });
        for (const p of parts) {
          entries.push({ text: p.text, startSec: start + p.startSec, endSec: start + p.endSec });
        }
        // 末尾兜底：确保最后一条字幕不会因为时间切片误差提前消失
        if (entries.length) entries[entries.length - 1].endSec = end;
        cursor = end + GAP;
      }
      const sceneDur = Math.max(audioDur + 0.3, cursor);

      const assPath = path.join(tmpDir, `scene_${idx}.ass`);
      writeAssFile({
        outPath: assPath,
        entries,
        fontPath,
        fontSize: subtitle.fontSize,
        textColor: subtitle.color,
        backgroundColor: subtitle.backgroundColor,
        backgroundOpacity: subtitle.backgroundOpacity,
        positionPct: subtitle.positionPct,
        width,
        height,
      });

      const clipPath = path.join(tmpDir, `scene_${idx}.mp4`);
      await this.renderScene({
        imagePath,
        audioPath: sceneAudio,
        durationSec: sceneDur,
        assPath,
        outputPath: clipPath,
        cwd: tmpDir,
        motionMode: group[0].seg.motionMode,
        motionAmount: group[0].seg.motionAmount,
        signal,
      });

      clips.push({ path: clipPath, durationSec: sceneDur, audioSec: audioDur });
      totalDur += sceneDur;
      onProgress?.(Math.round(((gi + 1) / (groups.length + 1)) * 95));
    }

    onProgress?.(95);
    throwIfAborted();
    if (crossfade && clips.length > 1) {
      await this.concatWithCrossfade({ clips, outputPath, cwd: tmpDir, signal });
    } else {
      await this.concatCopy(clips, outputPath, tmpDir, signal);
    }
    onProgress?.(100);

    try {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    } catch {
      /* noop */
    }
    return { outputPath, durationSec: totalDur };
  }
}
