/*
 * SPDX-License-Identifier: GPL-3.0-only
 * Copyright (c) 2026 宝螺 / Baoluo contributors
 * 本文件属于「宝螺 / Baoluo」。除 GPL-3.0 外还适用 ADDITIONAL_TERMS.md 里的附加条款：
 * 分发时须保留来源署名；修改版对外分发时不得沿用「宝螺」名称与图标。
 */
/**
 * 图文解说「一镜一个解说员」端到端测试（需在 Electron 下跑、需联网用 Edge TTS）。
 *
 *   npm run test:narration
 *
 * 做法：ffmpeg 造两张纯色图 → 同一段脚本跑两次 runCompose：
 *   ① 两镜都用 +100% 语速   ② 第一镜 +100%、第二镜 -50%
 * 若第二镜的解说员配置真按镜头生效，②的总时长会明显长于①。
 * 这样验的是"逐镜"而不是"全局"，且不依赖 TTS 是否可复现（只看时长差）。
 */
const path = require("node:path");
const fs = require("node:fs");
const { spawn } = require("node:child_process");
const { app } = require("electron");

const ROOT = path.join(__dirname, "..");
app.setAppPath(ROOT);
app.setPath("userData", path.join(process.env.APPDATA || "", "Baoluo"));

const ffmpeg = require(path.join(ROOT, "node_modules", "ffmpeg-static"));
const TMP = path.join(ROOT, "tmp", "narration-narrators");
const OUT = path.join(TMP, "out");
const VOICE = "zh-CN-YunjianNeural";

let failures = 0;
function check(ok, label, extra = "") {
  console.log(`${ok ? "PASS" : "FAIL"}  ${label}${extra ? " — " + extra : ""}`);
  if (!ok) failures++;
}

function runFfmpeg(args) {
  return new Promise((resolve, reject) => {
    const child = spawn(ffmpeg, args, { windowsHide: true });
    let err = "";
    child.stderr.on("data", (b) => (err += b.toString("utf8")));
    child.on("close", (code) =>
      code === 0 ? resolve() : reject(new Error(`ffmpeg exit ${code}\n${err.slice(-500)}`))
    );
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
      resolve(m ? +m[1] * 3600 + +m[2] * 60 + +m[3] : 0);
    });
    c.on("error", () => resolve(0));
  });
}

(async () => {
  await app.whenReady();
  fs.rmSync(TMP, { recursive: true, force: true });
  fs.mkdirSync(OUT, { recursive: true });

  const { runCompose } = require(path.join(ROOT, "dist", "main", "dialogue", "compose.js"));

  // 两张占位图（不依赖外部素材）
  const img1 = path.join(TMP, "shot1.jpg");
  const img2 = path.join(TMP, "shot2.jpg");
  await runFfmpeg(["-y", "-f", "lavfi", "-i", "color=c=#1b3a6b:s=1280x720", "-frames:v", "1", img1]);
  await runFfmpeg(["-y", "-f", "lavfi", "-i", "color=c=#6b3a1b:s=1280x720", "-frames:v", "1", img2]);
  check(fs.existsSync(img1) && fs.existsSync(img2), "占位图已生成");

  const zero = { rate: 0, pitch: 0, volume: 0 };
  const base = {
    name: "narrator-test",
    mode: "narration",
    resolution: "landscape",
    imageFit: "contain",
    motionMode: "none",
    motionAmount: 10,
    // 页面里由分镜拼出来的脚本格式
    script: "#图1\n今天天气不错。\n\n#图2\n我们一起出去走走。",
    imageFortune: "",
    imageCustomer: "",
    images: [
      { path: img1, text: "今天天气不错。" },
      { path: img2, text: "我们一起出去走走。" },
    ],
    outputDir: OUT,
    voiceFortune: VOICE,
    voiceCustomer: VOICE,
    voiceNarrator: VOICE,
    narratorCount: 1,
    prosody: { a: zero, b: zero, narrator: zero },
    subtitle: {
      fontSize: 40,
      positionPct: 0.85,
      color: "#FFFFFF",
      backgroundColor: "#000000",
      backgroundOpacity: 0.5,
    },
    webContents: {
      send: (_channel, p) => {
        if (p?.message) console.log(`      · [${p.stage}] ${p.message}`);
      },
      isDestroyed: () => false,
    },
  };

  const fast = { rate: 100, pitch: 0, volume: 0 };
  const slow = { rate: -50, pitch: 0, volume: 0 };

  console.log("      [1/2] 两镜都 +100% 语速…");
  const r1 = await runCompose({
    ...base,
    imageNarrators: [
      { voice: VOICE, prosody: fast },
      { voice: VOICE, prosody: fast },
    ],
  });
  const d1 = await probeDuration(r1.outputPath);

  console.log("      [2/2] 第二镜改成 -50% 语速…");
  const r2 = await runCompose({
    ...base,
    imageNarrators: [
      { voice: VOICE, prosody: fast },
      { voice: VOICE, prosody: slow },
    ],
  });
  const d2 = await probeDuration(r2.outputPath);

  check(fs.existsSync(r1.outputPath) && d1 > 0, "第一次生成了视频", `${d1.toFixed(2)}s`);
  check(fs.existsSync(r2.outputPath) && d2 > 0, "第二次生成了视频", `${d2.toFixed(2)}s`);
  check(
    d2 - d1 > 0.8,
    "第二镜的解说员配置按镜头生效（不是全局）",
    `${d1.toFixed(2)}s → ${d2.toFixed(2)}s（差 ${(d2 - d1).toFixed(2)}s）`
  );

  console.log(failures ? `\n${failures} 项未通过` : "\n全部通过");
  app.exit(failures ? 1 : 0);
})().catch((e) => {
  console.error("FAIL  图文解说逐镜解说员测试抛错 —", e?.message || e);
  app.exit(1);
});
