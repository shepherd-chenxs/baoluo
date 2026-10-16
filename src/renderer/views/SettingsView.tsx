/*
 * SPDX-License-Identifier: GPL-3.0-only
 * Copyright (c) 2026 宝螺 / Baoluo contributors
 * 本文件属于「宝螺 / Baoluo」。除 GPL-3.0 外还适用 ADDITIONAL_TERMS.md 里的附加条款：
 * 分发时须保留来源署名；修改版对外分发时不得沿用「宝螺」名称与图标。
 */
import { useEffect, useState } from "react";
import type { ReactNode } from "react";
import type { SettingsPageKey } from "../components/SideNav";
import { NavPage } from "../components/SideList";
import { usePageActive } from "../components/KeepAlive";
import AiPage from "./settings/AiPage";
import ClonePage from "./settings/ClonePage";
import GeneralPage from "./settings/GeneralPage";
import SubtitlePage from "./settings/SubtitlePage";
import VoicesPage from "./settings/VoicesPage";

const PAGE_META: Record<SettingsPageKey, { title: string; subtitle: string }> = {
  subtitle: { title: "字幕设置", subtitle: "对话视频字幕的显示参数" },
  voices: { title: "音色设置", subtitle: "勾选常用音色，只显示你需要的" },
  clone: {
    title: "声音克隆",
    subtitle:
      "启用自动配置环境，首次下载离线语音模型，本地离线运行；停用即时释放系统资源。克隆音色保留在本地，不会上传到互联网。",
  },
  ai: { title: "AI 服务", subtitle: "文本模型（写脚本/分镜）与生图引擎的连接配置" },
  general: { title: "通用设置", subtitle: "视频输出等全局配置" },
};

export default function SettingsView({
  page,
  nav,
}: {
  page: SettingsPageKey;
  /** 左栏顶部的导航块（App 传下来的 SideNav），二级菜单（五个子页）就在导航里 */
  nav?: ReactNode;
}) {
  const meta = PAGE_META[page];
  const [cloneOnline, setCloneOnline] = useState<boolean | null>(null);
  /** 页面被保活后离开视野的实例仍在运行，轮询要跟着停 */
  const pageActive = usePageActive();

  useEffect(() => {
    // refresh 里那次 env() 会起 python 子进程，隐藏时不能在后台空转
    if (page !== "clone" || !pageActive) return;
    let alive = true;
    const refresh = async () => {
      try {
        const env = await window.localTts.env();
        if (alive) setCloneOnline(env.online);
      } catch {
        /* 忽略 */
      }
    };
    void refresh();
    const off = window.localTts.onProgress((p) => {
      if (p.phase === "start" || p.phase === "stop") void refresh();
    });
    const timer = window.setInterval(() => void refresh(), 5000);
    return () => {
      alive = false;
      off();
      window.clearInterval(timer);
    };
  }, [page, pageActive]);

  return (
    <NavPage nav={nav}>
      <div className="view settings-view">
      <h2 className="settings-page-title">
        {meta.title}
        {page === "clone" && cloneOnline !== null && (
          <span className={`service-status-chip ${cloneOnline ? "running" : "stopped"}`}>
            {cloneOnline ? "● 服务运行中" : "○ 服务未运行"}
          </span>
        )}
      </h2>
      <p className="subtitle">{meta.subtitle}</p>
      {page === "subtitle" && <SubtitlePage />}
      {page === "voices" && <VoicesPage />}
      {page === "clone" && <ClonePage />}
      {page === "ai" && <AiPage />}
      {page === "general" && <GeneralPage />}
      </div>
    </NavPage>
  );
}
