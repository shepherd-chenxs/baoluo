/*
 * SPDX-License-Identifier: GPL-3.0-only
 * Copyright (c) 2026 宝螺 / Baoluo contributors
 * 本文件属于「宝螺 / Baoluo」。除 GPL-3.0 外还适用 ADDITIONAL_TERMS.md 里的附加条款：
 * 分发时须保留来源署名；修改版对外分发时不得沿用「宝螺」名称与图标。
 */
/**
 * AI 服务商预设 —— 让「设置 → AI 服务」从"手抄 baseUrl"变成"选一家、填个 key"。
 *
 * 协议约定：所有预设都是 OpenAI 兼容的 /chat/completions（宝螺三个调用点只依赖这一种协议），
 * 本地网关（Ollama / LM Studio / OneAPI / vLLM）同样遵守，所以本地模型和云端模型没有区别。
 */
export interface AiProviderPreset {
  key: string;
  label: string;
  /** /chat/completions 之前的 base（不要带结尾斜杠） */
  baseUrl: string;
  /** 预设的默认模型名；用户改完保存在 settings.model 里 */
  model: string;
  /** 这家要不要 API Key（本地网关一般不用） */
  needsKey: boolean;
  /** 申请入口，界面上做成可点的提示 */
  keyUrl?: string;
  /** 拉模型列表的路径；OpenAI 兼容网关都是 /models */
  modelsPath: string;
}

export const AI_PROVIDERS: AiProviderPreset[] = [
  {
    key: "deepseek",
    label: "DeepSeek",
    baseUrl: "https://api.deepseek.com/v1",
    model: "deepseek-chat",
    needsKey: true,
    keyUrl: "https://platform.deepseek.com/api_keys",
    modelsPath: "/models",
  },
  {
    key: "moonshot",
    label: "Kimi / 月之暗面",
    baseUrl: "https://api.moonshot.cn/v1",
    model: "moonshot-v1-8k",
    needsKey: true,
    keyUrl: "https://platform.moonshot.cn/console/api-keys",
    modelsPath: "/models",
  },
  {
    key: "dashscope",
    label: "通义千问（阿里）",
    baseUrl: "https://dashscope.aliyuncs.com/compatible-mode/v1",
    model: "qwen-plus",
    needsKey: true,
    keyUrl: "https://bailian.console.aliyun.com/",
    modelsPath: "/models",
  },
  {
    key: "zhipu",
    label: "智谱 GLM",
    baseUrl: "https://open.bigmodel.cn/api/paas/v4",
    model: "glm-4-flash",
    needsKey: true,
    keyUrl: "https://open.bigmodel.cn/usercenter/apikeys",
    modelsPath: "/models",
  },
  {
    key: "openai",
    label: "OpenAI",
    baseUrl: "https://api.openai.com/v1",
    model: "gpt-4o-mini",
    needsKey: true,
    keyUrl: "https://platform.openai.com/api-keys",
    modelsPath: "/models",
  },
  {
    key: "openrouter",
    label: "OpenRouter（一家 key 用多家模型）",
    baseUrl: "https://openrouter.ai/api/v1",
    model: "anthropic/claude-3.5-haiku",
    needsKey: true,
    keyUrl: "https://openrouter.ai/keys",
    modelsPath: "/models",
  },
  {
    key: "ollama",
    label: "Ollama（本地，默认 11434）",
    baseUrl: "http://127.0.0.1:11434/v1",
    model: "qwen2.5:7b",
    needsKey: false,
    modelsPath: "/models",
  },
  {
    key: "lmstudio",
    label: "LM Studio（本地，默认 1234）",
    baseUrl: "http://127.0.0.1:1234/v1",
    model: "local-model",
    needsKey: false,
    modelsPath: "/models",
  },
  {
    key: "oneapi",
    label: "OneAPI / NewAPI 网关（自建聚合）",
    baseUrl: "http://127.0.0.1:3000/v1",
    model: "gpt-4o-mini",
    needsKey: true,
    modelsPath: "/models",
  },
];

/** 默认预设 = DeepSeek（保持现有行为，老用户无感） */
export const DEFAULT_PROVIDER_KEY = "deepseek";
