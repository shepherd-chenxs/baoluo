/*
 * SPDX-License-Identifier: GPL-3.0-only
 * Copyright (c) 2026 宝螺 / Baoluo contributors
 * 本文件属于「宝螺 / Baoluo」。除 GPL-3.0 外还适用 ADDITIONAL_TERMS.md 里的附加条款：
 * 分发时须保留来源署名；修改版对外分发时不得沿用「宝螺」名称与图标。
 */
import { useState } from "react";

/** 设置页共用的「保存设置 / 重置」操作行 */
export default function SaveResetRow(props: {
  onSave: () => Promise<void>;
  onReset: () => Promise<void>;
}) {
  const [saved, setSaved] = useState(false);
  const [resetFlash, setResetFlash] = useState(false);

  return (
    <div className="row save-reset-row">
      <button
        className="primary"
        onClick={async () => {
          try {
            await props.onSave();
            setSaved(true);
            setTimeout(() => setSaved(false), 1500);
          } catch {
            /* 错误由页面自己展示 */
          }
        }}
      >
        保存设置
      </button>
      <button
        className="secondary reset-button"
        style={{
          background: "transparent",
          color: "#1d1d1f",
          borderColor: "rgba(0, 0, 0, 0.24)",
        }}
        onClick={async () => {
          try {
            await props.onReset();
            setResetFlash(true);
            setTimeout(() => setResetFlash(false), 1500);
          } catch {
            /* 错误由页面自己展示 */
          }
        }}
      >
        重置
      </button>
      {saved && (
        <span className="status" style={{ color: "#34c759" }}>
          已保存 ✓
        </span>
      )}
      {resetFlash && (
        <span className="status" style={{ color: "#ff9500" }}>
          已恢复默认 ✓
        </span>
      )}
    </div>
  );
}
