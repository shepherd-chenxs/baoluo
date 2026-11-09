/**
 * 左侧导航（一级 + 二级 + 底部组），挂在每页自己的左栏顶部。
 *
 * 为什么在各页左栏里而不是全局一条：工作台和视频四个页本来就有左栏
 * （任务/方案列表），导航再单独占一条就成了双左栏，宽度吃不起。
 * 所以导航做成一块「积木」由 App 传下来，各页塞进自己左栏的最上面；
 * 没有左栏的页（素材捕手 / 语音三页 / 设置 / 关于）用 .split 补一条。
 *
 * 菜单数据仍由 App 传进来——路由逻辑集中在 App 一处（tab/videoPage/voicePage/
 * settingsPage 四个状态都在那儿），这里只负责画。
 *
 * 二级菜单显隐：哪个一级项亮着就展开哪个的子项（「子页面把二级放左侧」）。
 * 一级项都可直接点击跳转（组项跳到第一个子页）。
 * bottomItems 沉底（margin-top:auto）：设置这类低频入口固定在左栏最下面。
 */
import { useState, type ReactNode } from "react";

export type TabKey =
  | "workspace"
  | "materials"
  | "video"
  | "voice"
  | "story"
  | "sniff"
  | "textcard"
  | "tts"
  | "asr"
  | "settings"
  | "about";
export type SettingsPageKey = "subtitle" | "voices" | "clone" | "ai" | "runtime" | "plugins" | "general";
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
  /** 沉底的项（设置组）：margin-top:auto 压到左栏最下面 */
  bottomItems?: NavItem[];
}

/* 一级项的小图标：16×16 线性，currentColor 跟着文字变色 */
const stroke = { fill: "none", stroke: "currentColor", strokeWidth: 1.5 } as const;
const icons: Record<string, ReactNode> = {
  workspace: (
    <svg width="16" height="16" viewBox="0 0 16 16" aria-hidden="true">
      <path d="M8 1.5 L9.7 6.3 L14.5 8 L9.7 9.7 L8 14.5 L6.3 9.7 L1.5 8 L6.3 6.3 Z" {...stroke} strokeLinejoin="round" />
    </svg>
  ),
  materials: (
    <svg width="16" height="16" viewBox="0 0 16 16" aria-hidden="true">
      <path d="M8 2v7 M4.8 6.2 8 9.4l3.2-3.2" {...stroke} strokeLinecap="round" strokeLinejoin="round" />
      <path d="M2.5 12.5h11" {...stroke} strokeLinecap="round" />
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
  /* —— 设置页左栏的子页菜单（App settingsNav 平铺的那几项）—— */
  general: (
    <svg width="16" height="16" viewBox="0 0 16 16" aria-hidden="true">
      <circle cx="8" cy="8" r="2.1" {...stroke} />
      <path
        d="M8 1.8v2 M8 12.2v2 M1.8 8h2 M12.2 8h2 M3.6 3.6 5 5 M11 11l1.4 1.4 M12.4 3.6 11 5 M5 11l-1.4 1.4"
        {...stroke}
        strokeLinecap="round"
      />
    </svg>
  ),
  subtitle: (
    <svg width="16" height="16" viewBox="0 0 16 16" aria-hidden="true">
      <rect x="1.8" y="3" width="12.4" height="10" rx="2" {...stroke} />
      <path d="M4.4 7h7.2 M4.4 10h3.6 M10.4 10h1.2" {...stroke} strokeLinecap="round" />
    </svg>
  ),
  voices: (
    <svg width="16" height="16" viewBox="0 0 16 16" aria-hidden="true">
      <path d="M3 6.5v3 M5.5 4.5v7 M8 2.8v10.4 M10.5 4.5v7 M13 6.5v3" {...stroke} strokeLinecap="round" />
    </svg>
  ),
  clone: (
    <svg width="16" height="16" viewBox="0 0 16 16" aria-hidden="true">
      <rect x="5.5" y="5.5" width="8" height="8" rx="1.6" {...stroke} />
      <path d="M10.5 2.5H4.4A1.9 1.9 0 0 0 2.5 4.4v6.1" {...stroke} strokeLinecap="round" />
    </svg>
  ),
  ai: (
    <svg width="16" height="16" viewBox="0 0 16 16" aria-hidden="true">
      <path d="M6.5 2.5 7.6 5.9 11 7 7.6 8.1 6.5 11.5 5.4 8.1 2 7l3.4-1.1z" {...stroke} strokeLinejoin="round" />
      <path d="M11.8 9.2l.7 2.1 2.1.7-2.1.7-.7 2.1-.7-2.1-2.1-.7 2.1-.7z" fill="currentColor" stroke="none" />
    </svg>
  ),
  runtime: (
    <svg width="16" height="16" viewBox="0 0 16 16" aria-hidden="true">
      <rect x="1.8" y="2.6" width="12.4" height="10.8" rx="2" {...stroke} />
      <path d="M4.4 6.2 6.3 8l-1.9 1.8" {...stroke} strokeLinecap="round" strokeLinejoin="round" />
      <path d="M8.4 9.8h3.2" {...stroke} strokeLinecap="round" />
    </svg>
  ),
  plugins: (
    <svg width="16" height="16" viewBox="0 0 16 16" aria-hidden="true">
      <rect x="2.2" y="2.2" width="5" height="5" rx="1.2" {...stroke} />
      <rect x="8.8" y="2.2" width="5" height="5" rx="1.2" {...stroke} />
      <rect x="2.2" y="8.8" width="5" height="5" rx="1.2" {...stroke} />
      <rect x="8.8" y="8.8" width="5" height="5" rx="1.2" {...stroke} />
    </svg>
  ),
};

/* 「关于」在设置菜单里以 about-entry 这个 key 出现，复用同一枚图标 */
icons["about-entry"] = icons.about;

/** 一级项 + 二级菜单的统一渲染（顶部组用；底部组走弹出菜单，见 BottomNavItem） */
function renderItems(items: NavItem[]): ReactNode {
  return items.map((item) => (
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
  ));
}

/**
 * 沉底项（设置）：点击**弹出子菜单浮层**，不再把二级菜单展开在侧栏里。
 *
 * 为什么弹窗：设置子页有 7 项，展开在侧栏底部会占掉半栏（还得把上面的
 * 任务列表挤走）；浮层只在需要时出现，点空白处或选完即收。
 * 带子菜单的沉底项点击只开关浮层；没有子菜单的照常直接 onClick。
 */
function BottomNavItem({ item }: { item: NavItem }): ReactNode {
  const [open, setOpen] = useState(false);
  const hasSub = !!item.sub?.length;
  return (
    <div className="side-nav-cell side-nav-cell-bottom">
      {/* 兜底层：点浮层外面任何地方都收起 */}
      {open && <div className="side-nav-backdrop" onClick={() => setOpen(false)} />}
      <button
        type="button"
        className={`side-nav-item${item.active ? " active" : ""}${open ? " open" : ""}`}
        title={item.tip ?? item.label}
        onClick={() => {
          if (hasSub) setOpen((v) => !v);
          else item.onClick?.();
        }}
      >
        {icons[item.key] && <span className="side-nav-icon">{icons[item.key]}</span>}
        <span>{item.label}</span>
      </button>
      {open && hasSub && (
        <div className="side-nav-popup" role="menu">
          {item.sub!.map((s) => (
            <button
              key={s.key}
              type="button"
              role="menuitem"
              className={`side-nav-popup-item${s.active ? " active" : ""}`}
              onClick={() => {
                setOpen(false);
                s.onClick();
              }}
            >
              {s.label}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

export default function SideNav({ items, bottomItems }: SideNavProps): ReactNode {
  return (
    <nav className="side-nav">
      <div className="side-nav-group">{renderItems(items)}</div>
      {bottomItems && bottomItems.length > 0 && (
        <div className="side-nav-foot">
          <div className="side-nav-group">
            {bottomItems.map((item) =>
              item.sub?.length ? (
                <BottomNavItem key={item.key} item={item} />
              ) : (
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
                </div>
              ),
            )}
          </div>
        </div>
      )}
    </nav>
  );
}
