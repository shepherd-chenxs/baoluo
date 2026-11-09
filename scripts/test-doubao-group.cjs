/**
 * 按组生图（T-003）的抓图逻辑测试 —— 必须在 Electron 下跑。
 *
 *   npm run test:doubao-group
 *
 * 用一个「会像豆包那样出多张图」的替身页跑**真实实现**
 * dist/main/doubao.js 的 generateImagesFromPrompt，验四件事：
 *   1) 一条消息出 3 张 → 按 DOM 顺序返回 3 张（顺序就是归位依据，标准 3）；
 *   2) 虚拟列表把图卸载再挂回来，也不许漏（前置实验第三轮暴露的约束）；
 *   3) 张数比要的少 → 整体失败（code=count-mismatch），不许交回半截序列（标准 5）；
 *   4) 张数比要的多、且是「够数之后才多出来」的 → 也要等一等再判，
 *      不能一够数就收（标准 5 的另一半）。
 *
 * 真机上的顺序稳定性由前置实验负责（见 T-003 试验报告第三轮）；
 * 这里验的是「我的代码有没有按那套约束写」。
 */
const http = require("node:http");
const path = require("node:path");
const fs = require("node:fs");
const { app, BrowserWindow, nativeImage } = require("electron");

const ROOT = path.join(__dirname, "..");
const SANDBOX = path.join(ROOT, "tmp", "doubao-group-test");
fs.rmSync(SANDBOX, { recursive: true, force: true });
fs.mkdirSync(SANDBOX, { recursive: true });
app.setPath("userData", SANDBOX);

let failures = 0;
function check(ok, label, extra = "") {
  console.log(`${ok ? "PASS" : "FAIL"}  ${label}${extra ? " — " + extra : ""}`);
  if (!ok) failures++;
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const SMALL_PNG = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==",
  "base64"
);
const BIG_PNG = nativeImage.createFromBuffer(SMALL_PNG).resize({ width: 400, height: 400 }).toPNG();

/** 替身页：结构与豆包一致；按 ?mode= 决定「一次发送出几张、什么时候出」 */
const PAGE = [
  '<!doctype html><html><head><meta charset="utf-8"><title>替身豆包</title></head>',
  "<body>",
  '<div class="fixed inset-0" id="promo" style="position:fixed;inset:0;z-index:2000;background:rgba(0,0,0,.4)">',
  '  <button aria-label="关闭" id="promoClose">x</button>',
  "</div>",
  '<div id="inputWrap"><div contenteditable="true"></div></div>',
  '<div class="send-btn-wrapper"><button id="send" disabled>发送</button></div>',
  // 复刻豆包的会话区：虚拟列表（超出可视高度的内容会被卸载）
  '<div id="scroller" style="overflow-y:auto;height:200px"><div id="results"></div></div>',
  "<script>",
  "  const mode = new URLSearchParams(location.search).get('mode') || 'ok3';",
  "  window.__submitted = [];",
  "  window.__clicks = [];",
  "  document.addEventListener('click', (e) => { window.__clicks.push({ t: e.target.id || e.target.tagName, x: e.clientX, y: e.clientY, trusted: e.isTrusted }); }, true);",
  "  const ed = document.querySelector('[contenteditable=\"true\"]');",
  "  const send = document.getElementById('send');",
  "  const results = document.getElementById('results');",
  "  document.getElementById('promoClose').onclick = () => document.getElementById('promo').remove();",
  "  setInterval(() => { send.disabled = (ed.innerText || '').trim().length === 0; }, 80);",
  "  /** 出图计划：[第几张, 距提交多久出现] */",
  "  const PLANS = {",
  "    ok3: [[1, 0], [2, 1200], [3, 2400]],",
  "    only2: [[1, 0], [2, 1200]],",
  "    extra4: [[1, 0], [2, 1200], [3, 2400], [4, 3600]],",
  "    slowExtra: [[1, 0], [2, 1200], [3, 2200]],",
  "  };",
  "  send.onclick = (e) => {",
  "    window.__sendTrusted = e.isTrusted;",
  "    window.__submitted.push(ed.innerText);",
  "    ed.innerHTML = '';   // 复刻豆包：发出去之后输入框清空",
  "    const plan = PLANS[mode] || PLANS.ok3;",
  "    const made = {};",
  "    for (const [n, at] of plan) {",
  "      setTimeout(() => {",
  "        const img = document.createElement('img');",
  "        img.id = 'gen' + n;",
  "        img.src = '/gen/' + n + '.png';",
  "        img.width = 580; img.height = 580;",
  "        results.appendChild(img);",
  "        made[n] = img;",
  // ok3：全部出齐之后把第 1 张从 DOM 里摘掉，再挂回来 —— 复刻虚拟列表的卸载/重挂
  "        if (mode === 'ok3' && n === 3) {",
  "          setTimeout(() => { img.ownerDocument.getElementById('gen1').remove(); }, 1600);",
  "          setTimeout(() => {",
  "            const back = document.createElement('img');",
  "            back.id = 'gen1'; back.src = '/gen/1.png'; back.width = 580; back.height = 580;",
  "            results.insertBefore(back, results.firstChild);",
  "          }, 3000);",
  "        }",
  "      }, at);",
  "    }",
  "  };",
  "</script>",
  "</body></html>",
].join("\n");

const server = http.createServer((req, res) => {
  if (req.url.startsWith("/gen/")) {
    res
      .writeHead(200, { "Content-Type": "image/png", "Content-Length": String(BIG_PNG.length) })
      .end(BIG_PNG);
    return;
  }
  res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" }).end(PAGE);
});

(async () => {
  await app.whenReady();
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  const base = `http://127.0.0.1:${server.address().port}`;

  const doubao = require(path.join(ROOT, "dist", "main", "doubao.js"));

  const win = new BrowserWindow({ width: 1200, height: 800, show: true, x: 0, y: 0 });
  const openMode = async (mode) => {
    process.env.BAOLUO_DOUBAO_URL = `${base}/chat/create-image?mode=${mode}&t=${Date.now()}`;
    doubao.setDoubaoVisible(win, true);
    doubao.setDoubaoBounds({ x: 0, y: 46, width: 800, height: 700 });
    doubao.reloadDoubao();
    const deadline = Date.now() + 20000;
    while (Date.now() < deadline && doubao.getDoubaoState().status !== "ready") await sleep(100);
    // 豆包 v1.0.0 起是独立 BrowserWindow：主窗口之外的那个就是它
    return BrowserWindow.getAllWindows().find((w) => w !== win && !w.isDestroyed()).webContents;
  };

  const MSG = [
    "请给我生成 3 张图片，每段描述单独出一张，按顺序一张一张出，不要合成一张拼图。",
    "第1张：甲画面",
    "第2张：乙画面",
    "第3张：丙画面",
  ].join("\n");

  // ---- 1) 一次发送出 3 张：按 DOM 顺序返回，且卸载重挂也不漏 ----
  {
    const wc = await openMode("ok3");
    let submittedCount = 0;
    const phases = [];
    const started = Date.now();
    const imgs = await doubao.generateImagesFromPrompt(MSG, 3, {
      timeoutMs: 25000,
      stableMs: 1500,
      onPhase: (m) => phases.push(m),
      onSubmitted: () => submittedCount++,
    });
    const took = Date.now() - started;
    check(imgs.length === 3, "一组 3 张全部返回", `n=${imgs.length}`);
    check(
      imgs.map((i) => i.src.split("/").pop()).join(",") === "1.png,2.png,3.png",
      "返回顺序 == DOM 顺序 == 提示词顺序（归位依据）",
      imgs.map((i) => i.src.split("/").pop()).join(",")
    );
    check(
      imgs.every((i) => i.ext === ".png" && i.base64.length > 0),
      "每张都取回了字节且按魔数认出是 PNG"
    );
    check(submittedCount === 1, "整组只提交一次（标准 2 的数就是靠这个回调）", `onSubmitted=${submittedCount}`);
    // 页面侧证据：点击到底有没有落地（CDP 真鼠标事件返回成功 ≠ 事件真的投到了页面）
    const pageSubmitted = await wc.executeJavaScript(`window.__submitted.length`, true);
    const pageTrusted = await wc.executeJavaScript(`window.__sendTrusted`, true);
    check(
      pageSubmitted === 1,
      "页面侧确实收到一次发送（点击真的落地了）",
      `submitted=${pageSubmitted} isTrusted=${pageTrusted}`
    );
    check(
      phases.some((m) => m.includes("3 段提示词")) && phases.some((m) => m.includes("等豆包出 3 张图")),
      "阶段提示能说明「写 3 段 / 等 3 张」",
      JSON.stringify(phases)
    );
    // 发送时输入框里的原文（替身页复刻了豆包「发出去就清空输入框」的行为，所以不能事后再读）
    const sentText = await wc.executeJavaScript(`(window.__submitted || [])[0] || ''`, true);
    check(
      sentText.includes("第1张：甲画面") && sentText.includes("第3张：丙画面"),
      "整组提示词原样进了输入框（发送时页面里的原文）",
      JSON.stringify(sentText.replace(/\n/g, " | ").slice(0, 40))
    );
    check(took > 3000, "等到了卸载/重挂之后才收工（没有「够数就收」）", `${took}ms`);
  }

  // ---- 2) 够数之后还多出来一张：要等一等再判，不能一够数就收（标准 5）----
  {
    await openMode("slowExtra");
    const msg2 = MSG.replace("3 张图片", "2 张图片").replace(/\n第3张：丙画面/, "");
    let code = "";
    let message = "";
    try {
      await doubao.generateImagesFromPrompt(msg2, 2, { timeoutMs: 20000, stableMs: 2500 });
    } catch (e) {
      code = e?.code ?? "";
      message = e?.message ?? "";
    }
    check(code === "count-mismatch", "要 2 张、实到 3 张 → 整体失败", `code=${code}`);
    check(/实到 3 张/.test(message), "失败原因里写清实到几张", message);
  }

  // ---- 3) 张数少了：整体失败，绝不交回半截序列（标准 5）----
  {
    await openMode("only2");
    let code = "";
    let message = "";
    try {
      await doubao.generateImagesFromPrompt(MSG, 3, { timeoutMs: 6000, stableMs: 1200 });
    } catch (e) {
      code = e?.code ?? "";
      message = e?.message ?? "";
    }
    check(code === "count-mismatch", "要 3 张、只出 2 张 → 整体失败（不绑半截数据）", `code=${code}`);
    check(/实到 2 张/.test(message) && /退回单张补发/.test(message), "原因可读且写明退路", message);
  }

  // ---- 4) 多出来一张：同样整体失败 ----
  {
    await openMode("extra4");
    let code = "";
    let message = "";
    try {
      await doubao.generateImagesFromPrompt(MSG, 3, { timeoutMs: 20000, stableMs: 1200 });
    } catch (e) {
      code = e?.code ?? "";
      message = e?.message ?? "";
    }
    check(code === "count-mismatch", "要 3 张、实到 4 张 → 整体失败", `code=${code}`);
    check(/实到 4 张/.test(message), "失败原因里写清实到几张", message);
  }

  doubao.disposeDoubao(win);
  win.destroy();
  server.close();
  console.log(failures ? `\n${failures} 项未通过` : "\n全部通过");
  app.exit(failures ? 1 : 0);
})().catch((e) => {
  console.error("FAIL  按组生图测试抛错 —", e?.stack || e?.message || e);
  app.exit(1);
});
