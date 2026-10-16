/*
 * SPDX-License-Identifier: GPL-3.0-only
 * Copyright (c) 2026 宝螺 / Baoluo contributors
 * 本文件属于「宝螺 / Baoluo」。除 GPL-3.0 外还适用 ADDITIONAL_TERMS.md 里的附加条款：
 * 分发时须保留来源署名；修改版对外分发时不得沿用「宝螺」名称与图标。
 */
/**
 * 工作台「任务卡 + 执行器」的端到端测试（Electron 下跑，不联网）。
 *
 *   npm run test:agent-runner
 *
 * 验的是接线，不是模型：
 *   ① 建卡：一句话真的变成一张有步骤的任务卡，并且落了盘
 *   ② 接着跑：已经有脚本的前提下，从"第一个没做完的步骤"继续，而不是从头再来
 *   ③ 失败要说人话：合成缺两张人物图 → 那一步标红，错误信息是可操作的
 *   ④ 进度要回推：每一步的状态变化都通过 onProgress 发出来了
 *   ⑤ 收尾：删掉任务，不留垃圾
 *   ⑥ 图文解说：建的是内嵌分镜工作台（hot-story），「执行」能顺利收尾并给出指引
 *   ⑦ 爆款拆解：仍走「生成分镜 → 生图 + 合成」，缺图先尝试自动生图、失败要说人话
 */
const path = require("node:path");
const fs = require("node:fs");
const { app } = require("electron");

const ROOT = path.join(__dirname, "..");
const SANDBOX = path.join(ROOT, "tmp", "agent-runner");

// 指到沙箱目录：这是测试，别往用户真实的任务列表里塞东西
app.setAppPath(ROOT);
fs.rmSync(SANDBOX, { recursive: true, force: true });
fs.mkdirSync(SANDBOX, { recursive: true });
app.setPath("userData", SANDBOX);

let failures = 0;
/**
 * 结果同时写一份到文件：Windows 下 electron 的 stdout 不继承给父进程（管道里拿不到），
 * 只靠 console.log 时外面看到的永远是空。文件是唯一可靠的观测口。
 */
const LOG_FILE = path.join(ROOT, "tmp", "test-agent-runner.log");
function log(line) {
  console.log(line);
  try {
    fs.appendFileSync(LOG_FILE, line + "\n", "utf-8");
  } catch {
    /* 日志写不进去不影响测试本身 */
  }
}
function check(ok, label, extra = "") {
  log(`${ok ? "PASS" : "FAIL"}  ${label}${extra ? " — " + extra : ""}`);
  if (!ok) failures++;
}
/** 总超时：卡住时留下最后一条日志，好定位卡在哪一步（正常几秒就跑完） */
const HARD_TIMEOUT_MS = 90_000;
const hardTimer = setTimeout(() => {
  log(`\n[超时] 测试跑了 ${HARD_TIMEOUT_MS / 1000}s 还没结束，最后一条日志就是卡住的位置`);
  app.exit(1);
}, HARD_TIMEOUT_MS);

(async () => {
  fs.rmSync(LOG_FILE, { force: true });
  log("== test-agent-runner 开始 ==");
  await app.whenReady();

  const { createTask } = require(path.join(ROOT, "dist", "main", "agent", "workflows.js"));
  const { getTask, listTasks, removeTask, saveTask, tasksFile } = require(
    path.join(ROOT, "dist", "main", "agent", "store.js")
  );
  const { runTask } = require(path.join(ROOT, "dist", "main", "agent", "runner.js"));
  const { deleteStoryboard } = require(path.join(ROOT, "dist", "main", "storyboard", "store.js"));

  // ① 建卡
  const created = createTask("对话 事业运");
  check(created.task !== null, "一句话建出了任务卡", created.parse.intent);
  const task = created.task;
  check(
    task.steps.map((s) => s.kind).join(" > ") === "write-script > dialogue-config > compose",
    "步骤是「写脚本 → 角色与画面 → 合成」（跟热点成片的 ①②③ 对齐）",
    task.steps.map((s) => s.kind).join(" > ")
  );
  check(fs.existsSync(tasksFile()), "任务已经落盘");
  check(
    listTasks().some((t) => t.id === task.id),
    "列表里能看到它"
  );
  check(task.steps.every((s) => s.status === "pending"), "新卡的每一步都是未开始");

  // ② 假装脚本已经写好了，从「角色与画面」这一步继续跑（写脚本那步不会再调 AI）
  const fresh = getTask(task.id);
  fresh.steps[0].status = "done";
  fresh.steps[0].note = "12 行";
  fresh.state = { script: "甲方：你最近是不是总觉得，努力了却看不到结果？\n乙方：对，就是这样。" };
  saveTask(fresh);

  const progress = [];
  // 真实隐藏窗口：合成/生图链路会调 BrowserWindow.fromWebContents，假对象在 Electron 30 会抛错
  const win = new (require("electron").BrowserWindow)({ show: false });
  const after = await runTask(task.id, {
    webContents: win.webContents,
    onProgress: (p) => progress.push(p),
  });

  // ③ 缺人物图 → 这一步必须失败，而且要说清楚缺什么
  const composeStep = after.steps.find((s) => s.kind === "compose");
  check(composeStep.status === "failed", "没选人物图时合成步骤失败", composeStep.status);
  check(
    (composeStep.error || "").includes("两张人物图"),
    "错误信息是能照着做的人话",
    composeStep.error
  );
  check(after.status === "failed", "任务级状态跟着变成失败", after.status);
  check(
    after.steps[0].status === "done",
    "已经完成的第一步没有被重跑（从断点继续）",
    after.steps[0].status
  );
  check(
    after.steps[1].status === "done",
    "中间的「角色与画面」是空操作，能顺利跑过去",
    after.steps[1].status
  );
  check(
    !after.steps.some((s) => s.kind === "download"),
    "只给主题的剧本不会凭空多出下载步骤"
  );

  // ④ 进度事件：每一步的状态变化都要推给界面
  check(progress.length > 0, "回推了进度事件", `${progress.length} 条`);
  check(
    progress.some((p) => p.stepId === composeStep.id && p.step?.status === "running"),
    "推送过「合成中」"
  );
  check(
    progress.some((p) => p.taskId === task.id && p.task),
    "结束时推了一份完整的任务快照"
  );

  // ⑤ 收尾
  removeTask(task.id);
  check(getTask(task.id) === null, "删除后查不到");
  check(
    !listTasks().some((t) => t.id === task.id),
    "删除后不在列表里"
  );

  /*
   * ⑥ 图文解说 = 任务卡里内嵌「热点成片」页同一个分镜工作台（hot-story 步骤）。
   *    建卡只带主题预填，选题/生图/合成都在这块工作台上操作；
   *    工具本身是空操作，所以「执行」必须能顺利收尾、并给出下一步指引。
   */
  const narration = createTask("图文解说 职场焦虑");
  check(
    narration.task.steps.map((s) => s.kind).join(" > ") === "hot-story",
    "图文解说建出了内嵌工作台（hot-story）",
    narration.task.steps.map((s) => s.kind).join(" > ")
  );
  check(
    narration.task.steps[0].params.some((p) => p.key === "topic" && p.value === "职场焦虑"),
    "建卡时的话题带给工作台预填"
  );

  const nAfter = await runTask(narration.task.id, {
    webContents: win.webContents,
    onProgress: () => {},
  });
  const nStep = nAfter.steps.find((s) => s.kind === "hot-story");
  check(nStep?.status === "done", "「执行」能收尾（工具是空操作，不报「没有这种工具」）", nStep?.status);
  check(nAfter.status === "done", "任务级状态 = done", nAfter.status);
  check(
    (nStep?.note || "").includes("工作台"),
    "收尾时告诉用户去下面的工作台点「成片」",
    nStep?.note
  );
  removeTask(narration.task.id);

  /*
   * ⑦ 爆款拆解那条链仍走「生成分镜 → 生图 + 合成」：缺图时先尝试自动生图、失败要说人话。
   *
   * 这里用「切到 ModelScope 引擎但不填 Key」制造一个必然失败的前置校验：
   *   ModelScope 的校验是纯本地的，没 Key 直接报「自动生图没法开跑：…」，
   *   同样验到"缺图 → 试自动生图 → 说人话"。
   */
  const settingsMod = require(path.join(ROOT, "dist", "main", "dialogue", "settings.js"));
  settingsMod.updateAppSettings({ imageProvider: "modelscope", modelscopeImage: { token: "" } });
  const { createStoryboard } = require(path.join(ROOT, "dist", "main", "storyboard", "store.js"));
  const sniffTask = createTask("拆解这个爆款 https://v.douyin.com/aaa/").task;
  check(
    sniffTask.steps.map((s) => s.kind).join(" > ") ===
      "sniff > write-storyboard > compose-narration",
    "爆款拆解建出了「拆解 → 生成分镜 → 生图合成」",
    sniffTask.steps.map((s) => s.kind).join(" > ")
  );

  const sb = createStoryboard(
    {
      title: "职场焦虑",
      hook: "别再硬扛了",
      style: "柔和写实",
      shots: [
        { caption: "第一镜：加班到深夜", imagePrompt: "深夜办公室，冷光" },
        { caption: "第二镜：清晨的地铁", imagePrompt: "清晨地铁，暖光" },
      ],
    },
    null,
    "portrait"
  );
  const sTask = getTask(sniffTask.id);
  sTask.steps[0].status = "done";
  sTask.steps[1].status = "done";
  sTask.state = { storyboardId: sb.id };
  saveTask(sTask);

  let sniffError = "";
  const sAfter = await runTask(sniffTask.id, {
    webContents: win.webContents,
    onProgress: () => {},
  }).catch((e) => {
    sniffError = e.message;
    return null;
  });
  const sCompose = sAfter?.steps.find((s) => s.kind === "compose-narration");
  check(sCompose?.status === "failed", "两镜都没图时合成步骤失败", sCompose?.status);
  const sError = sCompose?.error || sniffError;
  check(
    sError.includes("自动生图"),
    "缺图时尝试自动生图（前置校验拦住并说人话）",
    sError
  );
  removeTask(sniffTask.id);
  deleteStoryboard(sb.id);

  /*
   * 清沙箱：目录里可能有刚写过、句柄还没释放的文件（Windows 上删不掉）。
   * 清理失败不该让测试崩——它是收尾动作，前面 23 项断言已经跑完了；
   * 抛出去会跳过下面的 app.exit()，外面看就是"卡住 90 秒"（踩过）。
   */
  try {
    fs.rmSync(SANDBOX, { recursive: true, force: true });
  } catch (e) {
    log(`（沙箱清理没成功，不影响结论：${e.message}）`);
  }

  clearTimeout(hardTimer);
  log(failures ? `\n${failures} 项没通过` : "\n全部通过");
  /*
   * 收尾：把测试开过的东西都关掉再退出。
   * 只调 app.exit() 时进程不肯收工（实测跑完还挂着），因为测试期间加载过
   * 生图/分镜这些模块，可能留下隐藏窗口或 WebContents 句柄。全关一遍再 exit。
   */
  try {
    const { BrowserWindow } = require("electron");
    for (const w of BrowserWindow.getAllWindows()) {
      if (!w.isDestroyed()) w.destroy();
    }
  } catch {
    /* 拿不到窗口列表就算了 */
  }
  app.exit(failures ? 1 : 0);
})();
