/**
 * 豆包独立窗口测试（必须在 Electron 下跑）。
 *
 *   npm run test:doubao
 *
 * 不连真实豆包：起一个本地 HTTP 服务当替身页面，页面里每 300ms 打一次请求，
 * 于是「关掉窗口后不再联网」能直接数请求数验证，不受外网和豆包改版影响。
 *
 * 覆盖：懒加载、打开后窗口可见、关闭后不再联网、关闭只隐藏不销毁（重开秒回）、
 *      重开能恢复、用户点豆包窗口自己的 ✕ 也只是隐藏、站外跳转不开新窗口、
 *      非 http 协议不导航、登录态分区落在数据目录里、主窗口关闭时清理豆包窗口。
 * （v1.0.0 时代还有「占位盒归零即隐藏 / 改尺寸跟随」两条——豆包换成独立窗口后
 *   位置由用户自己拖，setDoubaoBounds 只保留为兼容 no-op，这里验证它不崩即可。）
 */
const http = require("node:http");
const path = require("node:path");
const fs = require("node:fs");
const { app, BrowserWindow } = require("electron");

const ROOT = path.join(__dirname, "..");
const SANDBOX = path.join(ROOT, "tmp", "doubao-drawer-test");

/*
 * 分两趟跑（由 scripts/test-doubao-drawer-runner.cjs 依次拉起两个进程），
 * 验证「登录态跨重启保留」：
 *   第 1 趟：正常跑完功能检查，最后往分区里写一个 cookie 并落盘；
 *   第 2 趟：新起一个 Electron 进程，只读那个 cookie，看还在不在。
 *
 * 为什么必须分成两个进程、而且不能由第 1 趟自己 spawn 第 2 趟：
 * Chromium 对同一个 userData 目录有独占锁，父进程还活着时子进程起不来。
 */
const PHASE2 = process.argv.includes("--phase2");
const PHASE2_OUT = path.join(SANDBOX, "phase2-result.txt");

if (PHASE2) {
  app.setPath("userData", SANDBOX); // 复用第 1 趟的目录，不清空
  (async () => {
    await app.whenReady();
    const ses = require("electron").session.fromPartition("persist:doubao");
    const cookies = await ses.cookies.get({ url: "https://www.doubao.com" });
    const hit = cookies.find((c) => c.name === "baoluo-test-login");
    const ok = !!hit && hit.value === "kept";
    // 结果同时写文件（runner 读）和 stdout（人工看）
    fs.writeFileSync(
      PHASE2_OUT,
      `${ok ? "PASS" : "FAIL"}  重启后登录态仍在（分区 cookie 保留） — found=${cookies.length} value=${hit ? hit.value : "none"}\n`,
      "utf8"
    );
    console.log(
      `${ok ? "PASS" : "FAIL"}  重启后登录态仍在（分区 cookie 保留） — found=${cookies.length} value=${hit ? hit.value : "none"}`
    );
    app.exit(ok ? 0 : 1);
  })();
  return;
}

fs.rmSync(SANDBOX, { recursive: true, force: true });
fs.mkdirSync(SANDBOX, { recursive: true });
app.setPath("userData", SANDBOX);

let failures = 0;
function check(ok, label, extra = "") {
  console.log(`${ok ? "PASS" : "FAIL"}  ${label}${extra ? " — " + extra : ""}`);
  if (!ok) failures++;
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** 替身页面：每 300ms 打一次 /tick，用来数「关掉窗口后还有没有在联网」 */
const PAGE = [
  '<!doctype html><html><head><meta charset="utf-8"><title>替身豆包</title></head>',
  "<body><h1>替身豆包</h1>",
  "<script>setInterval(() => { fetch('/tick').catch(() => {}); }, 300);</script>",
  "</body></html>",
].join("");

let requests = 0;
const server = http.createServer((req, res) => {
  if (req.url.startsWith("/tick")) {
    requests++;
    res.writeHead(204).end();
    return;
  }
  res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" }).end(PAGE);
});

/** 等条件成立，超时返回 null */
async function waitFor(fn, timeoutMs = 15000, stepMs = 200) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const hit = fn();
    if (hit) return hit;
    await sleep(stepMs);
  }
  return null;
}

/** 豆包独立窗口：主窗口（win）之外的那个 BrowserWindow */
function findPanel() {
  return BrowserWindow.getAllWindows().find((w) => w !== win && !w.isDestroyed()) || null;
}

let win;

(async () => {
  await app.whenReady();

  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  process.env.BAOLUO_DOUBAO_URL = `http://127.0.0.1:${server.address().port}/`;

  const doubao = require(path.join(ROOT, "dist", "main", "doubao.js"));
  win = new BrowserWindow({ width: 1200, height: 800, show: false });

  // --- 1) 懒加载 ---
  check(doubao.getDoubaoState().attached === false, "未打开时窗口未创建（懒加载）");
  check(requests === 0, "未打开时不发起任何请求", `requests=${requests}`);

  // --- 2) 打开 ---
  doubao.setDoubaoVisible(win, true);
  const ready = await waitFor(() =>
    doubao.getDoubaoState().status === "ready" ? doubao.getDoubaoState() : null
  );
  check(!!ready, "打开后页面加载完成（status=ready）", `status=${doubao.getDoubaoState().status}`);
  check(doubao.getDoubaoState().visible === true, "加载完成后窗口可见");
  const panel = findPanel();
  check(!!panel, "豆包窗口是独立的 BrowserWindow（不在主窗口 DOM 里）");
  check(!!panel && panel.isVisible(), "独立窗口对用户可见");
  // 替身页面每 300ms 才打一次 /tick，等两拍再数
  await sleep(1000);
  check(requests > 0, "打开后有网络请求", `requests=${requests}`);

  // --- 2.5) setDoubaoBounds 只是兼容 no-op：调用不崩、状态不变 ---
  doubao.setDoubaoBounds({ x: 0, y: 46, width: 700, height: 700 });
  await sleep(200);
  check(
    doubao.getDoubaoState().visible === true && !!findPanel(),
    "setDoubaoBounds 兼容入口 no-op（不崩、不改变窗口状态）"
  );

  // --- 3) 站外跳转不开新窗口 ---
  const wc = panel.webContents;
  const winsBefore = BrowserWindow.getAllWindows().length;
  await wc.executeJavaScript("window.open('https://example.com','_blank'); 1;", true);
  await sleep(1500);
  check(
    BrowserWindow.getAllWindows().length === winsBefore,
    "window.open 没有新开窗口",
    `before=${winsBefore} after=${BrowserWindow.getAllWindows().length}`
  );

  // --- 4) 非 http(s) 协议不导航 ---
  await wc.executeJavaScript("location.href='doubao://hack'; 1;", true).catch(() => {});
  await sleep(1000);
  const after = wc.getURL();
  check(/^https?:\/\//i.test(after), "非 http(s) 协议被拦下，仍停在 http 页面", `after=${after}`);

  // --- 5) 登录态分区落在数据目录里 ---
  const partDir = path.join(SANDBOX, "Partitions", "doubao");
  check(fs.existsSync(partDir), "分区目录落在数据目录下（可随迁移一起走）", partDir);

  // --- 6) 用户点豆包窗口自己的 ✕：只隐藏、不销毁 ---
  const panelBeforeClose = findPanel();
  panelBeforeClose.close();
  await sleep(400);
  check(doubao.getDoubaoState().visible === false, "点窗口 ✕ 后状态为不可见");
  check(doubao.getDoubaoState().attached === true, "点窗口 ✕ 只隐藏、不销毁（close 被拦成 hide）");
  check(findPanel() === panelBeforeClose, "窗口实例还在（没有真的关掉）");

  // --- 7) API 关闭 = 隐藏 + 冻结：页面保留（重开秒回），且不再联网 ---
  doubao.setDoubaoVisible(win, true);
  await waitFor(() => doubao.getDoubaoState().visible);
  doubao.setDoubaoVisible(win, false);
  check(doubao.getDoubaoState().visible === false, "关闭后窗口不可见");
  check(doubao.getDoubaoState().attached === true, "关闭只隐藏、不销毁（重开不用重载）");
  check(findPanel() === panelBeforeClose, "关闭后还是同一个窗口实例");
  await sleep(1200); // 让在途请求收尾
  const frozenBase = requests;
  await sleep(4000);
  check(
    requests === frozenBase,
    "关闭后 4 秒内不再发起新请求（冻结生效）",
    `base=${frozenBase} now=${requests}`
  );

  // --- 8) 重新打开：窗口复用，不需要重新加载 ---
  const t0 = Date.now();
  doubao.setDoubaoVisible(win, true);
  const ready2 = await waitFor(() =>
    doubao.getDoubaoState().status === "ready" && doubao.getDoubaoState().visible
      ? doubao.getDoubaoState()
      : null
  );
  check(!!ready2, "重新打开后立刻可见（复用窗口，不重新加载）");
  check(
    Date.now() - t0 < 500,
    "重开耗时 < 500ms（回归：曾因关闭即销毁而要 3 秒）",
    `${Date.now() - t0}ms`
  );
  check(findPanel() === panelBeforeClose, "重开后仍是同一个窗口实例");

  // --- 9) 主窗口关闭时清理豆包窗口 ---
  doubao.disposeDoubao(win);
  check(doubao.getDoubaoState().attached === false, "主窗口关闭后豆包窗口已销毁");
  check(findPanel() === null, "豆包窗口不再存在");

  // --- 9.5) 迁移前释放：窗口销毁、且再次销毁不报错 ---
  doubao.setDoubaoVisible(win, true);
  await waitFor(() => doubao.getDoubaoState().attached);
  doubao.releaseDoubaoBeforeMigration();
  check(doubao.getDoubaoState().attached === false, "迁移前释放：窗口已销毁（不再占用分区文件）");
  doubao.releaseDoubaoBeforeMigration(); // 重复调用不应抛错
  check(true, "迁移前释放可重复调用（幂等，不抛错）");

  // --- 10) 写一个假登录 cookie，落盘后另起进程验证「重启后还在」 ---
  const ses = require("electron").session.fromPartition("persist:doubao");
  await ses.cookies.set({
    url: "https://www.doubao.com",
    name: "baoluo-test-login",
    value: "kept",
    expirationDate: Math.floor(Date.now() / 1000) + 3600,
  });
  doubao.flushDoubaoStorage();
  const written = (await ses.cookies.get({ url: "https://www.doubao.com" })).find(
    (c) => c.name === "baoluo-test-login"
  );
  check(!!written, "已写入测试登录 cookie（用于验证跨重启保留）");

  win.destroy();
  server.close();
  // 等 Chromium 把 cookie 真正写进磁盘（它在后台按批刷盘）
  await sleep(2500);
  doubao.flushDoubaoStorage();
  await sleep(500);
  console.log(failures ? `\n${failures} 项未通过` : "\n第 1 趟全部通过");
  app.exit(failures ? 1 : 0);
})().catch((e) => {
  console.error("FAIL  豆包独立窗口测试抛错 —", e?.stack || e?.message || e);
  app.exit(1);
});
