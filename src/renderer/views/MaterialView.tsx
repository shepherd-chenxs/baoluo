import { useEffect, useRef, useState } from "react";
import type { ReactNode } from "react";
import type {
  BeeApi,
  DownloadProgress,
  MaterialsApi,
  VideoMeta,
} from "../../preload";
import { NavPage } from "../components/SideList";

declare global {
  interface Window {
    bee: BeeApi;
    materials: MaterialsApi;
  }
}

interface MaterialViewProps {
  /** 左栏顶部的导航块（App 传下来的 SideNav） */
  nav?: ReactNode;
  /** 点击「提取文案」时调用：参数为已下载的视频绝对路径，App 负责切到语音识别页 */
  onRequestTranscribe: (filePath: string) => void;
}

const PLATFORM_LABELS: Record<
  VideoMeta["platform"],
  { name: string; icon: string }
> = {
  douyin: { name: "抖音", icon: "🎵" },
  kuaishou: { name: "快手", icon: "📱" },
  bilibili: { name: "B站", icon: "📺" },
  xiaohongshu: { name: "小红书", icon: "📕" },
  generic: { name: "网页", icon: "🌐" },
};

function fmtDuration(ms: number) {
  if (!ms) return "";
  const s = Math.round(ms / 1000);
  const m = Math.floor(s / 60);
  return `${m}:${(s % 60).toString().padStart(2, "0")}`;
}

function fmtBytes(n: number) {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / 1024 / 1024).toFixed(2)} MB`;
}

export default function MaterialView({ nav, onRequestTranscribe }: MaterialViewProps) {
  const [text, setText] = useState("");
  const [meta, setMeta] = useState<VideoMeta | null>(null);
  const [parsing, setParsing] = useState(false);
  const [downloading, setDownloading] = useState(false);
  const [progress, setProgress] = useState<DownloadProgress | null>(null);
  const [savedPath, setSavedPath] = useState<string | null>(null);
  /** 已下载视频的本地播放地址（bee-file://）：下载完成后卡片下面直接能看 */
  const [savedUrl, setSavedUrl] = useState<string>("");
  const [error, setError] = useState<string | null>(null);
  const [autoDownload, setAutoDownload] = useState(true);

  const downloadedRef = useRef<Set<string>>(new Set());

  useEffect(() => {
    const offDownload = window.materials.onProgress((p) => {
      setProgress(p);
    });
    return () => {
      offDownload();
    };
  }, []);

  // 下载好的文件换成能塞进 <video> 的本地地址（清空/换链接时跟着清）
  useEffect(() => {
    let alive = true;
    setSavedUrl("");
    if (!savedPath) return;
    window.media
      .toUrl(savedPath)
      .then((u) => {
        if (alive) setSavedUrl(u);
      })
      .catch(() => {
        /* 换不到地址就不摆播放器，「在文件夹显示」照常可用 */
      });
    return () => {
      alive = false;
    };
  }, [savedPath]);

  function handleTextChange(value: string) {
    setText(value);
  }

  async function runParse(value?: string) {
    const input = (value ?? text).trim();
    if (!input) return;
    setError(null);
    setParsing(true);
    try {
      const m = await window.materials.parse(input);
      setMeta(m);
      setSavedPath(null);
      if (autoDownload) await maybeAutoDownload(m);
    } catch (e: any) {
      setError(e?.message || String(e));
    } finally {
      setParsing(false);
    }
  }

  async function maybeAutoDownload(m: VideoMeta) {
    const key = `${m.platform}:${m.id}`;
    if (downloadedRef.current.has(key)) return;
    downloadedRef.current.add(key);
    await startDownload(m, "auto");
  }

  async function startDownload(m: VideoMeta, mode: "auto" | "manual") {
    setError(null);
    setSavedPath(null);
    let savePath: string | null = null;
    if (mode === "auto") {
      savePath = await window.materials.autoSavePath(m);
    } else {
      const suggested = await window.materials.suggestFileName(m);
      savePath = await window.materials.chooseSavePath(suggested);
    }
    if (!savePath) return;
    setDownloading(true);
    setProgress({ received: 0, total: 0, percent: 0, stage: "download" });
    try {
      const res = await window.materials.download({
        url: m.playUrl,
        savePath,
        requestId: `${m.platform}:${m.id}-${Date.now()}`,
        platform: m.platform,
        audioUrl: m.audioUrl,
        durationMs: m.duration,
      });
      setSavedPath(res.path);
    } catch (e: any) {
      setError(e?.message || String(e));
    } finally {
      setDownloading(false);
    }
  }

  function handleClear() {
    setText("");
    setMeta(null);
    setError(null);
    setSavedPath(null);
    setProgress(null);
  }

  const platform = meta ? PLATFORM_LABELS[meta.platform] : null;

  return (
    <NavPage nav={nav}>
      <div className="view">
      <h2>素材捕手</h2>
      <p className="subtitle">
        粘贴分享链接，自动解析媒体资源（支持主流内容平台）
      </p>

      <textarea
        className="paste"
        placeholder="粘贴分享链接，一键解析媒体资源"
        value={text}
        onChange={(e) => handleTextChange(e.target.value)}
      />

      <div className="row">
        <button className="primary" onClick={() => runParse()} disabled={parsing || downloading}>
          {parsing ? "解析中..." : "开始解析"}
        </button>
        <button
          className="secondary secondary-outlined"
          onClick={handleClear}
          disabled={parsing || downloading}
        >
          清空
        </button>
        <label className="auto-download-label">
          <input
            type="checkbox"
            checked={autoDownload}
            onChange={(e) => setAutoDownload(e.target.checked)}
          />
          解析后自动下载
        </label>
      </div>

      {error && <div className="error">{error}</div>}

      {meta && (
        <div className="card">
          {/* 左侧预览位：下载完成前是封面图，下载完成后就地换成能播的本地视频 */}
          {savedUrl ? (
            <video className="material-preview" src={savedUrl} poster={meta.cover || undefined} controls playsInline />
          ) : meta.cover ? (
            <img src={meta.cover} alt="cover" referrerPolicy="no-referrer" />
          ) : (
            <div style={{ width: 132, height: 176, background: "#eaeef2", borderRadius: 6 }} />
          )}
          <div className="meta">
            <div className="platform-badge">
              {platform?.icon} {platform?.name}
            </div>
            <div className="title">{meta.title || "(无标题)"}</div>
            <div className="info">
              作者：{meta.author || "-"}
              {meta.duration ? ` · 时长：${fmtDuration(meta.duration)}` : ""}
            </div>
            <div className="actions">
              <button
                className="primary small primary-plain"
                onClick={() => startDownload(meta, "manual")}
                disabled={downloading}
              >
                {downloading ? "下载中..." : savedPath ? "重新下载" : "下载视频"}
              </button>
              {savedPath && (
                <button
                  className="secondary small secondary-plain"
                  onClick={() => onRequestTranscribe(savedPath)}
                  title="跳转到「语音识别」页进行识别"
                >
                  📝 提取文案
                </button>
              )}
              {savedPath && (
                <button
                  className="secondary small secondary-plain"
                  onClick={() => window.materials.showInFolder(savedPath)}
                >
                  在文件夹显示
                </button>
              )}
            </div>

            {downloading && progress && (
              <>
                <div className="progress">
                  <div style={{ width: `${progress.percent}%` }} />
                </div>
                <div className="status">
                  {progress.stage === "merge" ? "合并音轨中..." : "下载中..."}
                  {progress.percent > 0 && ` · ${progress.percent.toFixed(1)}%`}
                  {progress.total > 0 &&
                    ` · ${fmtBytes(progress.received)} / ${fmtBytes(progress.total)}`}
                </div>
              </>
            )}
            {savedPath && !downloading && (
              <div className="status" style={{ color: "#1a7f37" }}>
                ✓ 已保存到：{savedPath}
              </div>
            )}
          </div>
        </div>
      )}

      <div className="disclaimer">
        免责声明：本工具仅供个人学习与本地备份使用，请遵守各平台服务条款及相关法律法规，
        下载他人内容请取得版权方授权，相关法律责任由使用者自行承担。部分平台存在登录与风控限制，
        无法保证全部链接均可解析。
      </div>
      </div>
    </NavPage>
  );
}
