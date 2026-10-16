/*
 * SPDX-License-Identifier: GPL-3.0-only
 * Copyright (c) 2026 宝螺 / Baoluo contributors
 * 本文件属于「宝螺 / Baoluo」。除 GPL-3.0 外还适用 ADDITIONAL_TERMS.md 里的附加条款：
 * 分发时须保留来源署名；修改版对外分发时不得沿用「宝螺」名称与图标。
 */
import { useEffect, useLayoutEffect, useRef, useState } from "react";
import type { ReactNode } from "react";
import type { DialogueApi, MediaApi, SettingsApi, VoiceApi } from "../../preload";
import { effectiveFavoriteVoices, VOICE_OPTIONS } from "../../shared/voices";
import AppSelect from "../components/AppSelect";
import { NavPage } from "../components/SideList";
import { HourglassIcon, SpeakerIcon } from "../components/VoiceIcons";

declare global {
  interface Window {
    voice: VoiceApi;
    media: MediaApi;
    dialogue: DialogueApi;
    settings: SettingsApi;
  }
}

/** 音色试听默认示例句 */
const PREVIEW_TEXT = "你好，我是宝螺。今天天气不错，出来走走，心情也跟着好了起来。";

function fmtProsody(n: number): string {
  if (n === 0) return "默认";
  return `${n > 0 ? "+" : ""}${n}%`;
}

function SliderRow(props: {
  label: string;
  value: number;
  onChange: (v: number) => void;
}) {
  return (
    <div className="form-row prosody-row">
      <label>{props.label}</label>
      <input
        type="range"
        min={-10}
        max={10}
        step={1}
        value={props.value}
        onChange={(e) => props.onChange(Number(e.target.value))}
      />
      <span className="prosody-value">{fmtProsody(props.value)}</span>
    </div>
  );
}

export default function TtsView({ nav }: { nav?: ReactNode } = {}) {
  const [text, setText] = useState("");
  const textareaRef = useRef<HTMLTextAreaElement>(null);

  /**
   * 输入框随文字增加自动变高。
   * - 用 useLayoutEffect 同步测量，避免 useEffect 偶发的"先画 0 高再展开"闪烁。
   * - 高度 = 内容自然高度，由 CSS min-height 兜底（空内容时也保留 180px）。
   * - CSS max-height + overflow-y: auto 在内容超过上限时启用内部滚动。
   */
  useLayoutEffect(() => {
    const el = textareaRef.current;
    if (!el) return;
    el.style.height = "auto";
    el.style.height = el.scrollHeight + "px";
  }, [text]);
  const [voice, setVoice] = useState(VOICE_OPTIONS[0].value);
  const [voiceOptions, setVoiceOptions] = useState(VOICE_OPTIONS);
  const [rate, setRate] = useState(0);
  const [pitch, setPitch] = useState(0);
  const [volume, setVolume] = useState(0);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [audioUrl, setAudioUrl] = useState<string | null>(null);
  const [audioPath, setAudioPath] = useState<string | null>(null);
  const [savedFlash, setSavedFlash] = useState(false);
  const [previewStatus, setPreviewStatus] = useState<
    | { state: "loading" | "playing" }
    | { state: "error"; message: string }
    | null
  >(null);
  const previewAudioRef = useRef<HTMLAudioElement | null>(null);
  const previewBusyRef = useRef(false);
  const effectiveVoice = voice;

  // 按设置里勾选的常用音色过滤；没勾选则显示全部
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
        const combined = [
          ...VOICE_OPTIONS.filter((v) => favs.includes(v.value)),
          ...clones,
        ];
        setVoiceOptions(combined);
        setVoice((cur) =>
          combined.some((v) => v.value === cur) ? cur : combined[0]?.value ?? ""
        );
      } catch {
        /* 设置读取失败时保持全部音色 */
      }
    })();
    return () => {
      active = false;
    };
  }, []);

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

  function handlePreview() {
    if (!effectiveVoice || previewBusyRef.current) return;
    previewBusyRef.current = true;
    setPreviewStatus({ state: "loading" });
    // 先停掉上一次试听，避免多条声音重叠
    const prev = previewAudioRef.current;
    if (prev) {
      prev.pause();
      prev.currentTime = 0;
      prev.onended = null;
      prev.onerror = null;
    }
    window.dialogue
      .previewVoice({
        voice: effectiveVoice,
        rate,
        pitch,
        volume,
        text: text.trim() || PREVIEW_TEXT,
      })
      .then((r) => window.media.toUrl(r.path))
      .then((url) => {
        const audio = previewAudioRef.current ?? new Audio();
        previewAudioRef.current = audio;
        audio.src = url;
        audio.onended = () => setPreviewStatus(null);
        audio.onerror = () => setPreviewStatus(null);
        audio.play();
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

  async function handleSynth() {
    setError(null);
    if (!text.trim()) {
      setError("请先输入要合成的文本。");
      return;
    }
    if (!effectiveVoice) {
      setError("请选择音色。");
      return;
    }
    setBusy(true);
    try {
      const res = await window.voice.synth({
        text,
        voice: effectiveVoice,
        rate,
        pitch,
        volume,
      });
      const url = await window.media.toUrl(res.path);
      setAudioPath(res.path);
      setAudioUrl(url);
    } catch (e: any) {
      setError(e?.message || String(e));
    } finally {
      setBusy(false);
    }
  }

  function handleClear() {
    setText("");
    setError(null);
    setAudioUrl(null);
    setAudioPath(null);
    setSavedFlash(false);
  }

  async function handleSave() {
    if (!audioPath) return;
    setError(null);
    try {
      const dest = await window.voice.saveMp3(audioPath);
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
      <h2>语音合成</h2>
      <p className="subtitle">输入文字，选择音色，一键合成语音</p>

      <textarea
        ref={textareaRef}
        className="paste tts-paste"
        placeholder="输入要合成的文本"
        value={text}
        maxLength={2000}
        onChange={(e) => setText(e.target.value)}
      />
      <div className={`char-counter ${text.length >= 2000 ? "is-limit" : text.length >= 1800 ? "is-warn" : ""}`}>
        <span className="char-counter-text">{text.length} / 2000</span>
        {text.length >= 2000 && <span className="char-counter-hint">已达上限</span>}
      </div>

      <div className="tts-controls">
        <div className="form-row">
          <label>音色</label>
          <AppSelect value={voice} options={voiceOptions} onChange={setVoice} />
          <div className="voice-preview-row">
            <button
              className={`speaker-btn ${
                previewStatus && previewStatus.state !== "error" ? "active" : ""
              }`}
              title={
                previewStatus?.state === "error"
                  ? previewStatus.message
                  : "试听当前音色"
              }
              disabled={previewStatus?.state === "loading"}
              onClick={handlePreview}
            >
              <span className="speaker-icon">
                {previewStatus?.state === "loading" ? (
                  <HourglassIcon />
                ) : (
                  <SpeakerIcon />
                )}
              </span>
            </button>
            <span className="hint">试听</span>
          </div>
        </div>
        {voiceOptions.length === 0 && (
          <div className="hint">
            音色设置里没有勾选任何音色，请在「设置 → 音色设置」里勾选后再来合成。
          </div>
        )}
        <SliderRow label="语速" value={rate} onChange={setRate} />
        <SliderRow label="音调" value={pitch} onChange={setPitch} />
        <SliderRow label="音量" value={volume} onChange={setVolume} />
      </div>

      <div className="row">
        <button className="primary" onClick={handleSynth} disabled={busy}>
          {busy ? "合成中..." : "🎙 合成语音"}
        </button>
        <button className="secondary secondary-outlined" onClick={handleClear} disabled={busy}>
          清空
        </button>
      </div>

      {error && <div className="error">{error}</div>}

      {audioUrl && (
        <div className="transcribe-panel">
          <div className="panel-title">合成结果</div>
          <audio className="audio-preview" controls src={audioUrl} />
          <div className="row">
            <button className="secondary" onClick={handleSave}>
              {savedFlash ? "已保存 ✓" : "保存为 MP3"}
            </button>
          </div>
        </div>
      )}

      <div className="disclaimer">
        免责声明：语音生成内容请遵守相关法律法规与使用规范，请勿用于伪造、侵权等违规场景，使用产生的全部责任由使用者自行承担
      </div>
      </div>
    </NavPage>
  );
}

