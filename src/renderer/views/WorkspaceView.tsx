/*
 * SPDX-License-Identifier: GPL-3.0-only
 * Copyright (c) 2026 宝螺 / Baoluo contributors
 * 本文件属于「宝螺 / Baoluo」。除 GPL-3.0 外还适用 ADDITIONAL_TERMS.md 里的附加条款：
 * 分发时须保留来源署名；修改版对外分发时不得沿用「宝螺」名称与图标。
 */
/**
 * 工作台：一句话 → 一张可改的任务卡 → 执行。
 *
 * 设计见 doc/Agent化改造-产品形态设计.md：
 * 左栏是任务，中栏是任务卡（步骤可见、参数可改、每步能单独重跑），右栏是对话入口。
 * 现有那些页面不删，收在侧边栏的「手动模式」里，当高手模式用。
 */
import { useCallback, useEffect, useRef, useState } from "react";
import type { ReactNode } from "react";
import type { AgentApi, RecordsApi } from "../../preload";
import type { AgentParam, AgentStep, AgentTask } from "../../shared/agent-types";
import type { HotItem, HotSource } from "../../shared/storyboard-types";
import type { TemplateConfig } from "../../shared/dialogue-types";
import type { WorkRecordSummary } from "../../shared/record-types";
import { formatHeat } from "../../shared/hot-format";
import { usePageActive } from "../components/KeepAlive";
import HotStoryWorkbench, {
  type HotStoryWorkbenchHandle,
  type PipelineButtonState,
} from "../components/hot-story/HotStoryWorkbench";
import ParamField from "../components/workspace/ParamField";
import RoleCards from "../components/workspace/RoleCards";
import TopicChips from "../components/workspace/TopicChips";
import AppSelect from "../components/AppSelect";
import tianluAvatar from "../assets/tianlu-avatar.png";
import { useConfirm } from "../components/ConfirmDialog";
import { formatListTime, SideRow } from "../components/SideList";
import type { StepFieldApi } from "../components/workspace/fieldApi";

declare global {
  interface Window {
    agent: AgentApi;
    /** 对话模板库：卡片上「用模板」从这里读 */
    records: RecordsApi;
  }
}

interface Bubble {
  role: "user" | "bot";
  text: string;
  /** 用户消息附的图（+ 号上传）：气泡里回显缩略图 */
  images?: string[];
}

function errText(e: unknown): string {
  const raw = e instanceof Error ? e.message : String(e);
  // 渲染层被 Vite 热更新了、但主进程还是上一次启动的那份：接口没注册。
  // 这不是代码问题，把应用整个退掉重开即可（npm run dev 会先重编主进程）。
  if (raw.includes("No handler registered for 'agent:")) {
    return "主进程还是旧版本，没注册工作台的接口。完全退出宝螺再重开就行（开发模式下 npm run dev 会先重新编译主进程）。";
  }
  return raw;
}


function statusText(t: AgentTask): string {
  switch (t.status) {
    case "running":
      return "执行中";
    case "done":
      return "已完成";
    case "failed":
      return "出错";
    case "cancelled":
      return "已取消";
    default:
      return "待执行";
  }
}

function dot(status: AgentStep["status"]): string {
  switch (status) {
    case "done":
      return "✓";
    case "running":
      return "●";
    case "failed":
      return "!";
    case "skipped":
      return "–";
    default:
      return "○";
  }
}

/**
 * 把参数分成若干行：独占一行的（主题、镜头选图）各自成行，
 * 标了 breakBefore 的（音色+语速这组）从新行开始，其余跟在上一行后面。
 * 显式分行不靠 flex 折行凑巧——窗口窄了也是「时长+画面」一行、「音色+语速」一行。
 */
function paramRows(params: AgentParam[]): AgentParam[][] {
  const rows: AgentParam[][] = [];
  for (const p of params) {
    const startNew = rows.length === 0 || p.ownLine || p.breakBefore || p.type === "image";
    if (startNew) rows.push([p]);
    else rows[rows.length - 1].push(p);
  }
  return rows;
}

interface Mention {
  /** 名单里显示的名字，如 "@对话" */
  label: string;
  hint: string;
  /** 选中后往输入框里补的文本 */
  insert: string;
  /** 这一条不是剧本，而是"去挑一条热点" */
  hot?: boolean;
}

/** 打 @ 弹出来的名单：跟在群里 @ 人干活一样，只是这些"人"是宝螺的几条流水线 */
const MENTIONS: Mention[] = [
  { label: "@对话", hint: "给主题 → 双人对话视频", insert: "@对话 " },
  { label: "@图文", hint: "给主题 → 单人图文解说", insert: "@图文 " },
  { label: "@语音", hint: "给一段文字 → 用指定音色念出来", insert: "@语音 " },
  { label: "@识别", hint: "给音视频文件 → 出文案（本地跑）", insert: "@识别 " },
  { label: "@变声", hint: "给音视频文件 → 换音色重念", insert: "@变声 " },
  { label: "@爆款", hint: "给音视频文件 → 拆解可复用的方法", insert: "@爆款 " },
  { label: "@热点", hint: "不知道写什么？从榜单里挑一条", insert: "", hot: true },
];

interface WorkspaceViewProps {
  /** 左栏顶部的导航块（App 传下来的 SideNav）：任务列表收起时它也必须在 */
  nav?: ReactNode;
  /** 左栏任务列表是否显示（开关在顶部条左端，状态在 App）：false 时对话区摊满 */
  listShown?: boolean;
  /** 右侧操作区是否展开（开关在顶部条右端，状态在 App）：收起后对话区摊满 */
  panelOpen?: boolean;
  /** 请求展开操作区：点任务行、发消息建卡时叫它 */
  onTogglePanel?: () => void;
  /**
   * 去「热点成片」页细改某份方案（工作台这边定位成全自动，编辑都在那边）。
   * 由 App 负责切页 + 把 boardId 交给那一页打开。
   */
  onOpenBoardInStoryPage?: (boardId: string) => void;
}

export default function WorkspaceView({
  nav,
  listShown = true,
  panelOpen = true,
  onTogglePanel,
  onOpenBoardInStoryPage,
}: WorkspaceViewProps = {}) {
  /** 工作台被保活后隐藏的实例不消费全局进度广播（内嵌分镜工作台用） */
  const pageActive = usePageActive();
  const [tasks, setTasks] = useState<AgentTask[]>([]);
  const [activeId, setActiveId] = useState<string | null>(null);
  const [input, setInput] = useState("");
  /** 随消息附图的绝对路径列表（+ 号选图），发送后清空；预览 URL 缓存见 attachUrls */
  const [attachments, setAttachments] = useState<string[]>([]);
  const [attachUrls, setAttachUrls] = useState<Record<string, string>>({});
  const [bubbles, setBubbles] = useState<Bubble[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [elapsed, setElapsed] = useState(0);
  const [mediaUrl, setMediaUrl] = useState("");
  const [edits, setEdits] = useState<Record<string, string>>({});
  /** 热点榜单：选热点建卡用（「热点成片」那条链路） */
  const [hotOpen, setHotOpen] = useState(false);
  const [hotSources, setHotSources] = useState<HotSource[]>([]);
  const [hotSource, setHotSource] = useState("");
  const [hotItems, setHotItems] = useState<HotItem[]>([]);
  const [hotBusy, setHotBusy] = useState(false);
  /** 正在试听哪个角色（A/B）；null = 没在放 */
  const [previewing, setPreviewing] = useState<string | null>(null);
  const previewAudioRef = useRef<HTMLAudioElement | null>(null);
  /** 选过图的参数：把路径换成能塞进 <img> 的地址，回显缩略图 */
  const [imageUrls, setImageUrls] = useState<Record<string, string>>({});
  /** 删除确认框：左栏任务行的 ✕ 先问一句再删 */
  const [confirmDialog, confirmDelete] = useConfirm();
  /** 打 @ 的名单：mentionOff 用于按 Esc 关掉后不再自动弹 */
  const [mentionIdx, setMentionIdx] = useState(0);
  const [mentionOff, setMentionOff] = useState(false);
  const inputRef = useRef<HTMLTextAreaElement>(null);

  const activeTask = tasks.find((t) => t.id === activeId) ?? null;
  const running = busy || activeTask?.status === "running";
  /**
   * **这张卡自己**在不在跑。
   *
   * 必须跟 `busy` 分开：busy 是"我正在等某个任务跑完"，而那个任务可能是别的卡
   * （run() 会带上目标任务，自动跑也是）。用它画秒表和「取消」，
   * 否则在一张卡上点执行、切到另一张卡，那边也会冒出「已用时 Xs」和一个取消按钮。
   */
  const shownRunning = activeTask?.status === "running";
  /**
   * 当前任务卡的引用副本：onPipelineState 是空依赖的 useCallback（见下），
   * 里面读不到最新的 activeTask，只能走 ref。
   */
  const activeTaskRef = useRef<AgentTask | null>(null);
  activeTaskRef.current = activeTask;
  /**
   * 「工作区卡」：整张卡只有一个内嵌分镜工作台步骤（hot-story），没有可跑的步骤。
   *
   * 这种卡上不摆「执行」（点了什么也不发生），也不画步骤列表（那行「1. 热点成片 ○」
   * 提供不了任何信息），卡头的主按钮直接就是工作台那颗「成片」——动作和状态都由
   * 工作台交出来（见 HotStoryWorkbench 的 controlRef / onPipelineState），不是另做一套。
   *
   * 其余卡（下载+文案、对话视频、爆款拆解、带链接的图文解说…）都有真步骤，保持流水线卡。
   */
  const isWorkspaceCard =
    !!activeTask && activeTask.steps.length > 0 && activeTask.steps.every((s) => s.kind === "hot-story");
  /**
   * 这张卡是不是「全自动」形态：对话视频卡。
   *
   * 工作台的定位是"说一句话就出片"，所以对话卡不摆任何配置——
   * 参数、角色卡、模板选择器、脚本块全都不画，只显示每步的进度和最后的成片。
   * 要改配置去「视频生成 → 对话模式」页（那边是手动模式，有完整的配置面板）。
   *
   * 判定：步骤里有 write-script（对话链独有）——图文解说卡走 hot-story（另一种全自动形态），
   * 下载/变声/识别这些单步卡仍按普通流水线卡画。
   */
  const isAutoCard =
    !!activeTask &&
    activeTask.steps.some((s) => s.kind === "write-script") &&
    activeTask.steps.some((s) => s.kind === "compose");
  /**
   * 这张卡开跑过没有。
   * 跑过之后，工作台里的一切都当「过程」：只给看不给改（要改去「热点成片」页）。
   *
   * 判断依据是 state.hotRanAt，不是 status：工作区卡的执行走工作台内部的流水线，
   * 不经过 agent:run，所以 status 永远停在 draft（实测过，光看 status 会让只读永远不生效）。
   * 另外：卡上之前留下的分镜（storyboardId）不算——那份可能是刚打开就自动建的草稿。
   */
  const taskStarted = !!activeTask && !!activeTask.state?.hotRanAt;
  /** 工作台主按钮的动作（工作台挂上来的）与状态（工作台发过来的） */
  const workbenchRef = useRef<HotStoryWorkbenchHandle | null>(null);
  const [pipelineButton, setPipelineButton] = useState<PipelineButtonState | null>(null);
  /**
   * 对话模板库的列表：卡片上那个「用模板」下拉要用它当选项，所以进卡片就拉一次。
   * （改成下拉框之后不能"点开再拉"：选项得先备好，菜单才能立刻弹出来。）
   */
  const [templates, setTemplates] = useState<WorkRecordSummary[]>([]);
  const reloadTemplates = useCallback(async () => {
    try {
      setTemplates(await window.records.list("template"));
    } catch {
      setTemplates([]);
    }
  }, []);

  useEffect(() => {
    if (!pageActive || !activeId) return;
    void reloadTemplates();
  }, [pageActive, activeId, reloadTemplates]);
  /**
   * 值没变就复用旧对象：工作台每次状态变化都会发一份，宿主若每次都 setState（新对象）
   * 就会多渲染一轮，而渲染又会触发工作台重新发——来回就成环了。
   *
   * 顺带把"开跑过"记到任务上（hotRanAt）：流水线一进 running 就写一次，
   * 之后这张卡重开、甚至重启应用，都还是过程态（只读）。
   */
  const onPipelineState = useCallback(
    (s: PipelineButtonState) => {
      setPipelineButton((prev) =>
        prev &&
        prev.canRun === s.canRun &&
        prev.label === s.label &&
        prev.disabledReason === s.disabledReason &&
        prev.running === s.running &&
        prev.missing === s.missing
          ? prev
          : s
      );
      if (s.running && activeTaskRef.current && !activeTaskRef.current.state?.hotRanAt) {
        void patchHotRan(activeTaskRef.current);
      }
    },
    []
  );

  /**
   * 内嵌分镜工作台。两处渲染它：带链接的解说卡里（挂在步骤行下面），和工作区卡里（直接当卡身）。
   * 只有「主按钮谁画」不同：工作区卡把它移到卡头（asCardBody），所以这里要收状态、
   * 并且不让工作台再摆一个同级主按钮。
   */
  function renderWorkbench(task: AgentTask, step: AgentStep, asCardBody: boolean) {
    /*
     * 主题预填：建卡时带的话题优先；没有就用已提取的文案开头。
     * 主题到位时重挂一次（key 带上它），工作台才能捡到晚来的文案。
     */
    const stepTopic = (step.params ?? []).find((p) => p.key === "topic")?.value ?? "";
    const initialTopic = stepTopic || task.state?.transcript?.slice(0, 40) || "";
    return (
      <HotStoryWorkbench
        key={`${task.id}:${initialTopic}`}
        active={pageActive}
        initialHot={task.hot ?? null}
        initialTopic={initialTopic}
        initialBoardId={task.state?.storyboardId ?? null}
        onBoardIdChange={(id) => void patchBoardId(task, id)}
        showLastDraft={false}
        hideGenerateButton={asCardBody}
        controlRef={asCardBody ? workbenchRef : undefined}
        onPipelineState={asCardBody ? onPipelineState : undefined}
        /*
         * 工作台的图文解说卡定位成「全自动」：
         *   - 热点在对话框里选，卡上不再摆热榜（同一件事只留一个地方改）
         *   - 点过一次之后下面全是过程：只给看，不给改；要改去「热点成片」页
         *   - 跑之前先确认一次（一次要花 AI 调用 + 若干张图 + 几分钟）
         */
        hideHotPicker={asCardBody}
        readOnly={asCardBody && taskStarted}
        confirmBeforeRun={
          asCardBody
            ? "将调用 AI 写分镜，并为缺图镜头自动生成图片（通常 5~12 张），然后配音合成，可能需要 3~5 分钟。现在开始吗？"
            : undefined
        }
      />
    );
  }
  /**
   * 文本类产物：文案 / 爆款拆解报告，有哪个就摊哪个。
   * 脚本不算产物——它是「写对话脚本」那一步的中间稿，摆在那一步的参数下面。
   */
  const textArtifact =
    activeTask?.state?.transcript ?? activeTask?.state?.sniffReport;
  /** 写好的对话脚本：贴在「写对话脚本」那一步里，不往产物区放 */
  const scriptArtifact = activeTask?.state?.script;

  /** 拆解爆款给出的候选选题 */
  const sniffTopics = activeTask?.state?.sniffTopics ?? [];

  /** 当前任务卡上所有选过图的参数路径（去重，顺序稳定） */
  const imagePaths = Array.from(
    new Set(
      (activeTask?.steps ?? []).flatMap((s) =>
        (s.params ?? []).filter((p) => p.type === "image" && p.value).map((p) => p.value)
      )
    )
  );
  const imageSig = imagePaths.join("|");
  const imageUrlCache = useRef<Record<string, string>>({});

  // 多行输入时只看光标所在那一行，免得在第二行打字被第一行的 @ 拽出名单
  const lineStart = input.lastIndexOf("\n") + 1;
  const lastAt = input.lastIndexOf("@");
  const atIndex = lastAt >= lineStart ? lastAt : -1;
  const atTail = atIndex >= 0 ? input.slice(atIndex + 1) : "";
  const mentionList =
    !mentionOff && atIndex >= 0 && !/\s/.test(atTail)
      ? MENTIONS.filter((m) => m.label.slice(1).startsWith(atTail))
      : [];
  const mentionPick = Math.max(0, Math.min(mentionIdx, mentionList.length - 1));

  function applyTask(task: AgentTask): void {
    setTasks((prev) => {
      const i = prev.findIndex((t) => t.id === task.id);
      if (i < 0) return [task, ...prev];
      const next = prev.slice();
      next[i] = task;
      return next;
    });
  }

  async function refresh(preferId?: string): Promise<void> {
    try {
      const list = await window.agent.list();
      setTasks(list);
      const wanted = preferId ?? activeId;
      if (wanted && list.some((t) => t.id === wanted)) setActiveId(wanted);
      else if (list.length) setActiveId(list[0].id);
      else setActiveId(null);
    } catch (e: unknown) {
      setError(errText(e));
    }
  }

  useEffect(() => {
    void refresh();
    const off = window.agent.onProgress((p) => {
      setTasks((prev) => {
        const i = prev.findIndex((t) => t.id === p.taskId);
        if (i < 0) return prev;
        const next = prev.slice();
        if (p.task) {
          next[i] = p.task;
        } else if (p.step) {
          const step = p.step;
          const merged = { ...next[i] };
          merged.status = "running";
          merged.steps = merged.steps.map((s) => (s.id === step.id ? { ...s, ...step } : s));
          next[i] = merged;
        }
        return next;
      });
    });
    return off;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  /** 产物预览：视频/音频要先去主进程换一个能塞进 <video> 的 URL */
  useEffect(() => {
    let alive = true;
    setMediaUrl("");
    const p = activeTask?.resultPath;
    const kind = activeTask?.resultKind;
    if (!p || (kind !== "video" && kind !== "audio")) return;
    window.media
      .toUrl(p)
      .then((u) => {
        if (alive) setMediaUrl(u);
      })
      .catch(() => {
        /* 预览失败不影响产物本身，下面还有「打开」按钮 */
      });
    return () => {
      alive = false;
    };
  }, [activeTask?.resultPath, activeTask?.resultKind]);

  /**
   * 选过图的参数要看得见图本身，不是只有一行路径。
   * 换过的路径记在 ref 里，切来切去不重复问主进程（也免得进依赖反复触发）。
   */
  useEffect(() => {
    let alive = true;
    const todo = (imageSig ? imageSig.split("|") : []).filter((p) => !imageUrlCache.current[p]);
    if (!todo.length) return;
    (async () => {
      for (const p of todo) {
        try {
          imageUrlCache.current[p] = await window.media.toUrl(p);
        } catch {
          /* 图不在了就不显示缩略图，路径本身还在输入框里 */
        }
      }
      if (alive) setImageUrls({ ...imageUrlCache.current });
    })();
    return () => {
      alive = false;
    };
  }, [imageSig]);

  /** 跑任务时走一个「已用时」，长任务不至于看起来像卡死（只给"正在跑的这张卡"走） */
  useEffect(() => {
    if (!shownRunning) return;
    const t0 = Date.now();
    setElapsed(0);
    const timer = window.setInterval(() => setElapsed(Math.round((Date.now() - t0) / 1000)), 1000);
    return () => window.clearInterval(timer);
  }, [activeId, shownRunning]);

  async function createFrom(
    instruction: string,
    hot?: HotItem,
    /** 气泡里实际展示的内容：默认就是指令原文（附图时由 send 传缩略图 + 原文） */
    bubble?: { text: string; images?: string[] }
  ): Promise<void> {
    setError(null);
    setBubbles((prev) => [
      ...prev,
      {
        role: "user",
        text: bubble ? bubble.text : hot ? `按热点：${hot.title}` : instruction,
        images: bubble?.images,
      },
    ]);
    try {
      const r = await window.agent.create(instruction, hot);
      if (r.task) {
        const task = r.task;
        applyTask(task);
        setActiveId(task.id);
        // 操作区收着时建了卡：拉回来，不然卡建好了用户看不见
        if (!panelOpen) onTogglePanel?.();
        /*
         * 建卡回复只发一条：有自动跑步骤时由 autoRunHint 说（它更具体，还带"跑到哪停"），
         * 否则发 router 的 summary。两句都发过——说的是同一件事，看着像复读。
         */
        const auto = hasAutoSteps(task);
        setBubbles((prev) => [
          ...prev,
          { role: "bot", text: auto ? autoRunHint(task) : r.parse.summary },
        ]);
        await autoRun(task);
      } else {
        setBubbles((prev) => [...prev, { role: "bot", text: r.parse.summary }]);
      }
    } catch (e: unknown) {
      setError(errText(e));
    }
  }

  /** + 号选图：一张一张加（对话框复用 agent:chooseFile 的图片选择框） */
  async function pickImage(): Promise<void> {
    try {
      const p = await window.agent.chooseFile({ kind: "image" });
      if (!p) return;
      setAttachments((prev) => (prev.includes(p) ? prev : [...prev, p]));
      if (!attachUrls[p]) {
        const url = await window.media.toUrl(p);
        setAttachUrls((prev) => ({ ...prev, [p]: url }));
      }
    } catch (e: unknown) {
      setError(errText(e));
    }
  }

  async function send(): Promise<void> {
    const text = input.trim();
    if (!text && attachments.length === 0) return;
    // 有图时：气泡里回显缩略图 + 原文，指令尾部带上路径——任务卡（和后面的流程）能拿到它们；
    // 纯文本链路暂时"看得见用不上"，图片的深语义（选作某镜头配图等）后面再接
    const imgs = attachments;
    setInput("");
    setAttachments([]);
    await createFrom(imgs.length ? `${text}\n（附图 ${imgs.length} 张：${imgs.join("；")}）` : text, undefined, {
      text,
      images: imgs.length ? [...imgs] : undefined,
    });
  }

  /** 拉榜单：源只取一次，之后切源只重拉列表 */
  async function ensureHotLoaded(): Promise<void> {
    if (hotSources.length) {
      if (!hotItems.length && hotSource) await loadHot(hotSource);
      return;
    }
    setHotBusy(true);
    try {
      const sources = await window.storyboard.hotSources();
      setHotSources(sources);
      if (sources.length) await loadHot(sources[0].key);
    } catch (e: unknown) {
      setError(errText(e));
    } finally {
      setHotBusy(false);
    }
  }

  async function toggleHot(): Promise<void> {
    const next = !hotOpen;
    setHotOpen(next);
    if (next) await ensureHotLoaded();
  }

  async function loadHot(key: string): Promise<void> {
    setHotSource(key);
    setHotBusy(true);
    setHotItems([]);
    try {
      setHotItems(await window.storyboard.hotList(key));
    } catch (e: unknown) {
      setError(errText(e));
    } finally {
      setHotBusy(false);
    }
  }

  /** 选中一条热点：直接按「图文解说」建卡，榜单来源一起带上 */
  async function pickHot(item: HotItem): Promise<void> {
    setHotOpen(false);
    await createFrom(`图文解说 ${item.title}`, item);
  }

  /** 名单里选了一条：补进输入框，或者去开热点榜单 */
  function pickMention(m: Mention): void {
    const head = input.slice(0, atIndex);
    setMentionOff(true);
    setMentionIdx(0);
    if (m.hot) {
      setInput(head.trim());
      // 再点一次 @热点 就是收起
      void toggleHot();
    } else {
      setInput(`${head}${m.insert}`);
    }
    inputRef.current?.focus();
  }

  /**
   * 跑任务。
   *
   * `auto` = 建卡后自动跑的那一步：这时"已经有任务在跑"不算错误，
   * 安静跳过就行——自动链路上不摆手动重跑，免得用户和自动跑抢同一个任务。
   */
  async function run(
    stepId?: string,
    task: AgentTask | null = activeTask,
    auto = false
  ): Promise<AgentTask | null> {
    if (!task) return null;
    setError(null);
    setBusy(true);
    let updated: AgentTask | null = null;
    try {
      updated = await window.agent.run({ taskId: task.id, stepId });
      applyTask(updated);
    } catch (e: unknown) {
      if (!auto) setError(errText(e));
    } finally {
      setBusy(false);
      setEdits({});
      await refresh(task.id);
    }
    return updated;
  }

  /**
   * 建完卡自动往下跑的步骤类型。
   *
   * 工作台的定位是**全自动**：说一句话就出片，中间不停下来让人配参数
   * （要改配置去「视频生成」页，那边是手动模式）。
   *   - transcribe：从素材提文案（对话链的台词素材，用户不用管）
   *   - write-script：写台词（AI）
   *   - dialogue-config：套模板配好角色画面（形象图/音色/运镜都是模板给的）
   *   - compose / compose-narration：合成出片（最耗资源：逐句 TTS + ffmpeg 渲染，
   *     30 秒的片子要 1~3 分钟）
   */
  const AUTO_KINDS = new Set([
    "transcribe",
    "write-script",
    "dialogue-config",
    "compose",
    "compose-narration",
  ]);

  /** 这张卡有没有会自动跑的步骤（决定要不要先跟用户说一句） */
  function hasAutoSteps(task: AgentTask): boolean {
    return task.steps.some((s) => AUTO_KINDS.has(s.kind) && s.status !== "done");
  }

  /** 自动跑之前的一句话：说清"我在替你做什么"（工作台是全自动，一路到出片） */
  function autoRunHint(task: AgentTask): string {
    const kinds = task.steps.filter((s) => AUTO_KINDS.has(s.kind)).map((s) => s.kind);
    const parts: string[] = [];
    if (kinds.includes("transcribe")) parts.push("提文案");
    if (kinds.includes("write-script")) parts.push("写台词");
    if (kinds.includes("dialogue-config")) parts.push("按模板配好角色画面");
    if (kinds.includes("compose") || kinds.includes("compose-narration")) parts.push("合成出片");
    return `${parts.join(" → ")}，我这就一路跑完（写台词十几秒、合成要几分钟）。要改配置去「视频生成」页。`;
  }

  async function autoRun(task: AgentTask): Promise<void> {
    for (const step of task.steps) {
      if (!AUTO_KINDS.has(step.kind)) break;
      const after = await run(step.id, task, true);
      // 这一步没跑成（解析失败、别的任务正占着、AI 报错）就停在这儿，卡上照样能自己点
      if (!after || after.steps.find((s) => s.id === step.id)?.status !== "done") break;
    }
  }

  function editKey(stepId: string, key: string): string {
    return `${stepId}.${key}`;
  }

  /**
   * 卡头那颗主按钮叫什么：看"下一个要跑的步骤"是什么。
   *   - 只剩合成 → 「合成视频」（用户一眼知道点下去就是出片）
   *   - 还有别的步骤 → 「执行」（通用）
   * 对话模式建卡后会自动跑完写脚本/角色画面，所以通常停在这里时按钮就是「合成视频」。
   */
  function runButtonLabel(task: AgentTask | null): string {
    if (!task) return "执行";
    const next = task.steps.find((s) => s.status !== "done");
    if (!next) return "执行";
    return next.kind === "compose" ? "合成视频" : "执行";
  }

  function valueOf(step: AgentStep, p: AgentParam): string {
    return edits[editKey(step.id, p.key)] ?? p.value;
  }

  /** 参数改完提交：主进程会把这一步和下游打回未开始（结果过期了） */
  async function commitParam(step: AgentStep, p: AgentParam, value: string): Promise<void> {
    const k = editKey(step.id, p.key);
    setEdits((prev) => {
      const next = { ...prev };
      delete next[k];
      return next;
    });
    if (!activeTask || value === p.value) return;
    try {
      applyTask(
        await window.agent.updateParams({
          taskId: activeTask.id,
          stepId: step.id,
          params: [{ key: p.key, value }],
        })
      );
    } catch (e: unknown) {
      setError(errText(e));
    }
  }

  async function pickFile(step: AgentStep, p: AgentParam): Promise<void> {
    if (!activeTask) return;
    try {
      const picked = await window.agent.chooseFile({
        kind: p.type === "image" ? "image" : "media",
        currentPath: p.value || undefined,
      });
      if (picked) await commitParam(step, p, picked);
    } catch (e: unknown) {
      setError(errText(e));
    }
  }

  /**
   * 把分镜方案 id 写回任务：内嵌的分镜工作台建好/打开/删除方案时调用，
   * 下次打开这张卡还能续上同一份方案。
   */
  async function patchBoardId(task: AgentTask, boardId: string | null): Promise<void> {
    try {
      applyTask(await window.agent.patchState({ taskId: task.id, patch: { storyboardId: boardId ?? undefined } }));
    } catch (e: unknown) {
      // 写不进去只影响「下次打开续上」，不影响工作台本身
      setError(errText(e));
    }
  }

  /**
   * 记下"这张卡跑过 成片"。
   * 写进任务状态（持久化），这样界面把下面整块切成就地只读，重开卡/重启应用也还是只读。
   */
  async function patchHotRan(task: AgentTask): Promise<void> {
    try {
      applyTask(await window.agent.patchState({ taskId: task.id, patch: { hotRanAt: Date.now() } }));
    } catch (e: unknown) {
      // 记不上只影响"只读态"，别的照旧
      setError(errText(e));
    }
  }

  // ---------------------------------------------------------------------------
  // 卡片上用模板：对话模板库是「对话模式」页在管，这里只负责"套到这张卡上"
  // ---------------------------------------------------------------------------

  /** 模板下拉里"不用模板"那一项的值（不是模板 id，是"清掉模板配置"） */
  const NO_TEMPLATE = "__none__";

  /**
   * 这一步是不是"角色配置"（要摆两个人物卡 + 选择模板）。
   *
   * 「角色与画面」是拆分后新加的步骤；拆分前建的**老卡片**把那些参数挂在 compose 那一步上，
   * 所以也认——但必须**真有那些参数**才算：新卡片的 compose 是空的，
   * 只看 kind 的话会给它渲染出两个空壳人物卡（踩过）。
   */
  function isRoleStep(step: AgentStep): boolean {
    if (step.kind === "dialogue-config") return true;
    return step.kind === "compose" && (step.params ?? []).some((p) => p.key === "imageFortune");
  }

  /**
   * 成片/音频预览该挂在哪一步下面。
   *
   * 首选：这一步就是「出成片」的那一步（对话链 compose、图文/爆款链 compose-narration）。
   * 兜底：这条链**没有**独立合成步骤——图文解说的合成在内嵌分镜工作台里做（只有 hot-story 一步）、
   *   语音合成产的是音频（只有 tts 一步）——那就挂在最后一步下面，
   *   否则这些链路的产物会没地方显示（去掉产物模块时踩过）。
   */
  function isResultStep(step: AgentStep, task: AgentTask | null): boolean {
    if (step.kind === "compose" || step.kind === "compose-narration") return true;
    const steps = task?.steps ?? [];
    const hasCompose = steps.some((s) => s.kind === "compose" || s.kind === "compose-narration");
    if (hasCompose) return false;
    return steps.length > 0 && steps[steps.length - 1].id === step.id;
  }

  /**
   * 这一步的产物是文本（文案 / 拆解报告）：摊在它下面。
   * 两种来源——「提取文案」出 transcript，「拆解爆款」出 sniffReport。
   */
  function isArtifactStep(step: AgentStep): boolean {
    if (activeTask?.state?.transcript && step.kind === "transcribe") return true;
    return Boolean(activeTask?.state?.sniffReport && step.kind === "sniff");
  }

  /**
   * 「不用模板」：把模板带来的那套配置清掉，回到出厂默认。
   *
   * 默认值跟新建一张卡时主进程给的完全一致：音色/音量取「设置」里的默认，
   * 运镜推近 25%，比例竖屏，形象图清空。
   * 语速/语调一律不动（卡上没有它们的 UI，从模板到重置都不碰，规则才简单可预期）。
   */
  async function resetStepConfig(step: AgentStep): Promise<void> {
    if (!activeTask) return;
    setError(null);
    try {
      const dw = await window.dialogue.getSettings();
      const patch = [
        { key: "imageFortune", value: "" },
        { key: "imageCustomer", value: "" },
        { key: "voiceFortune", value: dw.voiceFortune },
        { key: "voiceCustomer", value: dw.voiceCustomer },
        { key: "volumeA", value: String(dw.prosody.a.volume) },
        { key: "volumeB", value: String(dw.prosody.b.volume) },
        { key: "motionModeA", value: "zoom-in" },
        { key: "motionAmountA", value: "25" },
        { key: "motionModeB", value: "zoom-in" },
        { key: "motionAmountB", value: "25" },
      ].filter((p) => step.params?.some((x) => x.key === p.key));
      if (patch.length) {
        applyTask(await window.agent.updateParams({ taskId: activeTask.id, stepId: step.id, params: patch }));
      }
      const resStep = activeTask.steps.find((s) => s.params?.some((p) => p.key === "resolution"));
      if (resStep) {
        applyTask(
          await window.agent.updateParams({
            taskId: activeTask.id,
            stepId: resStep.id,
            params: [{ key: "resolution", value: "portrait" }],
          })
        );
      }
    } catch (e: unknown) {
      setError(errText(e));
    }
  }

  /**
   * 把一份模板套到这张卡上。
   *
   * 写这几项：形象图、音色、音量、运镜（甲乙各自）、画面比例。
   * **语速/语调刻意跳过**：卡上没有这两项的 UI（按需求撤掉了），
   * 写进去会变成"生效但看不见、也没法改"的状态——宁可少套一项。
   *
   * 改参数会让这张卡回到「未执行」（updateParams 的既有行为），跑过的卡套模板 = 要重跑。
   */
  async function applyTemplateToStep(step: AgentStep, templateId: string): Promise<void> {
    if (!activeTask) return;
    setError(null);
    try {
      const rec = await window.records.get<TemplateConfig>("template", templateId);
      if (!rec) return;
      const cfg = rec.payload;
      const has = (key: string) => step.params?.some((p) => p.key === key) ?? false;
      const patch: Array<{ key: string; value: string }> = [];
      const add = (key: string, v: string | number | null | undefined) => {
        if (v === null || v === undefined || !has(key)) return;
        patch.push({ key, value: String(v) });
      };
      add("imageFortune", cfg.imageFortune ?? "");
      add("imageCustomer", cfg.imageCustomer ?? "");
      add("voiceFortune", cfg.voices?.voiceFortune);
      add("voiceCustomer", cfg.voices?.voiceCustomer);
      add("volumeA", cfg.voices?.prosody?.a?.volume);
      add("volumeB", cfg.voices?.prosody?.b?.volume);
      add("motionModeA", cfg.motionRoleA?.mode);
      add("motionAmountA", cfg.motionRoleA?.amount);
      add("motionModeB", cfg.motionRoleB?.mode);
      add("motionAmountB", cfg.motionRoleB?.amount);
      if (patch.length) {
        applyTask(
          await window.agent.updateParams({
            taskId: activeTask.id,
            stepId: step.id,
            params: patch,
          })
        );
      }
      // 画面比例挂在整张卡的第一步上，不在这一步
      const resStep = activeTask.steps.find((s) => s.params?.some((p) => p.key === "resolution"));
      if (resStep && cfg.resolution) {
        applyTask(
          await window.agent.updateParams({
            taskId: activeTask.id,
            stepId: resStep.id,
            params: [{ key: "resolution", value: cfg.resolution }],
          })
        );
      }
    } catch (e: unknown) {
      setError(errText(e));
    }
  }
  /**
   * 点了候选选题：把主题写进「出分镜方案」那一步，并直接开跑——
   * 跟手动「爆款嗅探」里选定选题后生成新分镜是同一件事，只是搬进了任务卡。
   */
  async function pickTopic(topic: string): Promise<void> {
    if (!activeTask) return;
    const board = activeTask.steps.find((s) => s.kind === "write-storyboard");
    if (!board) return;
    setError(null);
    setBusy(true);
    try {
      applyTask(
        await window.agent.updateParams({
          taskId: activeTask.id,
          stepId: board.id,
          params: [{ key: "topic", value: topic }],
        })
      );
      applyTask(await window.agent.run({ taskId: activeTask.id, stepId: board.id }));
    } catch (e: unknown) {
      setError(errText(e));
    } finally {
      setBusy(false);
      setEdits({});
      await refresh(activeTask.id);
    }
  }

  /**
   * 试听：拿这张卡上的音色 + 语速/语调/音量合成一句话放出来。
   * 值发出去之前都还是"待提交"的本地编辑，所以直接读 step 上的当前值。
   */
  /** 播一段试听：key 标记是谁在放（角色卡用 A/B，参数行用 param:步骤.参数），放完清掉 */
  async function playPreview(
    key: string,
    voice: string,
    prosody: { rate: number; pitch: number; volume: number }
  ): Promise<void> {
    if (!voice || previewing) return;
    setPreviewing(key);
    try {
      // 先停掉上一次，免得两条声音叠在一起
      const prev = previewAudioRef.current;
      if (prev) {
        prev.pause();
        prev.currentTime = 0;
      }
      const r = await window.dialogue.previewVoice({ voice, ...prosody });
      const url = await window.media.toUrl(r.path);
      const audio = previewAudioRef.current ?? new Audio();
      previewAudioRef.current = audio;
      audio.src = url;
      audio.onended = () => setPreviewing(null);
      audio.onerror = () => setPreviewing(null);
      await audio.play();
    } catch (e: unknown) {
      setError(errText(e));
      setPreviewing(null);
    }
  }

  /** 角色卡上的试听：语速/语调/音量各读自己那一套（rateA / rateB） */
  async function previewRole(step: AgentStep, slot: string, voice: string): Promise<void> {
    const num = (key: string) => {
      const p = step.params?.find((x) => x.key === key);
      return p ? Number(valueOf(step, p)) || 0 : 0;
    };
    await playPreview(slot, voice, {
      rate: num(`rate${slot}`),
      pitch: num(`pitch${slot}`),
      volume: num(`volume${slot}`),
    });
  }

  /** 参数行上的「试听」：音色取当前值，语速找同一步骤里配套的那个（解说是 rateNarrator，语音合成是 rate） */
  function previewParamVoice(step: AgentStep, p: AgentParam): void {
    const voice = valueOf(step, p);
    if (!voice) return;
    const rateP = step.params?.find((x) => x.key === "rateNarrator" || x.key === "rate");
    const rate = rateP ? Number(valueOf(step, rateP)) || 0 : 0;
    void playPreview(`param:${step.id}.${p.key}`, voice, { rate, pitch: 0, volume: 0 });
  }

  /** 参数控件的统一接口：搬到 components/workspace/ 的那几块都通过它读写参数 */
  const fieldApi: StepFieldApi = {
    valueOf,
    setLocal: (step, p, v) => setEdits((prev) => ({ ...prev, [editKey(step.id, p.key)]: v })),
    commit: (step, p, v) => void commitParam(step, p, v),
    pickFile: (step, p) => void pickFile(step, p),
    preview: previewParamVoice,
    previewing,
    imageUrls,
  };

  return (
    <div className={`ws${listShown ? "" : " list-closed"}${panelOpen ? "" : " panel-closed"}`}>
      {/* 收起时整个列表不渲染：网格里只剩对话、操作区两项，正好对应两列 */}
      {listShown && (
        <aside className="ws-list">
          {nav}
          <div className="panel-title-row">
          <span className="panel-title">任务</span>
          <span className="status">{tasks.length}</span>
        </div>
        {tasks.length === 0 ? (
          <p className="split-empty">还没有任务。右边说一句话试试。</p>
        ) : (
          <div className="ws-list-items">
            {tasks.map((t) => (
              /* 行长相与图文解说等页共用（SideRow = .side-row）：删除也走同款悬浮 ✕ */
              <SideRow
                key={t.id}
                title={t.title}
                active={t.id === activeId}
                meta={<span>{statusText(t)}</span>}
                time={formatListTime(t.updatedAt)}
                onOpen={() => {
                  setActiveId(t.id);
                  // 操作区收着时点任务：把操作区拉回来，不然点了没反应
                  if (!panelOpen) onTogglePanel?.();
                }}
                onDelete={async () => {
                  if (
                    await confirmDelete({
                      title: `删除任务「${t.title}」？`,
                      detail: "删除后这条任务的产物目录不会一并删除，但任务卡找不回来了。",
                    })
                  ) {
                    await window.agent.remove(t.id);
                    refresh();
                  }
                }}
                deleteLabel={`删除任务 ${t.title}`}
              />
            ))}
          </div>
        )}
        </aside>
      )}

      {/* 操作区收起时整块不渲染：网格里对话占满；点任务或发消息会把它拉回来 */}
      {panelOpen && (
      <main className="ws-main">
        {!activeTask ? (
          <div className="ws-empty">
            <p className="subtitle">贴一条视频链接、给一个主题，或者打 @ 点名要干什么。</p>
            <p className="status">我会把它拆成几步摆在这儿，跑之前你还能改参数。</p>
          </div>
        ) : (
          <>
            <div className="ws-head">
              <span className="panel-title">{activeTask.title}</span>
              {/* 工作区卡不摆徽章：它的状态就在那颗主按钮上（成片中 / 继续合成），
                  再来一个「待执行」只会自相矛盾——卡上根本没有「执行」 */}
              {!isWorkspaceCard && (
                <span className={`ws-badge ${activeTask.status}`}>{statusText(activeTask)}</span>
              )}
              <div className="ws-head-actions">
                {shownRunning && <span className="status">已用时 {elapsed}s</span>}
                {isWorkspaceCard ? (
                  /* 卡头这颗就是工作台那颗「成片」：动作走 handle，文字/禁用/原因由工作台给 */
                  <>
                    <button
                      type="button"
                      className="ai-generate-button compact"
                      disabled={!pipelineButton?.canRun}
                      title={pipelineButton?.disabledReason ?? "写分镜 → 缺图自动生图 → 配音字幕运镜合成"}
                      onClick={() => workbenchRef.current?.runPipeline()}
                    >
                      <span className="ai-generate-icon" aria-hidden="true">
                        AI
                      </span>
                      <span className="ai-generate-label">{pipelineButton?.label ?? "成片"}</span>
                    </button>
                    {pipelineButton?.running && (
                      <button
                        className="secondary"
                        onClick={() => workbenchRef.current?.cancelPipeline()}
                      >
                        中止
                      </button>
                    )}
                    {/*
                      出口：工作台只负责自动出片，细改在「热点成片」页（那里整屏是编辑器 + 方案列表）。
                      这里把当前这份方案带过去，落地就打开它，不用用户自己再找。
                    */}
                    {activeTask.state?.storyboardId && onOpenBoardInStoryPage && (
                      <button
                        className="secondary"
                        title="去「视频生成 → 热点成片」里改这份方案（文案 / 图片 / 音色…）"
                        onClick={() => onOpenBoardInStoryPage(activeTask.state!.storyboardId!)}
                      >
                        去细改
                      </button>
                    )}
                  </>
                ) : shownRunning ? (
                  <button className="secondary" onClick={() => void window.agent.cancel(activeTask.id)}>
                    取消
                  </button>
                ) : (
                  <button
                    className="primary"
                    disabled={busy}
                    title={
                      busy
                        ? "有任务正在执行，等它跑完"
                        : isAutoCard
                          ? "重新跑一遍（台词重写、按模板重新配好、重新合成）"
                          : runButtonLabel(activeTask) === "合成视频"
                            ? "配音 + 字幕 + 运镜，一条龙合成（形象图已由模板配好）"
                            : undefined
                    }
                    onClick={() => void run()}
                  >
                    {isAutoCard ? (activeTask.status === "failed" ? "重试" : "重新生成") : runButtonLabel(activeTask)}
                  </button>
                )}
                {/* 删除挪去了左栏任务行（悬浮 ✕，跟视频页的记录列表同一套） */}
              </div>
            </div>

            {/*
              工作区卡不画步骤列表：那行「1. 热点成片 ○」提供不了任何信息（没有可跑的步骤），
              卡身直接就是工作台。带链接的解说卡等仍有步骤，照常画。
            */}
            {isWorkspaceCard ? (
              <div className="ws-workbench">
                {renderWorkbench(activeTask, activeTask.steps[0], true)}
              </div>
            ) : (
            <ol className="ws-steps">
              {activeTask.steps.map((step, i) => (
                <li key={step.id} className={`ws-step is-${step.status}`}>
                  <span className="ws-dot">{dot(step.status)}</span>
                  <div className="ws-step-body">
                    <div className="ws-step-head">
                      <span className="ws-step-name">
                        {i + 1}. {step.title}
                      </span>
                      <div className="ws-step-actions">
                        {/* 角色配置那一步（「角色与画面」；老卡片是 compose）才摆「选择模板」。
                            全自动卡（对话）不摆：配置去「视频生成」页改 */}
                        {isRoleStep(step) && !isAutoCard && (
                          <div className="ws-tpl-pick">
                            {/*
                              下拉框只列模板名（摘要放不下也没必要——名字就是他自己起的）。
                              value 恒为 ""，选完仍显示「用模板」：
                              这样同一份模板连着套两次也能触发（onChange 只有值变了才回调）。
                            */}
                            <AppSelect
                              value=""
                              placeholder="选择模板"
                              options={[
                                // 「不用模板」排在最前：它跟运镜里的「无（静止）」一个意思——
                                // 是一个有实效的选项（清掉模板配置、回到出厂默认），不是占位标签
                                { value: NO_TEMPLATE, label: "不用模板" },
                                ...templates.map((t) => ({ value: t.id, label: t.title })),
                              ]}
                              onChange={(id) => {
                                if (id === NO_TEMPLATE) void resetStepConfig(step);
                                else if (id) void applyTemplateToStep(step, id);
                              }}
                              title={
                                templates.length === 0
                                  ? "模板库还是空的：去「视频生成 → 对话模式」攒几套"
                                  : "选一套对话模板套到这张卡；选「不用模板」= 清掉配置回到默认"
                              }
                            />
                          </div>
                        )}
                        {step.outputPath && (
                          <button className="link" onClick={() => void window.agent.openPath(step.outputPath!)}>
                            打开
                          </button>
                        )}
                        {/* 单步重跑：全自动卡不摆（卡头那颗「重新生成」就是重跑整条），
                            也免得用户以为要一步步点 */}
                        {!isAutoCard && step.rerunnable !== false && !running && (
                          <button className="link" onClick={() => void run(step.id)}>
                            {step.status === "done" ? "重跑" : "跑这步"}
                          </button>
                        )}
                      </div>
                    </div>
                    {step.error && <div className="error">{step.error}</div>}
                    {/* 热点成片：任务卡里内嵌「热点成片」页同一个分镜工作台（换入口，不是另一套） */}
                    {step.kind === "hot-story" && renderWorkbench(activeTask, step, false)}
                    {/*
                      角色卡（左图右音）：拆分后挂在「角色与画面」那一步；
                      老卡片（拆分前建的）参数还在 compose 那一步上，所以两种都认。
                      全自动卡（对话）不画：形象图/音色/运镜都是模板配好的，要看要改去「视频生成」页。
                    */}
                    {isRoleStep(step) && !isAutoCard && (
                      <RoleCards
                        step={step}
                        api={fieldApi}
                        previewing={previewing}
                        onPreview={(slot, voice) => void previewRole(step, slot, voice)}
                      />
                    )}
                    {/* 参数区：全自动卡不画（同上，配置在「视频生成」页） */}
                    {!isRoleStep(step) &&
                      !isAutoCard &&
                      step.kind !== "hot-story" &&
                      step.params &&
                      step.params.length > 0 && (
                      <div className="ws-params">
                        {paramRows(step.params).map((row, ri) => (
                          <div className="ws-param-row" key={ri}>
                            {row.map((p) => (
                              <ParamField key={p.key} step={step} param={p} api={fieldApi} />
                            ))}
                          </div>
                        ))}
                      </div>
                    )}
                    {/* 结果（标题 · 时长 / 已合成 …）放在参数下面：上面是你要填的，下面是我读出来的 */}
                    {step.note && <div className="ws-step-note">{step.note}</div>}
                    {/*
                      成片就摆在这一步（合成视频）下面，不再另开「产物」模块——
                      跑完这一步要看的就是这条片子，贴着它摆最顺，也少一块重复的壳。
                      不再摆「打开所在文件夹」：步骤行右侧已经有「打开」（同一个产物路径），重复。
                    */}
                    {isResultStep(step, activeTask) && mediaUrl && (
                      <div className="ws-step-result">
                        {activeTask.resultKind === "audio" ? (
                          <audio className="ws-media" src={mediaUrl} controls />
                        ) : (
                          /* 成片预览固定 16:9 横屏窗口：竖版成片也在这个框里居中，不撑破版式 */
                          <div className="ws-stage">
                            <video className="ws-media" src={mediaUrl} controls />
                          </div>
                        )}
                      </div>
                    )}
                    {/* 文本类产物（文案 / 拆解报告）摊在产出它的那一步下面 */}
                    {step.status === "done" && textArtifact && isArtifactStep(step) && (
                      <pre className="ws-script ws-step-result">{textArtifact}</pre>
                    )}
                    {/* 写好的脚本就地摊在主题/目标时长下面，不往产物区塞 */}
                    {step.kind === "write-script" && scriptArtifact && (
                      <div className="ws-script-block">
                        {/* 标题在左、行数右对齐 */}
                        <div className="ws-script-head">
                          <span className="ws-script-title">脚本文案</span>
                          <span className="ws-script-count">
                            {scriptArtifact.split("\n").filter((l) => l.trim()).length} 行
                          </span>
                        </div>
                        <pre className="ws-script">{scriptArtifact}</pre>
                      </div>
                    )}
                    {/* 选题排在「你的赛道」下面：赛道定了再挑题 */}
                    {step.kind === "sniff" && (
                      <TopicChips
                        topics={sniffTopics}
                        disabled={running}
                        onPick={(t) => void pickTopic(t)}
                      />
                    )}
                  </div>
                </li>
              ))}
            </ol>
            )}

            {/* 产物不再单独摆一块：成片贴在「合成视频」那一步下面、文案/报告贴在产出它的那一步下面 */}
          </>
        )}
      </main>
      )}

      <aside className="ws-chat">
        <div className="ws-chat-head">
          {/* 任务栏收/展开的开关挪去了顶部条左端（跟右端的面板开关对称） */}
          <span className="panel-title">田螺姑娘</span>
        </div>
        <div className="ws-bubbles">
          {bubbles.map((b, i) =>
            b.role === "bot" ? (
              <div key={i} className="ws-row bot">
                <img className="ws-chat-avatar" src={tianluAvatar} alt="田螺姑娘" />
                <div className="ws-bubble bot">
                  {b.images && b.images.length > 0 && (
                    <div className="ws-bubble-images">
                      {b.images.map((p) => (
                        <img key={p} src={attachUrls[p]} alt={p} title={p} />
                      ))}
                    </div>
                  )}
                  {b.text}
                </div>
              </div>
            ) : (
              <div key={i} className={`ws-bubble ${b.role}`}>
                {b.images && b.images.length > 0 && (
                  <div className="ws-bubble-images">
                    {b.images.map((p) => (
                      <img key={p} src={attachUrls[p]} alt={p} title={p} />
                    ))}
                  </div>
                )}
                {b.text}
              </div>
            )
          )}
        </div>
        {hotOpen && (
          <div className="ws-hot-panel">
            <div className="ws-hot-sources">
              {hotSources.map((s) => (
                <button
                  key={s.key}
                  className={`ws-chip${s.key === hotSource ? " active" : ""}`}
                  onClick={() => void loadHot(s.key)}
                >
                  {s.name}
                </button>
              ))}
            </div>
            {hotBusy && <p className="status">正在拉榜单…</p>}
            <div className="ws-hot-list">
              {hotItems.map((it) => (
                <button key={it.id} className="ws-hot-item" onClick={() => void pickHot(it)}>
                  <span className="ws-hot-rank">{it.rank}</span>
                  <span className="ws-hot-title">{it.title}</span>
                  <span className="ws-hot-heat">
                    {it.heat
                      ? `${it.rank <= 3 ? "🔥 " : ""}${formatHeat(it.heat)}`
                      : it.rank <= 3
                        ? "🔥"
                        : ""}
                  </span>
                </button>
              ))}
              {!hotBusy && !hotItems.length && <p className="status">这个榜单没拉到内容，换个源试试。</p>}
            </div>
          </div>
        )}
        {mentionList.length > 0 && (
          <div className="ws-mention" role="listbox" aria-label="功能名单">
            {mentionList.map((m, i) => (
              <button
                key={m.label}
                className={`ws-mention-item${i === mentionPick ? " active" : ""}`}
                role="option"
                aria-selected={i === mentionPick}
                onMouseEnter={() => setMentionIdx(i)}
                onClick={() => pickMention(m)}
              >
                <span className="ws-mention-label">{m.label}</span>
                <span className="ws-mention-hint">{m.hint}</span>
              </button>
            ))}
          </div>
        )}

        <div className="ws-input-foot">
          <button
            type="button"
            className={`secondary small${hotOpen ? " active" : ""}`}
            onClick={() => void toggleHot()}
            title="从热榜里挑一条，直接按图文解说建卡（也可以打 @ 点名）"
          >
            {hotOpen ? "收起热点" : "🔥 选热点"}
          </button>
          {hotOpen && <span className="status">点一条热点就建卡</span>}
        </div>
        {attachments.length > 0 && (
          <div className="ws-attach-row">
            {attachments.map((p) => (
              <span key={p} className="ws-attach-thumb" title={p}>
                <img src={attachUrls[p]} alt={p} />
                <button
                  type="button"
                  className="ws-attach-remove"
                  aria-label="移除这张图"
                  onClick={() => setAttachments((prev) => prev.filter((x) => x !== p))}
                >
                  ✕
                </button>
              </span>
            ))}
          </div>
        )}
        <div className="ws-input">
          <button
            type="button"
            className="ws-attach-add"
            title="添加图片"
            aria-label="添加图片"
            onClick={() => void pickImage()}
          >
            ＋
          </button>
          <textarea
            ref={inputRef}
            value={input}
            rows={4}
            placeholder="打 @ 点名，或直接贴链接 / 说主题（Enter 发送，Shift+Enter 换行）"
            onChange={(e) => {
              setInput(e.target.value);
              setMentionOff(false);
              setMentionIdx(0);
            }}
            onKeyDown={(e) => {
              if (mentionList.length) {
                if (e.key === "ArrowDown") {
                  e.preventDefault();
                  setMentionIdx(Math.min(mentionPick + 1, mentionList.length - 1));
                  return;
                }
                if (e.key === "ArrowUp") {
                  e.preventDefault();
                  setMentionIdx(Math.max(mentionPick - 1, 0));
                  return;
                }
                if (e.key === "Enter" && !e.shiftKey) {
                  e.preventDefault();
                  pickMention(mentionList[mentionPick]);
                  return;
                }
                if (e.key === "Escape") {
                  e.preventDefault();
                  setMentionOff(true);
                  return;
                }
              }
              // 回车发送、Shift+回车换行（和聊天工具一致）
              if (e.key === "Enter" && !e.shiftKey) {
                e.preventDefault();
                void send();
              }
            }}
          />
          <button
            className="ws-send"
            onClick={() => void send()}
            disabled={!input.trim()}
            aria-label="发送"
            title="发送（Enter）"
          >
            <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
              <path d="M12 19V5" />
              <path d="m5 12 7-7 7 7" />
            </svg>
          </button>
        </div>
        {error && (
          <div className="error ws-error">
            <span className="ws-error-text">{error}</span>
            <button
              className="ws-error-close"
              type="button"
              title="关掉这条报错"
              aria-label="关闭报错"
              onClick={() => setError(null)}
            >
              ×
            </button>
          </div>
        )}
      </aside>
      {confirmDialog}
    </div>
  );
}
