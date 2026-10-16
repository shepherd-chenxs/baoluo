/*
 * SPDX-License-Identifier: GPL-3.0-only
 * Copyright (c) 2026 宝螺 / Baoluo contributors
 * 本文件属于「宝螺 / Baoluo」。除 GPL-3.0 外还适用 ADDITIONAL_TERMS.md 里的附加条款：
 * 分发时须保留来源署名；修改版对外分发时不得沿用「宝螺」名称与图标。
 */
/**
 * 变声器（方案 A）端到端测试 —— 必须在 Electron 下跑（要用 app.getPath / net）。
 *
 *   npm run test:convert
 *
 * 流程：Edge TTS 造一段中文源音频 → 走完整变声流水线（识别 → 换音色重新配音 → 拼接）
 *      → 校验产物存在、时长合理、句数对得上。
 * 依赖：已下载的 whisper 模型（首次会自动下载约 148 MB）＋ 联网（Edge TTS）。
 */
const path = require("node:path");
const fs = require("node:fs");
const { spawn } = require("node:child_process");
const { app } = require("electron");

const ROOT = path.join(__dirname, "..");
// 让 transcribe.ts 里的 app.getAppPath()/resources 解析到项目根，而不是 scripts/
app.setAppPath(ROOT);
// 用真实用户目录：能找到已下载的 whisper 模型和本地设置
app.setPath("userData", path.join(process.env.APPDATA || "", "Baoluo"));

const ffmpeg = require(path.join(ROOT, "node_modules", "ffmpeg-static"));
const { EdgeTTS } = require(path.join(ROOT, "node_modules", "node-edge-tts"));

const TMP = path.join(ROOT, "tmp", "voice-convert-test");
const OUT = path.join(TMP, "out");

const SRC_TEXT =
  "日月有更替，四季长轮转。人难长安泰，月难永团圆。心里有啥事儿，阁下请直言。";
const SRC_VOICE = "zh-CN-YunjianNeural";
const DST_VOICE = "zh-CN-XiaoxiaoNeural";

let failures = 0;
function check(ok, label, extra = "") {
  console.log(`${ok ? "PASS" : "FAIL"}  ${label}${extra ? " — " + extra : ""}`);
  if (!ok) failures++;
}

function probeDuration(file) {
  return new Promise((resolve) => {
    const c = spawn(ffmpeg, ["-hide_banner", "-i", file], { windowsHide: true });
    let err = "";
    c.stderr.on("data", (b) => (err += b.toString("utf8")));
    c.on("close", () => {
      const m = /Duration:\s*(\d+):(\d+):(\d+\.\d+)/.exec(err);
      resolve(m ? +m[1] * 3600 + +m[2] * 60 + +m[3] : 0);
    });
  });
}

(async () => {
  await app.whenReady();

  fs.rmSync(TMP, { recursive: true, force: true });
  fs.mkdirSync(OUT, { recursive: true });

  // 1) 造一段源音频（模拟用户上传）
  const srcPath = path.join(TMP, "src.mp3");
  await new EdgeTTS({ voice: SRC_VOICE, timeout: 30_000 }).ttsPromise(SRC_TEXT, srcPath);
  const srcDur = await probeDuration(srcPath);
  check(fs.existsSync(srcPath) && srcDur > 0, "源音频已生成", `${srcDur.toFixed(2)}s`);

  // 2) 跑变声流水线
  const { runVoiceConvert } = require(path.join(ROOT, "dist", "main", "dialogue", "voice-convert.js"));
  const stages = [];
  const t0 = Date.now();
  const res = await runVoiceConvert({
    inputPath: srcPath,
    voice: DST_VOICE,
    outputDir: OUT,
    onProgress: (p) => {
      if (stages[stages.length - 1] !== p.stage) {
        stages.push(p.stage);
        console.log(`      [${p.stage}] ${p.message ?? ""}`);
      }
    },
  });
  const cost = ((Date.now() - t0) / 1000).toFixed(1);

  // 3) 校验产物
  const outDur = await probeDuration(res.audioPath);
  const size = fs.statSync(res.audioPath).size;
  check(fs.existsSync(res.audioPath), "产物已生成", path.relative(ROOT, res.audioPath));
  check(size > 10_000, "产物不是空文件", `${(size / 1024).toFixed(1)} KB`);
  check(outDur > 0.5, "产物有可听时长", `${outDur.toFixed(2)}s`);
  check(res.segmentCount > 0, "识别出了句子", `${res.segmentCount} 句`);
  check(
    stages.includes("transcribe") && stages.includes("synthesize") && stages.includes("merge"),
    "三个阶段都走到了",
    stages.join(" → ")
  );
  check(
    !fs.existsSync(path.join(OUT, "seg")) && !fs.existsSync(path.join(OUT, "norm")),
    "中间产物已清理"
  );
  console.log(`      源 ${srcDur.toFixed(2)}s → 成品 ${outDur.toFixed(2)}s，耗时 ${cost}s`);
  console.log(`      成品：${res.audioPath}`);

  console.log(failures ? `\n${failures} 项未通过` : "\n全部通过");
  app.exit(failures ? 1 : 0);
})().catch((e) => {
  console.error("FAIL  变声流水线抛错 —", e?.message || e);
  app.exit(1);
});
