/**
 * 文字卡视频：文案 → 卡片图 → 成片。
 *
 * 流程：
 *   1. **出图**：开一个隐藏窗口加载 `buildCardsHtml` 生成的页面（N 张卡竖排），
 *      滚到第 i 张截一次图。同一份 HTML 也用于界面预览，所见即所得。
 *   2. **配音**（可选）：逐卡把文案合成 TTS，卡时长 = 语音 + 尾垫，"念完才翻页"；
 *      单卡失败回退固定秒数的静音段，成片永远出得来。
 *   3. **合成**：每张图做一段「卡内运动 + 转场」，音轨（配音或静音）一并编进去，
 *      再无损拼起来；选了 BGM 最后混一轮（视频流直拷）。
 *
 * 为什么不用 DOM 逐帧渲染：静态图 + 缩放/淡入在观感上已经够，速度差两个数量级
 * （10 张卡的片子这里几十秒出片，逐帧渲染要几分钟还不稳）。
 */
import { app, BrowserWindow, nativeImage, screen } from "electron";
import fs from "node:fs";
import path from "node:path";
import type {
  TextCard,
  TextCardMotion,
  TextCardOptions,
  TextCardProgress,
  TextCardRequest,
  TextCardResult,
  TextCardTransition,
} from "../../shared/textcard-types";
import { buildCardsHtml, cardSize, stripCardMarkers, TEXT_CARD_MOTIONS, TEXT_CARD_TRANSITIONS } from "../../shared/textcard-types";
import * as settings from "../dialogue/settings";
import { defaultOutputDir } from "../dialogue/compose";
import { probeAudioDuration, runFfmpeg } from "../dialogue/ffmpeg";
import { cloneIdFromVoice, findCloneVoice, synthCloneSingle } from "../dialogue/clone-voice";
import { prosodyPercent, TtsEngine } from "../dialogue/tts";

const FPS = 25;
/** 淡入淡出时长（秒）：短一点才像"翻页"，长了显得拖 */
const FADE = 0.35;
/** 白闪时长（秒）：再长就晃眼了 */
const FLASH = 0.12;
/** 配音念完到翻页之间留的呼吸（秒） */
const VOICE_TAIL = 0.4;
/** 段音轨统一参数：Edge 出的就是 24kHz 单声道，各段一致 concat -c copy 才不翻车 */
const AUDIO_ARGS = ["-c:a", "aac", "-b:a", "96k", "-ar", "24000", "-ac", "1"];

const active = new Map<string, AbortController>();

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

function outputDir(): string {
  const base = settings.getAppSettings().outputDir || defaultOutputDir();
  const dir = path.join(base, "textcard");
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

/** 成片目录（界面「打开目录」用） */
export function textCardOutputDir(): string {
  return outputDir();
}

function stamp(): string {
  const d = new Date();
  const p = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`;
}

export function cancelTextCard(requestId: string): boolean {
  const c = active.get(requestId);
  if (!c) return false;
  c.abort();
  return true;
}

/**
 * 窗口装不装得下整张卡。
 *
 * 关键坑：BrowserWindow 的尺寸会被系统**限制在工作区之内**（实测 1080×1920 的窗口
 * 只会拿到 1080×852），所以 1920 高的竖屏卡根本不可能一次截全。
 * 解法是按屏幕能给的尺寸把卡切成 tile，逐块截、再拼（见 stitchTiles）。
 */
interface CaptureLayout {
  w: number;
  h: number;
  tileW: number;
  tileH: number;
  cols: number;
  rows: number;
}

function captureLayout(w: number, h: number): CaptureLayout {
  const { workAreaSize } = screen.getPrimaryDisplay();
  // 留 80px 余量：窗口被系统裁掉一点就会少一条边
  const maxW = Math.max(480, Math.floor(workAreaSize.width) - 80);
  const maxH = Math.max(480, Math.floor(workAreaSize.height) - 80);
  const tileW = Math.min(w, maxW);
  const tileH = Math.min(h, maxH);
  return { w, h, tileW, tileH, cols: Math.ceil(w / tileW), rows: Math.ceil(h / tileH) };
}

/**
 * 把若干块拼回整张卡。
 *
 * 用 ffmpeg 的 xstack：Electron 的 NativeImage 只有 crop 没有拼合，
 * 为这一件事装一个 canvas 依赖不值当（ffmpeg 本来就在）。
 * 拼完再缩到画布尺寸 —— 截图是物理像素（缩放 150% 的屏上是 1.5 倍），
 * 先拼再缩等于超采样，字比直接按逻辑像素截更干净。
 */
async function stitchTiles(
  tiles: Array<{ file: string; x: number; y: number }>,
  w: number,
  h: number,
  signal: AbortSignal,
  out: string
): Promise<void> {
  if (tiles.length === 1) {
    const img = nativeImage.createFromPath(tiles[0].file);
    const sized =
      img.getSize().width === w ? img : img.resize({ width: w, height: h, quality: "best" });
    fs.writeFileSync(out, sized.toPNG());
    return;
  }

  const layout = tiles.map((t) => `${Math.round(t.x)}_${Math.round(t.y)}`).join("|");
  const inputs = tiles.flatMap((t) => ["-i", t.file]);
  const labels = tiles.map((_, i) => `[${i}]`).join("");
  const fc = `${labels}xstack=inputs=${tiles.length}:layout=${layout}:fill=black,scale=${w}:${h}:flags=lanczos`;

  const r = await runFfmpeg(["-y", ...inputs, "-filter_complex", fc, "-frames:v", "1", out], {
    signal,
    timeoutMs: 60_000,
  });
  if (r.code !== 0) {
    throw new Error(`拼图失败：${r.stderr.split(/\r?\n/).filter(Boolean).slice(-2).join(" ")}`);
  }
}

/**
 * 把所有卡截成 PNG。
 *
 * 一个窗口、一次加载、按 tile 滚动截图 —— 每张卡开一次窗口的话，光是 BrowserWindow
 * 创建就要几百毫秒，10 张卡能多花好几秒。
 *
 * 两个必须处理的边界（踩过）：
 *   1. **滚动会被 page 底部 clamp**：最后一块想要的位置滚不过去，截到的其实是上一段的
 *      内容，拼出来就是文字重复。所以按实际滚动量算偏移，把多出来的部分裁掉。
 *   2. **最后一块不该占满整块**：卡高 1920 除以块高 772，第三块只需要 376 高，
 *      按 772 算会让整张图被 xstack 拉高再压扁。每块都按"在卡内实际需要的高度"裁。
 */
async function captureCards(
  cards: TextCard[],
  options: TextCardOptions,
  dir: string,
  onEach: (i: number) => void,
  signal: AbortSignal
): Promise<string[]> {
  const { w, h } = cardSize(options.ratio);
  const L = captureLayout(w, h);
  const pageH = cards.length * h;

  const win = new BrowserWindow({
    show: false,
    width: L.tileW,
    height: L.tileH,
    useContentSize: true,
    frame: false,
    webPreferences: {
      backgroundThrottling: false,
      spellcheck: false,
      contextIsolation: true,
      nodeIntegration: false,
    },
  });
  win.webContents.setAudioMuted(true);

  const htmlFile = path.join(app.getPath("temp"), `baoluo-textcard-${Date.now()}.html`);
  const out: string[] = [];
  let dpr = 1;
  try {
    fs.writeFileSync(htmlFile, buildCardsHtml(cards, options), "utf-8");
    await win.loadFile(htmlFile);
    // 字体没就绪就截图，中文会先画成方框/回退字重
    await win.webContents.executeJavaScript("document.fonts.ready.then(() => true)");
    await win.webContents.executeJavaScript(
      "new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(() => r(true))))"
    );

    for (let i = 0; i < cards.length; i++) {
      if (signal.aborted) throw new Error("已取消");
      const tiles: Array<{ file: string; x: number; y: number }> = [];
      let accY = 0;
      for (let r = 0; r < L.rows; r++) {
        const needH = Math.min(L.tileH, h - r * L.tileH);
        const targetY = i * h + r * L.tileH;
        const maxScrollY = Math.max(0, pageH - L.tileH);
        const actualY = Math.min(targetY, maxScrollY);
        const skipY = targetY - actualY;

        let accX = 0;
        for (let c = 0; c < L.cols; c++) {
          if (signal.aborted) throw new Error("已取消");
          const needW = Math.min(L.tileW, w - c * L.tileW);
          const targetX = c * L.tileW;
          const maxScrollX = Math.max(0, w - L.tileW);
          const actualX = Math.min(targetX, maxScrollX);
          const skipX = targetX - actualX;

          await win.webContents.executeJavaScript(
            `window.scrollTo(${actualX}, ${actualY}); true`
          );
          await sleep(tiles.length === 0 ? 80 : 60);

          let img = await win.webContents.capturePage();
          if (tiles.length === 0) dpr = img.getSize().width / L.tileW;

          if (skipX > 0 || skipY > 0 || needW < L.tileW || needH < L.tileH) {
            const size = img.getSize();
            const x = Math.round(skipX * dpr);
            const y = Math.round(skipY * dpr);
            img = img.crop({
              x,
              y,
              width: Math.max(1, Math.min(size.width - x, Math.round(needW * dpr))),
              height: Math.max(1, Math.min(size.height - y, Math.round(needH * dpr))),
            });
          }

          const file = path.join(dir, `t-${i + 1}-${r}-${c}.png`);
          fs.writeFileSync(file, img.toPNG());
          tiles.push({ file, x: accX, y: accY });
          accX += needW * dpr;
        }
        accY += needH * dpr;
      }

      const png = path.join(dir, `card-${String(i + 1).padStart(2, "0")}.png`);
      await stitchTiles(tiles, w, h, signal, png);
      out.push(png);
      onEach(i);
    }
    return out;
  } finally {
    try {
      win.destroy();
    } catch {
      /* 已经关了 */
    }
    try {
      fs.unlinkSync(htmlFile);
    } catch {
      /* 临时文件删不掉不影响结果 */
    }
  }
}

/** 一张卡的配音结果：audioPath 为 null 表示这张没配成（或没配音），按固定秒数走静音段 */
interface CardVoice {
  audioPath: string | null;
  /** 这张卡的成片时长（秒）：配音成功 = 语音 + 尾垫，否则 = 固定秒数 */
  durSec: number;
}

/** auto 档的轮换序列：静止不进自动（翻着翻着停一下反而显得卡） */
const AUTO_MOTIONS: Array<Exclude<TextCardMotion, "auto" | "still">> = ["in", "pan", "out"];

/** 把 auto 解析成第 index 张实际用的运动；非 auto 原样返回 */
function motionAt(options: TextCardOptions, index: number): Exclude<TextCardMotion, "auto"> {
  const m = options.motion ?? "auto";
  if (m !== "auto") return m;
  return AUTO_MOTIONS[index % AUTO_MOTIONS.length];
}

/** 转场 fade 滤镜：黑场淡入淡出 / 白闪 / 硬切（不加滤镜） */
function transitionFilters(transition: TextCardTransition, dur: number): string[] {
  if (transition === "cut") return [];
  if (transition === "flash") {
    const d = Math.min(FLASH, dur / 2);
    return [
      `fade=t=in:st=0:d=${d.toFixed(2)}:color=white`,
      `fade=t=out:st=${Math.max(0, dur - d).toFixed(2)}:d=${d.toFixed(2)}:color=white`,
    ];
  }
  return [
    `fade=t=in:st=0:d=${FADE}`,
    `fade=t=out:st=${Math.max(0, dur - FADE).toFixed(2)}:d=${FADE}`,
  ];
}

/** 朗读文本：大字 + 小字各行拼成一句。行尾标点去掉再用句号连，避免"，。"这种怪连读；
 *  *词* 标记只管上色，星号不进语音 */
function speakTextOf(card: TextCard): string {
  const parts = [stripCardMarkers(card.lead), ...stripCardMarkers(card.body).split("\n")]
    .map((s) => s.trim().replace(/[。，！？；、.,!?;:：~—-]+$/u, ""))
    .filter(Boolean);
  return parts.length ? `${parts.join("。")}。` : "";
}

/**
 * 逐卡合成配音。在线 Edge 音色共用一个引擎（顺序合成）；`clone:<id>` 走本地 Genie。
 * 单卡失败不拦整片：记下来，这张卡回退成固定秒数的静音段。
 */
async function synthCardVoices(
  cards: TextCard[],
  voice: string,
  workDir: string,
  onEach: (i: number) => void,
  signal: AbortSignal
): Promise<{ voices: CardVoice[]; failed: number }> {
  const voices: CardVoice[] = [];
  let failed = 0;
  const cloneId = cloneIdFromVoice(voice);
  // Edge 引擎无条件建一个：克隆模式用不到它，顶多多建个空目录（workDir 收尾会删）
  const engine = new TtsEngine({
    outputDir: path.join(workDir, "voice"),
    betweenDelayMs: 0,
    timeoutMs: 30_000,
    maxRetries: 2,
    signal,
  });

  for (let i = 0; i < cards.length; i++) {
    if (signal.aborted) throw new Error("已取消");
    onEach(i);
    const text = speakTextOf(cards[i]);
    let audioPath: string | null = null;
    if (text) {
      try {
        if (cloneId) {
          const r = await synthCloneSingle({
            voice: findCloneVoice(cloneId),
            text,
            outputDir: path.join(workDir, "voice", `c-${i}`),
          });
          audioPath = r.path;
        } else {
          const r = await engine.generateSingle({
            index: i,
            text,
            voice,
            rate: prosodyPercent(0),
            pitch: prosodyPercent(0),
            volume: prosodyPercent(0),
          });
          audioPath = r?.path ?? null;
        }
      } catch {
        // 中止要往外抛，别当成"合成失败"吞了
        if (signal.aborted) throw new Error("已取消");
        audioPath = null;
      }
    }
    if (audioPath) {
      const probe = await probeAudioDuration(audioPath);
      voices.push({ audioPath, durSec: Math.max(1.2, probe + VOICE_TAIL) });
    } else {
      failed += 1;
      voices.push({ audioPath: null, durSec: 0 }); // 秒数由调用方按 options.seconds 填
    }
  }
  return { voices, failed };
}

/** 一张卡 → 一段视频：卡内运动 + 转场 + 音轨（配音或静音），音轨永远存在，concat 才一致 */
async function makeSegment(
  png: string,
  outFile: string,
  options: TextCardOptions,
  voice: CardVoice,
  motion: Exclude<TextCardMotion, "auto">,
  index: number,
  signal: AbortSignal
): Promise<void> {
  const { w, h } = cardSize(options.ratio);
  const dur = Math.max(0.8, voice.durSec);
  const frames = Math.max(1, Math.round(dur * FPS));
  // 推近幅度按总秒数摊：2 秒和 6 秒的卡看起来要"一样慢"
  const step = (0.055 / frames).toFixed(6);
  const transition = options.transition ?? "fade";

  const center = `x='iw/2-(iw/zoom/2)':y='ih/2-(ih/zoom/2)'`;
  // 平移在 1.06 倍下左右游走：奇偶卡换个方向，不显得全片都往一边挪
  const panN = Math.max(1, frames - 1);
  const panExpr =
    index % 2 === 0
      ? `(iw-iw/zoom)*min(on-1,${panN})/${panN}`
      : `(iw-iw/zoom)*(1-min(on-1,${panN})/${panN})`;
  const motionVf: string | null =
    motion === "still"
      ? null
      : motion === "in"
        ? `zoompan=z='min(zoom+${step},1.06)':${center}:d=${frames}:s=${w}x${h}:fps=${FPS}`
        : motion === "out"
          ? `zoompan=z='if(lte(on,1),1.06,max(zoom-${step},1.0))':${center}:d=${frames}:s=${w}x${h}:fps=${FPS}`
          : `zoompan=z='1.06':x='${panExpr}':y='ih/2-(ih/zoom/2)':d=${frames}:s=${w}x${h}:fps=${FPS}`;

  const vf = [motionVf, ...transitionFilters(transition, dur), "format=yuv420p"]
    .filter(Boolean)
    .join(",");

  // 有配音垫满整段（apad），没配音（或失败回退）用静音流顶位——音轨必须有，concat -c copy 才不会因流不一致失败
  const audioIn = voice.audioPath
    ? ["-i", voice.audioPath]
    : ["-f", "lavfi", "-i", "anullsrc=r=24000:cl=mono"];

  const r = await runFfmpeg(
    [
      "-y",
      "-loop", "1",
      "-i", png,
      ...audioIn,
      "-map", "0:v",
      "-map", "1:a",
      "-t", dur.toFixed(3),
      ...(voice.audioPath ? ["-af", "apad"] : []),
      "-vf", vf,
      "-frames:v", String(frames),
      "-r", String(FPS),
      "-c:v", "libx264",
      "-preset", "veryfast",
      "-crf", "20",
      "-pix_fmt", "yuv420p",
      ...AUDIO_ARGS,
      outFile,
    ],
    { signal, timeoutMs: 120_000 }
  );
  if (r.code !== 0) {
    throw new Error(`合成第 ${path.basename(png)} 失败：${r.stderr.split(/\r?\n/).filter(Boolean).slice(-2).join(" ")}`);
  }
}

/** BGM 混流：视频流直拷，原音轨 + 循环 BGM 混成一条，片尾淡出 */
async function mixBgm(
  film: string,
  bgmPath: string,
  volume: number,
  totalDur: number,
  outFile: string,
  signal: AbortSignal
): Promise<void> {
  const vol = Math.min(0.5, Math.max(0.02, volume || 0.15));
  const fc = [
    `[1:a]volume=${vol.toFixed(2)},afade=t=in:d=0.8,afade=t=out:st=${Math.max(0, totalDur - 1.2).toFixed(2)}:d=1.2[bg]`,
    `[0:a][bg]amix=inputs=2:duration=first:normalize=0[a]`,
  ].join(";");
  const r = await runFfmpeg(
    [
      "-y",
      "-i", film,
      "-stream_loop", "-1", "-i", bgmPath,
      "-filter_complex", fc,
      "-map", "0:v",
      "-map", "[a]",
      "-c:v", "copy",
      "-c:a", "aac", "-b:a", "128k", "-ar", "24000", "-ac", "1",
      "-movflags", "+faststart",
      outFile,
    ],
    { signal, timeoutMs: 120_000 }
  );
  if (r.code !== 0) {
    throw new Error(`混入背景音乐失败：${r.stderr.split(/\r?\n/).filter(Boolean).slice(-2).join(" ")}`);
  }
}

function concatList(dir: string, files: string[]): string {
  const listFile = path.join(dir, "parts.txt");
  // concat 的路径用正斜杠 + 单引号包裹，Windows 反斜杠会被当转义
  const body = files.map((f) => `file '${f.replace(/\\/g, "/")}'`).join("\n");
  fs.writeFileSync(listFile, `${body}\n`, "utf-8");
  return listFile;
}

export async function runTextCard(
  req: TextCardRequest,
  onProgress: (p: TextCardProgress) => void
): Promise<TextCardResult> {
  const requestId = req.requestId || `tc-${Date.now()}`;
  const cards = (req.cards ?? []).filter((c) => (c.lead ?? "").trim());
  if (!cards.length) throw new Error("还没有内容：一行一句，空一行分卡。");

  const MOTION_VALUES = TEXT_CARD_MOTIONS.map((m) => m.value);
  const TRANSITION_VALUES = TEXT_CARD_TRANSITIONS.map((t) => t.value);
  const motionOpt = req.options?.motion;
  const transitionOpt = req.options?.transition;
  const options: TextCardOptions = {
    style: req.options?.style ?? "plain",
    ratio: req.options?.ratio ?? "portrait",
    seconds: Math.min(10, Math.max(0.8, req.options?.seconds ?? 2.5)),
    motion: motionOpt && MOTION_VALUES.includes(motionOpt) ? motionOpt : "auto",
    transition: transitionOpt && TRANSITION_VALUES.includes(transitionOpt) ? transitionOpt : "fade",
  };
  // 配音与 BGM 从请求里取；音色为空 = 静音模式（老行为）
  const voice = (req.options?.voice ?? "").trim();
  const bgmPath = (req.options?.bgmPath ?? "").trim();
  const bgmVolume = typeof req.options?.bgmVolume === "number" ? req.options.bgmVolume : 0.15;
  // 模板 auto 档给的是逐卡节奏（按字数算的），没给的卡回退固定 seconds
  const durations = Array.isArray(req.options?.durations) ? req.options.durations : null;
  const fixedSec = (i: number): number =>
    Math.min(10, Math.max(0.8, durations?.[i] ?? options.seconds));

  const ctrl = new AbortController();
  active.set(requestId, ctrl);
  const { signal } = ctrl;

  const dir = outputDir();
  // 中间产物放临时区：万一被占用删不掉，也不会在用户的输出目录里留一堆 .work
  const workDir = path.join(app.getPath("temp"), `baoluo-textcard-${requestId}`);
  fs.mkdirSync(workDir, { recursive: true });
  const videoPath = path.join(dir, `文字卡-${stamp()}.mp4`);

  try {
    const total = cards.length;
    const report = (p: Partial<TextCardProgress> & { stage: TextCardProgress["stage"] }) =>
      onProgress({
        requestId,
        stage: p.stage,
        index: p.index ?? 0,
        total,
        percent: p.percent ?? 0,
        message: p.message ?? "",
      });

    // 配音模式改了各阶段的进度占比：配音自己也占一截
    const span = voice ? { capture: 40, voice: 25, compose: 30 } : { capture: 55, voice: 0, compose: 40 };

    // ---- 1. 出图 ----
    const pngs = await captureCards(
      cards,
      options,
      workDir,
      (i) =>
        report({
          stage: "capture",
          index: i + 1,
          percent: Math.round(((i + 1) / total) * span.capture),
          message: `正在出第 ${i + 1}/${total} 张图…`,
        }),
      signal
    );

    // ---- 2. 配音（可选）----
    let voices: CardVoice[] = cards.map((_, i) => ({ audioPath: null, durSec: fixedSec(i) }));
    let failed = 0;
    if (voice) {
      const r = await synthCardVoices(
        cards,
        voice,
        workDir,
        (i) =>
          report({
            stage: "voice",
            index: i + 1,
            percent: span.capture + Math.round(((i + 1) / total) * span.voice),
            message: `正在合成第 ${i + 1}/${total} 句配音…`,
          }),
        signal
      );
      // 失败的卡回退这张自己的节奏（synthCardVoices 里记 0，这里补上）
      voices = r.voices.map((v, i) => (v.audioPath ? v : { ...v, durSec: fixedSec(i) }));
      failed = r.failed;
    }

    // ---- 3. 每张编一段 ----
    const parts: string[] = [];
    for (let i = 0; i < pngs.length; i++) {
      if (signal.aborted) throw new Error("已取消");
      report({
        stage: "compose",
        index: i + 1,
        percent: span.capture + span.voice + Math.round((i / total) * span.compose),
        message: `正在合成第 ${i + 1}/${total} 段…`,
      });
      const part = path.join(workDir, `part-${String(i + 1).padStart(2, "0")}.mp4`);
      await makeSegment(pngs[i], part, options, voices[i], motionAt(options, i), i, signal);
      parts.push(part);
    }

    // ---- 4. 拼接（要混 BGM 就先拼成中间片）----
    report({ stage: "compose", index: total, percent: 96, message: "正在拼接成片…" });
    let filmPath = videoPath;
    if (bgmPath) filmPath = path.join(workDir, "film.mp4");
    const listFile = concatList(workDir, parts);
    const r = await runFfmpeg(
      ["-y", "-f", "concat", "-safe", "0", "-i", listFile, "-c", "copy", "-movflags", "+faststart", filmPath],
      { signal, timeoutMs: 120_000 }
    );
    if (r.code !== 0) {
      throw new Error(`拼接失败：${r.stderr.split(/\r?\n/).filter(Boolean).slice(-2).join(" ")}`);
    }

    // ---- 5. BGM（可选）----
    if (bgmPath) {
      report({ stage: "compose", index: total, percent: 98, message: "正在混入背景音乐…" });
      const totalDur = voices.reduce((s, v) => s + v.durSec, 0);
      await mixBgm(filmPath, bgmPath, bgmVolume, totalDur, videoPath, signal);
    }

    const durationSec = +voices.reduce((s, v) => s + v.durSec, 0).toFixed(2);
    let note: string | undefined;
    if (voice && failed >= total) note = "配音没合成出来（检查一下网络），已按固定节奏出片。";
    else if (voice && failed > 0) note = `${failed} 张卡配音失败，那几张按固定节奏出片。`;
    report({ stage: "done", index: total, percent: 100, message: note ?? "成片好了。" });
    return { videoPath, durationSec, count: total, note };
  } finally {
    active.delete(requestId);
    // 中间产物（PNG / 分段 / 清单）用完就清。Windows 上文件句柄偶尔还没释放，
    // 删不掉就等等再试——重试几次仍失败也只是留个临时目录，不影响成片。
    for (let i = 0; i < 3; i++) {
      try {
        fs.rmSync(workDir, { recursive: true, force: true });
        break;
      } catch {
        await sleep(300);
      }
    }
  }
}
