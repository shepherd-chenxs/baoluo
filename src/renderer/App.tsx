import { useEffect, useRef, useState } from "react";
import SideNav, {
  type SettingsPageKey,
  type TabKey,
  type VideoPageKey,
} from "./components/SideNav";
import BrandLogo from "./components/BrandLogo";
import MaterialView from "./views/MaterialView";
import WorkspaceView from "./views/WorkspaceView";
import DialogueView from "./views/DialogueView";
import HotStoryView from "./views/HotStoryView";
import SniffView from "./views/SniffView";
import TextCardView from "./views/TextCardView";
import TtsView from "./views/TtsView";
import AsrView from "./views/AsrView";
import SettingsView from "./views/SettingsView";
import AboutView from "./views/AboutView";
import KeepAlive from "./components/KeepAlive";
import DoubaoWindow from "./components/DoubaoWindow";
import { PLUGINS, effectiveInstalledPlugins, type PluginKey } from "../shared/plugins";

const STORAGE_KEY = "baoluo.activeTab";
const VIDEO_PAGE_KEY = "baoluo.videoPage";
const VOICE_PAGE_KEY = "baoluo.voicePage";

/** 语音处理分区的三个子页；顶栏点「语音处理」时回到上次那个 */
const VOICE_TABS: TabKey[] = ["tts", "asr"];

/** 视频生成分区的子页；顶栏「视频生成」亮着时它们都在这个分区里 */
const VIDEO_TABS: TabKey[] = ["video", "story", "sniff"];

/**
 * 用「左栏 + 右区」整屏分栏骨架的页：视频四页本来就有左栏，
 * 素材捕手/语音三页/设置/关于这次补上左栏来装导航。
 */
const SHELL_TABS: TabKey[] = [...VIDEO_TABS, ...VOICE_TABS, "materials", "textcard", "settings", "about"];

/** 设置分区的子页（顺序即左侧菜单顺序） */
const SETTINGS_PAGES: Array<{ key: SettingsPageKey; label: string }> = [
  { key: "general", label: "通用设置" },
  { key: "subtitle", label: "字幕设置" },
  { key: "voices", label: "音色设置" },
  { key: "clone", label: "声音克隆" },
  { key: "runtime", label: "运行时" },
  { key: "ai", label: "AI 服务" },
  { key: "plugins", label: "插件" },
];

export default function App() {
  const [tab, setTab] = useState<TabKey>("workspace");
  const [settingsPage, setSettingsPage] = useState<SettingsPageKey>("general");
  /**
   * 已安装插件（shared/plugins.ts）。null = 还没读到配置（按全装渲染，避免闪烁）。
   * 设置 → 插件 页里装/卸时经 onPluginsChanged 回传到这里，左侧导航即时增删入口；
   * 被卸载插件的页面如果正开着，自动退回工作台。
   */
  const [installedPlugins, setInstalledPlugins] = useState<PluginKey[] | null>(null);
  useEffect(() => {
    let alive = true;
    window.settings
      .get()
      .then((s) => {
        if (alive) setInstalledPlugins(effectiveInstalledPlugins(s.installedPlugins, s.knownPlugins));
      })
      .catch(() => {});
    return () => {
      alive = false;
    };
  }, []);
  /** 插件是否已装（配置没读到时按全装算） */
  const hasPlugin = (k: PluginKey) => !installedPlugins || installedPlugins.includes(k);
  /**
   * 从工作台「去细改」带过来的方案 id：切到热点成片页后自动打开它。
   * 打开完就清掉（由页面回调），免得下次再切回这一页时又顶掉用户自己选的方案。
   */
  const [pendingStoryBoardId, setPendingStoryBoardId] = useState<string | null>(null);
  /** 视频生成的子页面：图文解说 / 两人对话 */
  const [videoPage, setVideoPage] = useState<VideoPageKey>("narration");
  /** 语音处理上次停在哪个子页（顶栏只有一个入口，得记住去过哪） */
  const [voicePage, setVoicePage] = useState<TabKey>("tts");

  /** 素材捕手点击「提取文案」时，把文件路径带过来，由语音识别页消费后清空 */
  const [pendingAsrFile, setPendingAsrFile] = useState<string | null>(null);

  /** 豆包独立窗口开 / 关（窗口本身由主进程管理，这里只持用户意图）：分镜类页面 ＋ 工作台（登录入口） */
  const [doubaoOpen, setDoubaoOpen] = useState(false);

  // 持久化：刷新/重开后还在上次的 tab
  useEffect(() => {
    try {
      const savedVideoPage = localStorage.getItem(VIDEO_PAGE_KEY);
      if (savedVideoPage === "narration" || savedVideoPage === "dialogue") {
        setVideoPage(savedVideoPage);
      }
      const savedVoicePage = localStorage.getItem(VOICE_PAGE_KEY);
      if (savedVoicePage === "tts" || savedVoicePage === "asr") {
        setVoicePage(savedVoicePage);
      }
      const saved = localStorage.getItem(STORAGE_KEY);
      if (saved === "voice") {
        // 顶栏那项只是个入口，本身没有页面：落到上次的子页
        setTab(
          savedVoicePage === "asr" ? savedVoicePage : "tts"
        );
        return;
      }
      if (saved === "dialogue") {
        // 旧版本「视频生成」是单页，tab 名还是 dialogue；迁移到 video 并落在两人对话
        setTab("video");
        setVideoPage("dialogue");
        return;
      }
      if (
        saved === "materials" ||
        saved === "workspace" ||
        saved === "video" ||
        saved === "story" ||
        saved === "sniff" ||
        saved === "textcard" ||
        saved === "tts" ||
        saved === "asr" ||
        saved === "settings" ||
        saved === "about"
      ) {
        setTab(saved);
      } else if (saved === "douyin") {
        // 旧版本 tab 名迁移
        setTab("materials");
      }
    } catch {
      // localStorage 在某些嵌入环境可能不可用，忽略
    }
  }, []);

  /** 内容区现在跨页共用，切页时要自己把滚动位置归零（以前靠整页重建顺带归零） */
  const contentRef = useRef<HTMLElement>(null);
  useEffect(() => {
    if (contentRef.current) contentRef.current.scrollTop = 0;
  }, [tab, videoPage, settingsPage]);

  /** 当前页所属插件被卸载时退回工作台（导航入口也没了，停在那儿就是个不可达页面） */
  useEffect(() => {
    if (!installedPlugins) return;
    if (tab === "materials" && !installedPlugins.includes("materials")) changeTab("workspace");
    else if (tab === "story" && !installedPlugins.includes("hotstory")) changeTab("workspace");
    else if (tab === "sniff" && !installedPlugins.includes("sniff")) changeTab("workspace");
    else if (tab === "textcard" && !installedPlugins.includes("textcard")) changeTab("workspace");
    else if (
      tab === "video" &&
      !installedPlugins.includes(videoPage === "narration" ? "narration" : "dialogue")
    )
      changeTab("workspace");
    else if (VOICE_TABS.includes(tab) && !installedPlugins.includes("voice"))
      changeTab("workspace");
    /* 豆包插件被卸载：独立豆包窗口收起来，AI 服务页里的登录入口也随之消失 */
    if (doubaoOpen && !installedPlugins.includes("doubao")) setDoubaoOpen(false);
  }, [tab, videoPage, installedPlugins, doubaoOpen]);

  function changeTab(k: TabKey) {
    // 「语音处理」是分区入口，本身没有页面：进它等于进上次那个子页
    if (k === "voice") {
      changeVoicePage(voicePage);
      return;
    }
    setTab(k);
    try {
      localStorage.setItem(STORAGE_KEY, k);
    } catch {
      /* noop */
    }
  }

  function changeVoicePage(k: TabKey) {
    setVoicePage(k);
    setTab(k);
    try {
      localStorage.setItem(STORAGE_KEY, k);
      localStorage.setItem(VOICE_PAGE_KEY, k);
    } catch {
      /* noop */
    }
  }

  function changeVideoPage(k: VideoPageKey) {
    setVideoPage(k);
    try {
      localStorage.setItem(VIDEO_PAGE_KEY, k);
    } catch {
      /* noop */
    }
  }

  /**
   * 豆包是独立窗口，不再盖在宝螺内容区上，切页不用收它；
   * 但离开「跟豆包有关系」的页面后，登录入口也不在这个页面上，open 状态保留即可。
   */

  /**
   * 用户在豆包窗口里把豆包登上了：主进程会自动把窗口收掉，这里同步回状态。
   *
   * 只在「打开时没登录、之后登上了」时触发（主进程侧判定，见 doubao.ts 的
   * startLoginWatch）；本来就登录着的用户进来看看，不会被弹出去。
   */
  useEffect(() => {
    return window.doubao.onLoggedIn(() => setDoubaoOpen(false));
  }, []);

  /**
   * 豆包窗口一打开就自动把登录框叫出来。
   *
   * 用户点「登录豆包」的意图就是登录，不该还要他在豆包窗口里自己找「登录」两个字。
   * 主进程那边负责三件事：等页面渲染到能判断登录态、确认确实未登录、再点掉登录入口
   * （已登录时是空操作，所以「打开窗口看生成」的用户不会被打扰）。
   * dialogOpened=false 且带 message 时，说明自动点没成，日志里留一条供排查。
   */
  useEffect(() => {
    if (!doubaoOpen) return;
    let alive = true;
    void window.doubao.openLogin().then((res) => {
      if (!alive) return;
      if (!res.ok || (!res.dialogOpened && !res.alreadyLoggedIn)) {
        console.warn("[doubao] 自动打开登录框没成功：", res.message || res);
      }
    });
    return () => {
      alive = false;
    };
  }, [doubaoOpen]);

  /** 素材捕手跳到语音识别页，并把文件路径带过去 */
  function requestTranscribe(filePath: string) {
    setPendingAsrFile(filePath);
    changeVoicePage("asr");
  }

  /** 顶部导航「工作台」：回到工作台入口页（对话形态也能一键退回） */
  function goWorkspace() {
    setWsHome(true);
    changeTab("workspace");
  }

  /**
   * 设置/关于页的左栏：设置子页菜单平铺（SideNav 画）。
   * 「工作台 / 设置」两个一级入口在顶栏，左栏不再重复。
   */
  const settingsNav = (
    <SideNav
      items={[
        ...SETTINGS_PAGES.map((p) => ({
          key: p.key,
          label: p.label,
          tip: p.label,
          active: tab === "settings" && settingsPage === p.key,
          onClick: () => {
            setSettingsPage(p.key);
            changeTab("settings");
          },
        })),
        {
          key: "about-entry",
          label: "关于",
          tip: "关于",
          active: tab === "about",
          onClick: () => changeTab("about"),
        },
      ]}
    />
  );

  /** 工作台插件卡片要展示的（豆包/ModelScope 是引擎配置、没有独立页面，不列进来） */
  const workspacePlugins = PLUGINS.filter(
    (p) => p.key !== "doubao" && p.key !== "modelscope" && hasPlugin(p.key)
  );

  /** 从工作台插件卡片跳到对应功能页 */
  function openPlugin(k: PluginKey) {
    if (k === "materials") changeTab("materials");
    else if (k === "narration") {
      changeVideoPage("narration");
      changeTab("video");
    } else if (k === "dialogue") {
      changeVideoPage("dialogue");
      changeTab("video");
    } else if (k === "hotstory") changeTab("story");
    else if (k === "sniff") changeTab("sniff");
    else if (k === "textcard") changeTab("textcard");
    else if (k === "voice") changeVoicePage(voicePage);
  }

  /**
   * 工作台双形态：true = 插件入口页（默认，只摆插件卡片）；
   * 点「＋ 新建任务」进对话形态（任务列表 + 对话 + 操作区）。
   * 顶栏「工作台」永远回到入口页。
   */
  const [wsHome, setWsHome] = useState(true);

  /** 工作台右侧操作区的收起/展开：开关在顶部条右端（跟 ZCode 的面板切换一个位置）。
   * 默认收起——空工作台没任务可看，别占掉半屏；建卡/点任务时会自动请求展开（WorkspaceView）。 */
  const [wsPanelOpen, setWsPanelOpen] = useState(false);
  /**
   * 工作台左栏任务列表的收起/展开：开关在顶部条左端。
   * wsListAuto = 窗口太窄（<1100px，对话区不够最小宽）时的自动收起，宽回 1160+ 自动恢复；
   * 跟手动开关分开记，手动点了就清掉自动态，直到下次 resize 再介入。
   */
  const [wsListOpen, setWsListOpen] = useState(true);
  const [wsListAuto, setWsListAuto] = useState(false);
  const wsListShown = wsListOpen && !wsListAuto;
  useEffect(() => {
    const check = () => {
      if (window.innerWidth < 1100) setWsListAuto(true);
      else if (window.innerWidth >= 1160) setWsListAuto(false);
    };
    check();
    window.addEventListener("resize", check);
    return () => window.removeEventListener("resize", check);
  }, []);

  /*
   * 插件页（素材捕手 / 视频四件套 / 语音两页）不渲染左栏：内容全宽铺开。
   * 回工作台的入口 = 顶栏的「工作台」。
   */

  return (
    <div className="app">
      {/* 顶部导航条：品牌（工作台页兼任务栏开关）+「工作台 / 设置」两个一级入口，
        右端留工作台操作区开关。插件页没有左栏，回工作台就点顶栏「工作台」。 */}
    <header className="topnav topnav-slim">
      <button
        type="button"
        className={`topnav-brand-toggle${tab === "workspace" ? "" : " is-static"}`}
        title={tab === "workspace" ? (wsListShown ? "收起任务栏" : "展开任务栏") : undefined}
        aria-label={tab === "workspace" ? (wsListShown ? "收起任务栏" : "展开任务栏") : undefined}
        onClick={() => {
          if (tab !== "workspace") return;
          setWsListAuto(false);
          setWsListOpen((v) => !v);
        }}
      >
        <BrandLogo className="topnav-brand-logo" />
        <span className="topnav-brand-hover" aria-hidden="true">
            <svg width="15" height="15" viewBox="0 0 16 16">
              <rect x="1.5" y="2.5" width="13" height="11" rx="2" fill="none" stroke="currentColor" strokeWidth="1.4" />
              <line x1="6" y1="2.5" x2="6" y2="13.5" stroke="currentColor" strokeWidth="1.4" />
            </svg>
          </span>
        </button>
        <span className="brand-name">宝螺</span>
        {/* 一级导航：工作台 / 设置（设置含关于，active 一起亮） */}
        <nav className="topnav-tabs">
          <button
            type="button"
            className={`topnav-tab${tab === "workspace" ? " active" : ""}`}
            onClick={goWorkspace}
          >
            工作台
          </button>
          <button
            type="button"
            className={`topnav-tab${tab === "settings" || tab === "about" ? " active" : ""}`}
            onClick={() => changeTab("settings")}
          >
            设置
          </button>
        </nav>
        {tab === "workspace" && (
          <button
            type="button"
            className="topnav-panel-toggle"
            title={wsPanelOpen ? "收起操作区" : "展开操作区"}
            aria-label={wsPanelOpen ? "收起操作区" : "展开操作区"}
            onClick={() => setWsPanelOpen((v) => !v)}
          >
            <svg width="15" height="15" viewBox="0 0 16 16" aria-hidden="true">
              <rect x="1.5" y="2.5" width="13" height="11" rx="2" fill="none" stroke="currentColor" strokeWidth="1.4" />
              <line x1="10" y1="2.5" x2="10" y2="13.5" stroke="currentColor" strokeWidth="1.4" />
            </svg>
          </button>
        )}
      </header>
      <main
        className={`content${
          tab === "workspace"
            ? " is-workspace"
            : /* 这些页都是"左栏 + 右区内容"的整屏分栏（视频四页本来就有，
                 素材/语音/设置/关于这次补上左栏来装导航） */
              SHELL_TABS.includes(tab)
              ? " is-split"
              : ""
        }`}
        ref={contentRef}
      >
        {/* 页面保活：访问过的页面不再卸载，切回来时 state 和已经拉好的数据都还在 */}
        <KeepAlive active={tab === "materials"}>
          <MaterialView onRequestTranscribe={requestTranscribe} />
        </KeepAlive>
        <KeepAlive active={tab === "workspace"}>
          <WorkspaceView
            listShown={wsListShown}
            /* 操作区开合：开关在顶部条，收起后点任务/发消息会请求展开 */
            panelOpen={wsPanelOpen}
            onTogglePanel={() => setWsPanelOpen((v) => !v)}
            /* 入口页形态：true = 只摆插件卡片；点「＋ 新建任务」进对话形态 */
            home={wsHome}
            onLeaveHome={() => setWsHome(false)}
            /* 功能插件入口：装了的才出现在入口页/右侧面板空状态里，点了跳对应页 */
            plugins={workspacePlugins}
            onOpenPlugin={openPlugin}
            /* 内嵌分镜工作台的「打开豆包」还要开关抽屉（登录入口本体已挪去设置） */
            onToggleDoubao={() => setDoubaoOpen((v) => !v)}
            /* 工作台是「全自动」那一侧：要细改就去热点成片页，顺手把那份方案带过去 */
            onOpenBoardInStoryPage={(boardId) => {
              setPendingStoryBoardId(boardId);
              changeTab("story");
            }}
          />
        </KeepAlive>
        {/* 视频生成：子页在左栏的二级菜单里切换 */}
        <KeepAlive active={VIDEO_TABS.includes(tab)}>
          {/* 两个模式各留一份实例：切回来还是各自的草稿，且不用重新挂载 */}
          <KeepAlive active={tab === "video" && videoPage === "narration"}>
            <DialogueView mode="narration" />
          </KeepAlive>
          <KeepAlive active={tab === "video" && videoPage === "dialogue"}>
            <DialogueView mode="dialogue" />
          </KeepAlive>
          <KeepAlive active={tab === "story"}>
            <HotStoryView

              onOpenDoubao={() => setDoubaoOpen(true)}
              openBoardId={pendingStoryBoardId}
              onOpenBoardConsumed={() => setPendingStoryBoardId(null)}
            />
          </KeepAlive>
          <KeepAlive active={tab === "sniff"}>
            <SniffView onOpenStory={() => changeTab("story")} />
          </KeepAlive>
        </KeepAlive>
        {/* 文字卡视频：独立一页（不挂在视频那组里，那组的外层条件是 VIDEO_TABS） */}
        <KeepAlive active={tab === "textcard"}>
          <TextCardView />
        </KeepAlive>
        {/* 语音处理：子页在左栏的二级菜单里切换 */}
        <KeepAlive active={VOICE_TABS.includes(tab)}>
          <KeepAlive active={tab === "tts"}>
            <TtsView />
          </KeepAlive>
          <KeepAlive active={tab === "asr"}>
            <AsrView pendingFile={pendingAsrFile} onConsumed={() => setPendingAsrFile(null)} />
          </KeepAlive>
        </KeepAlive>
        {/* 设置：子页在设置菜单（左栏）里切换；「关于」同属这套菜单 */}
        <KeepAlive active={tab === "settings" || tab === "about"}>
          <KeepAlive active={tab === "settings"}>
            <SettingsView
              page={settingsPage}
              nav={settingsNav}
              doubaoOpen={doubaoOpen}
              onToggleDoubao={() => setDoubaoOpen((v) => !v)}
              onPluginsChanged={setInstalledPlugins}
            />
          </KeepAlive>
          <KeepAlive active={tab === "about"}>
            <AboutView nav={settingsNav} />
          </KeepAlive>
        </KeepAlive>
      </main>
      {/*
        豆包是独立窗口（v1.0.0）：页面在主进程的 BrowserWindow 里，不占宝螺的 DOM。
        这个组件只负责开 / 关同步和失败提示卡片。
        （登录入口在「设置 → AI 服务 → 生图引擎」里，见 AiPage 的 DoubaoLoginChip）
      */}
      <DoubaoWindow open={doubaoOpen} onClose={() => setDoubaoOpen(false)} />
    </div>
  );
}
