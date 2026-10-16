/*
 * SPDX-License-Identifier: GPL-3.0-only
 * Copyright (c) 2026 宝螺 / Baoluo contributors
 * 本文件属于「宝螺 / Baoluo」。除 GPL-3.0 外还适用 ADDITIONAL_TERMS.md 里的附加条款：
 * 分发时须保留来源署名；修改版对外分发时不得沿用「宝螺」名称与图标。
 */
import { useEffect, useRef, useState } from "react";
import type { DialogueApi, MediaApi, SettingsApi } from "../../../preload";
import {
  DEFAULT_FAVORITE_VOICES,
  effectiveFavoriteVoices,
  VOICE_OPTIONS,
} from "../../../shared/voices";
import AlertModal from "../../components/AlertModal";
import SaveResetRow from "./SaveResetRow";

declare global {
  interface Window {
    settings: SettingsApi;
    dialogue: DialogueApi;
    media: MediaApi;
  }
}

/** 喇叭图标 */
function SpeakerIcon() {
  return (
    <svg
      className="speaker-svg"
      viewBox="0 0 24 24"
      width="15"
      height="15"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden
    >
      <path d="M11 5 6 9H2v6h4l5 4V5z" />
      <path d="M15.54 8.46a5 5 0 0 1 0 7.07" />
      <path d="M19.07 4.93a10 10 0 0 1 0 14.14" />
    </svg>
  );
}

/** 沙漏图标（合成中） */
function HourglassIcon() {
  return (
    <svg
      className="speaker-svg"
      viewBox="0 0 24 24"
      width="15"
      height="15"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden
    >
      <path d="M5 22h14" />
      <path d="M5 2h14" />
      <path d="M17 22v-4.17a2 2 0 0 0-.59-1.42L12 12l-4.41 4.41A2 2 0 0 0 7 17.83V22" />
      <path d="M7 2v4.17a2 2 0 0 0 .59 1.42L12 12l4.41-4.41A2 2 0 0 0 17 6.17V2" />
    </svg>
  );
}

/** 按标签前缀给音色分组（与 voices.ts 里的命名保持一致） */
function voiceGroupName(v: { label: string }): string {
  if (/^(男|女)·/.test(v.label)) return "普通话";
  if (/^(东北|陕西)·/.test(v.label)) return "方言";
  if (/^台·/.test(v.label)) return "台湾国语";
  if (/^粤·/.test(v.label)) return "粤语";
  if (/^(美音|英音|澳音)·/.test(v.label)) return "英语";
  if (/^日·/.test(v.label)) return "日语";
  if (/^韩·/.test(v.label)) return "韩语";
  return "其他外语";
}

export default function VoicesPage() {
  const [favoriteVoices, setFavoriteVoices] = useState<string[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [previewStatus, setPreviewStatus] = useState<
    | { voice: string; state: "loading" | "playing" }
    | { voice: string; state: "error"; message: string }
    | null
  >(null);
  const [alertMsg, setAlertMsg] = useState<string | null>(null);
  const previewAudioRef = useRef<HTMLAudioElement | null>(null);
  const previewBusyRef = useRef(false);

  useEffect(() => {
    (async () => {
      try {
        const app = await window.settings.get();
        setFavoriteVoices(effectiveFavoriteVoices(app.favoriteVoices));
      } catch {
        /* ignore */
      }
    })();
  }, []);

  const voiceGroups: Array<{ name: string; items: typeof VOICE_OPTIONS }> = [];
  for (const v of VOICE_OPTIONS) {
    const g = voiceGroupName(v);
    let group = voiceGroups.find((x) => x.name === g);
    if (!group) {
      group = { name: g, items: [] };
      voiceGroups.push(group);
    }
    group.items.push(v);
  }

  function toggleFavorite(id: string) {
    setFavoriteVoices((cur) =>
      cur.includes(id) ? cur.filter((x) => x !== id) : [...cur, id]
    );
  }

  async function handleSave() {
    setError(null);
    await window.settings.update({ favoriteVoices });
  }

  async function handleReset() {
    setError(null);
    setFavoriteVoices(DEFAULT_FAVORITE_VOICES);
    await window.settings.update({ favoriteVoices: DEFAULT_FAVORITE_VOICES });
  }

  /** 试听某个音色：合成一句示例并播放 */
  function previewVoice(voice: string) {
    if (!voice || previewBusyRef.current) return;
    previewBusyRef.current = true;
    setPreviewStatus({ voice, state: "loading" });
    const prev = previewAudioRef.current;
    if (prev) {
      prev.pause();
      prev.currentTime = 0;
      prev.onended = null;
      prev.onerror = null;
    }
    window.dialogue
      .previewVoice({ voice })
      .then((r) => window.media.toUrl(r.path))
      .then((url) => {
        const audio = previewAudioRef.current ?? new Audio();
        previewAudioRef.current = audio;
        audio.src = url;
        audio.onended = () => setPreviewStatus(null);
        audio.onerror = () => setPreviewStatus(null);
        audio.play();
        setPreviewStatus({ voice, state: "playing" });
      })
      .catch((e) => {
        const msg = e?.message ?? String(e);
        const friendly = /timeout|timed out/i.test(msg)
          ? "该音色当前不可用（合成超时），请换个音色试试。"
          : msg;
        setPreviewStatus({ voice, state: "error", message: friendly });
        setAlertMsg(friendly);
      })
      .finally(() => {
        previewBusyRef.current = false;
      });
  }

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

  return (
    <>
      <div className="card-pad">
        <div className="panel-title">音色设置</div>
        <div className="hint">
          未设置时默认勾选一组常用音色；勾选哪个，语音合成和视频生成的下拉就显示哪个；
          清空并保存则两个页面都不显示普通音色（克隆音色始终显示）。修改后记得点「保存设置」。
        </div>
        <div className="row">
          <button
            className="link"
            onClick={() => setFavoriteVoices(VOICE_OPTIONS.map((v) => v.value))}
          >
            全选
          </button>
          <button className="link" onClick={() => setFavoriteVoices([])}>
            清空
          </button>
          <span className="hint">
            已勾选 {favoriteVoices.length} / {VOICE_OPTIONS.length}
          </span>
        </div>
        {voiceGroups.map((g) => (
          <div key={g.name} className="voice-check-group">
            <div className="voice-check-group-title">{g.name}</div>
            <div className="voice-check-grid">
              {g.items.map((v) => (
                <div key={v.value} className="voice-check-item">
                  <label className="voice-check-label">
                    <input
                      type="checkbox"
                      checked={favoriteVoices.includes(v.value)}
                      onChange={() => toggleFavorite(v.value)}
                    />
                    <span>{v.label}</span>
                  </label>
                  <button
                    className={`speaker-btn voice-preview-btn ${
                      previewStatus?.voice === v.value &&
                      previewStatus.state !== "error"
                        ? "active"
                        : ""
                    }`}
                    title={
                      previewStatus?.voice === v.value &&
                      previewStatus.state === "error"
                        ? previewStatus.message
                        : "试听当前音色"
                    }
                    disabled={
                      previewStatus?.voice === v.value &&
                      previewStatus.state === "loading"
                    }
                    onClick={() => previewVoice(v.value)}
                  >
                    <span className="speaker-icon">
                      {previewStatus?.voice === v.value &&
                      previewStatus.state === "loading" ? (
                        <HourglassIcon />
                      ) : (
                        <SpeakerIcon />
                      )}
                    </span>
                  </button>
                </div>
              ))}
            </div>
          </div>
        ))}
      </div>
      {error && <div className="error">{error}</div>}
      <SaveResetRow onSave={handleSave} onReset={handleReset} />
      {alertMsg && <AlertModal message={alertMsg} onClose={() => setAlertMsg(null)} />}
    </>
  );
}
