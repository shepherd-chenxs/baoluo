/*
 * SPDX-License-Identifier: GPL-3.0-only
 * Copyright (c) 2026 宝螺 / Baoluo contributors
 * 本文件属于「宝螺 / Baoluo」。除 GPL-3.0 外还适用 ADDITIONAL_TERMS.md 里的附加条款：
 * 分发时须保留来源署名；修改版对外分发时不得沿用「宝螺」名称与图标。
 */
/**
 * 生图引擎（provider）预设。
 *
 * 生图走官方 HTTP 接口（ModelScope / 阿里云通义万相）：异步任务（提交 → 轮询 →
 * 下载），前置条件是 API Key、会被限流。
 *
 * 界面契约：界面上都是「一键生图 / 批量生图 + 进度 + 人话报错」，具体怎么出图由
 * 主进程分派（见 src/main/imagegen/index.ts）。
 *
 * 数据源模式照抄 src/shared/ai-providers.ts（AI 文本模型那套服务商预设），保持一致。
 */

export type ImageProviderKey = "modelscope";

export interface ImageProviderPreset {
  key: ImageProviderKey;
  label: string;
  /** 是否要用户自己填凭据（Token） */
  needsToken: boolean;
  /** 去哪里申请 Token */
  tokenUrl?: string;
}

export const IMAGE_PROVIDERS: ImageProviderPreset[] = [
  {
    key: "modelscope",
    label: "ModelScope",
    needsToken: true,
    tokenUrl: "https://modelscope.cn/my/myaccesstoken",
  },
];

/** 默认引擎 = ModelScope */
export const DEFAULT_IMAGE_PROVIDER: ImageProviderKey = "modelscope";

export function isImageProviderKey(v: unknown): v is ImageProviderKey {
  return v === "modelscope";
}

/** 认不出来的值一律回落到默认引擎 */
export function normalizeImageProvider(v: unknown): ImageProviderKey {
  return isImageProviderKey(v) ? v : DEFAULT_IMAGE_PROVIDER;
}

export function imageProviderPreset(key: ImageProviderKey): ImageProviderPreset {
  return IMAGE_PROVIDERS.find((p) => p.key === key) ?? IMAGE_PROVIDERS[0];
}

/** ModelScope API-Inference 的服务地址（官方文档给的就是这个域名） */
export const MODELSCOPE_BASE_URL = "https://api-inference.modelscope.cn";

/** 默认模型：turbo 蒸馏版，中文提示词友好、出图快，适合短视频配图 */
export const MODELSCOPE_DEFAULT_MODEL = "Tongyi-MAI/Z-Image-Turbo";

/** 模型候选；下拉只给几个常用档，用户在设置里也能手填别的模型 id */
export const MODELSCOPE_MODEL_PRESETS: Array<{ value: string; label: string }> = [
  { value: "Tongyi-MAI/Z-Image-Turbo", label: "Z-Image-Turbo（快，中文友好）" },
  { value: "Qwen/Qwen-Image", label: "Qwen-Image（画质好，慢一些）" },
  { value: "black-forest-labs/FLUX.1-schnell", label: "FLUX.1-schnell（英文提示词更准）" },
];

/** 出图尺寸候选；空值 = 按分镜画面比例自动选（竖版 720×1280 / 横版 1280×720） */
export const MODELSCOPE_SIZE_PRESETS: Array<{ value: string; label: string }> = [
  { value: "", label: "自动（跟分镜画面比例一致）" },
  { value: "720x1280", label: "竖版 9:16（720×1280）" },
  { value: "1280x720", label: "横版 16:9（1280×720）" },
  { value: "1024x1024", label: "方形（1024×1024）" },
  { value: "1024x576", label: "宽幅（1024×576）" },
];

/** 生图引擎的当前状态（主进程算好给界面显示，界面不重复实现判断逻辑） */
export interface ImageProviderInfo {
  provider: ImageProviderKey;
  label: string;
  /** 能不能直接开跑；false 时 message 说清缺什么、去哪儿补 */
  ready: boolean;
  code?: string;
  message?: string;
  /** 当前引擎实际会用的模型 */
  model: string;
}
