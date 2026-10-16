/*
 * SPDX-License-Identifier: GPL-3.0-only
 * Copyright (c) 2026 宝螺 / Baoluo contributors
 * 本文件属于「宝螺 / Baoluo」。除 GPL-3.0 外还适用 ADDITIONAL_TERMS.md 里的附加条款：
 * 分发时须保留来源署名；修改版对外分发时不得沿用「宝螺」名称与图标。
 */
/**
 * 「AI 一键成片」的顺序编排（与 React 无关，方便用例直接跑）。
 *
 * 链路：写分镜 → 缺图的镜头排队生图 → 配音 + 字幕 + 合成。
 *
 * 三条纪律（都踩过或差点踩）：
 *   1) **不偷偷改画面**：有镜头没生成出图就停下来问用户，不用纯色卡顶替、也不静默跳过；
 *   2) **不静默丢镜头**：没有画面提示词的镜头根本生不出图，要在合成前就报错说清楚；
 *   3) **不生吞缺配置**：生图引擎没配好（如 ModelScope 没填 Token）时如实报错（code 由界面处理），
 *      然后停下来问用户——用户补好配置后重跑即可（已生成的图不会重做）。
 *
 * 所有副作用（调 API、读写界面状态）都通过 deps 注入，所以用例可以拿假实现把每条分支走一遍。
 */
import type { Storyboard } from "../../shared/storyboard-types";
import type { BatchStartResult } from "../../shared/image-batch-types";

export type PipelineStage = "story" | "images" | "compose";
export type PipelineStatus = "running" | "done" | "waiting" | "error" | "cancelled";

export interface PipelineDeps {
  /** 调 AI 写分镜（花 token，所以 skipStory 时一次都不调） */
  generateStoryboard: () => Promise<Storyboard>;
  /** 从磁盘重读分镜（生图队列会把图写进镜头，界面要拿最新的） */
  loadBoard: (id: string) => Promise<Storyboard>;
  /** 启动后台批量生图队列 */
  startBatch: (boardId: string) => Promise<BatchStartResult>;
  /** 等队列收工（成功、失败、被中止都算收工） */
  waitBatch: () => Promise<void>;
  /** 合成视频，返回成片路径 */
  compose: (sb: Storyboard) => Promise<string>;
  /** 阶段播报（界面照这个画三步进度条） */
  onStage: (stage: PipelineStage, status: PipelineStatus, message: string, missing?: number) => void;
  /** 生图引擎没配置好：界面据此给出口（例如引导去设置页填 Token） */
  onNeedConfig?: () => void;
}

export interface PipelineResult {
  status: "done" | "waiting" | "error" | "cancelled";
  stage: PipelineStage;
  /** status=done 时的成片路径 */
  outputPath?: string;
  /** status=waiting 时还缺几张 */
  missing?: number;
  /** 人话原因（error / waiting 时给界面显示） */
  message: string;
}

export interface PipelineInput {
  /** 现有分镜（没有就先生成） */
  board: Storyboard | null;
  /**
   * 不重写分镜、沿用现有的。
   *
   * 界面按 shouldReuseStoryboard() 算好再传；「重试缺图，继续合成」那条路直接传 true。
   */
  skipStory: boolean;
}

/** 缺图的镜头（图 + 提示词都齐了才算不缺） */
function missingShots(sb: Storyboard): number {
  return sb.shots.filter((s) => !s.imagePath).length;
}

/** 有镜头没图、又没画面提示词：这种镜头生不出图，得让用户先补 */
function shotsWithoutPrompt(sb: Storyboard): number {
  return sb.shots.filter((s) => !s.imagePath && !s.imagePrompt.trim()).length;
}

/**
 * 「AI 成片」要不要沿用已有分镜？
 *
 * 以前只有一个入口时它总是重写分镜 —— 用户改过文案/提示词再点，就被 AI 覆盖了。
 * 现在「批量生图」那个独立入口去掉了，这条路必须自己修好：否则"只想补几张图"的用户
 * 每次都白花一次 AI 调用，还丢掉自己的修改。
 *
 * 规则：有分镜、且主题没改过 → 沿用；主题改了或还没有分镜 → 重写。
 * （没记过主题时保守沿用：冲掉用户的手改比多花一次调用糟。）
 */
export function shouldReuseStoryboard(
  board: Storyboard | null,
  boardTopic: string | null,
  currentTopic: string
): boolean {
  if (!board || !board.shots.length) return false;
  if (boardTopic === null) return true;
  return boardTopic.trim() === currentTopic.trim();
}

export async function runHotPipeline(
  input: PipelineInput,
  deps: PipelineDeps
): Promise<PipelineResult> {
  let stage: PipelineStage = "story";
  let cancelled = false;

  try {
    // ---- ① 分镜 ----
    let sb = input.board;
    if (!input.skipStory || !sb || !sb.shots.length) {
      deps.onStage("story", "running", "正在写分镜…");
      sb = await deps.generateStoryboard();
    } else {
      deps.onStage("story", "done", "沿用已有分镜");
    }
    if (!sb || !sb.shots.length) {
      stage = "story";
      const message = "分镜里没有镜头，没法成片。";
      deps.onStage(stage, "error", message);
      return { status: "error", stage, message };
    }

    // ---- ② 生图 ----
    stage = "images";
    const noPrompt = shotsWithoutPrompt(sb);
    if (noPrompt) {
      const message = `有 ${noPrompt} 个镜头没有画面提示词，成片前需要补上（或在分镜里删掉这些镜头）。`;
      deps.onStage(stage, "error", message);
      return { status: "error", stage, message };
    }
    let missing = missingShots(sb);
    if (missing) {
      deps.onStage("images", "running", `正在给 ${missing} 个缺图镜头排队生成（后台跑）…`);
      const started = await deps.startBatch(sb.id);
      if (!started.started) {
        const message = started.error || "批量生图没能启动，请稍后重试。";
        if (started.code === "ms-no-token") deps.onNeedConfig?.();
        deps.onStage(stage, "error", message);
        return { status: "error", stage, message };
      }
      await deps.waitBatch();
      // 队列收工后以磁盘为准重数（广播可能错过，只有磁盘是权威）
      sb = await deps.loadBoard(sb.id);
      missing = missingShots(sb);
      if (missing) {
        const message = `还有 ${missing} 张没生成出来。`;
        // 终态要自己播报：界面的三步进度条据此停在「生图」这一格等用户
        deps.onStage(stage, "waiting", message, missing);
        return { status: "waiting", stage, missing, message };
      }
    } else {
      deps.onStage("images", "done", "所有镜头都已有图");
    }

    // ---- ③ 合成 ----
    stage = "compose";
    deps.onStage("compose", "running", "正在配音 + 字幕 + 合成视频…");
    const outputPath = await deps.compose(sb);
    deps.onStage(stage, "done", "成片好了。");
    return { status: "done", stage, outputPath, message: "成片好了。" };
  } catch (e: unknown) {
    const raw = e instanceof Error ? e.message : String(e);
    cancelled = /已取消/.test(raw);
    const message = cancelled ? "已中止。" : raw;
    deps.onStage(stage, cancelled ? "cancelled" : "error", message);
    return { status: cancelled ? "cancelled" : "error", stage, message };
  }
}
