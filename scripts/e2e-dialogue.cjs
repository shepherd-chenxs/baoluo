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

/** 角色图目录：可用环境变量 BAOLUO_ASSETS_DIR 覆盖，默认用仓库自带的模板图 */
const ASSETS = process.env.BAOLUO_ASSETS_DIR || path.join(ROOT, "resources", "template-assets");

/** 在 ASSETS 下按顺序找第一个存在的文件，都没有就返回第一个候选（便于报错时看到路径） */
function pickImage(...names) {
  for (const name of names) {
    const p = path.join(ASSETS, name);
    if (fs.existsSync(p)) return p;
  }
  return path.join(ASSETS, names[0]);
}

// 模拟 webContents.send
const events = [];
const fakeWebContents = {
  send: (_channel, payload) => events.push(payload),
};

(async () => {
  console.log("[e2e] starting compose...");
  const t0 = Date.now();
  const res = await composeMod.runCompose({
    name: "e2e-test",
    script: `命理师：日月有更替，四季长轮转。心里有啥事儿，阁下请直言。
顾客：大师您好，最近睡不好。
命理师：你坐下，把生辰报一下。
顾客：我是八五年的，十月初九。`,
    imageFortune: pickImage("minglishi.jpg", "tpl-role-a.jpg"),
    imageCustomer: pickImage("guke.jpg", "tpl-role-b.jpg"),
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
