/**
 * 「AI 服务」这一小组设置在 DialogueSettings 里的形状。
 * 单独拎出来：ai-client（主进程）和设置页（渲染进程）都要用，
 * 不想把整个 DialogueSettings（带着一堆音色/字幕字段）都拽进来。
 */
export interface AiSettings {
  apiKey: string;
  baseUrl: string;
  model: string;
}
