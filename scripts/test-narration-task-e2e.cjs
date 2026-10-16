/*
 * SPDX-License-Identifier: GPL-3.0-only
 * Copyright (c) 2026 宝螺 / Baoluo contributors
 * 本文件属于「宝螺 / Baoluo」。除 GPL-3.0 外还适用 ADDITIONAL_TERMS.md 里的附加条款：
 * 分发时须保留来源署名；修改版对外分发时不得沿用「宝螺」名称与图标。
 */
/**
 * 工作台「图文解说 → 点击执行 → 自动生成视频」端到端验证（Electron 下跑）。
 *
 *   electron scripts/test-narration-task-e2e.cjs
 *
 * 完整走一遍任务卡链路：
 *   ① createTask("图文解说 ...") 建卡，检查步骤 = 生成分镜 → 生图+合成
 *   ② 用 ffmpeg 造两张真实图片，落一份真实分镜（storyboard store），把第一步标成已完成
 *   ③ runTask 从断点继续执行「生图+合成」——缺图自动生图的前置校验全部跳过
 *    （图都齐了），直接进入逐镜配音 + 合成（真实 Edge TTS + ffmpeg，需联网）
 *   ④ 校验成片真的存在、时长 > 0，且写回了任务卡
 *   ⑤ 清理测试任务与分镜
 */
const path = require("node:path");
const fs = require("node:fs");
const { spawn } = require("node:child_process");
const { app } = require("electron");

const ROOT = path.join(__dirname, "..");
const SANDBOX = path.join(ROOT, "tmp", "narration-task-e2e");

// 沙箱 userData：这是测试，不污染真实数据
app.setAppPath(ROOT);
fs.rmSync(SANDBOX, { recursive: true, force: true });
fs.mkdirSync(SANDBOX, { recursive: true });
app.setPath("userData", SANDBOX);

let failures = 0;
function check(ok, label, extra = "") {
  console.log(`${ok ? "PASS" : "FAIL"}  ${label}${extra ? " — " + extra : ""}`);
  if (!ok) failures++;
}

function runFfmpeg(ffmpeg, args) {
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
    const c = spawn(
      require(path.join(ROOT, "node_modules", "ffmpeg-static")),
      ["-hide_banner", "-i", file],
      { windowsHide: true }
    );
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

  const { createTask } = require(path.join(ROOT, "dist", "main", "agent", "workflows.js"));
  const { getTask, removeTask, saveTask } = require(path.join(ROOT, "dist", "main", "agent", "store.js"));
  const { runTask } = require(path.join(ROOT, "dist", "main", "agent", "runner.js"));
  const { createStoryboard, deleteStoryboard, saveStoryboard } = require(path.join(ROOT, "dist", "main", "storyboard", "store.js"));

  // ① 建卡：一句话 → 图文解说任务卡
  const created = createTask("图文解说 职场焦虑");
  const task = created.task;
  check(task !== null, "一句话建出了图文解说任务卡", created.parse.intent);
  check(
    task.steps.map((s) => s.kind).join(" > ") === "write-storyboard > compose-narration",
    "步骤是「生成分镜 → 生图+合成」",
    task.steps.map((s) => s.kind).join(" > ")
  );
  check(
    task.steps[0].params.some((p) => p.key === "voiceNarrator"),
    "解说员音色挂在「生成分镜」这一步"
  );
  check(
    task.steps[0].params.some((p) => p.key === "rateNarrator"),
    "解说员语速挂在「生成分镜」这一步"
  );

  // ② 代替 AI 分镜：落一份真实分镜 + 两张真实图片（ffmpeg 造纯色图）
  const ffmpeg = require(path.join(ROOT, "node_modules", "ffmpeg-static"));
  const TMP = path.join(SANDBOX, "media");
  fs.mkdirSync(TMP, { recursive: true });
  const img1 = path.join(TMP, "shot1.jpg");
  const img2 = path.join(TMP, "shot2.jpg");
  await runFfmpeg(ffmpeg, ["-y", "-f", "lavfi", "-i", "color=c=#1b3a6b:s=1080x1920", "-frames:v", "1", img1]);
  await runFfmpeg(ffmpeg, ["-y", "-f", "lavfi", "-i", "color=c=#6b3a1b:s=1080x1920", "-frames:v", "1", img2]);
  check(fs.existsSync(img1) && fs.existsSync(img2), "两张镜头占位图已生成");

  const sb = createStoryboard(
    {
      title: "职场焦虑自测",
      hook: "你到底累不累",
      style: "柔和写实",
      trigger: "观众想代入自己",
      shots: [
        { caption: "第一镜，每天下班回家，你只想瘫着。", imagePrompt: "深夜办公室，冷光" },
        { caption: "第二镜，其实你已经做得很好了。", imagePrompt: "清晨地铁，暖光" },
      ],
    },
    null,
    "portrait"
  );
  sb.shots[0].imagePath = img1;
  sb.shots[1].imagePath = img2;
  saveStoryboard(sb);

  // ③ 模拟「生成分镜」已完成，执行下一步「生图+合成」——用户点执行时的真实路径
  const fresh = getTask(task.id);
  fresh.steps[0].status = "done";
  fresh.steps[0].note = "2 镜 · 测试直写";
  fresh.steps[0].outputPath = path.join(SANDBOX, "storyboard.json");
  fresh.state = { storyboardId: sb.id };
  saveTask(fresh);

  // 输出目录也指到沙箱里
  const settingsMod = require(path.join(ROOT, "dist", "main", "dialogue", "settings.js"));
  settingsMod.updateAppSettings({ outputDir: path.join(SANDBOX, "output") });

  const progress = [];
  // 用真实隐藏窗口的 webContents：compose/自动生图链路会调 BrowserWindow.fromWebContents，
  // Electron 30 遇到假对象会抛 e.getOwnerBrowserWindow（真实应用里是真窗口，不受影响）
  const win = new (require("electron").BrowserWindow)({ show: false });
  console.log("      正在执行「生图 + 合成」（真实 TTS + ffmpeg，约半分钟）…");
  const after = await runTask(task.id, {
    webContents: win.webContents,
    onProgress: (p) => progress.push(p),
  });

  // ④ 校验结果
  const composeStep = after.steps.find((s) => s.kind === "compose-narration");
  if (composeStep?.status !== "done") {
    console.log(`      compose-narration 失败原因：${composeStep?.error || "（无错误信息）"}`);
  }
  check(composeStep?.status === "done", "「生图+合成」步骤执行成功", composeStep?.status);
  check(after.status === "done", "任务级状态 = done", after.status);
  check(
    Boolean(after.resultPath) && fs.existsSync(after.resultPath),
    "成片文件真实存在",
    after.resultPath || "（无）"
  );
  if (after.resultPath && fs.existsSync(after.resultPath)) {
    const d = await probeDuration(after.resultPath);
    check(d > 1, "成片时长 > 1 秒", `${d.toFixed(2)}s`);
  }
  check(
    progress.some((p) => p.stepId === composeStep?.id && p.step?.status === "running"),
    "回推过「合成中」进度"
  );
  check(
    progress.some((p) => p.status === "done" && p.task),
    "结束时推了完整任务快照"
  );

  // ⑤ 清理
  removeTask(task.id);
  deleteStoryboard(sb.id);
  check(getTask(task.id) === null, "测试任务已清理");

  console.log(failures ? `\n${failures} 项未通过` : "\n全部通过");
  app.exit(failures ? 1 : 0);
})().catch((e) => {
  console.error("FAIL  测试抛错 —", e?.message || e);
  app.exit(1);
});
