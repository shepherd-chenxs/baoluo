/*
 * SPDX-License-Identifier: GPL-3.0-only
 * Copyright (c) 2026 宝螺 / Baoluo contributors
 * 本文件属于「宝螺 / Baoluo」。除 GPL-3.0 外还适用 ADDITIONAL_TERMS.md 里的附加条款：
 * 分发时须保留来源署名；修改版对外分发时不得沿用「宝螺」名称与图标。
 */
/**
 * 图文解说：单个镜头的真人录音条。
 *
 * 交互：🎙 录音 → 停止 → 自动落盘（dialogue:saveRecording）→ 回显「真人录音 · 时长」，
 * 带试听 / 重录 / 清除。合成时这一镜直接用录音（跳过 TTS），没录的镜头照常走音色——
 * 允许一部分真人、一部分机器混着来。
 *
 * 录音在渲染层用 MediaRecorder 完成（webm/opus，ffmpeg 直接吃）；
 * 麦克风权限由主进程放行（见 main/index.ts 的 setPermissionRequestHandler）。
 */
import { useCallback, useEffect, useRef, useState, type ReactNode } from "react";
import { useConfirm } from "../ConfirmDialog";

interface ShotRecorderProps {
  /** 已录好的音频路径；空 = 还没录 */
  audioPath?: string;
  /** 录完/清除后回写场景（undefined = 清除） */
  onChange: (path: string | undefined) => void;
  onError: (msg: string) => void;
  /** 合成中等全局禁用态 */
  disabled?: boolean;
  /** 这一镜现有的解说词（「生成字幕」覆盖前拿它做确认对比） */
  text?: string;
  /** 「生成字幕」把识别结果写回解说词 */
  onTextChange?: (text: string) => void;
  /**
   * 文案口吻：镜头（图文解说）/ 台词（对话模式）。
   * 两边录的是同一种东西，只是"这一镜"和"这一句"读起来不一样。
   */
  variant?: "shot" | "line";
}

function fmtSec(s: number): string {
  const m = Math.floor(s / 60);
  const ss = s % 60;
  return `${m}:${String(ss).padStart(2, "0")}`;
}

/** 录音上限：超过自动停（防止忘关一直录） */
const MAX_SECONDS = 10 * 60;

export default function ShotRecorder({
  audioPath,
  onChange,
  onError,
  disabled,
  text,
  onTextChange,
}: ShotRecorderProps): ReactNode {
  const [phase, setPhase] = useState<"idle" | "recording" | "saving">("idle");
  /** 「生成字幕」识别中（本地 Whisper，可能要等几秒到几十秒） */
  const [transcribing, setTranscribing] = useState(false);
  /** 「生成字幕」覆盖已有解说词前的确认框 */
  const [confirmDialog, confirmOverwrite] = useConfirm();
  const [seconds, setSeconds] = useState(0);
  /** 已存录音的时长（秒）：audio 元素 metadata 加载后回填 */
  const [savedDur, setSavedDur] = useState<number | null>(null);
  const [playUrl, setPlayUrl] = useState<string>("");
  const [playing, setPlaying] = useState(false);
  /** 试听进度（秒）：驱动播放条的进度填充 */
  const [playPos, setPlayPos] = useState(0);
  const recRef = useRef<MediaRecorder | null>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const chunksRef = useRef<Blob[]>([]);
  const timerRef = useRef<number | null>(null);
  const audioElRef = useRef<HTMLAudioElement | null>(null);

  const stopStream = useCallback(() => {
    streamRef.current?.getTracks().forEach((t) => t.stop());
    streamRef.current = null;
    if (timerRef.current) {
      window.clearInterval(timerRef.current);
      timerRef.current = null;
    }
  }, []);

  // 卸载收尾：关流、停播放
  useEffect(() => {
    return () => {
      stopStream();
      audioElRef.current?.pause();
    };
  }, [stopStream]);

  // 有已存录音：取回放 URL + 时长（时长主进程探：<audio> 读 webm 时长不可靠）
  useEffect(() => {
    let alive = true;
    setSavedDur(null);
    if (!audioPath) {
      setPlayUrl("");
      return;
    }
    window.media
      .toUrl(audioPath)
      .then((u) => {
        if (alive) setPlayUrl(u);
      })
      .catch(() => {});
    window.dialogue
      .audioDuration(audioPath)
      .then((d) => {
        if (alive && d > 0) setSavedDur(d);
      })
      .catch(() => {});
    return () => {
      alive = false;
    };
  }, [audioPath]);

  // 录音到上限自动停
  useEffect(() => {
    if (phase === "recording" && seconds >= MAX_SECONDS) stopRecord();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [seconds, phase]);

  async function startRecord(): Promise<void> {
    onError("");
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      streamRef.current = stream;
      const mime = MediaRecorder.isTypeSupported("audio/webm;codecs=opus")
        ? "audio/webm;codecs=opus"
        : "";
      const rec = new MediaRecorder(stream, mime ? { mimeType: mime } : undefined);
      chunksRef.current = [];
      rec.ondataavailable = (e) => {
        if (e.data.size) chunksRef.current.push(e.data);
      };
      rec.onstop = async () => {
        stopStream();
        const blob = new Blob(chunksRef.current, { type: rec.mimeType || "audio/webm" });
        chunksRef.current = [];
        if (!blob.size) {
          setPhase("idle");
          onError("录音是空的，再试一次。");
          return;
        }
        setPhase("saving");
        try {
          const r = await window.dialogue.saveRecording(await blob.arrayBuffer());
          // 主进程转码时顺手探好了时长：录完立刻显示，不等 <audio> 加载
          if (r.durationSec > 0) setSavedDur(Math.round(r.durationSec));
          onChange(r.path);
        } catch (e: any) {
          onError(e?.message ?? String(e));
        } finally {
          setPhase("idle");
        }
      };
      recRef.current = rec;
      setSeconds(0);
      setPhase("recording");
      rec.start();
      timerRef.current = window.setInterval(() => setSeconds((s) => s + 1), 1000);
    } catch (e: any) {
      stopStream();
      setPhase("idle");
      const denied = e?.name === "NotAllowedError" || e?.name === "PermissionDeniedError";
      onError(denied ? "麦克风权限被拒绝：请在系统设置里允许宝螺使用麦克风。" : `打不开麦克风：${e?.message ?? e}`);
    }
  }

  function stopRecord(): void {
    if (recRef.current && recRef.current.state !== "inactive") recRef.current.stop();
  }

  function togglePlay(): void {
    const el = audioElRef.current;
    if (!el || !playUrl) return;
    if (playing) {
      el.pause();
      return;
    }
    void el.play().catch(() => onError("试听失败：录音文件可能已损坏。"));
  }

  async function clearRecord(): Promise<void> {
    if (audioPath) void window.dialogue.deleteRecording(audioPath).catch(() => {});
    audioElRef.current?.pause();
    setPlaying(false);
    onChange(undefined);
  }

  /**
   * 生成字幕：把这段录音交给本地 Whisper 识别成文字，写回这一镜的解说词。
   * 已有解说词时先确认（识别结果会覆盖它）。
   */
  async function transcribe(): Promise<void> {
    if (!audioPath || !onTextChange) return;
    const old = (text ?? "").trim();
    if (old) {
      const ok = await confirmOverwrite({
        title: "用识别结果替换现有解说词？",
        detail: "这一镜已经有解说词，「生成字幕」会用录音识别出的文字覆盖它。",
        confirmLabel: "替换",
      });
      if (!ok) return;
    }
    onError("");
    setTranscribing(true);
    try {
      const r = await window.dialogue.transcribeAudio(audioPath);
      const got = (r.text ?? "").trim();
      if (!got) {
        onError("没听出内容：录音可能太短或太安静，重录一段再试。");
        return;
      }
      // Whisper 的分段就是自然的句子：逐段一行，换行即分条字幕（与本页约定一致）
      const lines = (r.segments ?? [])
        .map((s) => s.text.trim())
        .filter(Boolean);
      onTextChange((lines.length ? lines.join("\n") : got).replace(/\s*\n\s*/g, "\n"));
    } catch (e: any) {
      onError(e?.message ?? String(e));
    } finally {
      setTranscribing(false);
    }
  }

  // 有录音：迷你播放条（点它播放/暂停）+ 少量动作
  if (audioPath && phase !== "recording") {
    const dur = savedDur ?? 0;
    const pct = dur > 0 ? Math.min(100, (playPos / dur) * 100) : 0;
    return (
      <div className="shot-inline-row shot-recorder">
        {/* 左标签跟「音色」行对齐：这一行是这一镜的声音来源 */}
        <span className="story-field-label">录音</span>
        <audio
          ref={audioElRef}
          src={playUrl || undefined}
          preload="metadata"
          onTimeUpdate={(e) => setPlayPos(e.currentTarget.currentTime)}
          onPlay={() => setPlaying(true)}
          onPause={() => setPlaying(false)}
          onEnded={() => {
            setPlaying(false);
            setPlayPos(0);
          }}
        />
        <button
          type="button"
          className="shot-rec-bar"
          onClick={togglePlay}
          disabled={disabled || !playUrl}
          title={playing ? "暂停" : "试听这段录音"}
          aria-label={playing ? "暂停" : "试听"}
        >
          <span className="shot-rec-play" aria-hidden="true">
            {playing ? "❚❚" : "▶"}
          </span>
          <span className="shot-rec-track">
            <span className="shot-rec-fill" style={{ width: `${pct}%` }} />
          </span>
        </button>
        {/* 时长跟在播放条后面 */}
        {savedDur != null && <span className="shot-rec-dur">{fmtSec(savedDur)}</span>}
        <span className="shot-rec-actions">
          <button
            type="button"
            className="secondary small secondary-plain"
            onClick={() => void transcribe()}
            disabled={disabled || transcribing || !onTextChange}
            title="用本地语音识别把这段录音转成解说词（写回上面的文本框）"
          >
            {transcribing ? "识别中…" : "生成字幕"}
          </button>
          <button
            type="button"
            className="secondary small secondary-plain"
            onClick={() => void startRecord()}
            disabled={disabled || phase === "saving"}
          >
            {phase === "saving" ? "保存中…" : "重录"}
          </button>
          <button
            type="button"
            className="danger small danger-plain"
            onClick={() => void clearRecord()}
            disabled={disabled}
            title="清掉这一镜的录音（文件一起删）"
          >
            清除
          </button>
        </span>
        {confirmDialog}
      </div>
    );
  }

  // 没录音 / 正在录
  return (
    <div className={`shot-inline-row shot-recorder${phase === "recording" ? " recording" : ""}`}>
      {phase === "recording" ? (
        <>
          <span className="shot-rec-dot" aria-hidden="true" />
          <span className="shot-rec-time">{fmtSec(seconds)}</span>
          <button type="button" className="secondary small" onClick={stopRecord}>
            ⏹ 停止
          </button>
          <span className="story-muted">照着解说词念，录完自动保存</span>
        </>
      ) : (
        <>
          <button
            type="button"
            className="secondary small secondary-plain"
            onClick={() => void startRecord()}
            disabled={disabled || phase === "saving"}
            title="录这一镜的真人解说（合成时优先用它，不再走音色）"
          >
            {phase === "saving" ? "保存中…" : "🎙 录音"}
          </button>
          <span className="story-muted">真人解说：录一段念这段解说词的声音</span>
        </>
      )}
    </div>
  );
}
