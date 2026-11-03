/**
 * 批量生图队列（T-003，按组一次发送）测试 —— 必须在 Electron 下跑。
 *
 *   npm run test:doubao-batch
 *
 * 分两块：
 *   A) 队列逻辑：把 doubao 模块的 generateImagesFromPrompt（按组）与
 *      generateImageFromPrompt（单张补发）换成替身，不联网、不碰真实豆包，
 *      专测「分组 / 提交条数 / 顺序与消息内容 / 归位硬校验 / 退回单发 / 重试 /
 *      中止 / 汇总 / 判重」。
 *   B) 冻结闸门：真实打开一个本地页面的抽屉，验证「有任务在跑时关抽屉
 *      不会把页面冻住」——这是标准 8「关抽屉不中断任务」能成立的前提。
 *
 * 替身为什么可行：编译产物里是 (0, doubao_1.generateImagesFromPrompt)(...) 这种
 * 属性取值调用，所以运行时改 exports 就能换掉它。
 * 替身必须自己回调 opts.onSubmitted()：队列数「提交条数」（标准 2）就是靠这个回调。
 */
const path = require("node:path");
const fs = require("node:fs");
const http = require("node:http");
const { app, BrowserWindow, nativeImage } = require("electron");

const ROOT = path.join(__dirname, "..");
const SANDBOX = path.join(ROOT, "tmp", "doubao-batch-test");
fs.rmSync(SANDBOX, { recursive: true, force: true });
fs.mkdirSync(SANDBOX, { recursive: true });
app.setPath("userData", SANDBOX);

let failures = 0;
function check(ok, label, extra = "") {
  console.log(`${ok ? "PASS" : "FAIL"}  ${label}${extra ? " — " + extra : ""}`);
  if (!ok) failures++;
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** 一张真位图（PNG 魔数），让 attachShotImageBytes 的字节校验能过 */
const ONE_PX = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==",
  "base64"
);
const REAL_PNG = nativeImage.createFromBuffer(ONE_PX).resize({ width: 400, height: 400 }).toPNG();
const REAL_B64 = REAL_PNG.toString("base64");

/**
 * 建一个 n 镜方案。
 *
 * tag 用来让每块测试的提示词互不相同：替身是按提示词文本记账的，
 * 共用文本会让上一块设的「永远失败」计划漏到下一块（第一版就踩了）。
 */
function makeBoard(store, n, tag) {
  return store.createStoryboard({
    title: `批量测试方案-${tag}`,
    hook: "h",
    style: "s",
    shots: Array.from({ length: n }, (_, i) => ({
      caption: `${tag}第${i + 1}镜旁白`,
      imagePrompt: `${tag}第${i + 1}镜提示词`,
    })),
  });
}

(async () => {
  await app.whenReady();

  const doubao = require(path.join(ROOT, "dist", "main", "doubao.js"));
  const batch = require(path.join(ROOT, "dist", "main", "doubao-batch.js"));
  const store = require(path.join(ROOT, "dist", "main", "storyboard", "store.js"));

  const GROUP_MS = 120;
  const SINGLE_MS = 60;

  /** 按组调用的记录 */
  let groupCalls = [];
  /** 单张补发的记录 */
  let singleCalls = [];
  /**
   * 每组给出几张图（按调用序号）：默认给满。
   * give 小于 count 就是「张数不符」，队列必须整组退回单发（标准 5）。
   */
  let groupGivePlan = [];
  /** 单张补发：提示词 → 还要失败几次（用来验重试上限，标准 6） */
  let singleFailPlan = new Map();

  doubao.generateImagesFromPrompt = async (message, count, opts = {}) => {
    const idx = groupCalls.length;
    groupCalls.push({ message, count, timeoutMs: opts.timeoutMs });
    opts.onPhase?.(`正在把 ${count} 段提示词写进豆包…`);
    opts.onSubmitted?.();
    await sleep(GROUP_MS);
    const give = groupGivePlan[idx] ?? count;
    return Array.from({ length: give }, (_, i) => ({
      base64: REAL_B64,
      ext: ".png",
      src: `stub://group${idx}-${i}.png`,
    }));
  };

  doubao.generateImageFromPrompt = async (prompt, opts = {}) => {
    singleCalls.push({ prompt });
    opts.onPhase?.("正在把提示词写进豆包…");
    const left = singleFailPlan.get(prompt) ?? 0;
    /*
     * 失败发生在「提交之后」（真机上最常见的是抓图超时），所以先回调 onSubmitted
     * 再抛错：提交条数要把这些重试也算进去（标准 2 数的是真发出去的消息）。
     */
    opts.onSubmitted?.();
    if (left > 0) {
      singleFailPlan.set(prompt, left - 1);
      throw new doubao.DoubaoError(`模拟失败：${prompt}`, "stub-fail");
    }
    await sleep(SINGLE_MS);
    return { base64: REAL_B64, ext: ".png", src: "stub://single.png" };
  };

  // ---- B0) 广播：每次状态变化都收到快照 ----
  const events = [];
  batch.setBatchEmitter((s) => events.push(s));

  const waitDone = async () => {
    const deadline = Date.now() + 30000;
    while (Date.now() < deadline) {
      const s = batch.getBatchState();
      if (!s.running) return s;
      await sleep(20);
    }
    return batch.getBatchState();
  };
  const resetStubs = () => {
    groupCalls = [];
    singleCalls = [];
    groupGivePlan = [];
    singleFailPlan = new Map();
  };

  // ---- 0) 消息拼装（标准 3）----
  {
    const msg = batch.composeGroupMessage(["甲画面", "乙画面", "丙画面"]);
    const lines = msg.split("\n");
    check(lines[0].includes("生成 3 张图片"), "第一条说明要几张", lines[0]);
    check(/单独出一张/.test(lines[0]) && /不要合成一张拼图/.test(lines[0]), "明确要求各段单独出图、不要拼图");
    check(
      lines[1] === "第1张：甲画面" && lines[2] === "第2张：乙画面" && lines[3] === "第3张：丙画面",
      "三段提示词按镜头顺序编号",
      JSON.stringify(lines.slice(1))
    );
  }

  // ---- 1) 分组与提交条数（标准 1、2）----
  {
    resetStubs();
    // 12 镜：第 2 镜已有图、第 5 镜没提示词 → 10 个该生图的镜头
    const b1 = makeBoard(store, 12, "A");
    const seed = path.join(SANDBOX, "seed.png");
    fs.writeFileSync(seed, REAL_PNG);
    store.attachShotImage(b1.id, b1.shots[1].id, seed);
    const noPrompt = store.getStoryboard(b1.id);
    noPrompt.shots[4].imagePrompt = "";
    store.saveStoryboard(noPrompt);

    const r = await batch.startBatch(b1.id);
    check(r.started === true, "批量能启动", `error=${r.error ?? ""}`);
    check(r.state.total === 10, "已放图 / 缺提示词的镜头被跳过（12 镜里排 10 张）", `total=${r.state.total}`);
    check(r.state.groupSize === 3, "组大小用卡里的默认值 3", `groupSize=${r.state.groupSize}`);

    const dup = await batch.startBatch(b1.id);
    check(dup.started === false && !!dup.error, "执行中再点不会启动第二个队列", dup.error || "");

    const fin = await waitDone();
    check(fin.running === false, "队列跑完回到非运行态");
    check(
      groupCalls.length === 4 && fin.submitted === 4,
      "10 张只提交 4 条消息（3+3+3+1，标准 2 的算式）",
      `groupCalls=${groupCalls.length} submitted=${fin.submitted}`
    );
    check(
      fin.submitted <= 4,
      "没有退化成逐张提交（10 张、组大小 3 时提交条数 ≤ 4）",
      `submitted=${fin.submitted}`
    );
    check(
      groupCalls.every((c) => c.timeoutMs === c.count * 120000),
      "单组等待上限 = 组大小 × 单张上限（标准 10）",
      JSON.stringify(groupCalls.map((c) => `${c.count}→${c.timeoutMs}`))
    );
    check(
      groupCalls[3].count === 1,
      "最后一组只有 1 张（10 = 3+3+3+1）",
      `lastCount=${groupCalls[3].count}`
    );
    const g0 = groupCalls[0].message;
    check(
      g0.includes("A第1镜提示词") &&
        g0.includes("A第3镜提示词") &&
        g0.includes("A第4镜提示词") &&
        !g0.includes("A第2镜提示词") &&
        !g0.includes("A第5镜提示词"),
      "一条消息里只有本组该生图的提示词（跳过已放图的第 2 镜、缺提示词的第 5 镜）",
      g0.split("\n").slice(1).join(" | ")
    );
    check(
      fin.items.every((i) => i.state === "done" && i.via === "group"),
      "10 张全部按组归位成功",
      JSON.stringify(fin.items.map((i) => `${i.index}:${i.state}/${i.via}`))
    );
    check(
      singleCalls.length === 0,
      "没有触发任何单张补发",
      `singleCalls=${singleCalls.length}`
    );
    const doneEvents = events.filter((s) => s.running).map((s) => s.doneCount);
    for (const n of [1, 2, 5, 9, 10]) {
      check(doneEvents.includes(n), `进度逐张递增广播（出现过 doneCount=${n}）`, JSON.stringify(doneEvents.slice(0, 12)));
    }
    const after = store.getStoryboard(b1.id);
    check(
      after.shots.filter((s) => s.imagePath).length === 11,
      "批量后 11 个镜头有图（10 张新 + 原有第 2 镜），缺提示词那镜仍空",
      `filled=${after.shots.filter((s) => s.imagePath).length}`
    );
    check(
      after.shots.filter((s) => s.imagePath).every((s) => fs.existsSync(s.imagePath)),
      "图片文件真的落盘了"
    );
    check(after.shots[4].imagePath === null, "缺提示词的镜头保持「待放图」");
    check(/共提交 4 条消息/.test(fin.summary), "汇总里写明提交条数", fin.summary);
  }

  // ---- 2) 归位硬校验：张数不符 → 一张都不绑、整组退回单发（标准 5、6）----
  {
    resetStubs();
    const b2 = makeBoard(store, 3, "B");
    // 这一组只回 2 张（要 3 张）→ 整组退回单发；单发也都失败 → 结果必须是「一张都没绑」
    groupGivePlan = [2];
    for (const s of b2.shots) singleFailPlan.set(s.imagePrompt, 99);

    await batch.startBatch(b2.id);
    const fin = await waitDone();
    check(fin.fallbackGroups === 1, "记下了 1 组「张数不符」", `fallbackGroups=${fin.fallbackGroups}`);
    check(
      fin.items.every((i) => /组内张数不符，退回单发/.test(i.note ?? "")),
      "每个镜头的留痕里写明「组内张数不符，退回单发」",
      JSON.stringify(fin.items.map((i) => (i.note ?? "").slice(0, 12)))
    );
    check(
      fin.items.every((i) => /模拟失败/.test(i.error ?? "")),
      "补发失败的原因记在 error 里，没有被留痕挤掉",
      JSON.stringify(fin.items.map((i) => (i.error ?? "").slice(0, 10)))
    );
    check(
      singleCalls.length === 3 * batch.MAX_RETRY,
      `退回单发后每镜重试 ${batch.MAX_RETRY} 次`,
      `singleCalls=${singleCalls.length}`
    );
    check(
      fin.items.every((i) => i.state === "failed" && i.via === "single"),
      "补发全失败 → 三个镜头都标 failed（没被组的 2 张误绑）",
      JSON.stringify(fin.items.map((i) => `${i.state}/${i.via}`))
    );
    const after2 = store.getStoryboard(b2.id);
    check(
      after2.shots.every((s) => s.imagePath === null),
      "该组一张都没绑（错绑比慢严重）",
      `filled=${after2.shots.filter((s) => s.imagePath).length}`
    );
    check(
      /成功 0 \/ 共 3.*失败：第 1、2、3 镜/.test(fin.summary) &&
        /1 组张数不符已退回单发/.test(fin.summary),
      "汇总是人话：点名失败镜 + 写明退回单发",
      fin.summary
    );
    check(
      fin.submitted === 1 + 3 * batch.MAX_RETRY,
      "提交条数如实记账：1 条组消息 + 9 次单发（每镜试满 3 次）",
      `submitted=${fin.submitted}`
    );
  }

  // ---- 3) 退回单发能成功，且重试够用就成功（标准 6）----
  {
    resetStubs();
    const b3 = makeBoard(store, 3, "C");
    groupGivePlan = [2]; // 张数不符 → 退回单发
    // 第 2 镜前两次失败、第 3 次成功；其余一次成功
    singleFailPlan.set(b3.shots[1].imagePrompt, 2);

    await batch.startBatch(b3.id);
    const fin = await waitDone();
    const after3 = store.getStoryboard(b3.id);
    check(
      after3.shots.every((s) => !!s.imagePath && fs.existsSync(s.imagePath)),
      "退回单发后三张都补上了",
      `filled=${after3.shots.filter((s) => s.imagePath).length}`
    );
    check(
      fin.items.every((i) => i.state === "done" && i.via === "single"),
      "三张都是「单发补发」这条路出图的",
      JSON.stringify(fin.items.map((i) => `${i.state}/${i.via}`))
    );
    check(
      fin.items[1].attempts === 3,
      "第 2 镜试到第 3 次才成功（重试真的在重试）",
      `attempts=${fin.items[1].attempts}`
    );
    check(
      singleCalls.length === 5,
      "单发总次数 = 1 + 3 + 1（含重试）",
      `singleCalls=${singleCalls.length}`
    );
  }

  // ---- 4) 中止：当前这一组跑完即停，已归位不回滚，未开始保持待放图（标准 7）----
  {
    resetStubs();
    const b4 = makeBoard(store, 5, "D");
    await batch.startBatch(b4.id);
    // 等某一组真的在跑再按中止（固定 sleep 会赶上整队跑完）
    const runningDeadline = Date.now() + 5000;
    while (Date.now() < runningDeadline && !batch.getBatchState().items.some((i) => i.state === "running")) {
      await sleep(5);
    }
    const cancelState = batch.cancelBatch();
    check(cancelState.cancelling === true, "中止请求已接受（等当前这一组跑完）");
    const fin = await waitDone();
    const doneN = fin.items.filter((i) => i.state === "done").length;
    check(fin.running === false, "中止后队列结束");
    check(
      fin.items.filter((i) => i.state === "running" || i.state === "pending").length === 0,
      "结束后没有残留 running / pending",
      JSON.stringify(fin.items.map((i) => i.state))
    );
    check(doneN === 3, "中止时当前这一组跑完才停（3 张 = 一组）", `done=${doneN}`);
    check(
      fin.items.filter((i) => i.state === "skipped").length === 2,
      "第二组两张全部标 skipped",
      `skipped=${fin.items.filter((i) => i.state === "skipped").length}`
    );
    const after4 = store.getStoryboard(b4.id);
    check(
      after4.shots.slice(0, 3).every((s) => !!s.imagePath) && after4.shots.slice(3).every((s) => !s.imagePath),
      "已归位的图不回滚；未开始的保持「待放图」",
      `filled=${after4.shots.filter((s) => s.imagePath).length}`
    );
    check(/已中止/.test(fin.summary), "汇总里写明是中止", fin.summary);
    check(/共提交 1 条消息/.test(fin.summary), "中止后提交条数也是准的（只发了那一组）", fin.summary);
  }

  // ---- 5) 没有可排队的镜头时不启动，并给出原因（标准 1）----
  {
    resetStubs();
    const b5 = makeBoard(store, 1, "E");
    const seed = path.join(SANDBOX, "seed2.png");
    fs.writeFileSync(seed, REAL_PNG);
    store.attachShotImage(b5.id, b5.shots[0].id, seed);
    const r5 = await batch.startBatch(b5.id);
    check(r5.started === false, "全部已放图时不启动队列");
    check(/没有需要生图的镜头/.test(r5.error || ""), "并说明原因", r5.error || "");

    const b6 = store.createStoryboard({
      title: "缺提示词方案-F",
      hook: "h",
      style: "s",
      shots: [
        { caption: "有提示词", imagePrompt: "F能生图" },
        { caption: "没提示词", imagePrompt: "" },
      ],
    });
    const r6 = await batch.startBatch(b6.id);
    check(r6.state.total === 1, "缺提示词的镜头不排队", `total=${r6.state.total}`);
    await waitDone();
  }

  // ============ B) 冻结闸门：有任务在跑时关抽屉不许冻页面 ============
  const server = http.createServer((_req, res) => {
    res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" }).end(
      "<!doctype html><html><body><div contenteditable=\"true\"></div></body></html>"
    );
  });
  await new Promise((res) => server.listen(0, "127.0.0.1", res));
  process.env.BAOLUO_DOUBAO_URL = `http://127.0.0.1:${server.address().port}/`;

  const win = new BrowserWindow({ width: 1000, height: 700, show: true, x: 0, y: 0 });
  doubao.setDoubaoVisible(win, true);
  doubao.setDoubaoBounds({ x: 0, y: 46, width: 700, height: 600 });
  const readyDeadline = Date.now() + 30000;
  while (Date.now() < readyDeadline && doubao.getDoubaoState().status !== "ready") {
    await sleep(100);
  }
  check(doubao.getDoubaoState().status === "ready", "本地页面抽屉已打开");

  // 没有任务时，关抽屉会冻结页面（正常行为：省电、不再轮询）
  doubao.setDoubaoVisible(win, false);
  await sleep(200);
  check(
    doubao.getGenerationGuardState().frozen === true,
    "空闲时关抽屉：页面被冻结（原行为保留）",
    JSON.stringify(doubao.getGenerationGuardState())
  );

  // 有任务在跑时，关抽屉不许冻结
  doubao.setDoubaoVisible(win, true);
  const reDeadline = Date.now() + 20000;
  while (Date.now() < reDeadline && doubao.getDoubaoState().status !== "ready") {
    await sleep(100);
  }
  doubao.beginGeneration();
  doubao.setDoubaoVisible(win, false);
  await sleep(200);
  const guard = doubao.getGenerationGuardState();
  check(guard.busy === 1, "任务在跑（busy=1）", JSON.stringify(guard));
  check(
    guard.frozen === false,
    "任务在跑时关抽屉：页面不被冻结，生成可以继续（标准 8 的前提）",
    JSON.stringify(guard)
  );
  doubao.endGeneration();
  // 任务结束后再关抽屉，应该能冻结
  doubao.setDoubaoVisible(win, false);
  await sleep(200);
  check(
    doubao.getGenerationGuardState().frozen === true,
    "任务结束后关抽屉：恢复冻结",
    JSON.stringify(doubao.getGenerationGuardState())
  );

  /*
   * 单张生图和批量互斥：豆包只有一个输入框，两边同时填词会互相打断。
   * 这里手工把 busy 打上去，验 startBatch 会拒绝，而不是真跑一张。
   */
  resetStubs();
  const b7 = makeBoard(store, 2, "G");
  doubao.beginGeneration();
  const busy = await batch.startBatch(b7.id);
  check(busy.started === false, "单张生图在途时不启动批量队列");
  check(/有一张图正在生成/.test(busy.error || ""), "并说明原因", busy.error || "");
  check(
    busy.state.running === false && busy.state.boardId !== b7.id,
    "被拒时没有启动新队列，也没改动上一趟的结论",
    `running=${busy.state.running} boardId=${busy.state.boardId === b7.id ? "G(错)" : "不是G"}`
  );
  doubao.endGeneration();
  const free = await batch.startBatch(b7.id);
  check(free.started === true && free.state.total === 2, "busy 解除后同方案可正常启动", `total=${free.state.total}`);
  await waitDone();

  doubao.disposeDoubao(win);
  win.destroy();
  server.close();
  console.log(failures ? `\n${failures} 项未通过` : "\n全部通过");
  app.exit(failures ? 1 : 0);
})().catch((e) => {
  console.error("FAIL  批量生图测试抛错 —", e?.stack || e?.message || e);
  app.exit(1);
});
