/**
 * 功能插件注册表 —— 把左侧导航里的功能模块当成「插件」管理。
 *
 * 为什么这样做：功能越来越多（素材捕手/图文解说/对话模式/热点成片/爆款嗅探/语音处理），
 * 不是每个用户都用得上全部。设置 → 插件 里按需安装/卸载：
 *   - 卸载后左侧导航不再出现该入口；
 *   - 工作台「＋」菜单里对应的功能（@下载/@对话/@语音/@识别/@爆款/@热点）也不再显示。
 *
 * 存储：settings.json 的 app 分区 `installedPlugins`（已装插件的 key 列表）。
 * **键不存在 = 全部安装**（老用户升级后一切照旧，不会突然"消失"功能）。
 */

export type PluginKey =
  | "materials"
  | "narration"
  | "dialogue"
  | "hotstory"
  | "sniff"
  | "textcard"
  | "voice"
  | "modelscope"
  | "doubao";

export interface PluginDef {
  key: PluginKey;
  name: string;
  /** 设置页里的一句话说明 */
  desc: string;
}

export const PLUGINS: PluginDef[] = [
  {
    key: "materials",
    name: "素材捕手",
    desc: "多平台视频解析下载（抖音 / 快手 / B站 / 小红书），无水印原片",
  },
  {
    key: "narration",
    name: "图文解说",
    desc: "一张图一段旁白，AI 出分镜自动生图，合成解说视频",
  },
  {
    key: "dialogue",
    name: "对话模式",
    desc: "甲乙双人对口型对话视频，模板 / 音色 / 运镜可配",
  },
  {
    key: "hotstory",
    name: "热点成片",
    desc: "从热点榜单挑题材，自动出分镜合成成片",
  },
  {
    key: "sniff",
    name: "爆款嗅探",
    desc: "给爆款链接，拆解可复用的拍摄与文案方法",
  },
  {
    key: "textcard",
    name: "文字卡视频",
    desc: "文案排版成卡片，自动加推近与淡入淡出合成视频（纯本地，不生成画面）",
  },
  {
    key: "voice",
    name: "语音处理",
    desc: "语音合成（指定音色念文字）与语音识别（音视频出文案，本地跑）",
  },
  {
    key: "modelscope",
    name: "ModelScope 生图",
    desc: "魔搭 API 生图引擎（免费额度，需访问令牌）；卸载后 AI 服务页不再显示 ModelScope 引擎",
  },
  {
    key: "doubao",
    name: "豆包生图",
    desc: "豆包网页生图引擎（免费，需登录豆包账号）；卸载后 AI 服务页不再显示豆包引擎与登录入口",
  },
];

const PLUGIN_KEYS: ReadonlySet<string> = new Set<string>(PLUGINS.map((p) => p.key));

export function isPluginKey(k: string): k is PluginKey {
  return PLUGIN_KEYS.has(k);
}

/** 全量插件 key（「未配置 = 全装」的默认值） */
export const ALL_PLUGIN_KEYS: PluginKey[] = PLUGINS.map((p) => p.key);

/**
 * settings 里存的列表 → 生效的已装集合。
 * undefined / 非数组 = 老配置，全装；否则按存储的来（交空数组就是全卸）。
 *
 * 第二个参数是 `knownPlugins`：**上次写这份配置时程序认识的全部 key**。
 * 升级后会多出新的插件 key，它们不在名单里 → 当作"新上架的插件"自动装上，
 * 否则老用户永远看不到新功能（装了等于没装，还得自己去设置里找）。
 * 用户亲手卸掉的插件 key 一定在名单里，所以不会被这个规则装回来。
 * 名单本身缺失（更早的版本写的配置）就从严：不自动补装，完全按列表来。
 */
export function effectiveInstalledPlugins(stored: unknown, known?: unknown): PluginKey[] {
  if (!Array.isArray(stored)) return [...ALL_PLUGIN_KEYS];
  const set = new Set<PluginKey>();
  for (const k of stored) {
    const key = String(k);
    if (isPluginKey(key)) set.add(key);
  }
  if (Array.isArray(known)) {
    const knownSet = new Set<string>(known.map(String));
    for (const k of ALL_PLUGIN_KEYS) {
      if (!knownSet.has(k)) set.add(k);
    }
  }
  return [...set];
}

/** 工作台「＋」菜单 / @ 名单里每条功能归属哪个插件（未列出的不受插件控制） */
export const FEATURE_PLUGIN: Record<string, PluginKey> = {
  "@下载": "materials",
  "@对话": "dialogue",
  "@语音": "voice",
  "@识别": "voice",
  "@爆款": "sniff",
  "@热点": "hotstory",
};

/**
 * 工作台入口页（home）的卡片分组：参考启动器式布局（分类标题 + 卡片行）。
 * 豆包生图是引擎配置、没有独立页面，不进分组。
 */
export const PLUGIN_GROUPS: Array<{ title: string; keys: PluginKey[] }> = [
  { title: "视频创作", keys: ["narration", "dialogue", "hotstory", "sniff", "textcard"] },
  { title: "素材与语音", keys: ["materials", "voice"] },
];
