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
import BeeSelect from "../components/BeeSelect";
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
  parse: "解析链接",
  download: "下载视频",
  transcribe: "转写文案",
  analyze: "AI 拆解",
  done: "完成",
  error: "失败",
};

export default function SniffView({ nav, onOpenStory }: SniffViewProps = {}) {
  /** 删除记录前先问一句（应用内确认框） */
  const [confirmDialog, confirmDelete] = useConfirm();
  const [link, setLink] = useState("");
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
      setLink(rec.payload.record.source.url);
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

  /** ＋新建：清空当前结果，回到"贴一条链接"的初始样子 */
  function startFresh(): void {
    setCurrent(null);
    setLink("");
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

  async function run() {
    const input = link.trim();
    if (!input) {
      setError("请先粘贴一条爆款视频链接。");
      return;
    }
    setError(null);
    setCurrent(null);
    setMessage("");
    if (!(await window.asr.isModelReady())) {
      const ok = window.confirm(
        "首次嗅探需要下载本地语音识别模型（约 150 MB）。\n下载后一直保存在本地，之后无需重复下载。\n\n是否现在开始？"
      );
      if (!ok) return;
    }
    setRunning(true);
    setStage("parse");
    setMessage("正在准备…");
    const requestId = `sniff-${Date.now()}`;
    try {
      const rec = await window.sniff.run({
        link: input,
        niche: niche.trim() || undefined,
        requestId,
      });
      setCurrent(rec);
      setRewriteNiche(rec.niche);
      // 拆解完就进列表：以后想再看这份报告不用重跑一遍（重跑要下载+转写，很贵）
      try {
        const saved = await window.records.save({
          kind: "sniff",
          title: rec.source.title || rec.source.url,
          subtitle: `${rec.source.platform} · ${rec.analysis.topics?.length ?? 0} 个候选选题`,
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
      <section className="card-pad sniff-input-card">
        <textarea
          className="paste sniff-link"
          placeholder="粘贴爆款视频链接（抖音 / 快手 / B站 / 小红书等）"
          value={link}
          maxLength={500}
          onChange={(e) => setLink(e.target.value)}
          disabled={running}
        />
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
            disabled={running || !link.trim()}
            onClick={() => void run()}
          >
            {running ? "嗅探中…" : "🔍 开始嗅探"}
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
              {current.source.title || "未命名"} · {current.source.author || "未知作者"}
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
            <BeeSelect
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
