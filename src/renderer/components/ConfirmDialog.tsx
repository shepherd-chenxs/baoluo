/*
 * SPDX-License-Identifier: GPL-3.0-only
 * Copyright (c) 2026 宝螺 / Baoluo contributors
 * 本文件属于「宝螺 / Baoluo」。除 GPL-3.0 外还适用 ADDITIONAL_TERMS.md 里的附加条款：
 * 分发时须保留来源署名；修改版对外分发时不得沿用「宝螺」名称与图标。
 */
/**
 * 删除确认框（Promise 风格的轻量 modal）。
 *
 * 为什么不直接删：列表行的 ✕ 太顺手了，悬浮就能点到——手一抖删掉一条
 * 跑了几分钟的记录，代价和操作完全不成比例。所以删除前弹一层确认。
 *
 * 用法：
 *   const [confirmDialog, confirmDelete] = useConfirm();
 *   if (await confirmDelete({ title: `删除「${name}」？` })) await doRemove();
 * 然后把 {confirmDialog} 摆进页面任意位置（不开的时候不渲染任何东西）。
 */
import { useCallback, useEffect, useRef, useState, type ReactNode } from "react";

export interface ConfirmOptions {
  /** 一句话问清删的是什么（带名字） */
  title: string;
  /** 可选的第二行说明（如「删除后不可恢复」） */
  detail?: string;
  confirmLabel?: string;
  cancelLabel?: string;
}

export function useConfirm(): [ReactNode, (opts: ConfirmOptions) => Promise<boolean>] {
  const [state, setState] = useState<ConfirmOptions | null>(null);
  const resolver = useRef<((ok: boolean) => void) | null>(null);

  const confirm = useCallback((opts: ConfirmOptions) => {
    return new Promise<boolean>((resolve) => {
      resolver.current?.(false); // 上一个还没答就又开新的：旧的那个按取消算
      resolver.current = resolve;
      setState(opts);
    });
  }, []);

  const settle = useCallback((ok: boolean) => {
    setState(null);
    resolver.current?.(ok);
    resolver.current = null;
  }, []);

  // Esc = 取消：确认框开着时监听，关掉就摘
  useEffect(() => {
    if (!state) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") settle(false);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [state, settle]);

  const dialog: ReactNode = state ? (
    <div
      className="confirm-mask"
      role="dialog"
      aria-modal="true"
      aria-label={state.title}
      onClick={() => settle(false)}
    >
      <div className="confirm-box" onClick={(e) => e.stopPropagation()}>
        <div className="confirm-title">{state.title}</div>
        {state.detail && <div className="confirm-detail">{state.detail}</div>}
        <div className="confirm-actions">
          <button type="button" className="secondary small" onClick={() => settle(false)}>
            {state.cancelLabel ?? "取消"}
          </button>
          <button type="button" className="danger small" onClick={() => settle(true)}>
            {state.confirmLabel ?? "删除"}
          </button>
        </div>
      </div>
    </div>
  ) : null;

  return [dialog, confirm];
}
