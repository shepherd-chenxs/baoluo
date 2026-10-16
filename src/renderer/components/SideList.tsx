/*
 * SPDX-License-Identifier: GPL-3.0-only
 * Copyright (c) 2026 宝螺 / Baoluo contributors
 * 本文件属于「宝螺 / Baoluo」。除 GPL-3.0 外还适用 ADDITIONAL_TERMS.md 里的附加条款：
 * 分发时须保留来源署名；修改版对外分发时不得沿用「宝螺」名称与图标。
 */
/**
 * 左栏列表 + 右区内容：视频生成那四个页面（图文解说 / 对话模式 / 热点成片 / 爆款嗅探）共用。
 *
 * 为什么抽出来：热点成片先有了这套"左边翻历史、右边干活"的分栏，另外三页要一样的
 * 长相与手感；各写一份必然越走越偏（尺寸、分隔线、空列表提示都会慢慢不一样）。
 * 这里只负责长相与骨架，列表里放什么、点什么由调用方决定。
 */
import type { ReactNode } from "react";

export interface SideListProps {
  /** 左栏顶部的导航块（App 传下来的 SideNav）；给了就画在最上面 */
  nav?: ReactNode;
  /** 左栏顶部的大标题（页面名）。二级菜单进左栏后页名会重复，可以不给 */
  title?: string;
  /** 标题下面那行的小节名（方案 / 记录 / 历史…） */
  section: string;
  /** 小节名右边的动作（通常是「＋ 新建」） */
  action?: ReactNode;
  /** 有内容就渲染 items，没有就渲染 empty */
  hasItems: boolean;
  empty?: ReactNode;
  /** 列表里的行 */
  items?: ReactNode;
  /** 左栏底部常驻的东西（如整页级入口）；列表用 flex:1 占满剩余空间，它自然贴底 */
  footer?: ReactNode;
  /** 右区 */
  children: ReactNode;
}

export default function SideList({
  nav,
  title,
  section,
  action,
  hasItems,
  empty,
  items,
  footer,
  children,
}: SideListProps) {
  return (
    <div className="split">
      <aside className="split-list">
        {nav}
        {title && <h2 className="split-title">{title}</h2>}
        <div className="split-list-head">
          <span className="panel-title">{section}</span>
          {action}
        </div>
        {hasItems ? (
          <div className="split-items">{items}</div>
        ) : (
          <div className="split-empty">{empty}</div>
        )}
        {/* 底部入口：flex 里 items 占满剩余空间，所以它自然贴在下面 */}
        {footer && <div className="split-foot">{footer}</div>}
      </aside>
      <div className="split-work">{children}</div>
    </div>
  );
}

/**
 * 给本来没有左栏的页（语音三页 / 设置 / 关于）补一条左栏装导航：
 * 骨架与 SideList 同款（.split），右区就是页面原来的内容。
 */
export function NavPage({ nav, children }: { nav?: ReactNode; children: ReactNode }) {
  return (
    <div className="split">
      <aside className="split-list">{nav}</aside>
      <div className="split-work">{children}</div>
    </div>
  );
}

export interface SideRowProps {
  title: string;
  /** 次行左边那串（几镜 / 几图 / 平台…） */
  meta?: ReactNode;
  /** 成片了没有：有就打绿标 */
  done?: boolean;
  /** 次行最右边的时间 */
  time?: string;
  active?: boolean;
  onOpen: () => void;
  /** 不给就没有删除按钮 */
  onDelete?: () => void;
  deleteLabel?: string;
  /** 整行的悬停说明（标题被截断时有用） */
  hint?: string;
}

/** 列表里的一行：主标题 + 次行meta +（可选）删除 */
export function SideRow({
  title,
  meta,
  done,
  time,
  active,
  onOpen,
  onDelete,
  deleteLabel,
  hint,
}: SideRowProps) {
  return (
    <div className={`side-row${active ? " active" : ""}`}>
      <button type="button" className="side-item" onClick={onOpen} title={hint ?? title}>
        <span className="side-item-title">{title}</span>
        <span className="side-item-meta">
          {meta}
          {done && <span className="side-done">已成片</span>}
          {time && <span>{time}</span>}
        </span>
      </button>
      {onDelete && (
        <button
          type="button"
          className="side-del"
          onClick={onDelete}
          title={deleteLabel ?? "删除这一条"}
          aria-label={deleteLabel ?? `删除 ${title}`}
        >
          ✕
        </button>
      )}
    </div>
  );
}

/** 列表里的时间：今天只给时刻，往前给日期（一屏里看的是「哪份最近动过」） */
export function formatListTime(ts: number): string {
  const d = new Date(ts);
  const today = new Date();
  const sameDay = d.toDateString() === today.toDateString();
  const hh = String(d.getHours()).padStart(2, "0");
  const mm = String(d.getMinutes()).padStart(2, "0");
  return sameDay ? `${hh}:${mm}` : `${d.getMonth() + 1}月${d.getDate()}日`;
}
