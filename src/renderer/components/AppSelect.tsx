/*
 * SPDX-License-Identifier: GPL-3.0-only
 * Copyright (c) 2026 宝螺 / Baoluo contributors
 * 本文件属于「宝螺 / Baoluo」。除 GPL-3.0 外还适用 ADDITIONAL_TERMS.md 里的附加条款：
 * 分发时须保留来源署名；修改版对外分发时不得沿用「宝螺」名称与图标。
 */
import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";

/** 自定义下拉：原生 select 的弹层是系统菜单，CSS 控制不了选项高度，改用这个。
 *  v0.3.1：菜单通过 React Portal 渲染到 document.body，position: fixed 定位，
 *  并按视口空间自动选择开口方向，避免与下方 <textarea> 等同级元素冲突。
 *  点菜单空白 padding 也可关菜单，方便用户随手取消。
 */
type Props = {
  value: string;
  options: Array<{ value: string; label: string }>;
  onChange: (v: string) => void;
  title?: string;
  /** 只读（过程态）：框还在、样子不变，但点不开菜单 */
  disabled?: boolean;
  /**
   * 触发框里没选中任何选项时显示的字（如「用模板」）。
   * 只出现在触发框上，**不进菜单**——它不是选项，是"这个控件是干嘛的"。
   */
  placeholder?: string;
};

type MenuPos = { top: number; left: number; width: number; placement: "down" | "up" };

const VIEWPORT_GAP = 4;
const VIEWPORT_PADDING = 8;

export default function AppSelect(props: Props) {
  const [open, setOpen] = useState(false);
  const [menuPos, setMenuPos] = useState<MenuPos | null>(null);
  /** 菜单被夹窄到装不下最长选项时，选项文字改成换行（否则会从菜单里横着溢出去） */
  const [optionsWrap, setOptionsWrap] = useState(false);
  const wrapRef = useRef<HTMLDivElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);

  const recalcPos = () => {
    const el = triggerRef.current;
    if (!el) return;
    const r = el.getBoundingClientRect();
    const vh = window.innerHeight;
    const estH = Math.min(280, Math.max(60, props.options.length * 44 + 12));
    const spaceBelow = vh - r.bottom - VIEWPORT_GAP - VIEWPORT_PADDING;
    const spaceAbove = r.top - VIEWPORT_GAP - VIEWPORT_PADDING;
    const placement: "down" | "up" =
      spaceBelow >= estH || spaceBelow >= spaceAbove ? "down" : "up";
    // "up" 时菜单底边贴在 trigger.top 上方；"down" 时菜单顶边贴在 trigger.bottom 下方
    const top =
      placement === "down"
        ? r.bottom + VIEWPORT_GAP
        : Math.max(VIEWPORT_PADDING, r.top - VIEWPORT_GAP - estH);
    // 宽度：不低于触发按钮，但允许按最长的选项撑开（否则「无（静止）」这类标签会折行）；
    // 撑开后再把左右收进视口，避免菜单跑出屏幕
    const measured = menuRef.current?.offsetWidth ?? 0;
    /*
     * 上限兜底：这里量的是菜单自己（width: max-content）。首帧只贴在 body 上量，
     * 量出来的值偶尔会大得离谱（整个视口那么宽），菜单就被拉成一条横贯屏幕的白条。
     * 所以把宽度夹在「触发按钮宽 ~ 触发框最大可用宽」之间 —— 选项再长也只是折行，
     * 不会把弹层撑爆。
     */
    const maxWidth = Math.max(
      r.width,
      Math.min(320, window.innerWidth - r.left - VIEWPORT_GAP - VIEWPORT_PADDING)
    );
    const width = Math.min(Math.max(r.width, measured), maxWidth);
    // 宽度算窄了（选项比按钮宽，且已经顶到上限）就换行显示，别让文字从菜单里溢出去
    setOptionsWrap(measured > width + 1);
    const left = Math.max(
      VIEWPORT_PADDING,
      Math.min(r.left, window.innerWidth - width - VIEWPORT_PADDING)
    );
    setMenuPos({ top, left, width, placement });
  };

  useEffect(() => {
    if (!open) return;
    recalcPos();
    const onWin = () => recalcPos();
    window.addEventListener("scroll", onWin, true);
    window.addEventListener("resize", onWin);

    const onDocPointer = (e: MouseEvent) => {
      const target = e.target as Node | null;
      if (!target) return;
      if (triggerRef.current && triggerRef.current.contains(target)) return;
      if (menuRef.current && menuRef.current.contains(target)) return;
      setOpen(false);
    };
    document.addEventListener("mousedown", onDocPointer, true);
    return () => {
      window.removeEventListener("scroll", onWin, true);
      window.removeEventListener("resize", onWin);
      document.removeEventListener("mousedown", onDocPointer, true);
    };
  }, [open, props.options.length]);

  // ESC 关闭菜单
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setOpen(false);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open]);

  // 首帧只能按触发按钮的宽度定位；菜单挂载后再按真实内容宽度校正一次左右贴边
  useEffect(() => {
    if (!open) return;
    const id = requestAnimationFrame(() => recalcPos());
    return () => cancelAnimationFrame(id);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  const current = props.options.find((o) => o.value === props.value);
  return (
    <div className="app-select" ref={wrapRef}>
      <button
        type="button"
        ref={triggerRef}
        className="app-select-trigger"
        disabled={props.disabled}
        onClick={() => {
          if (props.disabled) return;
          setOpen((v) => !v);
        }}
        title={props.title}
      >
        <span className="app-select-label">{current?.label ?? props.placeholder ?? props.value}</span>
        <span className="app-select-caret">{open ? "▴" : "▾"}</span>
      </button>
      {open && menuPos && !props.disabled && createPortal(
        <div
          ref={menuRef}
          className={`app-select-menu app-select-menu-${menuPos.placement}${
            optionsWrap ? " wrap-options" : ""
          }`}
          style={{
            position: "fixed",
            top: menuPos.top,
            left: menuPos.left,
            minWidth: menuPos.width,
          }}
          // 点菜单空白 padding 时关菜单；点 option 由 option 自己的 onClick 处理
          onClick={(e) => {
            if (e.target === e.currentTarget) setOpen(false);
          }}
        >
          {props.options.map((o) => (
            <button
              type="button"
              key={o.value}
              className={`app-select-option ${o.value === props.value ? "selected" : ""}`}
              onClick={() => {
                props.onChange(o.value);
                setOpen(false);
              }}
            >
              {o.label}
            </button>
          ))}
        </div>,
        document.body
      )}
    </div>
  );
}
