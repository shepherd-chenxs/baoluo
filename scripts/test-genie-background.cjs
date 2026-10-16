/*
 * SPDX-License-Identifier: GPL-3.0-only
 * Copyright (c) 2026 宝螺 / Baoluo contributors
 * 本文件属于「宝螺 / Baoluo」。除 GPL-3.0 外还适用 ADDITIONAL_TERMS.md 里的附加条款：
 * 分发时须保留来源署名；修改版对外分发时不得沿用「宝螺」名称与图标。
 */
/**
 * 后台下载（v0.8.13）的回归测试。
 *
 * 界面依赖的契约是「点下载立即返回、进度/结局另行通知」，其中任何一条破掉，
 * 用户体验就会退回「界面干等几分钟」或者「出现两个下载进程抢同一份目录」：
 *
 *   1. 受理即返回：startDownloadInBackground 同步返回，不等下载结束
 *   2. 受理后立刻可从 task() 看到「下载中」（界面不会先闪一下「未下载」）
 *   3. 同一个模型重复点：并到正在跑的任务上，不再起第二个进程
 *   4. 换一个模型：同步拒绝（绝不并行两个下载）
 *   5. 取消：能立刻在真正联网之前生效，快照清空
 *   6. 结局通知：成功 / 取消 / 失败 三种收尾都要通知到，且不残留任务状态
 *
 * 整个测试不联网、不起真子进程：随包运行时位置放一个假的 python.exe，
 * 配合「取消标记先于微任务」的时序，真实下载路径走不到 HTTP 请求那一步。
 *
 * 需要先构建：npm run build:main
 */
const Module = require("node:module");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

let fail = 0;
function check(name, cond, extra) {
  console.log(`${cond ? "PASS" : "FAIL"}  ${name}${cond || !extra ? "" : `  —— ${extra}`}`);
  if (!cond) fail++;
}
const tick = (ms = 0) => new Promise((r) => setTimeout(r, ms));

// ---------------------------------------------------------------------------
// 环境：临时 userData + 临时的「随包运行时」目录（只有个空 python.exe 占位）
// ---------------------------------------------------------------------------
const USER_DATA = fs.mkdtempSync(path.join(os.tmpdir(), "baoluo-bg-ud-"));
const APP_PATH = fs.mkdtempSync(path.join(os.tmpdir(), "baoluo-bg-app-"));
// process.resourcesPath 是 Electron 才有的全局量，纯 node 下用它会让 path.join 抛错
process.resourcesPath = APP_PATH;
const FAKE_PYTHON =
  process.platform === "win32"
    ? path.join(APP_PATH, "python", "python.exe")
    : path.join(APP_PATH, "python", "bin", "python3");
fs.mkdirSync(path.dirname(FAKE_PYTHON), { recursive: true });
fs.writeFileSync(FAKE_PYTHON, "");

const electronStub = {
  app: {
    getPath: (k) => (k === "userData" ? USER_DATA : os.tmpdir()),
    setPath: () => {},
    isPackaged: true,
    getAppPath: () => APP_PATH,
    getVersion: () => "0.0.0",
  },
};
const origLoad = Module._load;
Module._load = function (request) {
  if (request === "electron") return electronStub;
  return origLoad.apply(this, arguments);
};

const { genieManager } = require("../dist/main/dialogue/genie-manager.js");

async function main() {
  // -------------------------------------------------------------------------
  // 1~4) 受理即返回 + 快照立即可见 + 并发守卫
  // -------------------------------------------------------------------------
  const progress = [];
  const send = (p) => progress.push(p);
  const done = [];
  const onDone = (r) => done.push(r);

  const ret = genieManager.startDownloadInBackground(send, "feibi", onDone);
  check("startDownloadInBackground 同步返回（不等下载结束）", ret === undefined);
  check(
    "受理后立刻能看到「下载中」（界面不会先闪「未下载」）",
    genieManager.task().downloadingKey === "feibi",
    JSON.stringify(genieManager.task())
  );
  check("快照同时带上了 state/message 字段", typeof genieManager.task().state === "string");

  // 同一个模型再点一次：并到正在跑的任务上，不抛错、也不多一个任务
  let dupThrew = false;
  try {
    genieManager.startDownloadInBackground(send, "feibi", onDone);
  } catch {
    dupThrew = true;
  }
  check("同一个模型重复点：不报错、直接并入", !dupThrew);
  check("同一个模型重复点：没有起第二个任务", genieManager.task().downloadingKey === "feibi");

  // 换一个模型：必须被同步拒绝
  let otherErr = "";
  try {
    genieManager.startDownloadInBackground(send, "mika", onDone);
  } catch (e) {
    otherErr = String(e && e.message);
  }
  check("换一个模型：同步拒绝，不并行下载", /正在下载/.test(otherErr), otherErr);

  // -------------------------------------------------------------------------
  // 5) 取消：标记先于微任务生效 → 还没联网就收尾
  // -------------------------------------------------------------------------
  await genieManager.cancelDownload();
  await tick(30);
  check("取消后任务状态清空", genieManager.task().downloadingKey === null);
  check(
    "取消在「准备」阶段就生效：除受理时那条准备提示外，没有任何后续步骤",
    progress.length <= 1 && progress.every((p) => /正在准备/.test(p.message)),
    JSON.stringify(progress.map((p) => `${p.phase}:${p.message}`))
  );
  check(
    "没有收到安装阶段事件（说明 prepare 在检查点就被拦下，没起 pip / 下载脚本）",
    !progress.some((p) => p.phase === "install"),
    JSON.stringify(progress.map((p) => p.message))
  );
  check(
    "取消的收尾通知发到了界面（ok=false, cancelled=true）",
    done.length === 1 && done[0].ok === false && done[0].cancelled === true,
    JSON.stringify(done)
  );
  check("取消通知里带上了本次任务的角色 key", done[0] && done[0].key === "feibi");

  // -------------------------------------------------------------------------
  // 6) 结局通知：成功 / 取消 / 失败（把真实 prepare 换成假的，不联网）
  // -------------------------------------------------------------------------
  const realPrepare = genieManager.prepare;

  // 成功
  genieManager.prepare = async (sendFn) => {
    sendFn({ phase: "download", message: "正在下载语音模型…", percent: 42 });
    return "ok";
  };
  const okDone = [];
  genieManager.startDownloadInBackground(send, "mika", (r) => okDone.push(r));
  await tick(30);
  check(
    "成功：通知 ok=true 且带一句人话",
    okDone.length === 1 && okDone[0].ok === true && /已就绪/.test(okDone[0].message),
    JSON.stringify(okDone)
  );
  check("成功：任务状态清空（可再次下载）", genieManager.task().downloadingKey === null);
  check("成功：进度事件透传给了界面", progress.some((p) => p.percent === 42));

  // 取消
  genieManager.prepare = async () => "cancelled";
  const cancelDone = [];
  genieManager.startDownloadInBackground(send, "mika", (r) => cancelDone.push(r));
  await tick(30);
  check(
    "取消：通知 ok=false 且标明 cancelled",
    cancelDone.length === 1 && cancelDone[0].ok === false && cancelDone[0].cancelled === true,
    JSON.stringify(cancelDone)
  );

  // 失败：错误信息要原样带回界面（含归类后的原因）
  genieManager.prepare = async () => {
    throw new Error("语音合成环境安装失败（磁盘空间不足），请重试。");
  };
  const failDone = [];
  genieManager.startDownloadInBackground(send, "mika", (r) => failDone.push(r));
  await tick(30);
  check(
    "失败：通知 ok=false 且带上原因",
    failDone.length === 1 && failDone[0].ok === false && /磁盘空间不足/.test(failDone[0].message),
    JSON.stringify(failDone)
  );
  check("失败：任务状态也要清空（否则界面永远卡在「下载中」）", genieManager.task().downloadingKey === null);

  genieManager.prepare = realPrepare;

  // -------------------------------------------------------------------------
  // 7) 退出收尾：不能再留孤儿进程（这里只验证不抛错、状态可清）
  // -------------------------------------------------------------------------
  let shutdownThrew = false;
  try {
    genieManager.shutdown();
  } catch (e) {
    shutdownThrew = true;
  }
  check("shutdown() 不抛错", !shutdownThrew);

  for (const d of [USER_DATA, APP_PATH]) {
    try {
      fs.rmSync(d, { recursive: true, force: true });
    } catch {
      /* 忽略 */
    }
  }
  process.exit(fail ? 1 : 0);
}

main().catch((e) => {
  console.error("测试异常:", e);
  process.exit(1);
});
