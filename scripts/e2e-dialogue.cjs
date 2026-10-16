/*
 * SPDX-License-Identifier: GPL-3.0-only
 * Copyright (c) 2026 宝螺 / Baoluo contributors
 * 本文件属于「宝螺 / Baoluo」。除 GPL-3.0 外还适用 ADDITIONAL_TERMS.md 里的附加条款：
 * 分发时须保留来源署名；修改版对外分发时不得沿用「宝螺」名称与图标。
 */
/**
 * 端到端测试：模拟 IPC 流程，从解析脚本 → TTS → 合成 → 输出文件。
 * 用已经 tsc 编译出来的 CJS 模块，跑一遍，验证集成正确性。
 */
const path = require("node:path");
const fs = require("node:fs");
const { spawn } = require("node:child_process");

const ROOT = path.join(__dirname, "..");
const DIST = path.join(ROOT, "dist", "main", "dialogue", "compose.js");

if (!fs.existsSync(DIST)) {
  console.error("Need to build first. Run: npm run build");
  process.exit(1);
}

const composeMod = require(DIST);

const OUT_DIR = path.join(ROOT, "tmp", "e2e-out");
fs.rmSync(OUT_DIR, { recursive: true, force: true });

/** 用 ffmpeg 生成纯色占位图，测试不依赖任何外部素材目录 */
function makePlaceholder(file, color) {
  return new Promise((resolve, reject) => {
    const child = spawn(
      require("ffmpeg-static"),
      ["-y", "-f", "lavfi", "-i", `color=c=${color}:s=720x1280`, "-frames:v", "1", file],
      { windowsHide: true }
    );
    let err = "";
    child.stderr.on("data", (b) => (err += b.toString("utf8")));
    child.on("close", (code) =>
      code === 0 ? resolve() : reject(new Error(`ffmpeg exit ${code}\n${err.slice(-500)}`))
    );
    child.on("error", reject);
  });
}

// 模拟 webContents.send
const events = [];
const fakeWebContents = {
  send: (_channel, payload) => events.push(payload),
};

(async () => {
  const ASSET_DIR = path.join(ROOT, "tmp", "e2e-assets");
  fs.mkdirSync(ASSET_DIR, { recursive: true });
  const imgA = path.join(ASSET_DIR, "role-a.jpg");
  const imgB = path.join(ASSET_DIR, "role-b.jpg");
  await makePlaceholder(imgA, "#1b3a6b");
  await makePlaceholder(imgB, "#6b3a1b");

  console.log("[e2e] starting compose...");
  const t0 = Date.now();
  const res = await composeMod.runCompose({
    name: "e2e-test",
    script: `甲方：忙了一整天，晚上还是睡不着。
乙方：我懂，越急越睡不着。
甲方：所以想找个办法放松一下。
乙方：先从固定的睡前流程开始试。`,
    imageFortune: imgA,
    imageCustomer: imgB,
    outputDir: OUT_DIR,
    voiceFortune: "zh-CN-YunjianNeural",
    voiceCustomer: "zh-CN-XiaoxiaoNeural",
    subtitle: { fontSize: 50, positionPct: 0.85, color: "#FFFFFF", backgroundColor: "#000000", backgroundOpacity: 0.8 },
    webContents: fakeWebContents,
    requestId: "e2e-1",
  });

  console.log("[e2e] DONE in " + (Date.now() - t0) + "ms");
  console.log("[e2e] output:", res.outputPath);
  console.log("[e2e] size:", fs.statSync(res.outputPath).size);

  // 探测视频时长
  const child = spawn(require("ffmpeg-static"), ["-hide_banner", "-i", res.outputPath], { windowsHide: true });
  let err = "";
  child.stderr.on("data", (b) => (err += b.toString("utf8")));
  await new Promise((r) => child.on("close", r));
  const m = /Duration:\s*(\d+):(\d+):(\d+\.\d+)/.exec(err);
  if (m) console.log("[e2e] duration:", m[1] + ":" + m[2] + ":" + m[3]);

  // 显示进度事件摘要
  const stages = new Set(events.map((e) => e.stage));
  console.log("[e2e] progress stages seen:", [...stages].join(", "));
  console.log("[e2e] total events:", events.length);

  console.log("OK.");
})().catch((e) => {
  console.error("FAIL:", e);
  process.exit(1);
});
