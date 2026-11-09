/**
 * 会话的落盘：userData/agent/conversations.json。
 *
 * 只存"说了什么 + 挂在哪个任务卡上"，产物本身仍由 tasks.json 指路——
 * 会话是书签，不是仓库。
 *
 * 迁移：老版本没有这个文件，首次读时按现有任务卡一条一张地补出来
 * （每张卡当一个只有一轮的会话），用户升级后看到的就是原来的历史，不会凭空消失。
 */
import fs from "node:fs";
import path from "node:path";
import { agentRoot, ensureDir, listTasks } from "./store";
import type {
  Conversation,
  ConversationMessage,
  ConversationSummary,
} from "../../shared/conversation-types";

/** 最多留这么多条会话，防止 conversations.json 无限长 */
const MAX_CONVERSATIONS = 100;
/** 单条会话最多留这么多条消息：超了从头丢，最近的一定在 */
const MAX_MESSAGES = 200;

function file(): string {
  return path.join(agentRoot(), "conversations.json");
}

export function newConversationId(): string {
  return `c-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`;
}

export function newMessageId(): string {
  return `m-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`;
}

function titleOf(text: string): string {
  const one = (text ?? "").replace(/\s+/g, " ").trim();
  return one.length > 24 ? `${one.slice(0, 24)}…` : one || "新会话";
}

function normalize(c: Conversation): Conversation {
  return {
    id: c.id,
    title: c.title || "新会话",
    createdAt: c.createdAt ?? Date.now(),
    updatedAt: c.updatedAt ?? c.createdAt ?? Date.now(),
    messages: Array.isArray(c.messages) ? c.messages : [],
    taskIds: Array.isArray(c.taskIds) ? c.taskIds : [],
  };
}

/**
 * 老数据补会话：每个任务卡一条；**同一句话重跑的那几次并进同一条**。
 *
 * 用户重发同一句主题时，以前会多出一张一模一样的卡（左栏就多一条）——
 * 那本来就是一回事的第二轮，迁过来正好合并，历史看着才像"一件事"。
 */
function migrateFromTasks(): Conversation[] {
  const tasks = listTasks().slice().reverse();
  const out: Conversation[] = [];
  /** 同一句原话 → 它已经落在哪条会话里（6 小时内算同一件事） */
  const seen = new Map<string, Conversation>();
  const SAME_TOPIC_MS = 6 * 3600_000;

  for (const t of tasks) {
    const at = t.createdAt || t.updatedAt || Date.now();
    const said = t.instruction || t.title;
    const key = said.replace(/\s+/g, " ").trim();
    const prev = seen.get(key);
    if (prev && Math.abs(at - prev.updatedAt) < SAME_TOPIC_MS) {
      prev.messages.push({ id: `m-${t.id}-u`, role: "user", text: said, at });
      prev.messages.push({ id: `m-${t.id}-a`, role: "assistant", text: "", at: at + 1, taskId: t.id });
      prev.taskIds.push(t.id);
      prev.updatedAt = Math.max(prev.updatedAt, t.updatedAt || at);
      continue;
    }
    const conv: Conversation = {
      id: `c-${t.id}`,
      // 标题用**用户原话**，不用任务卡标题：卡标题是模板化的（"主题 → 图文解说"），
      // 一列看下去全是同一句，等于没有标题。
      title: titleOf(said),
      createdAt: at,
      updatedAt: t.updatedAt || at,
      messages: [
        { id: `m-${t.id}-u`, role: "user", text: said, at },
        // 老数据没有当时的回复，留空交给界面画成「结果卡」
        { id: `m-${t.id}-a`, role: "assistant", text: "", at: at + 1, taskId: t.id },
      ],
      taskIds: [t.id],
    };
    out.push(conv);
    seen.set(key, conv);
  }
  return out;
}

let cache: Conversation[] | null = null;

function load(): Conversation[] {
  if (cache) return cache;
  try {
    const raw = JSON.parse(fs.readFileSync(file(), "utf-8")) as
      | { list?: Conversation[] }
      | Conversation[];
    const list = Array.isArray(raw) ? raw : raw.list;
    if (Array.isArray(list)) {
      cache = list.map(normalize);
      return cache;
    }
  } catch {
    /* 没有文件 / 文件坏了：下面走迁移 */
  }
  cache = migrateFromTasks();
  persist(cache);
  return cache;
}

function persist(list: Conversation[]): void {
  try {
    ensureDir(agentRoot());
    const trimmed = list.slice(0, MAX_CONVERSATIONS);
    fs.writeFileSync(file(), JSON.stringify({ version: 1, list: trimmed }, null, 2), "utf-8");
  } catch {
    /* 写不进去不影响本次运行 */
  }
}

/**
 * 左栏列表：按最近更新倒序，只带摘要。
 *
 * **空白会话不上榜**：点了「＋」却没说话的那些（老版本会落一条「新会话」）不该占位。
 * 有消息或有任务卡才算一件事。
 */
export function listConversations(): ConversationSummary[] {
  return load()
    .filter((c) => c.messages.length > 0 || c.taskIds.length > 0)
    .slice()
    .sort((a, b) => b.updatedAt - a.updatedAt)
    .map((c) => {
      const lastUser = [...c.messages].reverse().find((m) => m.role === "user");
      return {
        id: c.id,
        title: c.title,
        createdAt: c.createdAt,
        updatedAt: c.updatedAt,
        messageCount: c.messages.length,
        taskCount: c.taskIds.length,
        lastTaskId: c.taskIds.length ? c.taskIds[c.taskIds.length - 1] : null,
        preview: (lastUser?.text ?? "").replace(/\s+/g, " ").slice(0, 60),
      };
    });
}

export function getConversation(id: string): Conversation | null {
  return load().find((c) => c.id === id) ?? null;
}

/** 任务卡属于哪条会话（删卡 / 跳转时反查） */
export function conversationOfTask(taskId: string): Conversation | null {
  return load().find((c) => c.taskIds.includes(taskId)) ?? null;
}

export function createConversation(seedText = ""): Conversation {
  const list = load();
  const now = Date.now();
  const conv: Conversation = {
    id: newConversationId(),
    title: seedText.trim() ? titleOf(seedText) : "新会话",
    createdAt: now,
    updatedAt: now,
    messages: [],
    taskIds: [],
  };
  list.unshift(conv);
  persist(list);
  return conv;
}

/** 追加一条消息；会话不存在时顺手建一条（界面偶尔会先发消息后建会话） */
export function appendMessage(
  convId: string,
  msg: Omit<ConversationMessage, "id" | "at"> & { at?: number }
): Conversation | null {
  const list = load();
  let conv = list.find((c) => c.id === convId);
  if (!conv) {
    // createConversation 已经把新会话塞进同一个 list，这里取回它的引用
    const created = createConversation(msg.text);
    conv = list.find((c) => c.id === created.id) ?? created;
  }
  const message: ConversationMessage = {
    id: newMessageId(),
    role: msg.role,
    text: msg.text,
    images: msg.images?.length ? msg.images : undefined,
    at: msg.at ?? Date.now(),
    taskId: msg.taskId,
  };
  conv.messages.push(message);
  if (conv.messages.length > MAX_MESSAGES) {
    conv.messages = conv.messages.slice(-MAX_MESSAGES);
  }
  conv.updatedAt = message.at;
  // 标题只认第一条用户消息：后来改主意了也不改名，用户找的是"当初那件事"
  if (conv.title === "新会话" && msg.role === "user" && msg.text.trim()) {
    conv.title = titleOf(msg.text);
  }
  persist(list);
  return conv;
}

/** 把一张任务卡挂进会话（同一张卡重复挂不会重复） */
export function bindTask(convId: string, taskId: string): Conversation | null {
  const list = load();
  const conv = list.find((c) => c.id === convId);
  if (!conv) return null;
  if (!conv.taskIds.includes(taskId)) conv.taskIds.push(taskId);
  conv.updatedAt = Date.now();
  persist(list);
  return conv;
}

export function renameConversation(convId: string, title: string): Conversation | null {
  const list = load();
  const conv = list.find((c) => c.id === convId);
  if (!conv) return null;
  conv.title = titleOf(title);
  conv.updatedAt = Date.now();
  persist(list);
  return conv;
}

export function removeConversation(convId: string): void {
  const list = load();
  const i = list.findIndex((c) => c.id === convId);
  if (i < 0) return;
  list.splice(i, 1);
  persist(list);
}

/** 测试 / 换数据目录时清掉内存缓存 */
export function resetConversationCache(): void {
  cache = null;
}
