/**
 * T-004（生图开关与异常兜底）驱动测试 —— 必须在 Electron 下跑。
 *
 *   npm run test:doubao-t4
 *
 * 用本地替身页面跑**真实的编排层** dist/main/doubao-shot.js（不是测试自己抄一份逻辑），
 * 逐条对 T-004 的五条验收标准取证：
 *   标准 1  设置默认开；关掉后「一键生图」只填词不提交（且落盘，重启不弹回）
 *   标准 2  未登录时给出「请先登录豆包」，且**一次都没发起填词**
 *   标准 3  找不到输入框（豆包改版）时给可读提示 + 指向手动出口（打开豆包窗口手动生图）
 *   标准 4  抓图失败给可读原因 + 指向同一条手动出口
 *   标准 5  所有提示都是中文人话：无英文错误码、无堆栈、无 undefined
 *
 * 另外带上「登录完自动回到宝螺」的取证（登录看门狗 → doubao:loggedIn 真的发到渲染层）。
 *
 * 界面那一层（按钮长什么样、点了会不会弹）不在本用例里，见开发报告「未实测」一节。
 */
const http = require("node:http");
const path = require("node:path");
const fs = require("node:fs");
const { app, BrowserWindow, ipcMain, nativeImage } = require("electron");

const ROOT = path.join(__dirname, "..");
const SANDBOX = path.join(ROOT, "tmp", "doubao-t4-test");
fs.rmSync(SANDBOX, { recursive: true, force: true });
fs.mkdirSync(SANDBOX, { recursive: true });
app.setPath("userData", SANDBOX);
/*
 * 必须在 app ready 之前：后台生图用的是"屏幕外的普通窗口"，
 * 不关掉 Chromium 的窗口遮挡判定，页面会被判成 hidden、视口 0×0（填词直接失效）。
 */
require(path.join(ROOT, "dist", "main", "chromium-switches.js")).applyChromiumSwitches();

let failures = 0;
function check(ok, label, extra = "") {
  console.log(`${ok ? "PASS" : "FAIL"}  ${label}${extra ? " — " + extra : ""}`);
  if (!ok) failures++;
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** 生成图字节：400x400 的真 PNG（尺寸判据靠 naturalWidth，1x1 过不了） */
const SMALL_PNG = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==",
  "base64"
);
const BIG_PNG = nativeImage.createFromBuffer(SMALL_PNG).resize({ width: 400, height: 400 }).toPNG();

/**
 * 替身页面：结构对齐豆包（输入框 / 发送按钮 / 遮挡浮层），
 * 用 ?mode= 切换几种「出问题」的形态。
 */
const PAGE = [
  '<!doctype html><html><head><meta charset="utf-8"><title>替身豆包</title></head>',
  "<body>",
  '<div class="fixed inset-0" id="promo" style="position:fixed;inset:0;z-index:2000;background:rgba(0,0,0,.4)">',
  '  <button aria-label="关闭" id="promoClose">x</button>',
  "  <p>下载豆包电脑版 免费领取 30 天订阅</p>",
  "</div>",
  '<img id="icon" src="/rc/icon/logo.png" width="24" height="24">',
  '<div id="inputWrap"></div>',
  '<div id="sendWrap"></div>',
  '<div id="results"></div>',
  "<script>",
  "  const mode = new URLSearchParams(location.search).get('mode') || 'normal';",
  "  window.__mode = mode;",
  "  window.__submitted = [];",
  "  window.__fillEvents = 0;",
  "  const results = document.getElementById('results');",
  "  document.getElementById('promoClose').onclick = () => document.getElementById('promo').remove();",
  "  function addEditor() {",
  "    const ed = document.createElement('div');",
  "    ed.setAttribute('contenteditable', 'true');",
  // 记录「有没有被填过词」：标准 2 要证明未登录时一次都不填
  "    ed.addEventListener('input', () => { window.__fillEvents++; });",
  "    document.getElementById('inputWrap').appendChild(ed);",
  "    return ed;",
  "  }",
  "  function addSend(ed) {",
  "    const wrap = document.createElement('div');",
  "    wrap.className = 'send-btn-wrapper';",
  "    const btn = document.createElement('button');",
  "    btn.id = 'send'; btn.disabled = true; btn.innerText = '发送';",
  "    setInterval(() => { btn.disabled = (ed.innerText || '').trim().length === 0; }, 100);",
  "    btn.onclick = (e) => {",
  "      window.__submitted.push(ed.innerText);",
  // 记下这次点击是不是「真鼠标」事件（CDP Input.dispatchMouseEvent → isTrusted=true）
  "      window.__sendTrusted = e.isTrusted;",
  "      ed.innerHTML = '';   // 复刻豆包：发出去之后输入框清空",
  "      if (mode === 'noImage') return;",
  "      setTimeout(() => {",
  "        const img = document.createElement('img');",
  "        img.src = '/gen/' + window.__submitted.length + '.png';",
  "        img.width = 580; img.height = 580;",
  "        results.appendChild(img);",
  "      }, 1200);",
  "    };",
  "    wrap.appendChild(btn);",
  "    document.getElementById('sendWrap').appendChild(wrap);",
  "  }",
  "  if (mode === 'noRender') {",
  // 既没有输入框、也没有登录按钮：渲染判据等不到东西（模拟豆包整页改版）
  "  } else if (mode === 'loggedOut') {",
  "    const b = document.createElement('button'); b.innerText = '登录'; document.body.appendChild(b);",
  "    addEditor();",
  // 模拟「用户扫码登录成功」：登录按钮消失、页面上只剩输入框
  "  } else if (mode === 'loginAfter') {",
  "    const b = document.createElement('button'); b.innerText = '登录'; document.body.appendChild(b);",
  "    addEditor();",
  "    setTimeout(() => { b.remove(); }, 2500);",
  /*
   * 未登录 + 点「登录」会弹出扫码框：给「面板一打开就自动把登录框叫出来」取证。
   * 复刻真实页面的两件事：登录入口是文字为「登录」的按钮；点了之后出现浮层里的二维码。
   */
  "  } else if (mode === 'loginDialog') {",
  "    addEditor();",
  "    const b = document.createElement('button');",
  "    b.innerText = '登录';",
  "    b.id = 'loginEntry';",
  "    document.body.appendChild(b);",
  "    window.__loginClicks = [];",
  "    b.addEventListener('click', (e) => {",
  "      window.__loginClicks.push(e.isTrusted);",
  "      if (document.getElementById('loginDialog')) return;",
  "      const d = document.createElement('div');",
  "      d.id = 'loginDialog';",
  "      d.style.cssText = 'position:fixed;inset:0;z-index:3000;background:rgba(0,0,0,.35)';",
  "      const c = document.createElement('canvas');",
  "      c.width = 200; c.height = 200; c.style.cssText = 'width:200px;height:200px';",
  "      d.appendChild(c);",
  "      const p = document.createElement('p'); p.innerText = '扫码登录'; d.appendChild(p);",
  "      document.body.appendChild(d);",
  "    });",
  "  } else if (mode === 'noInput') {",
  // 输入框在（页面看着正常），但插词不再生效：模拟豆包改版后输入路径变了。
  // 真实实现判的就是「insertText 之后编辑框里还是空的」，所以这里拦 execCommand。
  "    addEditor();",
  "    const orig = document.execCommand.bind(document);",
  "    document.execCommand = (cmd, ...rest) => (cmd === 'insertText' ? false : orig(cmd, ...rest));",
  "  } else {",
  "    const ed = addEditor();",
  "    addSend(ed);",
  "  }",
  "</script>",
  "</body></html>",
].join("\n");

const server = http.createServer((req, res) => {
  if (req.url.startsWith("/rc/icon/")) {
    res.writeHead(200, { "Content-Type": "image/png" }).end(SMALL_PNG);
    return;
  }
  if (req.url.startsWith("/gen/")) {
    res
      .writeHead(200, { "Content-Type": "image/png", "Content-Length": String(BIG_PNG.length) })
      .end(BIG_PNG);
    return;
  }
  res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" }).end(PAGE);
});

async function waitFor(fn, timeoutMs = 30000, stepMs = 200) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const hit = await fn();
    if (hit) return hit;
    await sleep(stepMs);
  }
  return null;
}

/** 提示是不是「中文人话」：有中文，且没有英文错误码 / 堆栈 / undefined */
const BAD_TEXT = /Error invoking remote method|\bat [\w.$]+\(|ENOENT|ECONN|EPERM|ETIMEDOUT|undefined|null|\[object|DoubaoError/;
function humanReadable(msg) {
  return typeof msg === "string" && /[\u4e00-\u9fa5]/.test(msg) && !BAD_TEXT.test(msg);
}

(async () => {
  await app.whenReady();
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  const base = `http://127.0.0.1:${server.address().port}`;

  const settings = require(path.join(ROOT, "dist", "main", "dialogue", "settings.js"));
  const doubao = require(path.join(ROOT, "dist", "main", "doubao.js"));
  const shot = require(path.join(ROOT, "dist", "main", "doubao-shot.js"));
  const batch = require(path.join(ROOT, "dist", "main", "doubao-batch.js"));
  const store = require(path.join(ROOT, "dist", "main", "storyboard", "store.js"));

  // ---- 标准 1）开关默认开，且落盘 ----
  const settingsPath = path.join(SANDBOX, "settings.json");
  check(settings.isAutoSubmitImageEnabled() === true, "没写过这个键时默认开（老配置升级不会变手动挡）");

  settings.updateAppSettings({ autoSubmitImage: false });
  const onDiskOff = JSON.parse(fs.readFileSync(settingsPath, "utf-8"));
  check(settings.isAutoSubmitImageEnabled() === false, "关掉后读到的是关");
  check(
    onDiskOff.app?.autoSubmitImage === false,
    "关掉的状态真的写进了 settings.json（不是内存里的假象）",
    `app.autoSubmitImage=${JSON.stringify(onDiskOff.app?.autoSubmitImage)}`
  );

  settings.updateAppSettings({ autoSubmitImage: true });
  const onDiskOn = JSON.parse(fs.readFileSync(settingsPath, "utf-8"));
  check(
    settings.isAutoSubmitImageEnabled() === true && onDiskOn.app?.autoSubmitImage === true,
    "重新打开后落盘 true"
  );

  // ---- 标准 1 相关）关掉自动发送时，批量队列给出可读拒绝 ----
  const blocked = batch.batchAutoSubmitBlocked(false);
  check(batch.batchAutoSubmitBlocked(true) === null, "开着自动发送时批量不拦");
  check(
    typeof blocked === "string" && humanReadable(blocked) && /生图时自动发送/.test(blocked),
    "关掉自动发送时，批量被拒且理由是人话",
    blocked ?? "(null)"
  );

  // ---- 标准 5）英文异常不许端给用户 ----
  const leaked = shot.describeDoubaoFailure(new Error("Script failed at Object.<anonymous> ENOENT"));
  check(
    humanReadable(leaked.message),
    "英文堆栈类的意外异常被收成中文兜底",
    leaked.message
  );
  const passThrough = shot.describeDoubaoFailure(
    new doubao.DoubaoError("豆包页面可能已改版：找不到写提示词的输入框。", "no-input")
  );
  check(
    passThrough.code === "no-input" && passThrough.message.includes("改版"),
    "DoubaoError 的原因与 code 原样带出（界面靠 code 认按钮）",
    `${passThrough.code} / ${passThrough.message.slice(0, 20)}`
  );

  // ---- 未打开抽屉：也要是人话，不是异常 ----
  // （此时还没有任何视图，走的是 not-open 分支）
  const board = store.createStoryboard({
    title: "T-004 用例方案",
    hook: "h",
    style: "s",
    shots: [
      { caption: "正常", imagePrompt: "竖屏 9:16，一只橘猫坐在窗台" },
      { caption: "未登录", imagePrompt: "竖屏 9:16，一只柴犬在草地" },
      { caption: "改版", imagePrompt: "竖屏 9:16，一只白鸽飞过屋顶" },
      { caption: "整页没渲染", imagePrompt: "竖屏 9:16，一条小船停在湖边" },
      { caption: "抓不到图", imagePrompt: "竖屏 9:16，一盏台灯亮着" },
      { caption: "手动挡", imagePrompt: "竖屏 9:16，一杯咖啡放在桌上" },
    ],
  });
  const [sNormal, sLoggedOut, sNoInput, sNoRender, sNoImage, sManual] = board.shots.map((s) => s.id);

  const noOpen = await shot.generateShotImage({ boardId: board.id, shotId: sNormal });
  check(
    noOpen.ok === false && noOpen.code === "not-open" && humanReadable(noOpen.message),
    "抽屉没打开时返回可读失败（不是抛异常）",
    `${noOpen.code} / ${noOpen.message}`
  );

  // ---- 工作台右下角登录入口的状态查询：没打开过页面不许联网、不许猜 ----
  {
    const idleAcc = await doubao.getDoubaoAccountState();
    check(
      idleAcc.page === "idle" && idleAcc.loggedIn === null,
      "没打开过页面时：入口是 idle、登录态为 null（不为了显示状态去加载豆包）",
      JSON.stringify(idleAcc)
    );
  }

  let win = null;
  const messages = [];

  /*
   * 「登录完自动回到宝螺」的取证方式：
   *
   * 这条链路是「主进程看门狗 → webContents.send('doubao:loggedIn') → 渲染层收掉面板」，
   * 环节里最关键的是那条 IPC 真的发出去了。所以给测试窗口挂一个 preload 当见证者，
   * 收到事件就回报主进程——这样断言的就不是内部变量，而是真跨了进程的那一下。
   */
  const WATCH_PRELOAD = path.join(SANDBOX, "login-watch-preload.js");
  fs.writeFileSync(
    WATCH_PRELOAD,
    [
      'const { ipcRenderer } = require("electron");',
      'ipcRenderer.send("test:preload-alive");',
      'ipcRenderer.on("doubao:loggedIn", () => ipcRenderer.send("test:doubao-logged-in"));',
      "",
    ].join("\n")
  );
  const loginEvents = [];
  let witnessReady = false;
  ipcMain.on("test:preload-alive", () => {
    witnessReady = true;
  });
  ipcMain.on("test:doubao-logged-in", () => loginEvents.push(Date.now()));

  /**
   * 换一页替身页面。
   *
   * 只用一个窗口 + reload：反复新建/销毁窗口会让上一次导航以 ERR_FAILED 收场，
   * 干扰 did-fail-load 的判定（踩过）。
   */
  async function openMode(mode) {
    const url = `${base}/chat/create-image?mode=${mode}&t=${Date.now()}`;
    if (!win) {
      process.env.BAOLUO_DOUBAO_URL = url;
      win = new BrowserWindow({
        width: 1200,
        height: 800,
        show: true,
        x: 0,
        y: 0,
        webPreferences: { preload: WATCH_PRELOAD },
      });
      /*
       * 必须真加载一次文档，preload 才会执行：
       * 只 new 一个空窗口时渲染进程还不跑，preload 里的监听根本没装上（实测）。
       */
      void win.loadURL("about:blank");
      doubao.setDoubaoVisible(win, true);
      doubao.setDoubaoBounds({ x: 0, y: 46, width: 800, height: 700 });
    } else {
      process.env.BAOLUO_DOUBAO_URL = url;
      /*
       * 面板视图可能在前面的用例里被换成了后台 worker（prepareDoubaoHidden 会销毁它）。
       * 先要回面板视图再重载，否则下面按 contentView.children 取页面会取到 undefined。
       */
      doubao.setDoubaoVisible(win, true);
      doubao.setDoubaoBounds({ x: 0, y: 46, width: 800, height: 700 });
      // reloadDoubao 会同步把状态打回 loading，所以下面等 ready 不会误判成上一次的 ready
      doubao.reloadDoubao();
    }
    const ready = await waitFor(() => doubao.getDoubaoState().status === "ready", 20000);
    if (!ready) throw new Error(`替身页面没加载完（mode=${mode}）：${doubao.getDoubaoState().message}`);
    return win.contentView.children.find((v) => v.webContents).webContents;
  }

  // ---- 标准 2）未登录：提示「请先登录豆包」，且一次都没填词 ----
  {
    const wc = await openMode("loggedOut");
    const res = await shot.generateShotImage(
      { boardId: board.id, shotId: sLoggedOut, timeouts: { loginMs: 8000 } },
      () => {}
    );
    const filled = await wc.executeJavaScript(`window.__fillEvents`, true);
    const text = await wc.executeJavaScript(
      `(document.querySelector('[contenteditable="true"]') || {}).innerText || ''`,
      true
    );
    messages.push(res.message);
    check(res.ok === false && res.code === "not-logged-in", "未登录返回 not-logged-in", `code=${res.code}`);
    check(/请先登录豆包/.test(res.message || ""), "提示里明确说「请先登录豆包」", res.message);
    check(filled === 0, "未登录时一次都没发起填词（页面没被碰过）", `fillEvents=${filled}`);
    check(text.trim() === "", "输入框里没有留下任何提示词", JSON.stringify(text.slice(0, 20)));

    // 登录入口的状态：这一页是「有登录按钮」的形态 → 应该查到未登录
    const accOut = await doubao.getDoubaoAccountState();
    check(
      accOut.page === "ready" && accOut.loggedIn === false,
      "登录入口能查到「未登录」",
      JSON.stringify(accOut)
    );
  }

  // ---- 标准 3）找不到输入框（改版）：可读提示 + 指向复制提示词 ----
  {
    await openMode("noInput");
    const res = await shot.generateShotImage({
      boardId: board.id,
      shotId: sNoInput,
      timeouts: { fillMs: 1500 },
    });
    messages.push(res.message);
    check(res.ok === false && res.code === "no-input", "填不进词时返回 no-input", `code=${res.code}`);
    check(/改版/.test(res.message || ""), "提示里点出「豆包页面可能已改版」", res.message);
    check(/打开豆包窗口/.test(res.message || ""), "提示里指出手动出口（打开豆包窗口手动生图）", res.message);
  }

  // ---- 标准 3 之二）整页没渲染出来 ----
  {
    await openMode("noRender");
    const res = await shot.generateShotImage({
      boardId: board.id,
      shotId: sNoRender,
      timeouts: { loginMs: 1200 },
    });
    messages.push(res.message);
    check(
      res.ok === false && res.code === "not-rendered",
      "页面渲染不出来时返回 not-rendered",
      `code=${res.code}`
    );
    check(/打开豆包窗口/.test(res.message || ""), "同样给出手动出口", res.message);
  }

  // ---- 标准 4）抓图失败（等不到出图）：可读原因 + 兜底 ----
  {
    await openMode("noImage");
    const started = Date.now();
    const res = await shot.generateShotImage({
      boardId: board.id,
      shotId: sNoImage,
      timeouts: { waitMs: 2500 },
    });
    const took = Date.now() - started;
    messages.push(res.message);
    check(res.ok === false && res.code === "timeout", "等不到图时返回 timeout", `code=${res.code}`);
    check(/等.*秒还没等到豆包出图/.test(res.message || ""), "原因可读（等了多久、可能因为什么）", res.message);
    check(/打开豆包窗口/.test(res.message || ""), "抓图失败也给手动出口", res.message);
    check(took < 15000, "等待有界，不会一直挂着", `${took}ms`);
  }

  // ---- 标准 1）关掉自动发送：只填词、不提交，且不是错误 ----
  {
    const wc = await openMode("normal");
    settings.updateAppSettings({ autoSubmitImage: false });
    const res = await shot.generateShotImage({
      boardId: board.id,
      shotId: sManual,
      timeouts: { waitMs: 6000 },
    });
    const submitted = await wc.executeJavaScript(`window.__submitted.length`, true);
    const text = await wc.executeJavaScript(
      `(document.querySelector('[contenteditable="true"]') || {}).innerText || ''`,
      true
    );
    check(res.ok === true && res.filledOnly === true, "关了自动发送时返回 ok + filledOnly（不是失败）", `ok=${res.ok} filledOnly=${res.filledOnly}`);
    check(
      res.code === "manual-submit" && /点「发送」/.test(res.message || ""),
      "提示用户自己去点发送",
      res.message
    );
    check(submitted === 0, "没有替用户提交（豆包侧一次发送都没有）", `submitted=${submitted}`);
    check(
      text.trim() === "竖屏 9:16，一杯咖啡放在桌上",
      "提示词已经完整填进输入框",
      JSON.stringify(text.trim().slice(0, 24))
    );
    check(
      store.getStoryboard(board.id).shots.find((s) => s.id === sManual).imagePath === null,
      "只填词时不会给镜头绑图"
    );
  }

  // ---- 回归：开着自动发送时，正常链路照样出图并绑到镜头 ----
  {
    settings.updateAppSettings({ autoSubmitImage: true });
    await openMode("normal");
    const res = await shot.generateShotImage({
      boardId: board.id,
      shotId: sNormal,
      timeouts: { waitMs: 20000 },
    });
    check(res.ok === true && !!res.board, "自动发送开着时正常出图（ok + board）", `ok=${res.ok}`);
    const bound = store.getStoryboard(board.id).shots.find((s) => s.id === sNormal);
    check(!!bound.imagePath && fs.existsSync(bound.imagePath), "图已绑到镜头且文件真的在", bound.imagePath ?? "(null)");
    const bytes = bound.imagePath ? fs.readFileSync(bound.imagePath) : Buffer.alloc(0);
    check(
      bytes.length === BIG_PNG.length && bytes.subarray(0, 4).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47])),
      "落盘的是原样的 PNG 字节",
      `${bytes.length} 字节`
    );
    check(/\.png$/.test(bound.imagePath || ""), "扩展名按字节魔数落成 .png", path.extname(bound.imagePath || ""));
    const trusted = await win.contentView.children
      .find((v) => v.webContents)
      .webContents.executeJavaScript(`window.__sendTrusted`, true);
    check(
      trusted === true,
      "发送是「真鼠标点击」（事件 isTrusted=true，不是脚本点）",
      `isTrusted=${trusted}`
    );
  }

  /*
   * ---- 登录完成看门狗：登上了自动回宝螺，没登 / 本来就登着都不许弹人 ----
   *
   * 放在这块（而不是文件末尾）：末尾那段会换一个新窗口，而见证 preload 只挂在
   * 第一个窗口上，换窗之后这条断言就成了空转。
   */
  {
    // 见证实装了吗：没装上后面那些「0 次」都是假通过
    check(witnessReady, "见证 preload 已装配（没装上的话下面的断言不算数）");

    // 1）打开时没登录、用户也没去登：不许因为「等太久」就自动关
    await openMode("loggedOut");
    loginEvents.length = 0;
    check(doubao.isDoubaoLoginWatchActive() === true, "面板打开且未登录：看门狗在盯");
    await sleep(6000);
    check(loginEvents.length === 0, "一直没登录：不会自动关面板", `${loginEvents.length} 次`);
    check(doubao.isDoubaoLoginWatchActive() === true, "盯的动作没停（用户随时可能去登）");

    // 2）打开时没登录、用户随后扫上了：广播一次，界面据此回到宝螺
    doubao.setDoubaoVisible(win, false);
    await openMode("loginAfter");
    loginEvents.length = 0;
    const hit = await waitFor(() => loginEvents.length > 0, 15000, 200);
    check(!!hit, "登录成功后广播 doubao:loggedIn（面板自动收掉回到宝螺）", `${loginEvents.length} 次`);
    check(doubao.isDoubaoLoginWatchActive() === false, "广播完就收工，不会反复发");
    await sleep(3000);
    check(loginEvents.length === 1, "整个过程只广播一次", `${loginEvents.length} 次`);

    // 3）本来就登录着（页面上没有登录按钮）：进来看看不该被弹出去
    doubao.setDoubaoVisible(win, false);
    await openMode("normal");
    loginEvents.length = 0;
    await sleep(7000); // 比「认锚宽限期」长，足够它下完结论
    check(loginEvents.length === 0, "本来就登录着：打开面板不会被自动弹出去", `${loginEvents.length} 次`);

    // 4）面板一关就不再盯：不会在用户没看的时候误发
    await openMode("loginAfter");
    check(doubao.isDoubaoLoginWatchActive() === true, "重新打开面板后看门狗重新起步");
    doubao.setDoubaoVisible(win, false);
    check(doubao.isDoubaoLoginWatchActive() === false, "面板一关就停止盯");
  }

  /*
   * ---- 后台生图（用户无感）：页面在屏幕外的 worker 窗口里也能出图 ----
   *
   * 为什么不复用抽屉视图：把它藏起来（setVisible(false)）或挪到窗口外，
   * Chromium 都会把页面判成 hidden、视口 0×0，提示词根本填不进去
   * （实测 tmp/probe-bg-real.log —— 后台生图就是这么坏过一次的）。
   * 现在后台走的是「屏幕外的普通窗口 + 关掉窗口遮挡判定」，页面自认可见。
   */
  {
    const oldWin = win;
    process.env.BAOLUO_DOUBAO_URL = `${base}/chat/create-image?mode=normal&t=${Date.now()}`;
    win = new BrowserWindow({ width: 1200, height: 800, show: true, x: 0, y: 0 });
    doubao.prepareDoubaoHidden(win);
    if (oldWin) oldWin.destroy();

    const ready = await waitFor(
      () => doubao.getDoubaoState().status === "ready" && !doubao.getDoubaoState().visible,
      20000
    );
    const st = doubao.getDoubaoState();
    check(!!ready, "后台准备：页面就绪但对用户不可见", JSON.stringify(st));
    check(
      doubao.getGenerationGuardState().frozen === false,
      "后台准备后页面已解冻（后台页面也要能跑脚本）",
      JSON.stringify(doubao.getGenerationGuardState())
    );
    /*
     * 最要紧的一条不变量：后台页面必须**自认可见**。
     * 这条要是塌了，症状就是"填词填不进去、生图报 no-input"——极难从用户报错反推。
     */
    const workerWin = BrowserWindow.getAllWindows().find((w) => w !== win && !w.isDestroyed());
    const pageView = workerWin
      ? await workerWin.webContents.executeJavaScript(
          `({ hidden: document.hidden, visibility: document.visibilityState, w: innerWidth, h: innerHeight })`,
          true
        )
      : null;
    check(
      !!pageView && pageView.hidden === false && pageView.visibility === "visible" && pageView.w > 100,
      "后台页面自认可见（document.hidden=false、视口有尺寸）——填词可行的前提",
      JSON.stringify(pageView)
    );
    const wb = workerWin ? workerWin.getBounds() : null;
    check(
      !!wb && wb.x < -1000,
      "后台窗口在屏幕外（用户看不到）",
      `worker bounds=${JSON.stringify(wb)}`
    );
    check(
      !!workerWin && workerWin.isFocusable() === false,
      "后台窗口不可聚焦（用户点不到它，也就不会被打断）",
      `focusable=${workerWin ? workerWin.isFocusable() : "n/a"}`
    );

    // 后台生图用一张干净的镜头（否则「绑到镜头」会在上一轮的旧绑定上假通过）
    const bgBoard = store.createStoryboard({
      title: "后台生图用例",
      hook: "h",
      style: "s",
      shots: [{ caption: "后台", imagePrompt: "竖屏 9:16，一盏路灯下的长椅" }],
    });
    const bgShot = bgBoard.shots[0].id;

    // 每隔一个阶段采样一次：整个生图过程里都不许露脸、也不许被冻结
    const samples = [];
    const res = await shot.generateShotImage(
      { boardId: bgBoard.id, shotId: bgShot, timeouts: { waitMs: 20000 } },
      () => samples.push({ ...doubao.getGenerationGuardState(), visible: doubao.getDoubaoState().visible })
    );
    check(res.ok === true, "后台生图成功出图（屏幕外窗口里照样填词/提交/抓图）", `ok=${res.ok} code=${res.code ?? ""}`);
    check(samples.length > 0, "过程里有阶段回调可采样", `${samples.length} 次`);
    check(
      samples.every((s) => s.visible === false),
      "整个过程都没露脸（用户无感）",
      JSON.stringify(samples.slice(0, 3))
    );
    check(
      samples.every((s) => s.frozen === false),
      "整个过程页面都没被冻结（冻结会让豆包轮询停住）",
      JSON.stringify(samples.slice(0, 3).map((s) => s.frozen))
    );
    check(
      doubao.getDoubaoState().visible === false,
      "生图结束后依然不可见（不会突然弹出来）",
      JSON.stringify(doubao.getDoubaoState())
    );
    check(
      doubao.getGenerationGuardState().frozen === true,
      "后台闲置后自动冻回去省 CPU（下次生图前再解冻）",
      JSON.stringify(doubao.getGenerationGuardState())
    );
    const boundBg = store.getStoryboard(bgBoard.id).shots.find((s) => s.id === bgShot);
    check(!!boundBg.imagePath && fs.existsSync(boundBg.imagePath), "后台出的图照样绑到了镜头", boundBg.imagePath ?? "(null)");

    /*
     * 页面侧取证：这一次提交真的发生了（只断"发生了一次"，不断 isTrusted）。
     * 测试环境里 CDP 合成输入经常投不进去（见痕迹加固报告），产品对此有落地证明 +
     * 脚本点击兜底，所以 isTrusted 在不同机器上不稳定，不该拿来当断言。
     */
    const pageSubmitted = workerWin
      ? await workerWin.webContents.executeJavaScript(`(window.__submitted || []).length`, true)
      : 0;
    check(pageSubmitted === 1, "后台这次提交在页面侧确实发生了（只发一次）", `submitted=${pageSubmitted}`);
  }

  /*
   * ---- 面板一打开就自动把登录框叫出来 ----
   *
   * 用户点「登录豆包」的意图就是登录，不该还要他在这张陌生页面里自己找「登录」两个字。
   * 这里断的是主进程那一步：未登录时点掉登录入口（且只点一次），已登录时空操作。
   */
  {
    const wc = await openMode("loginDialog");
    const res = await doubao.openDoubaoLogin(15000);
    check(
      res.ok === true && res.alreadyLoggedIn === false && res.dialogOpened === true,
      "未登录：自动弹出登录框（点掉豆包的「登录」入口 → 扫码框出来）",
      JSON.stringify(res)
    );
    const clicks = await wc.executeJavaScript(`window.__loginClicks`, true);
    check(
      Array.isArray(clicks) && clicks.length === 1,
      "登录入口只被点了一次（真鼠标或兜底，都不重复）",
      `clicks=${JSON.stringify(clicks)}`
    );
    const dialog = await wc.executeJavaScript(`!!document.getElementById('loginDialog')`, true);
    check(dialog === true, "页面上确实出现了扫码框", `dialog=${dialog}`);

    // 已登录：空操作（进来只是想看生成的用户不该被打扰）
    const wc2 = await openMode("normal");
    const res2 = await doubao.openDoubaoLogin(15000);
    check(
      res2.ok === true && res2.alreadyLoggedIn === true && res2.dialogOpened === false,
      "已登录：空操作，不点任何东西",
      JSON.stringify(res2)
    );
    const touched = await wc2.executeJavaScript(`window.__loginClicks ?? null`, true);
    check(touched === null, "已登录时一次都没碰过页面", `loginClicks=${JSON.stringify(touched)}`);
  }

  // ---- 反自动化指纹：UA 与 UA-CH 必须自洽（都带 Google Chrome、版本一致） ----
  {
    const wc = await openMode("normal");
    const fp = await wc.executeJavaScript(
      `(async () => {
        const o = { ua: navigator.userAgent, brands: null, full: null, webdriver: navigator.webdriver };
        if (navigator.userAgentData) {
          o.brands = (navigator.userAgentData.brands || []).map((b) => b.brand + '/' + b.version).join(', ');
          try {
            const hi = await navigator.userAgentData.getHighEntropyValues(['fullVersionList']);
            o.full = (hi.fullVersionList || []).map((b) => b.brand + '/' + b.version).join(', ');
          } catch (e) { o.full = 'err:' + e.message; }
        }
        return o;
      })()`,
      true
    );
    const major = process.versions.chrome.split(".")[0];
    check(
      new RegExp(`Chrome/${major}\\.0\\.0\\.0`).test(fp.ua),
      `UA 里的 Chrome 版本与本机 Chromium 一致（${major}）`,
      fp.ua
    );
    check(fp.webdriver === false, "navigator.webdriver=false（没有自动化开关痕迹）", `${fp.webdriver}`);
    check(
      /Google Chrome\//.test(fp.brands || ""),
      "UA-CH 的品牌里带 Google Chrome（否则是识别 Electron 的教科书特征）",
      `${fp.brands}`
    );
    check(
      new RegExp(`Google Chrome/${major}\\.`).test(fp.full || ""),
      "UA-CH 高熵版本号与 Chromium 实际版本一致",
      `${fp.full}`
    );

    // 登录入口的状态：这一页没有登录按钮 → 应该查到已登录
    const accIn = await doubao.getDoubaoAccountState();
    check(
      accIn.page === "ready" && accIn.loggedIn === true,
      "登录入口能查到「已登录」",
      JSON.stringify(accIn)
    );
  }

  // ---- 抖动延迟：区间内随机，不是固定节拍 ----
  {
    const d = require(path.join(ROOT, "dist", "main", "doubao.js"));
    const samples = Array.from({ length: 200 }, () => d.humanDelayMs(800, 2000));
    check(
      samples.every((n) => n >= 800 && n <= 2000),
      "humanDelayMs 落在给定区间内",
      `min=${Math.min(...samples)} max=${Math.max(...samples)}`
    );
    check(new Set(samples).size > 50, "humanDelayMs 确实在抖（不是固定值）", `${new Set(samples).size} 种取值`);
    check(
      d.humanDelayMs(5, 5) === 5 && (() => {
        const n = d.humanDelayMs(120, 30); // 传反了也不许抛，落在两个值之间
        return n >= 30 && n <= 120;
      })(),
      "边界：相等或传反了都不出错"
    );
  }

  // ---- 每日用量上限（自保闸门） ----
  {
    const quota = require(path.join(ROOT, "dist", "main", "doubao-quota.js"));
    const st = require(path.join(ROOT, "dist", "main", "dialogue", "settings.js"));
    const today = new Date();
    const day = `${today.getFullYear()}-${String(today.getMonth() + 1).padStart(2, "0")}-${String(today.getDate()).padStart(2, "0")}`;

    st.updateAppSettings({ doubaoGenDaily: { date: day, count: 1 } });
    check(quota.doubaoUsedToday() === 1, "当日用量能读出来", `${quota.doubaoUsedToday()}`);
    check(quota.doubaoDailyCapBlocked() === null, "没到上限时不拦");

    quota.noteDoubaoGenerated(2);
    check(quota.doubaoUsedToday() === 3, "出图后累加", `${quota.doubaoUsedToday()}`);

    st.updateAppSettings({ doubaoGenDaily: { date: day, count: quota.DAILY_IMAGE_CAP } });
    const blocked = quota.doubaoDailyCapBlocked();
    check(
      !!blocked && blocked.code === "daily-cap" && humanReadable(blocked.message),
      "到上限后人话拒绝",
      blocked ? blocked.message : "(null)"
    );

    // 昨天的记录不算今天的量（跨天自动归零）
    st.updateAppSettings({ doubaoGenDaily: { date: "2000-01-01", count: quota.DAILY_IMAGE_CAP } });
    check(quota.doubaoUsedToday() === 0 && quota.doubaoDailyCapBlocked() === null, "跨天自动归零");
    st.updateAppSettings({ doubaoGenDaily: { date: day, count: 0 } });
  }

  // ---- 标准 5）把上面所有失败提示过一遍筛子 ----
  const bad = messages.filter((m) => !humanReadable(m));
  check(
    messages.length >= 4 && bad.length === 0,
    `全部失败提示都是中文人话（无英文错误码 / 堆栈 / undefined）— 共 ${messages.length} 条`,
    bad.length ? JSON.stringify(bad) : ""
  );

  if (win) {
    doubao.disposeDoubao(win);
    win.destroy();
  }
  server.close();
  console.log(failures ? `\n${failures} 项未通过` : "\n全部通过");
  app.exit(failures ? 1 : 0);
})().catch((e) => {
  console.error("FAIL  T-004 用例抛错 —", e?.stack || e?.message || e);
  app.exit(1);
});
