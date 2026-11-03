/**
 * 单镜一键生图的编排层（T-004：生图开关与异常兜底）。
 *
 * 为什么要单独一层，而不是留在 ipc.ts 里：
 *   界面对这些情况要做的事**不一样**，不能只收到一句 message：
 *     - 「设置里关了自动发送」→ 只填了词，等用户去点发送：这是正常结果，不是错误；
 *     - 「未登录」→ 引导用户在当前这个豆包窗口里登录；
 *     - 「豆包改版 / 抓图失败」→ 提示语里指到手动出口（打开豆包窗口，把画面提示词手动输进去）。
 *   而 Electron 的 ipcMain 会把主进程抛出的异常压成一句 message（自定义属性全丢），
 *   所以区别必须写在**返回的对象**里（code），不能靠抛异常带过来。
 *
 * 另外这一层不碰窗口、不碰抽屉，因此可以在测试里直接调（见 scripts/test-doubao-t4.cjs）。
 */
import * as storyStore from "./storyboard/store";
import * as settings from "./dialogue/settings";
import { noteDoubaoGenerated } from "./doubao-quota";
import {
  DoubaoError,
  beginGeneration,
  endGeneration,
  generateImageFromPrompt,
} from "./doubao";
import {
  currentImageProvider,
  describeImageFailure,
  imageProviderBlocked,
  modelScopeConfig,
  sizeForResolution,
} from "./imagegen";
import { ModelScopeError, generateImageViaModelScope } from "./imagegen/modelscope";
import type { GenerateShotOutcome } from "../shared/doubao-shot-types";

export type { GenerateShotOutcome } from "../shared/doubao-shot-types";
export { describeDoubaoFailure } from "./doubao";
/** 失败收人话：按当前引擎分派（豆包/ModelScope 的失败都收成同一种形状） */
export { describeImageFailure } from "./imagegen";

export interface GenerateShotRequest {
  boardId: string;
  shotId: string;
  /** 覆盖设置里的「生图时自动发送」；不传就用设置（默认开） */
  autoSubmit?: boolean;
  /**
   * 各段等待上限（毫秒），不传就用 doubao.ts 里的产品默认值（30 秒 / 20 秒 / 120 秒 / 30 秒）。
   * 测试用来把秒级等待压到毫秒级；批量退回单发时也走这里。
   */
  timeouts?: {
    loginMs?: number;
    fillMs?: number;
    waitMs?: number;
    fetchMs?: number;
  };
  /** 点下发送之后回调一次（批量队列用它数提交条数） */
  onSubmitted?: () => void;
}

/**
 * 一键生图：填词（＋可选提交）→ 等出图 → 存进这个镜头。
 *
 * 返回结构化结果而不是抛异常：所有「用户看得见的结果」都走 ok/code/message，
 * 只有真的写坏了（进程级异常）才会以异常形式冒到 ipc。
 *
 * 这个函数是「单镜生图」的唯一入口，内部按当前生图引擎分派：
 *   - 豆包：填词 → 点发送 → 抓图（有「只填词不发送」这个手动挡）；
 *   - ModelScope：调 API-Inference 出图（没有手动挡，也不需要登录态）。
 * 两边返回同一个 GenerateShotOutcome，所以界面不用分两套。
 */
export async function generateShotImage(
  req: GenerateShotRequest,
  onPhase?: (message: string) => void
): Promise<GenerateShotOutcome> {
  let board;
  let shot;
  try {
    board = storyStore.getStoryboard(req.boardId);
    shot = board.shots.find((s) => s.id === req.shotId);
  } catch (e) {
    return { ok: false, board: null, ...describeImageFailure(e) };
  }
  if (!shot) {
    return { ok: false, board: null, code: "no-shot", message: "镜头不存在，请刷新后重试。" };
  }
  if (!shot.imagePrompt.trim()) {
    return {
      ok: false,
      board: null,
      code: "empty-prompt",
      message: "这个镜头还没有画面提示词，请先点「重新生成提示词」。",
    };
  }

  // ---------------- ModelScope（HTTP API）：没有手动挡，前置条件只有 Token ----------------
  if (currentImageProvider() === "modelscope") {
    const blocked = imageProviderBlocked();
    if (blocked) return { ok: false, board: null, ...blocked };
    beginGeneration();
    try {
      onPhase?.("正在调用 ModelScope 生图…");
      const cfg = modelScopeConfig();
      const img = await generateImageViaModelScope(shot.imagePrompt, {
        token: cfg.token,
        model: cfg.model,
        // 用户没手填尺寸时，按这条片子的画面比例出图（竖版 9:16 → 720×1280）
        size: cfg.size || sizeForResolution(board.resolution),
        timeoutMs: req.timeouts?.waitMs,
        onPhase,
        onSubmitted: req.onSubmitted,
      });
      onPhase?.("正在保存到镜头…");
      const saved = storyStore.attachShotImageBytes(req.boardId, req.shotId, img.base64);
      // 用量自保只在豆包那条路（ModelScope 的额度由服务端管，本地不设上限）
      return { ok: true, board: saved };
    } catch (e) {
      if (e instanceof ModelScopeError && e.code === "cancelled") {
        return { ok: false, board: null, code: "cancelled", message: "已取消" };
      }
      return { ok: false, board: null, ...describeImageFailure(e) };
    } finally {
      endGeneration();
    }
  }

  // ---------------- 豆包（浏览器自动化）：原有逻辑不动 ----------------
  // 设置里关了自动发送就只填词；显式传进来的 autoSubmit 优先（供测试与后续批量复用）
  const autoSubmit = req.autoSubmit ?? settings.isAutoSubmitImageEnabled();

  /*
   * 生图期间页面不许被冻结（关抽屉会触发冻结，豆包的生成轮询会停住）。
   * 与批量队列用同一个计数，互相之间也就能看见「有活在跑」。
   */
  beginGeneration();
  try {
    const t = req.timeouts ?? {};
    const img = await generateImageFromPrompt(shot.imagePrompt, {
      autoSubmit,
      loginTimeoutMs: t.loginMs,
      fillTimeoutMs: t.fillMs,
      timeoutMs: t.waitMs,
      fetchTimeoutMs: t.fetchMs,
      onPhase,
      onSubmitted: req.onSubmitted,
    });
    onPhase?.("正在保存到镜头…");
    const saved = storyStore.attachShotImageBytes(req.boardId, req.shotId, img.base64);
    // 记一笔当日用量（每日上限自保，见 doubao-quota.ts）
    noteDoubaoGenerated(1);
    return { ok: true, board: saved };
  } catch (e) {
    /*
     * 「只填词、没提交」不是失败：它是设置里那个手动挡的正常结果，
     * 界面要显示成提示（绿色）而不是错误（红色），所以这里单独认出来。
     */
    if (e instanceof DoubaoError && e.code === "manual-submit") {
      return {
        ok: true,
        board: null,
        filledOnly: true,
        code: "manual-submit",
        message: e.message,
      };
    }
    return { ok: false, board: null, ...describeImageFailure(e) };
  } finally {
    endGeneration();
  }
}
