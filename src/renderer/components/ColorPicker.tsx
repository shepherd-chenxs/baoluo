/*
 * SPDX-License-Identifier: GPL-3.0-only
 * Copyright (c) 2026 宝螺 / Baoluo contributors
 * 本文件属于「宝螺 / Baoluo」。除 GPL-3.0 外还适用 ADDITIONAL_TERMS.md 里的附加条款：
 * 分发时须保留来源署名；修改版对外分发时不得沿用「宝螺」名称与图标。
 */
import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";

/**
 * ColorPicker — 轻量取色弹窗。
 *
 * 为什么不直接用 `<input type="color">`：它的弹层是浏览器原生菜单，CSS 改不了，
 * 也没法在里面塞「无色」这种额外选项。所以自己做一层：
 *   常用色块 + 无色（可选）+ 自定义（原生取色器 / 手输 #RRGGBB）。
 * 定位方式与 AppSelect 一致：portal 到 body + fixed + 视口内收边 + 空间不够时向上开。
 */
export type ColorValue = string; // "#RRGGBB" 或 "transparent"

const PRESET_COLORS = [
  "#FFFFFF",
  "#FFD400",
  "#FF9500",
  "#FF3B30",
  "#34C759",
  "#00C7BE",
  "#007AFF",
  "#5856D6",
  "#AF52DE",
  "#000000",
];

const MENU_WIDTH = 232;
const VIEWPORT_GAP = 4;
const VIEWPORT_PADDING = 8;

/** "transparent" = 无色（不画底色） */
function isTransparentColor(v: string): boolean {
  return v.trim().toLowerCase() === "transparent";
}

function toHex(v: string): string {
  const m = /^#([0-9a-fA-F]{6})$/.exec(v.trim());
  return m ? m[0].toLowerCase() : "#000000";
}

export default function ColorPicker(props: {
  value: ColorValue;
  onChange: (v: ColorValue) => void;
  /** 允许选「无色」（字幕底色这种可以不画的场景） */
  allowTransparent?: boolean;
  title?: string;
  disabled?: boolean;
}) {
  const [open, setOpen] = useState(false);
  const [pos, setPos] = useState<{ top: number; left: number; placement: "down" | "up" } | null>(
    null
  );
  const [draftHex, setDraftHex] = useState(toHex(props.value));
  const triggerRef = useRef<HTMLButtonElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);

  const transparent = props.allowTransparent && isTransparentColor(props.value);

  useEffect(() => {
    setDraftHex(toHex(props.value));
  }, [props.value]);

  useEffect(() => {
    if (!open) return;
    const el = triggerRef.current;
    if (!el) return;
    const r = el.getBoundingClientRect();
    const estH = 190;
    const spaceBelow = window.innerHeight - r.bottom - VIEWPORT_GAP - VIEWPORT_PADDING;
    const placement: "down" | "up" =
      spaceBelow >= estH || spaceBelow >= r.top ? "down" : "up";
    const top =
      placement === "down"
        ? r.bottom + VIEWPORT_GAP
        : Math.max(VIEWPORT_PADDING, r.top - VIEWPORT_GAP - estH);
    const left = Math.max(
      VIEWPORT_PADDING,
      Math.min(r.left, window.innerWidth - MENU_WIDTH - VIEWPORT_PADDING)
    );
    setPos({ top, left, placement });

    const onDocPointer = (e: MouseEvent) => {
      const target = e.target as Node | null;
      if (!target) return;
      if (triggerRef.current?.contains(target)) return;
      if (menuRef.current?.contains(target)) return;
      setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setOpen(false);
    };
    const closeOnViewportChange = () => setOpen(false);
    window.addEventListener("scroll", closeOnViewportChange, true);
    window.addEventListener("resize", closeOnViewportChange);
    document.addEventListener("mousedown", onDocPointer, true);
    window.addEventListener("keydown", onKey);
    return () => {
      window.removeEventListener("scroll", closeOnViewportChange, true);
      window.removeEventListener("resize", closeOnViewportChange);
      document.removeEventListener("mousedown", onDocPointer, true);
      window.removeEventListener("keydown", onKey);
    };
  }, [open]);

  function pick(v: ColorValue) {
    props.onChange(v);
    setOpen(false);
  }

  return (
    <div className="color-picker">
      <button
        type="button"
        ref={triggerRef}
        className={`color-picker-trigger ${transparent ? "is-transparent" : ""}`}
        disabled={props.disabled}
        title={props.title ?? (transparent ? "无色（不画底色）" : props.value)}
        onClick={() => setOpen((v) => !v)}
      >
        <span
          className={`color-picker-swatch ${transparent ? "is-transparent" : ""}`}
          style={transparent ? undefined : { background: toHex(props.value) }}
        />
        <span className="app-select-caret">▾</span>
      </button>

      {open &&
        pos &&
        createPortal(
          <div
            ref={menuRef}
            className="color-picker-menu"
            style={{ position: "fixed", top: pos.top, left: pos.left, width: MENU_WIDTH }}
            onClick={(e) => {
              if (e.target === e.currentTarget) setOpen(false);
            }}
          >
            <div className="color-picker-grid">
              {props.allowTransparent && (
                <button
                  type="button"
                  className={`color-picker-cell color-picker-cell-none ${transparent ? "selected" : ""}`}
                  title="无色（不画底色）"
                  onClick={() => pick("transparent")}
                />
              )}
              {PRESET_COLORS.map((c) => (
                <button
                  type="button"
                  key={c}
                  className={`color-picker-cell ${
                    !transparent && toHex(props.value) === c.toLowerCase() ? "selected" : ""
                  }`}
                  style={{ background: c }}
                  title={c}
                  onClick={() => pick(c)}
                />
              ))}
            </div>

            <div className="color-picker-custom">
              <input
                type="color"
                className="color-picker-native"
                value={draftHex}
                title="自定义颜色"
                onChange={(e) => {
                  setDraftHex(e.target.value);
                  props.onChange(e.target.value);
                }}
              />
              <input
                className="color-picker-hex"
                value={draftHex}
                spellCheck={false}
                onChange={(e) => {
                  const v = e.target.value;
                  setDraftHex(v);
                  if (/^#[0-9a-fA-F]{6}$/.test(v.trim())) props.onChange(v.trim().toLowerCase());
                }}
                onBlur={() => setDraftHex(toHex(props.value))}
              />
              <span className="hint">自定义</span>
            </div>
          </div>,
          document.body
        )}
    </div>
  );
}
