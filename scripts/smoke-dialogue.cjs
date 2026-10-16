/*
 * SPDX-License-Identifier: GPL-3.0-only
 * Copyright (c) 2026 宝螺 / Baoluo contributors
 * 本文件属于「宝螺 / Baoluo」。除 GPL-3.0 外还适用 ADDITIONAL_TERMS.md 里的附加条款：
 * 分发时须保留来源署名；修改版对外分发时不得沿用「宝螺」名称与图标。
 */
/**
 * 对话视频 composer 烟雾测试。
 *
 * 流程：
 *   1. node-edge-tts 合成一段 mp3
 *   2. 写一份 .ass 字幕
 *   3. ffmpeg：图 + mp3 + ass 字幕 → 单段 mp4
 *   4. 模拟多段 concat：用两个段 + concat demuxer
 *   5. 报告文件大小、分辨率、时长
 *
 * 用法： node scripts/smoke-dialogue.cjs
 *   无需外部素材：两张人物图由 ffmpeg 现场生成纯色占位图
 */
const path = require("node:path");
const fs = require("node:fs");
const { spawn } = require("node:child_process");

const ROOT = path.join(__dirname, "..");
const ffmpeg = require(path.join(ROOT, "node_modules", "ffmpeg-static"));
const { EdgeTTS } = require(path.join(ROOT, "node_modules", "node-edge-tts"));

const TMP = path.join(ROOT, "tmp", "smoke-dialogue");
fs.rmSync(TMP, { recursive: true, force: true });
fs.mkdirSync(TMP, { recursive: true });

function runFfmpeg(args, opts = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(ffmpeg, args, { ...opts, windowsHide: true });
    let err = "";
    child.stderr.on("data", (b) => (err += b.toString("utf8")));
    child.on("close", (code) => (code === 0 ? resolve() : reject(new Error(`ffmpeg exit ${code}\n${err.split("\n").slice(-15).join("\n")}`))));
    child.on("error", reject);
  });
}

function probeDuration(file) {
  return new Promise((resolve) => {
    const c = spawn(ffmpeg, ["-hide_banner", "-i", file], { windowsHide: true });
    let err = "";
    c.stderr.on("data", (b) => (err += b.toString("utf8")));
    c.on("close", () => {
      const m = /Duration:\s*(\d+):(\d+):(\d+\.\d+)/.exec(err);
      resolve(m ? +m[1] * 3600 + +m[2] * 60 + +m[3] : 1);
    });
  });
}

(async () => {
  // 两张人物占位图：现场用 ffmpeg 生成，不依赖任何外部素材目录
  const ASSETS = path.join(TMP, "assets");
  fs.mkdirSync(ASSETS, { recursive: true });

  // 句 1
  const ttsA = path.join(TMP, "tts_a.mp3");
  await new EdgeTTS({ voice: "zh-CN-YunjianNeural", timeout: 30_000 })
    .ttsPromise("忙了一整天，晚上还是翻来覆去睡不着。", ttsA);
  const durA = await probeDuration(ttsA);
  console.log("[1] TTS-A", fs.statSync(ttsA).size, "bytes,", durA.toFixed(2), "s");

  // 句 2
  const ttsB = path.join(TMP, "tts_b.mp3");
  await new EdgeTTS({ voice: "zh-CN-XiaoxiaoNeural", timeout: 30_000 })
    .ttsPromise("我懂，越急着睡越睡不着。先试试固定的睡前流程。", ttsB);
  const durB = await probeDuration(ttsB);
  console.log("[2] TTS-B", fs.statSync(ttsB).size, "bytes,", durB.toFixed(2), "s");

  const imgA = path.join(ASSETS, "role-a.jpg");
  const imgB = path.join(ASSETS, "role-b.jpg");
  await runFfmpeg(["-y", "-f", "lavfi", "-i", "color=c=#1b3a6b:s=720x1280", "-frames:v", "1", imgA]);
  await runFfmpeg(["-y", "-f", "lavfi", "-i", "color=c=#6b3a1b:s=720x1280", "-frames:v", "1", imgB]);

  function assText(text, start, end) {
    return [
      "[Script Info]",
      "ScriptType: v4.00+",
      "PlayResX: 1920",
      "PlayResY: 1080",
      "",
      "[V4+ Styles]",
      "Format: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding",
      "Style: Default,Microsoft YaHei,50,&H00FFFFFF,&H000000FF,&H00000000,&H80000000,-1,0,0,0,100,100,0,0,1,2,0,2,40,40,80,1",
      "",
      "[Events]",
      "Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text",
      `Dialogue: 0,${start},${end},Default,,0,0,0,,${text.replace(/\r?\n/g, " ")}`,
    ].join("\r\n");
  }

  // 段 A
  fs.writeFileSync(path.join(TMP, "seg_000.ass"), assText("甲方：忙了一整天，晚上还是睡不着。", "0:00:00.00", "0:00:" + durA.toFixed(2).padStart(5, "0")), "utf-8");
  await runFfmpeg(
    ["-y", "-loop", "1", "-framerate", "24", "-t", durA.toFixed(3), "-i", imgA, "-i", ttsA,
     "-vf", "scale=1920:1080:force_original_aspect_ratio=decrease,pad=1920:1080:(ow-iw)/2:(oh-ih)/2:black,ass=seg_000.ass",
     "-c:v", "libx264", "-preset", "ultrafast", "-crf", "23", "-pix_fmt", "yuv420p",
     "-c:a", "aac", "-b:a", "128k", "seg_000.mp4"],
    { cwd: TMP }
  );
  console.log("[3] seg A rendered");

  // 段 B
  fs.writeFileSync(path.join(TMP, "seg_001.ass"), assText("乙方：我懂，越急着睡越睡不着。", "0:00:00.00", "0:00:" + durB.toFixed(2).padStart(5, "0")), "utf-8");
  await runFfmpeg(
    ["-y", "-loop", "1", "-framerate", "24", "-t", durB.toFixed(3), "-i", imgB, "-i", ttsB,
     "-vf", "scale=1920:1080:force_original_aspect_ratio=decrease,pad=1920:1080:(ow-iw)/2:(oh-ih)/2:black,ass=seg_001.ass",
     "-c:v", "libx264", "-preset", "ultrafast", "-crf", "23", "-pix_fmt", "yuv420p",
     "-c:a", "aac", "-b:a", "128k", "seg_001.mp4"],
    { cwd: TMP }
  );
  console.log("[4] seg B rendered");

  // concat
  fs.writeFileSync(path.join(TMP, "list.txt"), "file 'seg_000.mp4'\nfile 'seg_001.mp4'\n", "utf-8");
  await runFfmpeg(
    ["-y", "-f", "concat", "-safe", "0", "-i", "list.txt", "-c", "copy", "-movflags", "+faststart", "out.mp4"],
    { cwd: TMP }
  );
  console.log("[5] concat →", fs.statSync(path.join(TMP, "out.mp4")).size, "bytes");
  console.log("OK.");
})().catch((e) => { console.error("FAIL:", e); process.exit(1); });
