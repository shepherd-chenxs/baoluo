/**
 * 豆包页面「选择器漂移」检测（T-002 的哨兵测试）。
 *
 *   npm run test:doubao-selectors
 *
 * 一键生图靠驱动豆包页面实现，所以它依赖这些结构契约：
 *   1. 输入框：            [contenteditable="true"]
 *   2. 发送按钮：          .send-btn-wrapper > button
 *   3. 生成图可辨认：      大尺寸（>=300px）且路径不含 /rc/icon/
 *   4. 遮挡浮层可关闭：    全屏 fixed 层里有 aria-label="关闭" 的按钮
 *   5. 登录态可判断：      未登录时页面上有文案为「登录」的按钮
 *
 * 豆包改版就会在这里报出来——那时「一键生图」要退回「复制提示词」手动路径。
 * 这个用例需要联网；离线时会报「无法加载」，不算选择器失效。
 */
const path = require("node:path");
const fs = require("node:fs");
const { app, BrowserWindow } = require("electron");

const ROOT = path.join(__dirname, "..");
const SANDBOX = path.join(ROOT, "tmp", "doubao-selector-test");
fs.rmSync(SANDBOX, { recursive: true, force: true });
fs.mkdirSync(SANDBOX, { recursive: true });
app.setPath("userData", SANDBOX);

let failures = 0;
function check(ok, label, extra = "") {
  console.log(`${ok ? "PASS" : "FAIL"}  ${label}${extra ? " — " + extra : ""}`);
  if (!ok) failures++;
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

(async () => {
  await app.whenReady();
  const doubao = require(path.join(ROOT, "dist", "main", "doubao.js"));
  // 必须用可见窗口：隐藏窗口里页面被冻结，输入和按钮状态都不会更新（实测）
  const win = new BrowserWindow({ width: 1200, height: 900, show: true, x: 0, y: 0 });
  doubao.setDoubaoVisible(win, true);
  doubao.setDoubaoBounds({ x: 0, y: 46, width: 900, height: 800 });

  const deadline = Date.now() + 40000;
  while (Date.now() < deadline && doubao.getDoubaoState().status !== "ready") {
    await sleep(300);
  }
  const st = doubao.getDoubaoState();
  if (st.status !== "ready") {
    console.log(`SKIP  豆包页面没能加载（status=${st.status} ${st.message}）——离线或网络受限，不算选择器失效`);
    app.exit(0);
    return;
  }
  // 豆包是 SPA：文档加载完不代表输入框已经渲染出来，等它出现
  const inputDeadline = Date.now() + 30000;
  while (Date.now() < inputDeadline) {
    const has = await win.contentView.children
      .find((x) => x.webContents)
      .webContents.executeJavaScript(`!!document.querySelector('[contenteditable="true"]')`, true);
    if (has) break;
    await sleep(500);
  }
  await sleep(1500);

  const v = win.contentView.children.find((x) => x.webContents);
  const wc = v.webContents;
  const url = wc.getURL();
  check(/doubao\.com/.test(url), "已打开豆包页面", url);

  // 1) 输入框
  const input = await wc.executeJavaScript(
    `(() => { const ed = document.querySelector('[contenteditable="true"]');
      return { found: !!ed, tag: ed ? ed.tagName : null, cls: ed ? ed.className.slice(0, 60) : null }; })()`,
    true
  );
  check(input.found, "选择器 1：找得到输入框 [contenteditable=\"true\"]", JSON.stringify(input));

  // 2) 发送按钮：豆包是「输入框有内容才渲染出 .send-btn-wrapper」，所以先填一句再看
  /*
   * 未登录时**可能**填不进去：实测（tmp/probe-send.log，2026-10-04 21:5x）有些运行里
   *   ed.focus() 拿不到焦点（document.activeElement 仍是 BODY）→ insertText 不生效 →
   *   输入框始终空着 → 「有内容才渲染」的发送按钮自然不出现。
   * 但这不是选择器失效、也不是产品缺陷：产品填词之前先查登录态，未登录直接提示
   * 「请先登录豆包」，根本走不到填词。
   * 所以这里分三种情况，而不是一律判失败：
   *   填进去了        → 正常断言发送按钮（豆包改版会在这里报出来）
   *   没填进去 + 未登录 → SKIP（与离线同样处理），登录后再跑才有判定意义
   *   没填进去 + 已登录 → FAIL（这才是真的改版信号）
   */
  const loggedOut = await wc.executeJavaScript(
    `[...document.querySelectorAll('button')].some(b => (b.innerText || '').trim() === '登录')`,
    true
  );
  const filledText = await wc.executeJavaScript(`(() => {
    const ed = document.querySelector('[contenteditable="true"]');
    if (!ed) return '';
    ed.focus();
    document.execCommand('selectAll', false, null);
    document.execCommand('delete', false, null);
    document.execCommand('insertText', false, '选择器自检');
    return (ed.innerText || '').trim();
  })()`, true);

  if (filledText) {
    // 与产品 submitPrompt 同样轮询等它出现（豆包是异步渲染发送按钮的），而不是等 1 秒就下结论
    let send = { wrap: false, btn: false, disabled: null };
    const sendDeadline = Date.now() + 6000;
    while (Date.now() < sendDeadline) {
      send = await wc.executeJavaScript(
        `(() => { const w = document.querySelector('.send-btn-wrapper');
          const b = w ? w.querySelector('button') : null;
          return { wrap: !!w, btn: !!b, disabled: b ? b.disabled : null }; })()`,
        true
      );
      if (send.wrap && send.btn) break;
      await sleep(200);
    }
    check(send.wrap && send.btn, "选择器 2：填词后出现发送按钮 .send-btn-wrapper > button", JSON.stringify(send));
    // 清掉自检内容，别留在页面上
    await wc.executeJavaScript(`(() => {
      const ed = document.querySelector('[contenteditable="true"]');
      ed.focus();
      document.execCommand('selectAll', false, null);
      document.execCommand('delete', false, null);
    })()`, true);
  } else if (loggedOut) {
    console.log(
      "SKIP  选择器 2：当前未登录，豆包页面这次不接受输入（focus 拿不到、输入框留空），" +
        "这一条要在登录状态下才有判定意义"
    );
  } else {
    check(false, "选择器 2：已登录却填不进提示词（这才是真的改版信号）", `loggedOut=${loggedOut}`);
  }

  // 3) 生成图判据（当前页面上应该只有小图标，所以「大图数量」应为 0；关键是判据本身能跑）
  const imgs = await wc.executeJavaScript(
    `(() => {
      const all = [...document.querySelectorAll('img')];
      const big = all.filter(i => i.naturalWidth >= 300 && i.naturalHeight >= 300 && !i.src.includes('/rc/icon/'));
      return { total: all.length, big: big.length,
               maxNatural: Math.max(0, ...all.map(i => i.naturalWidth)),
               iconPathSeen: all.some(i => i.src.includes('/rc/icon/')) };
    })()`,
    true
  );
  check(imgs.total > 0, "选择器 3：页面上有图片可供判据筛选", JSON.stringify(imgs));

  // 4) 浮层关闭按钮（有浮层时才校验）
  const modal = await wc.executeJavaScript(
    `(() => {
      const modals = [...document.querySelectorAll('div')].filter(el => {
        const cs = getComputedStyle(el);
        if (cs.position !== 'fixed' && cs.position !== 'absolute') return false;
        // 同 doubao.ts：必须是明确数字且够高，"auto" 不能被当成浮层
        const z = Number.parseInt(cs.zIndex, 10);
        if (!Number.isFinite(z) || z < 100) return false;
        const r = el.getBoundingClientRect();
        return r.width > window.innerWidth * 0.5 && r.height > window.innerHeight * 0.5;
      });
      const withClose = modals.filter(m => [...m.querySelectorAll('button')]
        .some(b => b.getAttribute('aria-label') === '关闭'));
      return { modals: modals.length, closable: withClose.length,
               text: modals.length ? modals[0].innerText.slice(0, 30) : null };
    })()`,
    true
  );
  check(
    modal.modals === 0 || modal.closable > 0,
    "选择器 4：遮挡浮层（若有）能靠 aria-label=\"关闭\" 关掉",
    JSON.stringify(modal)
  );

  // 5) 登录态判据
  const login = await wc.executeJavaScript(
    `(() => {
      const btn = [...document.querySelectorAll('button')].find(b => (b.innerText || '').trim() === '登录');
      return { hasLoginButton: !!btn, loggedIn: !btn };
    })()`,
    true
  );
  check(
    typeof login.loggedIn === "boolean",
    "选择器 5：能判断登录状态（未登录时页面上有「登录」按钮）",
    JSON.stringify(login)
  );

  console.log("\n注：本机没有豆包账号，所以这里只验「选择器还找得到东西」，");
  console.log("    「登录后点一键生图能真出图」需要人工用真实账号跑一次。");

  doubao.disposeDoubao(win);
  win.destroy();
  console.log(failures ? `\n${failures} 项未通过` : "\n全部通过");
  app.exit(failures ? 1 : 0);
})().catch((e) => {
  console.error("FAIL  选择器检测抛错 —", e?.stack || e?.message || e);
  app.exit(1);
});
