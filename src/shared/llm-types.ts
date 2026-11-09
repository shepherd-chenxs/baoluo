/**
 * 「文本生成走哪条路」的共享形状（主进程算、界面显示）。
 *
 * 两条路：应用了运行时 → 交给人已经登录好的 CLI；没接运行时 → 老「AI 服务」的 Key。
 * 界面只拿 label 一句话（「Codex CLI」/「AI 服务 · deepseek-chat」），不关心底层协议。
 */
import type { RuntimeId } from "./runtime-types";

export type LlmSource = "runtime" | "api" | "none";

export interface LlmRoute {
  source: LlmSource;
  runtimeId: RuntimeId | null;
  /** 界面上直接显示：「Codex CLI」/「AI 服务 · deepseek-chat」/ 空 */
  label: string;
  /** 一条路都没有时给用户看的下一步 */
  message?: string;
}
