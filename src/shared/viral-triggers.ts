/** 可引爆的 7 类观众心理：整篇只允许选 1 个主类型（v0.5 与 v0.6 共用） */
export const VIRAL_TRIGGERS = [
  "观众想纠正你",
  "观众想看结果",
  "观众想看翻车",
  "观众想辩论真伪",
  "观众想证明自己",
  "观众想给你支招",
  "观众想代入自己",
] as const;

export type ViralTrigger = (typeof VIRAL_TRIGGERS)[number];

export function isViralTrigger(value: string): value is ViralTrigger {
  return (VIRAL_TRIGGERS as readonly string[]).includes(value);
}
