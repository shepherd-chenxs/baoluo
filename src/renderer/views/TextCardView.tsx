/**
 * 文字卡视频（插件页）：文案 → 卡片 → 成片。
 *
 * 页面只管"长什么样"和"什么时候开始跑"：
 *   · 预览用同一份模板 HTML（shared/textcard-types）塞进 iframe，和导出的图一模一样；
 *   · 出图 + 合成全在主进程（./main/textcard），这里只收进度。
 *
 * 为什么先做成插件页再谈自动化：这套东西先得让人眼看一遍（字号、留白、节奏），
 * 参数定下来之后接进工作台才是"填参数、出片"，不用边跑边改。
 */
import { useEffect, useMemo, useRef, useState } from "react";
import type { ReactNode } from "react";
import { stripIpc } from "../lib/err-text";
import type { DialogueApi, LocalTtsApi, MediaApi, SettingsApi, TextCardApi } from "../../preload";
import type { CloneVoice } from "../../shared/dialogue-types";
import { VOICE_OPTIONS } from "../../shared/voices";
import { DEFAULT_VOICE_NARRATOR } from "../../shared/settings-defaults";
import {
  CUSTOM_TEMPLATE_ID,
  DEFAULT_CARD_TEXT,
  TEXT_CARD_MOTIONS,
  TEXT_CARD_RATIOS,
  TEXT_CARD_STYLES,
  TEXT_CARD_TEMPLATES,
  TEXT_CARD_TRANSITIONS,
  autoSeconds,
  buildPreviewHtml,
  cardSize,
  parseCards,
  type TextCard,
  type TextCardMotion,
  type TextCardOptions,
  type TextCardProgress,
  type TextCardRatio,
  type TextCardResult,
  type TextCardStyle,
  type TextCardTemplate,
  type TextCardTransition,
} from "../../shared/textcard-types";

declare global {
  interface Window {
    textcard: TextCardApi;
    media: MediaApi;
    dialogue: DialogueApi;
    settings: SettingsApi;
    localTts: LocalTtsApi;
  }
}

/** 每张卡停留秒数：文字卡是"读一句"的节奏，2~3 秒最常见 */
const DURATIONS = [1.5, 2, 2.5, 3, 4, 6];
/** 卡点 BPM 档位：每卡 2 拍（72→1.667s、96→1.25s、120→1s、150→0.8s），故意错开 DURATIONS 免得两排同时亮 */
const BPMS = [72, 96, 120, 150];
const bpmSeconds = (bpm: number): number => +(120 / bpm).toFixed(3);

/* ---- 模板相册的缩略图：静态样张，模块加载时算一次，之后不再重渲染 ----
   为什么不用用户当前文案：每个键入都要重画 8 个 iframe，不值当；
   缩略图只表达"这套模板长什么样"，主预览才是所见即所得。 */
const THUMB_CARD: TextCard = { lead: "示例标题", body: "副文案一行" };
/** 缩略图格子的内框尺寸（三列布局，格子内宽约 62px） */
const THUMB_BOX_H = 60;
const THUMB_CELL_W = 60;

function tplThumbOpts(t: TextCardTemplate): TextCardOptions {
  return { style: t.style, ratio: t.ratio, seconds: 2.5, motion: t.motion, transition: t.transition };
}

const THUMB_HTML: Record<string, string> = Object.fromEntries(
  TEXT_CARD_TEMPLATES.map((t) => [t.id, buildPreviewHtml(THUMB_CARD, 0, 1, tplThumbOpts(t))])
);

function tplThumbGeom(t: TextCardTemplate): { scale: number; w: number; h: number } {
  const { w, h } = cardSize(t.ratio);
  // 双向都卡住：竖屏受高限制、横屏受宽限制
  return { scale: Math.min(THUMB_BOX_H / h, THUMB_CELL_W / w), w, h };
}

function errText(e: unknown): string {
  return stripIpc(e instanceof Error ? e.message : String(e));
}

export default function TextCardView(): ReactNode {
  const [text, setText] = useState(DEFAULT_CARD_TEXT);
  /** 选中的模板：非自定义时外观/画幅/动效/转场/节奏全部由模板给 */
  const [tplId, setTplId] = useState("quote");
  // 自定义档才用到的参数（选「自定义」伪模板时露出）
  const [style, setStyle] = useState<TextCardStyle>("plain");
  const [ratio, setRatio] = useState<TextCardRatio>("portrait");
  const [seconds, setSeconds] = useState(2.5);
  const [idx, setIdx] = useState(0);
  // 配音：开着才把 voice/bgm 塞进 options，关着完全走老行为
  const [voiceOn, setVoiceOn] = useState(false);
  const [voice, setVoice] = useState(DEFAULT_VOICE_NARRATOR);
  const [clones, setClones] = useState<CloneVoice[]>([]);
  const [bgmPath, setBgmPath] = useState<string | null>(null);
  const [bgmVolume, setBgmVolume] = useState(0.15);
  // 动效与转场
  const [motion, setMotion] = useState<TextCardMotion>("auto");
  const [transition, setTransition] = useState<TextCardTransition>("fade");

  const [busy, setBusy] = useState(false);
  const [progress, setProgress] = useState<TextCardProgress | null>(null);
  const [result, setResult] = useState<TextCardResult | null>(null);
  /** 这条成片是用哪个模板出的：切模板后预览变了、成片还是上一条，不标一下会以为对不上 */
  const [resultTpl, setResultTpl] = useState<string>("");
  const [videoUrl, setVideoUrl] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  /** 中止是用户主动行为，不该报红：跟真失败分开放 */
  const [notice, setNotice] = useState<string | null>(null);
  const requestRef = useRef<string | null>(null);

  const cards = useMemo(() => parseCards(text), [text]);
  const tpl = TEXT_CARD_TEMPLATES.find((t) => t.id === tplId) ?? TEXT_CARD_TEMPLATES[0];
  const isCustom = tpl.id === CUSTOM_TEMPLATE_ID;

  /**
   * 生效参数：模板档 = 模板说什么是什么（auto 档把逐卡节奏算好塞进 durations）；
   * 自定义档 = 左栏那排参数。preview 与 render 都吃这一份，所见即所得。
   */
  const options = useMemo<TextCardOptions>(() => {
    const voicePart = voiceOn ? { voice, bgmPath: bgmPath ?? undefined, bgmVolume } : {};
    if (isCustom) {
      return { style, ratio, seconds, motion, transition, ...voicePart };
    }
    return {
      style: tpl.style,
      ratio: tpl.ratio,
      motion: tpl.motion,
      transition: tpl.transition,
      seconds: typeof tpl.seconds === "number" ? tpl.seconds : 2.5,
      ...(tpl.seconds === "auto" ? { durations: cards.map(autoSeconds) } : {}),
      ...voicePart,
    };
  }, [isCustom, tpl, style, ratio, seconds, motion, transition, cards, voiceOn, voice, bgmPath, bgmVolume]);

  /** 左栏模板下面那行节奏提示 */
  const rhythmHint = useMemo<string>(() => {
    if (isCustom) return `${cards.length} 张卡 · 节奏在下面自己调`;
    if (typeof tpl.seconds !== "number") {
      const total = cards.reduce((s, c) => s + autoSeconds(c), 0);
      return `共 ${cards.length} 张 · 每张按字数自动停留 · 全片约 ${total.toFixed(1)} 秒`;
    }
    return `共 ${cards.length} 张 · 每张 ${tpl.seconds}s · 全片约 ${(cards.length * tpl.seconds).toFixed(1)} 秒`;
  }, [isCustom, tpl, cards]);
  const voiceOptions = useMemo(
    () => [...VOICE_OPTIONS, ...clones.map((v) => ({ value: `clone:${v.id}`, label: `克隆·${v.name}` }))],
    [clones]
  );
  const safeIdx = Math.min(idx, Math.max(0, cards.length - 1));
  const cur = cards[safeIdx] ?? { lead: "", body: "" };

  useEffect(() => {
    if (idx > 0 && idx > cards.length - 1) setIdx(Math.max(0, cards.length - 1));
  }, [cards.length, idx]);

  const { w, h } = cardSize(ratio);
  const previewHtml = useMemo(
    () => buildPreviewHtml(cur, safeIdx, Math.max(1, cards.length), options),
    [cur, safeIdx, cards.length, options]
  );

  /* 预览缩放：竖屏 1080×1920 塞不进半屏，按容器实际宽/高取小的那个等比缩。
     舞台尺寸完全由 CSS（flex）给，不写 inline height —— 否则"按高度算缩放、
     又用缩放写高度"会自己追自己，越缩越小。 */
  const stageRef = useRef<HTMLDivElement>(null);
  const [scale, setScale] = useState(0.32);
  useEffect(() => {
    const el = stageRef.current;
    if (!el) return;
    const fit = () => {
      const boxW = el.clientWidth;
      const boxH = el.clientHeight;
      if (boxW > 0 && boxH > 0) setScale(Math.max(0.05, Math.min(boxW / w, boxH / h)));
    };
    fit();
    const ro = new ResizeObserver(fit);
    ro.observe(el);
    window.addEventListener("resize", fit);
    return () => {
      ro.disconnect();
      window.removeEventListener("resize", fit);
    };
  }, [w, h]);

  useEffect(
    () =>
      window.textcard.onProgress((p) => {
        // 只认自己这一轮：切页回来时可能还挂着上一条监听
        if (p.requestId === requestRef.current) setProgress(p);
      }),
    []
  );

  /* 克隆音色列表（设置里配的），拿不到就只用 Edge 音色 */
  useEffect(() => {
    let alive = true;
    window.settings
      .get()
      .then((s) => {
        if (alive) setClones(s.cloneVoices ?? []);
      })
      .catch(() => {
        /* 设置读不出来不影响主流程 */
      });
    return () => {
      alive = false;
    };
  }, []);

  async function generate(): Promise<void> {
    if (busy || !cards.length) return;
    setError(null);
    setNotice(null);
    setResult(null);
    setVideoUrl(null);
    setResultTpl(isCustom ? "自定义" : tpl.name);
    const requestId = `tc-${Date.now()}`;
    requestRef.current = requestId;
    setBusy(true);
    setProgress({
      requestId,
      stage: "capture",
      index: 0,
      total: cards.length,
      percent: 0,
      message: "准备中…",
    });
    try {
      const r = await window.textcard.render({ requestId, cards, options });
      setResult(r);
      setVideoUrl(await window.media.toUrl(r.videoPath));
    } catch (e: unknown) {
      const msg = errText(e);
      // 主进程中止时抛的就是「已取消」：这是用户自己按的，别当报错显示
      if (msg.includes("取消")) setNotice("已中止，这次没有生成成片。");
      else setError(msg);
    } finally {
      setBusy(false);
      requestRef.current = null;
      setProgress(null);
    }
  }

  async function cancel(): Promise<void> {
    const id = requestRef.current;
    if (id) await window.textcard.cancel(id);
  }

  async function pickBgm(): Promise<void> {
    const p = await window.localTts.chooseAudio();
    if (p) setBgmPath(p);
  }

  const pct = progress?.percent ?? 0;

  return (
    <div className="split tc-split">
      <aside className="split-list tc-side">
        <h2 className="split-title">文字卡视频</h2>
        <p className="tc-lead-hint">
          一行一句，第一行是大字；空一行分卡。两颗星包住的词标重点色，如 <code>*别等*</code>。纯本地渲染，不花额度。
        </p>

        <div className="tc-field">
          <span className="tc-label">模板</span>
          <div className="tc-tpl-grid">
            {TEXT_CARD_TEMPLATES.map((t) => {
              const g = tplThumbGeom(t);
              return (
                <button
                  key={t.id}
                  type="button"
                  className={`tc-tpl${tplId === t.id ? " active" : ""}`}
                  onClick={() => setTplId(t.id)}
                  disabled={busy}
                  title={`${t.name} · ${t.tagline}`}
                >
                  <span className="tc-tpl-thumb">
                    {t.id === CUSTOM_TEMPLATE_ID ? (
                      <span className="tc-tpl-custom-mark">⚙</span>
                    ) : (
                      /* 缩略图是静态样张（模块级算一次）。外框按缩放后的尺寸撑开，
                         里面 iframe 从左上角 scale——用 translate(-50%,-50%) 的百分比
                         会按未缩放的 1080×1920 算，把画面推出格子里（踩过一次）。 */
                      <span
                        className="tc-tpl-fit"
                        style={{ width: Math.round(g.w * g.scale), height: Math.round(g.h * g.scale) }}
                      >
                        <iframe
                          title={`${t.name} 缩略图`}
                          srcDoc={THUMB_HTML[t.id]}
                          scrolling="no"
                          tabIndex={-1}
                          style={{
                            width: g.w,
                            height: g.h,
                            transform: `scale(${g.scale})`,
                            pointerEvents: "none",
                          }}
                        />
                      </span>
                    )}
                  </span>
                  <span className="tc-tpl-name">{t.name}</span>
                </button>
              );
            })}
          </div>
          <span className="tc-hint">{rhythmHint}</span>
        </div>

        {/* 参数只在「自定义」那张伪模板下露出：其余模板一切都是自带的 */}
        {isCustom && (
          <>
            <div className="tc-field">
              <span className="tc-label">外观</span>
              <div className="tc-chips">
                {TEXT_CARD_STYLES.map((s) => (
                  <button
                    key={s.value}
                    type="button"
                    className={`tc-chip${style === s.value ? " active" : ""}`}
                    onClick={() => setStyle(s.value)}
                    disabled={busy}
                  >
                    <span className={`tc-dot tc-dot-${s.value}`} aria-hidden="true" />
                    {s.label}
                  </button>
                ))}
              </div>
            </div>

            <div className="tc-field">
              <span className="tc-label">画幅</span>
              <div className="tc-chips">
                {TEXT_CARD_RATIOS.map((r) => (
                  <button
                    key={r.value}
                    type="button"
                    className={`tc-chip${ratio === r.value ? " active" : ""}`}
                    title={r.hint}
                    onClick={() => setRatio(r.value)}
                    disabled={busy}
                  >
                    {r.label}
                  </button>
                ))}
              </div>
              <span className="tc-hint">{TEXT_CARD_RATIOS.find((r) => r.value === ratio)?.hint}</span>
            </div>

        <div className="tc-field">
          <span className="tc-label">每张停留</span>
          <div className="tc-chips">
            {DURATIONS.map((d) => (
              <button
                key={d}
                type="button"
                className={`tc-chip${seconds === d ? " active" : ""}`}
                onClick={() => setSeconds(d)}
                disabled={busy}
              >
                {d}s
              </button>
            ))}
          </div>
          <span className="tc-hint">
            {voiceOn
              ? `共 ${cards.length} 张 · 时长跟着配音走（配不上的卡用 ${seconds}s）`
              : `共 ${cards.length} 张 · 约 ${(cards.length * seconds).toFixed(1)} 秒`}
          </span>
        </div>

        <div className="tc-field">
          <span className="tc-label">卡点</span>
          <div className="tc-chips">
            {BPMS.map((b) => (
              <button
                key={b}
                type="button"
                className={`tc-chip${Math.abs(seconds - bpmSeconds(b)) < 0.01 ? " active" : ""}`}
                onClick={() => setSeconds(bpmSeconds(b))}
                disabled={busy}
              >
                {b} BPM
              </button>
            ))}
          </div>
          <span className="tc-hint">每卡 2 拍（{seconds}s）。卡点建议配「硬切」或「白闪」。</span>
        </div>

        <div className="tc-field">
          <span className="tc-label">卡内动效</span>
          <div className="tc-chips">
            {TEXT_CARD_MOTIONS.map((m) => (
              <button
                key={m.value}
                type="button"
                className={`tc-chip${motion === m.value ? " active" : ""}`}
                onClick={() => setMotion(m.value)}
                disabled={busy}
              >
                {m.label}
              </button>
            ))}
          </div>
        </div>

        <div className="tc-field">
          <span className="tc-label">卡间转场</span>
          <div className="tc-chips">
            {TEXT_CARD_TRANSITIONS.map((t) => (
              <button
                key={t.value}
                type="button"
                className={`tc-chip${transition === t.value ? " active" : ""}`}
                onClick={() => setTransition(t.value)}
                disabled={busy}
              >
                {t.label}
              </button>
            ))}
          </div>
          <span className="tc-hint">
            {motion === "auto" && transition === "fade" ? "默认就是自动轮换 + 淡入淡出。" : undefined}
          </span>
        </div>
          </>
        )}

        {/* 配音摆在参数之后：模板档是「模板 → 配音 → 生成」，自定义档是「模板 → 参数 → 配音 → 生成」 */}
        <div className="tc-field">
          <span className="tc-label">配音</span>
          <div className="tc-chips">
            <button
              type="button"
              className={`tc-chip${!voiceOn ? " active" : ""}`}
              onClick={() => setVoiceOn(false)}
              disabled={busy}
            >
              静音
            </button>
            <button
              type="button"
              className={`tc-chip${voiceOn ? " active" : ""}`}
              onClick={() => setVoiceOn(true)}
              disabled={busy}
            >
              朗读配音
            </button>
          </div>
          {voiceOn && (
            <>
              <select
                className="tc-select"
                value={voice}
                onChange={(e) => setVoice(e.target.value)}
                disabled={busy}
              >
                {voiceOptions.map((v) => (
                  <option key={v.value} value={v.value}>
                    {v.label}
                  </option>
                ))}
              </select>
              <div className="tc-bgm-row">
                {bgmPath ? (
                  <>
                    <span className="tc-bgm-name" title={bgmPath}>
                      {bgmPath.split(/[\\/]/).pop()}
                    </span>
                    <button
                      type="button"
                      className="tc-bgm-clear"
                      onClick={() => setBgmPath(null)}
                      disabled={busy}
                      aria-label="清除背景音乐"
                    >
                      ×
                    </button>
                  </>
                ) : (
                  <button type="button" className="tc-chip" onClick={() => void pickBgm()} disabled={busy}>
                    ＋ 选背景音乐
                  </button>
                )}
                <select
                  className="tc-select tc-select-vol"
                  value={bgmVolume}
                  onChange={(e) => setBgmVolume(Number(e.target.value))}
                  disabled={busy || !bgmPath}
                >
                  <option value={0.08}>BGM 轻</option>
                  <option value={0.15}>BGM 中</option>
                  <option value={0.25}>BGM 响</option>
                </select>
              </div>
              <span className="tc-hint">每张卡念完自动翻页。Edge 音色需联网，克隆音色需本地服务在跑。</span>
            </>
          )}
        </div>

        <div className="tc-side-foot">
          {busy ? (
            <>
              <div className="tc-bar">
                <span style={{ width: `${pct}%` }} />
              </div>
              <div className="tc-progress-text">{progress?.message ?? "正在跑…"}</div>
              <button type="button" className="secondary secondary-outlined" onClick={() => void cancel()}>
                中止
              </button>
            </>
          ) : (
            <button type="button" className="primary tc-go" onClick={() => void generate()} disabled={!cards.length}>
              生成视频
            </button>
          )}
        </div>
      </aside>

      <div className="split-work tc-work">
        <div className="tc-editor">
          <div className="tc-pane-head">
            <span className="panel-title">文案</span>
            <span className="tc-hint">{cards.length} 张卡</span>
          </div>
          <textarea
            className="tc-text"
            value={text}
            spellCheck={false}
            onChange={(e) => setText(e.target.value)}
            placeholder={"想做就去做\n别等*准备好*了才开始。\n\n空一行 = 换一张卡\n*词* = 重点色"}
          />
        </div>

        <div className="tc-preview">
          <div className="tc-pane-head">
            <span className="panel-title">预览</span>
            {cards.length > 1 && (
              <span className="tc-pager">
                <button
                  type="button"
                  onClick={() => setIdx(Math.max(0, safeIdx - 1))}
                  disabled={safeIdx <= 0}
                  aria-label="上一张"
                >
                  ‹
                </button>
                <span>
                  {safeIdx + 1} / {cards.length}
                </span>
                <button
                  type="button"
                  onClick={() => setIdx(Math.min(cards.length - 1, safeIdx + 1))}
                  disabled={safeIdx >= cards.length - 1}
                  aria-label="下一张"
                >
                  ›
                </button>
              </span>
            )}
          </div>

          <div className="tc-stage" ref={stageRef}>
            <iframe
              title="卡片预览"
              srcDoc={previewHtml}
              scrolling="no"
              style={{ width: w, height: h, transform: `translate(-50%, -50%) scale(${scale})` }}
            />
          </div>

          {notice && <div className="tc-hint tc-notice">{notice}</div>}
          {error && <div className="error tc-error">{error}</div>}

          {result && videoUrl && (
            <div className="tc-result">
              <div className="tc-pane-head">
                <span className="panel-title">成片</span>
                <span className="tc-hint">
                  {resultTpl} · {result.count} 段 · {result.durationSec} 秒
                </span>
              </div>
              {result.note && <div className="tc-hint tc-notice">{result.note}</div>}
              {/* 定尺盒子：竖屏/横屏都装得下，宽度不随视频比例抖（百分比 max-width
                  在 grid 的 auto 列里会算成怪值，之前横屏被压成一条黑边） */}
              <div className="tc-video-box">
                <video className="tc-video" src={videoUrl} controls />
              </div>
              <div className="tc-result-info">
                <span className="tc-path" title={result.videoPath}>
                  {result.videoPath}
                </span>
                <button
                  type="button"
                  className="secondary secondary-outlined tc-open-dir"
                  onClick={() => void window.dialogue.showInFolder(result.videoPath)}
                >
                  在目录中显示
                </button>
              </div>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
