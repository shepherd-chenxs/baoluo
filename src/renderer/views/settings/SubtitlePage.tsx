/*
 * SPDX-License-Identifier: GPL-3.0-only
 * Copyright (c) 2026 宝螺 / Baoluo contributors
 * 本文件属于「宝螺 / Baoluo」。除 GPL-3.0 外还适用 ADDITIONAL_TERMS.md 里的附加条款：
 * 分发时须保留来源署名；修改版对外分发时不得沿用「宝螺」名称与图标。
 */
import { useEffect, useState } from "react";
import type { DialogueApi } from "../../../preload";
import type { SubtitleSettings } from "../../../shared/dialogue-types";
import { DEFAULT_SUBTITLE } from "../../../shared/settings-defaults";
import ColorPicker from "../../components/ColorPicker";
import SaveResetRow from "./SaveResetRow";

const SAMPLE_TEXT = "挫折只是一件单独的事，不要让它蔓延污染你的全部生活";

declare global {
  interface Window {
    dialogue: DialogueApi;
  }
}

export default function SubtitlePage() {
  const [subtitle, setSubtitle] = useState<SubtitleSettings | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    (async () => {
      try {
        const s = await window.dialogue.getSettings();
        setSubtitle(s.subtitle);
      } catch {
        /* ignore */
      }
    })();
  }, []);

  if (!subtitle) {
    return <p className="subtitle">加载中…</p>;
  }
  const sub = subtitle;
  /** 字幕底色选了「无色」：不画背景（与 backgroundOpacity 无关） */
  const isTransparent = sub.backgroundColor.trim().toLowerCase() === "transparent";

  function patchSubtitle(p: Partial<SubtitleSettings>) {
    setSubtitle({ ...sub, ...p });
  }

  async function handleSave() {
    setError(null);
    const cur = await window.dialogue.getSettings();
    const r = await window.dialogue.saveSettings({ ...cur, subtitle: sub });
    setSubtitle(r.subtitle);
  }

  async function handleReset() {
    setError(null);
    const cur = await window.dialogue.getSettings();
    const r = await window.dialogue.saveSettings({ ...cur, subtitle: { ...DEFAULT_SUBTITLE } });
    setSubtitle(r.subtitle);
  }

  // 预览按真实合成使用的 1920x1080 坐标等比缩放
  const PREVIEW_W = 480;
  const PREVIEW_H = 270;
  const scale = PREVIEW_H / 1080;

  function hexToRgba(hex: string, opacity: number): string {
    let h = hex.replace("#", "").trim();
    if (h.length === 3) h = h.split("").map((c) => c + c).join("");
    if (h.length !== 6) h = "000000";
    const r = parseInt(h.slice(0, 2), 16);
    const g = parseInt(h.slice(2, 4), 16);
    const b = parseInt(h.slice(4, 6), 16);
    return `rgba(${r}, ${g}, ${b}, ${Math.max(0, Math.min(1, opacity))})`;
  }

  return (
    <>
      <div className="card-pad subtitle-editor-card">
        <div className="subtitle-preview" style={{ width: PREVIEW_W, height: PREVIEW_H }}>
          <div
            className="preview-subtitle"
            style={{
              bottom: `${Math.max(8, (1080 * (1 - sub.positionPct) - 20) * scale)}px`,
              fontSize: `${Math.max(12, sub.fontSize * scale)}px`,
              color: sub.color,
              // backgroundOpacity 是"透明度"：1 = 完全透明（无色）
              backgroundColor: isTransparent
                ? "transparent"
                : hexToRgba(sub.backgroundColor, 1 - sub.backgroundOpacity),
            }}
          >
            {SAMPLE_TEXT}
          </div>
        </div>
        <div className="subtitle-params">
          <div className="form-row">
            <label>字幕字号</label>
            <input
              type="range"
              min={20}
              max={120}
              step={1}
              value={sub.fontSize}
              onChange={(e) => patchSubtitle({ fontSize: +e.target.value || 50 })}
            />
            <span className="range-value">{sub.fontSize}</span>
          </div>
          <div className="form-row">
            <label>字幕 Y 位置</label>
            <input
              type="range"
              step={0.005}
              min={0.5}
              max={0.99}
              value={sub.positionPct}
              onChange={(e) => patchSubtitle({ positionPct: +e.target.value || 0.85 })}
            />
            <span className="range-value">{Math.round(sub.positionPct * 100)}%</span>
          </div>
          <div className="form-row">
            <label>字幕颜色</label>
            <ColorPicker
              value={sub.color}
              onChange={(v) => patchSubtitle({ color: v })}
              title="字幕文字颜色"
            />
            <span className="color-hex">{sub.color}</span>
          </div>
          <div className="form-row">
            <label>背景颜色</label>
            <ColorPicker
              value={sub.backgroundColor}
              allowTransparent
              title="字幕底色，可选「无色」"
              onChange={(v) => patchSubtitle({ backgroundColor: v })}
            />
            <span className="color-hex">{isTransparent ? "无色" : sub.backgroundColor}</span>
          </div>
          <div className="form-row">
            <label>背景透明度</label>
            <input
              type="range"
              step={0.05}
              min={0}
              max={1}
              value={sub.backgroundOpacity}
              disabled={isTransparent}
              onChange={(e) =>
                patchSubtitle({
                  backgroundOpacity: Math.max(0, Math.min(1, +e.target.value || 0)),
                })
              }
            />
            <span className="range-value">{Math.round(sub.backgroundOpacity * 100)}%</span>
          </div>
          <div className="hint">
            背景颜色弹窗里第一格就是「无色」（彻底不画底色）；想留一点底色就用下面的背景透明度微调。
          </div>
          {error && <div className="error">{error}</div>}
        </div>
      </div>
      <SaveResetRow onSave={handleSave} onReset={handleReset} />
    </>
  );
}
