/**
 * 生图引擎分派层：界面只认「当前引擎」，具体怎么出图在这里决定。
 *
 * 上层（ipc / 编排层 / 批量队列）一律调这里，不再直接调豆包：
 *   - 豆包：浏览器自动化（前置条件多、有手动挡、失败模式是页面级的）；
 *   - ModelScope：HTTP API（前置条件是 Token、异步任务、会被限流）。
 *
 * 两边对外的返回值与失败形状保持一致（GeneratedImage / {code,message}），
 * 所以界面和批量队列都不用为第二个引擎写第二套分支。
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
import { describeDoubaoFailure, generateImageFromPrompt, type GeneratedImage } from "../doubao";
import { ModelScopeError, generateImageViaModelScope } from "./modelscope";

/** 当前生效的生图引擎（读错/没配过 = 豆包） */
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
 * 豆包的前置条件（登录态、页面就绪）不在这里判：那要窗口，只有 ipc 那层知道。
 */
export function imageProviderBlocked(): { code: string; message: string } | null {
  if (currentImageProvider() !== "modelscope") return null;
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
  /** 分镜的画面比例：给 API 引擎决定出图尺寸（豆包不看这个） */
  resolution?: VideoResolution;
  /** 豆包专用：是否自动点「发送」（API 引擎没有这个手动挡） */
  autoSubmit?: boolean;
  /** 豆包专用：填词/等图的超时（测试用） */
  timeouts?: {
    loginMs?: number;
    fillMs?: number;
    waitMs?: number;
    fetchMs?: number;
  };
  /** 出图总时长上限：豆包=等新图；ModelScope=排队+生成+下载 */
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
  if (currentImageProvider() === "modelscope") {
    const cfg = modelScopeConfig();
    return generateImageViaModelScope(prompt, {
      token: cfg.token,
      model: cfg.model,
      size: cfg.size || sizeForResolution(opts.resolution),
      timeoutMs: opts.timeoutMs,
      signal: opts.signal,
      onPhase: opts.onPhase,
      onSubmitted: opts.onSubmitted,
    });
  }
  return generateImageFromPrompt(prompt, {
    autoSubmit: opts.autoSubmit,
    timeoutMs: opts.timeoutMs,
    fetchTimeoutMs: opts.timeouts?.fetchMs,
    loginTimeoutMs: opts.timeouts?.loginMs,
    fillTimeoutMs: opts.timeouts?.fillMs,
    onPhase: opts.onPhase,
    onSubmitted: opts.onSubmitted,
  });
}

/** 失败 → 结构化人话：两个引擎的失败都收成 {code,message}（界面只认这一种） */
export function describeImageFailure(e: unknown): { code: string; message: string } {
  if (e instanceof ModelScopeError) return { code: e.code, message: e.message };
  return describeDoubaoFailure(e);
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
