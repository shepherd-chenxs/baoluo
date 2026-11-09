/**
 * 对话区执行器：把用户这句话交给**已应用**的运行时（本机智能体 CLI）。
 *
 * 分工（关键）：
 *   · 运行时负责**听懂 + 聊清楚 + 出计划**；
 *   · 真干活还是宝螺现有的流程（router 的意图 → workflows 的任务卡 → 工具步骤）。
 * 运行时碰不到文件、不执行 shell —— 它只能通过下面这套 `@@TOOL` 协议交回一条计划。
 *
 * 为什么用一条文本协议而不是 MCP/HTTP：三个 CLI 的 MCP 配置格式各不相同，
 * 装一次运行时就要教用户改一遍配置；而"标准输出里读一行 JSON"对所有 CLI 都一样，
 * 也不用为了给 CLI 开工具而把本地端口暴露出去。
 */
import fs from "node:fs";
import path from "node:path";
import { app } from "electron";
import type { AgentIntent, AgentParseResult } from "../../shared/agent-types";
import type {
  RuntimeChatMessage,
  RuntimeChatReply,
  RuntimeId,
  RuntimeInfo,
  RuntimePrefs,
} from "../../shared/runtime-types";
import { normalizePrefs, RUNTIME_LABELS } from "../../shared/runtime-types";
import { parseAiJson } from "../ai-json";
import { resultForIntent } from "../agent/router";
import { createTaskFromPlan } from "../agent/workflows";
import * as settings from "../dialogue/settings";
import { findRuntime, spawnCli } from "./detect";
import { ensureSkillsDir, skillPromptText } from "./skills";

/** 一次对话最多等这么久：CLI 排队/思考都在里面，超时就当没跑成 */
const CHAT_TIMEOUT_MS = 180_000;
/** 带进提示词的对话轮数（太多会把 CLI 的上下文吃满） */
const HISTORY_TURNS = 12;
/** 单条历史消息的截断长度 */
const MESSAGE_CHARS = 800;

/** 工具名 → 宝螺现有意图（plan 出来之后完全走老链路） */
const TOOL_INTENTS: Record<string, AgentIntent> = {
  download_video: "download",
  make_narration_video: "narration-video",
  make_dialogue_video: "dialogue-video",
  transcribe: "asr",
  text_to_speech: "tts",
  sniff: "sniff",
};

/**
 * 权限范围对模型说的话。
 * 「仅对话」不只是不给它工具，还得**明说**——否则它照样输出 @@TOOL，
 * 我们这边又把它吞掉，用户看到的就是"它说要去做，然后什么都没发生"。
 */
function permissionPrompt(prefs: RuntimePrefs): string {
  if (prefs.permission === "chat") {
    return `

【本轮权限：仅对话】
这轮只回答问题、聊想法、给建议。**不要**输出 @@TOOL，也不要声称自己已经开始做了。
用户明确让你开工时，就说一句"把权限切到「可执行」我就动手"。`;
  }
  if (prefs.permission === "full") {
    return `

【本轮权限：完全访问】
你可以在工作目录里自由读写文件（写脚本草稿、存中间产物都行），成片仍要按工具协议交回宝螺执行。`;
  }
  return "";
}

function systemPrompt(prefs: RuntimePrefs): string {
  return `你是「宝螺」视频创作工具里的田螺姑娘。宝螺能把一句话变成成片：下载无水印素材、写脚本、出分镜、配音、合成视频。

你不直接产出视频，也不能自己建文件或执行命令。你负责和用户把想法聊清楚，然后调用宝螺的工具，由宝螺现有的流程去做。

【可用工具】调用时**单独输出一行**，格式严格如下：
@@TOOL {"tool":"工具名","args":{...}}

1. download_video —— 下载抖音/快手/B站/小红书的无水印原片
   args: {"link":"分享链接或分享文本"}
2. make_narration_video —— 图文解说（单人旁白 + 每镜一张图，AI 出分镜，缺图自动生成）
   args: {"topic":"主题","link":"可选，基于某个视频做","durationSec":可选数字,"resolution":"portrait|landscape"}
3. make_dialogue_video —— 两人对话（甲方/乙方一问一答）
   args: 同 make_narration_video
4. transcribe —— 把本地音视频文件识别成文字
   args: {"filePath":"本地文件绝对路径"}
5. text_to_speech —— 把一段文字念成音频
   args: {"text":"要念的文本"}
6. sniff —— 拆解一条爆款视频，总结可复用的方法
   args: {"link":"链接"}

【怎么判断】
- 用户给了链接并说"下载/扒下来/要原片"→ 直接 download_video，别反问。
- 用户说"做一个讲解<主题>的图文解说/口播/热点视频"→ 直接 make_narration_video；主题就是那个主题，不要自己改写。
- 用户说"对话/双人/一问一答"→ make_dialogue_video。
- 用户只是在聊想法、问建议、让你帮他想选题 → 正常聊天，**不要**调工具；一次最多问一个问题。
- 关键信息缺了（要下载却没给链接、要识别却没给文件）→ 直接问，不要猜。
- 调用工具的那条消息里**只有** @@TOOL 那一行，不要解释、不要加代码块、不要 Markdown。

【说话风格】
- 中文，口语，简短（一般不超过 3 句）。
- 不吹牛、不复述流程清单；用户不需要知道"第几步"。
- 不编造文件路径、不承诺你没做的事。${skillPromptText()}${permissionPrompt(prefs)}`;
}

interface ToolCall {
  tool: string;
  args: Record<string, unknown>;
}

function str(v: unknown): string {
  return typeof v === "string" ? v.trim() : "";
}

function num(v: unknown): number | null {
  const n = typeof v === "number" ? v : typeof v === "string" ? Number(v) : NaN;
  return Number.isFinite(n) && n > 0 ? Math.round(n) : null;
}

function buildPrompt(messages: RuntimeChatMessage[], prefs: RuntimePrefs): string {
  const recent = messages.slice(-HISTORY_TURNS);
  const lines = recent.map((m) => `${m.role === "user" ? "用户" : "你"}：${m.text.slice(0, MESSAGE_CHARS)}`);
  return `${systemPrompt(prefs)}

【对话记录】
${lines.join("\n")}

现在请回复最后一条用户消息。`;
}

/** 从模型输出里揪出工具调用（找不到返回 null，按普通聊天处理） */
export function takeToolCall(text: string): ToolCall | null {
  const at = text.indexOf("@@TOOL");
  if (at < 0) return null;
  try {
    const raw = parseAiJson(text.slice(at));
    if (!raw || typeof raw !== "object") return null;
    const o = raw as { tool?: unknown; args?: unknown };
    const tool = str(o.tool);
    if (!tool) return null;
    const args = o.args && typeof o.args === "object" ? (o.args as Record<string, unknown>) : {};
    return { tool, args };
  } catch {
    return null;
  }
}

/** 工具调用 → 宝螺的分流结果（缺关键输入时 resultForIntent 会给 unknown + 提示语） */
export function planFromTool(call: ToolCall): AgentParseResult | null {
  const intent = TOOL_INTENTS[call.tool];
  if (!intent) return null;
  const { args } = call;
  const link = str(args.link) || null;
  const filePath = str(args.filePath) || str(args.file) || null;
  const topic = str(args.topic) || str(args.text);
  const resolution =
    args.resolution === "landscape" || args.resolution === "portrait" ? args.resolution : null;
  return resultForIntent(intent, {
    topic,
    link,
    filePath,
    durationSec: num(args.durationSec) ?? num(args.duration),
    resolution,
  });
}

function workspaceDir(): string {
  const dir = path.join(app.getPath("userData"), "runtime", "workspace");
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

/**
 * 各家族的"一次性问答"参数；提示词一律走 stdin（Windows 命令行长度和引号都不可靠）。
 *
 * 模型：三家都有 `--model`（codex 是 `--model/-m`，claude 可直接用 sonnet/opus/haiku 别名）。
 * 权限：只映射**能确认存在**的那几个开关——
 *   codex  `-s read-only | danger-full-access`
 *   claude `--permission-mode bypassPermissions`（不给就用它自己的默认档：非交互下该批的会拒）
 *   gemini 本机没装、参数没法校准，只给模型，不猜权限开关（真要放开再说）。
 * 只读档对"可执行"也够用：干活的是宝螺自己的流水线，运行时只负责听懂 + 出计划。
 */
export function argsFor(runtime: RuntimeId, lastMessageFile: string, prefs: RuntimePrefs): string[] {
  const modelArgs = prefs.model ? ["--model", prefs.model] : [];
  const full = prefs.permission === "full";
  switch (runtime) {
    case "claude":
      return [
        "-p",
        "--output-format",
        "json",
        ...modelArgs,
        ...(full ? ["--permission-mode", "bypassPermissions"] : []),
      ];
    case "codex":
      return [
        "exec",
        "--skip-git-repo-check",
        "--color",
        "never",
        "--sandbox",
        full ? "danger-full-access" : "read-only",
        ...modelArgs,
        "--output-last-message",
        lastMessageFile,
        "-",
      ];
    case "gemini":
      return ["-p", "--output-format", "json", ...modelArgs];
    default:
      return ["-p"];
  }
}

interface CliRun {
  stdout: string;
  stderr: string;
  code: number | null;
  timedOut: boolean;
  /** 被调用方的 signal 掐断（用户取消），跟"超时"要分开报 */
  aborted: boolean;
}

function runCli(
  info: RuntimeInfo,
  prompt: string,
  lastMessageFile: string,
  prefs: RuntimePrefs,
  timeoutMs = CHAT_TIMEOUT_MS,
  signal?: AbortSignal
): Promise<CliRun> {
  return new Promise((resolve) => {
    let stdout = "";
    let stderr = "";
    let settled = false;
    let timer: ReturnType<typeof setTimeout> | null = null;
    const onAbort = () => {
      kill();
      finish({ stdout, stderr, code: null, timedOut: false, aborted: true });
    };
    const finish = (r: CliRun) => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      signal?.removeEventListener("abort", onAbort);
      resolve(r);
    };
    const kill = () => {
      try {
        child.kill();
      } catch {
        /* 已经退出了 */
      }
    };

    let child: ReturnType<typeof spawnCli>;
    try {
      child = spawnCli(info.path, argsFor(info.id, lastMessageFile, prefs), { cwd: workspaceDir() });
    } catch (e) {
      finish({
        stdout: "",
        stderr: e instanceof Error ? e.message : String(e),
        code: null,
        timedOut: false,
        aborted: false,
      });
      return;
    }

    if (signal?.aborted) {
      kill();
      finish({ stdout, stderr, code: null, timedOut: false, aborted: true });
      return;
    }
    signal?.addEventListener("abort", onAbort, { once: true });

    timer = setTimeout(() => {
      kill();
      finish({ stdout, stderr, code: null, timedOut: true, aborted: false });
    }, timeoutMs);

    child.stdout?.on("data", (d: Buffer) => (stdout += d.toString()));
    child.stderr?.on("data", (d: Buffer) => (stderr += d.toString()));
    child.on("error", (e) => {
      finish({ stdout, stderr: stderr + e.message, code: null, timedOut: false, aborted: false });
    });
    child.on("close", (code) => {
      finish({ stdout, stderr, code, timedOut: false, aborted: false });
    });

    // 提示词走 stdin，写完就关 —— CLI 等的是 EOF，不是换行
    try {
      child.stdin?.end(prompt, "utf-8");
    } catch {
      /* 有的 CLI 不读 stdin，写失败不影响后面从 stdout 拿结果 */
    }
  });
}

/** Claude 的 `--output-format json` 会多包一层；其它家族直接是文本 */
function extractAnswer(info: RuntimeInfo, run: CliRun, lastMessageFile: string): string {
  if (info.id === "codex") {
    try {
      const text = fs.readFileSync(lastMessageFile, "utf-8").trim();
      if (text) return text;
    } catch {
      /* 没写出来就走下面的兜底 */
    }
    /*
     * 没跑成时**不要**拿 stdout 兜底：那里面是 banner + "ERROR: Reconnecting…"，
     * 当成回答发给用户就成了"田螺姑娘说了一串英文报错"（实测踩过）。
     */
    if (run.code !== 0) return "";
    // 兜底：codex 的 stdout 里有 banner（两条 -------- 夹着），答案在最后一段
    const lines = run.stdout.split(/\r?\n/);
    for (let i = lines.length - 1; i >= 0; i--) {
      if (lines[i].trim() === "codex") return lines.slice(i + 1).join("\n").trim();
    }
    return run.stdout.trim();
  }

  const raw = run.stdout.trim();
  if (info.id === "claude" || info.id === "gemini") {
    try {
      const parsed = JSON.parse(raw) as { result?: unknown; response?: unknown };
      const text = str(parsed.result) || str(parsed.response);
      if (text) return text;
    } catch {
      /* 不是 JSON（比如老版本 / 报错）就按纯文本用 */
    }
  }
  if (run.code !== 0) return "";
  return raw;
}

function stripToolLine(text: string): string {
  return text
    .split(/\r?\n/)
    .filter((line) => !line.includes("@@TOOL"))
    .join("\n")
    .trim();
}

function errorTail(run: CliRun): string {
  const text = (run.stderr || run.stdout).trim();
  if (!text) return "运行时没有返回任何内容。";
  const lines = text
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter(Boolean);
  // 取最后一条像错误的行：CLI 会在真正的原因前面刷一堆重试日志
  const last =
    [...lines].reverse().find((l) => /error|错误|失败|denied|unauthorized/i.test(l)) ??
    lines[lines.length - 1];
  return last.replace(/^ERROR:\s*/i, "").slice(0, 200);
}

/**
 * 跑一轮对话。返回要显示的话 +（可能）已经建好的任务卡。
 * 运行时起不来 / 报错时**抛错**：界面把原因说给用户就停住，不建卡、不落本地流程
 * （写分镜、写脚本、出提示词都靠运行时，没有它跑下去只会更晚失败）。
 */
export async function chatWithRuntime(messages: RuntimeChatMessage[]): Promise<RuntimeChatReply> {
  const activeId = settings.getAppSettings().runtime?.activeId as RuntimeId | undefined;
  if (!activeId) throw new Error("还没应用运行时。");

  // 对话区底部选的模型 / 权限范围（没选过就是默认：CLI 自带模型 + 可执行）
  const prefs = normalizePrefs(settings.getAppSettings().runtime?.prefs?.[activeId]);

  const info = await findRuntime(activeId);
  if (!info) {
    throw new Error("已应用的运行时在这台机器上起不来，去「设置 → 运行时」重新识别或换一个。");
  }

  const last = messages.filter((m) => m.role === "user").slice(-1)[0];
  if (!last) throw new Error("没有要处理的消息。");

  const lastMessageFile = path.join(app.getPath("userData"), "runtime", "last-message.txt");
  try {
    fs.unlinkSync(lastMessageFile);
  } catch {
    /* 上一次的残留删不掉也没关系，读完会校验内容 */
  }

  const run = await runCli(info, buildPrompt(messages, prefs), lastMessageFile, prefs);
  if (run.timedOut) {
    throw new Error(`运行时 ${Math.round(CHAT_TIMEOUT_MS / 1000)} 秒没回话，可能是排队或网络不通。`);
  }

  const answer = extractAnswer(info, run, lastMessageFile);
  if (!answer) throw new Error(errorTail(run));

  // 「仅对话」这档即使模型违规吐了 @@TOOL，也不许它替用户开工
  const call = prefs.permission === "chat" ? null : takeToolCall(answer);
  if (call) {
    const plan = planFromTool(call);
    if (!plan) {
      return { text: `这个动作宝螺还不支持：${call.tool}。`, parse: undefined };
    }
    if (plan.intent === "unknown") {
      // 参数不全：把"还缺什么"直接说给用户，别建一张跑不动的卡
      return { text: plan.summary, parse: plan };
    }
    const instruction = messages[messages.length - 1]?.text ?? "";
    const task = createTaskFromPlan(instruction, plan);
    return { text: stripToolLine(answer) || `好，我按「${plan.title}」开工。`, task, parse: plan };
  }

  const text = stripToolLine(answer);
  if (!text) throw new Error(errorTail(run));
  return { text };
}

/**
 * 内部生成用的一次性调用（写分镜 / 写脚本 / 拆爆款 / 认意图）。
 *
 * 跟对话区的区别：
 *   · 不套田螺姑娘的人设，也不给 @@TOOL 协议——这里要的是**一段文本 / 一个 JSON**；
 *   · 权限固定只读：这些活不需要碰用户文件，用对话区那档权限等于白开风险；
 *   · 每次都用一个独立的 last-message 文件：流水线可能同时发两条（分镜 + 重出提示词），
 *     共用一个文件会串味儿。
 */
export interface OneShotOptions {
  timeoutMs?: number;
  signal?: AbortSignal;
  /** 默认只读；真需要它写文件时才传 full */
  permission?: RuntimePrefs["permission"];
}

export interface OneShotResult {
  text: string;
  runtimeId: RuntimeId;
  label: string;
}

export async function runRuntimeOneShot(
  prompt: string,
  opts: OneShotOptions = {}
): Promise<OneShotResult> {
  const activeId = settings.getAppSettings().runtime?.activeId as RuntimeId | undefined;
  if (!activeId) throw new Error("还没应用运行时。");

  const info = await findRuntime(activeId);
  if (!info) {
    throw new Error("已应用的运行时在这台机器上起不来，去「设置 → 运行时」重新识别或换一个。");
  }

  const label = RUNTIME_LABELS[activeId] ?? activeId;
  const saved = normalizePrefs(settings.getAppSettings().runtime?.prefs?.[activeId]);
  const prefs: RuntimePrefs = {
    model: saved.model,
    permission: opts.permission ?? "agent",
  };

  const file = path.join(
    app.getPath("userData"),
    "runtime",
    `last-message-${Date.now()}-${Math.random().toString(36).slice(2, 8)}.txt`
  );
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.unlinkSync(file);
  } catch {
    /* 首次跑没有残留 */
  }

  const timeoutMs = opts.timeoutMs ?? CHAT_TIMEOUT_MS;
  try {
    const run = await runCli(info, prompt, file, prefs, timeoutMs, opts.signal);
    if (run.aborted) throw new Error("已取消");
    if (run.timedOut) {
      throw new Error(`运行时「${label}」${Math.round(timeoutMs / 1000)} 秒没回话，可能是排队或网络不通。`);
    }
    const text = extractAnswer(info, run, file);
    if (!text) throw new Error(`运行时「${label}」没给出结果：${errorTail(run)}`);
    return { text, runtimeId: activeId, label };
  } finally {
    try {
      fs.unlinkSync(file);
    } catch {
      /* 清理不掉也不影响结果 */
    }
  }
}

/** 技能目录（界面「打开技能目录」用，顺便把它建出来） */
export function runtimeSkillsDir(): string {
  return ensureSkillsDir();
}
