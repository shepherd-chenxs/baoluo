/*
 * SPDX-License-Identifier: GPL-3.0-only
 * Copyright (c) 2026 宝螺 / Baoluo contributors
 * 本文件属于「宝螺 / Baoluo」。除 GPL-3.0 外还适用 ADDITIONAL_TERMS.md 里的附加条款：
 * 分发时须保留来源署名；修改版对外分发时不得沿用「宝螺」名称与图标。
 */
import { useEffect, useRef, useState } from "react";
import SideNav, {
  type SettingsPageKey,
  type TabKey,
  type NavItem,
  type VideoPageKey,
} from "./components/SideNav";
import BrandLogo from "./components/BrandLogo";
import WorkspaceView from "./views/WorkspaceView";
import DialogueView from "./views/DialogueView";
import HotStoryView from "./views/HotStoryView";
import SniffView from "./views/SniffView";
import TtsView from "./views/TtsView";
import VoiceConvertView from "./views/VoiceConvertView";
import AsrView from "./views/AsrView";
import SettingsView from "./views/SettingsView";
import AboutView from "./views/AboutView";
import KeepAlive from "./components/KeepAlive";

const STORAGE_KEY = "baoluo.activeTab";
const VIDEO_PAGE_KEY = "baoluo.videoPage";
const VOICE_PAGE_KEY = "baoluo.voicePage";

/** 语音处理分区的三个子页；顶栏点「语音处理」时回到上次那个 */
const VOICE_TABS: TabKey[] = ["tts", "asr", "convert"];

/** 视频生成分区的子页；顶栏「视频生成」亮着时它们都在这个分区里 */
const VIDEO_TABS: TabKey[] = ["video", "story", "sniff"];

/**
 * 用「左栏 + 右区」整屏分栏骨架的页：视频四页本来就有左栏，
 * 语音三页/设置/关于这次补上左栏来装导航。
 */
const SHELL_TABS: TabKey[] = [...VIDEO_TABS, ...VOICE_TABS, "settings", "about"];

/** 设置分区的子页（顺序即左侧菜单顺序） */
const SETTINGS_PAGES: Array<{ key: SettingsPageKey; label: string }> = [
  { key: "general", label: "通用设置" },
  { key: "subtitle", label: "字幕设置" },
  { key: "voices", label: "音色设置" },
  { key: "clone", label: "声音克隆" },
  { key: "ai", label: "AI 服务" },
];

export default function App() {
  const [tab, setTab] = useState<TabKey>("workspace");
  const [settingsPage, setSettingsPage] = useState<SettingsPageKey>("general");
  /**
   * 从工作台「去细改」带过来的方案 id：切到热点成片页后自动打开它。
   * 打开完就清掉（由页面回调），免得下次再切回这一页时又顶掉用户自己选的方案。
   */
  const [pendingStoryBoardId, setPendingStoryBoardId] = useState<string | null>(null);
  /** 视频生成的子页面：图文解说 / 两人对话 */
  const [videoPage, setVideoPage] = useState<VideoPageKey>("narration");
  /** 语音处理上次停在哪个子页（顶栏只有一个入口，得记住去过哪） */
  const [voicePage, setVoicePage] = useState<TabKey>("tts");

  // 持久化：刷新/重开后还在上次的 tab
  useEffect(() => {
    try {
      const savedVideoPage = localStorage.getItem(VIDEO_PAGE_KEY);
      if (savedVideoPage === "narration" || savedVideoPage === "dialogue") {
        setVideoPage(savedVideoPage);
      }
      const savedVoicePage = localStorage.getItem(VOICE_PAGE_KEY);
      if (savedVoicePage === "tts" || savedVoicePage === "asr" || savedVoicePage === "convert") {
        setVoicePage(savedVoicePage);
      }
      const saved = localStorage.getItem(STORAGE_KEY);
      if (saved === "voice") {
        // 顶栏那项只是个入口，本身没有页面：落到上次的子页
        setTab(
          savedVoicePage === "asr" || savedVoicePage === "convert" ? savedVoicePage : "tts"
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
        saved === "workspace" ||
        saved === "video" ||
        saved === "story" ||
        saved === "sniff" ||
        saved === "tts" ||
        saved === "convert" ||
        saved === "asr" ||
        saved === "settings" ||
        saved === "about"
      ) {
        setTab(saved);
      }
      /*
       * 其余值（旧版本的 "douyin" / "materials"：素材捕手已下线）不匹配任何页，
       * 什么都不做，停在默认的工作台。
       */
    } catch {
      // localStorage 在某些嵌入环境可能不可用，忽略
    }
  }, []);

  /** 内容区现在跨页共用，切页时要自己把滚动位置归零（以前靠整页重建顺带归零） */
  const contentRef = useRef<HTMLElement>(null);
  useEffect(() => {
    if (contentRef.current) contentRef.current.scrollTop = 0;
  }, [tab, videoPage, settingsPage]);

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

  /*
   * 左侧导航（一级 + 二级）在这里定义，不在 SideNav 里：
   * 路由只有 App 知道（tab / videoPage / voicePage / settingsPage 四个状态都在这儿），
   * 菜单里再各自藏一份判断，两边迟早对不上（左侧那套子菜单当年就是这么分叉的）。
   * 一级项点了就跳：组项（视频生成/语音处理/设置）落到自己第一个/上次的子页。
   */
  const navItems: NavItem[] = [
    {
      key: "workspace",
      label: "工作台",
      tip: "说一句话，它自己拆步骤干活",
      active: tab === "workspace",
      onClick: () => changeTab("workspace"),
    },
    {
      key: "video",
      label: "视频生成",
      tip: "图文解说 / 对话模式 / 热点成片 / 爆款嗅探",
      // 一级项亮着 = 这一区的任一子页都算
      active: tab === "video" || tab === "story" || tab === "sniff",
      // 一级项点了就跳：落到上次看的那个子页
      onClick: () => {
        changeVideoPage(videoPage);
        changeTab("video");
      },
      sub: [
        {
          key: "narration",
          label: "图文解说",
          active: tab === "video" && videoPage === "narration",
          onClick: () => {
            changeVideoPage("narration");
            changeTab("video");
          },
        },
        {
          key: "dialogue",
          label: "对话模式",
          active: tab === "video" && videoPage === "dialogue",
          onClick: () => {
            changeVideoPage("dialogue");
            changeTab("video");
          },
        },
        {
          key: "story",
          label: "热点成片",
          active: tab === "story",
          onClick: () => changeTab("story"),
        },
        {
          key: "sniff",
          label: "爆款嗅探",
          active: tab === "sniff",
          onClick: () => changeTab("sniff"),
        },
      ],
    },
    {
      key: "voice",
      label: "语音处理",
      tip: "语音合成 / 语音识别 / 变声器",
      active: VOICE_TABS.includes(tab),
      onClick: () => changeVoicePage(voicePage),
      sub: [
        {
          key: "tts",
          label: "语音合成",
          active: tab === "tts",
          onClick: () => changeVoicePage("tts"),
        },
        {
          key: "asr",
          label: "语音识别",
          active: tab === "asr",
          onClick: () => changeVoicePage("asr"),
        },
        {
          key: "convert",
          label: "变声器",
          active: tab === "convert",
          onClick: () => changeVoicePage("convert"),
        },
      ],
    },
    {
      key: "settings",
      label: "设置",
      tip: "通用 / 字幕 / 音色 / 声音克隆 / AI 服务",
      active: tab === "settings" || tab === "about",
      // 「关于」在左栏底部单独一个入口，设置的一级项只管回设置页
      onClick: () => changeTab("settings"),
      sub: [
        ...SETTINGS_PAGES.map((p) => ({
          key: p.key,
          label: p.label,
          active: tab === "settings" && settingsPage === p.key,
          onClick: () => {
            setSettingsPage(p.key);
            changeTab("settings");
          },
        })),
      ],
    },
  ];

  /*
   * 左侧导航积木：各页左栏顶部都摆它（工作台/视频四页的左栏本来就存在；
   * 语音/设置/关于由页面自己用 .split 补一条左栏来装）。
   */
  const nav = <SideNav items={navItems} onOpenAbout={() => changeTab("about")} />;

  /** 工作台右侧操作区的收起/展开：开关在顶部条右端（跟 ZCode 的面板切换一个位置） */
  const [wsPanelOpen, setWsPanelOpen] = useState(true);
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

  return (
    <div className="app">
        {/* 顶部只剩窗口拖拽条：系统三个按钮压在这 46px 上，导航已经搬去左侧。
            品牌图标固定渲染同一个按钮：工作台页它是任务栏开关（悬浮变收起图标），
            其他页只是禁用——这样切页时 DOM 不重建，图标不会晃。 */}
        <header className="topnav topnav-slim">
          <button
            type="button"
            className={`topnav-brand-toggle${tab === "workspace" ? "" : " is-static"}`}
            aria-disabled={tab !== "workspace"}
            title={tab === "workspace" ? (wsListShown ? "收起任务栏" : "展开任务栏") : "宝螺"}
            aria-label={tab === "workspace" ? (wsListShown ? "收起任务栏" : "展开任务栏") : "宝螺"}
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
                   语音/设置/关于这次补上左栏来装导航） */
                SHELL_TABS.includes(tab)
                ? " is-split"
                : ""
          }`}
          ref={contentRef}
        >
          {/* 页面保活：访问过的页面不再卸载，切回来时 state 和已经拉好的数据都还在 */}
          <KeepAlive active={tab === "workspace"}>
            <WorkspaceView
              nav={nav}
              listShown={wsListShown}
              /* 操作区开合：开关在顶部条，收起后点任务/发消息会请求展开 */
              panelOpen={wsPanelOpen}
              onTogglePanel={() => setWsPanelOpen((v) => !v)}
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
              <DialogueView mode="narration" nav={nav} />
            </KeepAlive>
            <KeepAlive active={tab === "video" && videoPage === "dialogue"}>
              <DialogueView mode="dialogue" nav={nav} />
            </KeepAlive>
            <KeepAlive active={tab === "story"}>
              <HotStoryView
                nav={nav}
                openBoardId={pendingStoryBoardId}
                onOpenBoardConsumed={() => setPendingStoryBoardId(null)}
              />
            </KeepAlive>
            <KeepAlive active={tab === "sniff"}>
              <SniffView nav={nav} onOpenStory={() => changeTab("story")} />
            </KeepAlive>
          </KeepAlive>
          {/* 语音处理：子页在左栏的二级菜单里切换 */}
          <KeepAlive active={VOICE_TABS.includes(tab)}>
            <KeepAlive active={tab === "tts"}>
              <TtsView nav={nav} />
            </KeepAlive>
            <KeepAlive active={tab === "asr"}>
              <AsrView nav={nav} />
            </KeepAlive>
            <KeepAlive active={tab === "convert"}>
              <VoiceConvertView nav={nav} />
            </KeepAlive>
          </KeepAlive>
          {/* 设置：子页在左栏的二级菜单里切换；「关于」也是这套分栏，入口在导航底部 */}
          <KeepAlive active={tab === "settings" || tab === "about"}>
            <KeepAlive active={tab === "settings"}>
              <SettingsView
                page={settingsPage}
                nav={nav}
              />
            </KeepAlive>
            <KeepAlive active={tab === "about"}>
              <AboutView nav={nav} />
            </KeepAlive>
          </KeepAlive>
        </main>
      </div>
  );
}
