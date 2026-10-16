/*
 * SPDX-License-Identifier: GPL-3.0-only
 * Copyright (c) 2026 宝螺 / Baoluo contributors
 * 本文件属于「宝螺 / Baoluo」。除 GPL-3.0 外还适用 ADDITIONAL_TERMS.md 里的附加条款：
 * 分发时须保留来源署名；修改版对外分发时不得沿用「宝螺」名称与图标。
 */
import { useEffect, useState } from "react";
import type { ReactNode } from "react";
import type { BaoluoApi } from "../../preload";
import BrandLogo from "../components/BrandLogo";
import { NavPage } from "../components/SideList";

declare global {
  interface Window {
    baoluo: BaoluoApi;
  }
}

/**
 * 关于页：软件信息、运行日志、社区（公众号 / QQ 群）。
 */
const APP_INFO = {
  name: "宝螺",
  version: __APP_VERSION__,
  slogan: "对话视频生成 · 语音合成",
  author: "牧羊人",
  officialAccount: "",
  officialAccountQr: "",
  qqGroup: "",
  qqGroupQr: "",
  qqGroupQuestion: "",
  email: "",
};

export default function AboutView({ nav }: { nav?: ReactNode } = {}) {
  /** 运行日志位置：null 表示还没取到 */
  const [logInfo, setLogInfo] = useState<{ dir: string; file: string } | null>(null);
  const [logCopied, setLogCopied] = useState(false);
  const [logError, setLogError] = useState<string | null>(null);

  useEffect(() => {
    window.baoluo
      ?.logInfo()
      .then(setLogInfo)
      .catch(() => {
        /* 取不到就不显示路径，不影响其他内容 */
      });
  }, []);

  /** 打开日志所在目录（有日志就直接选中该文件） */
  async function handleOpenLogDir() {
    setLogError(null);
    const r = await window.baoluo.openLogDir();
    if (!r.ok) setLogError(r.error ?? "打开目录失败，请手动打开上面的路径。");
  }

  /** 复制日志路径，便于排查问题 */
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
          <span>对话视频生成 / 图文解说 / 语音合成 / 语音识别 / 变声器 / 爆款嗅探</span>
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
          把它作为 Issue 附件发上来即可定位（发之前请自行检查里面是否含你本机路径）。
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
      </div>

      <div className="disclaimer">
        本工具仅供个人学习与本地备份用途。请遵守各平台服务条款与相关法律法规，
        勿用于任何商业分发或侵犯创作者权益的场景。使用者对使用结果承担全部责任。
        <br />
        内置模板的两张人物形象图由 AI 生成，不对应任何真实人物；
        用于对外发布的商业内容前，请自行确认生成平台条款或改用你自己的素材。
      </div>
      </div>
    </NavPage>
  );
}
