/*
 * SPDX-License-Identifier: GPL-3.0-only
 * Copyright (c) 2026 宝螺 / Baoluo contributors
 * 本文件属于「宝螺 / Baoluo」。除 GPL-3.0 外还适用 ADDITIONAL_TERMS.md 里的附加条款：
 * 分发时须保留来源署名；修改版对外分发时不得沿用「宝螺」名称与图标。
 */
/**
 * ffmpeg 工具：共用 ffmpeg-static 调用 + 进度解析。
 *
 * 与 transcribe.ts 共用 ffmpegPath() 同一套 asarUnpack 处理：
 *   - dev 模式：require('ffmpeg-static') 直接拿到 exe 路径
 *   - prod 模式：exe 在 app.asar 内不可执行，需把 "app.asar" → "app.asar.unpacked"
 */
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import fs from "node:fs";

/** 返回本机 ffmpeg 可执行文件绝对路径（dev/prod 通用） */
export function ffmpegPath(): string {
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const raw: string = require("ffmpeg-static");
  return raw.replace(/app\.asar/g, "app.asar.unpacked");
}

export interface RunFfmpegOptions {
  cwd?: string;
  /** 整体超时（ms）。0 表示无限 */
  timeoutMs?: number;
  /** 取消信号：中止时立即杀掉 ffmpeg 子进程并拒绝 */
  signal?: AbortSignal;
  /** 解析 `-progress pipe:N` 输出后回调；time 单位：秒 */
  onProgress?: (info: { time: number; fps?: number; speed?: string }) => void;
  /** progress 数据流方向，默认 stderr */
  progressSink?: "stdout" | "stderr";
}

export interface FfmpegResult {
  code: number;
  stderr: string;
  stdout: string;
}

/**
 * 执行 ffmpeg。完成后返回 { code, stderr, stdout }。
 *
 * 进度用法：在 args 中加 `-progress pipe:1`（或 pipe:2），
 *          然后通过 opts.onProgress 收到每个 progress block 的累积时间。
 *          调用方应自行根据"已编时长 / 总时长"换算百分比。
 */
export function runFfmpeg(args: string[], opts: RunFfmpegOptions = {}): Promise<FfmpegResult> {
  return new Promise((resolve, reject) => {
    const child = spawn(ffmpegPath(), args, {
      cwd: opts.cwd,
      windowsHide: true,
      stdio: ["ignore", "pipe", "pipe"],
    });

    let stdout = "";
    let stderr = "";
    const kvBuf: Record<"stdout" | "stderr", { key: string; v: string }[]> = { stdout: [], stderr: [] };
    let timer: NodeJS.Timeout | null = null;
    if (opts.timeoutMs && opts.timeoutMs > 0) {
      timer = setTimeout(() => {
        try {
          child.kill("SIGKILL");
        } catch {
          /* noop */
        }
        reject(new Error(`ffmpeg timeout after ${opts.timeoutMs}ms`));
      }, opts.timeoutMs);
    }

    const abortHandler = () => {
      if (timer) clearTimeout(timer);
      try {
        child.kill("SIGKILL");
      } catch {
        /* noop */
      }
      reject(new Error("已取消"));
    };
    if (opts.signal) {
      if (opts.signal.aborted) {
        abortHandler();
        return;
      }
      opts.signal.addEventListener("abort", abortHandler, { once: true });
    }

    const handleProgress = () => {
      if (!opts.onProgress) return;
      const sink = opts.progressSink ?? "stderr";
      const last = kvBuf[sink];
      if (!last.length) return;
      const map: Record<string, string> = {};
      for (const { key, v } of last) map[key] = v;
      kvBuf[sink] = [];
      const t = map["out_time_ms"] ?? (map["out_time_us"] ? String(Math.floor(+map["out_time_us"] / 1000)) : "");
      if (t) {
        opts.onProgress({
          time: +t / 1000,
          ...(map["fps"] ? { fps: +map["fps"] } : {}),
          ...(map["speed"] ? { speed: map["speed"] } : {}),
        });
      }
    };

    const feedBuffer = (sink: "stdout" | "stderr", raw: string) => {
      const wantSink = opts.progressSink ?? "stderr";
      if (wantSink !== sink) return;
      const lines = raw.split(/\r?\n/);
      for (const ln of lines) {
        if (!ln) continue;
        if (ln === "progress=continue" || ln === "progress=end") {
          handleProgress();
          continue;
        }
        const eq = ln.indexOf("=");
        if (eq < 0) continue;
        const key = ln.slice(0, eq).trim();
        const v = ln.slice(eq + 1).trim();
        kvBuf[sink].push({ key, v });
      }
    };

    child.stdout.on("data", (b: Buffer) => {
      const s = b.toString("utf8");
      stdout += s;
      feedBuffer("stdout", s);
    });
    child.stderr.on("data", (b: Buffer) => {
      const s = b.toString("utf8");
      stderr += s;
      feedBuffer("stderr", s);
    });

    child.on("error", (e) => {
      if (timer) clearTimeout(timer);
      opts.signal?.removeEventListener("abort", abortHandler);
      reject(e);
    });
    child.on("close", (code) => {
      if (timer) clearTimeout(timer);
      opts.signal?.removeEventListener("abort", abortHandler);
      // 把最后一帧 progress flush 出去
      handleProgress();
      resolve({ code: code ?? -1, stdout, stderr });
    });
  });
}

/** 读音频时长（秒）。失败回退 1。 */
export function probeAudioDuration(file: string): Promise<number> {
  return new Promise((resolve) => {
    if (!fs.existsSync(file)) return resolve(1);
    const child = spawn(ffmpegPath(), ["-hide_banner", "-i", file], { windowsHide: true });
    let err = "";
    child.stderr.on("data", (b) => (err += b.toString("utf8")));
    child.on("close", () => {
      const m = /Duration:\s*(\d+):(\d+):(\d+\.\d+)/.exec(err);
      resolve(m ? +m[1] * 3600 + +m[2] * 60 + +m[3] : 1);
    });
    child.on("error", () => resolve(1));
  });
}
