import { useCallback, useEffect, useRef, useState } from "react";
import type { DragEvent } from "react";
import { usePageActive } from "../components/KeepAlive";
import { HourglassIcon, SpeakerIcon } from "../components/VoiceIcons";
import { ttsErrorText } from "../lib/err-text";
import type {
  BeeApi,
  DialogueApi,
  MediaApi,
  SettingsApi,
} from "../../preload";
import type {
  ComposeProgress,
  DialogueImageScene,
  DialogueLine,
  DialogueSettings,
  MotionConfig,
  MotionMode,
  SceneNarrator,
  TemplateConfig,
  VideoMode,
  VideoResolution,
  VoiceProsody,
} from "../../shared/dialogue-types";
import { effectiveFavoriteVoices, VOICE_OPTIONS } from "../../shared/voices";
import BeeSelect from "../components/BeeSelect";
import { useConfirm } from "../components/ConfirmDialog";
import ShotRecorder from "../components/workspace/ShotRecorder";
import SideList, { ListAddButton, SideRow, formatListTime } from "../components/SideList";
import type { RecordsApi } from "../../preload";
import type { WorkRecordKind, WorkRecordSummary } from "../../shared/record-types";

/**
 * 一条记录里存什么：够把编辑器恢复成当时的样子就行。
 * 成片路径不放这儿，它是列表上的字段（WorkRecord.outputPath）。
 */
interface DialogueRecordPayload {
  topic: string;
  scriptDuration: number;
  script: string;
  scenes: DialogueImageScene[];
  narrators: Array<SceneNarrator | undefined>;
  resolution: VideoResolution;
  motionMode: MotionMode;
  motionAmount: number;
  imageFortune: string | null;
  imageCustomer: string | null;
  motionRoleA: MotionConfig;
  motionRoleB: MotionConfig;
}

declare global {
  interface Window {
    bee: BeeApi;
    dialogue: DialogueApi;
    media: MediaApi;
    settings: SettingsApi;
    records: RecordsApi;
  }
}

const MOTION_OPTIONS: Array<{ value: MotionMode; label: string }> = [
  { value: "none", label: "无（静止）" },
  { value: "zoom-in", label: "推近" },
  { value: "zoom-out", label: "拉远" },
  { value: "pan-left", label: "左移" },
  { value: "pan-right", label: "右移" },
];

/** 合成阶段的人话（与热点成片 ③ 一致） */
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

function motionLabel(mode: MotionMode): string {
  return MOTION_OPTIONS.find((o) => o.value === mode)?.label ?? mode;
}

/** AI 写脚本的目标时长档位（跟热点成片那档一致，另加 45 秒 = 本来的默认值） */
const SCRIPT_DURATION_OPTIONS = [15, 30, 45, 60, 90, 120].map((s) => ({
  value: String(s),
  label: `${s} 秒`,
}));

const DEFAULT_DIALOGUE_SCRIPT = `甲方：最近工作压力特别大，晚上老是睡不着，想跟你聊聊。
乙方：怎么回事？说说看，我帮你捋一捋。
甲方：项目一个接一个，领导天天催，感觉快撑不住了。
乙方：你先别急，最近是不是太拼了，把自己绷得太紧了？
甲方：确实，回家就想躺着，什么也不想干。
乙方：那就对了，身体和脑子都需要歇一歇。该休息休息，别硬扛。
甲方：听你这么一说，心里踏实多了。
乙方：嗯，先把觉睡好，其他的事情一件一件来。`;

const DEFAULT_NARRATION_SCRIPT = `#图1
解说员A：先看第一张图，整体轮廓一目了然。
解说员B：注意，这里的细节才是关键。

#图2
不写角色名时，就用默认解说员音色继续讲。
长句子会自动按标点拆成多条字幕，不会糊满一屏。
`;

/**
 * 两个页面（图文解说 / 两人对话）共用这一个组件，靠 mode 区分：
 * 标题、默认脚本、以及启动时套用哪份保存的模板，都从这里取。
 */
const MODE_META: Record<VideoMode, { title: string; subtitle: string; defaultScript: string }> = {
  narration: {
    title: "图文解说",
    subtitle: "多张图片 + 解说员配音（可统一运镜或一图一屏），一键生成解说视频。",
    defaultScript: DEFAULT_NARRATION_SCRIPT,
  },
  dialogue: {
    title: "对话模式",
    subtitle: "甲方乙方的对话脚本 + 人物形象与音色，一键生成配音视频。",
    defaultScript: DEFAULT_DIALOGUE_SCRIPT,
  },
};

/**
 * 页面草稿（自动保存，防手滑）：
 *   两人对话 → 脚本文本；图文解说 → 整个分镜列表（图 + 解说词）。
 * 拆成两个页面后，切页面会重新挂载组件，不留草稿会把正在写的内容丢掉。
 * 模板库（对话/分镜模板）在 records 里，不受这里影响；「当前套用的是哪份模板」
 * 的来路 id 跟着草稿一起存（见下面的 templateId）。
 */
interface ModeDraft {
  script?: string;
  /** 两人对话：这一版脚本的主题词 */
  topic?: string;
  /** 两人对话：让 AI 写脚本时选的目标时长（秒） */
  duration?: number;
  scenes?: DialogueImageScene[];
  /** 图文解说：每个镜头的解说员（与 scenes 对齐） */
  narrators?: Array<SceneNarrator | undefined>;
  /*
   * 下面这几项是"这套配置"，不属于某一条脚本——
   * 但对话模式不再有"默认模板自动套用"，它们又不在记录里，
   * 所以跟着草稿一起存，免得重启后形象图/运镜/画面比例白白退回内置默认。
   */
  imageFortune?: string | null;
  imageCustomer?: string | null;
  resolution?: VideoResolution;
  motionRoleA?: MotionConfig;
  motionRoleB?: MotionConfig;
  /**
   * 这套配置是从模板库哪一份来的（null/没有 = 直接新建的）。
   * 一起存下来，重开应用后编辑器头上那颗按钮才是「更新「xx」」而不是「保存模板」——
   * 否则用户以为在更新，实际又存出一份重复的。
   */
  templateId?: string | null;
}

function draftKey(mode: VideoMode): string {
  return `baoluo.draft.${mode}`;
}

function loadDraft(mode: VideoMode): ModeDraft | null {
  try {
    const raw = localStorage.getItem(draftKey(mode));
    if (!raw) return null;
    const parsed = JSON.parse(raw) as ModeDraft;
    return parsed && typeof parsed === "object" ? parsed : null;
  } catch {
    /* 解析失败当作没有草稿 */
    return null;
  }
}

type PreviewStatus =
  | { voice: string; state: "loading" | "playing"; message?: string }
  | { voice: string; state: "error"; message: string }
  | null;

interface DialogueViewProps {
  /** 页面模式：由侧边栏子菜单决定，页内不再切换（切换即换页面） */
  mode: VideoMode;
}

export default function DialogueView({ mode }: DialogueViewProps) {
  /** 页面被保活后离开视野的实例仍在运行：进度广播只让当前显示的那份消费 */
  const pageActive = usePageActive();
  /** 删除记录前先问一句（应用内确认框，不用原生 confirm） */
  const [confirmDialog, confirmDelete] = useConfirm();
  const [resolution, setResolution] = useState<VideoResolution>("landscape");
  const [motionMode, setMotionMode] = useState<MotionMode>("zoom-in");
  const [motionAmount, setMotionAmount] = useState(25);
  const [motionRoleA, setMotionRoleA] = useState<MotionConfig>({ mode: "zoom-in", amount: 25 });
  const [motionRoleB, setMotionRoleB] = useState<MotionConfig>({ mode: "zoom-in", amount: 25 });
  const [motionPerImage, setMotionPerImage] = useState(false);
  const [imageMotions, setImageMotions] = useState<MotionConfig[]>([]);
  /** 两人对话：AI 写脚本的主题（跟脚本一起进草稿，切页面不丢） */
  const [topic, setTopic] = useState(() => loadDraft(mode)?.topic ?? "");
  /** 想让成片多长：AI 按这个秒数决定写几行、多少字 */
  const [scriptDuration, setScriptDuration] = useState(() => loadDraft(mode)?.duration ?? 45);
  /** 正在让 AI 写脚本：按钮置灰，别让人连点 */
  const [writing, setWriting] = useState(false);
  const [script, setScript] = useState(
    () => loadDraft(mode)?.script?.trim() || MODE_META[mode].defaultScript
  );
  const [imageFortune, setImageFortune] = useState<string | null>(null);
  const [imageCustomer, setImageCustomer] = useState<string | null>(null);
  const [scenes, setScenes] = useState<DialogueImageScene[]>(() => {
    const draftScenes = loadDraft(mode)?.scenes;
    return draftScenes && draftScenes.length ? draftScenes : [{ path: "", text: "" }];
  });
  /**
   * 图文解说：一镜一个解说员（音色 + 语速/音调/音量），与 scenes 顺序对齐。
   * 只存用户显式改过的项，没改的走 sceneNarrator() 的默认值（跟随设置里的默认解说员）。
   */
  const [sceneNarrators, setSceneNarrators] = useState<Array<SceneNarrator | undefined>>(
    () => loadDraft(mode)?.narrators ?? []
  );
  /** 分镜图片的显示 URL（path → blob/file url），分镜卡片直接用它渲染缩略图 */
  const [sceneUrls, setSceneUrls] = useState<Record<string, string>>({});
  const [settings, setSettings] = useState<DialogueSettings | null>(null);
  const [parsedLines, setParsedLines] = useState<DialogueLine[]>([]);
  const [parseWarnings, setParseWarnings] = useState<string[]>([]);
  const [composing, setComposing] = useState(false);
  /** 生成中显示已用时：合成长任务没有秒表，看着像卡死 */
  const [composingSeconds, setComposingSeconds] = useState(0);
  /** 合成进度：照热点成片的样子保留整个 ComposeProgress（阶段 + 百分比 + 段数） */
  const [progress, setProgress] = useState<ComposeProgress | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [outputDir, setOutputDir] = useState<string>("");
  const [outputPath, setOutputPath] = useState<string | null>(null);
  const [previewUrl, setPreviewUrl] = useState<string>("");
  const [voiceOptions, setVoiceOptions] = useState<typeof VOICE_OPTIONS>(VOICE_OPTIONS);
  const requestIdRef = useRef<string | null>(null);

  // ---- 左侧历史列表（记录） ----
  const [records, setRecords] = useState<WorkRecordSummary[]>([]);
  /**
   * 当前编辑器里的内容对应哪一条记录（null = 还没进列表）。
   * 生成脚本/开始合成时建一条，之后改的都是同一条；点「＋新建」置回 null。
   */
  const [currentRecordId, setCurrentRecordId] = useState<string | null>(null);

  /*
   * 右区显示哪一块：编辑器 / 对话模板库。
   * 模板库挂在左栏标题下面那个入口上（只对话模式有），点了把右区换过去，左栏的列表不动。
   */
  /** 模板管理弹窗开关（改名 / 删除 / 设默认）；原来是独立一页 */
  const [tplMgrOpen, setTplMgrOpen] = useState(false);
  /**
   * 「使用模板」开关（对话模式 / 图文解说共用，存在 AppSettings 里）。
   * 关着 = 界面上没有任何模板按钮，只剩画布 / 分镜本身的配置；
   * 打开后才露出模板入口。只是显隐，不删数据。
   */
  const [tplEnabled, setTplEnabled] = useState(false);
  /** 模板库：一条 = 一份命名好的配置（形象图/音色/运镜/比例） */
  const [templates, setTemplates] = useState<WorkRecordSummary[]>([]);
  /** 「存为新模板」那个输入框里的名字 */
  const [tplName, setTplName] = useState("");
  /** 「自定义模板」命名小窗：点下拉里的「＋ 自定义模板…」时弹出，就地存新模板 */
  const [newTplOpen, setNewTplOpen] = useState(false);
  /**
   * 编辑器当前"基于"哪份模板 = 这条路是从哪开始的：
   *   - 直接「＋新建」→ null → 头上那颗按钮是「保存模板」（存成新的一份）
   *   - 从模板库点「应用」→ 那份模板的 id → 按钮是「更新「xx」」（写回那一份）
   */
  const [appliedTemplateId, setAppliedTemplateId] = useState<string | null>(null);
  /**
   * 默认模板 id：工作台建「对话视频」卡时自动套用它的配置（见 workflows.ts 的 dialogueConfigStep）。
   * 存在 AppSettings 里，这里是它的一份界面副本——切换后立刻反映到「默认」标记上。
   */
  const [defaultTemplateId, setDefaultTemplateId] = useState<string | null>(null);
  /**
   * 内置模板（应用自带）：只能用、不能删不能改。它不在用户模板列表里，
   * 单独渲染在模板库最上面一张卡片。
   */
  const [builtinTpl, setBuiltinTpl] = useState<{
    id: string;
    title: string;
    subtitle: string;
    payload: TemplateConfig;
  } | null>(null);

  /**
   * 模板记录的 kind：对话模板（一套配音/运镜配置）与分镜模板（跟着镜头走）
   * 分开存，列表、应用互不串。逻辑完全同构，差别只在存哪份文件。
   */
  const tplKind: WorkRecordKind =
    mode === "narration" ? "narration-template" : "template";

  const reloadTemplates = useCallback(async () => {
    try {
      const [list, appSet, builtin] = await Promise.all([
        window.records.list(mode === "narration" ? "narration-template" : "template"),
        window.settings.get(),
        // 内置模板只有对话模式有；图文解说拿不到就当没有
        mode === "dialogue"
          ? window.dialogue.builtinTemplate().catch(() => null)
          : Promise.resolve(null),
      ]);
      setTemplates(list);
      setBuiltinTpl(builtin);
      setDefaultTemplateId(appSet.defaultTemplateId ?? null);
    } catch {
      /* 拉不到就空着，不影响编辑 */
    }
  }, [mode]);

  /** 把某份模板设为/取消默认（工作台建对话卡时套用它） */
  async function toggleDefaultTemplate(id: string): Promise<void> {
    setError(null);
    try {
      // 点已默认的那份 = 取消默认，回到"按设置里的默认值来"
      const next = defaultTemplateId === id ? "" : id;
      const r = await window.settings.update({ defaultTemplateId: next });
      setDefaultTemplateId(r.defaultTemplateId ?? null);
    } catch (e: any) {
      setError(e?.message ?? String(e));
    }
  }

  useEffect(() => {
    if (!pageActive) return;
    void reloadTemplates();
  }, [pageActive, reloadTemplates]);

  /**
   * 「使用模板」开关：只切界面显隐。
   * 关掉时顺手把两个模板弹窗收掉，否则弹窗还挂在屏幕上、按钮却没了，关不掉也找不到入口。
   */
  async function toggleTemplates(): Promise<void> {
    const next = !tplEnabled;
    setTplEnabled(next);
    if (!next) {
      setTplMgrOpen(false);
      setNewTplOpen(false);
    }
    try {
      await window.settings.update({ templatesEnabled: next });
    } catch {
      /* 写盘失败就算了：界面已经切过去，下次再点还会写 */
    }
  }

  const reloadRecords = useCallback(async () => {
    try {
      setRecords(await window.records.list(mode));
    } catch {
      /* 列表拉不到不影响编辑器 */
    }
  }, [mode]);

  useEffect(() => {
    if (!pageActive) return;
    void reloadRecords();
  }, [pageActive, reloadRecords]);

  /** 列表主标题：优先用主题，其次用正文开头几个字 */
  function recordTitle(): string {
    if (mode === "dialogue") {
      const t = topic.trim();
      if (t) return t;
      const first = script.split("\n").map((l) => l.trim()).find(Boolean) ?? "";
      return first.slice(0, 18) || "对话模式";
    }
    const first = scenes.map((s) => s.text.trim()).find(Boolean) ?? "";
    return first.slice(0, 18) || "图文解说";
  }

  /** 列表次行：一眼看出这份内容做到哪儿了 */
  function recordSubtitle(): string {
    if (mode === "dialogue") {
      return `${parsedLines.length} 行对话 · ${scriptDuration} 秒`;
    }
    const withImg = scenes.filter((s) => s.path).length;
    return `${withImg}/${scenes.length} 镜有图`;
  }

  /**
   * 把编辑器当前内容存进列表。
   * 第一次调用建一条（记住 id），之后都是更新同一条——所以不会点一次合成多一条。
   *
   * id 可以显式传：同一次操作里要连存两次（先记内容、合成完再补成片路径）时，
   * 第二次不能在闭包里读 currentRecordId——那是上一次渲染的旧值，会多建一条。
   * 返回值就是这条记录的 id。
   */
  async function saveCurrentRecord(
    opts: { outputPath?: string; id?: string } = {}
  ): Promise<string | null> {
    try {
      const saved = await window.records.save({
        id: opts.id ?? currentRecordId ?? undefined,
        kind: mode,
        title: recordTitle(),
        subtitle: recordSubtitle(),
        outputPath: opts.outputPath,
        payload: {
          topic,
          scriptDuration,
          script,
          scenes,
          narrators: sceneNarrators,
          resolution,
          motionMode,
          motionAmount,
          imageFortune,
          imageCustomer,
          motionRoleA,
          motionRoleB,
        } satisfies DialogueRecordPayload,
      });
      setCurrentRecordId(saved.id);
      await reloadRecords();
      return saved.id;
    } catch {
      /* 记录存不上不该打断生成 */
      return null;
    }
  }

  /**
   * 编辑器里有没有"还没进记录"的内容。
   * 有的话，载入别的记录 / 点新建会把它顶掉——先问一句，别让人白写。
   */
  function hasUnsavedEdits(): boolean {
    if (currentRecordId) return false;
    if (script.trim() && script.trim() !== MODE_META[mode].defaultScript.trim()) return true;
    if (topic.trim()) return true;
    return scenes.some((s) => s.path || s.text.trim());
  }

  /** 打开一条记录：把当时的脚本、镜头、音色、运镜全填回来 */
  async function openRecord(id: string): Promise<void> {
    setError(null);
    if (
      id !== currentRecordId &&
      hasUnsavedEdits() &&
      !window.confirm("当前编辑还没进记录，载入这条会替换掉它。继续吗？")
    ) {
      return;
    }
    try {
      const rec = await window.records.get<DialogueRecordPayload>(mode, id);
      if (!rec) {
        await reloadRecords();
        return;
      }
      const p = rec.payload;
      setTopic(p.topic ?? "");
      setScriptDuration(p.scriptDuration ?? 45);
      setScript(p.script ?? "");
      setScenes(p.scenes?.length ? p.scenes : [{ path: "", text: "" }]);
      setSceneNarrators(p.narrators ?? []);
      setResolution(p.resolution ?? "landscape");
      setMotionMode(p.motionMode ?? "zoom-in");
      setMotionAmount(p.motionAmount ?? 25);
      setImageFortune(p.imageFortune ?? null);
      setImageCustomer(p.imageCustomer ?? null);
      setMotionRoleA(p.motionRoleA ?? { mode: "zoom-in", amount: 25 });
      setMotionRoleB(p.motionRoleB ?? { mode: "zoom-in", amount: 25 });
      setCurrentRecordId(rec.id);
      // 这条记录带着自己的配置，跟模板库没关系了 → 来路清掉，按钮回到「保存模板」
      setAppliedTemplateId(null);
      // 模板管理弹窗还开着的话收掉：点记录就是想改它，别被弹窗挡着
      setTplMgrOpen(false);
      // 成片也一起回显：这条记录当时出过片，就直接能看
      setOutputPath(rec.outputPath ?? null);
      setPreviewUrl(rec.outputPath ? await window.media.toUrl(rec.outputPath) : "");
      setProgress(null);
    } catch (e: any) {
      setError(e?.message ?? String(e));
    }
  }

  async function removeRecord(id: string, title: string): Promise<void> {
    if (
      !(await confirmDelete({
        title: `删除记录「${title}」？`,
        detail: "成片文件不会被删除，只是从列表里去掉。",
      }))
    )
      return;
    try {
      await window.records.remove(mode, id);
      if (currentRecordId === id) setCurrentRecordId(null);
    } catch {
      /* 删不掉就让列表刷新出真相 */
    }
    await reloadRecords();
  }

  /** ＋新建：编辑器清成空白的一份，草稿也清掉（否则下次进来又把旧内容恢复出来） */
  function startFresh(): void {
    if (hasUnsavedEdits() && !window.confirm("当前编辑还没进记录，清空就找不回来了。继续吗？")) {
      return;
    }
    setTopic("");
    setScriptDuration(45);
    setScript(MODE_META[mode].defaultScript);
    setScenes([{ path: "", text: "" }]);
    setSceneNarrators([]);
    setImageFortune(null);
    setImageCustomer(null);
    setOutputPath(null);
    setPreviewUrl("");
    setProgress(null);
    setError(null);
    setCurrentRecordId(null);
    /*
     * 来路也要清：新建出来的这份配置跟任何模板都没关系了，
     * 按钮该回到「保存模板」。漏了这句，头上会一直挂着「基于「xx」」，
     * 而且草稿 500ms 后又把这条来路写回去——重载还在（踩过）。
     */
    setAppliedTemplateId(null);
    // 新建就是要编辑：模板管理弹窗若开着，顺手收掉
    setTplMgrOpen(false);
    try {
      localStorage.removeItem(draftKey(mode));
    } catch {
      /* 清不掉就靠上面的 state 覆盖 */
    }
  }

  // ---------------------------------------------------------------------------
  // 对话模板库（这个页面唯一的模板概念）
  //
  // 一套模板 = 一份命名好的配置（形象图 / 音色 / 运镜 / 画面比例）。
  // 新建视频两条路，编辑器头上那颗按钮跟着变：
  //   - 直接「＋新建」→ 没有"当前模板" → 按钮是「保存模板」（存成新的一份）
  //   - 从库里「应用」→ 记住那份 id → 按钮是「更新「xx」」（写回那一份）
  // 没有"默认模板"这种东西：想看别的配置就点应用，页面不会自己换。
  // ---------------------------------------------------------------------------

  /** 模板在列表上的摘要：一眼看出这套配置是什么声音、什么画面 */
  function templateSummary(cfg: TemplateConfig): string {
    // 分镜模板：内容跟着镜头走，镜头数就是它最要紧的信息
    if (mode === "narration") {
      return `${cfg.images?.length ?? 0} 个镜头 · ${
        cfg.resolution === "landscape" ? "横屏" : "竖屏"
      }`;
    }
    const a = cfg.voices?.voiceFortune ?? "";
    const b = cfg.voices?.voiceCustomer ?? "";
    const dir = cfg.resolution === "landscape" ? "横屏" : "竖屏";
    const label = (m?: MotionMode) =>
      MOTION_OPTIONS.find((o) => o.value === (m ?? cfg.motionMode))?.label ?? "";
    return `${a} / ${b} · ${dir} · 运镜 ${label(cfg.motionRoleA?.mode)} / ${label(
      cfg.motionRoleB?.mode
    )}`;
  }

  /** 编辑器里当前的配置，写进某一份模板（模板 id 给了就更新，没给就新建） */
  async function saveTemplateConfig(id: string | undefined, name: string): Promise<string | null> {
    const cfg = collectConfig();
    if (!cfg) return null;
    setError(null);
    try {
      const saved = await window.records.save({
        id,
        kind: tplKind,
        title: name,
        subtitle: templateSummary(cfg),
        payload: cfg,
      });
      await reloadTemplates();
      return saved.id;
    } catch (e: any) {
      setError(e?.message ?? String(e));
      return null;
    }
  }

  /**
   * 当前套用的用户模板（内置模板不在 templates 里，套内置时这里是 undefined →
   * 「更新」按钮置灰，只能「保存」另存一份）。
   */
  const curTpl = templates.find((t) => t.id === appliedTemplateId);

  /** 模板库里起好名字后，存成一份新模板 */
  async function saveAsTemplate(): Promise<void> {
    const name = tplName.trim();
    if (!name) {
      setError("先给模板起个名字。");
      return;
    }
    const id = await saveTemplateConfig(undefined, name);
    if (id) {
      setTplName("");
      setAppliedTemplateId(id);
    }
  }

  /** 下拉里「＋ 自定义模板…」的命名小窗：就地存新模板并应用（不用跳模板库页） */
  async function saveNewTemplate(): Promise<void> {
    const name = tplName.trim();
    if (!name) return;
    const id = await saveTemplateConfig(undefined, name);
    if (id) {
      setTplName("");
      setAppliedTemplateId(id);
      setNewTplOpen(false);
    }
  }

  async function renameTemplate(id: string, name: string): Promise<void> {
    const next = name.trim();
    if (!next) return;
    try {
      const rec = await window.records.get<TemplateConfig>(tplKind, id);
      if (!rec) return;
      await window.records.save({
        id,
        kind: tplKind,
        title: next,
        subtitle: rec.subtitle,
        outputPath: rec.outputPath,
        payload: rec.payload,
      });
      await reloadTemplates();
    } catch (e: any) {
      setError(e?.message ?? String(e));
    }
  }

  /** 套用一份模板到编辑器，并切回编辑界面（套完就是要接着改/开跑） */
  async function applyTemplate(id: string): Promise<void> {
    setError(null);
    // 内置模板不走 records（它不在用户数据里），直接用已加载的配置
    if (builtinTpl && id === builtinTpl.id) {
      applyConfig(builtinTpl.payload);
      setAppliedTemplateId(builtinTpl.id);
      return;
    }
    try {
      const rec = await window.records.get<TemplateConfig>(tplKind, id);
      if (!rec) {
        await reloadTemplates();
        return;
      }
      applyConfig(rec.payload);
      setAppliedTemplateId(rec.id);
    } catch (e: any) {
      setError(e?.message ?? String(e));
    }
  }

  async function removeTemplate(id: string, name: string): Promise<void> {
    if (!window.confirm(`确定删除模板「${name}」吗？`)) return;
    try {
      await window.records.remove(tplKind, id);
      // 删掉的正是当前这份：把标记收掉，别指着一个已经不在的 id
      if (appliedTemplateId === id) setAppliedTemplateId(null);
    } catch {
      /* 删不掉就让列表刷新出真相 */
    }
    await reloadTemplates();
  }
  const previewAudioRef = useRef<HTMLAudioElement | null>(null);
  const previewBusyRef = useRef(false);
  const [previewStatus, setPreviewStatus] = useState<PreviewStatus>(null);
  useEffect(() => {
    (async () => {
      try {
        const s = await window.dialogue.getSettings();
        setSettings(s);
        let od = await window.dialogue.defaultOutputDir();
        let saved: Partial<Record<VideoMode, TemplateConfig>> = {};
        try {
          const app = await window.settings.get();
          if (app.outputDir) od = app.outputDir;
          saved = app.savedTemplates ?? {};
          // 「使用模板」开关：未设置 = 关（默认界面不露模板按钮）
          setTplEnabled(!!app.templatesEnabled);
          const favs = effectiveFavoriteVoices(app.favoriteVoices);
          const clones = (app.cloneVoices ?? []).map((v) => ({
            value: `clone:${v.id}`,
            label: `克隆·${v.name}`,
          }));
          setVoiceOptions(
            [...VOICE_OPTIONS.filter((v) => favs.includes(v.value)), ...clones]
          );
        } catch {
          /* 用默认路径 */
        }
        setOutputDir(od);
        /*
         * 旧版图文解说的「保存模板」只存一份无名默认（savedTemplates.narration）。
         * 模板改成库逻辑后它进不了列表，这里一次性搬成一条命名模板，再把旧字段删掉——
         * 数据不丢，要不要套由用户在模板弹窗里点「应用」。
         * 对话模式本来就不自动套模板，图文解说现在也对齐：上次的配置由草稿恢复（见下面的 loadDraft）。
         */
        if (mode === "narration" && saved.narration) {
          try {
            await window.records.save({
              kind: "narration-template",
              title: "原默认分镜",
              subtitle: `${saved.narration.images?.length ?? 0} 个镜头`,
              payload: saved.narration,
            });
            const next = { ...saved };
            delete next.narration;
            await window.settings.update({ savedTemplates: next });
          } catch {
            /* 搬不动就留在原地，不影响使用 */
          }
        }
        // 草稿是本页面最后在写的内容，比模板里存的旧内容更新，优先恢复
        const draft = loadDraft(mode);
        if (draft?.scenes?.length) setScenes(draft.scenes);
        if (draft?.narrators?.length) setSceneNarrators(draft.narrators);
        if (draft?.script?.trim()) setScript(draft.script);
        if (draft?.topic) setTopic(draft.topic);
        if (draft?.duration) setScriptDuration(draft.duration);
        // 形象图与运镜/比例也一起回来：它们不在记录里，光靠草稿的脚本字段会丢
        if (draft?.imageFortune !== undefined) setImageFortune(draft.imageFortune);
        if (draft?.imageCustomer !== undefined) setImageCustomer(draft.imageCustomer);
        if (draft?.resolution) setResolution(draft.resolution);
        if (draft?.motionRoleA) setMotionRoleA(draft.motionRoleA);
        if (draft?.motionRoleB) setMotionRoleB(draft.motionRoleB);
        // 这套配置当初是从哪份模板来的：按钮靠它决定"更新"还是"另存"
        if (draft?.templateId) setAppliedTemplateId(draft.templateId);
      } catch {
        /* ignore */
      }
    })();
  }, []);

  /**
   * 合成进度是全应用广播的，图文解说 / 对话模式 / 热点成片都能收到。
   * 页面保活之后别的页面的任务也会广播到这里，所以只有当前显示的这份才消费，
   * 否则隐藏页面会跟着显示别人任务的进度、甚至把别人的报错挂在自己身上。
   */
  useEffect(() => {
    if (!pageActive) return;
    const off = window.dialogue.onComposeProgress((p) => {
      setProgress(p);
      if (p.error) setError(p.error);
    });
    return () => {
      off();
    };
  }, [pageActive]);

  /** 生成中走一个秒表：合成长任务只写「生成中…」的话，看着像卡住了 */
  useEffect(() => {
    if (!composing) {
      setComposingSeconds(0);
      return;
    }
    const t0 = Date.now();
    const timer = window.setInterval(
      () => setComposingSeconds(Math.round((Date.now() - t0) / 1000)),
      1000
    );
    return () => window.clearInterval(timer);
  }, [composing]);

  /**
   * 图文解说的解说词按镜头存放，这里拼成解析器认识的「#图N」脚本，
   * 这样双解说员、长句拆字幕、按图运镜等既有能力都不用改主进程。
   */
  const narrationScript = scenes
    .map((s, i) => `#图${i + 1}\n${s.text.trim()}`)
    .join("\n\n");
  /** 解析/生成真正用的脚本：对话页用 textarea，图文解说页用分镜拼出来的文本 */
  const effectiveScript = mode === "narration" ? narrationScript : script;

  // 草稿落盘（防抖 500ms，和下面的解析节奏一致）：切页面/重开都还在
  useEffect(() => {
    const t = setTimeout(() => {
      try {
        const payload: ModeDraft =
          mode === "narration"
            ? { scenes, narrators: sceneNarrators, templateId: appliedTemplateId }
            : {
                script,
                topic,
                duration: scriptDuration,
                imageFortune,
                imageCustomer,
                resolution,
                motionRoleA,
                motionRoleB,
                templateId: appliedTemplateId,
              };
        localStorage.setItem(draftKey(mode), JSON.stringify(payload));
      } catch {
        /* 隐私模式等场景写不了，忽略 */
      }
    }, 500);
    return () => clearTimeout(t);
  }, [
    script,
    topic,
    scriptDuration,
    scenes,
    sceneNarrators,
    mode,
    imageFortune,
    imageCustomer,
    resolution,
    motionRoleA,
    motionRoleB,
    appliedTemplateId,
  ]);

  // 实时解析（两种模式都用统一解析器）
  useEffect(() => {
    const t = setTimeout(async () => {
      try {
        const r = await window.dialogue.parse(effectiveScript, {
          mode,
          imageCount: scenes.length,
        });
        setParsedLines(r.lines);
        setParseWarnings(r.warnings);
      } catch {
        /* ignore */
      }
    }, 400);
    return () => clearTimeout(t);
  }, [effectiveScript, mode, scenes.length]);

  // 分镜图片路径 → 可显示的 URL（路径签名变化时才重算，避免死循环）
  const scenePathSig = scenes.map((s) => s.path).join("|");
  useEffect(() => {
    let alive = true;
    (async () => {
      const next: Record<string, string> = {};
      for (const s of scenes) {
        if (!s.path) continue;
        try {
          next[s.path] = await window.media.toUrl(s.path);
        } catch {
          /* 读不到的图先不显示，等用户重新选 */
        }
      }
      if (alive) setSceneUrls(next);
    })();
    return () => {
      alive = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [scenePathSig]);

  // 图片数量变化时，保持「按图运镜」数组与图片列表对齐
  useEffect(() => {
    setImageMotions((prev) => {
      if (prev.length === scenes.length) return prev;
      return scenes.map((_, i) => prev[i] ?? { mode: motionMode, amount: motionAmount });
    });
  }, [scenes.length]); // eslint-disable-line react-hooks/exhaustive-deps

  async function pickImage(who: "fortune" | "customer") {
    setError(null);
    try {
      const cur = who === "fortune" ? imageFortune : imageCustomer;
      const p = await window.dialogue.chooseImage(cur ?? null);
      if (p) {
        if (who === "fortune") setImageFortune(p);
        else setImageCustomer(p);
      }
    } catch (e: any) {
      setError(e?.message ?? String(e));
    }
  }

  async function pickSceneImage(index: number) {
    setError(null);
    try {
      const cur = scenes[index]?.path ?? null;
      const p = await window.dialogue.chooseImage(cur ?? null);
      if (p) updateScene(index, { path: p });
    } catch (e: any) {
      setError(e?.message ?? String(e));
    }
  }

  function updateScene(index: number, patch: Partial<DialogueImageScene>) {
    setScenes((prev) => prev.map((s, i) => (i === index ? { ...s, ...patch } : s)));
  }

  function addScene() {
    setScenes((prev) => [...prev, { path: "", text: "" }]);
  }

  function removeScene(index: number) {
    if (scenes.length <= 1) return;
    // 运镜/解说员都是按镜头序号对齐的，删镜头时一起删，否则后面的镜头会串配置
    setScenes((prev) => prev.filter((_, i) => i !== index));
    setImageMotions((prev) => prev.filter((_, i) => i !== index));
    setSceneNarrators((prev) => prev.filter((_, i) => i !== index));
  }

  function moveScene(index: number, dir: -1 | 1) {
    const j = index + dir;
    if (j < 0 || j >= scenes.length) return;
    const swap = <T,>(prev: T[]): T[] => {
      const next = [...prev];
      [next[index], next[j]] = [next[j], next[index]];
      return next;
    };
    setScenes(swap);
    setImageMotions(swap);
    setSceneNarrators(swap);
  }

  /** 这一镜的解说员：用户改过就用改过的，没改过跟随设置里的默认解说员音色 */
  function sceneNarrator(index: number): SceneNarrator {
    const own = sceneNarrators[index];
    if (own?.voice) return own;
    return {
      voice: own?.voice || settings?.voiceNarrator || settings?.voiceFortune || "",
      prosody: own?.prosody ?? settings?.prosody.narrator ?? { rate: 0, pitch: 0, volume: 0 },
    };
  }

  function updateSceneNarrator(index: number, patch: Partial<SceneNarrator>) {
    setSceneNarrators((prev) => {
      const next = [...prev];
      while (next.length < scenes.length) next.push(undefined);
      next[index] = { ...sceneNarrator(index), ...patch };
      return next;
    });
  }

  /** 把图片直接拖到分镜的图框里（与热点成片一致的操作习惯） */
  function onDropSceneImage(e: DragEvent<HTMLDivElement>, index: number) {
    e.preventDefault();
    const file = e.dataTransfer?.files?.[0];
    if (!file) return;
    const p = window.media.filePath(file);
    if (p) updateScene(index, { path: p });
  }

  /** 单镜运镜：图文解说的运镜按镜头逐条设置（对应 imageMotions[index]） */
  function setSceneMotion(index: number, motion: MotionConfig) {
    setImageMotions((prev) => {
      const base =
        prev.length >= scenes.length
          ? prev
          : scenes.map((_, j) => prev[j] ?? { mode: motionMode, amount: motionAmount });
      const next = [...base];
      next[index] = motion;
      return next;
    });
  }

  /** 分镜里这一镜的运镜配置（没设过就跟随默认值） */
  function sceneMotion(index: number): MotionConfig {
    return imageMotions[index] ?? { mode: motionMode, amount: motionAmount };
  }

  async function handleVoiceChange(
    field: "voiceFortune" | "voiceCustomer" | "voiceNarrator",
    value: string
  ) {
    if (!settings) return;
    const next = { ...settings, [field]: value };
    setSettings(next);
    try {
      const r = await window.dialogue.saveSettings(next);
      setSettings(r);
    } catch (e: any) {
      setError(e?.message ?? String(e));
    }
  }

  async function handleProsodyChange(
    role: "a" | "b" | "narrator",
    key: "rate" | "pitch" | "volume",
    value: number
  ) {
    if (!settings) return;
    const next = {
      ...settings,
      prosody: {
        ...settings.prosody,
        [role]: { ...settings.prosody[role], [key]: value },
      },
    };
    setSettings(next);
    try {
      const r = await window.dialogue.saveSettings(next);
      setSettings(r);
    } catch (e: any) {
      setError(e?.message ?? String(e));
    }
  }

  /** 收集当前左侧配置为一份模板配置 */
  function collectConfig(): TemplateConfig | null {
    if (!settings) {
      setError("设置尚未加载，请稍后重试。");
      return null;
    }
    return {
      imageFortune,
      imageCustomer,
      // 图文解说的解说词跟着镜头走，模板里也要一起存（否则换台机器/清草稿就只剩图）
      images: scenes.map(({ path, text, audioMode, audioPath }) => ({ path, text, audioMode, audioPath })),
      // 一镜一个解说员：模板里存的是每个镜头实际生效的音色/语速
      imageNarrators: scenes.map((_, i) => sceneNarrator(i)),
      narratorCount: settings.narratorCount ?? 2,
      resolution,
      // 图片适配不再提供开关：与热点成片一致，固定铺满画布
      imageFit: "cover",
      motionMode,
      motionAmount,
      motionRoleA,
      motionRoleB,
      motionPerImage,
      imageMotions,
      voices: {
        voiceFortune: settings.voiceFortune,
        voiceCustomer: settings.voiceCustomer,
        voiceNarrator: settings.voiceNarrator,
        prosody: settings.prosody,
      },
    };
  }

  /** 把一份模板配置应用到当前界面 */
  function applyConfig(cfg: TemplateConfig, voicesSettings?: DialogueSettings) {
    setImageFortune(cfg.imageFortune);
    setImageCustomer(cfg.imageCustomer);
    setScenes(cfg.images && cfg.images.length ? cfg.images : [{ path: "", text: "" }]);
    setSceneNarrators(cfg.imageNarrators ?? []);
    setResolution(cfg.resolution);
    setMotionMode(cfg.motionMode);
    setMotionAmount(cfg.motionAmount);
    setMotionRoleA(cfg.motionRoleA);
    setMotionRoleB(cfg.motionRoleB);
    setMotionPerImage(cfg.motionPerImage);
    setImageMotions(cfg.imageMotions ?? []);
    const base = voicesSettings ?? settings;
    if (cfg.voices && base) {
      const next = {
        ...base,
        ...cfg.voices,
        narratorCount: cfg.narratorCount ?? base.narratorCount ?? 2,
      };
      setSettings(next);
      window.dialogue
        .saveSettings(next)
        .then(setSettings)
        .catch(() => {
          /* 音色恢复失败不阻塞 */
        });
    }
    setOutputPath(null);
    setPreviewUrl("");
    setError(null);
  }

  /** 重置：删掉这个页面的默认模板配置（以及草稿），恢复默认 */  async function clearTemplate(kind: VideoMode) {
    if (
      !(await confirmDelete({
        title: `重置「${kind === "dialogue" ? "对话模式" : "图文解说"}」？`,
        detail: "将删除已保存的模板配置并清空当前内容，恢复默认。",
        confirmLabel: "重置",
      }))
    )
      return;
    setError(null);
    try {
      const cur = await window.settings.get();
      const next = { ...cur.savedTemplates };
      delete next[kind];
      await window.settings.update({ savedTemplates: next });
      // 草稿也一起清掉，否则下次进页面又把重置前的内容恢复出来
      try {
        localStorage.removeItem(draftKey(kind));
      } catch {
        /* noop */
      }
      /* 清掉界面上的内容，让它回到「没配过 / 空分镜」的样子（「画面方向」挂在合成栏里，跟模板配置无关，不清） */
      if (kind === "dialogue") {
        setImageFortune(null);
        setImageCustomer(null);
        setScript(MODE_META.dialogue.defaultScript);
        setTopic("");
        setMotionMode("zoom-in");
        setMotionAmount(25);
        setMotionRoleA({ mode: "zoom-in", amount: 25 });
        setMotionRoleB({ mode: "zoom-in", amount: 25 });
        setMotionPerImage(false);
        setImageMotions([]);
      } else {
        /*
         * 图文解说：镜头列表也清回一张空镜头。以前故意留着用户内容（「重置后接着改」），
         * 但按钮叫「重置」却什么都不变，看起来就是坏了——恢复默认才是它的意思。
         * 解说员设置（音色/语速）跟着镜头一起清，下次从头配。
         */
        setScenes([{ path: "", text: "" }]);
        setSceneNarrators([]);
        // 重置后的空分镜不再对应任何模板：来路清掉，按钮回到「保存为模板」
        setAppliedTemplateId(null);
      }
      setOutputPath(null);
      setPreviewUrl("");
    } catch (e: any) {
      setError(e?.message ?? String(e));
    }
  }

  /** 用设置里的默认输出路径打开资源管理器 */
  async function openOutputDir() {
    setError(null);
    try {
      const app = await window.settings.get();
      setOutputDir(app.outputDir || (await window.dialogue.defaultOutputDir()));
      const r = await window.dialogue.openOutputDir();
      if (!r.ok) setError(r.error ? `打开输出目录失败：${r.error}` : "打开输出目录失败。");
    } catch (e: any) {
      setError(e?.message ?? String(e));
    }
  }

  /**
   * 两人对话：按主题让 AI 写一段脚本，写完直接填进下面的脚本框。
   */
  async function writeScriptWithAi() {
    if (writing) return;
    setError(null);
    const t = topic.trim();
    if (!t) {
      setError("先写个主题，AI 才知道要聊什么。");
      return;
    }
    setWriting(true);
    try {
      const text = await window.dialogue.writeScript({
        topic: t,
        durationSeconds: scriptDuration,
      });
      setScript(text);
      /*
       * 脚本一写出来就进列表（此后合成会往同一条上补成片路径）。
       * 这里用的是刚拿到的 text，不能指望 setScript 之后的 state 已经更新。
       */
      await window.records
        .save({
          id: currentRecordId ?? undefined,
          kind: mode,
          title: t,
          subtitle: `${scriptDuration} 秒`,
          payload: {
            topic: t,
            scriptDuration,
            script: text,
            scenes,
            narrators: sceneNarrators,
            resolution,
            motionMode,
            motionAmount,
            imageFortune,
            imageCustomer,
            motionRoleA,
            motionRoleB,
          } satisfies DialogueRecordPayload,
        })
        .then((saved) => setCurrentRecordId(saved.id))
        .catch(() => {
          /* 记录存不上不该影响写脚本 */
        });
      void reloadRecords();
    } catch (e: any) {
      setError(e?.message ?? String(e));
    } finally {
      setWriting(false);
    }
  }

  /** 在资源管理器中定位刚生成的文件 */
  async function showInFolder(filePath: string) {
    setError(null);
    try {
      const r = await window.dialogue.showInFolder(filePath);
      if (!r.ok) setError(r.error ?? "定位文件失败。");
    } catch (e: any) {
      setError(e?.message ?? String(e));
    }
  }

  async function generateVideo() {
    if (!settings) return;
    setError(null);
    const validScenes = scenes.filter((s) => s.path);
    if (mode === "dialogue") {
      if (!imageFortune || !imageCustomer) {
        setError("请先选择两张图片。");
        return;
      }
      if (!parsedLines.length) {
        setError("脚本为空或未识别到对话。");
        return;
      }
    } else {
      // 分镜模式：解说词存在每个镜头里，缺图/缺词都会让画面和配音对不上，先拦住
      const noImage = scenes.filter((s) => !s.path).length;
      const noText = scenes.filter((s) => !s.text.trim()).length;
      if (!validScenes.length) {
        setError("请先给第一个镜头上传图片。");
        return;
      }
      if (noImage) {
        setError(`还有 ${noImage} 个镜头没放图，先补齐再生成。`);
        return;
      }
      if (noText) {
        setError(`还有 ${noText} 个镜头没写解说词，先补齐再生成。`);
        return;
      }
    }

    setComposing(true);
    setOutputPath(null);
    setPreviewUrl("");
    setProgress({ stage: "parse", percent: 0, message: "准备合成..." });
    /*
     * 先把这份内容记进列表再开跑：跑挂了也还在（列表上标成"没成片"），
     * 接着改一改再跑一版，而不是白跑一次什么都留不下。
     * 图文解说没有"AI 写脚本"那一步，这里就是它建记录的时点——
     * 能走到这里说明每个镜头图和词都齐了（上面刚校验过）。
     */
    const recId = await saveCurrentRecord();
    try {
      // 输出路径以设置里的默认值为准，实时读取
      const app = await window.settings.get();
      const outDir = app.outputDir || (await window.dialogue.defaultOutputDir());
      setOutputDir(outDir);
      const reqId = String(Date.now());
      requestIdRef.current = reqId;
      const res = await window.dialogue.runCompose({
        name: mode === "dialogue" ? "对话模式" : "图文解说",
        mode,
        resolution,
        // 与热点成片一致：图片一律铺满画布（超出裁掉），不留黑边
        imageFit: "cover",
        motionMode,
        motionAmount,
        // 图文解说按镜头逐条设置运镜，所以始终带 imageMotions
        imageMotions: mode === "narration" ? scenes.map((_, i) => sceneMotion(i)) : undefined,
        // 一镜一个解说员，逐镜传下去（主进程按 sceneId 取用）
        imageNarrators:
          mode === "narration" ? scenes.map((_, i) => sceneNarrator(i)) : undefined,
        motionA: mode === "dialogue" ? motionRoleA : undefined,
        motionB: mode === "dialogue" ? motionRoleB : undefined,
        script: effectiveScript,
        imageFortune: imageFortune ?? "",
        imageCustomer: imageCustomer ?? "",
        images: mode === "narration" ? scenes : undefined,
        outputDir: outDir,
        voiceFortune: settings.voiceFortune,
        voiceCustomer: settings.voiceCustomer,
        voiceNarrator: settings.voiceNarrator,
        narratorCount: settings.narratorCount ?? 2,
        prosody: settings.prosody,
        subtitle: settings.subtitle,
        requestId: reqId,
      });
      setOutputPath(res.outputPath);
      const url = await window.media.toUrl(res.outputPath);
      setPreviewUrl(url);
      setProgress({ stage: "done", percent: 100, message: "完成！" });
      // 成片路径补到同一条记录上：列表里立刻显示「已成片」
      await saveCurrentRecord({ outputPath: res.outputPath, id: recId ?? undefined });
    } catch (e: any) {
      const msg = e?.message ?? String(e);
      if (String(msg).includes("已取消")) {
        // 用户主动取消：不弹红色错误框
        setError(null);
        setProgress(null);
      } else {
        setError(msg);
        setProgress({ stage: "error", percent: 0 });
      }
    } finally {
      requestIdRef.current = null;
      setComposing(false);
    }
  }

  function cancelGenerate() {
    if (requestIdRef.current) {
      window.dialogue.cancelCompose(requestIdRef.current);
    }
  }

  /** 试听：用当前语速/音调/音量合成一句并播放；不传 text 时读默认示例句 */
  function previewVoice(voice: string, prosody: VoiceProsody, text?: string) {
    if (!voice || previewBusyRef.current) return;
    previewBusyRef.current = true;
    setPreviewStatus({ voice, state: "loading" });
    // 先停掉上一次的试听，避免多条声音重叠
    const prev = previewAudioRef.current;
    if (prev) {
      prev.pause();
      prev.currentTime = 0;
      prev.onended = null;
      prev.onerror = null;
    }
    window.dialogue
      .previewVoice({
        voice,
        rate: prosody.rate,
        pitch: prosody.pitch,
        volume: prosody.volume,
        text,
      })
      .then((r) => window.media.toUrl(r.path))
      .then((url) => {
        const audio = previewAudioRef.current ?? new Audio();
        previewAudioRef.current = audio;
        audio.src = url;
        audio.onended = () =>
          setPreviewStatus((s) => (s?.voice === voice ? null : s));
        audio.onerror = () =>
          setPreviewStatus((s) => (s?.voice === voice ? null : s));
        audio.play();
        setPreviewStatus({ voice, state: "playing" });
      })
      .catch((e) => {
        const friendly = ttsErrorText(e);
        setPreviewStatus({ voice, state: "error", message: friendly });
        window.alert(friendly);
      })
      .finally(() => {
        previewBusyRef.current = false;
      });
  }

  const canGenerate = !composing && (() => {
    if (mode === "narration") {
      // 每个镜头都得有图有词，生成按钮才亮
      return scenes.every((s) => s.path && s.text.trim());
    }
    if (mode === "dialogue") return !!imageFortune && !!imageCustomer && parsedLines.length > 0;
    return false;
  })();

  /** 音色下拉：按设置勾选过滤；当前已选音色即使未勾选也保留显示 */
  function optionsFor(value: string) {
    if (!value) return voiceOptions;
    return voiceOptions.some((o) => o.value === value)
      ? voiceOptions
      : [...voiceOptions, { value, label: value }];
  }

  return (
    /* 左栏是记录列表（用户要求挪回左边），右区是编辑器，全宽铺开 */
    <div className="view dialogue-view">
      <SideList
        section="记录"
        action={
          <ListAddButton
            onClick={startFresh}
            title="清空编辑器，从头做一份新的（不动已有记录）"
          />
        }
        hasItems={records.length > 0}
        items={records.map((r) => (
          <SideRow
            key={r.id}
            title={r.title}
            active={r.id === currentRecordId}
            meta={<span>{r.subtitle}</span>}
            done={!!r.outputPath}
            time={formatListTime(r.updatedAt)}
            onOpen={() => void openRecord(r.id)}
            onDelete={() => void removeRecord(r.id, r.title)}
            deleteLabel={`删除记录 ${r.title}`}
          />
        ))}
        empty={
          mode === "dialogue"
            ? "还没有记录。在右边写好主题点「AI 写脚本」，这条就会进列表。"
            : "还没有记录。在右边给每个镜头放上图、写好解说词，点合成就会进列表。"
        }
      >
      {/* 页名放编辑区顶部；记录列表在左栏 */}
      <h2 className="work-title">{MODE_META[mode].title}</h2>
        <div className="template-layout">
        {/* 模板配置 + 生成（原左侧模板菜单已上移到侧边栏「视频生成」的子菜单） */}
        <div className="template-content">
          {/*
            模板配置只服务「对话模式」：那里的角色卡（形象图 / 音色 / 语速 / 运镜）没别处可设。
            图文解说页不再有这块：画面方向挪到了「合成视频」，保存/重置挪到了分镜右上角。
          */}
          {mode === "dialogue" && (
            <div className="card-pad flat-panel">
              <div className="collapse-header">
                {/* 标题带上当前模板名：套了模板显示「画布（xx）」，没套就只是「画布」（内置模板也算） */}
                <span className="panel-title">
                  🎨 画布
                  {tplEnabled &&
                    (appliedTemplateId === builtinTpl?.id
                      ? `（${builtinTpl.title}）`
                      : curTpl
                        ? `（${curTpl.title}）`
                        : "")}
                </span>
                {/* 管理/保存/更新/重置跟在标题右边 */}
                <span className="collapse-header-actions">
                  {/* 开关：关掉后下面三颗模板按钮全部不渲染，只留画布本身 */}
                  <span className="tpl-toggle">
                    <span className="tpl-toggle-label">使用模板</span>
                    <button
                      type="button"
                      className={`plugin-switch is-sm${tplEnabled ? " on" : ""}`}
                      role="switch"
                      aria-checked={tplEnabled}
                      aria-label="使用模板"
                      title={
                        tplEnabled
                          ? "关掉后隐藏所有模板按钮（已保存的模板不会删）"
                          : "打开后显示模板按钮：应用 / 保存 / 更新"
                      }
                      onClick={(e) => {
                        e.stopPropagation();
                        void toggleTemplates();
                      }}
                    >
                      <span className="plugin-switch-knob" />
                    </button>
                  </span>
                  {tplEnabled && (
                    <>
                      {/* 模板入口就这一颗：应用 / 新建 / 改名 / 删除 / 设默认都在弹窗里 */}
                      <button
                        type="button"
                        className="secondary small secondary-plain"
                        onClick={(e) => {
                          e.stopPropagation();
                          setTplMgrOpen(true);
                        }}
                        title="应用 / 新建 / 改名 / 删除 / 设默认"
                      >
                        模板
                      </button>
                      {/*
                        保存/更新二选一显示：
                        - 套了自己的模板 → 只显示「更新模板」（写回那一份）；
                        - 没套模板（或套的是内置模板，内置改不了）→ 只显示「保存为模板」。
                      */}
                      {curTpl ? (
                        <button
                          type="button"
                          className="secondary small secondary-plain"
                          onClick={(e) => {
                            e.stopPropagation();
                            void saveTemplateConfig(curTpl.id, curTpl.title);
                          }}
                          title={`把当前的配音与运镜配置写回「${curTpl.title}」`}
                        >
                          更新模板
                        </button>
                      ) : (
                        <button
                          type="button"
                          className="secondary small secondary-plain"
                          onClick={(e) => {
                            e.stopPropagation();
                            setTplName((n) => n || topic.trim() || "");
                            setNewTplOpen(true);
                          }}
                          title="把当前的配音与运镜配置存成一份新模板"
                        >
                          保存为模板
                        </button>
                      )}
                    </>
                  )}
                  <button
                    type="button"
                    className="danger small danger-plain"
                    onClick={(e) => {
                      e.stopPropagation();
                      void clearTemplate(mode);
                    }}
                  >
                    重置
                  </button>
                </span>
              </div>

              <div className="template-config">
                    <RoleCard
                      label="甲方"
                    image={imageFortune}
                    onPickImage={() => pickImage("fortune")}
                    onClearImage={() => setImageFortune(null)}
                    voice={settings?.voiceFortune ?? ""}
                    options={optionsFor(settings?.voiceFortune ?? "")}
                    prosody={settings?.prosody.a ?? { rate: 0, pitch: 0, volume: 0 }}
                    onVoice={(v) => handleVoiceChange("voiceFortune", v)}
                    onProsody={(k, v) => handleProsodyChange("a", k, v)}
                    motion={motionRoleA}
                    onMotion={setMotionRoleA}
                    onPreview={() =>
                      previewVoice(
                        settings?.voiceFortune ?? "",
                        settings?.prosody.a ?? { rate: 0, pitch: 0, volume: 0 }
                      )
                    }
                    previewStatus={previewStatus}
                  />
                  <RoleCard
                    label="乙方"
                    image={imageCustomer}
                    onPickImage={() => pickImage("customer")}
                    onClearImage={() => setImageCustomer(null)}
                    voice={settings?.voiceCustomer ?? ""}
                    options={optionsFor(settings?.voiceCustomer ?? "")}
                    prosody={settings?.prosody.b ?? { rate: 0, pitch: 0, volume: 0 }}
                    onVoice={(v) => handleVoiceChange("voiceCustomer", v)}
                    onProsody={(k, v) => handleProsodyChange("b", k, v)}
                    motion={motionRoleB}
                    onMotion={setMotionRoleB}
                    onPreview={() =>
                      previewVoice(
                        settings?.voiceCustomer ?? "",
                        settings?.prosody.b ?? { rate: 0, pitch: 0, volume: 0 }
                      )
                    }
                    previewStatus={previewStatus}
                  />
                  </div>
                  {/*
                    画面方向也是"这条片子的设定"（跟形象图、音色、运镜一样），
                    所以归到模板配置里，模板也跟着一起存它（collectConfig 里有 resolution）。
                  */}
                  <div className="template-canvas-row">
                    <span className="story-field-label">画面方向</span>
                    <div className="story-direction-pick">
                      <BeeSelect
                        value={resolution}
                        options={[
                          { value: "landscape", label: "横版 16:9" },
                          { value: "portrait", label: "竖版 9:16" },
                        ]}
                        onChange={(v) => setResolution(v as VideoResolution)}
                        title="成片画布方向：AI 画面提示词与最终成片都按它生成"
                      />
                    </div>
              </div>
            </div>
          )}

          {mode === "narration" ? (
            /* 图文解说：分镜模式（与热点成片一致）——一个镜头一张图 + 一段解说词。
               flat-panel：右区去卡片化（同工作台那套），段落靠分隔线划分 */
            <div className="card-pad flat-panel">
              <div className="panel-title-row">
                <span className="panel-title">
                  🎬 分镜
                  {/* 套了模板带上名字（内置模板只有对话模式有，这里不用管） */}
                  {tplEnabled && curTpl ? `（${curTpl.title}）` : ""}
                </span>
                {/* 保存/重置挪到分镜右上角：图文解说页不再有「模板配置」，这两颗按钮得有地方待 */}
                <span className="panel-title-actions">
                  {/* 与对话模式共用同一个「使用模板」开关：关掉就只剩分镜本身 */}
                  <span className="tpl-toggle">
                    <span className="tpl-toggle-label">使用模板</span>
                    <button
                      type="button"
                      className={`plugin-switch is-sm${tplEnabled ? " on" : ""}`}
                      role="switch"
                      aria-checked={tplEnabled}
                      aria-label="使用模板"
                      title={
                        tplEnabled
                          ? "关掉后隐藏模板按钮（已保存的模板不会删）"
                          : "打开后显示模板按钮：应用 / 保存 / 更新"
                      }
                      onClick={() => void toggleTemplates()}
                    >
                      <span className="plugin-switch-knob" />
                    </button>
                  </span>
                  {tplEnabled && (
                    <>
                      {/* 模板入口就这一颗：应用 / 新建 / 改名 / 删除都在弹窗里 */}
                      <button
                        type="button"
                        className="secondary small secondary-plain"
                        onClick={() => setTplMgrOpen(true)}
                        title="应用 / 新建 / 改名 / 删除"
                      >
                        模板
                      </button>
                      {/*
                        保存/更新二选一显示（与对话模式同一套逻辑）：
                        - 套了自己的模板 → 只显示「更新模板」（写回那一份）；
                        - 没套模板 → 只显示「保存为模板」。
                      */}
                      {curTpl ? (
                        <button
                          type="button"
                          className="secondary small secondary-plain"
                          onClick={() => void saveTemplateConfig(curTpl.id, curTpl.title)}
                          title={`把当前的镜头与解说员配置写回「${curTpl.title}」`}
                        >
                          更新模板
                        </button>
                      ) : (
                        <button
                          type="button"
                          className="secondary small secondary-plain"
                          onClick={() => setNewTplOpen(true)}
                          title="把这批镜头（图 + 解说词 + 解说员）存成一份模板"
                        >
                          保存为模板
                        </button>
                      )}
                    </>
                  )}
                  <button
                    type="button"
                    className="danger small danger-plain"
                    onClick={() => void clearTemplate("narration")}
                  >
                    重置
                  </button>
                </span>
              </div>

              <div className="hint">
                一个镜头 = 一张图 + 一段解说词 + 一个解说员（音色/语速在镜头卡片里设），
                成片按这里的顺序播；换行即分条字幕，想在两段用两个音色就分成两个镜头。
              </div>

              <div className="shot-list">
                {scenes.map((sc, i) => (
                  <div className={`shot-card ${sc.path ? "ready" : ""}`} key={i}>
                    <div className="shot-head">
                      <span className="shot-index">镜头 {i + 1}</span>
                      <span className={`shot-state ${sc.path ? "ok" : ""}`}>
                        {sc.path ? "图已就绪" : "待放图"}
                      </span>
                      <div className="shot-head-actions">
                        <button
                          type="button"
                          className="secondary small secondary-plain"
                          disabled={i === 0}
                          onClick={() => moveScene(i, -1)}
                          title="上移"
                        >
                          ↑
                        </button>
                        <button
                          type="button"
                          className="secondary small secondary-plain"
                          disabled={i === scenes.length - 1}
                          onClick={() => moveScene(i, 1)}
                          title="下移"
                        >
                          ↓
                        </button>
                        <button
                          type="button"
                          className="danger small"
                          disabled={scenes.length <= 1}
                          onClick={() => removeScene(i)}
                          title="删除镜头"
                        >
                          删除
                        </button>
                      </div>
                    </div>

                    <div className="shot-body">
                      <div className="shot-image-col">
                        <div
                          className={`shot-image-slot ${sc.path ? "filled" : ""}`}
                          onClick={() => void pickSceneImage(i)}
                          onDrop={(e) => onDropSceneImage(e, i)}
                          onDragOver={(e) => e.preventDefault()}
                          title="点击选择图片，或直接把图片拖进来"
                        >
                          {sc.path && sceneUrls[sc.path] ? (
                            <img src={sceneUrls[sc.path]} alt={`镜头 ${i + 1}`} />
                          ) : (
                            <div className="shot-image-empty">
                              <span className="shot-image-plus">＋</span>
                              <span>把图片拖到这里</span>
                              <span className="shot-image-sub">或点击选择图片</span>
                            </div>
                          )}
                        </div>
                        {/* 清除图片贴着图框放：动作就在它作用的东西旁边。
                            没图时禁用而不是隐藏——按钮占位不变，放图/清图时画面不晃 */}
                        <button
                          type="button"
                          className="shot-image-clear"
                          disabled={!sc.path}
                          onClick={() => updateScene(i, { path: "" })}
                          title={sc.path ? "清掉这一镜的图片，保留解说词" : "放了图片才能清除"}
                        >
                          清除图片
                        </button>
                      </div>

                      <div className="shot-text-col">
                        <div className="shot-field">
                          <div className="shot-field-head">
                            <span className="story-field-label">解说词 / 字幕</span>
                            {/* 这一镜的声音来源：录音用真人、合成用音色。选哪个就只摆哪一行 */}
                            <div className="shot-audio-mode" role="radiogroup" aria-label="声音模式">
                              <button
                                type="button"
                                role="radio"
                                aria-checked={sc.audioMode === "record"}
                                className={`shot-audio-mode-btn${sc.audioMode === "record" ? " active" : ""}`}
                                onClick={() => updateScene(i, { audioMode: "record" })}
                                title="录一段真人解说，合成用这段声音"
                              >
                                🎙 录音模式
                              </button>
                              <button
                                type="button"
                                role="radio"
                                aria-checked={sc.audioMode !== "record"}
                                className={`shot-audio-mode-btn${sc.audioMode !== "record" ? " active" : ""}`}
                                onClick={() => updateScene(i, { audioMode: "tts" })}
                                title="用音色（在线 / 克隆）合成这一镜的声音"
                              >
                                语音合成
                              </button>
                            </div>
                          </div>
                          <textarea
                            rows={5}
                            value={sc.text}
                            placeholder={"这一镜要念的解说词\n换行就是分条字幕"}
                            onChange={(e) => updateScene(i, { text: e.target.value })}
                          />
                        </div>

                        {sc.audioMode === "record" ? (
                          /* 录音模式：摆录音条（音色那行不出现，合成用这段声音） */
                          <div className="shot-field">
                            <ShotRecorder
                              audioPath={sc.audioPath}
                              disabled={composing}
                              text={sc.text}
                              onTextChange={(t) => updateScene(i, { text: t })}
                              onChange={(p) => updateScene(i, { audioPath: p })}
                              onError={(msg) => setError(msg || null)}
                            />
                          </div>
                        ) : (
                          <div className="shot-field">
                            <div className="shot-inline-row">
                              <span className="story-field-label">音色</span>
                              <div className="voice-preview-row">
                                <BeeSelect
                                  value={sceneNarrator(i).voice}
                                  options={optionsFor(sceneNarrator(i).voice)}
                                  onChange={(v) => updateSceneNarrator(i, { voice: v })}
                                  title="这一镜用哪个音色念（含克隆音色）"
                                />
                                <ShotSpeakerButton
                                  voice={sceneNarrator(i).voice}
                                  status={previewStatus}
                                  onPreview={() =>
                                    previewVoice(sceneNarrator(i).voice, sceneNarrator(i).prosody)
                                  }
                                />
                              </div>
                              {/* 语速跟音色同一行：两者合起来就是这个解说员的声音设定 */}
                              <div className="shot-prosody">
                                <ProsodyRow
                                  label="语速"
                                  value={sceneNarrator(i).prosody.rate}
                                  min={-50}
                                  max={100}
                                  step={5}
                                  onChange={(v) =>
                                    updateSceneNarrator(i, {
                                      prosody: { ...sceneNarrator(i).prosody, rate: v },
                                    })
                                  }
                                />
                              </div>
                            </div>
                          </div>
                        )}

                        {/* 运镜放在这一镜的最下面 */}
                        <div className="shot-motion-row">
                          <span className="story-field-label">运镜</span>
                          <BeeSelect
                            value={sceneMotion(i).mode}
                            options={MOTION_OPTIONS}
                            onChange={(v) =>
                              setSceneMotion(i, { ...sceneMotion(i), mode: v as MotionMode })
                            }
                          />
                          <span className="story-field-label">幅度</span>
                          <input
                            type="range"
                            min={10}
                            max={40}
                            step={5}
                            value={sceneMotion(i).amount}
                            onChange={(e) =>
                              setSceneMotion(i, { ...sceneMotion(i), amount: +e.target.value })
                            }
                          />
                          <span className="story-muted">{sceneMotion(i).amount}%</span>
                        </div>

                      </div>
                    </div>
                  </div>
                ))}
              </div>

              <div className="row">
                <button className="secondary" onClick={addScene}>
                  ＋ 添加镜头
                </button>
              </div>

              {parseWarnings.length > 0 && (
                <div className="warnings">
                  {parseWarnings.map((w, i) => (
                    <div key={i}>⚠ {w}</div>
                  ))}
                </div>
              )}

            </div>
          ) : (
            <div className="card-pad flat-panel">
              <div className="panel-title-row">
                <span className="panel-title">📝 对话脚本</span>
              </div>

              {/*
                生成区：主题（占满剩余宽）+ 时长 + AI 写脚本。
                排成「左边主题、右边一组控制」，比原来五列硬挤的网格透气。
              */}
              <div className="script-gen">
                <div className="script-gen-topic">
                  <label className="story-field-label">主题</label>
                  {/* Enter 是换行，Ctrl+Enter 才是让 AI 写 */}
                  <textarea
                    className="script-topic-input"
                    value={topic}
                    placeholder="想聊什么？例如：最近老是睡不着、事业运、职场内耗…"
                    rows={2}
                    onChange={(e) => setTopic(e.target.value)}
                    onKeyDown={(e) => {
                      if (e.key === "Enter" && (e.ctrlKey || e.metaKey)) {
                        e.preventDefault();
                        void writeScriptWithAi();
                      }
                    }}
                  />
                </div>
                <div className="script-gen-ctrl">
                  <div className="script-gen-duration">
                    <label className="story-field-label">时长</label>
                    <BeeSelect
                      value={String(scriptDuration)}
                      options={SCRIPT_DURATION_OPTIONS}
                      onChange={(v) => setScriptDuration(Number(v))}
                      title="成片大概要多长：AI 按这个秒数决定脚本的行数和字数"
                    />
                  </div>
                  <button
                    type="button"
                    className="primary"
                    disabled={writing || !topic.trim()}
                    onClick={() => void writeScriptWithAi()}
                    title="按主题让 AI 写成甲方 / 乙方的双人对话（Ctrl+Enter）"
                  >
                    {writing ? "AI 写脚本中…" : "AI 写脚本"}
                  </button>
                </div>
              </div>
              {writing && <div className="status">正在让 AI 写脚本，通常十几秒…</div>}

              {/* 编辑区：小标题栏（左格式说明、右行数），下面是脚本框 */}
              <div className="script-edit-head">
                <span className="script-edit-title">脚本内容</span>
                <span className="story-muted">一行一句，格式「甲方：xxx」</span>
                <span className={`script-edit-count${parsedLines.length ? "" : " is-empty"}`}>
                  {parsedLines.length > 0 ? `已识别 ${parsedLines.length} 行` : "未识别到内容"}
                </span>
              </div>
              <textarea
                className="script-edit"
                value={script}
                onChange={(e) => setScript(e.target.value)}
                placeholder={"甲方：xxx\n乙方：xxx"}
                rows={12}
              />

              {parseWarnings.length > 0 && (
                <div className="warnings">
                  {parseWarnings.map((w, i) => (
                    <div key={i}>⚠ {w}</div>
                  ))}
                </div>
              )}

            </div>
          )}

          {error && <div className="error">{error}</div>}

          {/* ============ 合成视频：与热点成片 ③ 同一套布局（标题行带状态与按钮 / 左预览右设定 / 底部输出路径） ============ */}
          <div className="card-pad flat-panel">
            <div className="panel-title-row">
              <span className="panel-title">🎬 合成视频</span>

              <span className="compose-head-actions">
                <span className="story-muted">
                  {composing
                    ? progress
                      ? `${stageText(progress.stage)} · ${progress.percent}%` +
                        (progress.currentLine !== undefined && progress.totalLines
                          ? `（${progress.currentLine}/${progress.totalLines} 段）`
                          : "")
                      : "正在准备…"
                    : mode === "narration"
                      ? scenes.filter((s) => !s.path).length
                        ? `还有 ${scenes.filter((s) => !s.path).length} 个镜头没放图`
                        : "配音 + 字幕 + 运镜，一条龙合成"
                      : !imageFortune || !imageCustomer
                        ? "先选两张角色图"
                        : parsedLines.length
                          ? "配音 + 字幕 + 运镜，一条龙合成"
                          : "脚本还没有可识别的对话"}
                </span>
                {composing && (
                  <button type="button" className="link" onClick={cancelGenerate}>
                    取消
                  </button>
                )}
                <button
                  type="button"
                  className="primary small primary-plain"
                  disabled={!canGenerate}
                  onClick={() => void generateVideo()}
                  title="配音 + 字幕 + 运镜，一条龙合成"
                >
                  {composing ? `合成中（${composingSeconds}s）…` : "合成视频"}
                </button>
              </span>
            </div>

            <div className="compose-row">
              {/* 固定大小的预览框：画面按自己的比例 contain 进来，不由视频决定这块多高 */}
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
                  画面方向：对话模式在「模板配置」里改（它是模板的一个参数），这里只念出来；
                  图文解说页没有模板配置那块，所以仍旧在这里直接改。
                  其余项也都在「模板配置」里改，这里按只读的样子念出来。
                */}
                <div className="board-fields">
                  <div
                    className="board-field"
                    title={
                      mode === "dialogue"
                        ? "画面方向在「模板配置」里改（它是模板的一个参数）"
                        : "画布方向：横版 16:9 / 竖版 9:16"
                    }
                  >
                    <span className="story-field-label">画面方向：</span>
                    {mode === "dialogue" ? (
                      <span className="board-readonly">
                        {resolution === "landscape" ? "横版 16:9" : "竖版 9:16"}
                      </span>
                    ) : (
                      <BeeSelect
                        value={resolution}
                        options={[
                          { value: "landscape", label: "横版 16:9" },
                          { value: "portrait", label: "竖版 9:16" },
                        ]}
                        onChange={(v) => setResolution(v as VideoResolution)}
                      />
                    )}
                  </div>
                  {mode === "narration" ? (
                    <>
                      <div className="board-field" title="每个镜头的运镜在对应镜头卡片里单独设置">
                        <span className="story-field-label">默认运镜：</span>
                        <span className="board-readonly">{motionLabel(motionMode)}</span>
                      </div>
                      <div className="board-field">
                        <span className="story-field-label">镜头：</span>
                        <span className="board-readonly">
                          已就绪 {scenes.filter((s) => s.path && s.text.trim()).length}/
                          {scenes.length} 镜
                        </span>
                      </div>
                    </>
                  ) : (
                    <>
                      <div className="board-field" title="甲方音色在上面的角色卡里改">
                        <span className="story-field-label">甲方音色：</span>
                        <span className="board-readonly">
                          {voiceOptions.find((o) => o.value === settings?.voiceFortune)?.label ||
                            settings?.voiceFortune ||
                            "未选音色"}
                        </span>
                      </div>
                      <div className="board-field" title="乙方音色在上面的角色卡里改">
                        <span className="story-field-label">乙方音色：</span>
                        <span className="board-readonly">
                          {voiceOptions.find((o) => o.value === settings?.voiceCustomer)?.label ||
                            settings?.voiceCustomer ||
                            "未选音色"}
                        </span>
                      </div>
                      <div className="board-field">
                        <span className="story-field-label">台词：</span>
                        <span className="board-readonly">
                          {parsedLines.length ? `已识别 ${parsedLines.length} 行` : "未识别到对话"}
                        </span>
                      </div>
                    </>
                  )}
                </div>
              </div>
            </div>

            {/*
              成片路径始终显示这一行：还没合成时显示输出目录（知道它待会儿会落到哪儿），
              合成完成后换成成片文件本身，并给「在文件夹中显示」。
            */}
            <div className="compose-actions">
              <span className="story-field-label">视频输出：</span>
              <div className="compose-actions-main">
                <div className="story-result-path" title={outputPath || outputDir || undefined}>
                  {outputPath || outputDir || "默认目录加载中…"}
                </div>
                {outputPath ? (
                  <button
                    type="button"
                    className="secondary small"
                    onClick={() => showInFolder(outputPath)}
                  >
                    在文件夹中显示
                  </button>
                ) : (
                  <button
                    type="button"
                    className="secondary small"
                    onClick={openOutputDir}
                    title="在系统的文件资源管理器里打开这个目录"
                  >
                    在目录中显示
                  </button>
                )}
              </div>
            </div>
          </div>
        </div>
      </div>

      <div className="disclaimer">
        普通音色由在线语音服务合成；克隆音色在本机合成，不联网。本地项目数据保存在
        「设置 → 通用设置 → 数据目录」里配置的位置（默认 <code>%APPDATA%\Baoluo</code>）。
      </div>
      </SideList>
      {/* 「＋ 自定义模板…」的命名小窗：把编辑器当前配置存成一份新模板 */}
      {newTplOpen && (
        <div className="modal-overlay" onClick={() => setNewTplOpen(false)}>
          <div
            className="modal-card clone-modal"
            role="dialog"
            aria-label="新建模板"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="clone-modal-head">
              <h3>自定义模板</h3>
              <button type="button" className="secondary small" onClick={() => setNewTplOpen(false)}>
                取消
              </button>
            </div>
            <div className="clone-modal-body">
              <div className="form-row">
                <label>名称</label>
                <input
                  value={tplName}
                  maxLength={40}
                  autoFocus
                  placeholder="给这套配置起个名字，例如：温馨情感 / 职场犀利"
                  onChange={(e) => setTplName(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === "Enter") {
                      e.preventDefault();
                      void saveNewTemplate();
                    }
                  }}
                />
              </div>
              <p className="story-muted" style={{ margin: 0 }}>
                {mode === "narration"
                  ? "会把当前的镜头与解说员配置存成一份新模板，保存后自动应用到编辑器。"
                  : "会把编辑器里当前的配音 / 运镜配置存成一份新模板，保存后自动应用到编辑器。"}
              </p>
            </div>
            <div className="clone-modal-actions">
              <button
                type="button"
                className="primary"
                disabled={!tplName.trim()}
                onClick={() => void saveNewTemplate()}
              >
                保存
              </button>
            </div>
          </div>
        </div>
      )}
      {/* 模板弹窗：应用 / 新建 / 改名 / 删除 / 设默认（点标题行的「模板」按钮弹出） */}
      {tplMgrOpen && (
        <div className="modal-overlay" onClick={() => setTplMgrOpen(false)}>
          <div
            className="modal-card clone-modal tpl-mgr-modal"
            role="dialog"
            aria-label="模板管理"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="clone-modal-head">
              <h3>{mode === "narration" ? "🧩 分镜模板" : "🧩 对话模板"}</h3>
              <button type="button" className="secondary small" onClick={() => setTplMgrOpen(false)}>
                关闭
              </button>
            </div>
            <div className="clone-modal-body">
              <div className="tpl-new-row">
                <input
                  className="tpl-name-input"
                  value={tplName}
                  placeholder="给这套配置起个名字，例如：温馨情感 / 职场犀利"
                  maxLength={40}
                  onChange={(e) => setTplName(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === "Enter") {
                      e.preventDefault();
                      void saveAsTemplate();
                    }
                  }}
                />
                <button
                  type="button"
                  className="primary small"
                  disabled={!tplName.trim()}
                  onClick={() => void saveAsTemplate()}
                  title={
                    mode === "narration"
                      ? "把这批镜头（图 + 解说词 + 解说员）存成一份新模板"
                      : "把编辑器里当前的配置存成一份新模板"
                  }
                >
                  ＋ 保存为模板
                </button>
              </div>

              {/* 内置模板：应用自带，只能用不能改。没设自己的默认时，工作台建卡就走它（仅对话模式有） */}
              {mode === "dialogue" && builtinTpl && (
                <div className="tpl-card tpl-card-builtin">
                  <div className="tpl-card-main">
                    <span className="tpl-card-title-row">
                      <span className="tpl-card-name is-static">{builtinTpl.title}</span>
                      <span className="tpl-default-chip is-builtin" title="应用自带，不能删除或修改">
                        内置
                      </span>
                      {!defaultTemplateId && (
                        <span className="tpl-default-chip is-default" title="没设自己的默认模板时，工作台建卡就用它">
                          默认
                        </span>
                      )}
                      {appliedTemplateId === builtinTpl.id && (
                        <span className="tpl-default-chip">使用中</span>
                      )}
                    </span>
                    <span className="tpl-card-meta">{builtinTpl.subtitle}</span>
                  </div>
                  <div className="tpl-card-actions">
                    <button
                      type="button"
                      className="primary small"
                      onClick={() => {
                        void applyTemplate(builtinTpl.id);
                        setTplMgrOpen(false);
                      }}
                      title="把这套配置套到编辑器上（可继续改，改完用「保存」存成自己的一份）"
                    >
                      应用
                    </button>
                  </div>
                </div>
              )}

              {templates.length === 0 ? (
                <div className="story-empty">
                  {mode === "narration"
                    ? "还没有自己的模板。上面起个名字点「＋ 保存为模板」，就会把这批镜头（图 + 解说词 + 解说员）存下来。"
                    : "还没有自己的模板。上面起个名字点「＋ 保存为模板」，就会把当前的配音与运镜配置存下来。"}
                </div>
              ) : (
                <div className="tpl-list">
                  {templates.map((t) => (
                    <div className="tpl-card" key={t.id}>
                      <div className="tpl-card-main">
                        <span className="tpl-card-title-row">
                          <input
                            className="tpl-card-name"
                            defaultValue={t.title}
                            maxLength={40}
                            title="改完点别处或按回车即改名"
                            onBlur={(e) => {
                              if (e.target.value.trim() !== t.title)
                                void renameTemplate(t.id, e.target.value);
                            }}
                            onKeyDown={(e) => {
                              if (e.key === "Enter") (e.target as HTMLInputElement).blur();
                            }}
                          />
                          {appliedTemplateId === t.id && <span className="tpl-default-chip">使用中</span>}
                          {mode === "dialogue" && defaultTemplateId === t.id && (
                            <span className="tpl-default-chip is-default" title="工作台建「对话视频」时自动套用这套配置">
                              默认
                            </span>
                          )}
                        </span>
                        <span className="tpl-card-meta">
                          {t.subtitle}
                          <span className="tpl-card-time">{formatListTime(t.updatedAt)}</span>
                        </span>
                      </div>
                      <div className="tpl-card-actions">
                        <button
                          type="button"
                          className="primary small"
                          onClick={() => {
                            void applyTemplate(t.id);
                            setTplMgrOpen(false);
                          }}
                          title="把这套配置套到编辑器上"
                        >
                          应用
                        </button>
                        {/* 「设为默认」是工作台建卡的概念，分镜模板没有这条链路，不摆 */}
                        {mode === "dialogue" && (
                          <button
                            type="button"
                            className={`secondary small secondary-plain${defaultTemplateId === t.id ? " is-default" : ""}`}
                            onClick={() => void toggleDefaultTemplate(t.id)}
                            title={
                              defaultTemplateId === t.id
                                ? "取消默认（工作台建卡就按设置里的默认值来）"
                                : "设为默认：工作台建「对话视频」卡时自动套用这套配置"
                            }
                          >
                            {defaultTemplateId === t.id ? "取消默认" : "设为默认"}
                          </button>
                        )}
                        <button
                          type="button"
                          className="danger small"
                          onClick={() => void removeTemplate(t.id, t.title)}
                        >
                          删除
                        </button>
                      </div>
                    </div>
                  ))}
                </div>
              )}
            </div>
          </div>
        </div>
      )}
      {confirmDialog}
    </div>
  );
}

/** 喇叭图标（SVG，避免 emoji 基线偏移，颜色跟随 currentColor） */
function RoleCard(props: {
  label: string;
  image: string | null;
  onPickImage: () => void;
  onClearImage: () => void;
  voice: string;
  options: typeof VOICE_OPTIONS;
  prosody: VoiceProsody;
  onVoice: (v: string) => void;
  onProsody: (k: "rate" | "pitch" | "volume", v: number) => void;
  motion: MotionConfig;
  onMotion: (v: MotionConfig) => void;
  onPreview: () => void;
  previewStatus: PreviewStatus;
}) {
  const isThis = props.previewStatus?.voice === props.voice;
  const loading = isThis && props.previewStatus?.state === "loading";
  const playing = isThis && props.previewStatus?.state === "playing";
  const errMsg =
    isThis && props.previewStatus?.state === "error"
      ? props.previewStatus.message
      : undefined;
  return (
    <div className="role-card">
      <div className="panel-title">👤 {props.label}</div>
      <div className="role-main">
        <ImageSlot
          label={props.label}
          path={props.image}
          onPick={props.onPickImage}
          onClear={props.onClearImage}
        />
        <div className="role-right">
          {/* 运镜（和幅度）是画面的事，放前面；音色和语速是声音的事，两个挨着放一起 */}
          <div className="role-selects">
            <span className="story-field-label">运镜</span>
            <BeeSelect
              value={props.motion.mode}
              options={MOTION_OPTIONS}
              onChange={(v) => props.onMotion({ ...props.motion, mode: v as MotionMode })}
              title="运镜"
            />
          </div>
          <div className="form-row prosody-row">
            <label>幅度</label>
            <input
              type="range"
              min={10}
              max={40}
              step={5}
              value={props.motion.amount}
              onChange={(e) => props.onMotion({ ...props.motion, amount: +e.target.value })}
            />
            <span className="prosody-value">{props.motion.amount}%</span>
          </div>
          <div className="role-selects">
            <span className="story-field-label">音色</span>
            <BeeSelect
              value={props.voice}
              options={props.options}
              onChange={props.onVoice}
              title="音色"
            />
            <button
              className={`speaker-btn ${loading || playing ? "active" : ""}`}
              title={errMsg ?? "试听当前音色"}
              disabled={loading}
              onClick={props.onPreview}
            >
              <span className="speaker-icon">
                {loading ? <HourglassIcon /> : <SpeakerIcon />}
              </span>
            </button>
          </div>
          <div className="role-prosody">
            <ProsodyRow
              label="语速"
              value={props.prosody.rate}
              min={-50}
              max={100}
              step={5}
              onChange={(v) => props.onProsody("rate", v)}
            />
          </div>
        </div>
      </div>
    </div>
  );
}

function ImageSlot(props: {
  label: string;
  path: string | null;
  onPick: () => void;
  onClear?: () => void;
}) {
  const [url, setUrl] = useState<string>("");
  useEffect(() => {
    let active = true;
    (async () => {
      if (!props.path) {
        setUrl("");
        return;
      }
      try {
        const u = await window.media.toUrl(props.path);
        if (active) setUrl(u);
      } catch {
        if (active) setUrl("");
      }
    })();
    return () => {
      active = false;
    };
  }, [props.path]);

  return (
    <div className="image-slot">
      {/* filled：有图时边框从虚线变实线，与热点成片的镜头图框一个观感 */}
      <div className={`image-preview ${url ? "filled" : ""}`}>
        {url ? (
          <img src={url} alt={props.label} />
        ) : (
          // 框上不再写「甲方 / 乙方」：卡片标题已经是 👤 甲方，角色名在这里是重复的
          <div className="image-empty">点击选择图片</div>
        )}
      </div>
      <div className="image-actions">
        <button className="secondary small" onClick={props.onPick}>
          选择图片
        </button>
        {props.path && props.onClear && (
          <button className="link" onClick={props.onClear}>清除</button>
        )}
      </div>
    </div>
  );
}

/** 分镜卡片里的音色试听喇叭：状态沿用全局 previewStatus（按音色值匹配） */
function ShotSpeakerButton(props: {
  voice: string;
  status: PreviewStatus;
  onPreview: () => void;
}) {
  const isThis = props.status?.voice === props.voice;
  const loading = isThis && props.status?.state === "loading";
  const playing = isThis && props.status?.state === "playing";
  const errMsg =
    isThis && props.status?.state === "error" ? props.status.message : undefined;
  return (
    <button
      type="button"
      className={`speaker-btn ${loading || playing ? "active" : ""}`}
      title={errMsg ?? "试听这个音色（读一句示例）"}
      disabled={loading}
      onClick={props.onPreview}
    >
      <span className="speaker-icon">
        {loading ? <HourglassIcon /> : <SpeakerIcon />}
      </span>
    </button>
  );
}

function ProsodyRow(props: {
  label: string;
  value: number;
  min: number;
  max: number;
  step: number;
  onChange: (v: number) => void;
}) {
  return (
    <div className="form-row prosody-row">
      <label>{props.label}</label>
      <input
        type="range"
        min={props.min}
        max={props.max}
        step={props.step}
        value={props.value}
        onChange={(e) => props.onChange(+e.target.value)}
      />
      <span className="prosody-value">
        {props.value > 0 ? `+${props.value}%` : `${props.value}%`}
      </span>
    </div>
  );
}
