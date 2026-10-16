/*
 * SPDX-License-Identifier: GPL-3.0-only
 * Copyright (c) 2026 宝螺 / Baoluo contributors
 * 本文件属于「宝螺 / Baoluo」。除 GPL-3.0 外还适用 ADDITIONAL_TERMS.md 里的附加条款：
 * 分发时须保留来源署名；修改版对外分发时不得沿用「宝螺」名称与图标。
 */
import { useEffect, useState } from "react";
import type { LocalTtsApi, MediaApi, SettingsApi } from "../../../preload";
import type {
  CloneVoice,
  LocalTtsEnv,
  LocalTtsProgress,
} from "../../../shared/dialogue-types";
import AlertModal from "../../components/AlertModal";
import AppSelect from "../../components/AppSelect";
import { usePageActive } from "../../components/KeepAlive";

/**
 * 内置角色模型。
 * key 是磁盘上的真实目录名（CharacterModels/v2ProPlus/<key>），改了会找不到文件；
 * label 是给用户看的名字——直接按语言命名，比 feibi / mika / thirtyseven 好选。
 */
const GENIE_MODEL_CATALOG = [
  { key: "feibi", label: "中文模型", language: "中文", note: "默认模型，中文内容选它" },
  { key: "thirtyseven", label: "英语模型", language: "英语", note: "英文内容选它" },
  { key: "mika", label: "日语模型", language: "日语", note: "日文内容选它" },
];

/** 模型目录名 → 给用户看的名字；认不出来的目录名原样显示 */
function modelDisplayName(dirName: string): string {
  const hit = GENIE_MODEL_CATALOG.find((m) => m.key === dirName.toLowerCase());
  return hit ? hit.label : dirName;
}

declare global {
  interface Window {
    localTts: LocalTtsApi;
    media: MediaApi;
    settings: SettingsApi;
  }
}

export default function ClonePage() {
  /** 页面被保活后离开视野的实例仍在运行：2 秒一轮的对齐要跟着停 */
  const pageActive = usePageActive();
  const [cloneVoices, setCloneVoices] = useState<CloneVoice[]>([]);
  const [localEnv, setLocalEnv] = useState<LocalTtsEnv | null>(null);
  const [managerBusy, setManagerBusy] = useState(false);
  const [managerProgress, setManagerProgress] = useState<LocalTtsProgress | null>(null);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [showEditor, setShowEditor] = useState(false);
  const [downloadingKey, setDownloadingKey] = useState<string | null>(null);
  const [modelLibraryOpen, setModelLibraryOpen] = useState(false);
  const [draft, setDraft] = useState({
    name: "",
    modelDir: "",
    audioPath: "",
    audioText: "",
    language: "zh",
  });
  const [previewBusyId, setPreviewBusyId] = useState<string | null>(null);
  const [previewUrl, setPreviewUrl] = useState("");
  /** 当前试听的是哪个音色（id；编辑器里的草稿是 "draft"）——删除该音色时要一并收掉试听 */
  const [previewVoiceId, setPreviewVoiceId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [alertMsg, setAlertMsg] = useState<string | null>(null);

  useEffect(() => {
    (async () => {
      try {
        const app = await window.settings.get();
        setCloneVoices(app.cloneVoices ?? []);
      } catch {
        /* ignore */
      }
    })();
    void refreshEnv();
    const off = window.localTts.onProgress((p) => {
      setManagerProgress(p);
      if (p.phase === "download" || p.phase === "install") setManagerBusy(true);
    });
    return () => {
      off();
    };
  }, []);

  /**
   * 以主进程为唯一真源，持续对齐「哪个模型在下载」。
   *
   * 常驻轮询（不是只在本地 downloadingKey 有值时才轮）：下载任务活在主进程里，
   * 组件可能错过开局（切页面后再回来、或任务不是从本组件发起的）。
   * 只认快照的话，模型库会显示成「未下载」+ 可点的下载按钮，点一下就并发了第二个下载进程。
   *
   * 走的是 `local-tts:task`（只读内存、不起子进程），所以 2 秒一轮很便宜；
   * 任务收尾时才用一次 `env()`（那个要起 python，只能低频调）把「已下载」标记刷新出来。
   */
  useEffect(() => {
    if (!pageActive) return;
    let stopped = false;
    let inFlight = false;
    /** 上一轮是否在下载，用来识别「刚收尾」这一刻 */
    let wasRunning = false;
    const tick = async () => {
      if (stopped || inFlight) return;
      inFlight = true;
      try {
        const snap = await window.localTts.task();
        if (stopped) return;
        const running = snap.downloadingKey;
        setDownloadingKey(running);
        setManagerBusy(!!running);
        setManagerProgress(running ? snap.progress ?? null : null);
        if (running) {
          wasRunning = true;
        } else if (wasRunning) {
          // 刚收尾（完成/取消/失败）：状态与文案以 env 为准（含失败归类）
          wasRunning = false;
          await refreshEnv();
        }
      } catch {
        /* 读不到就等下一轮 */
      } finally {
        inFlight = false;
      }
    };
    void tick();
    const timer = window.setInterval(() => void tick(), 2000);
    return () => {
      stopped = true;
      window.clearInterval(timer);
    };
  }, [pageActive]);

  /** 后台任务的结局由主进程广播，落地后刷一次环境（含失败原因与「已下载」状态） */
  useEffect(() => {
    const off = window.localTts.onTaskDone((r) => {
      // 取消是用户自己按的，不该当报错弹；失败才回显原因
      if (!r.ok && !r.cancelled) setError(r.message);
      void refreshEnv();
    });
    return () => {
      off();
    };
  }, []);

  /** 环境刷新后：没选过模型时默认选中内置中文模型（feibi） */
  useEffect(() => {
    if (!draft.modelDir && localEnv?.defaultModelDir) {
      setDraft((d) => ({ ...d, modelDir: localEnv.defaultModelDir! }));
    }
  }, [localEnv?.defaultModelDir]);

  /** 路径只显示最后一段，避免挤爆表单 */
  function pathTail(p: string): string {
    return p.split(/[\\/]/).filter(Boolean).pop() ?? p;
  }

  /**
   * 以主进程为唯一真源同步界面状态。
   * 切页面回来时组件自己的 busy/进度全没了，必须靠 env 里的 downloadingKey/progress 恢复，
   * 否则会显示成「未下载」+ 可点的下载按钮，点一下就会并发起第二个下载进程。
   */
  function syncFromEnv(env: LocalTtsEnv | null) {
    if (!env) {
      setManagerBusy(false);
      setManagerProgress(null);
      return;
    }
    setLocalEnv(env);
    const running = env.downloadingKey ?? null;
    setDownloadingKey(running);
    setManagerBusy(!!running);
    setManagerProgress(running ? env.progress ?? null : null);
    if (env.state === "error" && env.message) setError(env.message);
  }

  async function refreshEnv(): Promise<LocalTtsEnv | null> {
    try {
      const env = await window.localTts.env();
      syncFromEnv(env);
      return env;
    } catch {
      /* 环境检测失败不阻塞 */
      return null;
    }
  }

  /** 统一处理“下载/启动”期间的 busy 状态与错误回显 */
  async function runManagerTask(
    task: () => Promise<LocalTtsEnv>
  ): Promise<LocalTtsEnv | null> {
    setError(null);
    setManagerBusy(true);
    setManagerProgress(null);
    let env: LocalTtsEnv | null = null;
    try {
      env = await task();
    } catch (e: any) {
      setError(e?.message ?? String(e));
      env = await refreshEnv();
    }
    syncFromEnv(env);
    // 模型就绪后，草稿的模型目录用默认中文模型（feibi）
    const defaultModelDir = env?.defaultModelDir;
    if (defaultModelDir && !draft.modelDir) {
      setDraft((d) => ({ ...d, modelDir: defaultModelDir }));
    }
    return env;
  }

  /**
   * 下载指定角色模型（feibi/mika/thirtyseven）。
   * 主进程受理后**立即返回**，进度走广播 + 轮询，用户可以切页面继续干别的。
   * 受理失败（比如已有别的模型在下载）在这里直接回显。
   */
  async function handleModelDownload(key: string) {
    setError(null);
    setDownloadingKey(key);
    setManagerBusy(true);
    setManagerProgress(null);
    try {
      await window.localTts.download(key);
    } catch (e: any) {
      setError(e?.message ?? String(e));
    } finally {
      // 收尾状态交给 syncFromEnv：主进程还在下就继续显示「下载中」，别在这里盲目清空
      await refreshEnv();
    }
  }

  async function handleCancelDownload() {
    setError(null);
    try {
      await window.localTts.cancelDownload();
    } catch (e: any) {
      setError(e?.message ?? String(e));
    }
    await refreshEnv();
  }

  async function handleDeleteModel(key: string) {
    if (!window.confirm(`确定删除模型 ${key}？删除后需要时可重新下载。`)) return;
    setError(null);
    try {
      syncFromEnv(await window.localTts.deleteModel(key));
    } catch (e: any) {
      setError(e?.message ?? String(e));
    }
  }

  async function handleStart() {
    await runManagerTask(() => window.localTts.start());
  }

  async function handleDisable() {
    setError(null);
    setManagerBusy(true);
    let env: LocalTtsEnv | null = null;
    try {
      env = await window.localTts.disable();
    } catch (e: any) {
      setError(e?.message ?? String(e));
      env = await refreshEnv();
    }
    syncFromEnv(env);
  }

  /** 试听一个克隆音色（保存过的或表单草稿都行） */
  async function testClone(voice: CloneVoice) {
    setError(null);
    if (!localEnv?.online) {
      setAlertMsg("声音克隆服务未启动，请先点「启动服务」再试听。");
      return;
    }
    setPreviewBusyId(voice.id);
    try {
      const r = await window.localTts.preview({ voice });
      const url = await window.media.toUrl(r.path);
      setPreviewUrl(url);
      setPreviewVoiceId(voice.id);
    } catch (e: any) {
      setError(e?.message ?? String(e));
    } finally {
      setPreviewBusyId(null);
    }
  }

  async function pickDraftAudio() {
    const p = await window.localTts.chooseAudio();
    if (p) setDraft((d) => ({ ...d, audioPath: p }));
  }

  /** 打开“添加音色”弹窗 */
  function openAddVoice() {
    setEditingId(null);
    setDraft({
      name: "",
      modelDir: localEnv?.defaultModelDir ?? "",
      audioPath: "",
      audioText: "",
      language: "zh",
    });
    setPreviewUrl("");
    setError(null);
    setShowEditor(true);
  }

  /** 编辑：把已有音色回填到表单并打开弹窗 */
  function startEdit(v: CloneVoice) {
    setEditingId(v.id);
    setDraft({
      name: v.name,
      modelDir: v.modelDir,
      audioPath: v.audioPath,
      audioText: v.audioText ?? "",
      language: v.language,
    });
    setPreviewUrl("");
    setError(null);
    setShowEditor(true);
  }

  /** 关闭弹窗并清空编辑态 */
  function closeEditor() {
    setEditingId(null);
    setDraft({ name: "", modelDir: "", audioPath: "", audioText: "", language: "zh" });
    setPreviewUrl("");
    setPreviewVoiceId(null);
    setError(null);
    setShowEditor(false);
  }

  async function saveDraft() {
    setError(null);
    try {
      const list = await window.localTts.save({
        ...(editingId ? { id: editingId } : {}),
        ...draft,
      });
      setCloneVoices(list);
      closeEditor();
    } catch (e: any) {
      setError(e?.message ?? String(e));
    }
  }

  async function removeClone(id: string) {
    if (!window.confirm("删除这个克隆音色？删除后音色下拉里将不再显示。")) return;
    setError(null);
    try {
      setCloneVoices(await window.localTts.remove(id));
      if (editingId === id) closeEditor();
      // 删掉的正好是当前试听的音色：播放器一起收掉，别留着已删除音色的试听
      if (previewVoiceId === id) {
        setPreviewUrl("");
        setPreviewVoiceId(null);
      }
    } catch (e: any) {
      setError(e?.message ?? String(e));
    }
  }

  const installedModelKeys = new Set(
    (localEnv?.modelOptions ?? []).map((o) => o.label.toLowerCase())
  );
  const installedModelCount = GENIE_MODEL_CATALOG.filter((m) =>
    installedModelKeys.has(m.key)
  ).length;
  const modelSelectOptions = [
    { value: "", label: "请选择模型…" },
    ...(localEnv?.modelOptions ?? []).map((o) => ({
      value: o.modelDir,
      label: modelDisplayName(o.label),
    })),
    ...(draft.modelDir &&
    !(localEnv?.modelOptions ?? []).some((o) => o.modelDir === draft.modelDir)
      ? [{ value: draft.modelDir, label: `${modelDisplayName(pathTail(draft.modelDir))}（自定义）` }]
      : []),
  ];
  const languageSelectOptions = [
    { value: "zh", label: "中文" },
    { value: "en", label: "英语" },
    { value: "jp", label: "日语" },
    { value: "kr", label: "韩语" },
  ];

  return (
    <>
      <div className="card-pad clone-model-card">
        <div
          className="collapse-header model-library-header"
          onClick={() => setModelLibraryOpen((v) => !v)}
        >
          <span className="panel-title">
            模型库
            <span className="model-library-summary">已下载 {installedModelCount}/3</span>
          </span>
          <span className={`collapse-arrow ${modelLibraryOpen ? "open" : ""}`}>
            {modelLibraryOpen ? "▾" : "▸"}
          </span>
        </div>
        {/* 进度不在界面上显示：下载是后台任务，这页只报状态——
            「已下载 / 下载中… / 未下载」，不显示百分比、不弹浮层。
            试过加百分比与悬停细节，真机对比后决定不加：点完下载不需要盯着数字。 */}
        {modelLibraryOpen && (
          <>
            {GENIE_MODEL_CATALOG.map((m) => {
              const installed = installedModelKeys.has(m.key);
              const busy = downloadingKey === m.key;
              return (
                <div className="model-library-item" key={m.key}>
                  <div className="model-library-info">
                    <span className="model-library-name">{m.label}</span>
                    <span className="hint">{m.note}</span>
                  </div>
                  <span
                    className={`model-library-status ${installed ? "ok" : ""} ${busy ? "busy" : ""}`}
                  >
                    {busy ? "下载中…" : installed ? "已下载" : "未下载"}
                  </span>
                  <div className="model-library-actions">
                    {busy && (
                      <>
                        <button
                          className="secondary small danger"
                          onClick={handleCancelDownload}
                        >
                          取消
                        </button>
                      </>
                    )}
                    {!busy && installed && (
                      <button
                        className="secondary small danger"
                        onClick={() => handleDeleteModel(m.key)}
                      >
                        删除
                      </button>
                    )}
                    {!busy && !installed && (
                      <button
                        className="secondary small"
                        onClick={() => handleModelDownload(m.key)}
                        disabled={managerBusy || downloadingKey !== null}
                      >
                        下载
                      </button>
                    )}
                  </div>
                </div>
              );
            })}
          </>
        )}
      </div>

      <div className="card-pad">
        <div className="panel-title clone-list-title">
          我的克隆音色
          <div className="clone-list-actions">
            <button className="primary small" onClick={openAddVoice}>
              + 添加音色
            </button>
            {localEnv?.online ? (
              <button
                className="secondary small"
                onClick={handleDisable}
                disabled={managerBusy || !localEnv.managed}
              >
                {managerBusy && managerProgress?.phase === "stop" ? "停止中…" : "停用服务"}
              </button>
            ) : (
              <button
                className="secondary small"
                onClick={handleStart}
                disabled={managerBusy || !localEnv?.modelReady}
              >
                {managerBusy && managerProgress?.phase === "start" ? "启动中…" : "启动服务"}
              </button>
            )}
          </div>
        </div>
        {cloneVoices.length === 0 && (
          <div className="hint">
            还没有克隆音色。点击右上角「+ 添加音色」，选一个模型目录和一段参考音频。
          </div>
        )}
        {cloneVoices.map((v) => (
          <div className="clone-item" key={v.id}>
            <div className="clone-item-main">
              <div className="clone-item-name">
                {v.name}
                <span className="clone-item-lang">[{v.language}]</span>
              </div>
              <div className="clone-item-path">
                模型：{modelDisplayName(pathTail(v.modelDir))}
              </div>
              <div className="clone-item-path" title={v.audioPath}>
                参考音频：{pathTail(v.audioPath)}
                {v.audioText &&
                  ` · 「${v.audioText.slice(0, 24)}${v.audioText.length > 24 ? "…" : ""}」`}
              </div>
            </div>
            <div className="row tight">
              <button
                className="secondary small"
                onClick={() => testClone(v)}
                disabled={previewBusyId !== null}
              >
                {previewBusyId === v.id ? "合成中…" : "试听"}
              </button>
              <button
                className="secondary small"
                onClick={() => startEdit(v)}
                disabled={previewBusyId !== null}
              >
                编辑
              </button>
              <button className="secondary small danger" onClick={() => removeClone(v.id)}>
                删除
              </button>
            </div>
          </div>
        ))}
        {previewUrl && !showEditor && (
          <div className="clone-preview">
            <audio className="audio-preview" controls autoPlay src={previewUrl} />
          </div>
        )}
      </div>

      {showEditor && (
        <div
          className="modal-overlay"
          onMouseDown={(e) => {
            if (e.target === e.currentTarget) closeEditor();
          }}
        >
          <div className="modal-card clone-modal">
            <div className="clone-modal-head">
              <h3>{editingId ? "编辑克隆音色" : "添加克隆音色"}</h3>
              <button className="link" onClick={closeEditor}>
                关闭
              </button>
            </div>
            <div className="clone-modal-body">
              <div className="form-row">
                <label>音色名称</label>
                <input
                  autoFocus
                  maxLength={20}
                  value={draft.name}
                  onChange={(e) => setDraft((d) => ({ ...d, name: e.target.value }))}
                  placeholder="例如：张三"
                />
                <span />
              </div>
              <div className="form-row">
                <label>模型目录</label>
                <AppSelect
                  value={draft.modelDir}
                  options={modelSelectOptions}
                  onChange={(v) => setDraft((d) => ({ ...d, modelDir: v }))}
                />
              </div>
              <div className="form-row">
                <label>参考音频</label>
                <input
                  readOnly
                  value={draft.audioPath ? pathTail(draft.audioPath) : ""}
                  placeholder="3~10 秒清晰人声（wav/flac/ogg/aiff）"
                  title={draft.audioPath}
                />
                <button className="secondary" onClick={pickDraftAudio}>
                  选择
                </button>
              </div>
              <div className="form-row">
                <label>参考音频文本</label>
                <textarea
                  value={draft.audioText}
                  onChange={(e) => setDraft((d) => ({ ...d, audioText: e.target.value }))}
                  placeholder="这段音频里说的话（越准确克隆效果越好）"
                  rows={3}
                />
                <span />
              </div>
              <div className="form-row">
                <label>语言</label>
                <AppSelect
                  value={draft.language}
                  options={languageSelectOptions}
                  onChange={(v) => setDraft((d) => ({ ...d, language: v }))}
                />
                <span />
              </div>
              {error && <div className="error">{error}</div>}
              {previewUrl && (
                <div className="clone-preview">
                  <audio className="audio-preview" controls autoPlay src={previewUrl} />
                </div>
              )}
            </div>
            <div className="clone-modal-actions">
              <button
                className="secondary"
                onClick={() =>
                  testClone({
                    id: "draft",
                    name: draft.name || "草稿",
                    modelDir: draft.modelDir,
                    audioPath: draft.audioPath,
                    audioText: draft.audioText,
                    language: draft.language,
                    createdAt: 0,
                  })
                }
                disabled={previewBusyId !== null || !draft.modelDir || !draft.audioPath}
              >
                {previewBusyId === "draft" ? "合成中…" : "试听草稿"}
              </button>
              <button className="primary" onClick={saveDraft}>
                {editingId ? "保存修改" : "保存音色"}
              </button>
            </div>
          </div>
        </div>
      )}

      {error && !showEditor && <div className="error">{error}</div>}
      {alertMsg && <AlertModal message={alertMsg} onClose={() => setAlertMsg(null)} />}
    </>
  );
}
