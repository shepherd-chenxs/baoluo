import { useEffect, useState } from "react";
import type { ReactNode } from "react";
import type { BeeApi } from "../../preload";
import qqGroupQrUrl from "../assets/qq-group.jpg";
import BrandLogo from "../components/BrandLogo";
import { NavPage } from "../components/SideList";

declare global {
  interface Window {
    bee: BeeApi;
  }
}

/**
 * 关于页：软件信息、运行日志、社区（公众号 / QQ 群）。
 */
const APP_INFO = {
  name: "宝螺",
  version: __APP_VERSION__,
  slogan: "素材捕手 · 对话视频生成",
  author: "牧羊人",
  officialAccount: "",
  officialAccountQr: "",
  qqGroup: "",
  qqGroupQr: qqGroupQrUrl,
  qqGroupQuestion: "",
  storeLink: "",
  email: "",
};

export default function AboutView({ nav }: { nav?: ReactNode } = {}) {
  /** 运行日志位置：null 表示还没取到 */
  const [logInfo, setLogInfo] = useState<{ dir: string; file: string } | null>(null);
  const [logCopied, setLogCopied] = useState(false);
  const [logError, setLogError] = useState<string | null>(null);

  useEffect(() => {
    window.bee
      ?.logInfo()
      .then(setLogInfo)
      .catch(() => {
        /* 取不到就不显示路径，不影响其他内容 */
      });
  }, []);

  /** 打开日志所在目录（有日志就直接选中该文件） */
  async function handleOpenLogDir() {
    setLogError(null);
    const r = await window.bee.openLogDir();
    if (!r.ok) setLogError(r.error ?? "打开目录失败，请手动打开上面的路径。");
  }

  /** 复制日志路径，便于买家直接粘给卖家 */
  function copyLogPath() {
    if (!logInfo) return;
    navigator.clipboard
      .writeText(logInfo.dir)
      .then(() => {
        setLogCopied(true);
        setTimeout(() => setLogCopied(false), 1500);
      })
      .catch(() => {
        /* 忽略 */
      });
  }

  return (
    <NavPage nav={nav}>
      <div className="view about-view">
      <h2>关于</h2>
      <p className="subtitle">
        {APP_INFO.name} · v{APP_INFO.version} · {APP_INFO.slogan}
      </p>

      <div className="card-pad">
        <div className="panel-title">
          <BrandLogo className="brand-logo-inline" />
          {APP_INFO.name}
        </div>
        <div className="about-rows">
          <span className="about-label">版本</span>
          <span>v{APP_INFO.version}</span>
          <span className="about-label">功能</span>
          <span>素材捕手 / 语音合成 / 语音识别 / 对话视频生成</span>
          <span className="about-label">作者</span>
          <span>{APP_INFO.author}</span>
          {APP_INFO.email && (
            <>
              <span className="about-label">联系</span>
              <span>{APP_INFO.email}</span>
            </>
          )}
        </div>
      </div>

      <div className="card-pad">
        <div className="panel-title">📄 运行日志</div>
        <div className="about-rows">
          <span className="about-label">日志目录</span>
          <span className="about-log-path">
            <code className="about-log-dir" title={logInfo?.dir}>
              {logInfo?.dir ?? "读取中…"}
            </code>
            <button
              className="small secondary"
              type="button"
              onClick={handleOpenLogDir}
              disabled={!logInfo}
            >
              打开目录
            </button>
            <button className="link" type="button" onClick={copyLogPath} disabled={!logInfo}>
              {logCopied ? "已复制" : "复制"}
            </button>
          </span>
        </div>
        <p className="hint">
          语音合成首次安装/下载出问题时，目录里的 <code>install.log</code> 记下了每一步结果；
          把它发给卖家即可定位。
        </p>
        {logError && <div className="error">{logError}</div>}
      </div>

      <div className="card-pad">
        <div className="panel-title">💬 社区</div>
        {(APP_INFO.officialAccount || APP_INFO.officialAccountQr || APP_INFO.qqGroupQr) && (
          <div className="about-community">
            <div className="about-community-item">
              <span className="about-label">公众号</span>
              {APP_INFO.officialAccountQr ? (
                <img src={APP_INFO.officialAccountQr} alt="公众号二维码" className="about-qr" />
              ) : (
                <div className="about-qr-placeholder">公众号二维码（待补充）</div>
              )}
              {APP_INFO.officialAccount && <span>名称：{APP_INFO.officialAccount}</span>}
            </div>
            {APP_INFO.qqGroup && (
              <div className="about-community-item">
                <span className="about-label">QQ 群</span>
                <div>
                  <div>群号：{APP_INFO.qqGroup}</div>
                  {APP_INFO.qqGroupQuestion && <div>进群口令：{APP_INFO.qqGroupQuestion}</div>}
                </div>
              </div>
            )}
            {APP_INFO.qqGroupQr && (
              <div className="about-community-item">
                <span className="about-label">QQ 群二维码</span>
                <img src={APP_INFO.qqGroupQr} alt="QQ群二维码" className="about-qr" />
              </div>
            )}
          </div>
        )}
        {!APP_INFO.officialAccount &&
          !APP_INFO.officialAccountQr &&
          !APP_INFO.qqGroup &&
          !APP_INFO.qqGroupQr && (
          <div className="status">社区信息待补充：公众号 / QQ 群。</div>
        )}
        {APP_INFO.storeLink && (
          <div className="row">
            <a className="primary link-button" href={APP_INFO.storeLink} target="_blank" rel="noreferrer">
              项目主页
            </a>
          </div>
        )}
      </div>

      <div className="disclaimer">
        本工具仅供个人学习与本地备份用途。请遵守各平台服务条款与相关法律法规，
        勿用于任何商业分发或侵犯创作者权益的场景。使用者对使用结果承担全部责任。
      </div>
      </div>
    </NavPage>
  );
}
