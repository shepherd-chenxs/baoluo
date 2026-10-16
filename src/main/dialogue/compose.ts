/*
 * SPDX-License-Identifier: GPL-3.0-only
 * Copyright (c) 2026 宝螺 / Baoluo contributors
 * 本文件属于「宝螺 / Baoluo」。除 GPL-3.0 外还适用 ADDITIONAL_TERMS.md 里的附加条款：
 * 分发时须保留来源署名；修改版对外分发时不得沿用「宝螺」名称与图标。
 */
/**
 * compose — 对外的"生成视频"入口。
 *
 * 串联 parser → tts → composer 三个阶段，
 * 通过回调 progressCb 推送进度给 IPC handler。
 */
import fs from "node:fs";
import path from "node:path";
import { app, type WebContents } from "electron";
import type {
  CloneVoice,
  ComposeProgress,
  ComposeRequest,
  ComposeSnapshot,
  MotionMode,
  VoiceProsody,
} from "../../shared/dialogue-types";
import { DialogueParser } from "./parser";
import { prosodyPercent, TtsEngine, type TtsResult, type TtsSegment } from "./tts";
import { runFfmpeg } from "./ffmpeg";
import { GenieTtsEngine, genieCharacterName } from "./genie";
import * as settings from "./settings";
import { VideoComposer, type ComposeSegment } from "./composer";
import { DEFAULT_LOCAL_TTS_HOST, DEFAULT_LOCAL_TTS_PORT } from "../../shared/settings-defaults";
import { describeFsError } from "../fsError";

interface ComposeRunArgs extends ComposeRequest {
  webContents: WebContents;
  requestId?: string;
}

/** 按 requestId 登记的中止控制器，供「取消生成」调用 */
const abortControllers = new Map<string, AbortController>();

export function cancelCompose(requestId: string): void {
  abortControllers.get(requestId)?.abort();
}

/**
 * 最近一次合成（在跑或刚跑完）的快照。
 *
 * 为什么主进程要记这个：合成的活儿在主进程跑（切页面、关抽屉都不中断），但进度和成片路径
 * 原先只留在渲染层组件的状态里。切换任务卡 / 切页会把组件卸载，回来就什么都不剩——
 * 界面上既看不出还在跑，也找不到刚合成好的片子（实测：片子已经生成好了，
 * 卡片上却连预览入口都没有）。界面重新挂载时靠这份快照认领自己那一次。
 *
 * 快照的形状定义在 shared（preload 要转给渲染层，而 preload 不能 import 主进程模块）。
 */
let lastCompose: ComposeSnapshot | null = null;

/** 给界面补一次现状用（同生图队列的 getBatchState） */
export function getComposeSnapshot(): ComposeSnapshot | null {
  return lastCompose ? { ...lastCompose } : null;
}

/** 本地语音服务的 baseUrl（设置里可改 host/port） */
function localTtsBaseUrl(): string {
  return `http://${DEFAULT_LOCAL_TTS_HOST}:${DEFAULT_LOCAL_TTS_PORT}`;
}

export async function runCompose(args: ComposeRunArgs): Promise<{ outputPath: string }> {
  const {
    mode = "dialogue",
    resolution,
    imageFit,
    motionMode,
    motionAmount,
    imageMotions,
    imageNarrators,
    motionA,
    motionB,
    script,
    imageFortune,
    imageCustomer,
    images,
    lineRecordings,
    outputDir,
    voiceFortune,
    voiceCustomer,
    voiceNarrator,
    narratorCount,
    prosody,
    subtitle,
    name,
    webContents,
    requestId,
    boardId,
  } = args;

  const controller = requestId ? new AbortController() : null;
  if (requestId && controller) abortControllers.set(requestId, controller);
  const signal = controller?.signal;

  const snapshotKey = requestId ?? "";
  const ownSnapshot = () => lastCompose !== null && lastCompose.requestId === snapshotKey;
  const startedAt = Date.now();
  lastCompose = {
    requestId: snapshotKey,
    boardId: boardId?.trim() || null,
    name,
    running: true,
    stage: "parse",
    percent: 0,
    message: "",
    outputPath: null,
    error: null,
    startedAt,
    updatedAt: startedAt,
  };

  const emit = (p: Omit<ComposeProgress, "requestId">) => {
    // 顺手把进度写进快照：界面切走再回来时要靠它把进度条接上
    if (ownSnapshot()) {
      lastCompose = {
        ...lastCompose!,
        stage: p.stage,
        percent: p.percent,
        message: p.message ?? "",
        currentLine: p.currentLine,
        totalLines: p.totalLines,
        ...(p.error ? { error: p.error } : {}),
        updatedAt: Date.now(),
      };
    }
    webContents.send("dialogue:progress", { ...p, requestId } satisfies ComposeProgress);
  };

  // 1. 把两种模式的输入统一成段：{ text, voice, imagePath }
  emit({ stage: "parse", percent: 0, message: "正在解析脚本..." });
  const narrator = voiceNarrator || voiceFortune;
  const narratorCount2 = narratorCount ?? 2;
  const voiceFor = (st: string): string =>
    st === "a" ? voiceFortune : st === "b" ? voiceCustomer : narrator;
  const prosodyFor = (st: string): VoiceProsody =>
    st === "a" ? prosody.a : st === "b" ? prosody.b : prosody.narrator;
  /** 图文解说按解说员数量取音色：1 个时全部用单个解说员，2 个时 A/B、无名字默认 A */
  const narrationVoice = (st: string): string => {
    if (narratorCount2 === 1) return narrator;
    return st === "a" ? voiceFortune : st === "b" ? voiceCustomer : voiceFortune;
  };
  const narrationProsody = (st: string): VoiceProsody => {
    if (narratorCount2 === 1) return prosody.narrator;
    return st === "a" ? prosody.a : st === "b" ? prosody.b : prosody.a;
  };
  const rawSegments: Array<{
    text: string;
    voice: string;
    imagePath: string;
    prosody: VoiceProsody;
    sceneId: number;
    motionMode?: MotionMode;
    motionAmount?: number;
    /** 真人解说：这一镜的录音文件；有它合成时直接用录音、跳过 TTS */
    audioPath?: string;
  }> = [];

  if (mode === "narration") {
    // 真人解说：录音模式却没图的镜头是配置失误——静默丢掉录音比报错更糟，直接说清楚
    const orphanAudio = (images ?? []).findIndex(
      (s) => s.audioMode === "record" && s.audioPath && !s.path
    );
    if (orphanAudio >= 0) {
      throw new Error(
        `镜头 ${orphanAudio + 1} 是录音模式但没有图片：请给它放一张图，或切回「语音合成」再合成。`
      );
    }
    let scenes = (images ?? []).filter((s) => s.path);
    // 兼容旧数据 A：只有一张图 + 一段脚本时按单场景处理
    if (!scenes.length && imageFortune && script.trim()) {
      scenes = [{ path: imageFortune, text: script }];
    }
    if (!scenes.length) throw new Error("请先添加至少一张图片。");

    // 兼容旧数据 B：每张图自带一段文本、脚本为空 → 按老格式逐图朗读
    const legacyPairMode = !script.trim() && scenes.some((s) => s.text.trim());
    if (legacyPairMode) {
      for (let si = 0; si < scenes.length; si++) {
        const sc = scenes[si];
        const imgMotion = imageMotions?.[si];
        // 分镜模式：这一镜的解说员若单独配了，就用它；否则回退全局音色
        const shotNarrator = imageNarrators?.[si];
        const texts = sc.text.split(/\r?\n/).map((s) => s.trim()).filter(Boolean);
        for (const t of texts) {
          rawSegments.push({
            text: t,
            voice: shotNarrator?.voice || narrator,
            imagePath: sc.path,
            prosody: shotNarrator?.prosody ?? prosody.narrator,
            sceneId: si,
            motionMode: imgMotion?.mode ?? motionMode,
            motionAmount: imgMotion?.amount ?? motionAmount,
          });
        }
      }
    } else {
      const lines = new DialogueParser().parse(script, { mode: "narration" });
      if (!lines.length) throw new Error("脚本为空，请输入解说词。");
      for (const l of lines) {
        if (!l.text.trim()) continue;
        let imgIdx = l.sceneId;
        if (imgIdx === undefined) {
          if (scenes.length === 1) imgIdx = 0;
          else {
            throw new Error(
              `第 ${l.index + 1} 行没有指定图片，请在解说词前加「图N」或「#图N」（当前共 ${scenes.length} 张图）。`
            );
          }
        }
        if (imgIdx < 0 || imgIdx >= scenes.length) {
          throw new Error(`图${imgIdx + 1} 不存在，图片列表里只有 ${scenes.length} 张。`);
        }
        const imgMotion = imageMotions?.[imgIdx];
        // 一镜一个解说员：配了就用它，没配才回退到「解说员数量 + 角色名」的老规则
        const shotNarrator = imageNarrators?.[imgIdx];
        rawSegments.push({
          text: l.text,
          voice: shotNarrator?.voice || narrationVoice(l.speakerType),
          imagePath: scenes[imgIdx].path,
          prosody: shotNarrator?.prosody ?? narrationProsody(l.speakerType),
          sceneId: imgIdx,
          motionMode: imgMotion?.mode ?? motionMode,
          motionAmount: imgMotion?.amount ?? motionAmount,
        });
      }
    }
    if (!rawSegments.length) throw new Error("解说文本为空。");

    /*
     * 真人解说 pass：这一镜是录音模式且有录音 → 该镜的所有行合并成一段（文本按换行拼接），
     * 带上 audioPath；合成时直接用录音（跳过 TTS），字幕按录音时长均分。
     * 语音合成模式的镜头原样走 TTS——允许一部分真人、一部分机器混着来。
     */
    const withAudio = new Map<number, string>();
    scenes.forEach((sc, si) => {
      if (sc.audioMode === "record" && sc.audioPath) withAudio.set(si, sc.audioPath);
    });
    if (withAudio.size) {
      const merged: typeof rawSegments = [];
      const consumed = new Set<number>();
      for (const seg of rawSegments) {
        const audio = withAudio.get(seg.sceneId);
        if (!audio) {
          merged.push(seg);
          continue;
        }
        if (consumed.has(seg.sceneId)) {
          // 这一镜已经并过一次：把文本续进那条
          const prev = merged.find((m) => m.sceneId === seg.sceneId && m.audioPath);
          if (prev) prev.text += "\n" + seg.text;
          continue;
        }
        consumed.add(seg.sceneId);
        merged.push({ ...seg, audioPath: audio });
      }
      rawSegments.length = 0;
      rawSegments.push(...merged);
    }
  } else {
    // dialogue：任意两个角色
    if (!imageFortune || !imageCustomer) throw new Error("请先选择两张图片。");
    const lines = new DialogueParser().parse(script);
    if (!lines.length) throw new Error("脚本为空或无法解析。");
    /*
     * 真人配音：按句录的文件。
     * 核对 text 再采用——录完又改了台词的话，旧录音配到新台词上会"声不对词"，
     * 这种情况宁可这一句回退合成音（界面也会把它标成"需重录"）。
     */
    const recByIndex = new Map<number, string>();
    for (const r of lineRecordings ?? []) {
      if (!r?.path) continue;
      recByIndex.set(r.index, r.text == null ? "" : r.text);
    }
    let lineIndex = 0;
    for (const l of lines) {
      if (!l.text.trim()) continue;
      const recText = recByIndex.get(lineIndex);
      // undefined = 没录过；字符串 = 录过，比对台词是否还是当初那句
      const audioPath =
        recText !== undefined && recText.trim() === l.text.trim()
          ? (lineRecordings ?? []).find((r) => r.index === lineIndex)?.path
          : undefined;
      rawSegments.push({
        text: l.text,
        voice: voiceFor(l.speakerType),
        imagePath: l.speakerType === "b" ? imageCustomer : imageFortune,
        prosody: prosodyFor(l.speakerType),
        sceneId: rawSegments.length,
        audioPath,
        motionMode: l.speakerType === "b" ? (motionB?.mode ?? motionMode) : (motionA?.mode ?? motionMode),
        motionAmount:
          l.speakerType === "b" ? (motionB?.amount ?? motionAmount) : (motionA?.amount ?? motionAmount),
      });
      lineIndex++;
    }
    if (!rawSegments.length) throw new Error("脚本为空或无法解析。");
  }

  const totalLines = rawSegments.length;
  emit({ stage: "parse", percent: 100, totalLines });

  // 2. tts
  try {
    fs.mkdirSync(outputDir, { recursive: true });
  } catch (e) {
    // 没权限/磁盘满时给出可操作的提示，而不是一串英文错误码
    throw describeFsError(e, outputDir, "视频输出路径");
  }
  // 每次合成用独立子目录，避免跨次运行复用同名 line_NNN.mp3 撞上被锁文件
  const runId = new Date().toISOString().replace(/[-:T.Z]/g, "").slice(0, 14) + "-" + Math.floor(Math.random() * 100000);
  const audioDir = path.join(outputDir, "audio", `run-${runId}`);
  fs.mkdirSync(audioDir, { recursive: true });

  try {
    emit({ stage: "tts", percent: 0, totalLines, message: "开始合成语音..." });

    const ttsResults: (TtsResult | null)[] = new Array(totalLines).fill(null);
    let ttsDone = 0;
    const bumpProgress = () => {
      ttsDone++;
      emit({
        stage: "tts",
        percent: totalLines ? Math.round((ttsDone / totalLines) * 100) : 0,
        currentLine: ttsDone,
        totalLines,
      });
    };

    // 1) 真人录音：直接用录好的文件（跳过 TTS），探测一次时长确认文件可读
    for (let i = 0; i < rawSegments.length; i++) {
      const s = rawSegments[i];
      if (!s.audioPath) continue;
      // 报错说清是哪一处：图文解说是"镜头 N"，对话模式是"第 N 句"
      const where = mode === "dialogue" ? `第 ${s.sceneId + 1} 句` : `镜头 ${s.sceneId + 1}`;
      if (!fs.existsSync(s.audioPath)) {
        throw new Error(`${where}的录音文件不存在，请重录或清掉录音再合成。`);
      }
      /*
       * 录音文件归一化成 mp3：音频拼接是 `-c copy`（不重编码），混不了 webm/opus 和 mp3；
       * 而且 MediaRecorder 的 webm 容器时长字段是 Infinity，探测会拿到错误的兜底时长。
       * 新录音在保存时已经转成 mp3，这里兜底处理旧的/转码失败留下的 webm。
       */
      let audioFile = s.audioPath;
      const ext = path.extname(audioFile).toLowerCase();
      if (ext !== ".mp3" && ext !== ".wav") {
        const mp3 = path.join(audioDir, `rec_${String(i).padStart(3, "0")}.mp3`);
        const res = await runFfmpeg(
          ["-y", "-i", audioFile, "-c:a", "libmp3lame", "-b:a", "64k", "-ar", "24000", "-ac", "1", mp3],
          { timeoutMs: 120_000, signal }
        );
        if (res.code !== 0 || !fs.existsSync(mp3) || fs.statSync(mp3).size === 0) {
          throw new Error(`${where}的录音读不了（可能已损坏），请重录。`);
        }
        audioFile = mp3;
      }
      ttsResults[i] = { path: audioFile, cues: [] };
      bumpProgress();
    }

    // 2) Edge 在线音色：整批走 TtsEngine
    const edgeIndices: number[] = [];
    const edgeSegments: TtsSegment[] = [];
    rawSegments.forEach((s, i) => {
      if (s.audioPath || ttsResults[i]) return;
      if (s.voice.startsWith("clone:")) return;
      edgeIndices.push(i);
      edgeSegments.push({
        index: i,
        text: s.text,
        voice: s.voice,
        rate: prosodyPercent(s.prosody.rate),
        pitch: prosodyPercent(s.prosody.pitch),
        volume: prosodyPercent(s.prosody.volume),
      });
    });
    if (edgeSegments.length) {
      const tts = new TtsEngine({ outputDir: audioDir, signal });
      const results = await tts.generateAll(edgeSegments, bumpProgress);
      results.forEach((r, k) => {
        ttsResults[edgeIndices[k]] = r;
      });
    }

    // 3) 克隆音色：按克隆 ID 分组，逐个通过本地 Genie 服务合成
    const cloneGroups = new Map<
      string,
      { voice: CloneVoice; items: Array<{ index: number; text: string }> }
    >();
    rawSegments.forEach((s, i) => {
      if (s.audioPath || ttsResults[i]) return;
      if (!s.voice.startsWith("clone:")) return;
      const id = s.voice.slice("clone:".length);
      const cv = (settings.getAppSettings().cloneVoices ?? []).find((v) => v.id === id);
      if (!cv) {
        throw new Error(`克隆音色 ${id} 不存在，请到「设置 → 声音克隆」检查。`);
      }
      const g = cloneGroups.get(id) ?? { voice: cv, items: [] };
      g.items.push({ index: i, text: s.text });
      cloneGroups.set(id, g);
    });
    for (const [id, g] of cloneGroups) {
      const engine = new GenieTtsEngine({ baseUrl: localTtsBaseUrl(), signal });
      const name = genieCharacterName(id);
      try {
        await engine.loadCharacter(name, g.voice.modelDir, g.voice.language);
        await engine.setReferenceAudio(
          name,
          g.voice.audioPath,
          g.voice.audioText,
          g.voice.language
        );
      } catch (e) {
        await engine.stop();
        if (signal?.aborted) throw new Error("已取消");
        throw new Error(
          `克隆音色「${g.voice.name}」加载失败：${e instanceof Error ? e.message : String(e)}` +
            "（请先在「设置 → 声音克隆」启动本地语音服务，并确认已下载模型、参考音频有效）"
        );
      }
      try {
        for (const item of g.items) {
          if (signal?.aborted) {
            await engine.stop();
            throw new Error("已取消");
          }
          try {
            const r = await engine.synthesize(
              { index: item.index, text: item.text, characterName: name },
              path.join(audioDir, `line_${String(item.index).padStart(3, "0")}.wav`)
            );
            ttsResults[item.index] = { path: r.path, cues: [] };
          } catch (e) {
            if (signal?.aborted) {
              await engine.stop();
              throw e;
            }
            // 单句失败：跳过该句，继续
            ttsResults[item.index] = null;
          }
          bumpProgress();
        }
      } finally {
        /*
         * 这一组（同一个克隆音色）用完就卸载：Genie 每次 load_character 都会新加载一份
         * 几百 MB 的 ONNX 模型，不卸载会在连续生成几次后 OOM，表现为合成出空的音频片段。
         */
        await engine.unloadCharacter(name);
      }
    }

    // 失败的是第几句要说清楚：合成失败的句子连画面带字幕整段跳过，只报个数量没法排查
    const failedLines = ttsResults
      .map((r, i) => (r ? -1 : i))
      .filter((i) => i >= 0);
    const failedCount = failedLines.length;
    const failedList = failedLines.slice(0, 3).map((i) => i + 1).join("、");
    const failedHint = failedCount
      ? `有 ${failedCount} 句语音合成失败（第 ${failedList}${failedCount > 3 ? "…" : ""} 句），视频将跳过这些内容`
      : undefined;
    emit({
      stage: "tts",
      percent: 100,
      totalLines,
      message: failedHint,
    });

    // 3. compose
    const safeName = name.replace(/[\\/:*?"<>|]/g, "_") || "dialogue";
    const ts = new Date()
      .toISOString()
      .replace(/[-:T.Z]/g, "")
      .slice(0, 14);
    const outputPath = path.join(outputDir, "video", `${safeName}_${ts}.mp4`);

    emit({ stage: "compose", percent: 0, message: "开始合成视频..." });
    const composer = new VideoComposer({
      resolution:
        resolution === "portrait"
          ? { width: 1080, height: 1920 }
          : { width: 1920, height: 1080 },
      imageFit: imageFit ?? "contain",
      motionMode: motionMode ?? "zoom-in",
      motionAmount: motionAmount ?? 25,
    });
    const composeSegments: ComposeSegment[] = rawSegments.map((s, i) => ({
      text: s.text,
      audioPath: ttsResults[i]?.path ?? "",
      cues: ttsResults[i]?.cues,
      imagePath: s.imagePath,
      sceneId: s.sceneId,
      motionMode: s.motionMode,
      motionAmount: s.motionAmount,
    }));
    await composer.compose({
      segments: composeSegments,
      /*
       * 两种模式走同一条拼接路径（跟热点成片一致）：
       *   crossfade=false 时是一行一段、各段自己编码后再 `concat -c copy`，
       *   段与段之间只有 Edge 裁剩的那点尾音（约 0.15 秒），听着就是"一句顶着一句、
       *   字幕和声音各来各的"；而且画面比音频多 0.3 秒尾巴，concat 后音画时钟各算各的，
       *   越往后字幕和声音越容易错开。
       * 改成 true 之后：每段开头垫一段真静音（镜头之间的停顿）、字幕按 leadGap 偏移、
       * 段间用 xfade/acrossfade 在同一个音频时钟上累加 —— 停顿和同步是同一件事。
       */
      crossfade: true,
      outputPath,
      subtitle,
      signal,
      onProgress: (pct) => emit({ stage: "compose", percent: pct }),
    });

    emit({
      stage: "done",
      percent: 100,
      message: signal?.aborted
        ? "已取消"
        : failedHint
          ? `完成（${failedHint.replace("，视频将跳过这些内容", "，已跳过")}）`
          : "完成",
    });
    // 成片路径也进快照：界面切回来后要能直接预览这条片子
    if (ownSnapshot()) {
      lastCompose = { ...lastCompose!, outputPath, running: false, updatedAt: Date.now() };
    }
    return { outputPath };
  } catch (e) {
    // 失败也要留在快照里：界面切回来时得知道这次没成，而不是以为没跑过
    if (ownSnapshot()) {
      lastCompose = {
        ...lastCompose!,
        running: false,
        error: (e as Error)?.message ?? String(e),
        updatedAt: Date.now(),
      };
    }
    throw e;
  } finally {
    if (requestId) abortControllers.delete(requestId);
    if (ownSnapshot()) {
      lastCompose = { ...lastCompose!, running: false, updatedAt: Date.now() };
    }
    // 音频是中间产物，合成完清理（含被锁/残留文件），避免下次运行撞上
    try {
      fs.rmSync(audioDir, { recursive: true, force: true });
    } catch {
      /* 清理失败不影响结果 */
    }
  }
}

/** 默认输出目录：C:\Baoluo\data\dialogue-output（固定短路径，用户好找） */
export function defaultOutputDir(): string {
  return "C:\\Baoluo\\data\\dialogue-output";
}
