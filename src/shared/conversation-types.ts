/**
 * 工作台会话（conversation）类型。
 *
 * 为什么要会话这一层：以前"一句话 = 一张任务卡"，左边那列其实是任务堆栈——
 * 同一个主题重发一次就会多出一条一模一样的记录，中间聊想法也会各占一行。
 * 现在一条会话装下这整件事：你说的每句话、我的回复、每轮产出的卡都在同一个流里，
 * 左栏只列"这件事"，不再列"每一步"。
 */
export interface ConversationMessage {
  id: string;
  role: "user" | "assistant";
  text: string;
  /** 随消息附的图片路径（用户发图时） */
  images?: string[];
  at: number;
  /** 这条回复产出的任务卡：界面把它渲染成消息流里的「结果卡」入口 */
  taskId?: string;
}

export interface Conversation {
  id: string;
  /** 左栏那一行的标题：取会话里第一条用户消息 */
  title: string;
  createdAt: number;
  updatedAt: number;
  messages: ConversationMessage[];
  /** 这条会话产出的任务卡，按时间顺序；最后一张 = 当前这一轮 */
  taskIds: string[];
}

/** 左栏列表用：不带 messages，省得一次拉全部历史 */
export interface ConversationSummary {
  id: string;
  title: string;
  createdAt: number;
  updatedAt: number;
  messageCount: number;
  taskCount: number;
  /** 当前这一轮（最后一张卡）：点开会话时先显示它 */
  lastTaskId: string | null;
  /** 最后一句用户消息的片段，左栏不给看就用它做 title 兜底 */
  preview: string;
}
