/**
 * 试验：豆包能不能「一次发送、出多张图」，以及图能不能按提示词顺序归位。
 *
 *   npm run experiment:doubao-multi            （默认 3 张）
 *   npm run experiment:doubao-multi -- --count=5 --minutes=8
 *
 * 这不是测试，不判对错，只采集事实并落盘到 tmp/doubao-multi/：
 *   1) 一条消息里写「给我生成 N 张图片，第1张…第2张…」，豆包实际回几张；
 *   2) 回图在 DOM 里的顺序是否就是提示词顺序（决定「能不能靠顺序归位」）；
 *   3) 全程发了几条提交类请求（回答「多次操作会不会更像第三方工具」）。
 *
 * 用真实登录态：复用产品同一个分区 persist:doubao（<数据目录>/Partitions/doubao）。
 * 所以跑之前必须先退出宝螺（npm run dev / 打包版），否则分区被占用、拿不到 cookie。
 *
 * 填词 / 提交 / 抓图的判据逐字复刻 src/main/doubao.ts 里实测过的那套，
 * 但不复用它的函数：它的视图绑在产品窗口上，试验要自己开一个窗口。
 */
const path = require("node:path");
const fs = require("node:fs");
const { app, BrowserWindow, session } = require("electron");

const ROOT = path.join(__dirname, "..");
const OUT = path.join(ROOT, "tmp", "doubao-multi");
const PARTITION = "persist:doubao";
const DOUBAO_URL = "https://www.doubao.com/chat/create-image";
const UA_DESKTOP =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 " +
  "(KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36";

const argv = process.argv.slice(1).filter((a) => a.startsWith("--"));
const getArg = (name, dft) => {
  const hit = argv.find((a) => a.startsWith(`--${name}=`));
  return hit ? hit.split("=")[1] : dft;
};
const COUNT = Math.max(2, parseInt(getArg("count", "3"), 10) || 3);
const WAIT_MS = Math.max(1, parseInt(getArg("minutes", "6"), 10) || 6) * 60_000;

/**
 * 跟产品一样解析数据目录：环境变量 > 指针文件 > 默认值。
 * 必须在 app ready 之前算出来并 setPath——分区目录（登录态所在）是按 userData
 * 派生的，ready 之后再改就晚来了。这里不用 app.getPath，改用 %APPDATA%，
 * 为的就是在模块加载阶段就能读指针文件。
 */
function resolveDataDir() {
  if (process.env.BAOLUO_DATA_DIR) return path.resolve(process.env.BAOLUO_DATA_DIR);
  const appData = process.env.APPDATA || path.join(process.env.USERPROFILE || "", "AppData", "Roaming");
  for (const p of [path.join("C:\\Baoluo\\data", "data-root.txt"), path.join(appData, "Baoluo", "data-root.txt")]) {
    try {
      const raw = fs.readFileSync(p, "utf-8").trim();
      if (raw && fs.existsSync(raw)) return path.resolve(raw);
    } catch {}
  }
  try {
    if (fs.existsSync("C:\\Baoluo\\data")) return "C:\\Baoluo\\data";
  } catch {}
  return path.join(appData, "Baoluo");
}

const DATA_DIR = resolveDataDir();
app.setPath("userData", DATA_DIR);

const logLines = [];
const t0 = Date.now();
function say(line) {
  const rel = ((Date.now() - t0) / 1000).toFixed(1).padStart(7);
  const text = `[${rel}s] ${line}`;
  console.log(text);
  logLines.push(text);
}
function dump() {
  try {
    fs.mkdirSync(OUT, { recursive: true });
    fs.writeFileSync(path.join(OUT, "timeline.log"), logLines.join("\n") + "\n", "utf8");
  } catch {}
}

/** 每个提示词都是肉眼一眼能分开的画面——这样才看得出「顺序对不对」 */
const SUBJECTS = [
  "一只红色热气球飘在雪山之上，清晨金色光线",
  "一头蓝色鲸鱼在星空下的海面上跃起，夜晚",
  "一个绿色机器人在霓虹灯街道上淋雨，赛博朋克",
  "一只白色猫头鹰停在秋天的枫树枝头，橙色落叶",
  "一辆紫色复古汽车停在沙漠公路边，黄昏",
  "一只橙色狐狸坐在雪地里，背景是绿色极光",
];

/**
 * 画面尾缀：跟产品实际发给豆包的一致（见 src/main/storyboard/ai.ts 的提示词约定）。
 * 带上它才验得出「多段各自带尾缀」会不会让豆包只出一张图或改变画幅。
 */
const TAIL = "竖屏 9:16，无文字无水印，写实电影感";

function buildPrompt(n) {
  const lines = SUBJECTS.slice(0, n).map(
    (s, i) => `第${i + 1}张：${s}，${TAIL}`
  );
  return `请给我生成 ${n} 张图片，每段描述单独出一张，按顺序一张一张出，不要合成一张拼图。\n${lines.join("\n")}`;
}

/* ---- 以下四段判据复刻 src/main/doubao.ts（实测过）---- */
const CLOSE_MODAL = `(() => {
  const modals = [...document.querySelectorAll('div')].filter(el => {
    const cs = getComputedStyle(el);
    if (cs.position !== 'fixed' && cs.position !== 'absolute') return false;
    const z = Number.parseInt(cs.zIndex, 10);
    if (!Number.isFinite(z) || z < 100) return false;
    const r = el.getBoundingClientRect();
    return r.width > window.innerWidth * 0.5 && r.height > window.innerHeight * 0.5;
  });
  let closed = 0;
  for (const m of modals) {
    const btn = [...m.querySelectorAll('button')].find(b => b.getAttribute('aria-label') === '关闭');
    if (btn) { btn.click(); closed++; }
  }
  return closed;
})()`;

const fillScript = (text) => `(() => {
  const ed = document.querySelector('[contenteditable="true"]');
  if (!ed) return false;
  ed.focus();
  document.execCommand('selectAll', false, null);
  document.execCommand('delete', false, null);
  document.execCommand('insertText', false, ${JSON.stringify(text)});
  return (ed.innerText || '').trim().length > 0;
})()`;

const submitScript = `(() => {
  const wrap = document.querySelector('.send-btn-wrapper');
  const btn = wrap ? wrap.querySelector('button') : null;
  if (!btn) return 'no-button';
  if (btn.disabled) return 'disabled';
  btn.click();
  return 'ok';
})()`;

/**
 * 候选图 + 归位证据。
 *
 * 除了 src 与 DOM 顺序，每张还带回「往上找到的最近一段说明文字」：
 * 豆包如果在每张图旁边写了「第2张」之类字样，那就是不用赌顺序的对齐依据。
 */
const candidatesScript = `(() => {
  const main = document.querySelector('main') || document.body;
  const imgs = [...main.querySelectorAll('img')]
    .filter(i => i.complete)
    .filter(i => i.naturalWidth >= 300 && i.naturalHeight >= 300)
    .filter(i => !i.src.includes('/rc/icon/'))
    .filter(i => !i.src.startsWith('data:image/svg'))
    // 来源判据：与 src/main/doubao.ts 的 isGeneratedCandidateUrl 保持一致。
    // 不排掉豆包自己的网页静态资源（/static/、/obj/），空状态插图会被当成生成结果
    // ——上一轮就是这么把 intro.png 当成第 4/5 张的。
    .filter(i => {
      let u;
      try { u = new URL(i.src); } catch { return false; }
      if (u.protocol !== 'http:' && u.protocol !== 'https:') return false;
      const host = u.hostname.toLowerCase();
      const path = u.pathname.toLowerCase();
      if (host.endsWith('doubao.com') && /\\/(static|obj)\\//.test(path)) return false;
      if (host.endsWith('byteacctimg.com')) return false;
      return true;
    });
  const nearbyText = (el) => {
    let node = el;
    for (let up = 0; up < 6 && node; up++) {
      node = node.parentElement;
      if (!node) break;
      const t = (node.innerText || '').trim();
      if (t && t.length < 400) return t.replace(/\\s+/g, ' ').slice(0, 160);
    }
    return '';
  };
  return imgs.map((i, order) => ({
    order,
    src: i.src,
    w: i.naturalWidth,
    h: i.naturalHeight,
    alt: i.alt || '',
    text: nearbyText(i),
  }));
})()`;

/**
 * 取图片字节。带超时——上一轮就是这里挂住 2107 秒。
 * 与 src/main/doubao.ts 的 fetchImageBase64 同款（AbortController + 上限）。
 */
const fetchScript = (src, timeoutMs = 30000) => `(async () => {
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), ${timeoutMs});
  try {
    const r = await fetch(${JSON.stringify(src)}, { signal: ctl.signal });
    if (!r.ok) throw new Error('HTTP ' + r.status);
    const blob = await r.blob();
    const buf = new Uint8Array(await blob.arrayBuffer());
    let s = '';
    const CHUNK = 0x8000;
    for (let i = 0; i < buf.length; i += CHUNK) s += String.fromCharCode.apply(null, buf.subarray(i, i + CHUNK));
    return btoa(s);
  } finally {
    clearTimeout(timer);
  }
})()`;

/** 找到会话区的滚动容器并滚到顶/底。虚拟列表不滚下去，后面的图不在 DOM 里。 */
const SCROLL_TO = (to) => `(() => {
  const main = document.querySelector('main') || document.scrollingElement || document.body;
  const box = [...document.querySelectorAll('*')].filter(el => {
    const cs = getComputedStyle(el);
    return (cs.overflowY === 'auto' || cs.overflowY === 'scroll') &&
      el.scrollHeight > el.clientHeight + 200;
  }).sort((a, b) => b.scrollHeight - a.scrollHeight)[0] || main;
  box.scrollTop = '${to}' === 'bottom' ? box.scrollHeight : 0;
  return { tag: box.className || box.tagName, h: box.scrollHeight, shown: box.clientHeight };
})()`;

const loginProbe = `(() => {
  const hasInput = !!document.querySelector('[contenteditable="true"]');
  const hasLoginBtn = [...document.querySelectorAll('button')].some(b => (b.innerText || '').trim() === '登录');
  return { rendered: hasInput || hasLoginBtn, hasLoginBtn };
})()`;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

(async () => {
  await app.whenReady();
  fs.mkdirSync(OUT, { recursive: true });
  fs.rmSync(path.join(OUT, "imgs"), { recursive: true, force: true });
  fs.mkdirSync(path.join(OUT, "imgs"), { recursive: true });

  say(`数据目录 = ${DATA_DIR}`);
  say(`计划：一条消息发 ${COUNT} 个提示词，最长等 ${Math.round(WAIT_MS / 60000)} 分钟`);
  say("提示词全文：" + buildPrompt(COUNT).replace(/\n/g, " / "));

  const ses = session.fromPartition(PARTITION);
  ses.setUserAgent(UA_DESKTOP);

  // 请求指纹：这一次发送发了几条请求、其中几条是提交类 POST
  let reqCount = 0;
  const posts = [];
  ses.webRequest.onBeforeRequest({ urls: ["https://*/*"] }, (details, cb) => {
    if (/doubao|volces|byteimg|bytedance/i.test(details.url)) {
      reqCount++;
      if (details.method === "POST" && /generate|conversation|image|prompt/i.test(details.url)) {
        posts.push({ at: ((Date.now() - t0) / 1000).toFixed(1), url: details.url.slice(0, 110) });
      }
    }
    cb({});
  });

  const win = new BrowserWindow({
    width: 1280,
    height: 900,
    x: 0,
    y: 0,
    show: true,
    title: "宝螺试验：一次发送多张提示词",
    webPreferences: { partition: PARTITION },
  });
  await win.loadURL(DOUBAO_URL);
  say("页面开始加载：" + win.webContents.getURL());

  // 等输入框渲染出来（豆包是 SPA，did-finish-load 时输入框还没挂上）
  const readyDeadline = Date.now() + 60_000;
  let loggedIn = null;
  while (Date.now() < readyDeadline) {
    await win.webContents.executeJavaScript(CLOSE_MODAL).catch(() => 0);
    const p = await win.webContents.executeJavaScript(loginProbe).catch(() => null);
    if (p && p.rendered) {
      loggedIn = !p.hasLoginBtn;
      break;
    }
    await sleep(500);
  }
  if (loggedIn === null) {
    say("结论：60 秒内没渲染出输入框或登录按钮（网络问题或已改版），试验无法继续。");
    dump();
    app.exit(2);
    return;
  }
  say(`渲染完成，登录态 = ${loggedIn ? "已登录" : "未登录"}`);
  if (!loggedIn) {
    say("结论：未登录，试验停止。请在窗口里登录后重跑。");
    dump();
    app.exit(2);
    return;
  }

  // 基线：页面上已有的图不算新出的
  const baseline = new Set(
    ((await win.webContents.executeJavaScript(candidatesScript).catch(() => [])) || []).map(
      (c) => c.src.split("?")[0]
    )
  );
  say(`基线：页面上已有 ${baseline.size} 张「像生成结果」的图`);

  let filled = false;
  const fillDeadline = Date.now() + 20_000;
  while (Date.now() < fillDeadline && !filled) {
    filled = await win.webContents
      .executeJavaScript(fillScript(buildPrompt(COUNT)))
      .catch(() => false);
    if (!filled) await sleep(300);
  }
  if (!filled) {
    say("结论：提示词填不进输入框（no-input），试验无法继续。");
    dump();
    app.exit(2);
    return;
  }
  say("提示词已填进输入框");

  let sent = "";
  const sendDeadline = Date.now() + 8_000;
  while (Date.now() < sendDeadline && sent !== "ok") {
    sent = await win.webContents.executeJavaScript(submitScript).catch(() => "throw");
    if (sent !== "ok") await sleep(150);
  }
  if (sent !== "ok") {
    say(`结论：发送按钮点不到（${sent}），试验无法继续。`);
    dump();
    app.exit(2);
    return;
  }
  const tSent = Date.now();
  say(">>> 已提交这一条消息（全程只提交这一次）");

  // 观察：张数随时间变化 + 归位证据
  let seen = [];
  const deadline = Date.now() + WAIT_MS;
  let lastCount = -1;
  let stableSince = 0;
  while (Date.now() < deadline) {
    await sleep(2000);
    await win.webContents.executeJavaScript(CLOSE_MODAL).catch(() => 0);
    /*
     * 滚到底再数：会话区是虚拟列表（实测 v_list_scroller，可视 619 / 内容 2947），
     * 不滚下去，后面的图根本没挂进 DOM，会误判成「还没出够」。
     * 上一轮就是靠这个才发现「数量够了就收」会漏图。
     */
    await win.webContents.executeJavaScript(SCROLL_TO("bottom")).catch(() => null);
    const cur = (await win.webContents.executeJavaScript(candidatesScript).catch(() => [])) || [];
    const fresh = cur.filter((c) => !baseline.has(c.src.split("?")[0]));
    if (fresh.length !== lastCount) {
      say(`新出的图：${fresh.length} 张（页面内候选共 ${cur.length} 张）`);
      fresh.forEach((c, i) =>
        say(`   位置${i + 1} ${c.w}x${c.h} alt="${c.alt}" 近旁文字="${c.text}"`)
      );
      seen = fresh;
      lastCount = fresh.length;
      stableSince = Date.now();
      if (fresh.length >= COUNT) say(`已出够 ${COUNT} 张，再等 15 秒看是否继续增加`);
    } else if (fresh.length > 0 && Date.now() - stableSince > 20_000) {
      /*
       * 张数稳定 20 秒就不再等——不管够没够。
       * 上一轮就是「够数才停」导致：62 秒时误判够 5 张、实际只有 3 张真图，
       * 然后白等了 245 秒才靠超时收尾。稳定即停，差几张由下面汇总报出来。
       */
      say(
        `张数稳定在 ${fresh.length} 张（要求 ${COUNT} 张${fresh.length < COUNT ? "，少了 " + (COUNT - fresh.length) + " 张" : ""}），停止等待`
      );
      break;
    }
  }

  say(`从提交到结束：${((Date.now() - tSent) / 1000).toFixed(1)} 秒，抓到 ${seen.length} 张新图`);

  /*
   * 顺序稳定性探针（新卡标准 5 的前提）：
   * 会话区是虚拟列表，图不在视口内会被卸载、URL 签名会刷新。
   * 所以滚到底再滚回顶，重读一次候选，看 DOM 顺序会不会变、
   * 会不会有图被卸载（数量减少）。顺序不可信，整组归位就不能做。
   */
  const orderKey = (list) => list.map((c) => c.src.split("?")[0]).join("\n");
  const beforeScroll = seen.map((c) => c.src.split("?")[0]);
  const sc1 = await win.webContents.executeJavaScript(SCROLL_TO("bottom")).catch(() => null);
  say(`滚动探针：滚到底 — ${JSON.stringify(sc1)}`);
  await sleep(3000);
  const afterBottom = ((await win.webContents.executeJavaScript(candidatesScript).catch(() => [])) || [])
    .filter((c) => !baseline.has(c.src.split("?")[0]));
  say(`滚到底后新图：${afterBottom.length} 张`);
  const sc2 = await win.webContents.executeJavaScript(SCROLL_TO("top")).catch(() => null);
  say(`滚动探针：滚回顶 — ${JSON.stringify(sc2)}`);
  await sleep(3000);
  const afterTop = ((await win.webContents.executeJavaScript(candidatesScript).catch(() => [])) || [])
    .filter((c) => !baseline.has(c.src.split("?")[0]));
  say(`滚回顶后新图：${afterTop.length} 张`);
  const sameCount = afterTop.length === beforeScroll.length;
  const sameOrder = orderKey(afterTop) === orderKey(seen);
  say(`顺序稳定性：数量一致=${sameCount}（${beforeScroll.length} → ${afterTop.length}） 顺序一致=${sameOrder}`);
  if (!sameOrder && afterTop.length && seen.length) {
    say("  滚动前：" + beforeScroll.map((s) => s.split("/").pop()).join(" , "));
    say("  滚动后：" + afterTop.map((c) => c.src.split("?")[0].split("/").pop()).join(" , "));
  }
  // 滚动会让图片重新挂载、URL 签名刷新，所以落盘用滚动后这份（拿不到就退回旧那份）
  if (sameCount && sameOrder) seen = afterTop;

  // 按 DOM 顺序编号存盘，方便肉眼看「顺序 == 提示词顺序」是否成立
  const { sniffRasterImageExt } = require(path.join(ROOT, "dist", "shared", "image-magic.js"));
  const saved = [];
  for (let i = 0; i < seen.length; i++) {
    try {
      const b64 = await win.webContents.executeJavaScript(fetchScript(seen[i].src));
      const buf = Buffer.from(b64, "base64");
      const ext = sniffRasterImageExt(buf);
      if (!ext) {
        say(`落盘位置${i + 1}：不是位图（${buf.length} 字节），跳过`);
        continue;
      }
      const file = path.join(OUT, "imgs", `pos${i + 1}${ext}`);
      fs.writeFileSync(file, buf);
      saved.push({ i: i + 1, file, bytes: buf.length });
      say(`落盘位置${i + 1}：${file}（${buf.length} 字节，${seen[i].w}x${seen[i].h}）`);
    } catch (e) {
      say(`落盘位置${i + 1} 失败 — ${e?.message ?? e}`);
    }
  }

  say("---- 事实汇总 ----");
  say(`提交类 POST：${posts.length} 条` + (posts.length ? `（${posts.map((p) => p.at + "s").join(", ")}）` : ""));
  for (const p of posts) say(`   ${p.url}`);
  say(`豆包域请求总数（本次全程）：${reqCount}`);
  say(`要求 ${COUNT} 张，落盘 ${saved.length} 张`);
  if (saved.length !== COUNT) say(`注意：张数与要求不符（差 ${COUNT - saved.length}），一次发送不保证张数`);
  say("顺序对齐：请人工看 tmp/doubao-multi/imgs/pos1..N 是否与提示词 1..N 一一对应");
  dump();
  say(`时间线已存：${path.join(OUT, "timeline.log")}`);
  app.exit(0);
})().catch((e) => {
  say("试验抛错 —" + (e?.stack || e?.message || e));
  dump();
  app.exit(1);
});
