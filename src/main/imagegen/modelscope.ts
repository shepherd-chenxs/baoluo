/*
 * SPDX-License-Identifier: GPL-3.0-only
 * Copyright (c) 2026 宝螺 / Baoluo contributors
 * 本文件属于「宝螺 / Baoluo」。除 GPL-3.0 外还适用 ADDITIONAL_TERMS.md 里的附加条款：
 * 分发时须保留来源署名；修改版对外分发时不得沿用「宝螺」名称与图标。
 */
/**
 * ModelScope API-Inference 生图客户端。
 *
 * 协议（官方 api-inference 的图片生成，三步）：
 *   1) POST {base}/v1/images/generations
 *      头：Authorization: Bearer <SDK Token>、X-ModelScope-Async-Mode: true
 *      体：{ model, prompt, size?, steps?, guidance?, negative_prompt?, seed? }
 *      → { task_id }
 *   2) GET  {base}/v1/tasks/{task_id}
 *      头：Authorization、X-ModelScope-Task-Type: image_generation
 *      → { task_status: PENDING|RUNNING|SUCCEED|FAILED, output_images?: string[], message? }
 *      轮询到 SUCCEED，取 output_images[0]（是个图片 URL）
 *   3) 下载那个 URL → 字节
 *
 * 与浏览器自动化的区别：
 *   - 这里是**异步任务**，提交后要轮询等出图（可能十几秒，排队时更久）；
 *   - 免费额度会被**限流（HTTP 429）**，所以 429 要退避重试，不能直接甩给用户；
 *   - 没有浏览器，也就没有「只填词不发送」这种手动挡，也不需要登录态。
 */
import { net } from "electron";
import { withNetworkRetry } from "../net-retry";
import { sniffRasterImageExt } from "../../shared/image-magic";
import { MODELSCOPE_BASE_URL, MODELSCOPE_DEFAULT_MODEL } from "../../shared/image-providers";

export type ModelScopeErrorCode =
  | "ms-no-token"
  | "ms-unauthorized"
  | "ms-not-bound"
  | "ms-rate-limited"
  | "ms-bad-request"
  | "ms-task-failed"
  | "ms-timeout"
  | "ms-empty"
  | "ms-network"
  | "cancelled";

export class ModelScopeError extends Error {
  readonly code: ModelScopeErrorCode;
  constructor(message: string, code: ModelScopeErrorCode) {
    super(message);
    this.name = "ModelScopeError";
    this.code = code;
  }
}

/** 出图结果的形状与统一接口 GenerateImage 一致，上层不用分两套处理 */
export interface ModelScopeImage {
  base64: string;
  ext: string;
  src: string;
}

export interface ModelScopeOptions {
  /** ModelScope SDK Token */
  token: string;
  /** 模型 id；留空用默认 */
  model?: string;
  /** 出图尺寸 WxH；留空不传，由服务端按模型默认走 */
  size?: string;
  /** 单张出图的总时长上限（默认 5 分钟：排队 + 生成 + 下载） */
  timeoutMs?: number;
  signal?: AbortSignal;
  onPhase?: (message: string) => void;
  /** 任务提交成功（拿到 task_id）后回调一次：批量队列用它数「提交了几次请求」 */
  onSubmitted?: () => void;
}

/** 提交与轮询的单次请求超时 */
const SUBMIT_TIMEOUT_MS = 120_000;
const POLL_REQUEST_TIMEOUT_MS = 10_000;
/** 轮询节奏：前 60 秒密一点（多数任务十几秒出图），之后拉长到 10 秒 */
const POLL_FAST_MS = 3_000;
const POLL_SLOW_MS = 10_000;
const POLL_FAST_WINDOW_MS = 60_000;
/** 轮询总次数上限：5 分钟 / 平均 5 秒 ≈ 60 次，给足排队余量 */
const POLL_MAX_ATTEMPTS = 120;
/** 限流退避：免费额度并发很低，429 是常态而不是异常 */
const RATE_LIMIT_BACKOFF_MS = [5_000, 10_000, 20_000, 30_000];
const MAX_RATE_LIMIT_RETRIES = RATE_LIMIT_BACKOFF_MS.length;
/** 网络抖动（5xx / 连接层错误）的重试上限 */
const MAX_TRANSIENT_RETRIES = 10;

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

/** 可被取消的等待：点「中止」不用等满一轮退避 */
async function sleepCancellable(ms: number, signal?: AbortSignal): Promise<void> {
  let left = ms;
  while (left > 0) {
    if (signal?.aborted) throw new ModelScopeError("已取消", "cancelled");
    const slice = Math.min(250, left);
    await sleep(slice);
    left -= slice;
  }
}

function abortError(): ModelScopeError {
  return new ModelScopeError("已取消", "cancelled");
}

interface RequestOptions {
  method: "GET" | "POST";
  body?: Record<string, unknown>;
  extraHeaders?: Record<string, string>;
  timeoutMs: number;
  signal?: AbortSignal;
}

/** 单次 HTTP 请求：把超时、取消、瞬时网络错误都收成 ModelScopeError */
async function requestJson<T>(path: string, token: string, opts: RequestOptions): Promise<T> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), opts.timeoutMs);
  const onExternalAbort = () => controller.abort();
  if (opts.signal?.aborted) {
    clearTimeout(timer);
    throw abortError();
  }
  opts.signal?.addEventListener("abort", onExternalAbort, { once: true });
  try {
    const res = await withNetworkRetry(opts.signal, () =>
      net.fetch(`${MODELSCOPE_BASE_URL}${path}`, {
        method: opts.method,
        signal: controller.signal,
        headers: {
          Authorization: `Bearer ${token}`,
          ...(opts.method === "POST" ? { "Content-Type": "application/json" } : {}),
          ...(opts.extraHeaders ?? {}),
        },
        ...(opts.method === "POST" && opts.body ? { body: JSON.stringify(opts.body) } : {}),
      })
    );
    if (!res.ok) {
      const detail = (await res.text().catch(() => "")).slice(0, 300);
      throw new ModelScopeHttpError(res.status, detail);
    }
    return (await res.json()) as T;
  } catch (e) {
    // 顺序必须是「先看是不是用户取消」：超时和外部 abort 都会抛 AbortError
    if (opts.signal?.aborted) throw abortError();
    if (e instanceof ModelScopeHttpError) throw e;
    if ((e as Error)?.name === "AbortError") {
      throw new ModelScopeError("调 ModelScope 超时了，请检查网络后重试。", "ms-timeout");
    }
    throw new ModelScopeError((e as Error)?.message || "调 ModelScope 失败，请稍后重试。", "ms-network");
  } finally {
    clearTimeout(timer);
    opts.signal?.removeEventListener("abort", onExternalAbort);
  }
}

/** 带 HTTP 状态码的失败：分派层据此决定「退避重试」还是「直接报错给用户」 */
class ModelScopeHttpError extends Error {
  readonly status: number;
  readonly detail: string;
  constructor(status: number, detail: string) {
    super(`ModelScope HTTP ${status}${detail ? `：${detail}` : ""}`);
    this.name = "ModelScopeHttpError";
    this.status = status;
    this.detail = detail;
  }
}

/** HTTP 失败 → 人话（401/403 是 Token 或账号问题，400 多半是尺寸/模型参数不对） */
function describeHttpFailure(e: ModelScopeHttpError): ModelScopeError {
  if (e.status === 401 || e.status === 403) {
    /*
     * 魔搭对「没绑定阿里云账号 / 没实名」返回的也是 401，但文案是
     * "please bind your alibaba cloud account before use"。
     * 这种情况说「Token 不对」会把用户带偏（Token 明明是对的），所以单独认出来。
     */
    if (/bind your alibaba cloud|alibaba cloud account/i.test(e.detail)) {
      return new ModelScopeError(
        "ModelScope 账号还没绑定阿里云账号（或没完成实名认证），免费额度没开通：" +
          "打开 modelscope.cn，点右上角头像 → Bind Alibabacloud 绑定阿里云并完成实名认证，再回来试。",
        "ms-not-bound"
      );
    }
    return new ModelScopeError(
      "ModelScope 鉴权失败：API Key 不对或没权限。到「设置 → AI 服务 → 生图引擎」重新填一个（访问令牌页复制 default 那条）。",
      "ms-unauthorized"
    );
  }
  if (e.status === 429) {
    return new ModelScopeError("ModelScope 限流了（免费额度并发很低），稍等一会儿再试。", "ms-rate-limited");
  }
  if (e.status === 400 || e.status === 422) {
    return new ModelScopeError(
      `ModelScope 说这个请求不合法（多半是模型 id 或尺寸不被支持）：${e.detail || "无详情"}`,
      "ms-bad-request"
    );
  }
  if (e.status === 404) {
    return new ModelScopeError(
      `ModelScope 上找不到这个模型：请到「设置 → AI 服务 → 生图引擎」确认模型 id。`,
      "ms-bad-request"
    );
  }
  return new ModelScopeError(`ModelScope 服务出错（HTTP ${e.status}），请稍后重试。`, "ms-network");
}

interface TaskSubmitResult {
  task_id?: string;
}

interface TaskResult {
  task_id?: string;
  task_status?: string;
  output_images?: string[];
  message?: string;
}

/**
 * 按当前引擎出一张图。
 *
 * 失败一律抛 ModelScopeError（带 code），由上层收成人话；
 * 绝不把英文堆栈直接暴露给界面。
 */
export async function generateImageViaModelScope(
  prompt: string,
  opts: ModelScopeOptions
): Promise<ModelScopeImage> {
  const token = (opts.token ?? "").trim();
  if (!token) {
    throw new ModelScopeError(
      "还没填 ModelScope 的 API Key：到「设置 → AI 服务 → 生图引擎」填上再试。" +
        "（就是访问令牌，ms- 开头；需要账号先绑定阿里云并实名认证才有免费额度。）",
      "ms-no-token"
    );
  }
  const model = (opts.model ?? "").trim() || MODELSCOPE_DEFAULT_MODEL;
  const timeoutMs = opts.timeoutMs && opts.timeoutMs > 0 ? opts.timeoutMs : 5 * 60_000;
  const deadline = Date.now() + timeoutMs;
  const { signal, onPhase } = opts;
  const cleanPrompt = (prompt ?? "").trim();
  if (!cleanPrompt) throw new ModelScopeError("这一镜还没有画面提示词。", "ms-bad-request");

  // ---- ① 提交任务（限流要退避重试）----
  onPhase?.(`正在向 ModelScope 提交生图任务（${model}）…`);
  let taskId = "";
  let rateLimitHits = 0;
  for (;;) {
    try {
      const submitted = await requestJson<TaskSubmitResult>("/v1/images/generations", token, {
        method: "POST",
        timeoutMs: SUBMIT_TIMEOUT_MS,
        signal,
        extraHeaders: { "X-ModelScope-Async-Mode": "true" },
        body: {
          model,
          prompt: cleanPrompt,
          ...(opts.size ? { size: opts.size } : {}),
        },
      });
      taskId = String(submitted?.task_id ?? "").trim();
      if (!taskId) throw new ModelScopeError("ModelScope 没返回任务号，请重试。", "ms-empty");
      opts.onSubmitted?.();
      break;
    } catch (e) {
      const http = e instanceof ModelScopeHttpError ? e : null;
      const retriable = http?.status === 429 || (http?.status ?? 0) >= 500 || e instanceof ModelScopeError && e.code === "ms-network";
      if (!retriable || rateLimitHits >= MAX_RATE_LIMIT_RETRIES) throw toModelScopeError(e);
      const wait = RATE_LIMIT_BACKOFF_MS[Math.min(rateLimitHits, RATE_LIMIT_BACKOFF_MS.length - 1)];
      rateLimitHits++;
      onPhase?.(
        `ModelScope 正忙（限流），${Math.round(wait / 1000)} 秒后自动重试（第 ${rateLimitHits} 次）…`
      );
      await sleepCancellable(wait, signal);
    }
  }

  // ---- ② 轮询到出图 ----
  let pollCount = 0;
  let transientRetries = 0;
  const startedAt = Date.now();
  for (;;) {
    if (Date.now() > deadline) {
      throw new ModelScopeError(
        "等 ModelScope 出图超时了（任务可能还在排队）。稍后再点一次「生图」，已出的图不会重做。",
        "ms-timeout"
      );
    }
    if (pollCount >= POLL_MAX_ATTEMPTS) {
      throw new ModelScopeError("ModelScope 任务排队太久，先不等了，稍后重试。", "ms-timeout");
    }
    pollCount++;
    let result: TaskResult | null = null;
    try {
      result = await requestJson<TaskResult>(`/v1/tasks/${encodeURIComponent(taskId)}`, token, {
        method: "GET",
        timeoutMs: POLL_REQUEST_TIMEOUT_MS,
        signal,
        extraHeaders: { "X-ModelScope-Task-Type": "image_generation" },
      });
      transientRetries = 0;
    } catch (e) {
      const http = e instanceof ModelScopeHttpError ? e : null;
      // 429 / 5xx / 连接层错误都算瞬时：退避后再轮询（任务还在服务端跑，不能因为一次抖动就放弃）
      const transient = http?.status === 429 || (http?.status ?? 0) >= 500 || (e as ModelScopeError)?.code === "ms-network";
      if (!transient) throw toModelScopeError(e);
      transientRetries++;
      if (transientRetries >= MAX_TRANSIENT_RETRIES) throw toModelScopeError(e);
      onPhase?.(`查 ModelScope 进度失败，${MAX_TRANSIENT_RETRIES - transientRetries} 次重试机会内再试…`);
      await sleepCancellable(transientRetries * 2_000, signal);
      continue;
    }

    const status = String(result?.task_status ?? "").toUpperCase();
    if (status === "SUCCEED") {
      const url = String(result?.output_images?.[0] ?? "").trim();
      if (!url) throw new ModelScopeError("ModelScope 出图成功了但没给图片地址，请重试。", "ms-empty");
      onPhase?.("正在把图下载回来…");
      const bytes = await downloadImage(url, signal);
      const ext = sniffRasterImageExt(bytes) ?? ".png";
      onPhase?.("图已取回");
      return { base64: bytes.toString("base64"), ext, src: url };
    }
    if (status === "FAILED") {
      const why = String(result?.message ?? "").trim();
      throw new ModelScopeError(
        `ModelScope 出图失败${why ? `：${why}` : ""}。换个提示词或换个模型再试。`,
        "ms-task-failed"
      );
    }
    // PENDING / RUNNING：按节奏等下一轮
    const waited = Date.now() - startedAt;
    const interval = waited < POLL_FAST_WINDOW_MS ? POLL_FAST_MS : POLL_SLOW_MS;
    onPhase?.(
      `ModelScope 正在出图（${status === "RUNNING" ? "生成中" : "排队中"}，已等 ${Math.round(
        waited / 1000
      )} 秒）…`
    );
    await sleepCancellable(interval, signal);
  }
}

/** 出图结果下载：失败也收成 ModelScopeError，别把 fetch 的原始错误漏出去 */
async function downloadImage(url: string, signal?: AbortSignal): Promise<Buffer> {
  try {
    const res = await withNetworkRetry(signal, () => net.fetch(url, { signal: signal as AbortSignal }));
    if (!res.ok) {
      throw new ModelScopeError(`下载出图结果失败（HTTP ${res.status}），请重试。`, "ms-network");
    }
    const buf = Buffer.from(await res.arrayBuffer());
    if (!buf.length) throw new ModelScopeError("下载回来的图是空的，请重试。", "ms-empty");
    return buf;
  } catch (e) {
    if (signal?.aborted) throw abortError();
    if (e instanceof ModelScopeError) throw e;
    throw new ModelScopeError("下载出图结果失败，请检查网络后重试。", "ms-network");
  }
}

/** 各类失败统一收成 ModelScopeError（界面只认 {code, message}） */
function toModelScopeError(e: unknown): ModelScopeError {
  if (e instanceof ModelScopeError) return e;
  if (e instanceof ModelScopeHttpError) return describeHttpFailure(e);
  return new ModelScopeError((e as Error)?.message || "ModelScope 生图失败，请稍后重试。", "ms-network");
}
