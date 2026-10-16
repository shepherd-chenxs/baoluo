/*
 * SPDX-License-Identifier: GPL-3.0-only
 * Copyright (c) 2026 宝螺 / Baoluo contributors
 * 本文件属于「宝螺 / Baoluo」。除 GPL-3.0 外还适用 ADDITIONAL_TERMS.md 里的附加条款：
 * 分发时须保留来源署名；修改版对外分发时不得沿用「宝螺」名称与图标。
 */
/**
 * 分镜工作台：热点成片的完整体验，一个组件全包。
 *
 * 「视频生成 → 热点成片」页和工作台的热点成片任务卡渲染的都是它——
 * 工作台只是换了个入口（选题从任务带进来），底下是同一套东西：
 * 选题 → AI 成片（写分镜 → 缺图生图 → 配音字幕运镜合成）→ 分镜稿编辑 → 成片预览。
 *
 * 从 HotStoryView 抽出来时的纪律：逻辑一行不改地搬，两边永远不许分叉——
 * 以前工作台自己另写了一条平行链路，同一份分镜能出两种片子，就是这么来的。
 */
import { useEffect, useRef, useState, type DragEvent, type MutableRefObject } from "react";
import type {
  DialogueApi,
  ImageApi,
  MediaApi,
  SettingsApi,
  StoryboardApi,
} from "../../../preload";
import type {
  ComposeProgress,
  ComposeSnapshot,
  DialogueSettings,
  MotionMode,
  VideoResolution,
} from "../../../shared/dialogue-types";
import type {
  HotItem,
  HotSource,
  Shot,
  Storyboard,
  StoryboardSummary,
} from "../../../shared/storyboard-types";
import { formatHeat } from "../../../shared/hot-format";
import { effectiveFavoriteVoices, VOICE_OPTIONS } from "../../../shared/voices";
import type { BatchState } from "../../../shared/image-batch-types";
import type { ImageProviderInfo } from "../../../shared/image-providers";
import {
  runHotPipeline,
  shouldReuseStoryboard,
  type PipelineResult,
  type PipelineStage,
  type PipelineStatus,
} from "../../views/hotStoryPipeline";
import AppSelect from "../AppSelect";

declare global {
  interface Window {
    storyboard: StoryboardApi;
    dialogue: DialogueApi;
    media: MediaApi;
    settings: SettingsApi;
    image: ImageApi;
  }
}

const MOTION_OPTIONS: Array<{ value: MotionMode; label: string }> = [
  { value: "none", label: "静止" },
  { value: "zoom-in", label: "推近" },
  { value: "zoom-out", label: "拉远" },
  { value: "pan-left", label: "左移" },
  { value: "pan-right", label: "右移" },
];

/** 一键成片的三个阶段（界面上的三步进度条按这个顺序画） */
const PIPELINE_STEPS: Array<{ key: PipelineStage; label: string }> = [
  { key: "story", label: "写分镜" },
  { key: "images", label: "生图" },
  { key: "compose", label: "合成视频" },
];

const DURATION_OPTIONS = [15, 30, 60, 90, 120].map((s) => ({
  value: String(s),
  label: `${s} 秒`,
}));

const DEFAULT_VOICE = "zh-CN-YunxiNeural";

function makeLocalId(): string {
  return `shot-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 9)}`;
}

function stageText(stage: ComposeProgress["stage"] | null): string {
  switch (stage) {
    case "parse":
      return "解析镜头";
    case "tts":
      return "合成配音";
    case "compose":
      return "合成视频";
    case "done":
      return "完成";
    case "error":
      return "失败";
    default:
      return "准备中";
  }
}

/**
 * 批量生图进度的人话，例如
 * 「第 2 / 共 5 张（第 3 镜，第 2 次重试） · 已向 ModelScope 请求 1 次」。
 *
 * 单独抽出来是因为这段要在 JSX 里算当前镜号、重试次数，
 * 写在内联表达式里会变成一坨重复的 `batch.items.find(...)`。
 */
function batchText(s: BatchState): string {
  if (!s.running) return s.summary;
  const cur = s.items.find((i) => i.state === "running");
  const n = Math.min(s.doneCount + 1, s.total);
  let text = `第 ${n} / 共 ${s.total} 张`;
  if (cur) {
    const tries = cur.attempts ?? 1;
    text += `（第 ${cur.index} 镜${tries > 1 ? `，第 ${tries} 次重试` : ""}）`;
  } else if (s.cancelling) {
    text += "（等当前这张跑完就停）";
  }
  if (s.submitted > 0) {
    text += ` · 已向 ${s.provider === "modelscope" ? "ModelScope" : "接口"}请求 ${s.submitted} 次`;
  }
  if (s.note) text += ` · ${s.note}`;
  return text;
}

/**
 * 把 IPC 抛回来的错误转成人话。
 *
 * Electron 会把主进程的异常包成
 *   "Error invoking remote method 'xxx': Error: 真正的原因"
 * 直接显示给用户就是一句英文加一串方法名。这里只留「真正的原因」那一句。
 */
function friendlyError(e: unknown): string {
  const raw = (e as { message?: string })?.message ?? String(e);
  const m = /Error invoking remote method '[^']*':\s*(?:Error:\s*)?([\s\S]*)/.exec(raw);
  const text = (m ? m[1] : raw).replace(/^[A-Za-z]*Error:\s*/, "");
  return text.trim() || "操作失败，请重试。";
}

async function copyText(t: string): Promise<boolean> {
  try {
    await navigator.clipboard.writeText(t);
    return true;
  } catch {
    const ta = document.createElement("textarea");
    ta.value = t;
    ta.style.position = "fixed";
    ta.style.opacity = "0";
    document.body.appendChild(ta);
    ta.select();
    try {
      document.execCommand("copy");
      return true;
    } catch {
      return false;
    } finally {
      document.body.removeChild(ta);
    }
  }
}

/**
 * 工作台主按钮（「成片」）的状态快照。
 *
 * 任务卡的卡头要画**同一个**按钮，但「能不能点 / 点了会怎样 / 现在是什么阶段」只有
 * 工作台自己知道（主题、热点、分镜、流水线、生图引擎状态都在它手上）。所以状态由工作台发出来，
 * 宿主只负责画——两边永远一致，不会各判一套（各判一套迟早会分叉）。
 */
export interface PipelineButtonState {
  /** 现在能不能点 */
  canRun: boolean;
  /** 按钮文字 */
  label: string;
  /** 点不动时给用户的原因（宿主画成 title，悬停可见） */
  disabledReason: string | null;
  /** 正在跑或是停下来等用户（宿主据此画「中止」） */
  running: boolean;
  /** 停下来等用户时还缺几张图（0 = 不缺） */
  missing: number;
}

/** 宿主（任务卡头 / 热点成片页）用它驱动工作台，与工作台里的按钮完全同源 */
export interface HotStoryWorkbenchHandle {
  runPipeline: () => void;
  cancelPipeline: () => void;
  /** 打开某份方案（热点成片页左侧列表点条目时用） */
  openBoard: (id: string) => void;
  /** 回到「还没选方案」的空白状态（列表上的「新建」） */
  startFresh: () => void;
}

export interface HotStoryWorkbenchProps {
  /**
   * 保活下隐藏的实例不消费进度广播：页面传 usePageActive()，
   * 工作台同样传自己的可见性——否则分镜生成/合成进度是全应用广播，会串台。
   */
  active: boolean;
  /** 建卡时带上的热点：选中它、主题预填标题（只在挂载时读一次） */
  initialHot?: HotItem | null;
  /** 主题预填（指令里的主题；只在挂载时读一次，之后以编辑器里的为准） */
  initialTopic?: string;
  /** 打开已有方案（工作台任务恢复时传 state.storyboardId；只在挂载时读一次） */
  initialBoardId?: string | null;
  /** 方案建立 / 切换 / 删除时告诉宿主（工作台把 id 写回任务，下次打开还能续上） */
  onBoardIdChange?: (boardId: string | null) => void;
  /** 页面显示「上次方案」恢复行；工作台的任务绑定自己的方案，不显示 */
  showLastDraft?: boolean;
  /**
   * 不摆工作台里那个大「成片」按钮：任务卡的卡头已经用同一个按钮取代了它
   * （工作区卡，见 WorkspaceView）。独立「热点成片」页没有卡头按钮，必须保留。
   */
  hideGenerateButton?: boolean;
  /** 任务卡头拿它驱动工作台（与工作台里那颗按钮同一套动作） */
  controlRef?: MutableRefObject<HotStoryWorkbenchHandle | null>;
  /** 把这个按钮的状态发给宿主（宿主照它画卡头那颗按钮） */
  onPipelineState?: (s: PipelineButtonState) => void;
  /**
   * 嵌在任务卡里、热点已经在对话框里选过了：① 里不再摆热榜（来源 / 刷新 / 列表）。
   * 热榜是"挑什么"的入口，只该有一个地方；卡片上再放一份，同一件事就有两处可改。
   */
  hideHotPicker?: boolean;
  /**
   * 只读（过程态）：跑起来之后，下面的分镜与成片都是机器的产物——只给看不给改。
   * 保留三样东西：三步进度、逐镜的可视化、以及「重试 / 中止」这类**过程操作**。
   */
  readOnly?: boolean;
  /**
   * 跑之前先确认一次。
   * 一键全自动的代价不小（1 次 AI 写分镜 + 5~12 张图 + 几分钟合成），防误点；
   * 只在这一轮还没跑起来时问，重试/继续不再问第二遍。
   */
  confirmBeforeRun?: string;
  /**
   * 段落去卡片化（① ② ③ 三张卡拍平成标题 + 分隔线，镜头改行分隔）：
   * 「热点成片」整页开着——右区本来就宽，两层壳白吃内距；
   * 工作台任务卡里由宿主容器（.ws-workbench）自己拍平，这里不用重复。
   */
  flatPanels?: boolean;
}

export default function HotStoryWorkbench({
  active,
  initialHot = null,
  initialTopic = "",
  initialBoardId = null,
  onBoardIdChange,
  showLastDraft = true,
  hideGenerateButton = false,
  controlRef,
  onPipelineState,
  hideHotPicker = false,
  readOnly = false,
  confirmBeforeRun,
  flatPanels = false,
}: HotStoryWorkbenchProps) {
  const [sources, setSources] = useState<HotSource[]>([]);
  const [sourceKey, setSourceKey] = useState("douyin");
  const [hotItems, setHotItems] = useState<HotItem[]>([]);
  const [hotLoading, setHotLoading] = useState(false);
  const [selectedHot, setSelectedHot] = useState<HotItem | null>(initialHot);
  const [customTopic, setCustomTopic] = useState(initialTopic || initialHot?.title || "");
  const [niche, setNiche] = useState("");
  const [durationSec, setDurationSec] = useState(30);
  const [resolution, setResolution] = useState<VideoResolution>("portrait");
  const [generating, setGenerating] = useState(false);
  const [genMsg, setGenMsg] = useState("");

  const [lastDraft, setLastDraft] = useState<StoryboardSummary | null>(null);
  const [board, setBoard] = useState<Storyboard | null>(null);
  /**
   * 当前分镜是用哪个主题写出来的。
   *
   * 「AI 成片」靠它判断该沿用还是重写分镜：主题没改就沿用（省一次 AI 调用，
   * 也不冲掉用户改过的文案/提示词），改了才重写。
   */
  const [boardTopic, setBoardTopic] = useState<string | null>(null);
  const [boardLoading, setBoardLoading] = useState(false);
  const [regeneratingId, setRegeneratingId] = useState<string | null>(null);
  /** 正在生图（画面提示词那行的「生图」）的镜头 id：同一时刻只允许一个 */
  const [generatingShotId, setGeneratingShotId] = useState<string | null>(null);
  /** 生图过程的阶段提示 */
  const [genShotMsg, setGenShotMsg] = useState("");
  /** 批量生图（T-003）的进度快照，队列跑在主进程，这里只是显示 */
  const [batch, setBatch] = useState<BatchState | null>(null);
  const [copiedKey, setCopiedKey] = useState<string | null>(null);
  /**
   * 当前生图引擎（走官方 HTTP 接口，ModelScope）。
   * 判断逻辑留在主进程（必须和实际分派一致），这里只拿结果换文案。
   */
  const [imageEngine, setImageEngine] = useState<ImageProviderInfo | null>(null);

  const [settings, setSettings] = useState<DialogueSettings | null>(null);
  const [voiceOptions, setVoiceOptions] = useState(VOICE_OPTIONS);
  const [narratorVoice, setNarratorVoice] = useState(DEFAULT_VOICE);

  const [composing, setComposing] = useState(false);
  /** 生成中显示已用时：合成长任务没有秒表，看着像卡死 */
  const [composingSeconds, setComposingSeconds] = useState(0);
  const [progress, setProgress] = useState<ComposeProgress | null>(null);
  const [previewUrl, setPreviewUrl] = useState("");
  const [outputPath, setOutputPath] = useState<string | null>(null);
  /** 挂载时从主进程取回的合成现状，等分镜加载完再认领（见下面的 effect） */
  const [pendingCompose, setPendingCompose] = useState<ComposeSnapshot | null>(null);
  const [error, setError] = useState<string | null>(null);
  /** 绿色提示（不是错误） */
  const [hint, setHint] = useState<string | null>(null);
  /** 标题的内联编辑：平时是文本 + 编辑图标，点图标才变输入框 */
  const [titleEditing, setTitleEditing] = useState(false);
  const [titleDraft, setTitleDraft] = useState("");
  const [shotUrls, setShotUrls] = useState<Record<string, string>>({});
  /**
   * 成片落在哪儿：用户在设置里指定的目录，没指定就用默认目录。
   * 还没合成时「视频输出」那一行就显示它（知道待会儿会落到哪儿）。
   */
  const [outputDir, setOutputDir] = useState("");
  const [defaultOutDir, setDefaultOutDir] = useState("");

  const requestIdRef = useRef<string | null>(null);
  /** 正在跑的分镜生成（story:generate）的 id：中止用 */
  const storyRequestIdRef = useRef<string | null>(null);
  /** onBoardIdChange 的最新值：挂载 effect 里的 openBoard 也要通知到最新的回调 */
  const boardIdChangeRef = useRef(onBoardIdChange);
  boardIdChangeRef.current = onBoardIdChange;

  /** 方案建立 / 切换 / 删除：统一从这里告诉宿主 */
  function notifyBoard(id: string | null) {
    boardIdChangeRef.current?.(id);
  }

  useEffect(() => {
    let alive = true;
    (async () => {
      try {
        const [srcList, dlg, app] = await Promise.all([
          window.storyboard.hotSources(),
          window.dialogue.getSettings(),
          window.settings.get(),
        ]);
        if (!alive) return;
        setSources(srcList);
        setSettings(dlg);
        // 生图引擎状态（哪个引擎、能不能开跑、缺什么）：主进程算好，这里只显示
        void window.image
          .providerInfo()
          .then((info) => {
            if (alive) setImageEngine(info);
          })
          .catch(() => {});
        const favs = effectiveFavoriteVoices(app.favoriteVoices);
        const clones = (app.cloneVoices ?? []).map((v) => ({
          value: `clone:${v.id}`,
          label: `克隆·${v.name}`,
        }));
        let opts = [...VOICE_OPTIONS.filter((v) => favs.includes(v.value)), ...clones];
        const nv = dlg.voiceNarrator || DEFAULT_VOICE;
        if (!opts.some((o) => o.value === nv)) {
          opts = [...opts, { value: nv, label: nv }];
        }
        setVoiceOptions(opts);
        setNarratorVoice(nv);
        setOutputDir(app.outputDir ?? "");
        setDefaultOutDir(await window.dialogue.defaultOutputDir());

        await loadHot("douyin");
        if (showLastDraft) await refreshLastDraft();
        // 工作台任务恢复：打开绑定的那份方案（页面没有 initialBoardId，跳过）
        if (initialBoardId) await openBoard(initialBoardId);
      } catch (e: any) {
        if (alive) setError(e?.message ?? String(e));
      }
    })();
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  /**
   * 分镜生成 / 合成进度都是全应用广播：图文解说、对话模式、热点成片都收得到。
   * 隐藏的实例不该再消费——否则会跟着显示别的页面的进度和报错。
   */
  useEffect(() => {
    if (!active) return;
    const offStory = window.storyboard.onProgress((p) => {
      setGenMsg(p.message);
      // 分镜生成的中止靠这个 id（cancelGenerate）
      if (p.requestId) storyRequestIdRef.current = p.requestId;
      if (p.phase === "error") setError(p.message);
    });
    const offCompose = window.dialogue.onComposeProgress((p) => {
      /*
       * 只认自己这一次合成。合成进度是全应用广播（对话页、其它分镜的合成都会发），
       * 不按 requestId 过滤的话，切到别的卡也能看见别人的进度条。
       */
      if (p.requestId !== requestIdRef.current) return;
      setProgress(p);
      if (p.error) setError(p.error);
    });
    // 单镜生图的分阶段提示由界面按固定文案显示，批量进度走广播
    /*
     * 批量生图进度。队列在主进程跑，切页面 / 关抽屉都不中断，
     * 所以这里不能只在 running 时订阅：切回来还要能看到最终汇总。
     */
    const offBatch = window.image.onBatchProgress((s) => {
      setBatch(s);
      // 每完成一张就把方案重读一次：镜头卡片要立刻变「图已就绪」
      if (s.doneCount > 0) void mergeBoardFromDisk();
      /*
       * 一键成片在等队列收工：running 翻成 false 的那次广播就是信号
       * （队列也可能被用户中止，所以不区分"成功结束"和"中止"，
       *  收工后由流水线自己重新数缺图，缺就停下来问用户）。
       */
      if (!s.running) {
        const waiter = batchWaiterRef.current;
        if (waiter) {
          batchWaiterRef.current = null;
          waiter(s);
        }
      }
    });
    /*
     * 补一次现状：队列在主进程跑，界面若刚重挂载（切页 / 重载）会错过之前的广播，
     * 那样批量还在跑但进度条不见了，用户会以为没在干活、再点一次。
     * doneCount > 0 时还要按磁盘对齐一次镜头图：错过的那些广播里，图已经落盘了。
     */
    void window.image
      .getBatchState()
      .then((s) => {
        if (s.running || s.doneCount > 0) setBatch(s);
        if (s.doneCount > 0) void mergeBoardFromDisk();
      })
      .catch(() => undefined);
    /*
     * 合成也要补一次现状（同批量队列的道理）：合成跑在主进程，切任务卡 / 切页会让这里的
     * 组件卸载，重挂之后广播已经错过——表现为「后台还在合成，界面上什么都没有」，
     * 已经合成好的片子也会丢掉预览入口。快照先存下来，等分镜加载完再认领（分镜是异步加载的）。
     */
    void window.dialogue
      .composeState()
      .then((s) => {
        if (s) setPendingCompose(s);
      })
      .catch(() => undefined);
    return () => {
      offStory();
      offCompose();
      offBatch();
    };
  }, [active]);

  /**
   * 秒表的起点。
   * 单独存一个 ref 是因为重挂后 composing 会从 false 变 true：若只按「现在」计时，
   * 一次已经跑了 40 秒的合成切回来会显示成「合成中（1s）…」。
   */
  const composeStartedAtRef = useRef<number | null>(null);

  /** 认领主进程那份合成快照：跑着的接上进度，跑完的接上预览 */
  useEffect(() => {
    if (!pendingCompose) return;
    const s = pendingCompose;
    // 分镜还没加载出来时先等：现在判不了这条快照是不是这份分镜的
    if (s.boardId && !board?.id) return;
    setPendingCompose(null);
    if (s.boardId && board && s.boardId !== board.id) return; // 别的分镜的合成，不画到这儿
    if (s.running) {
      requestIdRef.current = s.requestId;
      composeStartedAtRef.current = s.startedAt;
      setComposing(true);
      setProgress({
        requestId: s.requestId,
        stage: s.stage,
        percent: s.percent,
        message: s.message,
        currentLine: s.currentLine,
        totalLines: s.totalLines,
      });
      return;
    }
    if (s.outputPath) {
      setProgress({ stage: "done", percent: 100, message: "" });
      setOutputPath(s.outputPath);
      return;
    }
    if (s.error) {
      setProgress({ stage: "error", percent: 0, message: s.error });
      setError(s.error);
    }
  }, [pendingCompose, board?.id]);

  /**
   * 恢复「这份方案出过的最后一条片子」。
   *
   * 主进程的快照只活在应用这次运行里；重启之后靠方案上记的 lastVideoPath 找回入口
   * （不然刚渲染好的片子文件还在，界面上却没有任何地方能点开它）。
   */
  useEffect(() => {
    const saved = board?.lastVideoPath;
    if (!saved || composing || outputPath) return;
    setOutputPath(saved);
  }, [board?.id, board?.lastVideoPath]);

  /**
   * 预览地址由 outputPath **派生**，不再各处手动 setPreviewUrl。
   *
   * 原先「设置 outputPath」和「设置 previewUrl」是两处分别写的，谁后到谁说了算：
   * 打开方案时会先清一次（openBoard 里 `setPreviewUrl("")`），把刚才从方案里恢复出来的
   * 预览又抹掉了（实测：outputPath 恢复成功、预览框还是空的）。派生之后只有 outputPath
   * 一个真源，清空 / 恢复 / 新合成三条路都不会再打架。
   */
  useEffect(() => {
    if (!outputPath) {
      setPreviewUrl("");
      return;
    }
    let alive = true;
    void window.media
      .toUrl(outputPath)
      .then((u) => {
        if (alive) setPreviewUrl(u);
      })
      .catch(() => undefined);
    return () => {
      alive = false;
    };
  }, [outputPath]);

  /** 生成中走一个秒表：合成长任务只写「生成中…」的话，看着像卡住了 */
  useEffect(() => {
    if (!composing) {
      setComposingSeconds(0);
      composeStartedAtRef.current = null;
      return;
    }
    const t0 = composeStartedAtRef.current ?? Date.now();
    composeStartedAtRef.current = t0;
    const timer = window.setInterval(
      () => setComposingSeconds(Math.round((Date.now() - t0) / 1000)),
      1000
    );
    return () => window.clearInterval(timer);
  }, [composing]);

  // 方案内容改动后自动落盘（合并 700ms 内的连续输入）
  const boardRef = useRef(board);
  boardRef.current = board;
  /*
   * 「只是打开一份方案」不算改动：openBoard 给 board 赋值也会惊动下面这个 effect，
   * 不加这个标记的话，点一下列表里的方案就自动 save 一次 → updatedAt 刷新 →
   * 按最近动过排序的列表当场跳序（用户反馈：点记录顺序会变）。
   */
  const skipAutoSaveRef = useRef(false);
  useEffect(() => {
    const sb = boardRef.current;
    if (!sb) return;
    if (skipAutoSaveRef.current) {
      skipAutoSaveRef.current = false;
      return;
    }
    const timer = setTimeout(async () => {
      try {
        /*
         * 上盘前**总是**先和磁盘对一次 imagePath：批量生图是主进程直接往磁盘写图的，
         * 本地这份可能是几百毫秒前的旧快照（imagePath 还是 null）。
         *
         * 早先只在「批量正在跑」时才对账，结果批量一结束（或界面错过了广播）
         * 这份 stale 快照就会把批量刚存好的图**从 draft.json 里抹掉**——
         * 文件还在，方案里却没了。所以这里不设条件，一律对账。
         */
        let out = sb;
        try {
          const disk = await window.storyboard.get(sb.id);
          out = {
            ...sb,
            shots: sb.shots.map((s) => {
              const d = disk.shots.find((x) => x.id === s.id);
              return !s.imagePath && d?.imagePath ? { ...s, imagePath: d.imagePath } : s;
            }),
          };
        } catch {
          /* 读不到磁盘就按本地存，不比原来差 */
        }
        await window.storyboard.save(out);
      } catch (e: any) {
        setError(`保存方案失败：${e?.message ?? e}`);
      }
    }, 700);
    return () => clearTimeout(timer);
  }, [board]);

  // 镜头图片路径变化时刷新 baoluo-file:// 预览地址
  const imageSig = board?.shots
    .map((s) => `${s.id}:${s.imagePath ?? ""}`)
    .join("|");
  useEffect(() => {
    let alive = true;
    if (!board) return;
    (async () => {
      const next: Record<string, string> = {};
      for (const s of board.shots) {
        if (s.imagePath) {
          try {
            next[s.id] = await window.media.toUrl(s.imagePath);
          } catch {
            /* 单张图预览失败不影响整页 */
          }
        }
      }
      if (alive) setShotUrls(next);
    })();
    return () => {
      alive = false;
    };
  }, [board?.id, imageSig]); // eslint-disable-line react-hooks/exhaustive-deps

  async function loadHot(key: string) {
    setHotLoading(true);
    setError(null);
    try {
      const items = await window.storyboard.hotList(key);
      setHotItems(items);
    } catch (e: any) {
      setError(`获取${sources.find((s) => s.key === key)?.name ?? "热榜"}失败：${e?.message ?? e}`);
    } finally {
      setHotLoading(false);
    }
  }

  async function refreshLastDraft() {
    try {
      const list = await window.storyboard.list();
      setLastDraft(list[0] ?? null);
    } catch {
      /* 读取失败不影响主流程 */
    }
  }

  function changeSource(key: string) {
    setSourceKey(key);
    setSelectedHot(null);
    void loadHot(key);
  }

  function chooseHot(it: HotItem) {
    setSelectedHot(it);
    setCustomTopic(it.title);
  }

  async function openBoard(id: string) {
    setBoardLoading(true);
    setError(null);
    try {
      const sb = await window.storyboard.get(id);
      // 打开只是「看」，不该惊动自动落盘（否则 updatedAt 被刷新、列表跳序）
      skipAutoSaveRef.current = true;
      setBoard(sb);
      setBoardTopic(customTopic.trim());
      setResolution(sb.resolution ?? "portrait");
      setOutputPath(null);
      setPreviewUrl("");
      notifyBoard(id);
    } catch (e: any) {
      setError(e?.message ?? String(e));
    } finally {
      setBoardLoading(false);
    }
  }


  /**
   * 回到「还没选方案」的空白状态（热点成片页左侧列表的「新建」用）。
   *
   * 为什么不直接清空 board 了事：主题、选中的热点、预览、进度这些也得跟着回到初始，
   * 否则新建出来的工作台还挂着上一份方案的残留（看着像没生效）。
   * 落盘的那份方案不动——「新建」只是换个工作面，不是删东西。
   */
  function startFresh() {
    setBoard(null);
    setBoardTopic(null);
    setOutputPath(null);
    setProgress(null);
    setSelectedHot(null);
    setCustomTopic("");
    setNiche("");
    setTitleEditing(false);
    notifyBoard(null);
  }

  async function removeBoard() {
    if (!board) return;
    if (!window.confirm(`确定删除方案「${board.title || "未命名"}」吗？\n图片和分镜稿都会被删除，无法恢复。`)) {
      return;
    }
    try {
      await window.storyboard.remove(board.id);
      setBoard(null);
      setPreviewUrl("");
      setResolution("portrait");
      notifyBoard(null);
      await refreshLastDraft();
    } catch (e: any) {
      setError(e?.message ?? String(e));
    }
  }

  async function discardLastDraft() {
    if (!lastDraft) return;
    if (
      !window.confirm(
        `确定丢弃上次方案「${lastDraft.title || "未命名"}」吗？\n图片和分镜稿都会被删除，无法恢复。`
      )
    ) {
      return;
    }
    try {
      await window.storyboard.remove(lastDraft.id);
      await refreshLastDraft();
    } catch (e: any) {
      setError(e?.message ?? String(e));
    }
  }

  /** 只留可编辑的那几项：hook/style 是 AI 定的，界面上已经是只读文本 */
  function updateMeta(patch: Partial<Pick<Storyboard, "title">>) {
    setBoard((b) => (b ? { ...b, ...patch } : b));
  }

  /** 编辑完标题：回车/失焦提交，Esc 放弃 */
  function commitTitle() {
    updateMeta({ title: titleDraft.trim() });
    setTitleEditing(false);
  }

  function updateResolution(v: VideoResolution) {
    setResolution(v);
    setBoard((b) => (b ? { ...b, resolution: v } : b));
  }

  function updateShot(shotId: string, patch: Partial<Shot>) {
    setBoard((b) =>
      b
        ? { ...b, shots: b.shots.map((s) => (s.id === shotId ? { ...s, ...patch } : s)) }
        : b
    );
  }

  /**
   * 批量每完成一张，就把主进程写的 imagePath 合并回本地 board。
   *
   * 这里必须「合并」而不是整个用磁盘版覆盖：
   *   - imagePath 以磁盘为准（批量刚写进去的，本地那份是旧的）；
   *   - 文字字段以本地为准（用户可能正在改旁白 / 提示词）。
   * 早期直接 setBoard(磁盘版) 会把用户正在输入的字吞掉；
   * 反过来不重读更糟——本地上盘时那份 stale 的 imagePath:null
   * 会把批量刚存好的图抹掉（自动落盘在改动 700ms 后触发，一定会撞上）。
   */
  async function mergeBoardFromDisk() {
    /*
     * 必须走 ref 拿当前方案，不能用闭包里的 board：
     * 这个函数是被「进度订阅」那个 effect 捕获的，而那个 effect 的依赖只有 active，
     * 所以它一直握着**挂载那一刻**的 board（多半是 null）——批量跑完也不会合并，
     * 界面就停在「待放图」。用户实测踩到过：磁盘上 4 张图都在，卡片一张都不显示。
     */
    const cur = boardRef.current;
    if (!cur) return;
    try {
      const disk = await window.storyboard.get(cur.id);
      setBoard((b) => {
        if (!b || b.id !== cur.id) return b;
        return {
          ...b,
          shots: b.shots.map((s) => {
            const d = disk.shots.find((x) => x.id === s.id);
            return d?.imagePath && d.imagePath !== s.imagePath
              ? { ...s, imagePath: d.imagePath }
              : s;
          }),
        };
      });
    } catch {
      /* 重读失败下一张还会再试，不打断用户 */
    }
  }

  /*
   * 「批量生图」按钮已去掉：批量这条路现在由「AI 成片」统一走
   * （缺图时自动排队；停下后「继续合成」只补缺图、不重写分镜）。
   * 中止也由它自带——见 cancelPipeline()。
   */

  /** 批量结束后把汇总显示一下，并清掉进度条 */
  function dismissBatch() {
    setBatch(null);
  }

  function addManualShot() {
    setBoard((b) => {
      if (!b) return b;
      return {
        ...b,
        shots: [
          ...b.shots,
          {
            id: makeLocalId(),
            caption: "",
            imagePrompt: "",
            imagePath: null,
            motion: { mode: "zoom-in", amount: 25 },
          },
        ],
      };
    });
    void refreshLastDraft();
  }

  function moveShot(index: number, delta: number) {
    setBoard((b) => {
      if (!b) return b;
      const next = [...b.shots];
      const target = index + delta;
      if (target < 0 || target >= next.length) return b;
      const [item] = next.splice(index, 1);
      next.splice(target, 0, item);
      return { ...b, shots: next };
    });
  }

  function removeShot(shotId: string) {
    setBoard((b) => (b ? { ...b, shots: b.shots.filter((s) => s.id !== shotId) } : b));
  }

  async function attachForShot(shot: Shot, srcPath: string) {
    if (!board || !srcPath) return;
    setError(null);
    try {
      const next = await window.storyboard.attachImage({
        boardId: board.id,
        shotId: shot.id,
        srcPath,
      });
      setBoard(next);
      await refreshLastDraft();
    } catch (e: any) {
      setError(e?.message ?? String(e));
    }
  }

  async function pickForShot(shot: Shot) {
    try {
      const p = await window.storyboard.chooseImage(shot.imagePath);
      if (p) await attachForShot(shot, p);
    } catch (e: any) {
      setError(e?.message ?? String(e));
    }
  }

  function onDropImage(e: DragEvent<HTMLDivElement>, shot: Shot) {
    e.preventDefault();
    const file = e.dataTransfer.files?.[0];
    if (!file) return;
    const p = window.media.filePath(file);
    if (p) void attachForShot(shot, p);
  }

  async function copyPrompt(key: string, text: string) {
    const ok = await copyText(text);
    if (!ok) {
      setError("复制失败，请手动选择文字复制。");
      return;
    }
    setCopiedKey(key);
    setTimeout(() => setCopiedKey((k) => (k === key ? null : k)), 1600);
  }

  async function regenerateShot(shot: Shot) {
    if (!board) return;
    setError(null);
    setRegeneratingId(shot.id);
    setGenMsg("正在重新生成这个镜头的画面提示词…");
    try {
      const next = await window.storyboard.regeneratePrompt({
        boardId: board.id,
        shotId: shot.id,
      });
      setBoard(next);
    } catch (e: any) {
      setError(e?.message ?? String(e));
    } finally {
      setRegeneratingId(null);
      setGenMsg("");
    }
  }

  /**
   * 生图（画面提示词那行的「生图」）：把这一镜的提示词交给当前的生图引擎，
   * 出图后自动存进镜头槽。
   *
   * 走官方 HTTP 接口（ModelScope BYOK），后台跑、不弹窗口：
   * 用户看到的是卡片上的阶段提示和后面自动出现的缩略图——像调 API 一样。
   * 返回结构化结果：出了图就换掉 board；失败就红色提示（多数情况是 Token 没填，
   * 文案里直接指到设置页去填）。
   */
  async function generateShotImage(shot: Shot) {
    // 批量在跑时不接受单镜请求：同一份方案两套队列会互相打乱
    if (!board || generatingShotId || batch?.running) return;
    setError(null);
    setHint(null);
    setGeneratingShotId(shot.id);
    setGenShotMsg("正在生成…");
    try {
      const res = await window.image.generateShot({
        boardId: board.id,
        shotId: shot.id,
      });
      if (res.board) setBoard(res.board);
      if (!res.ok) {
        setError(res.message ?? "生图失败，请重试。");
      }
    } catch (e: any) {
      // 走到这里说明是进程级异常（主进程的「用户看得见的结果」都以 ok=false 返回）
      setError(friendlyError(e));
    } finally {
      setGeneratingShotId(null);
      setGenShotMsg("");
    }
  }

  function openBoardFolder() {
    if (!board) return;
    void window.storyboard.openDir(board.id).then((r) => {
      if (!r.ok) setError(r.error ?? "打开目录失败。");
    });
  }

  function cancelCompose() {
    if (requestIdRef.current) {
      void window.dialogue.cancelCompose(requestIdRef.current);
    }
  }

  /**
   * 合成一条分镜（配音 + 字幕 + 运镜）。
   *
   * 抽出来是因为现在有两个入口：③ 里的「合成视频」，和第一步那个「AI 成片」。
   * 两边必须走同一套参数，否则同一份分镜会出两种片子。
   */
  async function composeBoard(sb: Storyboard): Promise<string> {
    const app = await window.settings.get();
    const outDir = app.outputDir || (await window.dialogue.defaultOutputDir());
    const reqId = String(Date.now());
    requestIdRef.current = reqId;
    const res = await window.dialogue.runCompose({
      name: sb.title.trim() || "热点成片",
      mode: "narration",
      // 带上分镜 id：界面切卡片回来要靠它认领「是自己这份分镜的合成」
      boardId: sb.id,
      resolution: sb.resolution ?? resolution,
      imageFit: "cover",
      motionMode: "zoom-in",
      motionAmount: 25,
      imageMotions: sb.shots.map((s) => s.motion),
      script: "",
      imageFortune: "",
      imageCustomer: "",
      images: sb.shots.map((s) => ({ path: s.imagePath as string, text: s.caption })),
      outputDir: outDir,
      voiceFortune: narratorVoice,
      voiceCustomer: narratorVoice,
      voiceNarrator: narratorVoice,
      narratorCount: 1,
      prosody: settings!.prosody,
      subtitle: settings!.subtitle,
      requestId: reqId,
    });
    /*
     * 成片路径记在方案上：主进程那份快照只活在本次运行里，重启后靠这里找回预览入口
     * （片子文件一直在，丢的是界面上点开它的地方）。
     * 写盘用重读后的方案，避免把手里的旧快照覆盖回去。
     */
    try {
      const fresh = await window.storyboard.get(sb.id);
      fresh.lastVideoPath = res.outputPath;
      await window.storyboard.save(fresh);
    } catch {
      /* 记不上不影响这次出片 */
    }
    return res.outputPath;
  }

  async function generateVideo() {
    if (!board || !settings) return;
    setError(null);
    const noImage = board.shots.filter((s) => !s.imagePath).length;
    const noText = board.shots.filter((s) => !s.caption.trim()).length;
    if (!board.shots.length) {
      setError("分镜稿里还没有镜头。");
      return;
    }
    if (noImage) {
      setError(`还有 ${noImage} 个镜头没放图：先生图，再把图拖进对应镜头。`);
      return;
    }
    if (noText) {
      setError(`还有 ${noText} 个镜头没有旁白文案，请先填写。`);
      return;
    }
    setComposing(true);
    setProgress(null);
    setOutputPath(null);
    setPreviewUrl("");
    try {
      const out = await composeBoard(board);
      setOutputPath(out);
      setPreviewUrl(await window.media.toUrl(out));
      setProgress({ stage: "done", percent: 100 });
    } catch (e: any) {
      const msg = e?.message ?? String(e);
      if (!String(msg).includes("已取消")) {
        setError(msg);
        setProgress((p) => (p ? { ...p, stage: "error", percent: 0 } : null));
      }
    } finally {
      requestIdRef.current = null;
      setComposing(false);
    }
  }

  // ---------------------------------------------------------------------------
  // AI 成片（第一步那个按钮）：分镜 → 生图 → 合成，中间只在一处需要用户动手（缺图重试）
  // ---------------------------------------------------------------------------

  /** 流水线当前停在哪一步、什么状态（界面上的三步进度条就照它画） */
  interface PipelineState {
    stage: PipelineStage;
    status: "running" | "waiting" | "done" | "error";
    message: string;
    /** status=waiting 时：还有几张没生成出来 */
    missing: number;
    startedAt: number;
  }
  const [pipeline, setPipeline] = useState<PipelineState | null>(null);
  /** 防重入：流水线跑着的时候不许再点一次 */
  const pipelineBusyRef = useRef(false);
  /** 当前阶段的引用（catch 里要知道错在哪一步） */
  const pipelineStageRef = useRef<PipelineStage>("story");
  /** 等批量生图跑完的挂点（由 onBatchProgress 唤醒） */
  const batchWaiterRef = useRef<((s: BatchState) => void) | null>(null);
  const [pipelineSeconds, setPipelineSeconds] = useState(0);

  /** 一键成片跑着时也走秒表：出分镜 + 生图 + 合成加起来可能好几分钟 */
  useEffect(() => {
    if (pipeline?.status !== "running" && pipeline?.status !== "waiting") return;
    const t0 = pipeline.startedAt;
    setPipelineSeconds(Math.round((Date.now() - t0) / 1000));
    const timer = window.setInterval(
      () => setPipelineSeconds(Math.round((Date.now() - t0) / 1000)),
      1000
    );
    return () => window.clearInterval(timer);
  }, [pipeline?.status, pipeline?.startedAt]);

  /** 等批量队列收工（running=false 的那次广播） */
  function waitBatchDone(): Promise<BatchState> {
    return new Promise((resolve) => {
      batchWaiterRef.current = resolve;
    });
  }

  /** 流水线里的阶段切换：统一写状态，别在各处手拼 */
  function pipe(stage: PipelineStage, status: PipelineStatus, message: string, missing = 0) {
    pipelineStageRef.current = stage;
    setPipeline((p) => ({
      stage,
      // 「已中止」在界面上就是错误态（红点 + 重试按钮）
      status: status === "cancelled" ? "error" : status,
      message,
      missing,
      startedAt: p?.startedAt ?? Date.now(),
    }));
  }

  /**
   * 一键成片。
   *
   * 顺序本身在 hotStoryPipeline.ts 里（与 React 无关，用例能直接跑），
   * 这里只负责把界面上的能力注入进去、再把结果画回界面。
   *
   * skipStory：缺图重试时用——分镜已经有了，不用再花一次 AI 调用重写（也会把用户改过的
   * 文案/提示词冲掉）。
   */
  async function runPipeline(opts: { skipStory?: boolean } = {}): Promise<void> {
    if (pipelineBusyRef.current) return;
    if (!settings) return;
    if (!board?.shots.length && !selectedHot && !customTopic.trim()) {
      setError("先选一条热点，或在右侧输入你想做的主题。");
      return;
    }
    /*
     * 跑之前确认一次（宿主给的文案）。
     * 只在「这一轮还没跑过」时问：`pipeline` 有值说明已经在跑或已经跑完，
     * 这时再弹一次就只是烦人（重试缺图 / 重试这一步都是接着跑）。
     */
    if (confirmBeforeRun && !pipeline && !window.confirm(confirmBeforeRun)) return;
    pipelineBusyRef.current = true;
    setError(null);
    setHint(null);
    setOutputPath(null);
    setPreviewUrl("");
    setPipeline({ stage: "story", status: "running", message: "正在准备…", missing: 0, startedAt: Date.now() });
    pipelineStageRef.current = "story";

    let res: PipelineResult | null = null;
    try {
      /*
       * 沿用还是重写分镜：由 shouldReuseStoryboard 决定（有分镜 + 主题没改 → 沿用）。
       * 「重试缺图，继续合成」显式传 skipStory: true，不受主题影响。
       */
      const reuseStory = opts.skipStory ?? shouldReuseStoryboard(board, boardTopic, customTopic);
      res = await runHotPipeline(
        { board, skipStory: reuseStory },
        {
          generateStoryboard: async () => {
            /*
             * 「只出分镜」那个入口去掉了，但写分镜仍是一段有耗时的工作：
             * 这里把 generating 打开，页面上的「DeepSeek 正在写作…」提示才照旧显示。
             */
            setGenerating(true);
            setGenMsg("正在让 AI 构思分镜…");
            try {
              const sb = await window.storyboard.generate({
                hot: selectedHot,
                topic: customTopic.trim() || undefined,
                resolution,
                niche: niche.trim() || undefined,
                durationSeconds: durationSec,
              });
              setBoard(sb);
              setBoardTopic(customTopic.trim());
              notifyBoard(sb.id);
              await refreshLastDraft();
              return sb;
            } finally {
              setGenerating(false);
              setGenMsg("");
            }
          },
          loadBoard: async (id) => {
            // 队列已经把图写进磁盘了：先按磁盘对齐镜头卡，再取最新的一份
            await mergeBoardFromDisk();
            const sb = await window.storyboard.get(id);
            setBoard(sb);
            return sb;
          },
          startBatch: async (boardId) => {
            const r = await window.image.startBatch({ boardId });
            setBatch(r.state);
            return r;
          },
          waitBatch: async () => {
            await waitBatchDone();
          },
          compose: async (sb) => {
            setComposing(true);
            setProgress(null);
            const out = await composeBoard(sb);
            setOutputPath(out);
            setPreviewUrl(await window.media.toUrl(out));
            setProgress({ stage: "done", percent: 100 });
            return out;
          },
          onStage: (stage, status, message, missing) => pipe(stage, status, message, missing ?? 0),
          // 引擎没配好：界面据此给出口（例如引导去设置页填 Token）
          onNeedConfig: () => setError("生图引擎还没配好，到「设置 → AI 服务」填好 API Key 再试。"),
        }
      );
    } finally {
      requestIdRef.current = null;
      setComposing(false);
      pipelineBusyRef.current = false;
      batchWaiterRef.current = null;
    }

    if (!res) return;
    /*
     * 阶段播报由 runHotPipeline 自己发（终态也发），这里只补界面该做的事：
     * 失败/中止时错误区也要说一句。
     */
    if (res.status === "error" || res.status === "cancelled") setError(res.message);
  }

  /** 中止一键成片：写分镜阶段停 AI 请求，生图阶段停队列，合成阶段停渲染 */
  async function cancelPipeline() {
    if (pipelineStageRef.current === "story" && storyRequestIdRef.current) {
      void window.storyboard.cancelGenerate(storyRequestIdRef.current);
      storyRequestIdRef.current = null;
    } else if (pipelineStageRef.current === "images") {
      try {
        setBatch(await window.image.cancelBatch());
      } catch {
        /* 停不掉就等它自己收工 */
      }
    } else if (pipelineStageRef.current === "compose" && requestIdRef.current) {
      void window.dialogue.cancelCompose(requestIdRef.current);
    }
    pipe(pipelineStageRef.current, "error", "已中止。");
  }


  const selectedSource = sources.find((s) => s.key === sourceKey);
  const boardFilled = board?.shots.filter((s) => s.imagePath).length ?? 0;
  const voiceLabel =
    voiceOptions.find((o) => o.value === narratorVoice)?.label ?? narratorVoice;
  /** 一键成片是否在跑（跑着时按钮变"进行中"、并给中止） */
  const pipelineRunning = pipeline?.status === "running";

  /*
   * ---------------- 把「成片」交给宿主驱动（任务卡头那颗按钮） ----------------
   *
   * 工作区卡（只含内嵌工作台的图文解说卡）的卡头画的是**同一个**「成片」按钮，
   * 但它能不能点、点了干什么，只有这里知道（主题/热点/分镜/流水线/生图引擎状态都在手上）。
   * 所以：动作通过 controlRef 交出去，状态通过 onPipelineState 发出去，宿主只负责画。
   *
   * 用 ref 转一手的理由：runPipeline / cancelPipeline 每次渲染都是新函数，
   * 直接挂给宿主的话，宿主拿到的是第一帧那份闭包（那时 settings 还是 null，点了会直接 return）。
   */
  const runPipelineImpl = useRef<() => void>(() => {});
  const cancelPipelineImpl = useRef<() => void>(() => {});
  const openBoardImpl = useRef<(id: string) => void>(() => {});
  const startFreshImpl = useRef<() => void>(() => {});
  runPipelineImpl.current = () => void runPipeline();
  cancelPipelineImpl.current = () => void cancelPipeline();
  openBoardImpl.current = (id: string) => void openBoard(id);
  startFreshImpl.current = () => startFresh();
  useEffect(() => {
    if (!controlRef) return;
    controlRef.current = {
      runPipeline: () => runPipelineImpl.current(),
      cancelPipeline: () => cancelPipelineImpl.current(),
      openBoard: (id: string) => openBoardImpl.current(id),
      startFresh: () => startFreshImpl.current(),
    };
    return () => {
      controlRef.current = null;
    };
  }, [controlRef]);

  /** 生图引擎没就绪（如 ModelScope 没填 Key）：点了也出不来图，按钮要灰掉并说清原因 */
  const engineBlocked = imageEngine ? !imageEngine.ready : false;
  /** 有没有可成片的目标：已有分镜，或选了热点，或填了主题 */
  const hasPipelineTarget = Boolean(board?.shots.length || selectedHot || customTopic.trim());
  /** 忙到点了没用（waiting 不算：waiting 时点它是「继续合成」） */
  const pipelineHardBusy = pipelineRunning || generating || composing || hotLoading;
  const pipelineButton: PipelineButtonState = {
    canRun: !pipelineHardBusy && hasPipelineTarget && !engineBlocked,
    label: pipeline?.status === "waiting"
      ? `继续合成（缺 ${pipeline.missing} 张）`
      : pipelineRunning
        ? "成片中…"
        : generating
          ? "生成中…"
          : "成片",
    disabledReason: engineBlocked
      ? imageEngine?.message ?? "生图引擎还没准备好"
      : !hasPipelineTarget
        ? "先在上面选一条热点，或填一个主题"
        : pipelineHardBusy
          ? "正在跑，等它结束或点「中止」"
          : null,
    running: pipelineRunning || pipeline?.status === "waiting",
    missing: pipeline?.missing ?? 0,
  };
  /* 只在值真的变了才发：不然宿主每次拿到新对象都会重渲染一遍 */
  const pipelineButtonSig = `${pipelineButton.canRun}|${pipelineButton.label}|${pipelineButton.disabledReason ?? ""}|${pipelineButton.running}|${pipelineButton.missing}`;
  useEffect(() => {
    onPipelineState?.(pipelineButton);
  }, [onPipelineState, pipelineButtonSig]);

  return (
    /*
     * 根上挂 story-view：一批分镜稿样式（镜头卡、图框、选题行…）是
     * `.story-view .shot-card` 这样限作用域的，工作台任务卡里没有这个祖先类就全落空——
     * 布局走样、图片框瘪掉。页面和工作台由这一个类保证长得一模一样。
     */
    <div className={`story-view hot-story-workbench${readOnly ? " story-readonly" : ""}${flatPanels ? " flat-panels" : ""}`}>
      {/*
        * 失败提示：生图/合成失败时不能只说一句失败，要把原因说清（例如 Token 没填、网络异常）。
        */}
      {error && (
        <div className="story-error">
          <span>{error}</span>
          <div className="story-error-actions">
            <button
              className="link"
              onClick={() => {
                setError(null);
              }}
            >
              关闭
            </button>
          </div>
        </div>
      )}

      {hint && (
        <div className="story-hint">
          <span>{hint}</span>
          <button className="link" onClick={() => setHint(null)}>
            知道了
          </button>
        </div>
      )}

      {/* ============ ① 选题（嵌任务卡时只剩「设定」：热点在对话框里选） ============ */}
      <section className="card-pad story-card">
        <div className="panel-title-row">
          <span className="panel-title">{hideHotPicker ? "① 设定" : "① 选题"}</span>
          <span className="story-muted">
            {readOnly
              ? "这条片子的设定（只读）"
              : hideHotPicker
                ? "定好主题和画面，点卡头的「成片」开跑"
                : "选热点，或直接输入你想做的主题"}
          </span>
        </div>

        {!hideHotPicker && (
          <>
            <div className="story-source-row">
              <div className="story-source-select">
                <span className="story-field-label">榜单来源</span>
                <AppSelect
                  value={sourceKey}
                  options={sources.map((s) => ({ value: s.key, label: `${s.name}热榜` }))}
                  onChange={changeSource}
                />
              </div>
              <button
                type="button"
                className="secondary small"
                disabled={hotLoading || generating}
                onClick={() => void loadHot(sourceKey)}
              >
                {hotLoading ? "加载中…" : "刷新"}
              </button>
              <span className="story-muted">每 2 分钟自动缓存，无需登录</span>
            </div>

            <div className="hot-list">
              {hotLoading ? (
                <div className="story-empty">正在拉取{selectedSource?.name ?? ""}热榜…</div>
              ) : hotItems.length ? (
                hotItems.slice(0, 20).map((it) => (
                  <button
                    type="button"
                    key={it.id}
                    className={`hot-item ${selectedHot?.id === it.id ? "active" : ""}`}
                    onClick={() => chooseHot(it)}
                  >
                    <span className="hot-rank">{it.rank}</span>
                    <span className="hot-title">{it.title}</span>
                    <span className="hot-heat">
                      {it.heat
                        ? `${it.rank <= 3 ? "🔥 " : ""}${formatHeat(it.heat)}`
                        : it.rank <= 3
                          ? "🔥"
                          : ""}
                    </span>
                  </button>
                ))
              ) : (
                <div className="story-empty">榜单为空，点「刷新」再试。</div>
              )}
            </div>

            <div className="story-divider" />
          </>
        )}

        <div className="story-topic-layout">
          <div className="story-topic-row">
            {/*
              主题跟其它字段同一套排法（标签在左），但它是文本域、要占满剩下三列：
              热点标题之外常常还要补一句自己的说法，单行输入框写不下。
            */}
            <span className="story-field-label story-topic-label">主题</span>
            {/*
              只读态用「禁用」而不是换成纯文字：这些框的宽窄/对齐是排好的，
              换成 span 之后布局就散了（用户反馈：纯文字模式不好看）。
            */}
            <textarea
              className="story-topic-input story-topic-wide"
              rows={2}
              value={customTopic}
              placeholder="自定义主题或选择热点（可以换行写更细的要求）"
              onChange={(e) => {
                const v = e.target.value;
                setCustomTopic(v);
                if (selectedHot && v !== selectedHot.title) setSelectedHot(null);
              }}
              disabled={generating || readOnly}
            />
            <span className="story-field-label">赛道</span>
            <input
              className="story-niche-input"
              value={niche}
              placeholder="如：人文社科"
              onChange={(e) => setNiche(e.target.value)}
              disabled={generating || readOnly}
            />
            <span className="story-field-label">视频时长</span>
            <div className="story-duration">
              <AppSelect
                value={String(durationSec)}
                options={DURATION_OPTIONS}
                onChange={(v) => setDurationSec(Number(v))}
                disabled={readOnly}
              />
            </div>
            <span className="story-field-label">画面方向</span>
            <div className="story-direction-pick">
              <AppSelect
                value={resolution}
                options={[
                  { value: "portrait", label: "竖屏 9:16" },
                  { value: "landscape", label: "横屏 16:9" },
                ]}
                onChange={(v) => updateResolution(v as VideoResolution)}
                title="AI 画面提示词与最终成片都按此方向生成"
                disabled={readOnly}
              />
            </div>
            {/* 解说音色放第一步：它是这条片子的设定（跟方向、时长一样），不是分镜稿的细节 */}
            <span className="story-field-label">解说音色</span>
            <div className="story-voice-pick">
              <AppSelect
                value={narratorVoice}
                options={voiceOptions}
                onChange={setNarratorVoice}
                title="成片配音用这个解说音色（含克隆音色）"
                disabled={readOnly}
              />
            </div>
          </div>
          <div className="story-ai-zone">
            {/*
              嵌在任务卡里时这颗按钮由卡头承担（同一个动作，工作台把状态交给宿主），
              这里就不再摆一个同级主按钮——两颗权重一样的按钮并排，用户不知道该点哪个。
              进度面板和「重试缺图 / 重试这一步」这些上下文按钮照旧留在工作台里。
            */}
            {!hideGenerateButton && (
              <button
                type="button"
                className="ai-generate-button"
                disabled={pipelineRunning || generating || composing || hotLoading}
                onClick={() => void runPipeline()}
                aria-label="AI 成片"
                title="写分镜 → 缺图的镜头自动生图 → 配音+字幕+运镜合成，一次跑完"
              >
                <span className="ai-generate-icon" aria-hidden="true">
                  AI
                </span>
                <span className="ai-generate-label">
                  {pipeline?.status === "waiting"
                    ? "继续合成"
                    : pipelineRunning
                      ? "成片中…"
                      : generating
                        ? "生成中…"
                        : "成片"}
                </span>
              </button>
            )}
            <div className="story-ai-links">
              {/* 卡头已经给了「中止」，这里就不用再来一个 */}
              {pipelineRunning && !hideGenerateButton ? (
                <button type="button" className="link" onClick={() => void cancelPipeline()}>
                  中止
                </button>
              ) : null}
              {pipeline && !pipelineRunning ? (
                <button type="button" className="link" onClick={() => setPipeline(null)}>
                  收起
                </button>
              ) : null}
            </div>
          </div>
        </div>
        {pipeline && (
          <div className={`story-pipeline ${pipeline.status}`}>
            <ol className="story-pipeline-steps">
              {PIPELINE_STEPS.map((s, i) => {
                const order = PIPELINE_STEPS.findIndex((x) => x.key === s.key);
                const cur = PIPELINE_STEPS.findIndex((x) => x.key === pipeline.stage);
                // 当前阶段：running 时在转，waiting/error 时停在那一格
                const cls =
                  pipeline.stage === s.key
                    ? pipeline.status === "running"
                      ? "doing"
                      : pipeline.status === "waiting"
                        ? "wait"
                        : pipeline.status === "error"
                          ? "fail"
                          : "done"
                    : order < cur
                      ? "done"
                      : "todo";
                return (
                  <li key={s.key} className={`story-pipeline-step ${cls}`}>
                    <span className="story-pipeline-dot">{cls === "done" ? "✓" : order + 1}</span>
                    <span className="story-pipeline-label">{s.label}</span>
                    {/* 这一步连向下一步的线：这一步完成了线就变绿 */}
                    {i < PIPELINE_STEPS.length - 1 && (
                      <span className="story-pipeline-line" aria-hidden="true" />
                    )}
                  </li>
                );
              })}
            </ol>
            <div className="story-pipeline-msg">
              {pipeline.message}
              {(pipeline.status === "running" || pipeline.status === "waiting") &&
                ` · 已用时 ${pipelineSeconds}s`}
            </div>
            {pipeline.status === "waiting" && (
              <div className="story-pipeline-actions">
                <button
                  type="button"
                  className="primary small"
                  disabled={pipelineBusyRef.current}
                  onClick={() => void runPipeline({ skipStory: true })}
                >
                  ↻ 重试缺图（{pipeline.missing} 张），继续合成
                </button>
                <span className="story-muted">
                  也可以只给某一张点「生图」，然后在分镜里单独换图
                </span>
              </div>
            )}
            {pipeline.status === "error" && (
              <div className="story-pipeline-actions">
                <button
                  type="button"
                  className="secondary small"
                  onClick={() =>
                    void runPipeline({ skipStory: pipelineStageRef.current !== "story" })
                  }
                >
                  重试这一步
                </button>
              </div>
            )}
          </div>
        )}

        {generating && <div className="story-gen-tip">{genMsg || "请稍候，DeepSeek 正在写作…"}</div>}

        {!board && showLastDraft && lastDraft && (
          <div className="story-resume-row">
            <span className="story-field-label">上次方案</span>
            <span className="resume-title">
              {lastDraft.title || "未命名"}（{lastDraft.filledCount}/{lastDraft.shotCount} 图）
            </span>
            {boardLoading && <span className="story-muted">打开中…</span>}
            <button
              type="button"
              className="primary small"
              disabled={boardLoading}
              onClick={() => void openBoard(lastDraft.id)}
            >
              继续
            </button>
            <button
              type="button"
              className="danger small"
              disabled={boardLoading}
              onClick={() => void discardLastDraft()}
            >
              丢弃
            </button>
          </div>
        )}
      </section>

      {/* ============ ② 文案+生图：没分镜时也摆个空壳，位置先占好 ============ */}
      <section className="card-pad story-card">
        <div className="panel-title-row">
          <span className="panel-title">② 文案+生图</span>
          <span className="story-muted">
            {board
              ? `自动保存 · ${boardFilled}/${board.shots.length} 张图已就绪`
              : "出好分镜后，这里逐镜改文案、生图"}
            {/* 让用户一眼看到现在用的是哪个引擎（切了设置不用猜） */}
            {imageEngine ? ` · 生图引擎：${imageEngine.label}` : ""}
          </span>
        </div>

        {/* 引擎没就绪（如 ModelScope 没填 Token）先在这里说清楚，别等点了「生图」才报错 */}
        {imageEngine && !imageEngine.ready && imageEngine.message && (
          <div className="hint">{imageEngine.message}</div>
        )}

        {board ? (
        <>
          <div className="board-toolbar">
            {/* 只读态不给增删镜头：分镜是机器的产物；要改去「热点成片」页 */}
            {!readOnly && (
              <button type="button" className="secondary small" onClick={addManualShot}>
                ＋ 加一个自由镜头
              </button>
            )}
            <button type="button" className="secondary small" onClick={openBoardFolder}>
              打开草稿目录
            </button>
            <button
              type="button"
              className="secondary small"
              onClick={() =>
                void copyPrompt(
                  "all",
                  board.shots.map((s, i) => `镜头${i + 1}：${s.caption}`).join("\n\n")
                )
              }
            >
              {copiedKey === "all" ? "✓ 全文案已复制" : "复制全文案"}
            </button>
            {/* 生图提示词：跟旁白一样按镜头编号，每段前面带「生成图片：」 */}
            <button
              type="button"
              className="secondary small"
              onClick={() =>
                void copyPrompt(
                  "prompts",
                  board.shots
                    .map((s, i) => `镜头${i + 1}：生成图片：${s.imagePrompt}`)
                    .join("\n\n")
                )
              }
              title="复制所有镜头的画面提示词（生图用）"
            >
              {copiedKey === "prompts" ? "✓ 已复制生图提示词" : "复制生图提示词"}
            </button>
            {/* 只读态不给「删除方案」：这是编辑动作，不是过程操作 */}
            {!readOnly && (
              <button type="button" className="secondary small" onClick={() => void removeBoard()}>
                删除方案
              </button>
            )}
          </div>
          {/* 批量生图进度：跑的时候显示「第 n / 共 m 张」，结束后显示汇总 */}
          {batch ? (
            <div className={`batch-progress ${batch.running ? "" : "done"}`}>
              <span>{batchText(batch)}</span>
              {!batch.running && batch.items.some((i) => i.state === "failed") ? (
                <span className="story-muted">
                  失败的镜头可单独点这一镜的「生图」重试
                </span>
              ) : null}
              {!batch.running ? (
                <button type="button" className="link" onClick={dismissBatch}>
                  知道了
                </button>
              ) : null}
            </div>
          ) : null}

          {board.shots.length === 0 && (
            <div className="story-empty">还没有镜头，点「＋ 加一个自由镜头」。</div>
          )}

          <div className="shot-list">
            {board.shots.map((shot, i) => (
              <div className={`shot-card ${shot.imagePath ? "ready" : ""}`} key={shot.id}>
                <div className="shot-head">
                  <span className="shot-index">镜头 {i + 1}</span>
                  <span className={`shot-state ${shot.imagePath ? "ok" : ""}`}>
                    {shot.imagePath ? "图已就绪" : "待放图"}
                  </span>
                  {generatingShotId === shot.id && genShotMsg ? (
                    <span className="shot-gen-msg">{genShotMsg}</span>
                  ) : null}
                  <div className="shot-head-actions">
                    {/* 只读态不给改镜头顺序/删除：这些都是编辑动作 */}
                    {!readOnly && (
                      <>
                        <button
                          type="button"
                          className="secondary small"
                          disabled={i === 0}
                          onClick={() => moveShot(i, -1)}
                          title="上移"
                        >
                          ↑
                        </button>
                        <button
                          type="button"
                          className="secondary small"
                          disabled={i === board.shots.length - 1}
                          onClick={() => moveShot(i, 1)}
                          title="下移"
                        >
                          ↓
                        </button>
                        <button
                          type="button"
                          className="danger small"
                          onClick={() => removeShot(shot.id)}
                          title="删除镜头"
                        >
                          删除
                        </button>
                      </>
                    )}
                  </div>
                </div>

                <div className="shot-body">
                  <div className="shot-image-col">
                    <div
                      className={`shot-image-slot ${shot.imagePath ? "filled" : ""} ${readOnly ? "readonly" : ""}`}
                      onClick={readOnly ? undefined : () => void pickForShot(shot)}
                      onDrop={readOnly ? undefined : (e) => onDropImage(e, shot)}
                      onDragOver={readOnly ? undefined : (e) => e.preventDefault()}
                      title={readOnly ? "镜头配图（只读）" : "点击选择图片，或直接把图片拖进来"}
                    >
                      {shot.imagePath && shotUrls[shot.id] ? (
                        <img src={shotUrls[shot.id]} alt={`镜头${i + 1}`} />
                      ) : (
                        <div className="shot-image-empty">
                          <span className="shot-image-plus">＋</span>
                          <span>
                            {readOnly ? "这一镜还没出图" : "把生成的图拖到这里"}
                          </span>
                          {!readOnly && <span className="shot-image-sub">或点击选择图片</span>}
                        </div>
                      )}
                    </div>
                    {/* 运镜贴在图片下面：它管的就是"这张图怎么动" */}
                    <div className="shot-motion-row">
                      <span className="story-field-label">运镜</span>
                      <AppSelect
                        value={shot.motion.mode}
                        options={MOTION_OPTIONS}
                        onChange={(m) =>
                          updateShot(shot.id, { motion: { mode: m as MotionMode, amount: 25 } })
                        }
                        disabled={readOnly}
                      />
                    </div>
                  </div>

                  <div className="shot-text-col">
                    <div className="shot-field">
                      <span className="story-field-label">旁白 / 字幕</span>
                      <textarea
                        rows={3}
                        value={shot.caption}
                        placeholder="这段念出来的解说词"
                        readOnly={readOnly}
                        onChange={(e) => updateShot(shot.id, { caption: e.target.value })}
                      />
                    </div>
                    <div className="shot-field">
                      {/*
                        「重写 / 生图」都摆在这一行的右边：它们动的就是这个框里的字
                        （重写=让 AI 换一段描述，生图=按这段描述去生图引擎出一张）。
                        整镜级别的动作（搬图、删除）留在卡片右上角，位置即说明。
                      */}
                      <div className="story-field-head">
                        <span className="story-field-label">
                          画面提示词
                          {/* AI 建议的时长属于"这一镜该有多长"，跟画面提示词排在一起最省读 */}
                          {shot.durationHint ? (
                            <span className="story-field-note">（AI 建议 {shot.durationHint} 秒）</span>
                          ) : null}
                        </span>
                        <span className="story-field-actions">
                          {/* 只读态不给「重写 / 生图」：跑起来之后提示词与图都是机器的产物 */}
                          {!readOnly && (
                            <>
                              <button
                                type="button"
                                className="link"
                                disabled={regeneratingId === shot.id || !!generatingShotId || !!batch?.running}
                                onClick={() => void regenerateShot(shot)}
                                title="让 AI 按这一镜的旁白重写画面提示词（只改文字，不出图）"
                              >
                                {regeneratingId === shot.id ? "重写中…" : "重写"}
                              </button>
                              {/*
                                批量跑的时候这张要压住：同一份方案两套队列会互相打乱。
                              */}
                              <button
                                type="button"
                                className="link"
                                disabled={!!generatingShotId || !!batch?.running || regeneratingId === shot.id}
                                onClick={() => void generateShotImage(shot)}
                                title={
                                  batch?.running
                                    ? "批量生图正在进行，先等它跑完（整条成片的中止在第一步那里）"
                                    : "把这一镜的画面提示词交去生图，出图后自动存到这个镜头"
                                }
                              >
                                {generatingShotId === shot.id ? "生图中…" : "生图"}
                              </button>
                            </>
                          )}
                        </span>
                      </div>
                      <textarea
                        rows={4}
                        value={shot.imagePrompt}
                        placeholder="AI 生成后仍可手动修改"
                        readOnly={readOnly}
                        onChange={(e) => updateShot(shot.id, { imagePrompt: e.target.value })}
                      />
                    </div>
                  </div>
                </div>
              </div>
            ))}
          </div>
        </>
        ) : (
          <div className="story-empty">
            {readOnly
              ? "这一轮没有分镜——回工作台点卡头的「成片」跑一次。"
              : "出好分镜后，每个镜头的旁白 / 提示词 / 图片会显示在这里——先在①点「成片」。"}
          </div>
        )}
      </section>

      {/* ============ ③ 合成视频：没有分镜也先摆出来，预览区和输出目录从一开始就在 ============ */}      <section className="card-pad story-card">
        <div className="panel-title-row">
          <span className="panel-title">③ 合成视频</span>

          <span className="compose-head-actions">
            <span className="story-muted">
              {composing
                ? progress
                  ? `${stageText(progress.stage)} · ${progress.percent}%` +
                    (progress.currentLine !== undefined && progress.totalLines
                      ? `（${progress.currentLine}/${progress.totalLines} 段）`
                      : "")
                  : "正在准备…"
                : !board
                  ? "出好分镜，这里就能一键合成"
                  : boardFilled === board.shots.length
                    ? "配音 + 字幕 + 运镜，一条龙合成"
                    : `还有 ${board.shots.length - boardFilled} 张图没就绪`}
            </span>
            {composing && (
              <button type="button" className="link" onClick={cancelCompose}>
                取消
              </button>
            )}
            {/* 只读态不给「合成视频」：合成由卡头的「成片」整条跑，这里只展示结果 */}
            {board && !readOnly && (
              <button
                type="button"
                className="primary small primary-plain"
                disabled={composing || generating || boardFilled !== board.shots.length}
                onClick={() => void generateVideo()}
                title="配音 + 字幕 + 运镜，一条龙合成"
              >
                {composing ? `合成中（${composingSeconds}s）…` : "合成视频"}
              </button>
            )}
          </span>
        </div>

          {/*
            左预览、右按钮。
            预览区是**固定大小**的方框（跟镜头图片槽一个道理）：横屏片子横着显示、
            竖屏片子竖着显示，画面按自己的比例 contain 进来，不再由视频决定这个区域多高
            （以前 260 宽 + 竖屏 9:16 会撑出 460 多像素高，把按钮挤到下面）。
          */}
          <div className="compose-row">
            <div className={`compose-preview ${outputPath && previewUrl ? "filled" : ""}`}>
              {outputPath && previewUrl ? (
                <video controls src={previewUrl} />
              ) : (
                <div className="compose-preview-empty">
                  <span className="compose-preview-icon" aria-hidden="true">
                    ▶
                  </span>
                  <span>合成后在这里预览</span>
                </div>
              )}
            </div>

            <div className="compose-side">

              {/*
              标题 / 钩子 / 流量类型 / 画面风格：一行一个。
              前两个是你要拿去发布的文字，所以保持可改；后两个是 AI 定好的，直接当文本念出来
              —— 给只读的值套一个输入框框是假的交互暗示（点进去也改不了）。
              */}
              {board ? (
              <div className="board-fields">
                <div className="board-field">
                  <span className="story-field-label">标题：</span>
                  {titleEditing ? (
                    <input
                      autoFocus
                      className="board-title-input"
                      value={titleDraft}
                      placeholder="发布时用的标题"
                      onChange={(e) => setTitleDraft(e.target.value)}
                      onBlur={commitTitle}
                      onKeyDown={(e) => {
                        if (e.key === "Enter") {
                          e.preventDefault();
                          commitTitle();
                        } else if (e.key === "Escape") {
                          setTitleEditing(false);
                        }
                      }}
                    />
                  ) : (
                    <span className="board-editable">
                      <span className="board-readonly" title={board.title || undefined}>
                        {board.title || "（还没起标题）"}
                      </span>
                      {/* 只读态不给改标题（它是成片文件名，属于结果） */}
                      {!readOnly && (
                        <button
                          type="button"
                          className="board-edit-btn"
                          aria-label="编辑标题"
                          title="改标题（它会成为成片文件名）"
                          onClick={() => {
                            setTitleDraft(board.title);
                            setTitleEditing(true);
                          }}
                        >
                          ✎
                        </button>
                      )}
                    </span>
                  )}
                </div>
                {/*
                  钩子只读：视频里不出现、重写提示词的上下文也不用它（只用了标题/风格/旁白），
                  编辑它没有任何东西会变 —— 它是 AI 给的"开头角度"，看一眼就行。
                */}
                <div className="board-field" title="AI 建议的开头角度（只作参考，视频里不出现）">
                  <span className="story-field-label">钩子：</span>
                  <span className="board-readonly">{board.hook || "（AI 未给）"}</span>
                </div>
                {board.trigger && (
                  <div className="board-field" title="AI 为本篇选定的观众心理主类型，整篇文案围绕它强化">
                    <span className="story-field-label">流量类型：</span>
                    <span className="board-readonly">{board.trigger}</span>
                  </div>
                )}
                <div
                  className="board-field"
                  title="AI 自动生成，不可手改；会拼进每个镜头的画面提示词"
                >
                  <span className="story-field-label">画面风格：</span>
                  <span className="board-readonly">{board.style || "AI 生成后自动填入"}</span>
                </div>
                {/* 这两项是这条片子的设定，改在第一步：这里按标签属性的样子展示 */}
                <div className="board-field" title="在第一步「画面方向」里改">
                  <span className="story-field-label">画面方向：</span>
                  <span className="board-readonly">
                    {(board.resolution ?? resolution) === "landscape" ? "横屏 16:9" : "竖屏 9:16"}
                  </span>
                </div>
                <div className="board-field" title="在第一步「解说音色」里改">
                  <span className="story-field-label">解说音色：</span>
                  <span className="board-readonly">{voiceLabel}</span>
                </div>
              </div>
              ) : null}
            </div>

          </div>

{/*
  成片文件始终显示这一行：还没合成时显示输出目录（知道它待会儿会落到哪儿），
  合成完成后换成成片文件本身，并给「在文件夹中显示」。
*/}
        <div className="compose-actions">
          <span className="story-field-label">视频输出：</span>
          <div className="compose-actions-main">
            <div
              className="story-result-path"
              title={outputPath || outputDir || defaultOutDir || undefined}
            >
              {outputPath || outputDir || defaultOutDir || "默认目录加载中…"}
            </div>
            {outputPath ? (
              /*
               * 有片子：只留「在文件夹中显示」（成片一定落在 outputDir/video 里，
               * 「打开输出目录」打开的是同一个文件夹、只是不选中文件，是重复的那一个）。
               */
              <button
                type="button"
                className="secondary small"
                onClick={() => void window.dialogue.showInFolder(outputPath)}
              >
                在文件夹中显示
              </button>
            ) : (
              /* 还没合成：显示的是输出目录，所以给「在目录中显示」 */
              <button
                type="button"
                className="secondary small"
                onClick={() => void window.dialogue.openOutputDir()}
                title="在系统的文件资源管理器里打开这个目录"
              >
                在目录中显示
              </button>
            )}
          </div>
        </div>

      </section>
    </div>
  );
}
