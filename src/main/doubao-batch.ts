/**
 * 批量生图队列（T-003，按组一次发送）。
 *
 * 放在主进程，不放渲染层，原因两条：
 *   1. 标准 8 要求「关抽屉不中断任务」——渲染层的组件状态会随页面切换丢掉，
 *      主进程的 async 循环不会；
 *   2. 标准 9 要求「不允许第二个队列」，判重必须有一个唯一说了算的地方。
 *
 * 队列里跑哪套实现由**生图引擎**决定（两条路的出图方式根本不同）：
 *   - 豆包（浏览器自动化）：把最多 K 个镜头的提示词拼成一条消息发给豆包，一条消息出 K 张图，
 *     按 DOM 顺序归位；张数不符就整组退回单发（见下面 runQueue 的说明）。
 *   - ModelScope（HTTP API）：一镜一次请求，顺序跑。免费额度并发很低，所以逐张来 + 张间留间隔，
 *     失败交给 sendSingleWithRetry 重试（限流的退避在客户端里做）。
 *
 * 两条实现共用同一份 BatchState（含 provider 字段），所以界面只按 provider 换文案，不用写两套 UI。
 *
 * 归位纪律（标准 5，豆包那条路）：一组实到位图数 == 该组提示词数，才按 DOM 顺序绑定；
 * 不等就**一张都不绑**，整组退回单发。宁可慢，不许猜——错绑比慢严重得多。
 */
import {
  IMAGE_WAIT_MS,
  describeDoubaoFailure,
  beginGeneration,
  endGeneration,
  generateImagesFromPrompt,
  getGenerationGuardState,
  humanDelayMs,
  type GeneratedImage,
} from "./doubao";
import { generateShotImage } from "./doubao-shot";
import { noteDoubaoGenerated } from "./doubao-quota";
import * as storyStore from "./storyboard/store";
import { currentImageProvider } from "./imagegen";
import type { BatchItem, BatchState } from "../shared/doubao-batch-types";

/**
 * 组大小 K。
 *
 * 研发参数，不是产品参数：由前置实验定（T-003 卡）。第三轮实验用 5 张验过顺序可信，
 * 第一轮 3 张也验过，这里取卡里的默认值 3（10 个缺图镜头 → 4 条消息，满足标准 2）。
 * 改这个值必须重跑 `npm run experiment:doubao-multi -- --count=<K>`。
 */
export const GROUP_SIZE = 3;

/** 单张的等待上限；单组上限 = 组大小 × 这个值（标准 10） */
export const PER_SHOT_WAIT_MS = IMAGE_WAIT_MS;

/** 单镜失败后的重试上限（需求 v1.0.0：不做无限重试，上限 3 次） */
export const MAX_RETRY = 3;

export type { BatchItem, BatchState } from "../shared/doubao-batch-types";

let state: BatchState = {
  running: false,
  boardId: null,
  provider: "doubao",
  cancelling: false,
  total: 0,
  doneCount: 0,
  items: [],
  summary: "",
  submitted: 0,
  groupSize: GROUP_SIZE,
  fallbackGroups: 0,
  note: "",
};

type Emitter = (s: BatchState) => void;
let emit: Emitter = () => {};

export function setBatchEmitter(fn: Emitter): void {
  emit = fn;
}

function snapshot(): BatchState {
  return { ...state, items: state.items.map((i) => ({ ...i })) };
}

function publish(): void {
  emit(snapshot());
}

export function getBatchState(): BatchState {
  return snapshot();
}

/**
 * 把一组的提示词拼成一条消息（标准 3）。
 *
 * 三条要求都在里面：含该组全部提示词、顺序与镜头顺序一致、明确要求各段单独出图不要拼图。
 * 这段文本与前置实验里验证过的那条一致（试验报告第一/二/三轮）。
 */
export function composeGroupMessage(prompts: string[]): string {
  const lines = [
    `请给我生成 ${prompts.length} 张图片，每段描述单独出一张，按顺序一张一张出，不要合成一张拼图。`,
    ...prompts.map((p, i) => `第${i + 1}张：${p.trim()}`),
  ];
  return lines.join("\n");
}

/** 把结果拼成人话汇总 */
function buildSummary(items: BatchItem[], aborted: boolean): string {
  const ok = items.filter((i) => i.state === "done").length;
  const failed = items.filter((i) => i.state === "failed");
  const skipped = items.filter((i) => i.state === "skipped").length;
  const parts: string[] = [`成功 ${ok} / 共 ${items.length}`];
  if (failed.length) parts.push(`失败：第 ${failed.map((f) => f.index).join("、")} 镜`);
  if (skipped) parts.push(`未开始 ${skipped} 张`);
  // 提交口径按引擎说：豆包是「一条消息出 K 张」（用户要能核对没退化成逐张），API 引擎是一镜一次请求
  parts.push(state.provider === "modelscope" ? `共请求 ${state.submitted} 次` : `共提交 ${state.submitted} 条消息`);
  if (state.fallbackGroups) parts.push(`有 ${state.fallbackGroups} 组张数不符已退回单发`);
  if (aborted) parts.push("已中止");
  return parts.join("，");
}

/**
 * 关掉「生图时自动发送」时，批量队列不能跑（T-004）。
 *
 * 批量没有手动挡：它靠自动提交一组组往下走，页面上只会停下一条填好词的输入框，
 * 队列却以为在等出图。宁可在启动时就拒掉，也不要把用户丢进一个卡住的队列。
 * 返回 null 表示可以跑。
 */
export function batchAutoSubmitBlocked(autoSubmit: boolean): string | null {
  if (autoSubmit) return null;
  return (
    "「生图时自动发送」已关闭，批量生图需要自动发送。" +
    "请到「设置 → 通用设置」打开，或改用单镜「一键生图」（关掉时它只填提示词，发送由你点）。"
  );
}

interface Target {
  shotId: string;
  index: number;
  prompt: string;
}

/**
 * 启动批量生图。
 *
 * 只对「没有图、且有画面提示词」的镜头排队（标准 1），已放图的跳过。
 * 已在跑就拒绝第二个（标准 9），并把当前状态原样回给界面。
 */
export async function startBatch(
  boardId: string,
  opts: { groupSize?: number; perShotTimeoutMs?: number } = {}
): Promise<{ started: boolean; state: BatchState; error?: string }> {
  if (state.running) {
    return {
      started: false,
      state: snapshot(),
      error: "批量生图已经在跑了，请等它结束或先点「中止」。",
    };
  }
  /*
   * 有单张生图在途时不开队列：豆包只有一个输入框，
   * 队列刚把词填进去就会被打断，两边都拿不到图。
   */
  if (getGenerationGuardState().busy > 0) {
    return {
      started: false,
      state: snapshot(),
      error: "有一张图正在生成，先等它结束，再点「批量生图」。",
    };
  }

  const sb = storyStore.getStoryboard(boardId);
  const targets: Target[] = sb.shots
    .map((s, i) => ({
      shotId: s.id,
      index: i + 1,
      hasImage: !!s.imagePath,
      prompt: s.imagePrompt.trim(),
    }))
    .filter((t) => !t.hasImage && t.prompt)
    .map((t) => ({ shotId: t.shotId, index: t.index, prompt: t.prompt }));

  if (!targets.length) {
    return {
      started: false,
      state: snapshot(),
      error: "没有需要生图的镜头（要么都有图了，要么还缺画面提示词）。",
    };
  }

  /*
   * 队列里跑哪套实现由当前生图引擎决定：
   *   豆包 → 拼组消息一次出 K 张（要 DOM 顺序归位、张数不符退回单发）；
   *   API 引擎（ModelScope）→ 一镜一次请求，顺序跑（免费额度并发低，逐张来最稳）。
   * 两条实现共用同一份 state，所以此处只是选一个 async 循环。
   */
  const provider = currentImageProvider();
  const groupSize = Math.max(1, Math.floor(opts.groupSize ?? GROUP_SIZE));
  state = {
    running: true,
    boardId,
    provider,
    cancelling: false,
    total: targets.length,
    doneCount: 0,
    items: targets.map((t) => ({ shotId: t.shotId, index: t.index, state: "pending" as const })),
    summary: "",
    submitted: 0,
    // API 引擎没有「一组几张」的概念（一镜一次请求），界面上也不显示提交条数那条说明
    groupSize: provider === "modelscope" ? 1 : groupSize,
    fallbackGroups: 0,
    note: "",
  };
  publish();

  // 不 await：启动即回，跑的过程靠广播推进度
  const runner =
    provider === "modelscope"
      ? runApiQueue(boardId, targets, opts)
      : runQueue(boardId, targets, { ...opts, groupSize });
  queueDone = runner.then(() => snapshot());
  return { started: true, state: snapshot() };
}

/**
 * 队列跑完后的最终状态（含汇总）。
 *
 * 界面走广播推进度，不等着；这个出口给「把批量生图当流水线中间步」的调用方用
 * （工作台的「自动生图 + 合成」）：生完图才知道还缺不缺图。
 */
export function waitBatchDone(): Promise<BatchState> {
  return queueDone ?? Promise.resolve(snapshot());
}

/** 当前队列的完成信号；没在跑时resolve成当前状态（多半是「没跑」的空状态） */
let queueDone: Promise<BatchState> | null = null;

/** 请求中止：当前这一组跑完再停（标准 7） */
export function cancelBatch(): BatchState {
  if (!state.running) return snapshot();
  state.cancelling = true;
  publish();
  return snapshot();
}

function itemOf(shotId: string): BatchItem | undefined {
  return state.items.find((i) => i.shotId === shotId);
}

/** 把还没开始的都标成 skipped（中止时用） */
function skipPending(): void {
  for (const rest of state.items) {
    if (rest.state === "pending" || rest.state === "running") rest.state = "skipped";
  }
}

/**
 * 可中止的抖动等待（组间/补发之间的停顿用）。
 *
 * 固定节拍是行为分析里最容易被挑出来的特征，所以这里用随机区间；
 * 同时把等待切成小片，用户点「中止」不用等满这几秒。
 */
async function waitCancellable(minMs: number, maxMs: number): Promise<void> {
  let left = humanDelayMs(minMs, maxMs);
  while (left > 0 && !state.cancelling) {
    const slice = Math.min(250, left);
    await new Promise((r) => setTimeout(r, slice));
    left -= slice;
  }
}

async function runQueue(
  boardId: string,
  targets: Target[],
  opts: { groupSize?: number; perShotTimeoutMs?: number }
): Promise<void> {
  const groupSize = Math.max(1, Math.floor(opts.groupSize ?? GROUP_SIZE));
  const perShotMs = opts.perShotTimeoutMs ?? PER_SHOT_WAIT_MS;
  beginGeneration();
  let aborted = false;
  try {
    for (let i = 0; i < targets.length; i += groupSize) {
      if (state.cancelling) {
        aborted = true;
        skipPending();
        break;
      }
      const group = targets.slice(i, i + groupSize);
      /*
       * 组间随机停顿 3–8 秒（第一组不等）。
       * 一是别用固定节拍连发（机器特征），二是给豆包一点喘息，
       * 三是用户点了中止不用等满一整组。
       */
      if (i > 0) {
        state.note = "稍等一下再发下一组…";
        publish();
        await waitCancellable(3000, 8000);
        if (state.cancelling) {
          aborted = true;
          skipPending();
          break;
        }
      }
      for (const t of group) {
        const it = itemOf(t.shotId);
        if (it) it.state = "running";
      }
      publish();

      const say = (message: string) => {
        state.note = message;
        publish();
      };
      const countSubmitted = () => {
        state.submitted++;
        publish();
      };

      let images: GeneratedImage[] | null = null;
      let failWhy = "";
      try {
        images = await generateImagesFromPrompt(
          composeGroupMessage(group.map((t) => t.prompt)),
          group.length,
          {
            // 标准 10：单组等待上限 = 组大小 × 单张上限
            timeoutMs: group.length * perShotMs,
            onPhase: say,
            onSubmitted: countSubmitted,
          }
        );
      } catch (e) {
        failWhy = describeDoubaoFailure(e).message;
      }

      /*
       * 硬校验的第二道闸（标准 5）：依赖层已经保证「张数正好」，这里再判一次。
       * 少了会整体错位、多了会绑错镜头，两种都**一张都不许绑**——
       * 不能信任下游返回的数组长度（少了会在下面取 undefined 崩，多了会静默绑错）。
       */
      if (images && images.length !== group.length) {
        failWhy = `这一组要 ${group.length} 张，实到 ${images.length} 张。`;
        images = null;
      }

      if (!images) {
        /*
         * 整组退回单发。原因写进每个镜头的记录里（标准 5 要求留痕），
         * 汇总里也会写「有 N 组张数不符已退回单发」。
         */
        console.warn(`[batch] 组内张数不符/整组失败，退回单发：${failWhy}`);
        state.fallbackGroups++;
        state.note = "这一组张数不符，正在退回单张补发…";
        for (const t of group) {
          const it = itemOf(t.shotId);
          if (it) {
            // 留痕用 note，不占 error：error 后面会被每一次补发失败的原因覆盖
            it.note = `组内张数不符，退回单发：${failWhy}`;
            it.error = undefined;
          }
        }
        publish();
      }

      if (images) {
        // 归位：DOM 顺序 == 提示词顺序 == 镜头顺序（标准 3、5）
        for (let k = 0; k < group.length; k++) {
          const t = group[k];
          const it = itemOf(t.shotId);
          try {
            storyStore.attachShotImageBytes(boardId, t.shotId, images[k].base64);
            // 组内这一张也算一次当日用量（单发路径由 doubao-shot 自己记）
            noteDoubaoGenerated(1);
            if (it) {
              it.state = "done";
              it.via = "group";
              it.error = undefined;
            }
          } catch (e) {
            // 存盘失败只影响这一张（磁盘级错误），组内其它张照常
            if (it) {
              it.state = "failed";
              it.via = "group";
              it.error = describeDoubaoFailure(e).message;
            }
          }
          state.doneCount++;
          publish();
        }
        continue;
      }

      // ---- 退回单发（标准 6：复用单镜路径，失败重试 ≤ 3 次）----
      let firstSingle = true;
      for (const t of group) {
        if (state.cancelling) {
          aborted = true;
          skipPending();
          break;
        }
        // 补发之间也随机停一下，别连珠炮（第一张紧跟上一组，不用等）
        if (!firstSingle) await waitCancellable(1000, 3000);
        firstSingle = false;
        const it = itemOf(t.shotId);
        if (it) {
          it.state = "running";
          it.via = "single";
          publish();
        }
        const ok = await sendSingleWithRetry(boardId, t, perShotMs);
        if (it) {
          /*
           * attempts 还是空 = 一次都没试过（中止发生在这一张开始之前），
           * 这种要标 skipped（保持「待放图」），不能标成失败。
           */
          if (!ok && (it.attempts ?? 0) === 0) it.state = "skipped";
          else it.state = ok ? "done" : "failed";
          it.via = "single";
          if (ok) it.error = undefined;
        }
        state.doneCount++;
        publish();
      }
      if (aborted) break;
    }
  } finally {
    endGeneration();
    skipPending();
    state.note = "";
    state.summary = buildSummary(state.items, aborted);
    state.running = false;
    state.cancelling = false;
    publish();
  }
}

/**
 * API 引擎（ModelScope）的队列：一镜一次请求，顺序跑。
 *
 * 为什么不并发：免费额度并发很低（常见 QPS ≤ 1），并发只会把请求打成 429，反而整体更慢；
 * 逐张来 + 张间小停顿是这条路上最稳的节奏（限流退避在 ModelScope 客户端里做）。
 *
 * 重试复用单镜路径（sendSingleWithRetry）：失败点可能是提交、出图或下载，整张重来才有意义。
 */
async function runApiQueue(
  boardId: string,
  targets: Target[],
  opts: { perShotTimeoutMs?: number }
): Promise<void> {
  const perShotMs = opts.perShotTimeoutMs ?? PER_SHOT_WAIT_MS;
  beginGeneration();
  let aborted = false;
  try {
    for (let i = 0; i < targets.length; i++) {
      const t = targets[i];
      if (state.cancelling) {
        aborted = true;
        skipPending();
        break;
      }
      // 张与张之间留一点随机停顿（第一张不等）：既避开固定节拍，也给限流一点恢复时间
      if (i > 0) {
        state.note = "稍等一下再出下一张…";
        publish();
        await waitCancellable(800, 2500);
        if (state.cancelling) {
          aborted = true;
          skipPending();
          break;
        }
      }
      const it = itemOf(t.shotId);
      if (it) {
        it.state = "running";
        it.via = "api";
        publish();
      }
      const ok = await sendSingleWithRetry(boardId, t, perShotMs);
      if (it) {
        // 一次都没试过 = 中止发生在这一张开始之前：保持「待放图」，别标成失败
        if (!ok && (it.attempts ?? 0) === 0) it.state = "skipped";
        else it.state = ok ? "done" : "failed";
        it.via = "api";
        if (ok) it.error = undefined;
      }
      state.doneCount++;
      publish();
    }
  } finally {
    endGeneration();
    skipPending();
    state.note = "";
    state.summary = buildSummary(state.items, aborted);
    state.running = false;
    state.cancelling = false;
    publish();
  }
}

/**
 * 单镜补发：复用单镜生图路径（T-002/T-004 的 generateShotImage），失败最多重试 MAX_RETRY 次。
 *
 * 每次重试都重走一遍「填词 → 提交 → 抓图」：失败点可能在提交前，重发才有意义。
 * 用户中止造成的失败不再重试。
 */
async function sendSingleWithRetry(boardId: string, t: Target, perShotMs: number): Promise<boolean> {
  const it = itemOf(t.shotId);
  for (let attempt = 1; attempt <= MAX_RETRY; attempt++) {
    if (state.cancelling) return false;
    if (it) {
      it.attempts = attempt;
      publish();
    }
    const res = await generateShotImage(
      {
        boardId,
        shotId: t.shotId,
        // 批量必须自动发送（关掉自动发送时队列根本不会启动）
        autoSubmit: true,
        timeouts: { waitMs: perShotMs },
        onSubmitted: () => {
          state.submitted++;
          publish();
        },
      },
      (message) => {
        state.note = message;
        publish();
      }
    );
    if (res.ok) return true;
    if (it) it.error = res.message;
    if (state.cancelling) return false;
  }
  return false;
}
