/*
 * SPDX-License-Identifier: GPL-3.0-only
 * Copyright (c) 2026 宝螺 / Baoluo contributors
 * 本文件属于「宝螺 / Baoluo」。除 GPL-3.0 外还适用 ADDITIONAL_TERMS.md 里的附加条款：
 * 分发时须保留来源署名；修改版对外分发时不得沿用「宝螺」名称与图标。
 */
import { useEffect, useRef, useState } from "react";
import type { ReactNode } from "react";
import type {
  DialogueApi,
  MediaApi,
  SettingsApi,
  VoiceConvertApi,
  VoiceConvertProgress,
  VoiceConvertResult,
} from "../../preload";
import { effectiveFavoriteVoices, VOICE_OPTIONS } from "../../shared/voices";
import AppSelect from "../components/AppSelect";
import { HourglassIcon, SpeakerIcon } from "../components/VoiceIcons";
import { NavPage } from "../components/SideList";

declare global {
  interface Window {
    voiceConvert: VoiceConvertApi;
    dialogue: DialogueApi;
    media: MediaApi;
    settings: SettingsApi;
  }
}

/** 试听默认示例句（与语音合成页一致） */
const PREVIEW_TEXT = "你好，我是宝螺。今天天气不错，出来走走，心情也跟着好了起来。";

function fmtProsody(n: number): string {
  if (n === 0) return "默认";
  return `${n > 0 ? "+" : ""}${n}%`;
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

function fmtBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / 1024 / 1024).toFixed(2)} MB`;
}

function SliderRow(props: {
  label: string;
  value: number;
  onChange: (v: number) => void;
  disabled?: boolean;
}) {
  return (
    <div className="form-row prosody-row">
      <label>{props.label}</label>
      <input
        type="range"
        min={-10}
        max={10}
        step={1}
        disabled={props.disabled}
        value={props.value}
        onChange={(e) => props.onChange(Number(e.target.value))}
      />
      <span className="prosody-value">{fmtProsody(props.value)}</span>
    </div>
  );
}

/** 阶段 → 给用户看的一句话 */
function stageLabel(p: VoiceConvertProgress | null): string {
  switch (p?.stage) {
    case "model-download":
      return "首次使用：下载识别模型";
    case "extract-audio":
      return "提取人声";
    case "transcribe":
      return "识别原音频文案";
    case "synthesize":
      return "用新音色重新配音";
    case "merge":
      return "拼接音频";
    case "done":
      return "完成";
    default:
      return "准备中";
  }
}

export default function VoiceConvertView({ nav }: { nav?: ReactNode } = {}) {
  const [filePath, setFilePath] = useState<string | null>(null);
  const [voice, setVoice] = useState("");
  const [voiceOptions, setVoiceOptions] = useState(VOICE_OPTIONS);
  const [rate, setRate] = useState(0);
  const [pitch, setPitch] = useState(0);
  const [volume, setVolume] = useState(0);
  const [busy, setBusy] = useState(false);
  const [progress, setProgress] = useState<VoiceConvertProgress | null>(null);
  const [lines, setLines] = useState<string[]>([]);
  const [result, setResult] = useState<VoiceConvertResult | null>(null);
  const [audioUrl, setAudioUrl] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [cancelled, setCancelled] = useState(false);
  const [elapsed, setElapsed] = useState(0);
  const [savedFlash, setSavedFlash] = useState(false);
  const [previewStatus, setPreviewStatus] = useState<
    { state: "loading" | "playing" } | { state: "error"; message: string } | null
  >(null);

  const linesRef = useRef<HTMLDivElement>(null);
  const requestIdRef = useRef<string | null>(null);
  const previewAudioRef = useRef<HTMLAudioElement | null>(null);
  const previewBusyRef = useRef(false);
  /** 克隆音色的语速/音调/音量由模型决定，滑杆置灰但保留用户选择 */
  const isCloneVoice = voice.startsWith("clone:");

  // 音色下拉：勾选的常用音色 + 已保存的克隆音色（与语音合成页同一套规则）
  useEffect(() => {
    let active = true;
    (async () => {
      try {
        const app = await window.settings.get();
        const favs = effectiveFavoriteVoices(app.favoriteVoices);
        const clones = (app.cloneVoices ?? []).map((v) => ({
          value: `clone:${v.id}`,
          label: `克隆·${v.name}`,
        }));
        if (!active) return;
        const combined = [...VOICE_OPTIONS.filter((v) => favs.includes(v.value)), ...clones];
        setVoiceOptions(combined);
        setVoice((cur) => (combined.some((v) => v.value === cur) ? cur : combined[0]?.value ?? ""));
      } catch {
        /* 设置读取失败时保持全部音色 */
      }
    })();
    return () => {
      active = false;
    };
  }, []);

  useEffect(() => {
    const off = window.voiceConvert.onProgress((p) => {
      setProgress(p);
      if (p.stage === "transcribe" && p.line) {
        setLines((prev) => {
          const next = [...prev, p.line!];
          setTimeout(() => {
            if (linesRef.current) linesRef.current.scrollTop = linesRef.current.scrollHeight;
          }, 0);
          return next;
        });
      }
    });
    return () => {
      off();
    };
  }, []);

  // 变声是纯 CPU 活儿，慢的时候要有个跳动的计时器证明没卡死
  useEffect(() => {
    if (!busy) {
      setElapsed(0);
      return;
    }
    setElapsed(0);
    const timer = setInterval(() => setElapsed((v) => v + 1), 1000);
    return () => clearInterval(timer);
  }, [busy]);

  useEffect(() => {
    return () => {
      const a = previewAudioRef.current;
      if (a) {
        a.pause();
        a.onended = null;
        a.onerror = null;
        a.src = "";
      }
    };
  }, []);

  function reset() {
    setProgress(null);
    setLines([]);
    setResult(null);
    setAudioUrl(null);
    setError(null);
    setCancelled(false);
    setSavedFlash(false);
  }

  async function handleChoose() {
    if (busy) return;
    const p = await window.voiceConvert.chooseFile();
    if (!p) return;
    reset();
    setFilePath(p);
  }

  function handlePreview() {
    if (!voice || previewBusyRef.current) return;
    previewBusyRef.current = true;
    setPreviewStatus({ state: "loading" });
    const prev = previewAudioRef.current;
    if (prev) {
      prev.pause();
      prev.currentTime = 0;
      prev.onended = null;
      prev.onerror = null;
    }
    window.dialogue
      .previewVoice({ voice, rate, pitch, volume, text: PREVIEW_TEXT })
      .then((r) => window.media.toUrl(r.path))
      .then((url) => {
        const audio = previewAudioRef.current ?? new Audio();
        previewAudioRef.current = audio;
        audio.src = url;
        audio.onended = () => setPreviewStatus(null);
        audio.onerror = () => setPreviewStatus(null);
        void audio.play();
        setPreviewStatus({ state: "playing" });
      })
      .catch((e) => {
        const msg = e?.message ?? String(e);
        const friendly = /timeout|timed out/i.test(msg)
          ? "该音色当前不可用（合成超时），请换个音色试试。"
          : msg;
        setPreviewStatus({ state: "error", message: friendly });
        window.alert(friendly);
      })
      .finally(() => {
        previewBusyRef.current = false;
      });
  }

  async function handleRun() {
    if (!filePath) {
      setError("请先选择要变声的音频或视频。");
      return;
    }
    if (!voice) {
      setError("请先选择要变的目标音色。");
      return;
    }
    reset();
    setBusy(true);
    const requestId = `vc-${Date.now()}`;
    requestIdRef.current = requestId;
    try {
      const r = await window.voiceConvert.run({
        inputPath: filePath,
        voice,
        rate,
        pitch,
        volume,
        requestId,
      });
      setResult(r);
      setAudioUrl(await window.media.toUrl(r.audioPath));
    } catch (e: any) {
      const msg = e?.message || String(e);
      if (String(msg).includes("已取消")) {
        setCancelled(true);
      } else {
        setError(msg);
      }
    } finally {
      requestIdRef.current = null;
      setBusy(false);
    }
  }

  async function handleCancel() {
    if (requestIdRef.current) {
      await window.voiceConvert.cancel(requestIdRef.current);
    }
  }

  async function handleSave() {
    if (!result) return;
    setError(null);
    try {
      const dest = await window.voiceConvert.saveAudio(result.audioPath);
      if (dest) {
        setSavedFlash(true);
        setTimeout(() => setSavedFlash(false), 1800);
      }
    } catch (e: any) {
      setError(e?.message || String(e));
    }
  }

  /** 进度条：模型下载阶段按字节，其余按阶段权重 */
  const barPercent = (() => {
    if (!progress) return 0;
    if (progress.stage === "model-download") {
      const { received = 0, total = 0 } = progress;
      return total > 0 ? Math.min(100, (received / total) * 100) : 3;
    }
    if (progress.stage === "done") return 100;
    return progress.percent;
  })();

  return (
    <NavPage nav={nav}>
      <div className="view">
      <h2>变声器</h2>
      <p className="subtitle">
        上传一段音频或视频，识别出原话后用你指定的音色重新念一遍（原声的语气和节奏不会保留）
      </p>

      <div className="row">
        <button className="primary" onClick={handleChoose} disabled={busy}>
          选择音频 / 视频
        </button>
        {filePath && !busy && (
          <button className="secondary start-btn" onClick={handleRun}>
            🎚 开始变声
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
          <span className="asr-file-icon">🎵</span>
          <span className="asr-file-name">{filePath}</span>
        </div>
      )}

      <div className="tts-controls">
        <div className="form-row">
          <label>目标音色</label>
          <AppSelect value={voice} options={voiceOptions} onChange={setVoice} />
          <div className="voice-preview-row">
            <button
              className={`speaker-btn ${previewStatus && previewStatus.state !== "error" ? "active" : ""}`}
              title={previewStatus?.state === "error" ? previewStatus.message : "试听当前音色"}
              disabled={previewStatus?.state === "loading"}
              onClick={handlePreview}
            >
              <span className="speaker-icon">
                {previewStatus?.state === "loading" ? <HourglassIcon /> : <SpeakerIcon />}
              </span>
            </button>
            <span className="hint">试听</span>
          </div>
        </div>
        {voiceOptions.length === 0 && (
          <div className="hint">
            音色设置里没有勾选任何音色，请到「设置 → 音色设置」里勾选后再来变声。
          </div>
        )}
        <SliderRow label="语速" value={rate} onChange={setRate} disabled={isCloneVoice} />
        <SliderRow label="音调" value={pitch} onChange={setPitch} disabled={isCloneVoice} />
        <SliderRow label="音量" value={volume} onChange={setVolume} disabled={isCloneVoice} />
        {isCloneVoice && (
          <div className="hint">克隆音色的语速/音调由模型决定，三个滑杆对它不生效。</div>
        )}
      </div>

      {error && <div className="error">{error}</div>}

      {(busy || result || cancelled) && (
        <div className="transcribe-panel">
          <div className="panel-title-row">
            <span className="panel-title">
              {busy ? `🎚 ${stageLabel(progress)}…` : "🔊 变声结果"}
            </span>
            {busy && <span className="status">已用时 {fmtClock(elapsed)}</span>}
          </div>

          {busy && (
            <>
              <div className={`progress ${barPercent <= 0 ? "indeterminate" : ""}`}>
                <div style={{ width: `${Math.max(3, barPercent)}%` }} />
              </div>
              <div className="status">
                {progress?.stage === "model-download" && (progress.total ?? 0) > 0
                  ? `${fmtBytes(progress.received ?? 0)} / ${fmtBytes(progress.total ?? 0)}`
                  : progress?.message ?? "准备中…"}
                {progress?.stage === "synthesize" && progress.totalLines
                  ? ` · ${progress.current ?? 0}/${progress.totalLines} 句`
                  : ""}
              </div>
              {progress?.stage === "transcribe" && lines.length > 0 && (
                <div className="tr-live" ref={linesRef}>
                  {lines.map((l, i) => (
                    <div key={i}>{l}</div>
                  ))}
                </div>
              )}
            </>
          )}

          {!busy && cancelled && <div className="status">已取消</div>}

          {result && audioUrl && (
            <>
              <audio className="audio-preview" controls src={audioUrl} />
              <div className="status">
                共 {result.segmentCount} 句，成功 {result.doneCount} 句 · 时长约{" "}
                {fmtClock(result.durationSec)}
              </div>
              <div className="row">
                <button className="secondary" onClick={handleSave}>
                  {savedFlash ? "已保存 ✓" : "保存为 MP3"}
                </button>
                <button
                  className="secondary secondary-outlined"
                  onClick={() => window.voiceConvert.showInFolder(result.audioPath)}
                >
                  打开所在文件夹
                </button>
              </div>
            </>
          )}
        </div>
      )}

      <div className="disclaimer">
        识别与配音都在本机完成，音频不会上传到服务器（选用在线音色时，文字会发送到微软语音服务）。
        请仅对你有权处理的声音素材使用本功能，不得用于伪造他人声音、侵权等违规场景。
      </div>
      </div>
    </NavPage>
  );
}
