import { app, BrowserWindow, dialog, ipcMain, shell } from "electron";
import fs from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { parseMedia } from "./parser";
import type {
  AppSettings,
  CloneVoice,
  LocalTtsEnv,
  LocalTtsProgress,
  LocalTtsStatus,
  LocalTtsTaskResult,
  LocalTtsTaskSnapshot,
  VideoMeta,
} from "../shared/dialogue-types";
import { downloadVideo, safeFileName } from "./downloader";
import { listModels, testChat } from "./ai-client";
import { isModelReady, transcribeVideo, type TranscribeResult } from "./transcribe";
import { DialogueParser } from "./dialogue/parser";
import * as settings from "./dialogue/settings";
import { runCompose, defaultOutputDir, cancelCompose, getComposeSnapshot } from "./dialogue/compose";
import {
  BUILTIN_TEMPLATE_ID,
  BUILTIN_TEMPLATE_NAME,
  builtinTemplateConfig,
  builtinTemplateSummary,
} from "./dialogue/builtin-template";
import type { ComposeRequest } from "../shared/dialogue-types";
import { prosodyPercent, TtsEngine } from "./dialogue/tts";
import { GenieTtsEngine } from "./dialogue/genie";
import { genieManager, genieLogFile, genieRootDir } from "./dialogue/genie-manager";
import {
  cloneIdFromVoice,
  findCloneVoice,
  localTtsBaseUrl,
  synthCloneSingle,
} from "./dialogue/clone-voice";
import { runFfmpeg, probeAudioDuration } from "./dialogue/ffmpeg";
import { describeFsError } from "./fsError";
import type { AgentCreateResult, AgentTask } from "../shared/agent-types";
import type { Conversation, ConversationSummary } from "../shared/conversation-types";
import type {
  RuntimeChatMessage,
  RuntimeId,
  RuntimePermissionId,
  RuntimePrefs,
  RuntimeState,
} from "../shared/runtime-types";
import {
  normalizePrefs,
  type RuntimeModelList,
} from "../shared/runtime-types";
import { cachedRuntimes, detectRuntimesCached, detectedAt } from "./runtime/detect";
import { listSkills, skillsDir } from "./runtime/skills";
import { chatWithRuntime, runtimeSkillsDir } from "./runtime/chat";
import { modelsFor } from "./runtime/models";
import { llmRoute } from "./llm";
import { cancelTextCard, runTextCard, textCardOutputDir } from "./textcard";
import type { TextCardRequest, TextCardResult } from "../shared/textcard-types";
import type { HotItem } from "../shared/storyboard-types";
import { createTaskSmart } from "./agent/workflows";
import { writeDialogueScript } from "./agent/script-writer";
import { getTask, listTasks, removeTask, saveTask } from "./agent/store";
import {
  appendMessage,
  bindTask,
  conversationOfTask,
  createConversation,
  getConversation,
  listConversations,
  removeConversation,
  renameConversation,
} from "./agent/conversations";
import { cancelTask, forceRelease, runTask } from "./agent/runner";
import {
  clearDataDir,
  copyDataDir,
  currentDataDir,
  defaultDataDir,
  dirSizeBytes,
  scheduleDataDirCleanup,
  writeDataRoot,
} from "./userData";
import { getHotList, getHotSources } from "./hot";
import { generateAiDraft, regenerateShotPrompt } from "./storyboard/ai";
import * as storyStore from "./storyboard/store";
import * as recordsStore from "./records/store";
import {
  doubaoLoginBlocked,
  ensureDoubaoReady,
  getDoubaoAccountState,
  getDoubaoState,
  getGenerationGuardState,
  openDoubaoLogin,
  releaseDoubaoBeforeMigration,
  reloadDoubao,
  setDoubaoVisible,
} from "./doubao";
import {
  batchAutoSubmitBlocked,
  cancelBatch,
  getBatchState,
  setBatchEmitter,
  startBatch,
} from "./doubao-batch";
import {
  describeDoubaoFailure,
  generateShotImage,
  type GenerateShotOutcome,
} from "./doubao-shot";
import { doubaoDailyCapBlocked } from "./doubao-quota";import { runSniff } from "./sniff/pipeline";
import {
  currentImageProvider,
  imageProviderBlocked,
  imageProviderInfo,
} from "./imagegen";
import type {
  Storyboard,
  StoryboardSummary,
  StoryGenerateRequest,
} from "../shared/storyboard-types";
import type { SniffRunRequest } from "../shared/sniff-types";
import type {
  WorkRecord,
  WorkRecordKind,
  WorkRecordSaveRequest,
  WorkRecordSummary,
} from "../shared/record-types";

/** 音色试听默认示例句 */
const PREVIEW_TEXT = "你只管努力，剩下的交给时间。";

/**
 * Genie 读参考音频用的是 soundfile（libsndfile），只认这些格式；
 * m4a / aac / wma / 视频里的音轨都得先转成 wav 才能当参考音频。
 */
const GENIE_AUDIO_EXTS = new Set([".wav", ".flac", ".ogg", ".aiff", ".aif"]);

/**
 * 把用户选的参考音频准备成 Genie 能读的文件。
 * 已经是 wav/flac/ogg/aiff 就原样返回；其它格式（m4a / mp3 / aac / wma / 视频）先用 ffmpeg
 * 转成 32kHz 单声道 wav 副本（放在 userData/clone-refs，长期可用）。
 */
async function prepareReferenceAudio(file: string): Promise<string> {
  if (!file || !fs.existsSync(file)) throw new Error("音频文件不存在或已被移动。");
  const ext = path.extname(file).toLowerCase();
  if (GENIE_AUDIO_EXTS.has(ext)) return file;

  const dir = path.join(app.getPath("userData"), "clone-refs");
  fs.mkdirSync(dir, { recursive: true });
  const out = path.join(dir, `ref-${Date.now()}-${Math.floor(Math.random() * 10000)}.wav`);
  const res = await runFfmpeg(
    ["-y", "-i", file, "-ar", "32000", "-ac", "1", "-c:a", "pcm_s16le", out],
    { timeoutMs: 120_000 }
  );
  const ok = res.code === 0 && fs.existsSync(out) && fs.statSync(out).size > 1024;
  if (!ok) {
    try {
      if (fs.existsSync(out)) fs.unlinkSync(out);
    } catch {
      /* noop */
    }
    throw new Error("这个音频没能转成 WAV，请改用 wav / mp3 / m4a / flac 再试。");
  }
  return out;
}

export function registerIpc() {
  // -----------------------------------------------------------------
  // 数据目录（模型/运行时都在这里，可换到别的盘释放 C 盘空间）
  // -----------------------------------------------------------------

  /** 当前数据目录信息（界面展示用，含体积） */
  ipcMain.handle(
    "data-dir:get",
    (): { current: string; defaultDir: string; isCustom: boolean; sizeBytes: number } => {
      const current = currentDataDir();
      const def = defaultDataDir();
      return {
        current,
        defaultDir: def,
        isCustom: path.resolve(current) !== path.resolve(def),
        sizeBytes: dirSizeBytes(current),
      };
    }
  );

  /** 选择新的数据目录 */
  ipcMain.handle("data-dir:choose", async (e, currentPath?: string): Promise<string | null> => {
    const win = BrowserWindow.fromWebContents(e.sender) ?? BrowserWindow.getFocusedWindow();
    // 默认定位到"当前数据目录同级的 data"（目录不存在时系统会退到最近的已有父目录）。
    // 不要定位到当前目录本身——选到自己会被当成"没改"而拒绝。
    const base = currentPath?.trim() || currentDataDir();
    const suggested = path.join(path.dirname(base), "data");
    const res = await dialog.showOpenDialog(win!, {
      title: "选择数据目录（模型、运行时都会放进去）",
      defaultPath: suggested,
      buttonLabel: "用这个目录",
      properties: ["openDirectory", "createDirectory"],
    });
    if (res.canceled || !res.filePaths.length) return null;
    return res.filePaths[0];
  });

  /**
   * 迁移数据目录：复制 → 写指针 → （可选）清空旧目录。
   * 只复制成功后才切指针，中途失败时旧数据完整、启动仍走旧目录。
   */
  ipcMain.handle(
    "data-dir:migrate",
    async (
      e,
      req: { target: string; move?: boolean }
    ): Promise<{
      copied: number;
      bytes: number;
      skippedCount: number;
      failedClearCount: number;
      current: string;
    }> => {
      const target = req?.target?.trim();
      if (!target) throw new Error("请选择目标目录。");
      const src = currentDataDir();
      const dst = path.resolve(target);
      const srcResolved = path.resolve(src);
      if (dst === srcResolved) throw new Error("目标目录就是当前数据目录。");
      // 防呆：互相包含会把数据越拷越多（甚至递归）
      if (dst.startsWith(srcResolved + path.sep) || srcResolved.startsWith(dst + path.sep)) {
        throw new Error("目标目录不能是当前数据目录的子目录（或反过来），请选一个独立目录。");
      }

      fs.mkdirSync(dst, { recursive: true });
      // 目标盘空间校验：不够就直接拦下，别拷到一半失败
      const needBytes = dirSizeBytes(src);
      try {
        const st = fs.statfsSync(dst);
        const free = Number(st.bavail) * Number(st.bsize);
        if (free > 0 && free < needBytes * 1.05) {
          const gb = (n: number) => (n / 1024 / 1024 / 1024).toFixed(1);
          throw new Error(`目标盘空间不足：需要约 ${gb(needBytes)} GB，可用 ${gb(free)} GB。`);
        }
      } catch (err) {
        if (err instanceof Error && err.message.startsWith("目标盘空间不足")) throw err;
        /* 拿不到磁盘信息就不拦 */
      }

      /*
       * 豆包登录态就在数据目录里。迁移前先销毁豆包视图并刷盘：
       * 视图活着时 Chromium 占着分区的 cookie / 缓存文件，直接复制会拷到半截状态。
       */
      releaseDoubaoBeforeMigration();

      const send = (p: unknown) => {
        if (!e.sender.isDestroyed()) e.sender.send("data-dir:progress", p);
      };
      const result = await copyDataDir(src, dst, { onProgress: send });
      // 复制完成才切指针：中途失败也不会把用户的数据"搬丢"
      writeDataRoot(dst);
      let failedClearCount = 0;
      if (req.move) {
        failedClearCount = clearDataDir(src).failed.length;
        // 运行中删不掉的（模型被服务占着、缓存在写）留给下次启动补删
        if (failedClearCount > 0) scheduleDataDirCleanup(src);
      }
      return {
        copied: result.copied,
        bytes: result.bytes,
        skippedCount: result.skipped.length,
        failedClearCount,
        current: dst,
      };
    }
  );

  /**
   * 重启应用（迁移完生效）。
   * 开发模式下不要真的 relaunch：那样会把 vite 一起带走，窗口会白屏，
   * 交给开发者手动重启 `npm run dev`。
   */
  ipcMain.handle("app:relaunch", (): { dev: boolean } => {
    if (process.env.NODE_ENV === "development") return { dev: true };
    app.relaunch();
    app.exit(0);
    return { dev: false };
  });

  ipcMain.handle("media:parse", async (_e, shareText: string): Promise<VideoMeta> => {
    return await parseMedia(shareText);
  });

  ipcMain.handle("app:chooseSavePath", async (e, suggestedName: string): Promise<string | null> => {
    const win = BrowserWindow.fromWebContents(e.sender) ?? BrowserWindow.getFocusedWindow();
    const res = await dialog.showSaveDialog(win!, {
      title: "保存视频",
      defaultPath: suggestedName,
      filters: [{ name: "MP4 视频", extensions: ["mp4"] }],
    });
    return res.canceled ? null : res.filePath ?? null;
  });

  ipcMain.handle(
    "media:download",
    async (
      e,
      params: {
        url: string;
        savePath: string;
        requestId?: string;
        platform?: VideoMeta["platform"];
        audioUrl?: string;
      }
    ): Promise<{ ok: true; path: string }> => {
      const savePath = params.savePath.endsWith(".mp4")
        ? params.savePath
        : params.savePath + ".mp4";
      try {
        await downloadVideo({
          url: params.url,
          savePath,
          webContents: e.sender,
          requestId: params.requestId,
          platform: params.platform,
          audioUrl: params.audioUrl,
        });
      } catch (err) {
        // 没权限/磁盘满时提示"改素材目录"，不抛英文错误码
        throw describeFsError(err, path.dirname(savePath), "素材捕手保存目录");
      }
      return { ok: true, path: savePath };
    }
  );

  ipcMain.handle(
    "app:suggestFileName",
    (_e, meta: VideoMeta): string => {
      const base = `${safeFileName(meta.author)}-${safeFileName(meta.title, 30)}-${safeFileName(
        meta.id,
        40
      )}`;
      return path.join(base + ".mp4");
    }
  );

  // ---------- 素材捕手：素材保存目录 ----------

  /** 默认素材目录：<数据目录>/footage（跟着数据目录走，用户好找） */
  function defaultMaterialsDir(): string {
    return path.join(currentDataDir(), "footage");
  }

  /** 当前生效的素材目录：用户自定义 > 默认 */
  function currentMaterialsDir(): string {
    const custom = settings.getAppSettings().materialsDir;
    return custom && custom.trim() ? custom.trim() : defaultMaterialsDir();
  }

  ipcMain.handle("media:defaultSaveDir", (): string => {
    return currentMaterialsDir();
  });

  /** 弹出原生目录选择框，选择素材保存目录；用户取消则返回 null */
  ipcMain.handle(
    "app:chooseMaterialsDir",
    async (e, currentPath: string | null): Promise<string | null> => {
      const win = BrowserWindow.fromWebContents(e.sender) ?? BrowserWindow.getFocusedWindow();
      const res = await dialog.showOpenDialog(win!, {
        title: "选择素材保存目录",
        defaultPath: currentPath || defaultMaterialsDir(),
        properties: ["openDirectory", "createDirectory"],
      });
      if (res.canceled || !res.filePaths.length) return null;
      return res.filePaths[0];
    }
  );

  /** 自动下载用的保存路径：目录不存在则创建，重名自动追加 (1)(2)… */
  ipcMain.handle("media:autoSavePath", (_e, meta: VideoMeta): string => {
    const dir = currentMaterialsDir();
    fs.mkdirSync(dir, { recursive: true });
    /*
     * id 也要清洗：通用网页解析出来的 id 就是整条 URL（含 `://`），
     * 直接拼进文件名在 Windows 上是非法路径，mkdir/写入会直接 ENOENT。
     */
    const base = `${safeFileName(meta.author) || "unknown"}-${safeFileName(
      meta.title,
      30
    )}-${safeFileName(meta.id, 40)}`;
    let candidate = path.join(dir, base + ".mp4");
    let n = 1;
    while (fs.existsSync(candidate)) {
      candidate = path.join(dir, `${base}(${n}).mp4`);
      n++;
    }
    return candidate;
  });

  ipcMain.handle(
    "media:openDir",
    async (): Promise<{ ok: boolean; path: string; error?: string }> => {
      const dir = currentMaterialsDir();
      fs.mkdirSync(dir, { recursive: true });
      const err = await shell.openPath(dir);
      return err ? { ok: false, path: dir, error: err } : { ok: true, path: dir };
    }
  );

  ipcMain.handle("transcribe:isModelReady", () => isModelReady());

  /** 正在运行的转录任务：requestId → AbortController */
  const transcribeControllers = new Map<string, AbortController>();

  ipcMain.handle(
    "transcribe:run",
    async (
      e,
      params: { videoPath: string; requestId?: string; language?: string }
    ) => {
      const controller = new AbortController();
      if (params.requestId) transcribeControllers.set(params.requestId, controller);
      try {
        return await transcribeVideo({
          videoPath: params.videoPath,
          webContents: e.sender,
          requestId: params.requestId,
          language: params.language,
          signal: controller.signal,
        });
      } finally {
        if (params.requestId) transcribeControllers.delete(params.requestId);
      }
    }
  );

  ipcMain.handle("transcribe:cancel", (_e, requestId: string) => {
    transcribeControllers.get(requestId)?.abort();
  });

  // -----------------------------------------------------------------
  // 对话视频生成 (laodeng 功能集成)
  // -----------------------------------------------------------------

  /** 把本地绝对路径转成 bee-file:// URL，供 <video>/<img> 直接消费 */
  ipcMain.handle("media:toUrl", (_e, filePath: string): string => {
    if (!filePath) return "";
    const abs = path.resolve(filePath).replace(/\\/g, "/");
    // 用固定 host "local"，避免 Windows 盘符 "E:" 被 Chromium 当成 host 解析
    return "bee-file://local/" + encodeURIComponent(abs);
  });

  ipcMain.handle(
    "dialogue:parse",
    (_e, text: string, opts?: Parameters<DialogueParser["parse"]>[1]) => {
    const parser = new DialogueParser();
    const lines = parser.parse(text, opts);
    const warnings = parser.validate(lines, opts);
    return { lines, warnings };
    }
  );

  ipcMain.handle("dialogue:getSettings", () => settings.getSettings());

  /**
   * 内置对话模板（应用自带、只能用不能改）：模板库列表要显示它，应用/查看也要读它的配置。
   * 不存进用户数据——它就不是用户数据，存了反而要加一堆删改保护。
   */
  ipcMain.handle("dialogue:builtinTemplate", () => ({
    id: BUILTIN_TEMPLATE_ID,
    title: BUILTIN_TEMPLATE_NAME,
    subtitle: builtinTemplateSummary(),
    payload: builtinTemplateConfig(),
  }));
  ipcMain.handle(
    "dialogue:saveSettings",
    (_e, s: Parameters<typeof settings.saveSettings>[0]) => settings.saveSettings(s)
  );

  /*
   * 「AI 服务」设置页的两个小工具：
   *   ai:listModels — 拉模型列表（OpenAI 兼容网关都有 /models）
   *   ai:test      — 发一条最小 chat 请求，验证地址/key/模型名三件套
   * 都只读传入的这份配置：用户在表单里改完还没"保存"也能先试，不用先落盘。
   */
  ipcMain.handle("ai:listModels", (_e, s: { apiKey: string; baseUrl: string; model: string }) =>
    listModels(s)
  );
  ipcMain.handle("ai:test", (_e, s: { apiKey: string; baseUrl: string; model: string }) => testChat(s));

  /*
   * 「对话模式」的 AI 写脚本：拿主题（可选参考文案）写成甲方/乙方双人对话。
   * 走的是工作台那一步同一套实现（agent/script-writer.ts），两条路出来的格式一致。
   */
  ipcMain.handle(
    "dialogue:writeScript",
    (_e, req: { topic: string; transcript?: string; durationSeconds?: number }): Promise<string> =>
      writeDialogueScript(req)
  );

  ipcMain.handle("dialogue:chooseImage", async (e, currentPath: string | null) => {
    const win = BrowserWindow.fromWebContents(e.sender) ?? BrowserWindow.getFocusedWindow();
    const res = await dialog.showOpenDialog(win!, {
      title: "选择人物图片",
      defaultPath: currentPath ?? undefined,
      filters: [{ name: "图片", extensions: ["jpg", "jpeg", "png", "webp", "bmp"] }],
      properties: ["openFile"],
    });
    if (res.canceled || !res.filePaths.length) return null;
    return res.filePaths[0];
  });

  ipcMain.handle("dialogue:chooseOutputDir", async (e, currentPath: string | null) => {
    const win = BrowserWindow.fromWebContents(e.sender) ?? BrowserWindow.getFocusedWindow();
    const res = await dialog.showOpenDialog(win!, {
      title: "选择输出目录",
      defaultPath: currentPath ?? undefined,
      properties: ["openDirectory", "createDirectory"],
    });
    if (res.canceled || !res.filePaths.length) return null;
    return res.filePaths[0];
  });

  ipcMain.handle("dialogue:defaultOutputDir", () => defaultOutputDir());

  /* ---------------- 文字卡视频（文案 → 卡片图 → 成片） ---------------- */
  ipcMain.handle(
    "textcard:render",
    async (e, req: TextCardRequest): Promise<TextCardResult> => {
      const wc = e.sender;
      return await runTextCard(req, (p) => {
        try {
          if (!wc.isDestroyed()) wc.send("textcard:progress", p);
        } catch {
          /* 页面已经关了，进度发不出去不影响出片 */
        }
      });
    }
  );

  ipcMain.handle("textcard:cancel", (_e, requestId: string) => cancelTextCard(requestId));

  ipcMain.handle("textcard:openDir", async (): Promise<{ ok: boolean; path: string; error?: string }> => {
    const dir = textCardOutputDir();
    const err = await shell.openPath(dir);
    return err ? { ok: false, path: dir, error: err } : { ok: true, path: dir };
  });

  ipcMain.handle(
    "dialogue:openOutputDir",
    async (): Promise<{ ok: boolean; path: string; error?: string }> => {
      const appSet = settings.getAppSettings();
      const dir = appSet.outputDir || defaultOutputDir();
      fs.mkdirSync(dir, { recursive: true });
      // 优先打开 video 子目录（最终 mp4 所在位置），不存在则打开根目录
      const videoDir = path.join(dir, "video");
      const target = fs.existsSync(videoDir) ? videoDir : dir;
      const err = await shell.openPath(target);
      return err ? { ok: false, path: target, error: err } : { ok: true, path: target };
    }
  );

  ipcMain.handle(
    "dialogue:showInFolder",
    async (_e, filePath: string): Promise<{ ok: boolean; error?: string }> => {
      if (!filePath || !fs.existsSync(filePath)) {
        return { ok: false, error: "文件不存在或已被移动。" };
      }
      shell.showItemInFolder(filePath);
      return { ok: true };
    }
  );

  ipcMain.handle("settings:getApp", () => settings.getAppSettings());
  ipcMain.handle(
    "settings:updateApp",
    (_e, patch: Partial<AppSettings>) => settings.updateAppSettings(patch)
  );

  ipcMain.handle("dialogue:runCompose", async (e, req: ComposeRequest) => {
    return await runCompose({ ...req, webContents: e.sender });
  });

  /*
   * 真人解说：把渲染层录好的音频（ArrayBuffer）落盘，返回 { 路径, 时长秒 }。
   * 时长在主进程用 ffmpeg 探测（<audio> 读 MediaRecorder 的 webm 时长是 Infinity，
   * 渲染层拿不到），随保存一起回给界面，录完立刻能显示。
   * 存到输出目录下的 recordings/ 子目录（跟成片同根，用户好找、也避开临时区被清）。
   * 文件名带时间戳 + 随机后缀，重录不覆盖旧文件（旧文件由清除动作删）。
   *
   * MediaRecorder 出的是 webm/opus：容器时长字段是 Infinity（ffprobe 读不到秒数），
   * 而且合成链路的音频拼接是 `-c copy`，混不了 webm 和 mp3/wav——成片就成了没声音。
   * 所以这里落盘时直接转码成 mp3（24k 单声道，与在线音色同格式），下游全部走现成路径。
   */
  ipcMain.handle(
    "dialogue:saveRecording",
    async (_e, buf: ArrayBuffer): Promise<{ path: string; durationSec: number }> => {
      const bytes = Buffer.from(buf);
      if (!bytes.length) throw new Error("录音数据为空。");
      const dir = path.join(settings.getAppSettings().outputDir || defaultOutputDir(), "recordings");
      fs.mkdirSync(dir, { recursive: true });
      const stamp =
        new Date().toISOString().replace(/[-:T.Z]/g, "").slice(0, 14) +
        "-" +
        Math.floor(Math.random() * 100000);
      const rawFile = path.join(dir, `rec-${stamp}.webm`);
      const file = path.join(dir, `rec-${stamp}.mp3`);
      fs.writeFileSync(rawFile, bytes);
      try {
        const res = await runFfmpeg(
          ["-y", "-i", rawFile, "-c:a", "libmp3lame", "-b:a", "64k", "-ar", "24000", "-ac", "1", file],
          { timeoutMs: 60_000 }
        );
        if (res.code !== 0 || !fs.existsSync(file) || fs.statSync(file).size === 0) {
          throw new Error(res.stderr.split("\n").slice(-3).join(" "));
        }
        fs.rmSync(rawFile, { force: true });
        return { path: file, durationSec: await probeAudioDuration(file) };
      } catch (e) {
        // 转码失败：保底返回原始 webm（试听还能用，只是合成会报错，比丢录音强）
        try { fs.rmSync(file, { force: true }); } catch {}
        console.warn("[recording] 转码 mp3 失败，保留 webm：", e instanceof Error ? e.message : e);
        return { path: rawFile, durationSec: 0 };
      }
    }
  );

  /** 删除一份录音文件（重录/清除时回收磁盘；路径不在 recordings 下则不动，防误删） */
  ipcMain.handle("dialogue:deleteRecording", async (_e, filePath: string): Promise<void> => {
    if (!filePath) return;
    const recRoot = path.join(
      settings.getAppSettings().outputDir || defaultOutputDir(),
      "recordings"
    );
    const abs = path.resolve(filePath);
    if (!abs.startsWith(path.resolve(recRoot))) return;
    try {
      fs.rmSync(abs, { force: true });
    } catch {
      /* 文件已被清理/占用：忽略，界面状态会自己纠正 */
    }
  });

  /** 探测录音时长（秒），读不出返回 0：给「保存时没记时长的老录音」兜底显示 */
  ipcMain.handle("dialogue:audioDuration", async (_e, filePath: string): Promise<number> => {
    if (!filePath || !fs.existsSync(filePath)) return 0;
    try {
      const res = await runFfmpeg(["-hide_banner", "-i", filePath], { timeoutMs: 15_000 });
      const m = /Duration:\s*(\d+):(\d+):(\d+\.\d+)/.exec(res.stderr);
      return m ? Math.round(+m[1] * 3600 + +m[2] * 60 + +m[3]) : 0;
    } catch {
      return 0;
    }
  });

  /*
   * 真人解说「生成字幕」：把录音丢给本地 Whisper 识别出解说词。
   * 故意不传 webContents/requestId —— 不广播进度，免得串到「语音识别」页的 UI 上；
   * 录音条自己显示「识别中…」就够了。
   * 模型没下载时直接报错让用户先去下载，而不是在这里静默下载几分钟（这条通道没有进度）。
   */
  ipcMain.handle(
    "dialogue:transcribeAudio",
    async (_e, filePath: string): Promise<TranscribeResult> => {
      if (!filePath || !fs.existsSync(filePath)) throw new Error("录音文件不存在，请先录一段。");
      if (!isModelReady()) {
        throw new Error(
          "语音识别模型还没下载：先到「语音处理 → 语音识别」下载模型（约 150MB），再回来生成字幕。"
        );
      }
      return await transcribeVideo({ videoPath: filePath });
    }
  );

  ipcMain.handle("dialogue:cancelCompose", (_e, requestId: string) => {
    cancelCompose(requestId);
  });

  /**
   * 补一次合成的现状：界面切任务卡 / 切页会卸载重挂，光靠广播会错过之前的进度，
   * 表现为「后台还在合成，界面上却什么都没有」（成片路径也会一起丢）。
   */
  ipcMain.handle("dialogue:composeState", () => getComposeSnapshot());

  ipcMain.handle(
    "dialogue:previewVoice",
    async (
      _e,
      req: { voice: string; rate?: number; pitch?: number; volume?: number; text?: string }
    ): Promise<{ path: string }> => {
      if (!req.voice) throw new Error("未选择音色。");
      const base = path.join(app.getPath("userData"), "dialogue-output", "preview");
      fs.mkdirSync(base, { recursive: true });
      // 每次试听用独立子目录，避免上次播放还锁着文件时复写同名 line_000.mp3
      const dir = path.join(base, `p-${Date.now()}-${Math.floor(Math.random() * 10000)}`);
      fs.mkdirSync(dir, { recursive: true });
      const cloneId = cloneIdFromVoice(req.voice);
      let result: { path: string } | null = null;
      if (cloneId) {
        // 克隆音色走本地 Genie 服务；语速/音调/音量由模型决定，不支持调整
        result = await synthCloneSingle({
          voice: findCloneVoice(cloneId),
          text: req.text?.trim() || PREVIEW_TEXT,
          outputDir: dir,
          timeoutMs: 90_000,
        });
      } else {
        // 试听要快：短超时 + 少量重试，坏音色几秒内就能反馈，不用等 90 秒
        const engine = new TtsEngine({
          outputDir: dir,
          betweenDelayMs: 0,
          timeoutMs: 10_000,
          maxRetries: 1,
        });
        result = await engine.generateSingle({
          index: 0,
          text: req.text?.trim() || PREVIEW_TEXT,
          voice: req.voice,
          rate: prosodyPercent(req.rate ?? 0),
          pitch: prosodyPercent(req.pitch ?? 0),
          volume: prosodyPercent(req.volume ?? 0),
        });
      }
      if (!result) throw new Error("试听合成失败，请稍后重试。");
      // 清理旧试听目录，只留最新一个
      try {
        for (const d of fs.readdirSync(base)) {
          const full = path.join(base, d);
          if (full !== dir) {
            try {
              fs.rmSync(full, { recursive: true, force: true });
            } catch {
              /* 被占用时留到下次清理 */
            }
          }
        }
      } catch {
        /* 清理失败不影响试听 */
      }
      return { path: result.path };
    }
  );

  // -----------------------------------------------------------------
  // 语音工具（语音合成 / 语音识别）
  // -----------------------------------------------------------------

  /** 文本 → Edge TTS 语音，返回生成的 mp3 路径（每次独立目录，保留最新一次） */
  ipcMain.handle(
    "voice:synth",
    async (
      _e,
      req: { text: string; voice: string; rate?: number; pitch?: number; volume?: number }
    ): Promise<{ path: string }> => {
      const text = req?.text?.trim();
      if (!text) throw new Error("请输入要合成的文本。");
      if (!req.voice) throw new Error("请选择音色。");

      const base = path.join(app.getPath("userData"), "voice-output");
      fs.mkdirSync(base, { recursive: true });
      // 每次合成用独立子目录，避免上次播放还锁着文件时复写失败
      const dir = path.join(base, `s-${Date.now()}-${Math.floor(Math.random() * 10000)}`);
      fs.mkdirSync(dir, { recursive: true });

      const cloneId = cloneIdFromVoice(req.voice);
      let result: { path: string } | null = null;
      if (cloneId) {
        // 克隆音色：本地 Genie-TTS（语速/音调/音量由模型决定，不支持调整）
        result = await synthCloneSingle({
          voice: findCloneVoice(cloneId),
          text,
          outputDir: dir,
        });
      } else {
        const engine = new TtsEngine({
          outputDir: dir,
          betweenDelayMs: 0,
          timeoutMs: 30_000,
          maxRetries: 2,
        });
        result = await engine.generateSingle({
          index: 0,
          text,
          voice: req.voice,
          rate: prosodyPercent(req.rate ?? 0),
          pitch: prosodyPercent(req.pitch ?? 0),
          volume: prosodyPercent(req.volume ?? 0),
        });
      }
      if (!result) throw new Error("语音合成失败，请稍后重试。");

      // 清理旧合成目录，只留最新一个
      try {
        for (const d of fs.readdirSync(base)) {
          const full = path.join(base, d);
          if (full !== dir) {
            try {
              fs.rmSync(full, { recursive: true, force: true });
            } catch {
              /* 被占用时留到下次清理 */
            }
          }
        }
      } catch {
        /* 清理失败不影响合成结果 */
      }
      return { path: result.path };
    }
  );

  // -----------------------------------------------------------------
  // 本地声音克隆（Genie-TTS 服务）
  // -----------------------------------------------------------------

  /**
   * 把后台任务的进度/结局广播给**所有窗口**。
   *
   * 下载是后台任务，界面可能已经切到别的页面（甚至另一个窗口），
   * 只发给发起方会让"切页面回来"看不到进度；界面以主进程状态为准（task/env）即可恢复。
   */
  const broadcastLocalTtsProgress = (p: LocalTtsProgress): void => {
    for (const w of BrowserWindow.getAllWindows()) {
      if (!w.isDestroyed()) w.webContents.send("local-tts:progress", p);
    }
  };
  const broadcastLocalTtsResult = (r: LocalTtsTaskResult): void => {
    for (const w of BrowserWindow.getAllWindows()) {
      if (!w.isDestroyed()) w.webContents.send("local-tts:taskDone", r);
    }
  };

  /** 检测本地语音服务是否在线 */
  ipcMain.handle("local-tts:status", async (): Promise<LocalTtsStatus> => {
    const engine = new GenieTtsEngine({ baseUrl: localTtsBaseUrl(), timeoutMs: 4_000 });
    try {
      return (await engine.ping())
        ? { online: true }
        : {
            online: false,
            error: "本地语音服务未启动，请到「设置 → 声音克隆」点「启动服务」后再试。",
          };
    } catch (e) {
      return { online: false, error: String(e) };
    }
  });

  /** 环境信息：Python / genie-tts / 模型 / 服务状态（要起子进程探测，别高频调） */
  ipcMain.handle("local-tts:env", async (): Promise<LocalTtsEnv> => genieManager.env());

  /**
   * 诊断日志位置（「关于」页展示用）。
   * 路径可能带中文用户名，这里只报真实路径、不做包装。
   */
  ipcMain.handle("app:logInfo", (): { dir: string; file: string } => ({
    dir: genieRootDir(),
    file: genieLogFile(),
  }));

  /**
   * 打开日志所在目录（并选中日志文件本身）。
   * 文件还不存在时只打开目录——首次使用前不会生成这个日志，不该报错。
   */
  ipcMain.handle("app:openLogDir", async (): Promise<{ ok: boolean; error?: string }> => {
    const file = genieLogFile();
    try {
      if (fs.existsSync(file)) {
        shell.showItemInFolder(file);
        return { ok: true };
      }
      fs.mkdirSync(genieRootDir(), { recursive: true });
      const err = await shell.openPath(genieRootDir());
      return err ? { ok: false, error: err } : { ok: true };
    } catch (e: any) {
      return { ok: false, error: String(e?.message ?? e) };
    }
  });

  /** 后台任务快照：只读内存状态，界面轮询用（任何页面都能显示进度） */
  ipcMain.handle("local-tts:task", (): LocalTtsTaskSnapshot => genieManager.task());

  /** 一键启用：装依赖（如缺）→ 下载模型（如缺）→ 启动服务 */
  ipcMain.handle(
    "local-tts:enable",
    async (e): Promise<LocalTtsEnv> => {
      const send = (p: LocalTtsProgress) => e.sender.send("local-tts:progress", p);
      await genieManager.enable(send);
      return genieManager.env();
    }
  );

  /**
   * 后台下载：装依赖（如缺）→ 下载模型（如缺），**不启动服务**。
   *
   * 立即受理并返回（不再 await 到下载结束）：任务由主进程持有，进度走广播，
   * 结局走 `local-tts:taskDone`。这样用户可以随时切页面、去干别的，
   * 下载照常进行——之前 IPC 一直挂着，界面只能干等。
   */
  ipcMain.handle("local-tts:download", (_e, characterKey?: string): void => {
    genieManager.startDownloadInBackground(
      broadcastLocalTtsProgress,
      characterKey ?? "feibi",
      broadcastLocalTtsResult
    );
  });

  /** 取消模型下载（清掉半成品） */
  ipcMain.handle("local-tts:cancelDownload", async (): Promise<void> => {
    await genieManager.cancelDownload();
  });

  /** 删除已下载的角色模型 */
  ipcMain.handle("local-tts:deleteModel", async (_e, key: string): Promise<LocalTtsEnv> => {
    await genieManager.deleteModel(key);
    return genieManager.env();
  });

  /** 独立启动：模型就绪后只启动服务，不自动下载 */
  ipcMain.handle(
    "local-tts:start",
    async (e): Promise<LocalTtsEnv> => {
      const send = (p: LocalTtsProgress) => e.sender.send("local-tts:progress", p);
      await genieManager.start(send);
      return genieManager.env();
    }
  );

  /** 停用：停止并结束子进程，释放资源 */
  ipcMain.handle("local-tts:disable", async (): Promise<LocalTtsEnv> => {
    await genieManager.disable();
    return genieManager.env();
  });

  /** 选择参考音频（wav/flac/ogg/aiff，Genie 支持格式） */
  ipcMain.handle("local-tts:chooseAudio", async (e): Promise<string | null> => {
    const win = BrowserWindow.fromWebContents(e.sender) ?? BrowserWindow.getFocusedWindow();
    const res = await dialog.showOpenDialog(win!, {
      title: "选择参考音频（3~10 秒的清晰人声）",
      filters: [
        {
          name: "音频（m4a/mp3 等会自动转成 wav）",
          extensions: ["wav", "flac", "ogg", "aiff", "aif", "mp3", "m4a", "aac", "wma"],
        },
        { name: "全部文件", extensions: ["*"] },
      ],
      properties: ["openFile"],
    });
    if (res.canceled || !res.filePaths.length) return null;
    // m4a / mp3 这种 Genie 读不了的格式，先转成 wav 再交给克隆流程
    return await prepareReferenceAudio(res.filePaths[0]);
  });

  /** 新增/更新克隆音色（有 id 则按 id 更新，无 id 则新增）；返回最新列表 */
  ipcMain.handle(
    "local-tts:save",
    (
      _e,
      v: Pick<CloneVoice, "name" | "modelDir" | "audioPath" | "audioText" | "language"> & {
        id?: string;
      }
    ): CloneVoice[] => {
      const name = v.name?.trim();
      if (!name) throw new Error("请给克隆音色起个名字。");
      if (Array.from(name).length > 20) throw new Error("音色名称不能超过 20 个字。");
      if (!v.modelDir?.trim()) throw new Error("请选择模型目录。");
      if (!v.audioPath?.trim()) throw new Error("请选择参考音频。");
      const cur = settings.getAppSettings();
      const existing = (cur.cloneVoices ?? []).find((x) => x.id === v.id);
      const next: CloneVoice[] = existing
        ? (cur.cloneVoices ?? []).map((x) =>
            x.id === v.id
              ? {
                  ...x,
                  name,
                  modelDir: v.modelDir.trim(),
                  audioPath: v.audioPath.trim(),
                  audioText: (v.audioText ?? "").trim(),
                  language: v.language || "zh",
                }
              : x
          )
        : [
            ...(cur.cloneVoices ?? []),
            {
              id: randomUUID(),
              name,
              modelDir: v.modelDir.trim(),
              audioPath: v.audioPath.trim(),
              audioText: (v.audioText ?? "").trim(),
              language: v.language || "zh",
              createdAt: Date.now(),
            } satisfies CloneVoice,
          ];
      settings.updateAppSettings({ cloneVoices: next });
      return next;
    }
  );

  /** 删除克隆音色；返回最新列表 */
  ipcMain.handle("local-tts:delete", (_e, id: string): CloneVoice[] => {
    const cur = settings.getAppSettings();
    const next = (cur.cloneVoices ?? []).filter((v) => v.id !== id);
    settings.updateAppSettings({ cloneVoices: next });
    return next;
  });

  /** 用未保存的表单数据试听（用于设置页「试听」按钮） */
  ipcMain.handle(
    "local-tts:preview",
    async (_e, req: { voice: CloneVoice; text?: string }): Promise<{ path: string }> => {
      const v = req.voice;
      if (!v.modelDir?.trim()) throw new Error("请先选择模型目录。");
      if (!v.audioPath?.trim()) throw new Error("请先选择参考音频。");
      const base = path.join(app.getPath("userData"), "local-tts-preview");
      fs.mkdirSync(base, { recursive: true });
      const dir = path.join(base, `p-${Date.now()}-${Math.floor(Math.random() * 10000)}`);
      fs.mkdirSync(dir, { recursive: true });
      const result = await synthCloneSingle({
        voice: { ...v, id: `preview-${Date.now()}` },
        text: req.text?.trim() || PREVIEW_TEXT,
        outputDir: dir,
        timeoutMs: 90_000,
      });
      try {
        for (const d of fs.readdirSync(base)) {
          const full = path.join(base, d);
          if (full !== dir) {
            try {
              fs.rmSync(full, { recursive: true, force: true });
            } catch {
              /* 被占用时留到下次清理 */
            }
          }
        }
      } catch {
        /* 清理失败不影响试听 */
      }
      return { path: result.path };
    }
  );

  /** 把合成好的 mp3 另存到用户选择的位置 */
  ipcMain.handle(
    "voice:saveMp3",
    async (e, srcPath: string): Promise<string | null> => {
      if (!srcPath || !fs.existsSync(srcPath)) throw new Error("音频文件不存在或已被删除。");
      const isWav = path.extname(srcPath).toLowerCase() === ".wav";
      const win = BrowserWindow.fromWebContents(e.sender) ?? BrowserWindow.getFocusedWindow();
      const res = await dialog.showSaveDialog(win!, {
        title: "保存语音",
        defaultPath: `语音合成-${new Date().toISOString().slice(0, 10)}.${isWav ? "wav" : "mp3"}`,
        filters: isWav
          ? [{ name: "WAV 音频", extensions: ["wav"] }]
          : [{ name: "MP3 音频", extensions: ["mp3"] }],
      });
      if (res.canceled || !res.filePath) return null;
      const ext = isWav ? ".wav" : ".mp3";
      const dest = res.filePath.toLowerCase().endsWith(ext) ? res.filePath : res.filePath + ext;
      fs.copyFileSync(srcPath, dest);
      return dest;
    }
  );


  /** 语音识别：选择本地音频/视频文件 */
  ipcMain.handle("asr:chooseFile", async (e): Promise<string | null> => {
    const win = BrowserWindow.fromWebContents(e.sender) ?? BrowserWindow.getFocusedWindow();
    const res = await dialog.showOpenDialog(win!, {
      title: "选择音频 / 视频文件",
      filters: [
        {
          name: "音视频文件",
          extensions: [
            "mp4", "webm", "mov", "mkv", "avi", "flv",
            "mp3", "wav", "m4a", "aac", "flac", "ogg", "wma",
          ],
        },
      ],
      properties: ["openFile"],
    });
    if (res.canceled || !res.filePaths.length) return null;
    return res.filePaths[0];
  });

  /** 把识别文本保存为 txt */
  ipcMain.handle(
    "asr:saveText",
    async (e, params: { text: string }): Promise<string | null> => {
      const win = BrowserWindow.fromWebContents(e.sender) ?? BrowserWindow.getFocusedWindow();
      const res = await dialog.showSaveDialog(win!, {
        title: "保存识别文本",
        defaultPath: `语音识别-${new Date().toISOString().slice(0, 10)}.txt`,
        filters: [{ name: "文本文件", extensions: ["txt"] }],
      });
      if (res.canceled || !res.filePath) return null;
      const dest = res.filePath.toLowerCase().endsWith(".txt")
        ? res.filePath
        : res.filePath + ".txt";
      fs.writeFileSync(dest, params.text ?? "", "utf-8");
      return dest;
    }
  );

  // -----------------------------------------------------------------
  // v0.5.0 热点成片（热点榜 + AI 分镜 + 草稿工作台）
  // -----------------------------------------------------------------

  ipcMain.handle("hot:sources", () => getHotSources());

  ipcMain.handle("hot:list", (_e, source: string) => getHotList(source));

  const storyAbortControllers = new Map<string, AbortController>();

  ipcMain.handle("story:generate", async (e, req: StoryGenerateRequest) => {
    const requestId = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    const send = (phase: "thinking" | "writing" | "done" | "error", message: string) => {
      e.sender.send("story:progress", { phase, message, requestId });
    };
    const ac = new AbortController();
    storyAbortControllers.set(requestId, ac);
    try {
      const draft = await generateAiDraft(req, send, ac.signal);
      return storyStore.createStoryboard(draft, req.hot ?? null, req.resolution);
    } finally {
      storyAbortControllers.delete(requestId);
    }
  });

  /** 渲染层「中止」：按 requestId 取消正在跑的分镜生成 */
  ipcMain.handle("story:cancelGenerate", (_e, requestId: string) => {
    storyAbortControllers.get(requestId)?.abort();
    storyAbortControllers.delete(requestId);
  });

  ipcMain.handle(
    "story:regeneratePrompt",
    async (_e, req: { boardId: string; shotId: string }) => {
      const sb = storyStore.getStoryboard(req.boardId);
      const shot = sb.shots.find((s) => s.id === req.shotId);
      if (!shot) throw new Error("镜头不存在，请刷新后重试。");
      if (!shot.caption.trim()) throw new Error("请先填写这段旁白，AI 才知道要生成什么画面。");
      const resolution = sb.resolution ?? "portrait";
      const aspect = resolution === "landscape" ? "横屏 16:9" : "竖屏 9:16";
      const { imagePrompt } = await regenerateShotPrompt(
        sb.title,
        sb.style,
        shot.caption,
        resolution
      );
      const styleTail = sb.style.trim()
        ? `，${aspect}，无文字无水印，${sb.style.trim()}`
        : `，${aspect}，无文字无水印`;
      shot.imagePrompt = imagePrompt.includes(sb.style.trim()) && sb.style.trim()
        ? imagePrompt
        : imagePrompt.replace(/[，。\s]+$/, "") + styleTail;
      return storyStore.saveStoryboard(sb);
    }
  );

  ipcMain.handle("story:list", (): StoryboardSummary[] => storyStore.listStoryboards());

  ipcMain.handle("story:get", (_e, id: string): Storyboard => storyStore.getStoryboard(id));

  ipcMain.handle("story:save", (_e, sb: Storyboard): Storyboard => storyStore.saveStoryboard(sb));

  ipcMain.handle("story:delete", (_e, id: string): void => storyStore.deleteStoryboard(id));

  /*
   * 作品记录（图文解说 / 对话模式 / 爆款嗅探 的左侧历史列表）。
   * 分镜那套有自己的 store（story:*），这里是通用的那一种。
   */
  ipcMain.handle("records:list", (_e, kind: WorkRecordKind): WorkRecordSummary[] =>
    recordsStore.listRecords(kind)
  );

  ipcMain.handle("records:get", (_e, req: { kind: WorkRecordKind; id: string }): WorkRecord | null =>
    recordsStore.getRecord(req.kind, req.id)
  );

  ipcMain.handle("records:save", (_e, req: WorkRecordSaveRequest): WorkRecord =>
    recordsStore.saveRecord(req)
  );

  ipcMain.handle("records:remove", (_e, req: { kind: WorkRecordKind; id: string }): void =>
    recordsStore.removeRecord(req.kind, req.id)
  );

  ipcMain.handle("story:chooseImage", async (e, currentPath: string | null) => {
    const win = BrowserWindow.fromWebContents(e.sender) ?? BrowserWindow.getFocusedWindow();
    const res = await dialog.showOpenDialog(win!, {
      title: "选择豆包生成的图片",
      defaultPath: currentPath ?? undefined,
      filters: [{ name: "图片", extensions: ["jpg", "jpeg", "png", "webp", "bmp"] }],
      properties: ["openFile"],
    });
    if (res.canceled || !res.filePaths.length) return null;
    return res.filePaths[0];
  });

  ipcMain.handle(
    "story:attachImage",
    (_e, req: { boardId: string; shotId: string; srcPath: string }): Storyboard =>
      storyStore.attachShotImage(req.boardId, req.shotId, req.srcPath)
  );

  ipcMain.handle(
    "story:openDir",
    async (_e, id: string): Promise<{ ok: boolean; path: string; error?: string }> =>
      await storyStore.openStoryboardDir(id)
  );

  // -----------------------------------------------------------------
  // v1.0.0 内嵌豆包（铺满内容区的全屏面板）
  // -----------------------------------------------------------------

  /**
   * 批量生图（T-003）：队列跑在主进程，所以关抽屉、切页面都不会中断它。
   * 进度靠 doubao:batchProgress 广播，界面只负责显示。
   */
  ipcMain.handle("doubao:startBatch", async (e, req: { boardId: string }) => {
    if (getBatchState().running) {
      return { started: false, state: getBatchState(), error: "批量生图已经在跑了，请等它结束或先点「中止」。" };
    }
    // 单镜生图正在占用生成位时不开队列，否则两边会互相打断
    if (getGenerationGuardState().busy > 0) {
      return {
        started: false,
        state: getBatchState(),
        error: "有一张图正在生成，先等它结束，再点「批量生图」。",
      };
    }

    /*
     * 前置校验按引擎分：
     *   豆包 → 自动发送开着、页面准备好、已登录、当日没到量（都跟浏览器那套有关）；
     *   API 引擎 → 只要 Token 填了就能跑，没有浏览器也就没有登录态与页面准备。
     */
    if (currentImageProvider() === "doubao") {
      const win = BrowserWindow.fromWebContents(e.sender);
      if (!win) throw new Error("找不到窗口，请重试。");
      // 关掉「生图时自动发送」时批量不跑：批量没有手动挡（T-004）
      const autoSubmitBlocked = batchAutoSubmitBlocked(settings.isAutoSubmitImageEnabled());
      if (autoSubmitBlocked) {
        return { started: false, state: getBatchState(), error: autoSubmitBlocked };
      }
      // 先把页面准备好再排队（后台准备，不弹给用户看）；否则第一张会在没准备好的页面上白等一轮重试
      await ensureDoubaoReady(win, { silent: true });
      // 未登录：不排队，把人话原因交回界面，由界面把抽屉打开让用户扫码
      const login = await doubaoLoginBlocked();
      if (login) {
        return { started: false, state: getBatchState(), error: login.message, code: login.code };
      }
      // 当日用量到顶（自保闸门）
      const cap = doubaoDailyCapBlocked();
      if (cap) {
        return { started: false, state: getBatchState(), error: cap.message, code: cap.code };
      }
    } else {
      const blocked = imageProviderBlocked();
      if (blocked) {
        return { started: false, state: getBatchState(), error: blocked.message, code: blocked.code };
      }
    }

    setBatchEmitter((s) => {
      if (!e.sender.isDestroyed()) e.sender.send("doubao:batchProgress", s);
    });
    return startBatch(req.boardId);
  });

  ipcMain.handle("doubao:cancelBatch", () => cancelBatch());

  ipcMain.handle("doubao:batchState", () => getBatchState());

  /** 打开 / 关闭独立豆包窗口；打开时才创建窗口并发起网络请求 */
  ipcMain.handle("doubao:setVisible", (e, visible: boolean) => {
    const win = BrowserWindow.fromWebContents(e.sender);
    if (!win) return getDoubaoState();
    return setDoubaoVisible(win, !!visible);
  });

  ipcMain.handle("doubao:state", () => getDoubaoState());

  /** 给「工作台右下角登录入口」用的账号状态（没打开过页面就不联网、不猜） */
  ipcMain.handle("doubao:accountState", () => getDoubaoAccountState());

  /**
   * 自动把豆包的登录框叫出来（面板一打开就调）。
   * 未登录时点掉豆包的登录入口、弹出扫码框；已登录则是空操作。
   */
  ipcMain.handle("doubao:openLogin", () => openDoubaoLogin());

  ipcMain.handle("doubao:reload", () => reloadDoubao());

  /**
   * 一键生图：把提示词送进豆包 → 等它出图 → 存成该镜头的图。
   *
   * 生图要在豆包页面里跑，所以要求抽屉开着；抽屉被 KeepAlive 切走时视图仍在，
   * 照样能跑（这一点在 T-001 里已经改成「关闭不销毁」）。
   *
   * 返回结构化结果（T-004）：只填词 / 未登录 / 改版 / 抓图失败各有 code，
   * 界面据此显示不同的引导与兜底按钮；失败不再以异常形式跨进程传（属性会丢）。
   */
  ipcMain.handle(
    "doubao:generateForShot",
    async (
      e,
      req: { boardId: string; shotId: string; autoSubmit?: boolean }
    ): Promise<GenerateShotOutcome> => {
      /*
       * 批量占着生成位时不接受单镜请求（界面也会把按钮压住，这里是第二道闸）。
       * 这道闸放在 ipc 而不是编排层：批量队列自己也要用编排层做「退回单发」，
       * 放在编排层会把队列自己的补发也拦掉。
       */
      if (getBatchState().running) {
        return {
          ok: false,
          board: null,
          code: "batch-running",
          message: "批量生图正在进行，先等它跑完或点「中止」，再单独生成这一镜。",
        };
      }

      /*
       * 前置校验按引擎分：豆包那一套（窗口/页面就绪/登录态/当日用量）只对豆包成立；
       * API 引擎（ModelScope）的窗口无关，前置条件只有 Token。
       */
      if (currentImageProvider() === "doubao") {
        const win = BrowserWindow.fromWebContents(e.sender);
        if (!win) {
          return { ok: false, board: null, code: "no-window", message: "找不到窗口，请重试。" };
        }
        try {
          // 后台准备：页面活着但不弹给用户看（用户诉求：像调 API 一样无感）
          await ensureDoubaoReady(win, { silent: true });
        } catch (err) {
          return { ok: false, board: null, ...describeDoubaoFailure(err) };
        }
        // 未登录就先说清楚，别往下填词；界面收到这个 code 会把抽屉打开让用户扫码
        const login = await doubaoLoginBlocked();
        if (login) return { ok: false, board: null, ...login };
        // 当日用量到顶（自保闸门）
        const cap = doubaoDailyCapBlocked();
        if (cap) return { ok: false, board: null, ...cap };
      } else {
        const blocked = imageProviderBlocked();
        if (blocked) return { ok: false, board: null, ...blocked };
      }

      const send = (message: string) => {
        if (!e.sender.isDestroyed()) e.sender.send("doubao:genProgress", { shotId: req.shotId, message });
      };
      return await generateShotImage(req, send);
    }
  );

  /**
   * 当前生图引擎的状态：界面拿它显示「现在用的是哪个引擎、能不能开跑」，
   * 免得渲染层再实现一遍判断（那份判断必须和主进程分派逻辑一致）。
   */
  ipcMain.handle("image:providerInfo", () => imageProviderInfo());

  // -----------------------------------------------------------------
  // v0.6.0 爆款嗅探（链接 → 转写 → 拆解，一次性，不落盘记录）
  // -----------------------------------------------------------------

  ipcMain.handle("sniff:run", (e, req: SniffRunRequest) =>
    runSniff({
      link: req.link,
      niche: req.niche,
      requestId: req.requestId,
      webContents: e.sender,
    })
  );

  // -----------------------------------------------------------------
  // 工作台（agent 模式）：一句话 → 任务卡 → 逐步执行
  // 设计见 doc/Agent化改造-产品形态设计.md
  // -----------------------------------------------------------------

  /** 把某一步及其下游打回「未开始」：上游变了，它们的结果就不算数了 */
  function resetFrom(task: AgentTask, stepId: string): void {
    const idx = task.steps.findIndex((s) => s.id === stepId);
    if (idx < 0) return;
    for (let i = idx; i < task.steps.length; i++) {
      const s = task.steps[i];
      s.status = "pending";
      s.note = undefined;
      s.outputPath = undefined;
      s.error = undefined;
    }
  }

  /** 一句话 → 任务卡（认不出来的只回话，task 为 null）。规则拿不准时会问一次模型，所以是异步 */
  ipcMain.handle(
    "agent:create",
    async (_e, instruction: string, hot?: HotItem): Promise<AgentCreateResult> =>
      createTaskSmart(instruction, hot)
  );

  ipcMain.handle("agent:list", (): AgentTask[] => listTasks());
  ipcMain.handle("agent:get", (_e, id: string): AgentTask | null => getTask(id));

  ipcMain.handle("agent:remove", (_e, id: string): void => {
    cancelTask(id);
    /*
     * 删除时立刻让出"占用位"：abort 只是信号，跑着的 await 要等它自己抛出才结束；
     * 不在这清掉的话，接下来开新任务会被"已经有一个任务在跑"挡住（任务都已经删了）。
     */
    forceRelease(id);
    removeTask(id);
  });

  /* ---------- 会话：左栏一列现在是「一件事一条」，不再是「一句话一条」 ---------- */
  ipcMain.handle("conv:list", (): ConversationSummary[] => listConversations());
  ipcMain.handle("conv:get", (_e, id: string): Conversation | null => getConversation(id));
  ipcMain.handle("conv:create", (_e, seed?: string): Conversation => createConversation(seed ?? ""));
  /** 任务卡属于哪条会话（老入口按任务 id 找会话时用） */
  ipcMain.handle("conv:ofTask", (_e, taskId: string): Conversation | null => conversationOfTask(taskId));
  ipcMain.handle(
    "conv:append",
    (
      _e,
      req: {
        convId: string;
        message: { role: "user" | "assistant"; text: string; images?: string[]; taskId?: string };
      }
    ): Conversation | null => appendMessage(req.convId, req.message)
  );
  ipcMain.handle("conv:bindTask", (_e, req: { convId: string; taskId: string }): Conversation | null =>
    bindTask(req.convId, req.taskId)
  );
  ipcMain.handle("conv:rename", (_e, req: { convId: string; title: string }): Conversation | null =>
    renameConversation(req.convId, req.title)
  );
  /** 删会话 = 删这件事：连同它产出的任务卡一起收掉，不留半张卡在硬盘里 */
  ipcMain.handle("conv:remove", (_e, id: string): void => {
    const conv = getConversation(id);
    if (conv) {
      for (const taskId of conv.taskIds) {
        cancelTask(taskId);
        forceRelease(taskId);
        removeTask(taskId);
      }
    }
    removeConversation(id);
  });

  /** 改步骤参数：改完这一步和后面都回到未开始 */
  ipcMain.handle(
    "agent:updateParams",
    (_e, req: { taskId: string; stepId: string; params: Array<{ key: string; value: string }> }): AgentTask => {
      const task = getTask(req.taskId);
      if (!task) throw new Error("任务不存在。");
      const step = task.steps.find((s) => s.id === req.stepId);
      if (!step) throw new Error("步骤不存在。");
      for (const patch of req.params) {
        const target = step.params?.find((p) => p.key === patch.key);
        if (target) target.value = patch.value;
      }
      resetFrom(task, step.id);
      task.status = "draft";
      task.updatedAt = Date.now();
      return saveTask(task);
    }
  );

  /**
   * 记中间状态（目前只有分镜工作台用的 storyboardId）：
   * 任务卡内嵌的分镜工作台建好/打开/删除方案时把 id 写回任务，
   * 下次打开这张卡还能续上同一份方案。跟 updateParams 不同，这不打回步骤状态。
   */
  ipcMain.handle(
    "agent:patchState",
    (
      _e,
      req: {
        taskId: string;
        patch: {
          storyboardId?: string;
          hotRanAt?: number;
          /** 工作区卡（内嵌分镜工作台）跑完后把任务落成 done/failed（它不走 agent:run） */
          status?: AgentTask["status"];
        };
      }
    ): AgentTask => {
      const task = getTask(req.taskId);
      if (!task) throw new Error("任务不存在。");
      // status 是任务级字段，别混进 state 里
      const { status, ...statePatch } = req.patch;
      task.state = { ...(task.state ?? {}), ...statePatch };
      if (status) task.status = status;
      task.updatedAt = Date.now();
      return saveTask(task);
    }
  );

  /** 跑任务：不给 stepId 就是一路跑到底，给了就只重跑那一步 */
  ipcMain.handle(
    "agent:run",
    async (e, req: { taskId: string; stepId?: string }): Promise<AgentTask> =>
      await runTask(req.taskId, {
        stepId: req.stepId,
        webContents: e.sender,
        onProgress: (p) => {
          if (!e.sender.isDestroyed()) e.sender.send("agent:progress", p);
        },
      })
  );

  ipcMain.handle("agent:cancel", (_e, taskId: string): boolean => cancelTask(taskId));

  ipcMain.handle(
    "agent:chooseFile",
    async (e, req: { kind: "image" | "media"; currentPath?: string }): Promise<string | null> => {
      const win = BrowserWindow.fromWebContents(e.sender) ?? BrowserWindow.getFocusedWindow();
      const isImage = req.kind === "image";
      const res = await dialog.showOpenDialog(win!, {
        title: isImage ? "选择图片" : "选择音频或视频",
        defaultPath: req.currentPath || undefined,
        properties: ["openFile"],
        filters: isImage
          ? [{ name: "图片", extensions: ["png", "jpg", "jpeg", "webp", "bmp"] }]
          : [{ name: "音频/视频", extensions: ["mp3", "wav", "m4a", "flac", "aac", "mp4", "mov", "mkv", "avi"] }],
      });
      if (res.canceled || !res.filePaths.length) return null;
      return res.filePaths[0];
    }
  );

  /** 在工作台里点产物：直接在资源管理器里选中它 */
  ipcMain.handle("agent:openPath", (_e, p: string): void => {
    if (!p) return;
    const target = path.resolve(p);
    if (fs.existsSync(target)) shell.showItemInFolder(target);
  });

  // -----------------------------------------------------------------
  // 集成运行时（设置 → 运行时）：识别本机智能体 CLI，全局只应用一个
  // -----------------------------------------------------------------

  const RUNTIME_IDS: RuntimeId[] = ["codex", "claude", "gemini"];

  /** 界面上「运行时」页需要的一切（已应用 + 识别结果 + 技能） */
  function runtimeState(): RuntimeState {
    const app0 = settings.getAppSettings();
    const active = app0.runtime?.activeId ?? null;
    const activeId = active && RUNTIME_IDS.includes(active) ? active : null;
    const prefs = normalizePrefs(activeId ? app0.runtime?.prefs?.[activeId] : null);
    return {
      activeId,
      detected: cachedRuntimes(),
      skills: listSkills(),
      skillsDir: skillsDir(),
      detectedAt: detectedAt(),
      model: prefs.model,
      permission: prefs.permission,
    };
  }

  ipcMain.handle("runtime:state", (): RuntimeState => runtimeState());

  /**
   * 文案/分镜由谁写：应用了运行时就是它，没接运行时才回落到「AI 服务」。
   * 界面拿它决定提示语（别再劝用户去填 Key）和②区那行引擎说明。
   */
  ipcMain.handle("llm:route", () => llmRoute());

  /** 扫一遍本机（强制：用户点「识别 / 重新识别」才走这里） */
  ipcMain.handle("runtime:detect", async (): Promise<RuntimeState> => {
    await detectRuntimesCached(true);
    return runtimeState();
  });

  /**
   * 应用 / 取消应用。同一时间只有一个：写新的会直接覆盖旧的。
   * 传 null 只在"已应用的那个已经从本机卸载了"时用（界面上才会出现这颗按钮）。
   */
  ipcMain.handle("runtime:apply", async (_e, id: string | null): Promise<RuntimeState> => {
    if (id === null) {
      settings.updateAppSettings({ runtime: undefined });
      return runtimeState();
    }
    if (!RUNTIME_IDS.includes(id as RuntimeId)) throw new Error("不认识的运行时。");
    const info = (await detectRuntimesCached()).find((r) => r.id === id);
    if (!info) throw new Error("没识别到这个运行时，先点「重新识别」。");
    if (info.status !== "ready") {
      throw new Error(`这个运行时现在起不来：${info.note ?? "路径失效"}。`);
    }
    settings.updateAppSettings({
      runtime: { activeId: info.id, prefs: settings.getAppSettings().runtime?.prefs },
    });
    return runtimeState();
  });

  /**
   * 对话区底部那两颗选择器：模型 + 权限范围。
   * 只改**已应用**这个运行时的偏好，别的运行时那份原样留着（换回去还在）。
   */
  ipcMain.handle(
    "runtime:prefs",
    (_e, patch: { model?: string | null; permission?: RuntimePermissionId }): RuntimeState => {
      const cur = settings.getAppSettings().runtime;
      if (!cur?.activeId) throw new Error("还没应用运行时。");
      const id = cur.activeId;
      const prev = normalizePrefs(cur.prefs?.[id]);
      const next: RuntimePrefs = normalizePrefs({
        model: "model" in (patch ?? {}) ? (patch.model ?? null) : prev.model,
        permission: patch?.permission ?? prev.permission,
      });
      settings.updateAppSettings({
        runtime: { activeId: id, prefs: { ...(cur.prefs ?? {}), [id]: next } },
      });
      return runtimeState();
    }
  );

  /**
   * 模型清单：**现读 CLI 自己的配置**（codex 的目录文件 / claude 的 modelPicker），
   * 不在本地存账本 —— 账本是事实的副本，换网关当天就过期了。
   */
  ipcMain.handle(
    "runtime:models",
    async (_e, id?: string, force?: boolean): Promise<RuntimeModelList> => {
      const active = settings.getAppSettings().runtime?.activeId ?? null;
      const target = (id ?? active) as RuntimeId | null;
      if (!target || !RUNTIME_IDS.includes(target)) throw new Error("还没应用运行时。");
      return modelsFor(target, force === true);
    }
  );

  /** 打开技能目录（没有就建出来，用户往里丢 `技能名/SKILL.md` 即可） */
  ipcMain.handle("runtime:openSkillsDir", async (): Promise<void> => {
    const err = await shell.openPath(runtimeSkillsDir());
    if (err) throw new Error(err);
  });

  /** 对话区：把这一轮对话交给已应用的运行时，跑完回一条话（可能带一张建好的任务卡） */
  ipcMain.handle("runtime:chat", async (_e, req: { messages: RuntimeChatMessage[] }) =>
    chatWithRuntime(req.messages ?? [])
  );

}
