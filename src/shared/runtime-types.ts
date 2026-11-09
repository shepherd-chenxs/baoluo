/**
 * 集成运行时（设置 → 运行时）。
 *
 * 「运行时」= 本机已经装好的智能体 CLI（Codex CLI / Claude Code / Gemini CLI）。
 * 宝螺只**识别**、不代装；识别到的若干个里，**同一时间只允许应用一个**——
 * 应用过的那个才有资格接管对话区（田螺姑娘）的指令。
 *
 * 运行时不直接产出视频：它负责把用户这段话听明白、聊清楚，然后按宝螺的
 * 工具协议交回一条计划，由现有的 agent 流程（任务卡 + 步骤）去执行。
 */
import type { AgentParseResult, AgentTask } from "./agent-types";

/** 认得的运行时家族。id 同时是设置里存的 activeId */
export type RuntimeId = "codex" | "claude" | "gemini";

/** 家族 → 界面显示名（没识别过也要能显示"我应用的是哪个"） */
export const RUNTIME_LABELS: Record<RuntimeId, string> = {
  codex: "Codex CLI",
  claude: "Claude Code",
  gemini: "Gemini CLI",
};

/** 一家运行时在本机的样子 */
export interface RuntimeInfo {
  id: RuntimeId;
  label: string;
  vendor: string;
  /** 最终选中的可执行文件（同族有多份安装时取第一份能用的） */
  path: string;
  version?: string;
  /**
   * ready = 文件在、`--version` 起得来；
   * broken = 找到了但起不来（比如只有 .ps1、或 shim 坏了），此时不给「应用」。
   */
  status: "ready" | "broken";
  /** broken 时的一句人话（为什么起不来） */
  note?: string;
  /** 同族在本机还有哪些安装位置（去重后最多 3 条，含选中那条） */
  installs: string[];
}

/** 界面需要的全部状态（state / detect 两个接口同一份结构） */
export interface RuntimeState {
  /** 已应用的运行时；null = 没应用，对话区走本地规则链路 */
  activeId: RuntimeId | null;
  /** 上次识别结果（主进程内存缓存；刚启动时为空，需要点一次识别） */
  detected: RuntimeInfo[];
  /** %APPDATA%/Baoluo/skills 下认到的技能 */
  skills: RuntimeSkill[];
  /** 技能目录绝对路径（界面上「打开技能目录」） */
  skillsDir: string;
  /** 上次识别时间（毫秒）；null = 还没识别过 */
  detectedAt: number | null;
  /** 已应用运行时的模型（null = 用 CLI 自己配置的默认模型） */
  model: string | null;
  /** 已应用运行时的权限范围（对话区左下角那颗粒子） */
  permission: RuntimePermissionId;
}

/**
 * 权限范围：这一轮运行时"能做什么"。
 * 从紧到松三档，对话区左下角的粒子就是切它。
 */
export type RuntimePermissionId = "chat" | "agent" | "full";

export interface RuntimePermissionOption {
  id: RuntimePermissionId;
  label: string;
  /** 菜单里的一行说明（说人话，别写沙箱参数） */
  hint: string;
  /** 允许运行时按 @@TOOL 协议建任务卡；false = 这轮只聊天 */
  allowsTasks: boolean;
  /** 菜单里标黄：别默认开 */
  risky?: boolean;
}

export const RUNTIME_PERMISSIONS: RuntimePermissionOption[] = [
  {
    id: "chat",
    label: "仅对话",
    hint: "只聊想法、给建议，不动手（不建任务卡）",
    allowsTasks: false,
  },
  {
    id: "agent",
    label: "可执行",
    hint: "可以按宝螺的工具协议建任务卡，交给现有流程开工",
    allowsTasks: true,
  },
  {
    id: "full",
    label: "完全访问",
    hint: "运行时不再受沙箱限制，能直接读写本机文件",
    allowsTasks: true,
    risky: true,
  },
];

export function permissionOf(id: RuntimePermissionId | undefined): RuntimePermissionOption {
  return RUNTIME_PERMISSIONS.find((p) => p.id === id) ?? RUNTIME_PERMISSIONS[1];
}

/**
 * 模型清单：**不在这里写死**。
 *
 * 真实可用模型只有运行时的配置说得准（codex 的 `model_catalog_json`、
 * Claude Code 的 `settings.json` 里 `modelPicker.options`），硬编码一份只会过期。
 * 主进程 `runtime/models.ts` 每次打开菜单时现读，读不到就只留"默认 + 手工填"。
 */
export interface RuntimeModelChoice {
  /** 传给 CLI 的原值（`--model` 后面那个字符串） */
  id: string;
  /** 给人看的名字（没有就用 id） */
  label: string;
  /** 一行说明：来自服务端的描述，或者上下文长度 */
  hint?: string;
}

export interface RuntimeModelList {
  /** 清单读成功了吗；false 时 models 可能为空，界面要能把 error 说出来 */
  ok: boolean;
  models: RuntimeModelChoice[];
  /** 没指定模型时 CLI 实际会用的那个（配置里的默认值） */
  defaultModel: string | null;
  /** 从哪读到的（给人看的一句话，比如 "~/.codex/magpie-models.json"） */
  source: string;
  error?: string;
}

/** 每个运行时各自记一份：换来换去不会把上一个的模型/权限带过来 */
export interface RuntimePrefs {
  /** null = CLI 配置里的默认模型 */
  model: string | null;
  permission: RuntimePermissionId;
}

export const DEFAULT_RUNTIME_PREFS: RuntimePrefs = { model: null, permission: "agent" };

export function normalizePrefs(raw?: Partial<RuntimePrefs> | null): RuntimePrefs {
  const model = typeof raw?.model === "string" ? raw.model.trim().slice(0, 60) : "";
  const permission =
    raw?.permission === "chat" || raw?.permission === "full" || raw?.permission === "agent"
      ? raw.permission
      : DEFAULT_RUNTIME_PREFS.permission;
  return { model: model || null, permission };
}

/** 技能：一个目录一份 SKILL.md（front matter 里写 name/description） */
export interface RuntimeSkill {
  /** 目录名，界面上当 id */
  key: string;
  name: string;
  description: string;
  /** SKILL.md 绝对路径 */
  path: string;
}

/** 对话区传给运行时的一段话（主进程接的完整上下文） */
export interface RuntimeChatMessage {
  role: "user" | "assistant";
  text: string;
}

/** 运行时跑完一轮的产物 */
export interface RuntimeChatReply {
  /** 要显示在气泡里的回复正文（工具调用那一行已经剥掉） */
  text: string;
  /** 运行时决定动手时，主进程已经按计划建好的任务卡 */
  task?: AgentTask;
  /** 建卡用的分流结果（界面拿 summary 当补充说明） */
  parse?: AgentParseResult;
}
