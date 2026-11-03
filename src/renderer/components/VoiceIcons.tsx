/**
 * 试听用的两个图标：喇叭（可点）和沙漏（正在合成）。
 *
 * 抽出来是因为工作台和「视频生成」页都要用同一对——各写一份 SVG 迟早画歪。
 * 样式走全局的 .speaker-icon / .speaker-svg，所以尺寸由调用处的按钮决定。
 */
import type { ReactNode } from "react";

export function SpeakerIcon(): ReactNode {
  return (
    <svg
      className="speaker-svg"
      viewBox="0 0 24 24"
      width="16"
      height="16"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden
    >
      <path d="M11 5 6 9H2v6h4l5 4V5z" />
      <path d="M15.54 8.46a5 5 0 0 1 0 7.07" />
      <path d="M19.07 4.93a10 10 0 0 1 0 14.14" />
    </svg>
  );
}

/** 沙漏图标（合成/等待播放时显示，与播放状态区分） */
export function HourglassIcon(): ReactNode {
  return (
    <svg
      className="speaker-svg"
      viewBox="0 0 24 24"
      width="16"
      height="16"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden
    >
      <path d="M5 22h14" />
      <path d="M5 2h14" />
      <path d="M17 22v-4.17a2 2 0 0 0-.59-1.42L12 12l-4.41 4.41A2 2 0 0 0 7 17.83V22" />
      <path d="M7 2v4.17a2 2 0 0 0 .59 1.42L12 12l4.41-4.41A2 2 0 0 0 17 6.17V2" />
    </svg>
  );
}
