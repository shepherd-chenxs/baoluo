/**
 * 单镜一键生图的结果（T-004）。
 *
 * 放 shared 的理由同 doubao-batch-types：主进程产出、preload 与渲染层消费，
 * 而 preload 不能 import 主进程模块。
 *
 * 为什么不是一个 Storyboard 返回值：生图有四种「用户看得见的结局」，
 * 界面要做的事各不相同，而 Electron 跨进程只保留异常的 message（自定义属性会丢），
 * 所以必须用返回对象表达，不能用抛异常。
 */
import type { Storyboard } from "./storyboard-types";

export interface GenerateShotOutcome {
  ok: boolean;
  /** 成功且真的出了图 = 更新后的方案；只填词 / 失败时为 null（界面保持原样） */
  board: Storyboard | null;
  /** true = 只把提示词填进了豆包，没提交（设置里关了「生图时自动发送」） */
  filledOnly?: boolean;
  /**
   * 机器可读原因，界面据此决定显示哪些按钮（不直接给用户看）：
   * manual-submit / not-logged-in / not-open / not-rendered / no-input / no-editor /
   * no-send / send-disabled / timeout / fetch-timeout / fetch-empty / script /
   * empty-prompt / batch-running / no-shot / no-window / attach-failed / unknown
   */
  code?: string;
  /** 中文人话，可直接显示；不含英文错误码与堆栈 */
  message?: string;
}
