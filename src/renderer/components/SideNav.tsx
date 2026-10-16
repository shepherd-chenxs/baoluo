/*
 * SPDX-License-Identifier: GPL-3.0-only
 * Copyright (c) 2026 宝螺 / Baoluo contributors
 * 本文件属于「宝螺 / Baoluo」。除 GPL-3.0 外还适用 ADDITIONAL_TERMS.md 里的附加条款：
 * 分发时须保留来源署名；修改版对外分发时不得沿用「宝螺」名称与图标。
 */
/**
 * 左侧导航（一级 + 二级 + 底部关于/授权），挂在每页自己的左栏顶部。
 *
 * 为什么在各页左栏里而不是全局一条：工作台和视频四个页本来就有左栏
 * （任务/方案列表），导航再单独占一条就成了双左栏，宽度吃不起。
 * 所以导航做成一块「积木」由 App 传下来，各页塞进自己左栏的最上面；
 * 没有左栏的页（语音三页 / 设置 / 关于）用 .split 补一条。
 *
 * 菜单数据仍由 App 传进来——路由逻辑集中在 App 一处（tab/videoPage/voicePage/
 * settingsPage 四个状态都在那儿），这里只负责画。
 *
 * 二级菜单显隐：哪个一级项亮着就展开哪个的子项（「子页面把二级放左侧」）。
 * 一级项都可直接点击跳转（组项跳到第一个子页）。
 */
import { type ReactNode } from "react";

export type TabKey =
  | "workspace"
  | "video"
  | "voice"
  | "story"
  | "sniff"
  | "tts"
  | "convert"
  | "asr"
  | "settings"
  | "about";
export type SettingsPageKey = "subtitle" | "voices" | "clone" | "ai" | "general";
/** 视频生成的子页面：图文解说 / 两人对话（各自独立一页，共用一套生成逻辑） */
export type VideoPageKey = "narration" | "dialogue";

export interface NavItem {
  key: string;
  label: string;
  tip?: string;
  active: boolean;
  onClick?: () => void;
  /** 二级菜单：一级项亮着时展开在它下面 */
  sub?: Array<{ key: string; label: string; active: boolean; onClick: () => void }>;
}

interface SideNavProps {
  items: NavItem[];
  /** 点「关于」去哪 */
  onOpenAbout: () => void;
}

/* 一级项的小图标：16×16 线性，currentColor 跟着文字变色 */
const stroke = { fill: "none", stroke: "currentColor", strokeWidth: 1.5 } as const;
const icons: Record<string, ReactNode> = {
  workspace: (
    <svg width="16" height="16" viewBox="0 0 16 16" aria-hidden="true">
      <path d="M8 1.5 L9.7 6.3 L14.5 8 L9.7 9.7 L8 14.5 L6.3 9.7 L1.5 8 L6.3 6.3 Z" {...stroke} strokeLinejoin="round" />
    </svg>
  ),
  video: (
    <svg width="16" height="16" viewBox="0 0 16 16" aria-hidden="true">
      <rect x="1.8" y="3.2" width="12.4" height="9.6" rx="2" {...stroke} />
      <path d="M6.6 6.1l3.6 1.9-3.6 1.9z" fill="currentColor" stroke="none" />
    </svg>
  ),
  voice: (
    <svg width="16" height="16" viewBox="0 0 16 16" aria-hidden="true">
      <rect x="5.8" y="1.8" width="4.4" height="8" rx="2.2" {...stroke} />
      <path d="M3.5 7.5a4.5 4.5 0 0 0 9 0 M8 12v2.2" {...stroke} strokeLinecap="round" />
    </svg>
  ),
  settings: (
    <svg width="16" height="16" viewBox="0 0 16 16" aria-hidden="true">
      <path d="M2.5 4.5h11 M2.5 8h11 M2.5 11.5h11" {...stroke} strokeLinecap="round" />
      <circle {...stroke} cx="6" cy="4.5" r="1.4" fill="#fff" />
      <circle {...stroke} cx="10.5" cy="8" r="1.4" fill="#fff" />
      <circle {...stroke} cx="5" cy="11.5" r="1.4" fill="#fff" />
    </svg>
  ),
  about: (
    <svg width="16" height="16" viewBox="0 0 16 16" aria-hidden="true">
      <circle cx="8" cy="8" r="6.2" {...stroke} />
      <path d="M8 7.2v3.6" {...stroke} strokeLinecap="round" />
      <circle cx="8" cy="5" r="0.9" fill="currentColor" stroke="none" />
    </svg>
  ),
};

export default function SideNav({ items, onOpenAbout }: SideNavProps): ReactNode {
  return (
    <nav className="side-nav">
      <div className="side-nav-group">
        {items.map((item) => (
          <div key={item.key} className="side-nav-cell">
            <button
              type="button"
              className={`side-nav-item${item.active ? " active" : ""}`}
              title={item.tip ?? item.label}
              onClick={item.onClick}
            >
              {icons[item.key] && <span className="side-nav-icon">{icons[item.key]}</span>}
              <span>{item.label}</span>
            </button>
            {item.sub && item.active && (
              <div className="side-nav-sub">
                {item.sub.map((s) => (
                  <button
                    key={s.key}
                    type="button"
                    className={`side-nav-subitem${s.active ? " active" : ""}`}
                    onClick={s.onClick}
                  >
                    {s.label}
                  </button>
                ))}
              </div>
            )}
          </div>
        ))}
      </div>
      <div className="side-nav-foot">
        <button
          type="button"
          className="side-nav-item"
          title="版本 / 关于"
          onClick={onOpenAbout}
        >
          <span className="side-nav-icon">{icons.about}</span>
          <span>关于</span>
        </button>
      </div>
    </nav>
  );
}
