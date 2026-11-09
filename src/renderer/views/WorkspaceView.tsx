/**
 * 工作台：一句话 → 一张可改的任务卡 → 执行。
 *
 * 设计见 doc/Agent化改造-产品形态设计.md：
 * 左栏是任务，中栏是任务卡（步骤可见、参数可改、每步能单独重跑），右栏是对话入口。
 * 现有那些页面不删，收在侧边栏的「手动模式」里，当高手模式用。
 */
import { useCallback, useEffect, useRef, useState } from "react";
import type { ReactNode } from "react";
import type { AgentApi, ConversationApi, RecordsApi, RuntimeApi } from "../../preload";
import type { AgentParam, AgentStep, AgentTask } from "../../shared/agent-types";
import type { ConversationMessage, ConversationSummary } from "../../shared/conversation-types";
import type {
  RuntimeChatMessage,
  RuntimeId,
  RuntimeModelList,
  RuntimePermissionId,
} from "../../shared/runtime-types";
import {
  DEFAULT_RUNTIME_PREFS,
  RUNTIME_LABELS,
  RUNTIME_PERMISSIONS,
  permissionOf,
} from "../../shared/runtime-types";
import type { HotItem, HotSource } from "../../shared/storyboard-types";
import type { TemplateConfig } from "../../shared/dialogue-types";
import type { WorkRecordSummary } from "../../shared/record-types";
import { formatHeat } from "../../shared/hot-format";
import {
  PLUGIN_GROUPS,
  effectiveInstalledPlugins,
  type PluginDef,
  type PluginKey,
} from "../../shared/plugins";
import { usePageActive } from "../components/KeepAlive";
import HotStoryWorkbench, {
  type HotStoryWorkbenchHandle,
  type PipelineButtonState,
} from "../components/hot-story/HotStoryWorkbench";
import ParamField from "../components/workspace/ParamField";
import RoleCards from "../components/workspace/RoleCards";
import TopicChips from "../components/workspace/TopicChips";
import BeeSelect from "../components/BeeSelect";
import tianluAvatar from "../assets/tianlu-avatar.png";
import { useConfirm } from "../components/ConfirmDialog";
import { formatListTime, ListAddButton, SideRow } from "../components/SideList";
import type { StepFieldApi } from "../components/workspace/fieldApi";
import { stripIpc, ttsErrorText } from "../lib/err-text";

declare global {
  interface Window {
    agent: AgentApi;
    /** 会话：左栏那一列（一件事一条，一次对话的全过程） */
    conv: ConversationApi;
    /** 集成运行时：只用来"交给它执行"，切换在设置页，这儿不提供口子 */
    runtime: RuntimeApi;
    /** 对话模板库：卡片上「用模板」从这里读 */
    records: RecordsApi;
  }
}

interface Bubble {
  role: "user" | "bot";
  text: string;
  /** 用户消息附的图（+ 号上传）：气泡里回显缩略图 */
  images?: string[];
  /**
   * 同一条气泡反复改写的标识（托管跑片那条进度就是它）。
   * 没有 id 的气泡只增不改 —— 普通对话不需要原地刷新。
   */
  id?: string;
}

function errText(e: unknown): string {
  // IPC 会把主进程的错包一层 "Error invoking remote method 'agent:x': Error: …"，
  // 界面只要里层那句话
  const raw = stripIpc(e instanceof Error ? e.message : String(e));
  // 渲染层被 Vite 热更新了、但主进程还是上一次启动的那份：接口没注册。
  // 这不是代码问题，把应用整个退掉重开即可（npm run dev 会先重编主进程）。
  if (raw.includes("No handler registered for 'agent:")) {
    return "主进程还是旧版本，没注册工作台的接口。完全退出宝螺再重开就行（开发模式下 npm run dev 会先重新编译主进程）。";
  }
  return raw;
}

/**
 * 运行时没接上要说的话。
 *
 * 这一轮**不建卡、不跑**：写分镜、写脚本、出画面提示词全靠运行时，
 * 没有它本地流程跑到生图那步只会失败，白等几分钟再报一个更绕的错。
 * 所以当场说清三件事就停住——为什么没开工、去修哪儿、修好了怎么办。
 */
function runtimeDownHint(e: unknown): string {
  // 主进程那句自带句号，塞进括号里会变成「…换一个。）」，先剥掉
  const why = errText(e).replace(/[。.]$/, "");
  // 这几句本身就是完整的结论，不必再把人话嵌进括号里重复一遍
  if (/还没应用运行时/.test(why)) {
    return "还没应用运行时，这一轮没开工。去「设置 → 运行时」选一个（Codex 或 Claude 都行），弄好后把这句再发一遍。";
  }
  if (/起不来|重新识别/.test(why)) {
    return "应用的那个运行时在这台机器上起不来。这一轮没开工——去「设置 → 运行时」重新识别或换一个，弄好后把这句再发一遍。";
  }
  if (/没回话/.test(why)) {
    return `运行时没回话（${why}）。这一轮没开工——它可能还在排队或网络不通，过会儿把这句再发一遍。`;
  }
  // CLI 有时只吐一个数字（重试次数 / 退出码），摊给用户看等于没说
  if (!why || /^\d+$/.test(why)) {
    return `运行时中途断了${why ? `（错误码 ${why}）` : ""}。这一轮没开工——把这句话再发一遍通常就好；老这样就去「设置 → 运行时」换一个。`;
  }
  return `运行时没接上（${why}）。这一轮没开工——去「设置 → 运行时」看一眼（重开一次或换一个），弄好后把这句再发一遍。`;
}

/**
 * 托管跑片要说给用户的那句话（对话区那条会原地改写的气泡）。
 *
 * 放组件外：阶段文案跟界面无关，集中在一处好改；也免得 effect 里挂一串三目。
 * 说人话、给出路：跑到哪、为什么停、接下来点哪儿——用户只要结果，失败时更需要知道怎么办。
 */
function pipelineReport(btn: PipelineButtonState): string | null {
  if (!btn.stage || !btn.status) return null;
  if (btn.status === "running") {
    if (btn.stage === "story") return "正在写分镜…";
    if (btn.stage === "images") return "正在生图（缺图的镜头在后面排队，一张通常几十秒）…";
    return "正在配音、字幕、合成视频…";
  }
  if (btn.status === "waiting") {
    return `有 ${btn.missing} 张图没生出来，我先停在这儿了。把主题再发一遍，我重开一轮接着跑（已生成的图不会重做）。`;
  }
  if (btn.status === "cancelled") return "已中止。";
  if (btn.status === "done") return "成片好了，在右边 ③ 里预览。";
  // 失败：IPC 那层会把主进程的错包成 "Error invoking remote method 'x': Error: …"，先剥掉
  const why = errText(btn.message ?? "未知原因");
  const tip = /运行时|写文案|API Key|AI 服务/.test(why)
    ? "（去「设置 → 运行时」应用一个运行时；或去「设置 → AI 服务」填 Key。弄好把主题再发一遍）"
    : /登录|扫码|doubao/i.test(why)
      ? "（豆包登录窗已经打开，扫码登录后把主题再发一遍）"
      : "";
  return `这一轮没跑成：${why}${tip}`;
}

/**
 * 步骤体内联的视频预览（下载产物直接摆在第二步下面）：
 * 下载类任务不再单独走产物区——视频就是这一步的产出，预览贴着重跑/打开都在一处。
 * `kind` 只区分音频/视频（下载的可能是音频链接，别硬套 16:9 视频框）。
 */
function StepVideo({ path, kind }: { path: string; kind?: "video" | "audio" | "text" }) {
  const [url, setUrl] = useState("");
  useEffect(() => {
    let alive = true;
    setUrl("");
    window.media
      .toUrl(path)
      .then((u) => {
        if (alive) setUrl(u);
      })
      .catch(() => {
        /* 预览换不到地址不影响产物本身，步骤行还有「打开」 */
      });
    return () => {
      alive = false;
    };
  }, [path]);
  if (!url) return null;
  if (kind === "audio") {
    return (
      <div className="ws-step-result">
        <audio className="ws-media" src={url} controls />
      </div>
    );
  }
  return (
    <div className="ws-stage">
      <video className="ws-media" src={url} controls playsInline />
    </div>
  );
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

/** 名单（＋菜单里那份）：跟在群里 @ 人干活一样，只是这些"人"是宝螺的几条流水线。
 * 打 @ 自动弹名单的功能已撤——名单只从「＋」按钮进。 */
const MENTIONS: Mention[] = [
  { label: "@下载", hint: "给链接 → 无水印原片", insert: "@下载 " },
  { label: "@对话", hint: "给主题或链接 → 双人对话视频", insert: "@对话 " },
  { label: "@语音", hint: "给一段文字 → 用指定音色念出来", insert: "@语音 " },
  { label: "@识别", hint: "给音视频文件 → 出文案（本地跑）", insert: "@识别 " },
  { label: "@爆款", hint: "给爆款链接 → 拆解可复用的方法", insert: "@爆款 " },
  { label: "@热点", hint: "不知道写什么？从榜单里挑一条", insert: "", hot: true },
];

/** 每条 @ 功能归属哪个插件（shared/plugins.ts）：插件卸了，名单里也不出现 */
const FEATURE_PLUGIN: Record<string, PluginKey> = {
  "@下载": "materials",
  "@对话": "dialogue",
  "@语音": "voice",
  "@识别": "voice",
  "@爆款": "sniff",
  "@热点": "hotstory",
};

interface WorkspaceViewProps {
  /** 左栏顶部的导航块（App 传下来的 SideNav）：任务列表收起时它也必须在 */
  nav?: ReactNode;
  /** 入口页形态（默认 false）：true 时整页只摆插件卡片，对话/任务区要点「＋ 新建任务」才进 */
  home?: boolean;
  /** 从入口页进对话形态（App 把 home 置 false） */
  onLeaveHome?: () => void;
  /** 左栏任务列表是否显示（开关在顶部条左端，状态在 App）：false 时对话区摊满 */
  listShown?: boolean;
  /** 右侧操作区是否展开（开关在顶部条右端，状态在 App）：收起后对话区摊满 */
  panelOpen?: boolean;
  /** 请求展开操作区：点任务行、发消息建卡、点「任务」旁的 + 时叫它 */
  onTogglePanel?: () => void;
  /** 已安装的功能插件（App 按设置算好传下来）：入口页/右侧面板空状态里摆入口卡片 */
  plugins?: PluginDef[];
  /** 点插件卡片跳对应功能页（切页逻辑在 App） */
  onOpenPlugin?: (key: PluginKey) => void;
  /** 开/关豆包抽屉：内嵌分镜工作台里的「打开豆包」点它（入口本体在设置里） */
  onToggleDoubao?: () => void;
  /**
   * 去「热点成片」页细改某份方案（工作台这边定位成全自动，编辑都在那边）。
   * 由 App 负责切页 + 把 boardId 交给那一页打开。
   */
  onOpenBoardInStoryPage?: (boardId: string) => void;
  /**
   * 设置/关于页左栏的任务列表点了某条任务：App 切回工作台并把这个 id 递过来，
   * 这里打开它，然后调 onTaskConsumed 清账。
   */
  pendingOpenTaskId?: string | null;
  onTaskConsumed?: () => void;
}

/** 入口页卡片的小图标（emoji 够用，不上图标库）与底色 */
const PLUGIN_ICONS: Record<string, { emoji: string; bg: string }> = {
  materials: { emoji: "📥", bg: "#3478f6" },
  narration: { emoji: "🎬", bg: "#7048e8" },
  dialogue: { emoji: "💬", bg: "#0ca678" },
  hotstory: { emoji: "🔥", bg: "#f76707" },
  sniff: { emoji: "🔍", bg: "#e8590c" },
  voice: { emoji: "🎙️", bg: "#f59f00" },
};

export default function WorkspaceView({
  nav,
  home = false,
  onLeaveHome,
  listShown = true,
  panelOpen = true,
  onTogglePanel,
  plugins = [],
  onOpenPlugin,
  onToggleDoubao,
  onOpenBoardInStoryPage,
  pendingOpenTaskId,
  onTaskConsumed,
}: WorkspaceViewProps = {}) {
  /** 工作台被保活后隐藏的实例不消费全局进度广播（内嵌分镜工作台用） */
  const pageActive = usePageActive();
  /**
   * 已安装插件（设置 → 插件 里改）：null = 未读到配置（按全装渲染）。
   * 页面保活不重挂，所以每次切回工作台（pageActive 变真）重读一次，
   * 用户在设置里卸了某个功能再回工作台，「＋」菜单/@ 名单里就不见了。
   */
  const [installedPlugins, setInstalledPlugins] = useState<PluginKey[] | null>(null);
  /**
   * 「使用模板」开关（与「视频生成」页共用同一个设置项）。
   * 关着 = 卡片上不摆「选择模板」下拉；默认未设置 = 关。
   */
  const [tplEnabled, setTplEnabled] = useState(false);
  useEffect(() => {
    if (!pageActive) return;
    let alive = true;
    window.settings
      .get()
      .then((s) => {
        if (!alive) return;
        setInstalledPlugins(effectiveInstalledPlugins(s.installedPlugins, s.knownPlugins));
        setTplEnabled(!!s.templatesEnabled);
        const rt = s.runtime?.activeId ?? null;
        // 换了运行时：上一段的对话记录不能带给新的那个（口径可能完全不同）
        const changed = rt !== runtimeRef.current;
        if (changed) chatLogRef.current = [];
        runtimeRef.current = rt;
        setRuntimeName(rt ? RUNTIME_LABELS[rt] : null);
        const prefs = rt ? s.runtime?.prefs?.[rt] : null;
        setRuntimePerm(prefs?.permission ?? DEFAULT_RUNTIME_PREFS.permission);
        setRuntimeModel(prefs?.model ?? null);
        // 换了运行时，模型清单也要重读（每家的清单来源不一样）
        if (changed) setModelList(null);
      })
      .catch(() => {});
    return () => {
      alive = false;
    };
  }, [pageActive]);
  /** 该功能对应的插件装了吗（配置没读到时一律算装了） */
  const featureEnabled = (label: string) => {
    const plugin = FEATURE_PLUGIN[label];
    return !plugin || !installedPlugins || installedPlugins.includes(plugin);
  };
  const [tasks, setTasks] = useState<AgentTask[]>([]);
  /**
   * 左栏那一列是**会话**，不是任务卡：一件事一条。
   * 一次会话装下这件事的全过程（说过的话、我的回复、每一轮产出的卡）。
   */
  const [convs, setConvs] = useState<ConversationSummary[]>([]);
  const [activeConvId, setActiveConvId] = useState<string | null>(null);
  /** 当前会话里落过盘的消息；bubbles 只放临时播报（进度、思考中） */
  const [convMessages, setConvMessages] = useState<ConversationMessage[]>([]);
  /** 异步回调里要读"现在开的是哪条会话"，用 ref 免得拿到旧闭包里的值 */
  const activeConvIdRef = useRef<string | null>(null);
  const [activeId, setActiveId] = useState<string | null>(null);
  const [input, setInput] = useState("");
  /** 随消息附图的绝对路径列表（+ 号选图），发送后清空；预览 URL 缓存见 attachUrls */
  const [attachments, setAttachments] = useState<string[]>([]);
  const [attachUrls, setAttachUrls] = useState<Record<string, string>>({});
  const [bubbles, setBubbles] = useState<Bubble[]>([]);
  /**
   * 已应用的运行时（设置 → 运行时 里定的，这里只读）。
   * 有它 = 对话区的指令交给它听懂并规划；null = 走本地规则链路。
   * 对话区**不做切换**：换运行时回设置页，免得同一句话在两处口径不一。
   */
  const [runtimeName, setRuntimeName] = useState<string | null>(null);
  const runtimeRef = useRef<RuntimeId | null>(null);
  /**
   * 输入框底下那两颗选择器：权限范围（左）+ 模型（右）。
   * 只对**已应用**的运行时生效，值按运行时各存一份（换回来还是上次那个）。
   */
  const [runtimePerm, setRuntimePerm] = useState<RuntimePermissionId>(DEFAULT_RUNTIME_PREFS.permission);
  const [runtimeModel, setRuntimeModel] = useState<string | null>(null);
  /**
   * 模型清单：**不写死**，点开菜单时读一次 CLI 自己的配置
   * （codex 的模型目录 / Claude Code 的 modelPicker），读不到就只留默认 + 手工填。
   */
  const [modelList, setModelList] = useState<RuntimeModelList | null>(null);
  const [modelLoading, setModelLoading] = useState(false);
  /** 哪颗选择器展开了：权限 / 模型；null = 都收着 */
  const [pickOpen, setPickOpen] = useState<"perm" | "model" | null>(null);
  /** 模型菜单里"自定义"那一行正在输入的内容 */
  const [modelDraft, setModelDraft] = useState("");
  /** 运行时的对话记录：CLI 没有记忆，每轮把最近几条一起带过去 */
  const chatLogRef = useRef<RuntimeChatMessage[]>([]);
  /** 运行时正在跑（最长三分半，得让用户看见"它在想"，不然像卡死） */
  const [runtimeThinking, setRuntimeThinking] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [elapsed, setElapsed] = useState(0);
  const [mediaUrl, setMediaUrl] = useState("");
  const [edits, setEdits] = useState<Record<string, string>>({});
  /** 热点榜单：选热点建卡用（「热点成片」那条链路） */
  const [hotOpen, setHotOpen] = useState(false);
  /** 输入框左下角「＋」弹出的小菜单：选热点 / 添加图片 */
  const [plusOpen, setPlusOpen] = useState(false);
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
   * 下载/识别这些单步卡仍按普通流水线卡画。
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

  // ---------------------------------------------------------------------------
  // 托管跑片：建卡就自己跑，用户只要结果
  // ---------------------------------------------------------------------------

  /** 托管进度气泡的 id：跑几分钟里阶段会变好几次，同一条反复改写，不刷屏 */
  const AUTO_BUBBLE = "auto-run";
  /**
   * 同一条气泡原地改写（托管进度用它）。
   * 文案没变就返回原数组：工作台每次状态变化都会发一份，别为一句没变的话多渲染一轮。
   */
  const upsertBubble = useCallback((id: string, text: string): void => {
    setBubbles((prev) => {
      const i = prev.findIndex((b) => b.id === id);
      if (i < 0) return [...prev, { id, role: "bot", text }];
      if (prev[i].text === text) return prev;
      const next = prev.slice();
      next[i] = { ...next[i], text };
      return next;
    });
  }, []);
  /** 已经替用户自动踢过的工作区卡（一张卡只踢一次，失败也不无限重试） */
  const autoStartedRef = useRef<Set<string>>(new Set());
  /** 已经落过终态的任务（避免每来一份状态就写一次盘） */
  const autoStatusRef = useRef<Set<string>>(new Set());
  /** 已经说过的"跑不了"理由（同一句话只说一次；条件变好后仍然会自动跑） */
  const autoBlockedRef = useRef<Set<string>>(new Set());
  /**
   * 工作区卡（整张卡就是内嵌分镜工作台）挂上就自己开跑。
   *
   * 工作台对话区的定位是「说一句话，成片给我」：图文解说卡建好之后不该停在那儿
   * 等用户去点右边面板的「成片」—— 那是「热点成片」页（手动模式）的用法。
   *
   * 三条纪律：
   *   1) 一张卡只自动踢一次：跑挂了不偷偷重跑（一次要烧 AI + 几张图 + 几分钟），
   *      要重来点卡头那颗按钮；
   *   2) 已经跑过的卡（state.hotRanAt）不重跑 —— 重开任务、重启应用都算跑过；
   *   3) 跑不起来（没填主题 / 生图引擎没配 / 别的卡正忙）就说清原因，不静默不动。
   */
  useEffect(() => {
    // 右栏收着 = 工作台没挂载，踢了也没人接
    if (!pageActive || !panelOpen) return;
    const task = activeTask;
    if (!task || !isWorkspaceCard) return;
    if (task.state?.hotRanAt) return;
    if (autoStartedRef.current.has(task.id)) return;
    const btn = pipelineButton;
    // 工作台还在加载设置 / 主题还没到手：等下一次状态过来再踢
    if (!btn || btn.running) return;
    if (!btn.canRun) {
      if (btn.disabledReason) {
        const key = `${task.id}:${btn.disabledReason}`;
        if (!autoBlockedRef.current.has(key)) {
          autoBlockedRef.current.add(key);
          upsertBubble(AUTO_BUBBLE, `这张卡我先没动：${btn.disabledReason}。`);
        }
      }
      return;
    }
    autoStartedRef.current.add(task.id);
    upsertBubble(
      AUTO_BUBBLE,
      "收到，我直接开跑：写分镜 → 生图 → 配音、字幕、合成。你不用管，成片好了我叫你。"
    );
    // confirmed：这是"我自己决定跑的"，别再弹一个确认框让用户点一下
    workbenchRef.current?.runPipeline({ confirmed: true });
  }, [
    pageActive,
    panelOpen,
    activeTask,
    isWorkspaceCard,
    pipelineButton,
    upsertBubble,
  ]);
  /**
   * 托管进度：按工作台发来的阶段，改写上面那条气泡。
   * 只播报「我们自己踢起来的那张卡」—— 用户在「热点成片」页手动跑的，别把话塞进对话区。
   */
  useEffect(() => {
    const taskId = activeTask?.id;
    const btn = pipelineButton;
    if (!taskId || !btn || !btn.stage || !btn.status) return;
    if (!autoStartedRef.current.has(taskId)) return;
    const text = pipelineReport(btn);
    if (text) upsertBubble(AUTO_BUBBLE, text);
    /*
     * 落终态：工作区卡不走 agent:run，任务 status 永远停在 draft，
     * 左栏就会一直写「待执行」——明明已经出片了，看着像还要再点一下。
     * 按 taskId+status 去重：同一种终态只写一次，但"失败 → 修好重跑 → 成功"要能改成 done。
     */
    if (btn.status === "done" || btn.status === "error") {
      const key = `${taskId}:${btn.status}`;
      if (!autoStatusRef.current.has(key)) {
        autoStatusRef.current.add(key);
        void window.agent
          .patchState({ taskId, patch: { status: btn.status === "done" ? "done" : "failed" } })
          .then(applyTask)
          .catch(() => {
            /* 写不上只影响左栏那行小字，不影响成片 */
          });
      }
    }
  }, [activeTask?.id, pipelineButton, upsertBubble]);

  /**
   * 内嵌分镜工作台。两处渲染它：带链接的解说卡里（挂在步骤行下面），和工作区卡里（直接当卡身）。
   * 只有「主按钮谁画」不同：工作区卡把它移到卡头（asCardBody），所以这里要收状态、
   * 并且不让工作台再摆一个同级主按钮。
   */
  function renderWorkbench(task: AgentTask, step: AgentStep, asCardBody: boolean) {
    /*
     * 主题预填：建卡时带的话题优先；带链接的解说在解析/提文案之前没有话题，
     * 就用视频标题（不行再截文案开头）——跟旧链路给分镜工具的取值顺序一致。
     * 主题到位时重挂一次（key 带上它），工作台才能捡到晚来的标题/文案。
     */
    const stepTopic = (step.params ?? []).find((p) => p.key === "topic")?.value ?? "";
    const initialTopic =
      stepTopic || task.state?.meta?.title || task.state?.transcript?.slice(0, 40) || "";
    return (
      <HotStoryWorkbench
        key={`${task.id}:${initialTopic}`}
        active={pageActive}
        initialHot={task.hot ?? null}
        initialTopic={initialTopic}
        initialBoardId={task.state?.storyboardId ?? null}
        onBoardIdChange={(id) => void patchBoardId(task, id)}
        showLastDraft={false}
        onOpenDoubao={onToggleDoubao}
        cardMode={asCardBody}
        controlRef={asCardBody ? workbenchRef : undefined}
        onPipelineState={asCardBody ? onPipelineState : undefined}
        /*
         * 工作台的图文解说卡定位成「全自动」：
         *   - 热点在对话框里选，卡上不再摆热榜（同一件事只留一个地方改）
         *   - 点过一次之后下面全是过程：只给看，不给改；要改去「热点成片」页
         *   - 跑之前先确认一次（一次要花 AI 调用 + 若干张图 + 几分钟）
         */
        hideHotPicker={asCardBody}
        /*
         * 只读 = "这条已经跑过了，下面都是机器的产物"。
         * 但**跑挂了要放开**：比如主题写歪了导致分镜不对，用户得能改一下再来一轮，
         * 否则只读态下连主题框都点不动，只能去「热点成片」页重开一份。
         * 判据用任务上的 status（持久化），不看 pipelineButton —— 工作台的流水线状态
         * 只活在内存里，重开应用就没了，用它判会让失败卡又变回只读。
         */
        readOnly={asCardBody && taskStarted && activeTask?.status !== "failed"}
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

  // ---------------------------------------------------------------------------
  // 会话：左栏一件事一条，右侧是这件事的消息流
  // ---------------------------------------------------------------------------

  useEffect(() => {
    activeConvIdRef.current = activeConvId;
  }, [activeConvId]);

  /** 拉一次会话列表（左栏） */
  const refreshConvs = useCallback(async (): Promise<ConversationSummary[]> => {
    try {
      const list = await window.conv.list();
      setConvs(list);
      return list;
    } catch {
      return [];
    }
  }, []);

  /** 打开一条会话：恢复消息流，并把它最后一轮的任务卡摆到右栏 */
  async function openConversation(id: string): Promise<void> {
    try {
      const conv = await window.conv.get(id);
      if (!conv) return;
      setActiveConvId(conv.id);
      activeConvIdRef.current = conv.id;
      setConvMessages(conv.messages);
      // 临时播报属于上一轮，别串到这条会话里
      setBubbles([]);
      // 换会话：上一件事的上下文不能喂给运行时
      chatLogRef.current = [];
      const lastTaskId = conv.taskIds.length ? conv.taskIds[conv.taskIds.length - 1] : null;
      if (lastTaskId) {
        const t = await window.agent.get(lastTaskId);
        if (t) {
          applyTask(t);
          setActiveId(t.id);
        } else {
          setActiveId(null);
        }
      } else {
        setActiveId(null);
      }
    } catch (e: unknown) {
      setError(errText(e));
    }
  }

  /**
   * 开一条新会话（左栏 ＋）：**只把界面清成一张白纸，先不落盘**。
   *
   * 像 dsh 那样——点「＋」不等于新建了一条记录，说第一句话时才真正建
   * （见 createFrom 里的 conv.create）。否则连点两下＋，左栏就多出两条「新会话」空壳。
   */
  function newConversation(): void {
    setActiveConvId(null);
    activeConvIdRef.current = null;
    setConvMessages([]);
    setBubbles([]);
    chatLogRef.current = [];
    setActiveId(null);
    if (!panelOpen) onTogglePanel?.();
  }

  /**
   * 往会话里追加一条消息：立刻上屏，同时落盘。
   * 落盘失败不影响这一轮继续跑 —— 聊天记录丢一条，比整件事卡住强。
   */
  async function pushMessage(
    convId: string,
    msg: { role: "user" | "assistant"; text: string; images?: string[]; taskId?: string }
  ): Promise<void> {
    const local: ConversationMessage = {
      id: `local-${Date.now()}-${Math.random().toString(36).slice(2, 5)}`,
      at: Date.now(),
      role: msg.role,
      text: msg.text,
      images: msg.images,
      taskId: msg.taskId,
    };
    setConvMessages((prev) => [...prev, local]);
    try {
      const conv = await window.conv.append({ convId, message: msg });
      if (conv) {
        // 以落盘的为准（id/时间由主进程给），顺带更新左栏的时间与摘要
        if (conv.id === activeConvIdRef.current) setConvMessages(conv.messages);
        void refreshConvs();
      }
    } catch {
      /* 内存里那条还在，这一轮照跑 */
    }
  }

  /** 点消息里的「结果卡」：把那轮的任务卡摆到右栏（卡可能已被删，先确认还在） */
  async function openTaskById(taskId: string): Promise<void> {
    let t = tasks.find((x) => x.id === taskId) ?? null;
    if (!t) {
      try {
        t = await window.agent.get(taskId);
      } catch {
        t = null;
      }
    }
    if (!t) {
      setError("这张卡已经不在了（可能被删掉了）。");
      return;
    }
    applyTask(t);
    setActiveId(t.id);
    if (!panelOpen) onTogglePanel?.();
  }

  /** 删会话 = 删这件事：它产出的任务卡一起收掉（主进程那边做） */
  async function deleteConversation(c: ConversationSummary): Promise<void> {
    if (
      !(await confirmDelete({
        title: `删除会话「${c.title}」？`,
        detail: "这条会话里的对话记录、以及它产出的任务卡都会删掉，但产物文件不会删。",
      }))
    ) {
      return;
    }
    try {
      await window.conv.remove(c.id);
      const rest = await refreshConvs();
      if (activeConvIdRef.current === c.id) {
        if (rest.length) void openConversation(rest[0].id);
        else {
          setActiveConvId(null);
          activeConvIdRef.current = null;
          setConvMessages([]);
          setBubbles([]);
          setActiveId(null);
        }
      }
      await refresh();
    } catch (e: unknown) {
      setError(errText(e));
    }
  }

  useEffect(() => {
    void (async () => {
      await refresh();
      // 左栏是会话：拉一次列表，默认打开最近那条（把它最后一轮的卡摆到右栏）
      const list = await refreshConvs();
      if (list.length) void openConversation(list[0].id);
    })();
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

  /** 设置/关于页左栏点了任务：App 已切回工作台，这里找回它所属的会话并打开 */
  useEffect(() => {
    if (!pendingOpenTaskId) return;
    const taskId = pendingOpenTaskId;
    onTaskConsumed?.();
    void (async () => {
      try {
        const conv = await window.conv.ofTask(taskId);
        if (conv) {
          await openConversation(conv.id);
          return;
        }
      } catch {
        /* 反查不到就直接开卡 */
      }
      setActiveId(taskId);
    })();
    // onTaskConsumed 是 App 里的 setState 包装，稳定；只跟 pendingOpenTaskId 走
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pendingOpenTaskId]);

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

  /**
   * 会话里带图的消息：切回历史时也得看得见图。
   * 落盘的是路径，URL 每次启动都要重新换一遍（缓存活的，不跨进程）。
   */
  const convImageSig = convMessages.flatMap((m) => m.images ?? []).join("|");
  useEffect(() => {
    let alive = true;
    const todo = (convImageSig ? convImageSig.split("|") : []).filter(
      (p) => p && !attachUrls[p] && !imageUrlCache.current[p]
    );
    if (!todo.length) return;
    (async () => {
      const add: Record<string, string> = {};
      for (const p of todo) {
        try {
          add[p] = await window.media.toUrl(p);
        } catch {
          /* 图不在了就不显示缩略图，路径本身还在 */
        }
      }
      if (alive && Object.keys(add).length) setAttachUrls((prev) => ({ ...add, ...prev }));
    })();
    return () => {
      alive = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [convImageSig]);

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
    const shown = bubble ? bubble.text : hot ? `按热点：${hot.title}` : instruction;
    /*
     * 会话：没有就在这儿开一条（第一句话顺便给它起标题），有就接着往里说。
     * 同一件事说第二遍不会再在左栏多出一条 —— 那正是"任务列表"最烦人的地方。
     */
    let convId = activeConvIdRef.current;
    if (!convId) {
      try {
        const conv = await window.conv.create(shown);
        convId = conv.id;
        setActiveConvId(conv.id);
        activeConvIdRef.current = conv.id;
        setConvMessages([]);
        void refreshConvs();
      } catch {
        /* 会话开不出来也别挡着干活：这一轮当无会话跑，消息只在界面上 */
      }
    }
    if (convId) {
      await pushMessage(convId, { role: "user", text: shown, images: bubble?.images });
    } else {
      setBubbles((prev) => [...prev, { role: "user", text: shown, images: bubble?.images }]);
    }
    /*
     * 已应用运行时（设置 → 运行时）：这句先交给它 —— 听懂、聊清楚、给出计划，
     * 有计划就按宝螺现有的流程建卡并开跑。它起不来就停在这儿，不往本地链路落（见下面 catch）。
     *
     * 附图 / 热点建卡不走这条：图它看不见，热点卡有既定的分镜链路。
     */
    const rt = runtimeRef.current;
    if (rt && !hot && !bubble?.images?.length) {
      const history: RuntimeChatMessage[] = [
        ...chatLogRef.current,
        { role: "user", text: instruction },
      ];
      setRuntimeThinking(true);
      try {
        const reply = await window.runtime.chat(history);
        chatLogRef.current = [
          ...history,
          { role: "assistant" as const, text: reply.text },
        ].slice(-16);
        // 回复进会话（有卡就一并挂上，界面上它是这条消息的结果块）
        if (convId) {
          await pushMessage(convId, {
            role: "assistant",
            text: reply.text,
            taskId: reply.task?.id,
          });
        } else {
          setBubbles((prev) => [...prev, { role: "bot", text: reply.text }]);
        }
        if (reply.task) {
          applyTask(reply.task);
          setActiveId(reply.task.id);
          if (convId) {
            await window.conv.bindTask({ convId, taskId: reply.task.id });
            void refreshConvs();
          }
          if (!panelOpen) onTogglePanel?.();
          await autoRun(reply.task);
        }
        return;
      } catch (e: unknown) {
        /*
         * 起不来 / 超时 / 报错：**就停在这儿，不再往下面的本地流程走**。
         * 后面写分镜、写脚本、出提示词全得靠运行时，没有它就是一张跑不动的卡，
         * 跑到生图那步失败再报个更绕的错——不如当场说清"没开工、去修哪儿"。
         */
        const sorry = runtimeDownHint(e);
        if (convId) await pushMessage(convId, { role: "assistant", text: sorry });
        else setBubbles((prev) => [...prev, { role: "bot", text: sorry }]);
        // 这轮没成，上下文也清掉：重发那句话就是干干净净重开一轮
        chatLogRef.current = [];
        return;
      } finally {
        setRuntimeThinking(false);
      }
    }
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
        const said = auto ? autoRunHint(task) : r.parse.summary;
        if (convId) {
          await window.conv.bindTask({ convId, taskId: task.id });
          await pushMessage(convId, { role: "assistant", text: said, taskId: task.id });
        } else {
          setBubbles((prev) => [...prev, { role: "bot", text: said }]);
        }
        await autoRun(task);
      } else {
        if (convId) await pushMessage(convId, { role: "assistant", text: r.parse.summary });
        else setBubbles((prev) => [...prev, { role: "bot", text: r.parse.summary }]);
      }
    } catch (e: unknown) {
      setError(errText(e));
    }
  }

  /**
   * 权限范围：点一下就落盘，**下一轮**生效（正在跑的那轮不打断）。
   * 先本地变色，写失败再回滚 —— 这两颗是高频操作，等 IPC 回来再变色会显得顿。
   */
  async function choosePermission(id: RuntimePermissionId): Promise<void> {
    setPickOpen(null);
    if (id === runtimePerm) return;
    const prev = runtimePerm;
    setRuntimePerm(id);
    try {
      const st = await window.runtime.setPrefs({ permission: id });
      setRuntimePerm(st.permission);
    } catch (e: unknown) {
      setRuntimePerm(prev);
      setError(errText(e));
    }
  }

  /** 模型：null = 交回 CLI 自己配置里那个 */
  async function chooseModel(id: string | null): Promise<void> {
    setPickOpen(null);
    if (id === runtimeModel) return;
    const prev = runtimeModel;
    setRuntimeModel(id);
    try {
      const st = await window.runtime.setPrefs({ model: id });
      setRuntimeModel(st.model);
    } catch (e: unknown) {
      setRuntimeModel(prev);
      setError(errText(e));
    }
  }

  /**
   * 读模型清单（点开菜单时读一次；「重读」跳过主进程那 30 秒缓存）。
   * 读失败**不清空已有的** —— 上次读到的那份还能用，比空盒子强。
   */
  async function loadModels(force = false): Promise<void> {
    const rt = runtimeRef.current;
    if (!rt) return;
    setModelLoading(true);
    try {
      const list = await window.runtime.models(rt, force);
      if (runtimeRef.current !== rt) return;
      setModelList(list);
    } catch (e: unknown) {
      setModelList((prev) => prev ?? { ok: false, models: [], defaultModel: null, source: "", error: errText(e) });
    } finally {
      setModelLoading(false);
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
    // 运行时一轮还没回来就再发：会起两个 CLI 抢同一段对话，直接挡掉
    if (runtimeThinking) return;
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

  /**
   * 选中一条热点：不再直接建卡，回显到输入框，用户看过 / 改过再点发送。
   * 回显带「@热点」点名：发送后路由会强制走图文解说（否则裸标题会被智能分流猜错）。
   */
  function pickHot(item: HotItem): void {
    setHotOpen(false);
    setInput(`@热点 ${item.title}`);
    inputRef.current?.focus();
  }

  /**
   * 跑任务。
   *
   * `auto` = 建卡后自动跑的那一步：这时"已经有任务在跑"不算错误，
   * 安静跳过就行——解析/下载不给手动重跑（要重做去素材捕手重新贴链接）。
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
   * 建完卡自动往下跑的那几步。
   *
   * 自动跑的步骤类型：
   *   - parse-link / download：扒素材，跑完才有东西可用
   *   - write-script / dialogue-config：写台词、套模板配好角色画面——
   *     对话模板已经把形象图和音色都摆好了，这两步不用人插手
   *
   * 到此为止：**合成（compose）永远停下等用户点**。它最耗资源（逐句 TTS + ffmpeg 渲染，
   * 30 秒的片子要 1~3 分钟），而且用户看过脚本再决定要不要出片才合理。
   */
  /**
   * 建完卡自动往下跑的步骤类型。
   *
   * 工作台的定位是**全自动**：说一句话就出片，中间不停下来让人配参数
   * （要改配置去「视频生成」页，那边是手动模式）。
   *   - parse-link / download：扒素材
   *   - transcribe：从原片提文案（对话链的台词素材，用户不用管）
   *   - write-script：写台词（AI）
   *   - dialogue-config：套模板配好角色画面（形象图/音色/运镜都是模板给的）
   *   - compose / compose-narration：合成出片
   */
  const AUTO_KINDS = new Set([
    "parse-link",
    "download",
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
    if (kinds.includes("parse-link") || kinds.includes("download")) parts.push("扒素材");
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
    /*
     * 下载类任务的产物已经由 StepVideo 摆在「下载」那一步下面了（同一份 outputPath），
     * 这里再判一次就变成同一条片子摆两个播放器——直接让位。
     */
    if (step.kind === "download") return false;
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
      // 试听失败只可能是语音合成这条路，文案交给 ttsErrorText（403/超时都翻成人话）
      setError(ttsErrorText(e));
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

  /*
   * 左栏列表块：入口页和对话形态共用。
   * 列的是**会话**（一件事一条）——以前列任务卡，同一个主题重发一次就多一条一样的，
   * 中间聊两句想法也各占一行，越用越像日志。＋ = 新开一件事。
   */
  const taskListBlock = (
    <>
      <div className="panel-title-row">
        <span className="panel-title">会话</span>
        <span className="ws-list-title-right">
          <ListAddButton
            title="新建会话：只进对话形态，说第一句话时才落一条记录"
            onClick={() => {
              // 只进对话形态：右侧操作区保持原状（默认收起），说第一句话时才会展开
              onLeaveHome?.();
              void newConversation();
            }}
          />
        </span>
      </div>
      {convs.length === 0 ? (
        <p className="split-empty">还没有会话。说一句话就开始一件事。</p>
      ) : (
        <div className="ws-list-items">
          {convs.map((c) => {
            /* 行上写"这件事现在到哪了"：有卡就看卡的状态，没卡就是还在聊 */
            const t = c.lastTaskId ? tasks.find((x) => x.id === c.lastTaskId) ?? null : null;
            return (
              /* 行长相与图文解说等页共用（SideRow = .side-row）：删除也走同款悬浮 ✕ */
              <SideRow
                key={c.id}
                title={c.title}
                active={c.id === activeConvId}
                meta={<span>{t ? statusText(t) : "对话中"}</span>}
                time={formatListTime(c.updatedAt)}
                onOpen={() => {
                  onLeaveHome?.();
                  void openConversation(c.id);
                  // 操作区收着时点会话：把操作区拉回来，不然点了没反应
                  if (!panelOpen) onTogglePanel?.();
                }}
                onDelete={() => void deleteConversation(c)}
                deleteLabel={`删除会话 ${c.title}`}
              />
            );
          })}
        </div>
      )}
    </>
  );

  /* ---------- 入口页形态：左侧导航 + 任务列表（+号新建），右侧只摆插件卡片 ---------- */
  if (home) {
    return (
      <div className="ws ws-home-wrap">
        <aside className="ws-list">
          {nav}
          {taskListBlock}
        </aside>
        <main className="ws-home">
          <h2 className="ws-home-title">工作台</h2>
          {PLUGIN_GROUPS.map((g) => {
            const items = g.keys
              .filter((k) => plugins.some((p) => p.key === k))
              .map((k) => plugins.find((p) => p.key === k)!);
            if (!items.length) return null;
            return (
              <section key={g.title} className="ws-home-group">
                <h3 className="ws-home-group-title">{g.title}</h3>
                <div className="ws-home-grid">
                  {items.map((p) => {
                    const icon = PLUGIN_ICONS[p.key] ?? { emoji: "🧩", bg: "#86868b" };
                    return (
                      <button
                        key={p.key}
                        type="button"
                        className="ws-home-card"
                        onClick={() => onOpenPlugin?.(p.key)}
                        title={p.desc}
                      >
                        <span className="ws-home-icon" style={{ background: icon.bg }} aria-hidden="true">
                          {icon.emoji}
                        </span>
                        <span className="ws-home-card-text">
                          <span className="ws-home-card-name">{p.name}</span>
                          <span className="ws-home-card-desc">{p.desc}</span>
                        </span>
                      </button>
                    );
                  })}
                </div>
              </section>
            );
          })}
          {!plugins.length && <p className="status">还没有已安装的插件。去「设置 → 插件」装一个试试。</p>}
        </main>
      </div>
    );
  }

  return (
    <div className={`ws${listShown ? "" : " list-closed"}${panelOpen ? "" : " panel-closed"}`}>
      {/* 收起时整个列表不渲染：网格里只剩对话、操作区两项，正好对应两列 */}
      {listShown && (
        <aside className="ws-list">
          {nav}
          {taskListBlock}
        </aside>
      )}

      {/* 操作区收起时整块不渲染：网格里对话占满；点任务或发消息会把它拉回来 */}
      {panelOpen && (
      <main className="ws-main">
        {!activeTask ? (
          <div className="ws-empty">
            <p className="subtitle">贴一条视频链接、给一个主题，或者点输入框左下角的「＋」点名要干什么。</p>
            <p className="status">我会把它拆成几步摆在这儿，跑之前你还能改参数。</p>
          </div>
        ) : (
          <>
            <div className="ws-head">
              <span className="panel-title">{activeTask.title}</span>
              {/* 工作区卡不摆徽章：卡建好就自己跑，状态在卡里的进度条上，
                  再来一个「待执行」只会自相矛盾——卡上根本没有「执行」 */}
              {!isWorkspaceCard && (
                <span className={`ws-badge ${activeTask.status}`}>{statusText(activeTask)}</span>
              )}
              <div className="ws-head-actions">
                {shownRunning && <span className="status">已用时 {elapsed}s</span>}
                {isWorkspaceCard ? (
                  /* 全自动：卡建好自己开跑，所以这里不摆「成片」；剩下的只有
                     「中止」（跑太久想停）和「去细改」（要手动调去热点成片页） */
                  <>
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
                        {isRoleStep(step) && !isAutoCard && tplEnabled && (
                          <div className="ws-tpl-pick">
                            {/*
                              下拉框只列模板名（摘要放不下也没必要——名字就是他自己起的）。
                              value 恒为 ""，选完仍显示「用模板」：
                              这样同一份模板连着套两次也能触发（onChange 只有值变了才回调）。
                            */}
                            <BeeSelect
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
                    {/* 下载产物直接摆在这一步下面：不再走单独的产物区 */}
                    {step.kind === "download" && step.status === "done" && step.outputPath && (
                      <StepVideo path={step.outputPath} kind={activeTask.resultKind} />
                    )}
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
        <div className="ws-bubbles">
          {/* 会话里落过盘的消息：你说的话、我回的、以及每一轮产出的「结果卡」 */}
          {convMessages.map((m) =>
            m.role === "assistant" ? (
              <div key={m.id} className="ws-row bot">
                <img className="ws-chat-avatar" src={tianluAvatar} alt="田螺姑娘" />
                <div className="ws-bubble-col">
                  {m.text ? <div className="ws-bubble bot">{m.text}</div> : null}
                  {m.taskId ? (
                    <button
                      type="button"
                      className="ws-result-chip"
                      title="在右边打开这一轮的结果"
                      onClick={() => void openTaskById(m.taskId!)}
                    >
                      <span className="ws-result-dot" aria-hidden="true" />
                      {(() => {
                        const t = tasks.find((x) => x.id === m.taskId);
                        return t ? `${t.title} · ${statusText(t)}` : "这一轮的结果";
                      })()}
                    </button>
                  ) : null}
                </div>
              </div>
            ) : (
              <div key={m.id} className="ws-bubble user">
                {m.images && m.images.length > 0 && (
                  <div className="ws-bubble-images">
                    {m.images.map((p) => (
                      <img key={p} src={attachUrls[p]} alt={p} title={p} />
                    ))}
                  </div>
                )}
                {m.text}
              </div>
            )
          )}
          {/* 临时播报（跑片进度、正在想…）：只活在这一次打开里，不落盘 */}
          {bubbles.map((b, i) =>
            b.role === "bot" ? (
              <div key={`live-${i}`} className="ws-row bot">
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
              <div key={`live-${i}`} className={`ws-bubble ${b.role}`}>
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
          {runtimeThinking && (
            <div className="ws-row bot">
              <img className="ws-chat-avatar" src={tianluAvatar} alt="田螺姑娘" />
              <div className="ws-bubble bot ws-typing">正在想…</div>
            </div>
          )}
        </div>
        {hotOpen && (
          <>
            {/* 点面板外任意处收起（面板本体在 backdrop 之上，点击榜单不受影响） */}
            <div className="ws-plus-backdrop" onClick={() => setHotOpen(false)} />
            <div className="ws-hot-panel">
              <div className="ws-hot-head">
                <span className="ws-hot-head-title">
                  🔥 热点榜单<span className="ws-hot-head-hint">点一条回显到输入框，点发送建卡</span>
                </span>
                <button
                  type="button"
                  className="ws-hot-close"
                  aria-label="收起热点"
                  title="收起"
                  onClick={() => setHotOpen(false)}
                >
                  ✕
                </button>
              </div>
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
                <button key={it.id} className="ws-hot-item" onClick={() => pickHot(it)}>
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
          </>
        )}
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
          {/* 点「＋」才出现的菜单：选热点 / 添加图片（backdrop 兜底点空白处收起） */}
          {plusOpen && (
            <>
              <div className="ws-plus-backdrop" onClick={() => setPlusOpen(false)} />
              <div className="ws-plus-menu" role="menu">
                {featureEnabled("@热点") && (
                  <button
                    type="button"
                    className={`ws-plus-item${hotOpen ? " active" : ""}`}
                    role="menuitem"
                    onClick={() => {
                      setPlusOpen(false);
                      void toggleHot();
                    }}
                  >
                    <svg className="ws-plus-item-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
                      <path d="M12 3c1 2-1 3.5-1 5a2.5 2.5 0 0 0 5 .3C17.5 10 19 11.6 19 14a7 7 0 0 1-14 0c0-2.6 1.6-4.2 3-5.5.5 1 1.2 1.7 2 2-.4-2.8.3-5.6 2-7.5Z" />
                    </svg>
                    <span className="ws-plus-item-label">选热点</span>
                    <span className="ws-plus-item-chevron">›</span>
                  </button>
                )}
                <button
                  type="button"
                  className="ws-plus-item"
                  role="menuitem"
                  onClick={() => {
                    setPlusOpen(false);
                    void pickImage();
                  }}
                >
                  <svg className="ws-plus-item-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
                    <rect x="3" y="4" width="18" height="16" rx="2.5" />
                    <circle cx="9" cy="10" r="1.6" />
                    <path d="m3.5 17.5 4.6-4.6a1.5 1.5 0 0 1 2.1 0l6.3 6.1" />
                    <path d="m14.5 16.5 2-2a1.5 1.5 0 0 1 2.1 0l2 2" />
                  </svg>
                  <span className="ws-plus-item-label">添加图片</span>
                  <span className="ws-plus-item-chevron">›</span>
                </button>
                {/* 功能名单（＋菜单）：按插件过滤；@热点 = 选热点，不重复列 */}
                {MENTIONS.filter((m) => !m.hot && featureEnabled(m.label)).length > 0 && (
                  <div className="ws-plus-sep" />
                )}
                {MENTIONS.filter((m) => !m.hot && featureEnabled(m.label)).map((m) => (
                  <button
                    key={m.label}
                    type="button"
                    className="ws-plus-item"
                    role="menuitem"
                    title={m.hint}
                    onClick={() => {
                      setPlusOpen(false);
                      setInput((prev) => (prev ? `${prev}${m.insert}` : m.insert));
                      inputRef.current?.focus();
                    }}
                  >
                    <svg className="ws-plus-item-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
                      {m.label === "@下载" && (
                        <>
                          <path d="M12 4v10" />
                          <path d="m7.5 10.5 4.5 4.5 4.5-4.5" />
                          <path d="M4 19h16" />
                        </>
                      )}
                      {m.label === "@对话" && (
                        <>
                          <path d="M4 6.5A2.5 2.5 0 0 1 6.5 4h7A2.5 2.5 0 0 1 16 6.5v3A2.5 2.5 0 0 1 13.5 12H8l-4 3.5v-9Z" />
                          <path d="M16 9h1.5A2.5 2.5 0 0 1 20 11.5v3A2.5 2.5 0 0 1 17.5 17H16l-3 3v-3h-1" />
                        </>
                      )}
                      {m.label === "@语音" && (
                        <>
                          <rect x="9.5" y="3.5" width="5" height="10" rx="2.5" />
                          <path d="M6 11.5a6 6 0 0 0 12 0" />
                          <path d="M12 17.5V21" />
                        </>
                      )}
                      {m.label === "@识别" && (
                        <>
                          <path d="M4 8V6a2 2 0 0 1 2-2h2" />
                          <path d="M16 4h2a2 2 0 0 1 2 2v2" />
                          <path d="M20 16v2a2 2 0 0 1-2 2h-2" />
                          <path d="M8 20H6a2 2 0 0 1-2-2v-2" />
                          <path d="M9 12h6" />
                          <path d="M9 15.5h4" />
                        </>
                      )}
                      {m.label === "@爆款" && (
                        <>
                          <path d="m4 17 5-5 3.5 3.5L20 8" />
                          <path d="M15 8h5v5" />
                        </>
                      )}
                    </svg>
                    <span className="ws-plus-item-label">{m.label}</span>
                    <span className="ws-plus-item-hint">{m.hint}</span>
                    <span className="ws-plus-item-chevron">›</span>
                  </button>
                ))}
              </div>
            </>
          )}
          {/* 权限范围：这一轮运行时能做什么（左）；只有应用了运行时才有意义 */}
          {runtimeName && (
            <div className="ws-pick ws-pick-left">
              {pickOpen === "perm" && (
                <>
                  <div className="ws-pick-backdrop" onClick={() => setPickOpen(null)} />
                  <div className="ws-pick-menu" role="menu">
                    <div className="ws-pick-title">权限范围</div>
                    {RUNTIME_PERMISSIONS.map((p) => (
                      <button
                        key={p.id}
                        type="button"
                        role="menuitemradio"
                        aria-checked={p.id === runtimePerm}
                        className={`ws-pick-item${p.id === runtimePerm ? " active" : ""}`}
                        onClick={() => void choosePermission(p.id)}
                      >
                        <span className="ws-pick-check" aria-hidden>
                          {p.id === runtimePerm ? "✓" : ""}
                        </span>
                        <span className="ws-pick-item-body">
                          <span className="ws-pick-item-label">
                            {p.label}
                            {p.risky && <span className="ws-pick-risky">谨慎</span>}
                          </span>
                          <span className="ws-pick-item-hint">{p.hint}</span>
                        </span>
                      </button>
                    ))}
                    <div className="ws-pick-foot">
                      成片永远是宝螺自己的流水线在做；这一档只决定运行时能不能替你开工。
                    </div>
                  </div>
                </>
              )}
              <button
                type="button"
                className={`ws-pick-btn${pickOpen === "perm" ? " active" : ""}${
                  runtimePerm === "full" ? " risky" : ""
                }`}
                title="权限范围（这一轮运行时能做什么）"
                aria-haspopup="menu"
                onClick={() => setPickOpen((v) => (v === "perm" ? null : "perm"))}
              >
                <svg className="ws-pick-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
                  <path d="M12 3.5 5 6v6c0 4 3 6.9 7 8.5 4-1.6 7-4.5 7-8.5V6l-7-2.5Z" />
                  <path d="m9 12 2.2 2.2L15.5 10" />
                </svg>
                <span className="ws-pick-label">{permissionOf(runtimePerm).label}</span>
                <svg className="ws-pick-caret" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
                  <path d="m7 15 5-5 5 5" />
                </svg>
              </button>
            </div>
          )}
          {/* 模型：null = 用 CLI 自己配置里那个（右） */}
          {runtimeName && (
            <div className="ws-pick ws-pick-right">
              {pickOpen === "model" && (
                <>
                  <div className="ws-pick-backdrop" onClick={() => setPickOpen(null)} />
                  <div className="ws-pick-menu ws-pick-menu-right" role="menu">
                    <div className="ws-pick-title">
                      模型
                      <button
                        type="button"
                        className="ws-pick-reload"
                        title="重新读一遍 CLI 的配置"
                        onClick={() => void loadModels(true)}
                      >
                        重读
                      </button>
                    </div>
                    <button
                      type="button"
                      role="menuitemradio"
                      aria-checked={runtimeModel === null}
                      className={`ws-pick-item${runtimeModel === null ? " active" : ""}`}
                      onClick={() => void chooseModel(null)}
                    >
                      <span className="ws-pick-check" aria-hidden>{runtimeModel === null ? "✓" : ""}</span>
                      <span className="ws-pick-item-body">
                        <span className="ws-pick-item-label">默认模型</span>
                        <span className="ws-pick-item-hint">
                          {modelList?.defaultModel
                            ? `CLI 配置里那个：${modelList.defaultModel}`
                            : "用 CLI 配置文件里那个，不额外指定"}
                        </span>
                      </span>
                    </button>
                    {/* 清单是现读的：读的过程中给个"在读"，读不到说清为什么，别给个空盒子 */}
                    {modelLoading && <div className="ws-pick-note">正在读运行时的模型配置…</div>}
                    {!modelLoading &&
                      (modelList?.models ?? []).map((m) => (
                        <button
                          key={m.id}
                          type="button"
                          role="menuitemradio"
                          aria-checked={runtimeModel === m.id}
                          className={`ws-pick-item${runtimeModel === m.id ? " active" : ""}`}
                          title={m.id}
                          onClick={() => void chooseModel(m.id)}
                        >
                          <span className="ws-pick-check" aria-hidden>{runtimeModel === m.id ? "✓" : ""}</span>
                          <span className="ws-pick-item-body">
                            <span className="ws-pick-item-label">{m.label}</span>
                            {m.hint && <span className="ws-pick-item-hint">{m.hint}</span>}
                          </span>
                        </button>
                      ))}
                    {!modelLoading && modelList?.error && (
                      <div className="ws-pick-note warn">{modelList.error}</div>
                    )}
                    <div className="ws-pick-custom">
                      <input
                        value={modelDraft}
                        placeholder="其他模型名…"
                        onChange={(e) => setModelDraft(e.target.value)}
                        onKeyDown={(e) => {
                          if (e.key === "Enter" && modelDraft.trim()) {
                            e.preventDefault();
                            void chooseModel(modelDraft.trim());
                          }
                        }}
                      />
                      <button
                        type="button"
                        disabled={!modelDraft.trim()}
                        onClick={() => void chooseModel(modelDraft.trim())}
                      >
                        用
                      </button>
                    </div>
                    <div className="ws-pick-foot">
                      {modelList?.source ? `清单来自 ${modelList.source}` : "模型名会原样传给 CLI（--model）"}
                      ，写错会报"模型不存在"，那一轮就不开工了。
                    </div>
                  </div>
                </>
              )}
              <button
                type="button"
                className={`ws-pick-btn${pickOpen === "model" ? " active" : ""}`}
                title={runtimeModel ? `模型：${runtimeModel}` : "模型（这一轮用哪个）"}
                aria-haspopup="menu"
                onClick={() => {
                  setModelDraft(runtimeModel ?? "");
                  if (pickOpen !== "model") void loadModels();
                  setPickOpen((v) => (v === "model" ? null : "model"));
                }}
              >
                <svg className="ws-pick-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
                  <rect x="6.5" y="6.5" width="11" height="11" rx="2.5" />
                  <path d="M10 3.5v2M14 3.5v2M10 18.5v2M14 18.5v2M3.5 10h2M3.5 14h2M18.5 10h2M18.5 14h2" />
                </svg>
                <span className="ws-pick-label">
                  {runtimeModel
                    ? (modelList?.models.find((m) => m.id === runtimeModel)?.label ?? runtimeModel)
                    : "默认模型"}
                </span>
                <svg className="ws-pick-caret" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
                  <path d="m7 15 5-5 5 5" />
                </svg>
              </button>
            </div>
          )}
          <button
            type="button"
            className={`ws-attach-add${plusOpen || hotOpen ? " active" : ""}`}
            title="选热点 / 添加图片"
            aria-label="选热点或添加图片"
            onClick={() => setPlusOpen((v) => !v)}
          >
            ＋
          </button>
          <textarea
            ref={inputRef}
            value={input}
            rows={4}
            placeholder="直接贴链接 / 说主题（Enter 发送，Shift+Enter 换行）"
            onChange={(e) => setInput(e.target.value)}
            onKeyDown={(e) => {
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
            disabled={!input.trim() || runtimeThinking}
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
