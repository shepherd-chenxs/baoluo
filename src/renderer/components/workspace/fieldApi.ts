/*
 * SPDX-License-Identifier: GPL-3.0-only
 * Copyright (c) 2026 宝螺 / Baoluo contributors
 * 本文件属于「宝螺 / Baoluo」。除 GPL-3.0 外还适用 ADDITIONAL_TERMS.md 里的附加条款：
 * 分发时须保留来源署名；修改版对外分发时不得沿用「宝螺」名称与图标。
 */
/**
 * 步骤里的参数控件要跟工作台主组件打交道：读值、改值、提交、选文件、取图片地址。
 *
 * 把这些收成一个薄接口，各类控件（普通参数、人物卡）就能搬到自己的文件里，
 * 主组件只负责实现它——而不是每加一种步骤就往 WorkspaceView 里塞一个 renderXxx。
 */
import type { AgentParam, AgentStep } from "../../../shared/agent-types";

export interface StepFieldApi {
  /** 当前值：含还没提交的本地编辑 */
  valueOf(step: AgentStep, p: AgentParam): string;
  /** 只改本地（输入中），不提交 */
  setLocal(step: AgentStep, p: AgentParam, value: string): void;
  /** 提交（失焦 / 松手时） */
  commit(step: AgentStep, p: AgentParam, value: string): void;
  /** 弹文件框选一张图/一个音视频 */
  pickFile(step: AgentStep, p: AgentParam): void;
  /**
   * 试听一个音色参数（voice* 的下拉旁有个「试听」按钮）。
   * 语速取同一步骤里配套的语速参数（rateNarrator / rate），没有就按默认念。
   */
  preview?: (step: AgentStep, p: AgentParam) => void;
  /** 正在试听的是哪一项（field:paramKey / A / B）；null = 没在放 */
  previewing?: string | null;
  /** 图片路径 → 能塞进 <img> 的地址 */
  imageUrls: Record<string, string>;
}
