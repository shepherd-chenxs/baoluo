/*
 * SPDX-License-Identifier: GPL-3.0-only
 * Copyright (c) 2026 宝螺 / Baoluo contributors
 * 本文件属于「宝螺 / Baoluo」。除 GPL-3.0 外还适用 ADDITIONAL_TERMS.md 里的附加条款：
 * 分发时须保留来源署名；修改版对外分发时不得沿用「宝螺」名称与图标。
 */
import { useEffect, useRef, useState } from "react";
import type { ReactNode } from "react";
import type { AsrApi, TranscribeProgress, TranscribeResult } from "../../preload";
import { NavPage } from "../components/SideList";

declare global {
  interface Window {
    asr: AsrApi;
  }
}

function fmtBytes(n: number) {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / 1024 / 1024).toFixed(2)} MB`;
}

/** 秒 → 字幕风格时间戳（含毫秒） */
function fmtTime(sec: number): string {
  const s = Math.max(0, sec);
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const ss = Math.floor(s % 60);
  const ms = Math.round((s - Math.floor(s)) * 1000);
  return `${String(h).padStart(2, "0")}:${String(m).padStart(2, "0")}:${String(ss).padStart(2, "0")},${String(ms).padStart(3, "0")}`;
}

/** 秒 → 计时器显示 mm:ss / h:mm:ss */
function fmtClock(totalSec: number): string {
  const s = Math.max(0, Math.floor(totalSec));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const ss = s % 60;
  return h > 0
    ? `${h}:${String(m).padStart(2, "0")}:${String(ss).padStart(2, "0")}`
    : `${String(m).padStart(2, "0")}:${String(ss).padStart(2, "0")}`;
}

/** 把分句合并成一段（与主进程相同的标点策略：每 3 句一断，其余逗号） */
function mergeSegments(texts: string[]): string {
  const ENDING_PUNCT = /[，。！？；：,.\?!;:、~—…]$/;
  const QUESTION_HINT = /(吗|呢|嘛|吧|么|啥|谁|哪|怎|何)[”"'）)』」]?$/;
  let out = "";
  const sentenceEveryN = 3;
  for (let i = 0; i < texts.length; i++) {
    let clean = (texts[i] ?? "").replace(/^[\s，,]+|[\s]+$/g, "");
    if (!clean) continue;
    if (i < texts.length - 1 && !ENDING_PUNCT.test(clean)) {
      const shouldPeriod = (i + 1) % sentenceEveryN === 0;
      clean += shouldPeriod ? (QUESTION_HINT.test(clean) ? "？" : "。") : "，";
    }
    out += clean;
  }
  if (out && !ENDING_PUNCT.test(out)) {
    out += QUESTION_HINT.test(out) ? "？" : "。";
  }
  return out;
}

interface AsrViewProps {
  /** 左栏顶部的导航块（App 传下来的 SideNav） */
  nav?: ReactNode;
}

export default function AsrView({ nav }: AsrViewProps = {}) {
  const [filePath, setFilePath] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [stage, setStage] = useState<TranscribeProgress["stage"] | null>(null);
  const [modelProgress, setModelProgress] = useState<{
    received: number;
    total: number;
    percent: number;
  } | null>(null);
  const [lines, setLines] = useState<string[]>([]);
  const [result, setResult] = useState<TranscribeResult | null>(null);
  /** 按句编辑：每句的文本（与 result.segments 对齐） */
  const [segTexts, setSegTexts] = useState<string[]>([]);
  /** 合并成段模式下的文本 */
  const [mergedText, setMergedText] = useState("");
  /** true=合并成段，false=按句显示 */
  const [mergeMode, setMergeMode] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [copiedFlash, setCopiedFlash] = useState(false);
  const [savedFlash, setSavedFlash] = useState(false);
  const [cancelled, setCancelled] = useState(false);
  const [elapsed, setElapsed] = useState(0);
  const linesRef = useRef<HTMLDivElement>(null);
  const requestIdRef = useRef<string | null>(null);

  useEffect(() => {
    const off = window.asr.onProgress((p) => {
      setStage(p.stage);
      if (p.stage === "model-download") {
        setModelProgress({
          received: p.received ?? 0,
          total: p.total ?? 0,
          percent: p.percent ?? 0,
        });
      } else if (p.stage === "transcribe-line" && p.line) {
        setLines((prev) => {
          const next = [...prev, p.line!];
          setTimeout(() => {
            if (linesRef.current) {
              linesRef.current.scrollTop = linesRef.current.scrollHeight;
            }
          }, 0);
          return next;
        });
      }
    });
    return () => {
      off();
    };
  }, []);

  // 识别过程中每秒跳动一次计时，提示用户任务仍在进行
  useEffect(() => {
    if (!busy) {
      setElapsed(0);
      return;
    }
    setElapsed(0);
    const timer = setInterval(() => setElapsed((v) => v + 1), 1000);
    return () => clearInterval(timer);
  }, [busy]);

  function reset() {
    setStage(null);
    setModelProgress(null);
    setLines([]);
    setResult(null);
    setSegTexts([]);
    setMergedText("");
    setMergeMode(false);
    setError(null);
    setCopiedFlash(false);
    setSavedFlash(false);
    setCancelled(false);
  }

  async function handleChoose() {
    reset();
    const p = await window.asr.chooseFile();
    setFilePath(p);
  }

  async function runTranscription(targetPath: string) {
    if (!targetPath) return;
    reset();
    setBusy(true);
    setCancelled(false);
    try {
      const modelReady = await window.asr.isModelReady();
      if (!modelReady) {
        const ok = window.confirm(
          "首次识别需要下载本地语音识别模型（约 150 MB）。\n" +
            "下载后一直保存在本地，之后无需重复下载。\n\n" +
            "是否现在下载？"
        );
        if (!ok) {
          setBusy(false);
          return;
        }
      }
      requestIdRef.current = targetPath;
      const r = await window.asr.run({
        videoPath: targetPath,
        requestId: targetPath,
        language: "zh",
      });
      setResult(r);
      setSegTexts(r.segments.map((s) => s.text));
      setMergedText(r.text || "");
      setMergeMode(false);
    } catch (e: any) {
      const msg = e?.message || String(e);
      if (String(msg).includes("已取消")) {
        setError(null);
        setCancelled(true);
      } else {
        setError(msg);
      }
    } finally {
      requestIdRef.current = null;
      setBusy(false);
    }
  }

  async function handleRun() {
    if (!filePath) return;
    await runTranscription(filePath);
  }

  async function handleCancel() {
    if (requestIdRef.current) {
      await window.asr.cancel(requestIdRef.current);
    }
  }

  /** 当前视图对应的文本（按句=字幕风格，合并=整段） */
  function currentText(): string {
    if (!result) return "";
    if (mergeMode) return mergedText;
    if (result.segments.length) {
      return result.segments
        .map((s, i) => ({ s, t: (segTexts[i] ?? "").trim() }))
        .filter((x) => x.t)
        .map((x) => `[${fmtTime(x.s.start)} --> ${fmtTime(x.s.end)}] ${x.t}`)
        .join("\n");
    }
    return result.text;
  }

  function switchMode(next: boolean) {
    if (next && !mergeMode && result) {
      setMergedText(mergeSegments(segTexts));
    }
    setMergeMode(next);
  }

  function updateSegText(i: number, v: string) {
    setSegTexts((prev) => prev.map((t, j) => (j === i ? v : t)));
  }

  function removeSeg(i: number) {
    if (!result) return;
    setResult({
      ...result,
      segments: result.segments.filter((_, j) => j !== i),
    });
    setSegTexts((prev) => prev.filter((_, j) => j !== i));
  }

  async function handleCopy() {
    const t = currentText();
    if (!t) return;
    await navigator.clipboard.writeText(t);
    setCopiedFlash(true);
    setTimeout(() => setCopiedFlash(false), 1500);
  }

  async function handleSaveTxt() {
    const t = currentText();
    if (!t) return;
    setError(null);
    try {
      const dest = await window.asr.saveText(t);
      if (dest) {
        setSavedFlash(true);
        setTimeout(() => setSavedFlash(false), 1800);
      }
    } catch (e: any) {
      setError(e?.message || String(e));
    }
  }

  return (
    <NavPage nav={nav}>
      <div className="view">
      <h2>语音识别</h2>
      <p className="subtitle">导入本地音频、视频文件，在本机完成语音文字识别，无需联网。</p>

      <div className="row">
        <button className="primary" onClick={handleChoose} disabled={busy}>
          选择音频 / 视频文件
        </button>
        {filePath && !busy && (
          <button className="secondary start-btn" onClick={handleRun} disabled={busy}>
            🎧 开始识别
          </button>
        )}
        {busy && (
          <button className="secondary danger" onClick={handleCancel}>
            ⏹ 取消
          </button>
        )}
      </div>

      {filePath && (
        <div className="asr-file">
          <span className="asr-file-icon">📄</span>
          <span className="asr-file-name">{filePath}</span>
        </div>
      )}

      {error && <div className="error">{error}</div>}

      {(busy || result) && (
        <div className="transcribe-panel">
          <div className="panel-title-row">
            <span className="panel-title">{busy ? "🎧 识别中…" : "📝 识别结果"}</span>
            {busy && <span className="status">已用时 {fmtClock(elapsed)}</span>}
          </div>

          {!busy && cancelled && <div className="status">已取消</div>}

          {busy && stage === "model-download" && modelProgress && (
            <>
              <div className="progress">
                <div style={{ width: `${modelProgress.percent}%` }} />
              </div>
              <div className="status">
                {fmtBytes(modelProgress.received)} / {fmtBytes(modelProgress.total)} ·{" "}
                {modelProgress.percent.toFixed(1)}%
              </div>
            </>
          )}

          {busy && lines.length > 0 && (
            <div className="tr-live" ref={linesRef}>
              {lines.map((l, i) => (
                <div key={i}>{l}</div>
              ))}
            </div>
          )}

          {result && (
            <>
              {result.segments.length > 0 && (
                <div className="row tight seg-mode-toggle">
                  <button
                    className={`seg-mode-btn ${!mergeMode ? "active" : ""}`}
                    onClick={() => switchMode(false)}
                  >
                    按句显示（带时间）
                  </button>
                  <button
                    className={`seg-mode-btn ${mergeMode ? "active" : ""}`}
                    onClick={() => switchMode(true)}
                  >
                    合并成段
                  </button>
                  <span className="hint">可逐句修改，合并后也可整体修改</span>
                </div>
              )}

              {result.segments.length === 0 ? (
                <div className="tr-text">
                  {result.text || "(未识别出内容 — 文件中可能没有人声)"}
                </div>
              ) : mergeMode ? (
                <textarea
                  className="tr-textarea"
                  rows={Math.max(5, Math.ceil(mergedText.length / 40))}
                  value={mergedText}
                  onChange={(e) => setMergedText(e.target.value)}
                  placeholder="合并后的整段文本"
                />
              ) : (
                <div className="tr-segments">
                  {result.segments.map((s, i) => (
                    <div className="tr-seg-row" key={i}>
                      <span className="tr-seg-time" title={`${fmtTime(s.start)} → ${fmtTime(s.end)}`}>
                        [{fmtTime(s.start)} → {fmtTime(s.end)}]
                      </span>
                      <textarea
                        className="tr-seg-input"
                        rows={1}
                        value={segTexts[i] ?? ""}
                        onChange={(e) => updateSegText(i, e.target.value)}
                        placeholder="该句文本"
                      />
                      <button className="link" onClick={() => removeSeg(i)}>
                        删除
                      </button>
                    </div>
                  ))}
                </div>
              )}
              {currentText() && (
                <div className="row">
                  <button className="secondary" onClick={handleCopy}>
                    {copiedFlash ? "已复制 ✓" : "复制全文"}
                  </button>
                  <button className="secondary" onClick={handleSaveTxt}>
                    {savedFlash ? "已保存 ✓" : "保存为 TXT"}
                  </button>
                </div>
              )}
            </>
          )}
        </div>
      )}

      <div className="disclaimer">
        语音识别在本地完成，音频不会上传到服务器；首次使用需下载约 150 MB 模型。
      </div>
      </div>
    </NavPage>
  );
}
