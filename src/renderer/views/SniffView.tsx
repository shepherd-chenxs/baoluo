/*
 * SPDX-License-Identifier: GPL-3.0-only
 * Copyright (c) 2026 宝螺 / Baoluo contributors
 * 本文件属于「宝螺 / Baoluo」。除 GPL-3.0 外还适用 ADDITIONAL_TERMS.md 里的附加条款：
 * 分发时须保留来源署名；修改版对外分发时不得沿用「宝螺」名称与图标。
 */
import { useCallback, useEffect, useState } from "react";
import type { ReactNode } from "react";
import type {
  AsrApi,
  RecordsApi,
  SniffApi,
  StoryboardApi,
} from "../../preload";
import type { VideoResolution } from "../../shared/dialogue-types";
import type {
  SniffProgress,
  SniffRecord,
} from "../../shared/sniff-types";
import type { WorkRecordSummary } from "../../shared/record-types";
import AppSelect from "../components/AppSelect";
import { useConfirm } from "../components/ConfirmDialog";
import SideList, { SideRow, formatListTime } from "../components/SideList";
import { usePageActive } from "../components/KeepAlive";

declare global {
  interface Window {
    sniff: SniffApi;
    asr: AsrApi;
    storyboard: StoryboardApi;
    records: RecordsApi;
  }
}

interface SniffViewProps {
  /** 左栏顶部的导航块（App 传下来的 SideNav） */
  nav?: ReactNode;
  onOpenStory?: () => void;
}

const STAGE_TEXT: Record<SniffProgress["stage"], string> = {
  transcribe: "转写文案",
  analyze: "AI 拆解",
  done: "完成",
  error: "失败",
};

export default function SniffView({ nav, onOpenStory }: SniffViewProps = {}) {
  /** 删除记录前先问一句（应用内确认框） */
  const [confirmDialog, confirmDelete] = useConfirm();
  const [filePath, setFilePath] = useState<string | null>(null);
  const [niche, setNiche] = useState("");
  const [running, setRunning] = useState(false);
  const [stage, setStage] = useState<SniffProgress["stage"] | null>(null);
  const [message, setMessage] = useState("");
  const [error, setError] = useState<string | null>(null);

  const [current, setCurrent] = useState<SniffRecord | null>(null);

  const [showTranscript, setShowTranscript] = useState(false);

  // 同方法换主题
  const [rewriteTopic, setRewriteTopic] = useState("");
  const [rewriteNiche, setRewriteNiche] = useState("");
  const [rewriteResolution, setRewriteResolution] =
    useState<VideoResolution>("portrait");
  const [rewriting, setRewriting] = useState(false);
  const [rewriteMsg, setRewriteMsg] = useState("");

  // ---- 左侧历史列表（一条 = 一次拆解） ----
  /** 页面被保活后隐藏的实例不消费进度广播；列表也只在真正显示时刷 */
  const pageActive = usePageActive();
  const [records, setRecords] = useState<WorkRecordSummary[]>([]);
  const [currentRecordId, setCurrentRecordId] = useState<string | null>(null);

  const reloadRecords = useCallback(async () => {
    try {
      setRecords(await window.records.list("sniff"));
    } catch {
      /* 列表拉不到不影响嗅探本身 */
    }
  }, []);

  /* 首次进来、以及每次切回本页都刷一次：页面是保活的，不会重挂 */
  useEffect(() => {
    if (!pageActive) return;
    void reloadRecords();
  }, [pageActive, reloadRecords]);

  /** 打开一条历史：把当时的拆解结果原样摆回来 */
  async function openRecord(id: string): Promise<void> {
    setError(null);
    try {
      const rec = await window.records.get<{ record: SniffRecord; niche: string }>("sniff", id);
      if (!rec) {
        await reloadRecords();
        return;
      }
      setCurrent(rec.payload.record);
      setFilePath(rec.payload.record.source.path);
      setNiche(rec.payload.niche ?? "");
      setRewriteNiche(rec.payload.record.niche ?? "");
      setCurrentRecordId(rec.id);
      setShowTranscript(false);
      setRewriteMsg("");
    } catch (e: any) {
      setError(e?.message ?? String(e));
    }
  }

  async function removeRecord(id: string, title: string): Promise<void> {
    if (!(await confirmDelete({ title: `删除记录「${title}」？`, detail: "删除后不可恢复。" }))) return;
    try {
      await window.records.remove("sniff", id);
      if (currentRecordId === id) setCurrentRecordId(null);
    } catch {
      /* 删不掉就让列表刷新出真相 */
    }
    await reloadRecords();
  }

  /** ＋新建：清空当前结果，回到"选一个文件"的初始样子 */
  function startFresh(): void {
    setCurrent(null);
    setFilePath(null);
    setNiche("");
    setRewriteTopic("");
    setRewriteNiche("");
    setRewriteMsg("");
    setShowTranscript(false);
    setError(null);
    setCurrentRecordId(null);
  }

  useEffect(() => {
    const off = window.sniff.onProgress((p) => {
      setStage(p.stage);
      setMessage(p.message);
    });
    return off;
  }, []);

  /** 选一个本地音视频文件（不联网、不从平台取内容） */
  async function pickFile() {
    setError(null);
    try {
      const p = await window.asr.chooseFile();
      if (p) setFilePath(p);
    } catch (e: any) {
      setError(e?.message ?? String(e));
    }
  }

  async function run() {
    const input = (filePath ?? "").trim();
    if (!input) {
      setError("请先选一个音视频文件。");
      return;
    }
    setError(null);
    setCurrent(null);
    setMessage("");
    if (!(await window.asr.isModelReady())) {
      const ok = window.confirm(
        "首次拆解需要下载本地语音识别模型（约 150 MB）。\n下载后一直保存在本地，之后无需重复下载。\n\n是否现在开始？"
      );
      if (!ok) return;
    }
    setRunning(true);
    setStage("transcribe");
    setMessage("正在准备…");
    const requestId = `sniff-${Date.now()}`;
    try {
      const rec = await window.sniff.run({
        filePath: input,
        niche: niche.trim() || undefined,
        requestId,
      });
      setCurrent(rec);
      setRewriteNiche(rec.niche);
      // 拆解完就进列表：以后想再看这份报告不用重跑一遍（重跑要转写，很贵）
      try {
        const saved = await window.records.save({
          kind: "sniff",
          title: rec.source.title || rec.source.path,
          subtitle: `${rec.analysis.topics?.length ?? 0} 个候选选题`,
          payload: { record: rec, niche: niche.trim() },
        });
        setCurrentRecordId(saved.id);
        await reloadRecords();
      } catch {
        /* 记录存不上不该影响这次拆解结果 */
      }
    } catch (e: any) {
      setError(e?.message ?? String(e));
    } finally {
      setRunning(false);
      setStage(null);
      setMessage("");
    }
  }

  async function rewrite() {
    if (!current) return;
    if (!rewriteTopic.trim()) {
      setError("先填一个你想做的主题，AI 会保留爆款方法、换成你的主题。");
      return;
    }
    setError(null);
    setRewriting(true);
    setRewriteMsg("正在按这套爆款方法生成新分镜…");
    try {
      const a = current.analysis;
      await window.storyboard.generate({
        topic: rewriteTopic.trim(),
        niche: (rewriteNiche || current.niche).trim() || undefined,
        resolution: rewriteResolution,
        durationSeconds: 30,
        method: {
          trigger: a.trigger,
          hook: a.hook,
          structure: a.structure,
          reusable: a.reusable,
          commentBait: a.commentBait,
        },
      });
      setRewriteMsg("✓ 新分镜已生成，去「热点成片」点“继续”即可接着做。");
      window.setTimeout(() => onOpenStory?.(), 900);
    } catch (e: any) {
      setError(e?.message ?? String(e));
      setRewriteMsg("");
    } finally {
      setRewriting(false);
    }
  }

  return (
    /* 整屏分左右两区：左区是标题 + 历史记录，右区是嗅探与报告（骨架与另外三页共用） */
    <div className="view sniff-view">
      <SideList
        nav={nav}
        section="历史"
        action={
          <button
            type="button"
            className="secondary small"
            onClick={startFresh}
            title="清空当前结果，贴一条新链接"
          >
            ＋ 新建
          </button>
        }
        hasItems={records.length > 0}
        empty={<>还没有记录。右边贴一条爆款链接，拆完就会自动存进这里。</>}
        items={records.map((r) => (
          <SideRow
            key={r.id}
            title={r.title}
            active={r.id === currentRecordId}
            meta={<span>{r.subtitle}</span>}
            time={formatListTime(r.updatedAt)}
            onOpen={() => void openRecord(r.id)}
            onDelete={() => void removeRecord(r.id, r.title)}
            deleteLabel={`删除记录 ${r.title}`}
          />
        ))}
      >
      {/* 页名放右区顶部（跟其他内容页一致）；左栏只留导航 + 历史列表 */}
      <h2 className="work-title">爆款嗅探</h2>
      <section className="card-pad sniff-input-card">
        <p className="subtitle">
          导入一段本地音视频文件，在本机转成文案后拆出可复用的方法。
          本工具不从任何平台解析或下载内容，请先自行取得有权处理的素材。
        </p>
        <div className="row">
          <button type="button" className="primary" onClick={() => void pickFile()} disabled={running}>
            选择音频 / 视频文件
          </button>
          {filePath && (
            <span className="asr-file-name" title={filePath}>{filePath}</span>
          )}
        </div>
        <div className="sniff-niche-row">
          <span className="story-field-label">赛道标签</span>
          <input
            className="sniff-niche-input"
            value={niche}
            placeholder="情感/职场/历史…"
            onChange={(e) => setNiche(e.target.value)}
            disabled={running}
          />
          <button
            type="button"
            className="primary"
            disabled={running || !filePath}
            onClick={() => void run()}
          >
            {running ? "拆解中…" : "🔍 开始拆解"}
          </button>
        </div>
        {running && stage && (
          <div className="sniff-progress">
            <span>
              {STAGE_TEXT[stage]} · {message}
            </span>
            <div className="progress-track">
              <div
                className="progress-fill sniff-progress-indeterminate"
                style={{ width: stage === "analyze" ? "72%" : stage === "done" ? "100%" : "38%" }}
              />
            </div>
          </div>
        )}
        {error && <div className="story-error"><span>{error}</span></div>}
      </section>

      {current && (
        <section className="card-pad sniff-analysis">
          <div className="panel-title-row">
            <span className="panel-title">🧬 拆解卡</span>
            <span className="story-muted">
              {current.source.title || "未命名"} · {current.source.path}
            </span>
          </div>

          <div className="sniff-analysis-grid">
            <div className="sniff-analysis-item">
              <span className="story-field-label">流量类型</span>
              <span className="sniff-chip">{current.analysis.trigger}</span>
            </div>
            <div className="sniff-analysis-item wide">
              <span className="story-field-label">开头钩子</span>
              <p>{current.analysis.hook}</p>
            </div>
            <div className="sniff-analysis-item wide">
              <span className="story-field-label">叙事结构</span>
              <ol className="sniff-structure">
                {current.analysis.structure.map((s, i) => (
                  <li key={i}>{s}</li>
                ))}
              </ol>
            </div>
            <div className="sniff-analysis-item wide">
              <span className="story-field-label">可复用方法</span>
              <p>{current.analysis.reusable}</p>
            </div>
            {current.analysis.commentBait && (
              <div className="sniff-analysis-item wide">
                <span className="story-field-label">互动钩子</span>
                <p>{current.analysis.commentBait}</p>
              </div>
            )}
            {current.analysis.topics && current.analysis.topics.length > 0 && (
              <div className="sniff-analysis-item wide">
                <span className="story-field-label">选题建议</span>
                <div className="sniff-topic-suggestions">
                  {current.analysis.topics.map((t) => (
                    <button
                      type="button"
                      key={t}
                      className={`sniff-topic-chip ${rewriteTopic === t ? "active" : ""}`}
                      onClick={() => {
                        setRewriteTopic(t);
                        setError(null);
                      }}
                    >
                      {rewriteTopic === t ? "✓ " : ""}
                      {t}
                    </button>
                  ))}
                </div>
              </div>
            )}
          </div>

          <button
            type="button"
            className="link"
            onClick={() => setShowTranscript((v) => !v)}
          >
            {showTranscript ? "收起转写原文" : "查看转写原文"}
          </button>
          {showTranscript && (
            <pre className="sniff-transcript">{current.transcript || "（无口播文案）"}</pre>
          )}

          <div className="sniff-divider" />

          <div className="panel-title">✍️ 套用方法写我的主题</div>
          <div className="sniff-rewrite-row">
            <input
              className="sniff-topic-input"
              value={rewriteTopic}
              placeholder="选上面的建议主题，或自己填一个"
              onChange={(e) => setRewriteTopic(e.target.value)}
              disabled={rewriting}
            />
            <input
              className="sniff-niche-input"
              value={rewriteNiche}
              placeholder="赛道标签"
              onChange={(e) => setRewriteNiche(e.target.value)}
              disabled={rewriting}
            />
            <AppSelect
              value={rewriteResolution}
              options={[
                { value: "portrait", label: "竖屏 9:16" },
                { value: "landscape", label: "横屏 16:9" },
              ]}
              onChange={(v) => setRewriteResolution(v as VideoResolution)}
            />
            <button
              type="button"
              className="primary"
              disabled={rewriting}
              onClick={() => void rewrite()}
            >
              {rewriting ? "生成中…" : "✨ 生成新分镜"}
            </button>
          </div>
          {rewriteMsg && <div className="story-gen-tip">{rewriteMsg}</div>}
        </section>
      )}
      </SideList>
      {confirmDialog}
    </div>
  );
}
