import { useEffect, useState } from "react";
import type { ReactNode } from "react";
import type { SettingsPageKey } from "../components/SideNav";
import { NavPage } from "../components/SideList";
import { usePageActive } from "../components/KeepAlive";
import AiPage from "./settings/AiPage";
import ClonePage from "./settings/ClonePage";
import GeneralPage from "./settings/GeneralPage";
import PluginsPage from "./settings/PluginsPage";
import RuntimePage from "./settings/RuntimePage";
import SubtitlePage from "./settings/SubtitlePage";
import VoicesPage from "./settings/VoicesPage";
import type { PluginKey } from "../../shared/plugins";

const PAGE_META: Record<SettingsPageKey, { title: string; subtitle: string }> = {
  subtitle: { title: "字幕设置", subtitle: "对话视频字幕的显示参数" },
  voices: { title: "音色设置", subtitle: "勾选常用音色，只显示你需要的" },
  clone: {
    title: "声音克隆",
    subtitle:
      "启用自动配置环境，首次下载离线语音模型，本地离线运行；停用即时释放系统资源。克隆音色保留在本地，不会上传到互联网。",
  },
  ai: {
    title: "AI 服务",
    subtitle: "没接运行时才用这里的文本模型兜底；生图引擎在「插件」里",
  },
  plugins: { title: "插件", subtitle: "按需安装功能模块，装了才会出现在导航和工作台「＋」菜单里" },
  runtime: {
    title: "运行时",
    subtitle:
      "识别本机装好的智能体 CLI（Codex / Claude Code / Gemini），应用其中一个接管对话区，也负责写分镜/文案；同一时间只允许一个。",
  },
  general: { title: "通用设置", subtitle: "视频输出等全局配置" },
};

export default function SettingsView({
  page,
  nav,
  list,
  doubaoOpen = false,
  onToggleDoubao,
  onPluginsChanged,
}: {
  page: SettingsPageKey;
  /** 左栏顶部的导航块（App 传下来的 SideNav），二级菜单（五个子页）就在导航里 */
  nav?: ReactNode;
  /** 导航下方的任务列表（工作台左栏同款）：左栏不再因为切到设置页而空掉 */
  list?: ReactNode;
  /** 豆包独立窗口开合（窗口本体挂在 App 最外层）：插件页的豆包配置窗口点它 */
  doubaoOpen?: boolean;
  onToggleDoubao?: () => void;
  /** 插件装/卸后回传最新列表：App 据此即时刷新左侧导航 */
  onPluginsChanged?: (keys: PluginKey[]) => void;
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
    <NavPage nav={nav} list={list}>
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
      {page === "runtime" && <RuntimePage />}
      {page === "plugins" && (
        <PluginsPage
          onChanged={onPluginsChanged}
          doubaoOpen={doubaoOpen}
          onToggleDoubao={onToggleDoubao}
        />
      )}
      {page === "general" && <GeneralPage />}
      </div>
    </NavPage>
  );
}
