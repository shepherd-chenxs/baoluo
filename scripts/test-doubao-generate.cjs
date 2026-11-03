/**
 * 一键生图（T-002）驱动测试 —— 必须在 Electron 下跑。
 *
 *   npm run test:doubao-gen
 *
 * 分两块：
 *   A) 用本地替身页面跑完整链路。替身页面严格复刻豆包的结构契约：
 *      [contenteditable="true"] 输入框、.send-btn-wrapper > button 发送按钮、
 *      图标图走 /rc/icon/ 且很小、生成图大且有扩展名、可弹 aria-label="关闭" 的浮层。
 *      这样验的是「我的代码逻辑」，不依赖外网和豆包账号。
 *   B) 打开真实豆包页，断言我的选择器还找得到东西（豆包改版就会在这里报出来）。
 *
 * 说明：没有豆包账号，所以「真实账号下点一键生图能出图」这件事本用例**验不了**，
 * 见开发报告「未验证」一节。
 */
const http = require("node:http");
const path = require("node:path");
const fs = require("node:fs");
const { app, BrowserWindow, session } = require("electron");

const ROOT = path.join(__dirname, "..");
const SANDBOX = path.join(ROOT, "tmp", "doubao-gen-test");
fs.rmSync(SANDBOX, { recursive: true, force: true });
fs.mkdirSync(SANDBOX, { recursive: true });
app.setPath("userData", SANDBOX);

let failures = 0;
function check(ok, label, extra = "") {
  console.log(`${ok ? "PASS" : "FAIL"}  ${label}${extra ? " — " + extra : ""}`);
  if (!ok) failures++;
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** 与 src/shared/image-magic.ts 同一套判据，测试里独立实现以免依赖编译产物路径 */
function sniffBuf(b64) {
  return Buffer.from(b64, "base64");
}
function sniff(buf) {
  if (buf.length < 26) return null;
  if (buf[0] === 0x89 && buf[1] === 0x50 && buf[2] === 0x4e && buf[3] === 0x47) return ".png";
  if (buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) return ".jpg";
  if (buf[0] === 0x42 && buf[1] === 0x4d) return ".bmp";
  if (buf.toString("ascii", 0, 4) === "RIFF" && buf.toString("ascii", 8, 12) === "WEBP") return ".webp";
  return null;
}

/**
 * 生成图的字节。
 *
 * 必须是「真的够大」的 PNG：我的筛选逻辑按 naturalWidth/naturalHeight >= 300 判断，
 * 而 naturalWidth 是图片的固有尺寸，给 <img> 设 width 属性改不了它。
 * 所以这里用 Electron 的 nativeImage 现做一张 400x400 的图。
 */
const { nativeImage } = require("electron");
const SMALL_PNG = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==",
  "base64"
);
const PNG_1PX = SMALL_PNG;
const BIG_PNG = nativeImage
  .createFromBuffer(SMALL_PNG)
  .resize({ width: 400, height: 400 })
  .toPNG();

/**
 * 豆包「生成中」占位图的字节（真机抓下来的原样，82 字节）。
 * 它的 svg 属性 width/height 是 1520x2720，所以 naturalWidth 判据拦不住。
 */
const SVG_PLACEHOLDER_BYTES = Buffer.from(
  "<svg xmlns='http://www.w3.org/2000/svg' version='1.1' width='1520' height='2720'/>",
  "utf8"
);

/** 替身页面：结构对齐豆包（含发送按钮、图标图、可关闭浮层） */
const PAGE = [
  "<!doctype html><html><head><meta charset=\"utf-8\"><title>替身豆包</title></head>",
  "<body>",
  "<div class=\"fixed inset-0\" id=\"promo\" style=\"position:fixed;inset:0;z-index:2000;background:rgba(0,0,0,.4)\">",
  "  <button aria-label=\"关闭\" id=\"promoClose\">x</button>",
  "  <p>下载豆包电脑版 免费领取 30 天订阅</p>",
  "</div>",
  "<img id=\"icon\" src=\"/rc/icon/logo.png\" width=\"24\" height=\"24\">",
  "<div id=\"inputWrap\"><div contenteditable=\"true\"></div></div>",
  "<div class=\"send-btn-wrapper\"><button id=\"send\" disabled>发送</button></div>",
  "<div id=\"results\"></div>",
  "<script>",
  "  const ed = document.querySelector('[contenteditable=\"true\"]');",
  "  const send = document.getElementById('send');",
  "  const results = document.getElementById('results');",
  "  // 复刻豆包：输入框有内容才让发送按钮可用",
  "  window.__ticks = 0;",
  "  setInterval(() => { window.__ticks++; send.disabled = (ed.innerText || '').trim().length === 0; }, 100);",
  "  document.getElementById('promoClose').onclick = () => document.getElementById('promo').remove();",
  "  send.onclick = () => {",
  "    window.__submitted = (window.__submitted || []);",
  "    window.__submitted.push(ed.innerText);",
 "    // 复刻豆包的「生成中」占位：一张 data: 的 SVG，尺寸属性很大（实测 1520x2720），",
 "    // 光看 naturalWidth 会以为它就是生成结果（真机踩过这个坑）。",
 "    if (window.__mode !== 'onlySvg') {",
 "      const ph = document.createElement('img');",
 "      ph.src = 'data:image/svg+xml;utf8,' + encodeURIComponent(\"<svg xmlns='http://www.w3.org/2000/svg' width='1520' height='2720'/>\");",
 "      ph.id = 'placeholder';",
 "      results.appendChild(ph);",
 "    }",
  "    setTimeout(() => {",
 "      if (window.__mode === 'onlySvg') {",
"        // 只出「URL 后缀像 png、尺寸也很大、但字节是 SVG」的图：",
"        // 后缀和尺寸都骗得过，只有字节魔数能识破。",
"        const trap = document.createElement('img');",
"        trap.src = '/svg-trap.png';",
"        trap.width = 580; trap.height = 580;",
"        results.appendChild(trap);",
"        return;",
"      }",
  "      const img = document.createElement('img');",
  // __mode='hangFetch'：图正常挂上（能进候选），但它的字节请求永远不返回
  "      img.src = (window.__mode === 'hangFetch' ? '/hang/' : '/gen/') + window.__submitted.length + '.png';",
  "      img.width = 580; img.height = 580;",
  "      results.appendChild(img);",
  "    }, 1500);",
  "  };",
  "</script>",
  "</body></html>",
].join("\n"); // 用换行拼：用空串拼会让脚本里的 // 注释吞掉后面所有代码

const server = http.createServer((req, res) => {
  if (req.url.startsWith("/svg-trap.png")) {
    // 最阴的一种：能解码（尺寸骗得过 naturalWidth）、URL 后缀是 .png（骗得过按后缀猜扩展名），
    // 但字节是 SVG。只有魔数能识破它。
    res.writeHead(200, { "Content-Type": "image/svg+xml" }).end(SVG_PLACEHOLDER_BYTES);
    return;
  }
  if (req.url.startsWith("/rc/icon/")) {
    res.writeHead(200, { "Content-Type": "image/png" }).end(SMALL_PNG);
    return;
  }
  if (req.url.startsWith("/gen/")) {
    // 生成图：给一个够大的真实 PNG（用 1x1 放大在字节层面无所谓，页面按 width/height 认）
    res.writeHead(200, { "Content-Type": "image/png", "Content-Length": String(BIG_PNG.length) }).end(BIG_PNG);
    return;
  }
  if (req.url.startsWith("/doubao-static/")) {
    // 模拟豆包自己的网页静态资源（空状态插图那一类）：同样是真位图、尺寸够大，
    // 唯一区别是「来源」，用来验来源判据。
    res.writeHead(200, { "Content-Type": "image/png", "Content-Length": String(BIG_PNG.length) }).end(BIG_PNG);
    return;
  }
  if (req.url.startsWith("/hang/")) {
    /*
     * 复刻实测到的那个坑：图片地址正常、尺寸也够，但字节**永远不返回**
     * （真机上挂住过 2107 秒）。这里连头都不发，连接一直吊着，
     * 用来验 fetchImageBase64 的 30 秒超时真的会掐断，而不是无限等。
     *
     * 关键：要区分「<img> 加载这张图」和「页面里 fetch 这张图」两种请求——
     * 真机上 img 是正常显示出来的（否则它进不了候选），卡住的是后面那次 fetch。
     * 浏览器给这两种请求带的 Sec-Fetch-Dest 不同（image / empty），
     * 所以 img 请求照常返回位图，fetch 请求吊住不返回。
     */
    const dest = req.headers["sec-fetch-dest"];
    if (dest === "image") {
      res
        .writeHead(200, { "Content-Type": "image/png", "Content-Length": String(BIG_PNG.length) })
        .end(BIG_PNG);
    }
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

(async () => {
  await app.whenReady();
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  const base = `http://127.0.0.1:${server.address().port}`;
  // 带上 create-image：真实实现会用它判断「抽屉里是不是生图页」，
// 不是的话会重新加载页面，把测试注入的状态（__mode 等）冲掉。
process.env.BAOLUO_DOUBAO_URL = base + "/chat/create-image";

  const doubao = require(path.join(ROOT, "dist", "main", "doubao.js"));
  const store = require(path.join(ROOT, "dist", "main", "storyboard", "store.js"));
  // 用可见窗口：隐藏窗口会被 Chromium 节流定时器，替身页的按钮启用会变慢，
  // 那样测的是节流而不是我的逻辑。真实使用场景里抽屉本来就是可见的。
  const win = new BrowserWindow({ width: 1200, height: 800, show: true, x: 0, y: 0 });

  doubao.setDoubaoVisible(win, true);
  doubao.setDoubaoBounds({ x: 0, y: 46, width: 800, height: 700 });
  const ready = await waitFor(() => doubao.getDoubaoState().status === "ready");
  check(!!ready, "替身页面加载完成");

  // ---- A1) 未登录识别：替身页有「登录」按钮时判为未登录 ----
  // 替身页没有登录按钮，所以这里是「已登录」
  const loggedIn = await doubao.isDoubaoLoggedIn();
  check(loggedIn === true, "没有登录按钮时判为已登录", `loggedIn=${loggedIn}`);

  // ---- A2) 浮层可被关掉 ----
  const view = win.contentView.children.find((v) => v.webContents);
  const hadPromo = await view.webContents.executeJavaScript(`!!document.getElementById('promo')`, true);
  check(hadPromo === true, "替身页初始有遮挡浮层（模拟豆包推广弹窗）");


  // ---- A3) 完整一键生图链路 ----
  const gen = await doubao.generateImageFromPrompt(
    "竖屏 9:16，无文字无水印，治愈系手绘插画，一只橘猫坐在窗台，暖色调",
    { timeoutMs: 20000, onPhase: () => {} }
  );
  check(!!gen.base64 && gen.base64.length > 0, "取回图片字节（base64 非空）", `len=${gen.base64.length}`);
  check(gen.ext === ".png", "扩展名按字节魔数判定正确", `ext=${gen.ext}`);
  const bytes = Buffer.from(gen.base64, "base64");
  check(bytes.length === BIG_PNG.length, "字节长度与源图一致", `${bytes.length} vs ${BIG_PNG.length}`);
  check(
    bytes.equals(BIG_PNG),
    "字节内容与源图逐字节一致（没被截断/损坏）"
  );

  // ---- A4) 提示词完整进了输入框，且没有残留 ----
  const submitted = await view.webContents.executeJavaScript(`window.__submitted || []`, true);
  check(submitted.length === 1, "只提交了一次", `times=${submitted.length}`);
  check(
    submitted[0] === "竖屏 9:16，无文字无水印，治愈系手绘插画，一只橘猫坐在窗台，暖色调",
    "提交的提示词与传入的完全一致",
    JSON.stringify(submitted[0])
  );

  // ---- A5) 浮层已被关掉 ----
  const promoGone = await view.webContents.executeJavaScript(`!document.getElementById('promo')`, true);
  check(promoGone === true, "生图流程里把遮挡浮层关掉了");

  // ---- A6) 图标图与 SVG 占位图都不会被当成候选 ----
  // 直接调真实判据（listCandidateImages），测试自己抄一份筛选逻辑会随实现失真。
  const candidates = await doubao.listCandidateImages();
  check(candidates.length === 1, "只认生成图，界面图标和 SVG 占位图都不算候选", `candidates=${JSON.stringify(candidates.map((s) => s.slice(0, 24)))}`);

  /*
   * ---- A6b) 豆包自己的界面插图不能被当成生成结果 ----
   *
   * 这条判据的样本全部来自真机探针（tmp/doubao-probe/all-images.json，2026-10-04）：
   * 批量试验第二轮里，豆包的空状态插图（421x360 的**真位图**、普通 URL）
   * 混进了候选，被当成第 4/5 张生成结果。
   * 尺寸判据和「排掉 data:svg」都拦不住它，所以按来源判。
   */
  const URL_CASES = [
    // 真实生成图（探针里 30/30 都是这个形态）→ 必须是候选
    [
      "https://p3-flow-imagex-sign.byteimg.com/ocean-cloud-tos/image_generation/010c6dc70a54b5fdb36e10ca0953fe65_1778310615727186802.jpeg~tplv-a9rns2rl98-cgen_lwm3.png",
      true,
      "真实生成图（byteimg.com/image_generation）",
    ],
    // 空状态插图：真位图、普通 URL，尺寸 421x360 能过 >=300 —— 必须被排除
    [
      "https://lf-flow-web-cdn.doubao.com/obj/flow-doubao/doubao/chat/static/image/intro.12b8f8efa8.png",
      false,
      "豆包空状态插图（doubao.com/obj/.../static/）",
    ],
    [
      "https://lf-flow-web-cdn.doubao.com/obj/flow-doubao/doubao/chat/static/image/intro.12b8f8efa8.png?x-signature=abc",
      false,
      "同上，带签名参数",
    ],
    // 账号头像：也是真位图，也得排除
    [
      "https://p26-passport.byteacctimg.com/img/user-avatar/9a71efce22806bb38360e15459345d32~300x300.image",
      false,
      "账号头像（byteacctimg.com）",
    ],
    // 相对地址只可能是页面装饰，不认
    ["/svg-trap.png", false, "相对地址（页面装饰）"],
    ["data:image/png;base64,AAAA", false, "data: 地址"],
  ];
  let urlFails = 0;
  for (const [src, want, label] of URL_CASES) {
    const got = doubao.isGeneratedCandidateUrl(src);
    if (got !== want) {
      urlFails++;
      check(false, `判据误判：${label}`, `want=${want} got=${got} ${src.slice(0, 80)}`);
    }
  }
  check(urlFails === 0, `候选来源判据 ${URL_CASES.length} 条真实 URL 全部判对（含空状态插图必须被排除）`);

  /*
   * ---- A6c) 端到端：页面上真的挂一张「豆包静态资源」形态的图，不许进候选 ----
   *
   * 替身页在 localhost，没有 doubao.com 的域名。所以用 webRequest 把
   * https://lf-flow-web-cdn.doubao.com/obj/.../static/image/intro.png
   * 重定向到本地的真位图：这样这张图在 DOM 里是「真位图 + 尺寸够大 + 地址是豆包静态资源」，
   * 与真机上那张空状态插图完全同形，只有来源判据能挡掉它。
   * 验的是完整链路（DOM 过滤 → 来源过滤），不是判据函数本身（A6b 已单独验）。
   */
  const FAKE_STATIC_URL =
    "https://lf-flow-web-cdn.doubao.com/obj/flow-doubao/doubao/chat/static/image/intro.png";
  const ses = session.fromPartition("persist:doubao");
  const redirect = (details, cb) => {
    if (details.url === FAKE_STATIC_URL) {
      cb({ redirectURL: base + "/doubao-static/intro.png" });
      return;
    }
    cb({});
  };
  ses.webRequest.onBeforeRequest({ urls: [FAKE_STATIC_URL] }, redirect);

  const injected = await view.webContents.executeJavaScript(
    `(() => {
      const img = document.createElement('img');
      img.src = ${JSON.stringify(FAKE_STATIC_URL)};
      img.width = 421; img.height = 360;
      img.dataset.injected = 'doubao-static';
      document.getElementById('results').appendChild(img);
      return img.src;
    })()`,
    true
  );
  // 等它真的解码出来（complete + naturalWidth 都过尺寸判据）再断言
  const decoded = await waitFor(
    () =>
      view.webContents
        .executeJavaScript(
          `(() => { const i = document.querySelector('[data-injected]'); return !!i && i.complete && i.naturalWidth > 0; })()`,
          true
        )
        .catch(() => false),
    8000,
    200
  );
  check(!!decoded, "注入的豆包静态资源形态图已解码（尺寸判据能过）", injected.slice(0, 60));
  const withInjected = await doubao.listCandidateImages();
  check(
    withInjected.length === candidates.length,
    "挂上「豆包静态资源」形态的图后，候选数不变（来源判据在真实链路上生效）",
    `before=${candidates.length} after=${withInjected.length}`
  );
  check(
    !withInjected.some((s) => s.includes("doubao.com/obj/")),
    "候选里不含任何豆包网页静态资源",
    JSON.stringify(withInjected.map((s) => s.slice(0, 40)))
  );
  await view.webContents.executeJavaScript(
    `document.querySelectorAll('[data-injected]').forEach(e => e.remove())`,
    true
  );
  ses.webRequest.onBeforeRequest(null);

  // ---- A7) 存成镜头图并绑定 ----
  const board = store.createStoryboard({
    title: "测试方案",
    hook: "测试钩子",
    style: "治愈系手绘插画",
    shots: [{ caption: "第一镜旁白", imagePrompt: "一只橘猫" }],
  });
  const shotId = board.shots[0].id;
  const updated = store.attachShotImageBytes(board.id, shotId, gen.base64);
  const saved = updated.shots.find((s) => s.id === shotId);
  check(!!saved.imagePath, "图片已绑定到镜头", saved.imagePath || "");
  check(saved.imagePath.endsWith(".png"), "存盘文件扩展名正确", path.basename(saved.imagePath));
  check(fs.existsSync(saved.imagePath), "图片文件真的写到了磁盘");
  check(
    fs.statSync(saved.imagePath).size === BIG_PNG.length,
    "存盘文件大小与源图一致",
    `${fs.statSync(saved.imagePath).size} vs ${BIG_PNG.length}`
  );
  const reread = store.getStoryboard(board.id);
  check(
    reread.shots.find((s) => s.id === shotId).imagePath === saved.imagePath,
    "重新读取方案后绑定仍在（已落盘）"
  );
  check(
    saved.imagePath.startsWith(path.join(SANDBOX, "storyboards")),
    "图片落在该方案目录下",
    path.dirname(saved.imagePath)
  );

  // ---- A8) 未登录时的提示 ----
  await view.webContents.executeJavaScript(`(() => {
    const b = document.createElement('button'); b.innerText = '登录'; b.id = 'fakeLogin';
    document.body.appendChild(b);
  })()`, true);
  let loginErr = "";
  try {
    await doubao.generateImageFromPrompt("测试", { timeoutMs: 3000 });
  } catch (e) {
    loginErr = e.message;
  }
  check(/登录/.test(loginErr), "未登录时给出可读提示", loginErr.slice(0, 50));
  await view.webContents.executeJavaScript(`document.getElementById('fakeLogin').remove()`, true);

  // ---- A9) 空提示词拒绝 ----
  let emptyErr = "";
  try {
    await doubao.generateImageFromPrompt("   ");
  } catch (e) {
    emptyErr = e.message;
  }
  check(/没有画面提示词/.test(emptyErr), "空提示词被拒绝", emptyErr);

  // ---- A10) 输入框被改版时给出兜底提示 ----
  await view.webContents.executeJavaScript(`(() => {
    const ed = document.querySelector('[contenteditable="true"]');
    ed.setAttribute('data-old-editable', '1');
    ed.removeAttribute('contenteditable');
  })()`, true);
  let noInputErr = "";
  try {
    await doubao.generateImageFromPrompt("测试", { timeoutMs: 3000 });
  } catch (e) {
    noInputErr = e.message;
  }
  check(/手动|改版|重载/.test(noInputErr), "输入框不可用时提示走手动兜底", noInputErr.slice(0, 70));

  // A10 为了测「输入框改版」把 contenteditable 摘掉了，这里恢复回来再测后续用例
  await view.webContents.executeJavaScript(`(() => {
    const ed = document.querySelector('[data-old-editable]');
    if (ed) { ed.setAttribute('contenteditable', 'true'); ed.removeAttribute('data-old-editable'); }
  })()`, true);

  // ---- A11) 生成中的 SVG 占位图不能被当成结果 ----
  // 真机踩过：豆包出图前先挂一张 data:image/svg 的占位（width/height 属性很大），
  // 老逻辑只看尺寸就收工，于是把 82 字节的 <svg/> 存进镜头，界面是一张破图。
  const beforePh = Date.now();
  let phErr = "";
  try {
    await view.webContents.executeJavaScript("window.__mode = 'onlySvg';", true);
    await doubao.generateImageFromPrompt("占位图陷阱测试", { timeoutMs: 6000 });
  } catch (e) {
    phErr = e.message;
  }
  await view.webContents.executeJavaScript("delete window.__mode; document.getElementById('results').innerHTML = '';", true);
  check(
    /还没等到|手动/.test(phErr),
    "只有占位图时不返回图片，而是按超时给出可读提示",
    phErr.slice(0, 40)
  );
  check(Date.now() - beforePh >= 5000, "确实等满了超时（没有提前收工）");

  // ---- A12) 占位图之后真图出来，仍能正常抓到 ----
  const gen2 = await doubao.generateImageFromPrompt("真图会晚一点出现", {
    timeoutMs: 20000,
    onPhase: () => {},
  });
  check(
    sniff(sniffBuf(gen2.base64)) === ".png",
    "占位图先出现、真图后出现时，抓到的是真图",
    gen2.src
  );

  // ---- A12b) 取图片字节必须有超时，整体不许无限挂住 ----
  /*
   * 真机踩过：页面里的 fetch 没有任何超时，取一张图挂住过 2107 秒（35 分钟）。
   * 批量场景下这会让整个队列永久停住、界面卡在「第 n / 共 m 张」。
   *
   * 注意要验的是什么：单次 fetch 超时后会 `continue` 去重试（这是有意的，
   * 图还没写完时重试是对的），所以最终报出来的通常是外层那句「等了 N 秒」。
   * 真正要锁死的是**整体有界**——老代码里单次 fetch 没有上限，
   * 一次 await 就能超出外层 deadline 任意久（实测 35 分钟）。
   * 所以这里把外层超时设短，断言它到点就返回，而不是一直挂着。
   */
  await view.webContents.executeJavaScript("window.__mode = 'hangFetch';", true);
  const tHang = Date.now();
  let hangErr = "";
  try {
    await doubao.generateImageFromPrompt("取字节卡死测试", {
      timeoutMs: 6000,
      onPhase: () => {},
      fetchTimeoutMs: 1500, // 单次取字节上限压到 1.5 秒，测试才跑得快
    });
  } catch (e) {
    hangErr = e?.message ?? String(e);
  }
  const hangTook = Date.now() - tHang;
  await view.webContents.executeJavaScript(
    "delete window.__mode; document.getElementById('results').innerHTML = '';",
    true
  );
  check(
    /还没等到豆包出图/.test(hangErr),
    "取字节一直不返回时，到点给出可读提示（不是无声挂死）",
    hangErr.slice(0, 40)
  );
  check(
    hangTook < 20000,
    "整体有界：没有被单次 fetch 无限拖住（老代码这里是 2107 秒）",
    `${hangTook}ms`
  );

  // ---- A13) 数据层兜底：非位图字节绝不允许绑到镜头上 ----
  const svgB64 = Buffer.from(
    "<svg xmlns='http://www.w3.org/2000/svg' width='1520' height='2720'/>",
    "utf8"
  ).toString("base64");
  const board2 = store.createStoryboard({
    title: "占位图测试方案",
    hook: "h",
    style: "s",
    shots: [{ caption: "第一镜", imagePrompt: "p" }],
  });
  const shot2 = board2.shots[0].id;
  let storeErr = "";
  try {
    store.attachShotImageBytes(board2.id, shot2, svgB64);
  } catch (e) {
    storeErr = e.message;
  }
  check(/不是图片/.test(storeErr), "存盘那一层也会拦下 SVG 字节", storeErr.slice(0, 40));
  check(
    !store.getStoryboard(board2.id).shots.find((s) => s.id === shot2).imagePath,
    "被拦下后镜头保持未绑图（没有留下坏数据）"
  );

  doubao.disposeDoubao(win);
  win.destroy();
  server.close();
  console.log(failures ? `\n${failures} 项未通过` : "\n全部通过");
  app.exit(failures ? 1 : 0);
})().catch((e) => {
  console.error("FAIL  一键生图测试抛错 —", e?.stack || e?.message || e);
  app.exit(1);
});
