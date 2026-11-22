/**
 * 爆款拆解报告的纯文本格式（2026-11-22 从 agent/tools.ts 抽出）：
 * GUI 的任务卡（tools.ts 的 sniff 步骤）与 headless 入口（宝螺的 MCP 服务，
 * 见 src/headless）写的是同一份「爆款拆解.txt」—— 两个调用方，一份格式。
 */
import type { SniffRecord } from "../../shared/sniff-types";

export function renderSniffReport(rec: SniffRecord): string {
  const a = rec.analysis;
  const lines: string[] = [
    `原片：${rec.source.title}`,
    `作者 / 平台：${rec.source.author} · ${rec.source.platform}`,
    `链接：${rec.source.url}`,
    "",
    `引爆类型：${a.trigger}`,
    `开头钩子：${a.hook}`,
    "",
    "叙事结构：",
    ...a.structure.map((s, i) => `  ${i + 1}. ${s}`),
    "",
    `可复用方法：${a.reusable}`,
  ];
  if (a.commentBait) lines.push("", `互动埋点：${a.commentBait}`);
  if (a.topics?.length) {
    lines.push("", "同方法的选题：", ...a.topics.map((t) => `  · ${t}`));
  }
  lines.push("", "——— 原片文案 ———", rec.transcript);
  return lines.join("\n");
}
