/*
 * SPDX-License-Identifier: GPL-3.0-only
 * Copyright (c) 2026 宝螺 / Baoluo contributors
 * 本文件属于「宝螺 / Baoluo」。除 GPL-3.0 外还适用 ADDITIONAL_TERMS.md 里的附加条款：
 * 分发时须保留来源署名；修改版对外分发时不得沿用「宝螺」名称与图标。
 */
/**
 * 生图引擎分派层：界面只认「当前引擎」，具体怎么出图在这里决定。
 *
 * 现在生图只走官方 HTTP 接口（ModelScope / 阿里云通义万相）：
 *   - 异步任务（提交 → 轮询 → 下载），前置条件是 API Key、会被限流。
 *
 * 对外的返回值与失败形状保持一致（GeneratedImage / {code,message}），
 * 所以界面和批量队列都不用为多个引擎写多套分支。
 */
import type { VideoResolution } from "../../shared/dialogue-types";
import {
  type ImageProviderInfo,
  type ImageProviderKey,
  imageProviderPreset,
  normalizeImageProvider,
  MODELSCOPE_DEFAULT_MODEL,
} from "../../shared/image-providers";
import * as settings from "../dialogue/settings";
import { ModelScopeError, generateImageViaModelScope, type ModelScopeImage } from "./modelscope";

/** 出图结果的统一形状（与各引擎的返回保持一致，上层不用分两套处理） */
export interface GeneratedImage {
  base64: string;
  ext: string;
  src: string;
}

/** 当前生效的生图引擎（读错/没配过 = 默认引擎） */
export function currentImageProvider(): ImageProviderKey {
  return normalizeImageProvider(settings.getAppSettings().imageProvider);
}

export function imageProviderLabel(): string {
  return imageProviderPreset(currentImageProvider()).label;
}

/** ModelScope 侧的配置（token / model / size），带默认值 */
export function modelScopeConfig(): { token: string; model: string; size: string } {
  const m = settings.getAppSettings().modelscopeImage ?? {};
  return {
    token: String(m.token ?? "").trim(),
    model: String(m.model ?? "").trim() || MODELSCOPE_DEFAULT_MODEL,
    size: String(m.size ?? "").trim(),
  };
}

/**
 * 当前引擎能不能直接开跑；不能就给人话原因（界面直接显示这句话）。
 * 官方 HTTP 接口的前置条件是 API Key。
 */
export function imageProviderBlocked(): { code: string; message: string } | null {
  if (!modelScopeConfig().token) {
    return {
      code: "ms-no-token",
      message:
        "生图引擎现在选的是 ModelScope，但还没填 API Key：到「设置 → AI 服务 → 生图引擎」填上再试。" +
        "（就是 ModelScope 的访问令牌，ms- 开头；顺带确认账号已绑定阿里云并完成实名认证，否则免费额度不生效。）",
    };
  }
  return null;
}

/** 分镜画面比例 → ModelScope 出图尺寸（用户没手填尺寸时用这个） */
export function sizeForResolution(resolution?: VideoResolution): string {
  return resolution === "landscape" ? "1280x720" : "720x1280";
}

export interface GenerateImageOptions {
  /** 分镜的画面比例：决定出图尺寸 */
  resolution?: VideoResolution;
  /** 出图总时长上限 */
  timeoutMs?: number;
  signal?: AbortSignal;
  onPhase?: (message: string) => void;
  onSubmitted?: () => void;
}

/** 按当前引擎出一张图（失败抛错，由 describeImageFailure 收成人话） */
export async function generateImageForPrompt(
  prompt: string,
  opts: GenerateImageOptions = {}
): Promise<GeneratedImage> {
  const cfg = modelScopeConfig();
  const result: ModelScopeImage = await generateImageViaModelScope(prompt, {
    token: cfg.token,
    model: cfg.model,
    size: cfg.size || sizeForResolution(opts.resolution),
    timeoutMs: opts.timeoutMs,
    signal: opts.signal,
    onPhase: opts.onPhase,
    onSubmitted: opts.onSubmitted,
  });
  return { base64: result.base64, ext: result.ext, src: result.src };
}

/** 失败 → 结构化人话：统一收成 {code,message}（界面只认这一种） */
export function describeImageFailure(e: unknown): { code: string; message: string } {
  if (e instanceof ModelScopeError) return { code: e.code, message: e.message };
  return {
    code: "ms-network",
    message: (e as Error)?.message || "生图失败，请稍后重试。",
  };
}

/** 主进程算好给界面显示的引擎状态：界面不用重复实现一遍判断 */
export function imageProviderInfo(): ImageProviderInfo {
  const provider = currentImageProvider();
  const preset = imageProviderPreset(provider);
  const blocked = imageProviderBlocked();
  return {
    provider,
    label: preset.label,
    ready: !blocked,
    ...(blocked ? { code: blocked.code, message: blocked.message } : {}),
    model: provider === "modelscope" ? modelScopeConfig().model : "",
  };
}
