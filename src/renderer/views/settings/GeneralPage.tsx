/*
 * SPDX-License-Identifier: GPL-3.0-only
 * Copyright (c) 2026 宝螺 / Baoluo contributors
 * 本文件属于「宝螺 / Baoluo」。除 GPL-3.0 外还适用 ADDITIONAL_TERMS.md 里的附加条款：
 * 分发时须保留来源署名；修改版对外分发时不得沿用「宝螺」名称与图标。
 */
import { useEffect, useState } from "react";
import type {
  DataDirApi,
  DialogueApi,
  SettingsApi,
} from "../../../preload";
import SaveResetRow from "./SaveResetRow";

declare global {
  interface Window {
    dialogue: DialogueApi;
    settings: SettingsApi;
    dataDir: DataDirApi;
  }
}

/** 字节 → 人看的单位 */
function fmtSize(n: number): string {
  if (n >= 1024 * 1024 * 1024) return `${(n / 1024 / 1024 / 1024).toFixed(2)} GB`;
  if (n >= 1024 * 1024) return `${(n / 1024 / 1024).toFixed(0)} MB`;
  return `${Math.max(0, Math.round(n / 1024))} KB`;
}

/** 两个路径是否指向同一处（Windows 大小写不敏感、尾部分隔符忽略） */
function samePath(a: string, b: string): boolean {
  const norm = (s: string) => s.trim().replace(/[\\/]+$/, "").toLowerCase();
  return norm(a) === norm(b);
}

export default function GeneralPage() {
  const [outputDir, setOutputDir] = useState("");
  const [defaultOutDir, setDefaultOutDir] = useState("");

  const [error, setError] = useState<string | null>(null);

  /** 数据目录（模型/运行时所在地），可换盘 */
  const [dirInfo, setDirInfo] = useState<{
    current: string;
    defaultDir: string;
    isCustom: boolean;
    sizeBytes: number;
  } | null>(null);
  const [dirBusy, setDirBusy] = useState(false);
  const [dirProgress, setDirProgress] = useState<{
    percent: number;
    bytes: number;
    copied: number;
    total: number;
  } | null>(null);
  const [dirDone, setDirDone] = useState<string | null>(null);

  useEffect(() => {
    (async () => {
      try {
        const app = await window.settings.get();
        setOutputDir(app.outputDir ?? "");
        setDefaultOutDir(await window.dialogue.defaultOutputDir());
      } catch {
        /* ignore */
      }
    })();
  }, []);

  useEffect(() => {
    void window.dataDir
      .get()
      .then(setDirInfo)
      .catch(() => {});
    const off = window.dataDir.onProgress((p) =>
      setDirProgress({ percent: p.percent, bytes: p.bytes, copied: p.copied, total: p.total })
    );
    return () => {
      off();
    };
  }, []);

  /** 选择目录：选完直接走迁移流程（带确认弹窗） */
  async function pickDataDir() {
    setError(null);
    try {
      const target = await window.dataDir.choose(dirInfo?.current);
      if (target) await migrateTo(target);
    } catch (e: any) {
      setError(e?.message ?? String(e));
    }
  }

  /** 迁移到指定目录（输入框里手输的路径也走这里） */
  async function migrateTo(target: string) {
    setError(null);
    setDirDone(null);
    try {
      if (!target.trim()) {
        setError("请先填写或选择目标目录。");
        return;
      }
      if (dirInfo && samePath(target, dirInfo.current)) {
        setError("目标目录就是当前数据目录，不用迁移。");
        return;
      }
      const sizeText = dirInfo ? fmtSize(dirInfo.sizeBytes) : "若干";
      const ok = window.confirm(
        `把数据复制到：\n${target}\n\n` +
          `当前数据约 ${sizeText}，复制期间请不要关闭宝螺。\n` +
          `复制成功后会删除原目录以释放空间，然后需要重启应用生效。\n\n继续吗？`
      );
      if (!ok) return;
      setDirBusy(true);
      setDirProgress({ percent: 0, bytes: 0, copied: 0, total: 0 });
      const r = await window.dataDir.migrate({ target, move: true });
      setDirDone(
        `已迁移 ${fmtSize(r.bytes)} 到 ${r.current}` +
          (r.skippedCount ? `（有 ${r.skippedCount} 个占用中的缓存文件跳过）` : "") +
          (r.failedClearCount ? `（原目录有 ${r.failedClearCount} 项没删掉，可手动清理）` : "")
      );
      const info = await window.dataDir.get();
      setDirInfo(info);
    } catch (e: any) {
      setError(e?.message ?? String(e));
    } finally {
      setDirBusy(false);
      setDirProgress(null);
    }
  }

  async function pickOutputDir() {
    setError(null);
    try {
      const p = await window.dialogue.chooseOutputDir(outputDir || null);
      if (p) setOutputDir(p);
    } catch (e: any) {
      setError(e?.message ?? String(e));
    }
  }

  async function handleSave() {
    setError(null);
    await window.settings.update({ outputDir });
  }

  async function handleReset() {
    setError(null);
    setOutputDir("");
    await window.settings.update({ outputDir: "" });
  }

  return (
    <>
      <div className="card-pad">
        <div className="panel-title">通用设置</div>

        <div className="form-row">
          <label>视频输出路径</label>
          <input value={outputDir || defaultOutDir} readOnly placeholder="默认目录加载中…" title={outputDir || defaultOutDir} />
          <button className="secondary" onClick={pickOutputDir}>
            选择
          </button>
        </div>
      </div>

      <div className="card-pad" style={{ marginTop: 16 }}>
        <div className="panel-title">数据目录</div>

        <div className="form-row">
          <label>当前目录</label>
          <input
            value={dirInfo?.current ?? "读取中…"}
            readOnly
            title={dirInfo?.current ?? ""}
          />
          <button className="secondary" onClick={pickDataDir} disabled={dirBusy || !dirInfo}>
            {dirBusy ? "迁移中…" : "更改…"}
          </button>
        </div>
        {dirProgress && (
          <>
            <div className="progress">
              <div style={{ width: `${Math.max(2, dirProgress.percent)}%` }} />
            </div>
            <div className="status">
              正在复制：{dirProgress.percent}% · {fmtSize(dirProgress.bytes)}
              {dirProgress.total > 0 ? ` · ${dirProgress.copied}/${dirProgress.total} 个文件` : ""}
            </div>
          </>
        )}

        {dirDone && (
          <div className="row tight">
            <span className="status" style={{ color: "#1a7f37" }}>
              {dirDone}
            </span>
            <button
              className="primary"
              onClick={async () => {
                const r = await window.dataDir.relaunch();
                if (r?.dev) {
                  window.alert("开发模式下请手动重启（Ctrl+C 后重新 npm run dev）生效。");
                }
              }}
            >
              立即重启生效
            </button>
          </div>
        )}
      </div>

      {error && <div className="error">{error}</div>}
      <SaveResetRow onSave={handleSave} onReset={handleReset} />
    </>
  );
}
