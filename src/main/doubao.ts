/**
 * 豆包独立窗口（v1.0.0）：点「打开豆包生图」弹出一个**独立的浏览器窗口**（不再内嵌）。
 *
 * 为什么从内嵌 WebContentsView 换成独立 BrowserWindow：
 *   - 用户诉求：登录/看生图不该挤在宝螺窗口里，像开了一个浏览器标签一样自然；
 *   - BrowserWindow 有自己的标题栏和关闭按钮，用户操作零学习成本；
 *   - 登录态仍然是固定分区 `persist:doubao`，落盘在 <数据目录>/Partitions/doubao，
 *     跟着「设置 → 通用设置 → 数据目录」一起走，跨重启保留——和内嵌时代完全一致。
 *
 * 「关掉 = 隐藏 + 冻结，不销毁」的策略保留：用户点窗口右上角 ✕ 或宝螺里的「关闭」，
 * 只是把窗口藏起来（`hide()`），页面活着，重开秒回；窗口自己的 close 事件被拦下
 * 转成 hide，应用退出/迁移数据目录时才真正 destroy。
 *
 * 为什么不销毁：豆包页面本身很重（实测 360 个请求、约 4MB，dom-ready 2.1s、
 * 输入框可打字 3~5s）。销毁重建意味着每次重开都重付这笔钱——
 * 实测「销毁重建重开可用 3180ms」vs「只隐藏重开可用 41ms」，差 77 倍。
 *
 * 隐藏了还联不联网：实测真实豆包页在静止后被隐藏，90 秒内请求数为 0。
 * 但页面刚加载完那几秒隐藏仍会有在途请求，所以额外用 CDP
 * Page.setWebLifecycleState("frozen") 冻一层，双保险。
 *
 * 后台生图仍然走屏幕外的离屏 worker 窗口（见下文），与独立窗口同一时刻只留一个。
 */
import { BrowserWindow, session } from "electron";
import { sniffRasterImageExt } from "../shared/image-magic";

/** 图像生成页直达地址，已验证可用；比首页少一步点击 */
export const DOUBAO_URL = "https://www.doubao.com/chat/create-image";

/**
 * 实际加载的地址。
 * 可用环境变量覆盖——测试用本地服务器验证「关闭后不再联网」，不依赖外网。
 */
function targetUrl(): string {
  return process.env.BAOLUO_DOUBAO_URL?.trim() || DOUBAO_URL;
}

/** 固定分区名：登录态跟着数据目录走，跨重启保留 */
const PARTITION = "persist:doubao";

/**
 * 桌面 Chrome 的 UA。
 *
 * 关键点：**版本号要和本机 Chromium 一致**（`process.versions.chrome`）。
 * 早先写死 Chrome/120，而 Electron 30 内置的是 Chromium 124 —— 请求头里
 * `User-Agent: Chrome/120` 和 `sec-ch-ua: "Chromium";v="124"` 自相矛盾，
 * 任何做过一点反自动化的网关一条正则就能标记（实测见 tmp/probe-hdr.log）。
 *
 * 豆包对非桌面 UA 会推「下载电脑版」引导页，所以必须是桌面 Chrome 形态。
 */
function desktopChromeUa(): string {
  const chrome = process.versions.chrome ?? "124.0.0.0";
  const major = chrome.split(".")[0];
  return (
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 " +
    `(KHTML, like Gecko) Chrome/${major}.0.0.0 Safari/537.36`
  );
}

/** 真 Chrome 的 Accept-Language 不是光秃秃一个 zh-CN（实测我们原来只发 zh-CN） */
const ACCEPT_LANGUAGES = "zh-CN,zh;q=0.9,en;q=0.8";

/**
 * UA-CH（Client Hints）的用户代理元数据。
 *
 * Electron 不是 Chrome 品牌构建，UA-CH 里天然**没有 "Google Chrome" 这一项**，
 * 而真 Chrome 一定有 —— 这是识别 Electron/Puppeteer 的教科书特征。
 * 想补上只能走 CDP `Emulation.setUserAgentOverride`（页面内 navigator 与请求头一起改）。
 */
function uaMetadata() {
  const chrome = process.versions.chrome ?? "124.0.0.0";
  const major = chrome.split(".")[0];
  return {
    brands: [
      { brand: "Chromium", version: major },
      { brand: "Google Chrome", version: major },
      { brand: "Not-A.Brand", version: "99" },
    ],
    fullVersionList: [
      { brand: "Chromium", version: chrome },
      { brand: "Google Chrome", version: chrome },
      { brand: "Not-A.Brand", version: "99.0.0.0" },
    ],
    fullVersion: chrome,
    platform: "Windows",
    platformVersion: "19.0.0",
    architecture: "x86",
    bitness: "64",
    model: "",
    mobile: false,
    wow64: false,
  };
}

/**
 * 人味延迟：把固定节拍换成带抖动的区间。
 *
 * 固定 1.2 秒轮询、填完固定 300ms 就提交，是行为分析里最容易被挑出来的"机器节拍"。
 * 抽成纯函数是为了让用例能断言区间（不然只能靠感觉）。
 */
export function humanDelayMs(minMs: number, maxMs: number): number {
  const lo = Math.max(0, Math.min(minMs, maxMs));
  const hi = Math.max(lo, Math.max(minMs, maxMs));
  return Math.round(lo + Math.random() * (hi - lo));
}

/** 等一段带抖动的延迟 */
function humanWait(minMs: number, maxMs: number): Promise<void> {
  return new Promise((r) => setTimeout(r, humanDelayMs(minMs, maxMs)));
}

export interface DoubaoBounds {
  x: number;
  y: number;
  width: number;
  height: number;
}

export type DoubaoStatus = "idle" | "loading" | "ready" | "error";

export interface DoubaoState {
  /** 视图是否已创建并挂在窗口上 */
  attached: boolean;
  /** 视图此刻是否真的显示在窗口上 */
  visible: boolean;
  status: DoubaoStatus;
  url: string;
  message: string;
}

/**
 * 豆包独立窗口（正常浏览器窗口：有标题栏、在任务栏里）。
 *
 * 登录、看生成过程都在这里；「关掉只隐藏不销毁」——重开秒回。
 */
let panelWin: BrowserWindow | null = null;
/** 宝螺主窗口：状态广播（doubao:state / doubao:loggedIn）发给它的渲染层 */
let mainWin: BrowserWindow | null = null;
/** 用户意图：豆包窗口开着（窗口可能还在加载中） */
let open = false;
/** 首屏是否已经加载完成过 */
let loaded = false;

/**
 * 后台生图用的「离屏 worker 窗口」（屏幕外的普通窗口，里面是同一个豆包页面）。
 *
 * 为什么不直接驱动豆包窗口：用户把窗口关掉（= 隐藏）后，页面会被判成 hidden ——
 * 实测 `document.hidden === true`、`innerWidth/Height = 0`、
 * `execCommand('insertText')` 失效、发送按钮不渲染，提示词根本填不进去。
 * 而一个「移到屏幕外、show: true」的普通窗口，配合 chromium-switches.ts 里那几个
 * 开关，页面看自己是可见的（实测 visibility=visible、hasFocus=true、填词成功）。
 *
 * 同一时刻只留一个页面：开豆包窗口就销毁 worker，后台生图就销毁豆包窗口（省内存）。
 */
let workerWin: BrowserWindow | null = null;
let workerStatus: DoubaoStatus = "idle";
let workerMessage = "";
let workerLoaded = false;
/** 屏幕外的坐标：虚拟桌面允许负坐标，用户不可能看到 */
const WORKER_X = -3200;
/** 页面是否已被 CDP 冻结 */
let frozen = false;
let status: DoubaoStatus = "idle";
let lastMessage = "";
/** 在途的生成任务数（>0 时禁止冻结页面，见 setFrozen） */
let busyCount = 0;

/** 生成任务开始：标记「有活在跑」，期间页面不许被冻结 */
export function beginGeneration(): void {
  busyCount++;
}

/** 生成任务结束：与 beginGeneration 成对调用 */
export function endGeneration(): void {
  busyCount = Math.max(0, busyCount - 1);
  /*
   * 后台生图跑完、豆包窗口又没开着时，把页面冻回去省 CPU（下次生图前 prepareDoubaoHidden 会解冻）。
   * 页面的网络轮询 / 定时器在冻结时停止，所以这一步必须放在 busy 归零之后。
   */
  if (busyCount === 0 && open && !isPanelVisible() && !frozen) setFrozen(true);
}

/**
 * 给测试看的内部状态（不参与业务逻辑）。
 *
 * 批量生图要求「关豆包窗口不中断任务」，靠的就是 busyCount 拦住 setFrozen；
 * 这两个值不导出的话，那条不变量只能在测试里靠时序猜。
 */
export function getGenerationGuardState(): { busy: number; frozen: boolean } {
  return { busy: busyCount, frozen };
}

function currentState(): DoubaoState {
  if (hasPanel()) {
    return {
      attached: true,
      visible: isPanelVisible(),
      status,
      url: panelWin!.webContents.getURL(),
      message: lastMessage,
    };
  }
  /*
   * 没有豆包窗口时报 worker 的状态：后台生图（窗口关着）时，
   * ensureDoubaoReady 与登录入口都靠这个状态判断"页面准备好没有"。
   * visible 一律 false —— 它在屏幕外，对用户来说就是没显示。
   */
  if (workerWin && !workerWin.isDestroyed() && !workerWin.webContents.isDestroyed()) {
    return {
      attached: true,
      visible: false,
      status: workerStatus,
      url: workerWin.webContents.getURL(),
      message: workerMessage,
    };
  }
  return { attached: false, visible: false, status: "idle", url: "", message: lastMessage };
}

/** 有窗口订阅了状态变化就广播（渲染层用来显示「加载中 / 加载失败」） */
function emit(): void {
  if (mainWin && !mainWin.isDestroyed()) {
    mainWin.webContents.send("doubao:state", currentState());
  }
}

function setStatus(next: DoubaoStatus, message = ""): void {
  status = next;
  lastMessage = message;
  emit();
}

/**
 * 冻结 / 解冻页面（对「当前页面」生效：用户看得见时是豆包窗口，否则是离屏 worker）。
 *
 * 冻结的意义：面板关着的时候页面还能跑（后台生图），但闲置时不该一直轮询烧 CPU /
 * 流量，所以任务停下来就冻住它，下次干活前再解冻。
 * 冻结失败不影响功能，只是少一层保险。
 */
function setFrozen(next: boolean): void {
  let wc: Electron.WebContents;
  try {
    wc = requirePage();
  } catch {
    return; // 没有页面（面板/worker 都没建）——没什么可冻的
  }
  if (frozen === next) return;
  /*
   * 有生成任务在跑时，页面必须保持 active：
   * 批量生图要求「关豆包窗口不中断任务」，而关窗口会走到这里想冻结页面，
   * 一冻下去豆包的生成轮询就停了，任务会一直卡到超时。
   */
  if (next && busyCount > 0) return;
  try {
    if (!wc.debugger.isAttached()) wc.debugger.attach("1.3");
    wc.debugger.sendCommand("Page.setWebLifecycleState", {
      state: next ? "frozen" : "active",
    });
    frozen = next;
  } catch {
    // DevTools 占着 debugger 之类：冻不住就靠隐藏/别的兜底
    frozen = false;
  }
}

/** 非 http(s) 协议（doubao:// 之类）直接在页面里拦掉，别弹系统框 */
function blockNonHttp(target: Electron.WebContents): void {
  target.on("will-navigate", (e, url) => {
    if (!/^https?:\/\//i.test(url)) e.preventDefault();
  });
}

/**
 * 页面加载失败的原因翻成人话。
 *
 * Electron 给的 `desc` 是 ERR_INTERNET_DISCONNECTED 这类英文码，
 * 直接显示给用户就是 T-004 标准 5 说的「英文错误码」。原始值写进控制台供排查。
 */
function loadFailText(code: number, desc: string): string {
  console.error(`[doubao] 页面加载失败：code=${code} desc=${desc}`);
  if (code === -106) return "豆包页面打不开：网络连不上。请检查网络后点「重载」重试。";
  if (code === -105) return "豆包页面打不开：域名解析失败。请检查网络或 DNS 后点「重载」重试。";
  if (code === -118 || code === -7) return "豆包页面打不开：连接超时。请检查网络后点「重载」重试。";
  return "豆包页面没能打开（网络不通，或豆包已改版）。点「重载」再试一次。";
}

/**
 * 站外跳转：新窗口一律不开，http(s) 的改在当前视图里打开。
 * 豆包登录常走第三方页面，直接 deny 会让登录流程断掉，所以放行到本视图。
 */
function handleNewWindow(target: Electron.WebContents): void {
  target.setWindowOpenHandler(({ url }) => {
    if (/^https?:\/\//i.test(url)) {
      void target.loadURL(url);
    }
    return { action: "deny" };
  });
}

/** 豆包窗口还活着吗（不看可见性） */
function hasPanel(): boolean {
  return !!panelWin && !panelWin.isDestroyed() && !panelWin.webContents.isDestroyed();
}

/** 豆包窗口此刻是否真的显示着 */
function isPanelVisible(): boolean {
  return hasPanel() && panelWin!.isVisible();
}

function destroyPanel(): void {
  stopLoginWatch();
  const w = panelWin;
  panelWin = null;
  open = false;
  loaded = false;
  frozen = false;
  status = "idle";
  lastMessage = "";
  if (!w) return;
  // 关掉前把 cookie / localStorage 落盘，否则刚登录的会话可能还在内存里
  flushDoubaoStorage();
  try {
    // close 事件被我们拦成 hide 了，销毁前先摘掉，destroy 才不会被拦
    w.removeAllListeners("close");
    w.destroy();
  } catch {
    /* 窗口可能已经没了 */
  }
}

/**
 * 把「浏览器指纹」摆成一台正常的桌面 Chrome。
 *
 * 实测（tmp/probe-fp.log、tmp/probe-hdr.log、tmp/probe-ua2.log）：
 *   - 只改 UA 字符串：UA 说 Chrome/124，但 `sec-ch-ua` 里没有 "Google Chrome" 品牌项 → 仍是教科书级特征；
 *   - 加 CDP `Emulation.setUserAgentOverride`（带 userAgentMetadata）后，页面内 navigator 与请求头都有 Google Chrome；
 *   - **该覆盖在 detach 之后会失效**（实测），所以只能让 debugger 一直挂着，且必须在首次导航前发出；
 *   - Electron 30 里这个命令的**回复不会回来**（实测 5s 超时），但覆盖已生效 —— 所以不能 await，发出去后等一小会儿即可。
 *
 * 这个取舍是明确的：用「CDP 常驻」这个弱信号，换掉「UA-CH 缺 Google Chrome」这个强信号。
 */
function applyUaSpoof(wc: Electron.WebContents): void {
  const ua = desktopChromeUa();
  try {
    wc.setUserAgent(ua);
    // 会话级也设一遍：请求头（含 Accept-Language）也跟着走
    wc.session.setUserAgent(ua, ACCEPT_LANGUAGES);
  } catch (e) {
    console.warn("[doubao] 设置 UA 失败（继续，指纹会不一致）:", (e as Error)?.message);
  }
  try {
    if (!wc.debugger.isAttached()) wc.debugger.attach("1.3");
    // 故意不 await：Electron 30 里这条命令不回复（实测超时），但覆盖已经落地
    void wc.debugger
      .sendCommand("Emulation.setUserAgentOverride", {
        userAgent: ua,
        acceptLanguage: ACCEPT_LANGUAGES,
        platform: "Windows",
        userAgentMetadata: uaMetadata(),
      })
      .catch(() => undefined);
  } catch (e) {
    console.warn("[doubao] UA-CH 覆盖失败（继续，UA-CH 会缺 Google Chrome）:", (e as Error)?.message);
  }
}

/**
 * 延迟一点再发首个请求。
 *
 * 为什么不能立刻 loadURL：UA-CH 覆盖是异步落地的（`Emulation.setUserAgentOverride`
 * 在 Electron 30 里的回复不会回来，只能靠等），首个文档请求发早了就还是旧指纹。
 */
function scheduleLoad(wc: Electron.WebContents, onFail: () => void): void {
  setTimeout(() => {
    if (wc.isDestroyed()) return;
    wc.loadURL(targetUrl()).catch((e) => {
      console.error("[doubao] 页面加载失败：", e?.message ?? e);
      onFail();
    });
  }, humanDelayMs(250, 450));
}

/**
 * 懒创建：第一次打开时才建豆包窗口、才发起网络请求。
 *
 * 窗口先以 `show: false` 创建，加载由 setDoubaoVisible(true) 在亮出窗口之后触发——
 * 顺序不能反：先加载再显示，用户会先看到一瞬间的白页。
 */
function ensurePanel(): BrowserWindow {
  if (hasPanel()) return panelWin!;
  if (panelWin) destroyPanel();

  const ses = session.fromPartition(PARTITION);
  const w = new BrowserWindow({
    width: 1280,
    height: 860,
    show: false,
    title: "豆包",
    backgroundColor: "#ffffff",
    webPreferences: {
      session: ses,
      contextIsolation: true,
      nodeIntegration: false,
      // 窗口可能被用户缩到后台，别让节流把豆包的生成轮询掐掉
      backgroundThrottling: false,
    },
  });
  panelWin = w;
  loaded = false;
  frozen = false;
  status = "idle";
  lastMessage = "";

  // 页面标题不参与窗口标题，避免窗口标题栏出现第二个标题来源
  w.on("page-title-updated", (e) => e.preventDefault());
  const wc = w.webContents;
  applyUaSpoof(wc);
  blockNonHttp(wc);
  handleNewWindow(wc);

  wc.on("did-start-loading", () => {
    if (loaded) return; // SPA 站内跳转也会触发，别重复报「加载中」
    setStatus("loading", "正在打开豆包…");
  });
  wc.on("did-finish-load", () => {
    loaded = true;
    setStatus("ready", "");
  });
  /** SPA 站内跳转不会触发 did-finish-load，但同样说明页面已经能用了 */
  wc.on("did-navigate-in-page", (_e, _url, isMainFrame) => {
    if (!isMainFrame) return;
    loaded = true;
    setStatus("ready", "");
  });
  wc.on("did-fail-load", (_e, code, desc, _url, isMainFrame) => {
    if (!isMainFrame) return;
    // -3 是用户主动中断导航，不算失败
    if (code === -3) return;
    setStatus("error", loadFailText(code, desc));
  });
  wc.on("render-process-gone", () => {
    setStatus("error", "豆包页面已崩溃，请关闭豆包窗口后重试。");
  });

  /*
   * 用户点窗口自己的 ✕：隐藏而不是销毁（重开秒回，登录态照旧）。
   * 应用退出 / 数据目录迁移走 destroyPanel()，用的是 destroy()，不经过 close 事件。
   */
  w.on("close", (e) => {
    if (panelWin !== w || w.isDestroyed()) return;
    e.preventDefault();
    stopLoginWatch();
    open = false;
    setFrozen(true);
    w.hide();
    emit();
  });

  emit();
  return w;
}

/** 宝螺主窗口关闭时调用，避免留下孤儿窗口 */
export function disposeDoubao(_win: BrowserWindow): void {
  /*
   * 豆包窗口与离屏 worker 窗口都是 BrowserWindow：不销毁它们的话，
   * 主窗口关了之后 `window-all-closed` 不会触发，进程会留在后台不退
   * （实测坑：应用"关不掉"）。
   */
  destroyPanel();
  destroyWorker();
}

// ---------------------------------------------------------------------------
// 离屏 worker 窗口：后台生图真正跑在哪个页面上
// ---------------------------------------------------------------------------

/** 把页面放到屏幕外的窗口里加载（用户看不到，但页面认为自己是可见的） */
function scheduleWorkerLoad(w: BrowserWindow): void {
  // 和豆包窗口一样，等 UA-CH 覆盖落地再发首个请求
  setTimeout(() => {
    if (w.isDestroyed() || w.webContents.isDestroyed()) return;
    w.webContents.loadURL(targetUrl()).catch((e) => {
      console.error("[doubao] 后台页面加载失败：", e?.message ?? e);
      workerStatus = "error";
      workerMessage = "豆包页面没能打开（网络不通，或豆包已改版）。点宝螺里的「重载」再试一次。";
      emit();
    });
  }, humanDelayMs(250, 450));
}

/**
 * 建（或复用）离屏 worker 窗口。
 *
 * `show: true` 是关键：隐藏窗口（show:false）的页面照样是 hidden、视口 0×0。
 * 位置放到屏幕外（负坐标），配上 chromium-switches.ts 的开关，页面看自己就是正常可见的。
 */
function ensureWorker(): BrowserWindow {
  if (workerWin && !workerWin.isDestroyed()) return workerWin;

  const ses = session.fromPartition(PARTITION);
  const w = new BrowserWindow({
    x: WORKER_X,
    y: 0,
    width: 1200,
    height: 900,
    show: true,
    skipTaskbar: true,
    frame: false,
    // 用户看不到它，也就不会去点它；但要能接收 CDP 的合成输入
    focusable: false,
    webPreferences: {
      session: ses,
      contextIsolation: true,
      nodeIntegration: false,
      backgroundThrottling: false,
    },
  });
  const wc = w.webContents;
  workerWin = w;
  workerLoaded = false;
  frozen = false; // 新页面本身不是冻结态；后台闲置后 endGeneration 会再冻上
  workerStatus = "loading";
  workerMessage = "";
  wc.setBackgroundThrottling(false);
  applyUaSpoof(wc);
  blockNonHttp(wc);
  handleNewWindow(wc);
  wc.on("did-start-loading", () => {
    if (workerLoaded) return;
    workerStatus = "loading";
    workerMessage = "";
    emit();
  });
  wc.on("did-finish-load", () => {
    workerLoaded = true;
    workerStatus = "ready";
    workerMessage = "";
    emit();
  });
  wc.on("did-navigate-in-page", (_e, _url, isMainFrame) => {
    if (!isMainFrame) return;
    workerLoaded = true;
    workerStatus = "ready";
    workerMessage = "";
    emit();
  });
  wc.on("did-fail-load", (_e, code, desc, _url, isMainFrame) => {
    if (!isMainFrame) return;
    if (code === -3) return; // 用户主动中断导航，不算失败
    workerStatus = "error";
    workerMessage = loadFailText(code, desc);
    emit();
  });
  wc.on("render-process-gone", () => {
    workerStatus = "error";
    workerMessage = "豆包页面已崩溃，请重开一次豆包面板。";
    emit();
  });
  w.on("closed", () => {
    if (workerWin === w) {
      workerWin = null;
      workerLoaded = false;
      workerStatus = "idle";
      workerMessage = "";
    }
  });

  scheduleWorkerLoad(w);
  emit();
  return w;
}

/** 销毁 worker（开面板、数据目录迁移、应用退出时都要） */
function destroyWorker(): void {
  const w = workerWin;
  workerWin = null;
  workerLoaded = false;
  frozen = false;
  workerStatus = "idle";
  workerMessage = "";
  if (!w || w.isDestroyed()) return;
  try {
    w.removeAllListeners("closed");
    w.destroy();
  } catch {
    /* 窗口可能已经没了 */
  }
}

/**
 * 现在该驱动哪个页面。
 *
 *   1) 豆包窗口正显示给用户看 → 驱动豆包窗口（用户能看着它干活，符合预期）；
 *   2) 否则 → 驱动离屏 worker（后台生图，用户无感）；
 *   3) 都没有 → null。
 *
 * 注意「窗口建好了但被用户藏起来」那一档：DOM 还能读（登录态判断够用），
 * 但填词/点击不可靠（隐藏页面视口为 0）——要干活时请先走 prepareDoubaoHidden()，
 * 它会把豆包窗口换掉、改用 worker。
 */
function activePage(): Electron.WebContents | null {
  if (isPanelVisible()) return panelWin!.webContents;
  if (workerWin && !workerWin.isDestroyed() && !workerWin.webContents.isDestroyed()) {
    return workerWin.webContents;
  }
  if (hasPanel()) return panelWin!.webContents;
  return null;
}

/** 拿当前页面，没页面就抛可读错误 */
function requirePage(): Electron.WebContents {
  const p = activePage();
  if (!p) {
    throw new DoubaoError("豆包页面还没打开，请先点「打开豆包生图」。", "not-open");
  }
  return p;
}

/** 打开 / 关闭独立豆包窗口 */
export function setDoubaoVisible(win: BrowserWindow, next: boolean): DoubaoState {
  // 主窗口记下来：状态广播 / 登录完成通知都发给它
  if (!mainWin || mainWin.isDestroyed()) mainWin = win;

  if (!next) {
    /*
     * 关掉只隐藏、不销毁：重开才能秒回（实测 41ms vs 重建 3180ms）。
     * 隐藏 + 冻结已经能让页面停下，不需要靠销毁来保证不联网。
     */
    stopLoginWatch();
    open = false;
    if (hasPanel()) {
      setFrozen(true);
      panelWin!.hide();
    }
    emit();
    return currentState();
  }

  // 用户要看豆包：把后台 worker 让出来（同一时刻只留一个页面，省内存）
  destroyWorker();
  const w = ensurePanel();
  open = true;
  setFrozen(false);
  // 先亮窗口、再发首个请求：反过来用户会先看到一瞬间的白页
  w.show();
  if (!w.webContents.getURL()) {
    setStatus("loading", "正在打开豆包…");
    scheduleLoad(w.webContents, () => {
      setStatus("error", "豆包页面没能打开（网络不通，或豆包已改版）。点宝螺里的「重载」再试一次。");
    });
  }
  // 用户打开窗口＝想登录 / 想看生成；没登录的话，登录完自动把窗口收掉
  startLoginWatch();
  emit();
  return currentState();
}

/**
 * 后台准备豆包：把页面加载好，但**不显示给用户**。
 *
 * 生图走这条路（用户诉求：像调 API 一样无感，不要弹豆包窗口）。
 *
 * 实现方式是**换一个页面载体**：先销毁豆包窗口（如果还留着），再把页面放进
 * 屏幕外的 worker 窗口（见 ensureWorker 的注释：屏幕外的普通窗口 + 关掉窗口遮挡判定，
 * 页面看自己仍是可见的，所以填词/点击/轮询都正常）。
 *
 * 踩过的死路（写在这里免得以后又走回去）：页面被判 hidden（隐藏窗口/隐藏视图）
 * 时视口 0×0、`document.hidden === true`，提示词填不进去、发送按钮不渲染。
 *
 * 用户自己点「打开豆包生图」时走 setDoubaoVisible(true)：那时才亮出独立窗口。
 */
export function prepareDoubaoHidden(_win?: BrowserWindow): DoubaoState {
  // 后台生图：用户没在看，登录完成也没人等着被送回宝螺
  stopLoginWatch();
  /*
   * 同一时刻只留一个页面（省内存）：
   * 豆包窗口就算建过、现在关着，它也已经是 hidden 状态、干不了活，直接换掉。
   */
  if (hasPanel()) destroyPanel();
  open = true;
  ensureWorker();
  setFrozen(false);
  emit();
  return currentState();
}

/**
 * 兼容入口（旧内嵌抽屉时代，渲染层量好 DOM 坐标后送过来摆视图）。
 *
 * 豆包换成独立窗口后，窗口的位置/大小由用户自己拖，这里不再消费坐标；
 * 保留函数是为了让旧脚本（scripts/test-doubao-*.cjs）不至于直接崩。
 */
export function setDoubaoBounds(_bounds: DoubaoBounds): void {
  /* no-op：独立窗口自己管自己的位置 */
}

export function getDoubaoState(): DoubaoState {
  return currentState();
}

/** 给「登录入口」看的账号状态 */
export interface DoubaoAccountState {
  /** 页面状态：idle = 还没打开过（这时不联网、不猜登录态） */
  page: DoubaoStatus;
  /** 登录态：true/false；页面没就绪时是 null（不猜） */
  loggedIn: boolean | null;
  /** 失败原因（人话），没有就是空串 */
  message: string;
}

/**
 * 查一次豆包的登录状态，给右下角那个入口用。
 *
 * 刻意**不**为了这次查询去创建页面：没打开过就返回 `idle + loggedIn: null`，
 * 免得用户只是停在「工作台」就白白加载一次豆包（几 MB 请求）。
 * 页面已经在（豆包窗口开着 / 之前开过）时才真查——查登录态只需要读 DOM，
 * 页面即使被藏在后台（视口为 0）也能读（实测）。
 */
export async function getDoubaoAccountState(): Promise<DoubaoAccountState> {
  const s = currentState();
  if (!s.attached) return { page: "idle", loggedIn: null, message: "" };
  if (s.status !== "ready") return { page: s.status, loggedIn: null, message: s.message };
  try {
    const loggedIn = await isDoubaoLoggedIn(6000);
    return { page: "ready", loggedIn, message: "" };
  } catch (e) {
    // 页面在，但判不出登录态（改版/网络）——原因交回去，界面照实显示
    return { page: "ready", loggedIn: null, message: describeDoubaoFailure(e).message };
  }
}

// ---------------------------------------------------------------------------
// 登录完成看门狗：用户扫码登录成功后，自动把豆包窗口收掉、回到宝螺。
//
// 用户点登录入口的意图是「登录」，不是「一直待在豆包页面里」。登录完了还要
// 自己找关闭按钮，这一步是多余的。
// ---------------------------------------------------------------------------

/** 盯登录的上限：扫码、手机验证、第三方跳转都可能慢，给足十分钟 */
const LOGIN_WATCH_MS = 10 * 60_000;
/** 轮询间隔：密了白跑 CDP，疏了用户要多等 */
const LOGIN_POLL_MS = 1200;
/**
 * 刚打开时的「认锚」宽限期。
 *
 * 未登录的豆包页面是先出登录按钮、再出输入框的（实测）。刚打开那一两秒可能
 * 只读到输入框、读不到登录按钮，这时**不能**下「本来就登录着」的结论，否则
 * 用户扫码登录成功后没人管、面板不会自动关。宽限期内继续看，看到登录按钮
 * 就进入待命；宽限期过完还是登录态，才认定是本来就登录着。
 */
const LOGIN_ARM_GRACE_MS = 5000;

let loginTimer: NodeJS.Timeout | null = null;
/** 是否已经见过一次明确的「未登录」（页面上有登录按钮） */
let loginSeenLoggedOut = false;
/**
 * 看门狗的代次。
 *
 * 读页面是异步的，一轮可能在 await 里挂着；这时用户可能已经把面板关了又开。
 * 靠它把「上一代」的在途轮次作废，否则关掉再打开会让两条链同时盯同一页，
 * 登录完成时广播两次。
 */
let loginWatchToken = 0;

/** 给测试看的内部状态（不参与业务逻辑） */
export function isDoubaoLoginWatchActive(): boolean {
  return loginTimer !== null;
}

/** 面板关了、转后台、视图销毁时调用：别再盯了 */
function stopLoginWatch(): void {
  loginWatchToken++; // 让在途的那一轮作废（它醒来时前提条件可能又成立了）
  if (loginTimer) clearTimeout(loginTimer);
  loginTimer = null;
  loginSeenLoggedOut = false;
}

/**
 * 登录完成：通知宝螺渲染层（刷新登录点、收起面板状态），并把豆包窗口自动藏起来。
 */
function emitLoggedIn(): void {
  if (mainWin && !mainWin.isDestroyed()) mainWin.webContents.send("doubao:loggedIn");
  if (hasPanel()) {
    open = false;
    setFrozen(true);
    panelWin!.hide();
    emit();
  }
}

/**
 * 盯着「用户把豆包登上了」，登上了就广播 `doubao:loggedIn`。
 *
 * 防误关的三条规矩（少一条都会让「只是进来看看」的用户被弹出去）：
 *   1) 只在豆包窗口**对用户可见**时盯——后台生图不盯；
 *   2) 必须先见过一次**明确的「未登录」**才进入待命；
 *   3) 待命之后登录按钮消失（豆包改成渲染输入框）＝ 登录完成，广播一次就收工。
 */
function startLoginWatch(): void {
  if (loginTimer) return; // 已经在盯了
  if (!open || !isPanelVisible()) return; // 后台生图不盯
  loginSeenLoggedOut = false;
  const token = ++loginWatchToken;
  const startedAt = Date.now();
  /** 这一代还作数吗：窗口还开着、还看得见、还活着 */
  const alive = () =>
    token === loginWatchToken && open && isPanelVisible();

  const tick = async () => {
    if (token !== loginWatchToken) return; // 上一代的轮次，不碰全局状态
    loginTimer = null;
    // 每次醒来都重新确认前提：面板关了 / 转成后台生图 / 视图没了 → 收工
    if (!alive()) return;
    if (Date.now() - startedAt > LOGIN_WATCH_MS) return;

    let probe: { rendered: boolean; hasLoginButton: boolean };
    try {
      probe = await probeDoubaoLogin();
    } catch {
      // 页面正在加载 / 重载 / 改版：这一轮读不到，下一轮再说
      loginTimer = setTimeout(tick, LOGIN_POLL_MS);
      return;
    }
    if (!alive()) return; // 查询期间面板被关掉了（或被重开成了另一代）

    if (probe.rendered && !probe.hasLoginButton) {
      if (loginSeenLoggedOut) {
        emitLoggedIn();
        return;
      }
      // 还没见过未登录就已是登录态：可能是本来就登录着，也可能登录按钮还没渲染
      if (Date.now() - startedAt < LOGIN_ARM_GRACE_MS) {
        loginTimer = setTimeout(tick, LOGIN_POLL_MS);
      }
      return;
    }
    if (probe.rendered && probe.hasLoginButton) loginSeenLoggedOut = true;
    loginTimer = setTimeout(tick, LOGIN_POLL_MS);
  };

  loginTimer = setTimeout(tick, LOGIN_POLL_MS);
}

// ---------------------------------------------------------------------------
// T-002 一键生图：填词 → 提交 → 抓图 → 取字节
//
// 豆包没有可用的公开生图 API（内嵌方案的前提就是零成本），只能驱动页面：
// 把提示词塞进它的输入框、点它的发送按钮、再从 DOM 里把生成出来的图捞回来。
// 因此下面每个函数都依赖豆包的页面结构，结构一变就会失效——
// 这正是需求里保留「复制提示词 / 手动拖图」兜底的原因。
// ---------------------------------------------------------------------------

/** 等豆包出图的上限 */
export const IMAGE_WAIT_MS = 120_000;

export class DoubaoError extends Error {
  readonly code: string;
  constructor(message: string, code: string) {
    super(message);
    this.name = "DoubaoError";
    this.code = code;
  }
}

/** 有中文、且不像英文堆栈的消息才配直接给用户看 */
function isHumanReadable(message: string): boolean {
  if (!/[\u4e00-\u9fa5]/.test(message)) return false;
  return !/Error invoking remote method|\bat [\w.$]+\(|ENOENT|ECONN|EPERM|undefined/.test(message);
}

/**
 * 失败 → 结构化原因（T-004 标准 5：不出现英文错误码与堆栈）。
 *
 * 放在 doubao.ts 而不是编排层：批量队列也要用它把每个镜头的失败收成人话，
 * 而队列是编排层的上游，放这里两边都能引，不会绕出循环依赖。
 */
export function describeDoubaoFailure(e: unknown): { code: string; message: string } {
  if (e instanceof DoubaoError) return { code: e.code, message: e.message };
  const code = (e as { code?: string })?.code ?? "unknown";
  const raw = (e as { message?: string })?.message ?? String(e ?? "");
  if (isHumanReadable(raw)) return { code, message: raw };
  console.error("[doubao] 未预期的失败：", e);
  return {
    code,
    message:
      "生图过程中出了点问题。请重试一次；仍不行就打开豆包窗口，把画面提示词手动输进去生图。",
  };
}

async function run<T>(script: string): Promise<T> {
  // 页面目标由 activePage() 决定：用户看得见面板就用面板，否则用离屏 worker
  const p = requirePage();
  try {
    return (await p.executeJavaScript(script, true)) as T;
  } catch (e: any) {
    /*
     * 页面脚本失败的原始原因（"Script failed to execute..."之类）是英文的，
     * 直接端给用户就违反 T-004 标准 5（不出现英文错误码）。所以只留中文人话，
     * 原始原因写进控制台供排查。
     */
    console.error("[doubao] 页面脚本执行失败：", e?.message ?? e);
    throw new DoubaoError(
      "没能读到豆包页面的内容（页面可能正在重载或已改版）。请点宝螺里的「重载」后重试，或打开豆包窗口把画面提示词手动输进去生图。",
      "script"
    );
  }
}

/**
 * 关掉挡路的浮层。
 *
 * 实测豆包加载后会弹「下载豆包电脑版 免费领取 30 天订阅」，盖住整页
 * （fixed inset-0、z-index 2000），不关掉就点不到输入框和发送按钮。
 * 它的关闭按钮带 aria-label="关闭"。
 */
async function closeBlockingModal(): Promise<boolean> {
  return run<boolean>(`(() => {
    const modals = [...document.querySelectorAll('div')].filter(el => {
      const cs = getComputedStyle(el);
      if (cs.position !== 'fixed' && cs.position !== 'absolute') return false;
      /*
       * z-index 必须是**明确的数字**且足够高。
       * 注意别写成 parseInt(cs.zIndex) < 100：普通布局容器是 "auto"，
       * parseInt("auto") 得到 NaN，而 NaN < 100 是 false——那样等于没过滤，
       * 会把 .scroll-view / .image-item 这类正常容器当成浮层（实测踩过）。
       * 真浮层实测是 z-index: 2000。
       */
      const z = Number.parseInt(cs.zIndex, 10);
      if (!Number.isFinite(z) || z < 100) return false;
      const r = el.getBoundingClientRect();
      return r.width > window.innerWidth * 0.5 && r.height > window.innerHeight * 0.5;
    });
    let closed = 0;
    for (const m of modals) {
      const btn = [...m.querySelectorAll('button')].find(
        b => b.getAttribute('aria-label') === '关闭'
      );
      if (btn) { btn.click(); closed++; }
    }
    return closed > 0;
  })()`);
}

/**
 * 读一眼页面，判断「渲染到能判断登录态了没有」。
 *
 * 抽出来是因为现在有两个调用方：一次性判断（isDoubaoLoggedIn）和
 * 登录看门狗（startLoginWatch 要反复读、且读失败要容忍，不能抛）。
 */
async function probeDoubaoLogin(): Promise<{ rendered: boolean; hasLoginButton: boolean }> {
  return await run<{ rendered: boolean; hasLoginButton: boolean }>(`(() => {
    const hasInput = !!document.querySelector('[contenteditable="true"]');
    const hasLoginBtn = [...document.querySelectorAll('button')]
      .some(b => (b.innerText || '').trim() === '登录');
    return { rendered: hasInput || hasLoginBtn, hasLoginButton: hasLoginBtn };
  })()`);
}

/**
 * 有没有登录：没登录时豆包只回文字、不出图，得提前告诉用户。
 *
 * 关键是**等页面渲染完再判**。豆包加载顺序实测是：
 *   did-finish-load（文档好了）→ 约 1s 后登录按钮出现 → 再 1s 输入框出现。
 * 在「文档好了、登录按钮还没渲染」那一瞬间查，会把未登录误判成已登录，
 * 于是继续往下走、白白等两分钟才超时（实测踩过：E2E 里把一张推广插图当成了生成结果）。
 *
 * 判据：页面上出现输入框或登录按钮，才算「渲染到能判断」。
 */
export async function isDoubaoLoggedIn(timeoutMs = 30_000): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const r = await probeDoubaoLogin();
    if (r.rendered) return !r.hasLoginButton;
    await new Promise((res) => setTimeout(res, 300));
  }
  throw new DoubaoError(
    "豆包页面一直没有响应（可能网络不通，也可能豆包已改版）。请点宝螺里的「重载」重试；若仍不行，打开豆包窗口把画面提示词手动输进去生图。",
    "not-rendered"
  );
}

/**
 * 让豆包页面进入「跑得动」的状态，生图前必须先过这一关。
 *
 * 默认（silent=false）判的是 visible，不是 attached：豆包窗口关掉时页面不销毁（为了秒开），
 * 但会被隐藏 + CDP 冻结，页面停在后台、输入框拿不到焦点。早期判 attached，于是
 * 「开过窗口又关掉 → 点一键生图」会往冻住的页面里填词，20 秒后报
 * 「没能把提示词填进豆包输入框」（实测踩过）。
 *
 * silent=true 是**后台生图**：页面要活着，但不许弹到用户脸上（用户要的是「像调 API 一样无感」）。
 * 这时不调 setDoubaoVisible，只 prepareDoubaoHidden（建窗口 / 加载 / 解冻）；
 * 用户自己已经开着豆包窗口时不打扰他（保持显示）。
 */
export async function ensureDoubaoReady(
  win: BrowserWindow,
  opts: { silent?: boolean } = {}
): Promise<void> {
  if (!getDoubaoState().visible) {
    if (opts.silent) prepareDoubaoHidden(win);
    else setDoubaoVisible(win, true);
  }
  // 首屏要几秒；解冻后还要一会儿才渲染出输入框
  const deadline = Date.now() + 30_000;
  while (Date.now() < deadline) {
    const s = getDoubaoState();
    // 后台模式不看 visible（本来就该是隐藏的），只看页面准备好没有
    if (s.status === "ready" && (opts.silent || s.visible)) return;
    if (s.status === "error") break;
    await new Promise((r) => setTimeout(r, 300));
  }
  throw new DoubaoError(
    "豆包页面还没准备好（正在加载或已被关掉）。请先点「打开豆包生图」，等页面出来再试。",
    "not-ready"
  );
}

/**
 * 未登录就别往下走（T-004 标准 2）：返回给界面的人话结果，界面据此把豆包窗口打开让用户扫码。
 *
 * 与「页面没渲染出来」分开报：后者是改版/网络问题，提示用户去登录就指错方向了。
 */
export async function doubaoLoginBlocked(): Promise<{ code: string; message: string } | null> {
  let loggedIn: boolean;
  try {
    loggedIn = await isDoubaoLoggedIn(10_000);
  } catch (e) {
    return describeDoubaoFailure(e);
  }
  if (loggedIn) return null;
  return {
    code: "not-logged-in",
    message: "请先登录豆包：点「打开豆包生图」扫码登录一次即可（登录后一直有效）。",
  };
}

/** 「自动打开登录框」的结果：界面据此决定要不要提示用户手动操作 */
export interface OpenLoginResult {
  ok: boolean;
  /** 本来就已经登录着（什么都没点） */
  alreadyLoggedIn: boolean;
  /** 点完之后确实看到了登录框（扫码 / 手机号） */
  dialogOpened: boolean;
  /** 失败或需要用户接手时的人话说明 */
  message: string;
}

/**
 * 读一眼页面上有没有登录框（扫码 / 手机号 / 验证码）。
 *
 * 判据三层，从准到宽：
 *   1) 文案：真机实测点完「登录」后页面上出现的是「登录以解锁更多功能 / 使用豆包或飞书账号」，
 *      不是我们原先以为的「扫码登录」——所以这两句也在名单里（踩过：漏了它会把已经弹出的
 *      登录框判成"没弹出来"，然后给用户一句误导的提示）；
 *   2) 二维码：浮层里出现大尺寸 canvas/iframe；
 *   3) **新出现的浮层**：点之前先数一遍大浮层，点之后变多了就算弹出来了。
 *      这一层是兜底——豆包改文案也照样认得出（上面两层都是易变的）。
 */
async function probeLoginDialog(): Promise<{ markers: boolean; bigOverlays: number }> {
  return run<{ markers: boolean; bigOverlays: number }>(`(() => {
    const text = document.body ? (document.body.innerText || '') : '';
    const markers =
      /扫码登录|二维码|手机号登录|验证码登录|其他方式登录|登录即代表|登录以解锁|使用豆包或飞书账号|登录后可/.test(text);
    const overlays = [...document.querySelectorAll('div')].filter((el) => {
      const cs = getComputedStyle(el);
      if (cs.position !== 'fixed' && cs.position !== 'absolute') return false;
      const z = Number.parseInt(cs.zIndex, 10);
      if (!Number.isFinite(z) || z < 100) return false;
      const r = el.getBoundingClientRect();
      return r.width * r.height > innerWidth * innerHeight * 0.3;
    });
    const qr = [...document.querySelectorAll('canvas, iframe')].some((el) => {
      const r = el.getBoundingClientRect();
      return r.width > 120 && r.height > 120 && overlays.some((d) => d === el || d.contains(el));
    });
    return { markers: markers || qr, bigOverlays: overlays.length };
  })()`).catch(() => ({ markers: false, bigOverlays: 0 }));
}

/**
 * 自动把豆包的登录框叫出来。
 *
 * 用户点「登录豆包」的意图就是登录，不该还要他在这张陌生页面里自己找「登录」两个字。
 * 所以豆包窗口一打开就点掉登录入口，把扫码框弹出来（登录完成后由登录看门狗把窗口收掉）。
 *
 * 三个前提，缺一个都不动手（宁可什么都不做，也不要在用户没看的时候乱点页面）：
 *   1) 豆包窗口开着且对用户可见（后台生图不碰）；
 *   2) 页面渲染到能判断登录态（否则会把「登录按钮还没渲染出来」当成已登录）；
 *   3) 确实未登录。
 *
 * 点击方式与发送按钮同一套：量坐标 → elementFromPoint 命中判定 → CDP 真鼠标点击 →
 * 用页面侧监听证明事件真的落到了那个元素 → 没落就脚本点击兜底。
 * （踩过的坑：CDP 返回成功不等于事件到位，见 submitPrompt 的注释。）
 */
export async function openDoubaoLogin(timeoutMs = 15_000): Promise<OpenLoginResult> {
  // 只在"豆包窗口真的显示给用户看"时才动手：后台生图时不许在用户背后点页面
  if (!isPanelVisible()) {
    return {
      ok: false,
      alreadyLoggedIn: false,
      dialogOpened: false,
      message: "豆包窗口还没准备好，稍等一下再点。",
    };
  }

  let loggedIn: boolean;
  try {
    loggedIn = await isDoubaoLoggedIn(timeoutMs);
  } catch (e) {
    const d = describeDoubaoFailure(e);
    return { ok: false, alreadyLoggedIn: false, dialogOpened: false, message: d.message };
  }
  if (loggedIn) return { ok: true, alreadyLoggedIn: true, dialogOpened: false, message: "" };

  /*
   * 找登录入口：文字正好是「登录 / 立即登录 / 登录注册」的可点元素，且真的可见。
   * 特意不认「退出登录」「登录后同步」这类包含关系——点错了比不点更糟。
   * 命中的最内层元素（外层的容器文字会包含它），宁可点小的那个。
   */
  const target = await run<{ found: boolean; x: number; y: number; hit: boolean }>(`(() => {
    const visible = (el) => {
      const r = el.getBoundingClientRect();
      if (r.width < 8 || r.height < 8) return false;
      const cs = getComputedStyle(el);
      return cs.visibility !== 'hidden' && cs.display !== 'none' && Number(cs.opacity) > 0.1;
    };
    const words = ['登录', '立即登录', '登录/注册', '登录注册'];
    const cands = [...document.querySelectorAll('button, a, [role="button"], span, div')].filter((el) => {
      const t = (el.innerText || '').trim();
      if (!words.includes(t)) return false;
      if (el.querySelector('[contenteditable="true"]')) return false;
      if (!visible(el)) return false;
      // 最内层：没有哪个子元素的文字就等于它
      return ![...el.children].some((c) => (c.innerText || '').trim() === t);
    });
    if (!cands.length) return { found: false, x: 0, y: 0, hit: false };
    // 面积最大的那个通常是主入口（页脚/角落的小链接不是）
    cands.sort((a, b) => {
      const ra = a.getBoundingClientRect();
      const rb = b.getBoundingClientRect();
      return rb.width * rb.height - ra.width * ra.height;
    });
    const el = cands[0];
    const r = el.getBoundingClientRect();
    const x = Math.round(r.left + r.width / 2);
    const y = Math.round(r.top + r.height / 2);
    const top = document.elementFromPoint(x, y);
    const hit = !!top && (top === el || el.contains(top) || top.contains(el));
    // 一次性监听：证明真鼠标点击到底有没有落到这个元素上
    if (!el.__baoluoLoginHooked) {
      el.__baoluoLoginHooked = true;
      el.addEventListener('click', () => { window.__baoluoLoginClicked = true; }, true);
    }
    window.__baoluoLoginClicked = false;
    return { found: true, x, y, hit };
  })()`);

  if (!target.found) {
    return {
      ok: false,
      alreadyLoggedIn: false,
      dialogOpened: false,
      message: "没在豆包页面上找到「登录」入口（可能页面还没加载完，或豆包已改版）。请点宝螺里的「重载」再试。",
    };
  }

  // 先记一份"点之前"的浮层数：豆包登录框是弹出来的浮层，前后一比就知道有没有弹
  const before = await probeLoginDialog();

  // 先关掉可能盖住登录入口的浮层（真鼠标点击是按坐标命中的）
  await closeBlockingModal().catch(() => false);

  let landed = false;
  if (target.hit) {
    landed = await trustedClickAt(target.x, target.y);
    if (landed) {
      await humanWait(250, 600);
      landed = await run<boolean>(`!!window.__baoluoLoginClicked`).catch(() => false);
    }
  }
  if (!landed) {
    // 合成输入被丢掉 / 被浮层盖住 → 脚本点击兜底（登录入口点一下没有"重复提交"的副作用）
    await run<boolean>(`(() => {
      const words = ['登录', '立即登录', '登录/注册', '登录注册'];
      const cands = [...document.querySelectorAll('button, a, [role="button"], span, div')].filter((el) => {
        const t = (el.innerText || '').trim();
        if (!words.includes(t)) return false;
        const r = el.getBoundingClientRect();
        return r.width >= 8 && r.height >= 8;
      });
      if (!cands.length) return false;
      cands.sort((a, b) => {
        const ra = a.getBoundingClientRect();
        const rb = b.getBoundingClientRect();
        return rb.width * rb.height - ra.width * ra.height;
      });
      cands[0].click();
      return true;
    })()`).catch(() => false);
  }

  // 等登录框真的出来（豆包有时要一跳），最多 3 秒
  const deadline = Date.now() + 3000;
  while (Date.now() < deadline) {
    const now = await probeLoginDialog();
    // 文案命中，或者浮层比点之前多了（改文案也认得出）
    if (now.markers || now.bigOverlays > before.bigOverlays) {
      return { ok: true, alreadyLoggedIn: false, dialogOpened: true, message: "" };
    }
    await new Promise((r) => setTimeout(r, 300));
  }
  return {
    ok: true,
    alreadyLoggedIn: false,
    dialogOpened: false,
    message: "已经帮你点了「登录」，但没看到登录框弹出来。请在这个窗口里手动点一下「登录」（一般在右上角），或点「重载」重试。",
  };
}

/**
 * 把提示词写进输入框。
 *
 * 用 execCommand('insertText')：它是 ProseMirror 认得的标准输入路径，
 * 直接改 innerText / textContent 不会触发它内部状态，发送按钮会一直是灰的。
 * 实测这条路径能让发送按钮从 disabled 变为可用。
 */
async function fillPrompt(prompt: string, timeoutMs = 20_000): Promise<void> {
  /*
   * 等输入框出现，而不是查一次就下结论。
   * 豆包是 SPA：did-finish-load 只代表文档加载完，输入框还要再等一会儿才渲染出来
   * （实测文档加载完时页面上只有 1 张 20px 的图，输入框根本还没挂上）。
   * 用户刚打开豆包窗口就点「一键生图」时正好会撞上这段窗口。
   */
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const ok = await run<boolean>(`(() => {
      const ed = document.querySelector('[contenteditable="true"]');
      if (!ed) return false;
      ed.focus();
      // 先清空，避免连点两次时上一次的内容残留
      document.execCommand('selectAll', false, null);
      document.execCommand('delete', false, null);
      document.execCommand('insertText', false, ${JSON.stringify(prompt)});
      return (ed.innerText || '').trim().length > 0;
    })()`);
    if (ok) return;
    await new Promise((r) => setTimeout(r, 300));
  }
  throw new DoubaoError(
    "豆包页面可能已改版：找不到写提示词的输入框，没能把画面提示词填进去。请稍等页面加载完再试，或打开豆包窗口把画面提示词手动输进去生图。",
    "no-input"
  );
}

/**
 * 用 CDP 发一次「真鼠标点击」。
 *
 * 为什么要这么麻烦：`btn.click()` 触发的事件 `isTrusted=false`，页面里一行
 * `e.isTrusted` 就能认出是脚本点的（实测 tmp/probe-fp.log：click=false，
 * 而 execCommand 填词产生的 input 事件是 true）。CDP 的 Input.dispatchMouseEvent
 * 走的是浏览器输入管线，事件与真鼠标一致（还有 pointerdown/up 序列）。
 *
 * 失败就返回 false，由调用方退回 `btn.click()` —— 宁可被识别，也不能让生图挂掉。
 */
async function trustedClickAt(x: number, y: number): Promise<boolean> {
  let wc: Electron.WebContents;
  try {
    wc = requirePage();
  } catch {
    return false;
  }
  /*
   * 合成输入不是哪儿都能到：早先把视图藏起来/挪到窗口外时，CDP 的
   * Input.dispatchMouseEvent 会**返回成功但事件根本不落地**（页面里 __sendTrusted 是
   * undefined、生图卡到超时）。现在后台走的是屏幕外的普通窗口（页面自认可见），
   * 但"返回成功 ≠ 事件到位"这条教训仍然成立 —— 所以调用方（submitPrompt /
   * openDoubaoLogin）一律用页面侧监听证明落地，没落地就退回脚本点击。
   */
  try {
    if (!wc.debugger.isAttached()) wc.debugger.attach("1.3");
    await wc.debugger.sendCommand("Input.dispatchMouseEvent", {
      type: "mouseMoved",
      x,
      y,
      button: "none",
      buttons: 0,
    });
    await humanWait(40, 140);
    await wc.debugger.sendCommand("Input.dispatchMouseEvent", {
      type: "mousePressed",
      x,
      y,
      button: "left",
      buttons: 1,
      clickCount: 1,
    });
    await humanWait(30, 90);
    await wc.debugger.sendCommand("Input.dispatchMouseEvent", {
      type: "mouseReleased",
      x,
      y,
      button: "left",
      buttons: 0,
      clickCount: 1,
    });
    return true;
  } catch (e) {
    console.warn("[doubao] 真鼠标点击失败，退回脚本点击：", (e as Error)?.message);
    return false;
  }
}

/**
 * 发送之后页面「看起来收下了」吗？
 *
 * 判据取三选一（豆包发出去之后会把输入框清空、发送按钮变灰）：
 *   - 输入框空了；
 *   - 发送按钮变灰/消失。
 * 为什么需要它：真鼠标点击是**按坐标命中**的，任何盖住按钮的浮层（豆包自己的推广层、
 * 登录墙）都会把点击吃掉——而 `btn.click()` 不会。实测（scripts/test-doubao-group.cjs）
 * 页面上有浮层时，CDP 点击返回成功、事件却落在浮层上，生图直接卡到超时。
 */
async function sendLooksAccepted(): Promise<boolean> {
  return run<boolean>(`(() => {
    const ed = document.querySelector('[contenteditable="true"]');
    const wrap = document.querySelector('.send-btn-wrapper');
    const btn = wrap ? wrap.querySelector('button') : null;
    const empty = !ed || (ed.innerText || '').trim().length === 0;
    return empty || !btn || btn.disabled;
  })()`).catch(() => false);
}

/**
 * 点发送。
 *
 * 发送按钮是**异步**变可用的：填完词要等它自己的状态更新（实测约 100ms 内）。
 * 所以这里轮询等它变可用，而不是查一次就下结论——查一次会误报「按钮是灰的」。
 *
 * 策略（两边都要）：
 *   1. 先关掉可能挡住按钮的浮层，量坐标，并问一句「这个点上最上面的是不是按钮」；
 *   2. 是 → 发**真鼠标点击**（isTrusted=true，最像真人），并**证明它真的落到了按钮上**
 *      （点之前在页面侧挂一个一次性监听，点完读它）；
 *   3. 没落到（坐标被别的东西吃了、或视图不在可见区、合成输入被丢掉）→ 退回脚本点击
 *      `btn.click()`。这一步是安全的：监听没响就说明按钮的处理函数一次都没跑过，
 *      不存在"重复发送"的风险。
 *
 * 为什么非要这个监听：实测踩过两次坑——CDP 的 Input.dispatchMouseEvent **返回成功不等于
 * 事件到位**（后台视图那次直接丢；`test:doubao-gen` 里还偶发过一次），
 * 只按"返回值"或"输入框空没空"判断，一个会静默不发、一个会重复发送。
 */
async function submitPrompt(timeoutMs = 5000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  let sawButton = false;
  while (Date.now() < deadline) {
    // 浮层会吃掉真实鼠标点击，先关一遍
    await closeBlockingModal().catch(() => false);
    const r = await run<{ state: string; x: number; y: number; hit: boolean }>(`(() => {
      const wrap = document.querySelector('.send-btn-wrapper');
      const btn = wrap ? wrap.querySelector('button') : null;
      if (!btn) return { state: 'no-button', x: 0, y: 0, hit: false };
      if (btn.disabled) return { state: 'disabled', x: 0, y: 0, hit: false };
      const rect = btn.getBoundingClientRect();
      const x = Math.round(rect.left + rect.width / 2);
      const y = Math.round(rect.top + rect.height / 2);
      /*
       * 真鼠标点击是**按坐标命中**的：先问一句「这个点上最上面的是不是按钮」。
       * 被浮层/登录墙盖住时 elementFromPoint 返回的不是它，这时别浪费一次点击
       * （实测：点下去事件落在浮层上，生图卡到超时），直接走脚本点击。
       */
      const top = document.elementFromPoint(x, y);
      const hit = !!top && (top === btn || btn.contains(top) || top.contains(btn));
      // 一次性监听：证明真鼠标点击到底有没有落到按钮上（捕获阶段挂，页面 stopPropagation 也拦不住）
      if (!btn.__baoluoClickHooked) {
        btn.__baoluoClickHooked = true;
        btn.addEventListener('click', () => { window.__baoluoClickSeen = true; }, true);
      }
      window.__baoluoClickSeen = false;
      return { state: 'ready', x, y, hit };
    })()`);
    if (r.state === "ready") {
      if (r.hit && (await trustedClickAt(r.x, r.y))) {
        await humanWait(350, 800);
        const landed = await run<boolean>(`!!window.__baoluoClickSeen`).catch(() => false);
        if (landed) {
          /*
           * 事件确实落到了按钮上 = 按钮自己的处理函数跑过了 = 已经发出去。
           * 这时**绝不重试**：万一"看起来没发出去"是误判，重试就会重复发送
           * （成片多一张图、豆包多收一条消息），比偶尔少发一次糟得多。
           */
          if (!(await sendLooksAccepted())) {
            console.warn("[doubao] 真鼠标点击已落到发送按钮，但页面看起来没清空输入框（仅记录，不重试）");
          }
          return;
        }
        console.warn("[doubao] 真鼠标点击没落到发送按钮上（合成输入被丢掉），改用脚本点击兜底");
      }
      // 按钮被浮层盖住（命中判定为假）、或后台模式（合成输入投不进窗口外的视图）→ 脚本点击兜底
      const ok = await run<boolean>(`(() => {
        const wrap = document.querySelector('.send-btn-wrapper');
        const btn = wrap ? wrap.querySelector('button') : null;
        if (!btn || btn.disabled) return false;
        btn.click();
        return true;
      })()`);
      if (ok) return;
      await humanWait(150, 400);
      continue;
    }
    if (r.state === "no-button") {
      throw new DoubaoError(
        "豆包页面可能已改版：找不到发送按钮。请打开豆包窗口，把画面提示词手动输进去生图。",
        "no-send"
      );
    }
    sawButton = true;
    await new Promise((r2) => setTimeout(r2, 150));
  }
  if (sawButton) {
    throw new DoubaoError(
      "豆包的发送按钮一直是灰的，提示词可能没填进去。请重试，或打开豆包窗口把画面提示词手动输进去生图。",
      "send-disabled"
    );
  }
}

/**
 * 页面上现在有没有可输入的编辑器（快速探一次，不等）。
 *
 * 用来判断「豆包窗口里这一页还是不是生图页」：用户在豆包里点进别的会话/首页之后，
 * 页面上就没有我们认得的那个输入框了，直接填词必然失败。
 */
async function hasPromptEditor(): Promise<boolean> {
  return run<boolean>(`!!document.querySelector('[contenteditable="true"]')`);
}

/**
 * 把页面带回生图页。
 *
 * 豆包窗口是「关掉只隐藏、不销毁」的，所以页面可能停在：
 *   - 用户手动切过去的别的豆包会话；
 *   - 上一次加载失败/还卡在 loading；
 * 这两种情况填词都会失败（实测报「没能把提示词填进豆包输入框」）。
 * 找不到输入框就重新加载生图直达地址，再等它出现。
 */
async function ensureImagePage(timeoutMs = 30_000): Promise<void> {
  /*
   * 光看「有没有输入框」不够：豆包普通聊天页也有 contenteditable，
   * 把生图提示词填进聊天页只会得到一段文字回答。所以还要看地址是不是生图页。
   */
  const onImagePage = requirePage().getURL().includes("create-image");
  if (onImagePage && (await hasPromptEditor().catch(() => false))) return;
  const p = requirePage();
  setStatus("loading", "正在回到豆包生图页…");
  p.loadURL(targetUrl());
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await hasPromptEditor().catch(() => false)) {
      setStatus("ready", "");
      return;
    }
    await new Promise((r) => setTimeout(r, 500));
  }
  setStatus("ready", "");
  throw new DoubaoError(
    "豆包页面可能已改版：里面没有可用的输入框。请点宝螺里的「重载」后重试，或打开豆包窗口把画面提示词手动输进去生图。",
    "no-editor"
  );
}

/**
 * 会话区里所有「像生成结果」的图片地址。
 *
 * 为什么必须限定在会话区（main）里找：
 *   首页 / 侧栏上本来就有几十张插画（示例图、推荐位），尺寸也够大。
 *   不限定范围的话，第一次调用就会把它们全当成「新出的图」，
 *   于是把一张推广插图当成生成结果存进镜头（实测踩过）。
 *   会话区在 main 里，侧栏在 aside 里，示例图在 session 之外的其它容器里。
 *
 * 判据（都要满足）：
 *   - 在 main 里；
 *   - 尺寸够大：界面图标最大 240px，生成图实测 435~580px，取 300 作分界；
 *   - 不是图标资源：图标路径带 /rc/icon/；
 *   - 不是豆包自己的网页静态资源（见 isGeneratedCandidateUrl）。
 *
 * 注意：豆包出图前会先挂一张 **SVG 占位图**，它的 naturalWidth/Height 取自
 * svg 的 width/height 属性（实测 1520x2720），照样能通过上面的尺寸判据。
 * 所以这里额外排掉 data: 的 svg，真/假最终仍以取回后的**字节魔数**为准
 * （见 sniffRasterImageExt）。
 */
/**
 * 这条图片地址是不是「豆包生成出来的图」。
 *
 * 为什么单独抽出来并且导出：尺寸判据不够用。实测（2026-10-04 探针，
 * 见 tmp/doubao-probe/all-images.json 与 T-003 试验报告第二轮）：
 *   - 真实的生成图 30/30 都在 `.../image_generation/` 下，主机是 byteimg.com；
 *   - 而豆包的**空状态插图** `.../doubao.com/obj/.../static/image/intro.*.png`
 *     是 421x360 的**真位图**（普通 URL，不是 data:svg），
 *     `naturalWidth >= 300` 拦不住它，批量场景下会被当成第 N 张生成结果绑到镜头。
 * 所以这里按「来源」判，不按尺寸判：
 *   - 豆包网页自己的静态资源（/static/ 或 /obj/）→ 不是生成结果；
 *   - 账号类资源（头像，byteacctimg.com）→ 不是生成结果。
 * 抽成纯函数是为了能直接拿 URL 单测，不用把测试页的域名改成 doubao.com。
 */
export function isGeneratedCandidateUrl(src: string): boolean {
  let u: URL;
  try {
    u = new URL(src);
  } catch {
    // 相对地址 / data: / blob: —— 生成图实测都是绝对 http(s) 地址，
    // 相对地址一律不认（它们只可能是页面自己的装饰图）。
    return false;
  }
  // 只认 http(s)。注意 `new URL('data:image/png;base64,AAAA')` 是**成功**的
  // （协议 data:），所以不能只靠 try/catch，必须显式看协议。
  if (u.protocol !== "http:" && u.protocol !== "https:") return false;
  const host = u.hostname.toLowerCase();
  const path = u.pathname.toLowerCase();
  // 豆包网页的静态资源：空状态插图、占位装饰图都在这里
  if (host.endsWith("doubao.com") && /\/(static|obj)\//.test(path)) return false;
  // 账号头像一类的资源
  if (host.endsWith("byteacctimg.com")) return false;
  return true;
}

/**
 * 导出只为让测试能断言真实判据（早期测试自己抄了一份筛选代码，改判据时它就悄悄失真了）。
 */
export async function listCandidateImages(): Promise<string[]> {
  return run<string[]>(`(() => {
    const main = document.querySelector('main') || document.body;
    return [...main.querySelectorAll('img')]
      .filter(i => i.complete)
      .filter(i => i.naturalWidth >= 300 && i.naturalHeight >= 300)
      .filter(i => !i.src.includes('/rc/icon/'))
      .filter(i => !i.src.startsWith('data:image/svg'))
      .map(i => i.src);
  })()`).then((list) => list.filter(isGeneratedCandidateUrl));
}

/**
 * 图片地址的稳定标识：去掉查询串。
 *
 * 豆包图片 URL 带 x-signature / rcl 这类会变的签名参数，同一个文件两次读到的
 * 完整 URL 可能不同；比对时必须只比路径，否则会误判成「新图」。
 */
function imageKey(src: string): string {
  return src.split("?")[0];
}

/**
 * 取一张图片字节的上限。
 *
 * 实测踩过：页面里的 `fetch` 没有任何超时，某次取图挂住 **2107 秒（35 分钟）**才返回
 * （见 docs/项目文档-by班底/30-研发/10-开发报告/T-003-试验-一次发送多张图.md 第二轮）。
 * 单镜场景下用户只是多等一会儿；批量场景下整个队列会永久停住、
 * 界面卡在「第 n / 共 m 张」不动，用户只能强杀进程。
 * 所以这里必须自己设上限，不依赖 fetch 自己会失败。
 */
export const IMAGE_FETCH_MS = 30_000;

/**
 * 在页面里把图片字节取回来（fetch 可用；canvas 会因跨域被污染，走不了）。
 *
 * 两层超时：
 *   1. 页面内的 AbortController——正常路径，能真正掐断请求；
 *   2. 主机侧的 Promise.race——兜底，防 AbortController 也卡住
 *      （比如 executeJavaScript 本身没回来，或响应体读取阶段卡死在别处）。
 */
async function fetchImageBase64(src: string, timeoutMs = IMAGE_FETCH_MS): Promise<string> {
  const script = `(async () => {
    const ctl = new AbortController();
    const timer = setTimeout(() => ctl.abort(), ${timeoutMs});
    try {
      const r = await fetch(${JSON.stringify(src)}, { signal: ctl.signal });
      if (!r.ok) throw new Error('HTTP ' + r.status);
      const blob = await r.blob();
      const buf = new Uint8Array(await blob.arrayBuffer());
      // 分块转 base64，避免大图把调用栈撑爆
      let s = '';
      const CHUNK = 0x8000;
      for (let i = 0; i < buf.length; i += CHUNK) {
        s += String.fromCharCode.apply(null, buf.subarray(i, i + CHUNK));
      }
      return btoa(s);
    } finally {
      clearTimeout(timer);
    }
  })()`;

  let hostTimer: ReturnType<typeof setTimeout> | undefined;
  const b64 = await Promise.race([
    run<string>(script),
    new Promise<never>((_, reject) => {
      // 比页面侧多留 5 秒，正常情况下先由页面侧 abort 收尾
      hostTimer = setTimeout(
        () =>
          reject(
            new DoubaoError(
              `取这张图花了超过 ${Math.round(timeoutMs / 1000)} 秒还没回来，已放弃。`,
              "fetch-timeout"
            )
          ),
        timeoutMs + 5_000
      );
    }),
  ]).finally(() => clearTimeout(hostTimer));

  if (!b64) throw new DoubaoError("取图片字节失败（内容为空）。", "fetch-empty");
  return b64;
}


export interface GeneratedImage {
  base64: string;
  ext: string;
  /** 图片来源地址，出错时便于排查 */
  src: string;
}

/**
 * 一键生图主流程：填词 → 提交 → 等新图 → 取字节。
 *
 * `onPhase` 把「正在填词 / 等待出图」回报给界面，避免用户以为卡死。
 */
export async function generateImageFromPrompt(
  prompt: string,
  opts: {
    timeoutMs?: number;
    /** 取单张图片字节的超时（默认 IMAGE_FETCH_MS）；测试用来把 30 秒压短 */
    fetchTimeoutMs?: number;
    /** 等页面渲染到「能判断有没有登录」的上限（默认 30 秒）；测试用来压短 */
    loginTimeoutMs?: number;
    /** 等输入框出现并填词的上限（默认 20 秒）；测试用来压短 */
    fillTimeoutMs?: number;
    autoSubmit?: boolean;
    onPhase?: (message: string) => void;
    /** 真正点下发送之后回调一次（批量队列用它数「提交了几条消息」，标准 2） */
    onSubmitted?: () => void;
  } = {}
): Promise<GeneratedImage> {
  const text = prompt.trim();
  if (!text) throw new DoubaoError("这个镜头还没有画面提示词。", "empty-prompt");

  const timeoutMs = opts.timeoutMs ?? IMAGE_WAIT_MS;
  const autoSubmit = opts.autoSubmit !== false;
  const say = (m: string) => opts.onPhase?.(m);

  requirePage();

  say("正在检查豆包登录状态…");
  if (!(await isDoubaoLoggedIn(opts.loginTimeoutMs))) {
    throw new DoubaoError(
      "请先登录豆包：在豆包窗口里扫码登录一次即可（登录后一直有效）。",
      "not-logged-in"
    );
  }

  say("正在准备豆包页面…");
  await ensureImagePage();
  await closeBlockingModal();
  await humanWait(300, 800);

  // 记下生成前的图片（按去签名的路径比），之后取差集就知道哪张是新出的
  const baseline = new Set((await listCandidateImages()).map(imageKey));

  say("正在把提示词写进豆包…");
  await fillPrompt(text, opts.fillTimeoutMs);
  await humanWait(250, 700);

  if (!autoSubmit) {
    /*
     * 「只填词不提交」是设置里的一个正常挡位（T-004 标准 1），不是失败：
     * 用 DoubaoError 带一个专有 code 往上抛，由调用方（doubao-shot.ts）
     * 翻成「已填好，请你去点发送」的提示，而不是当成错误报给用户。
     */
    throw new DoubaoError(
      "画面提示词已经填进豆包，请在豆包窗口里点「发送」。",
      "manual-submit"
    );
  }
  say("已提交，等待豆包出图…");
  await submitPrompt();
  opts.onSubmitted?.();

  /*
   * 等新图：拿到候选地址后**必须验证字节**再收工。
   *
   * 豆包出图前会先挂一张 SVG 占位图（尺寸判据拦不住它），早期版本直接取
   * 第一个候选就返回，于是把占位图存进了镜头，界面上是一张破图（实测踩过）。
   * 现在把「不像真图」的地址记进 rejected，下一轮继续等，直到拿到位图或超时。
   */
  const rejected = new Set<string>();
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    await humanWait(800, 2000);
    // 出图过程中可能又弹浮层，顺手关掉
    await closeBlockingModal().catch(() => false);
    const now = await listCandidateImages().catch(() => [] as string[]);
    const fresh = now.filter(
      (s) => !baseline.has(imageKey(s)) && !rejected.has(imageKey(s))
    );
    for (const src of fresh) {
      say("已出图，正在取回…");
      let base64 = "";
      try {
        /*
         * 取字节的上限不能超过「整体剩余时间」，否则循环会在 deadline 之后
         * 还多吊一次 fetch——外层超时就不再是真正的上限了。
         * （实测：外层 120 秒 + 单次 30 秒，最坏会跑到 155 秒。）
         */
        const remain = deadline - Date.now();
        const fetchBudget = Math.min(opts.fetchTimeoutMs ?? IMAGE_FETCH_MS, Math.max(1, remain));
        base64 = await fetchImageBase64(src, fetchBudget);
      } catch (e: any) {
        // 取字节失败（图还没写完 / 跨源被拦）不算它被判死，下一轮再试
        continue;
      }
      const realExt = sniffRasterImageExt(Buffer.from(base64, "base64"));
      if (!realExt) {
        /*
         * 不是位图：多半是 SVG 占位图。
         * data: 地址的内容不会再变，直接判死；普通 URL 可能先回占位、随后换成
         * 真图，所以留着下一轮再取一次。
         */
        if (src.startsWith("data:")) rejected.add(imageKey(src));
        say("豆包还在画，继续等待…");
        continue;
      }
      return { base64, ext: realExt, src };
    }
  }

  throw new DoubaoError(
    `等了 ${Math.round(timeoutMs / 1000)} 秒还没等到豆包出图。可能是豆包在排队、被限流，或页面结构已改版——也可以打开豆包窗口手动生图。`,
    "timeout"
  );
}

/**
 * 组内「张数已稳定」的判定窗口：这么久没有新图出现，就认为豆包出齐了。
 *
 * 前置实验第三轮用的是 20 秒；这里取 8 秒，因为同时还靠「首次出现过的并集」
 * 兜住虚拟列表的卸载/重挂（见 generateImagesFromPrompt 里的注释）。
 * 张数不符时宁可整组退回单发，也不赌（T-003 标准 5）。
 */
export const IMAGE_STABLE_MS = 8_000;

/**
 * 把会话区滚到底 / 回顶。
 *
 * 会话区是虚拟列表（实测 v_list_scroller：可视 619 / 内容 2947），
 * 不滚下去，后面的图根本没挂进 DOM，会误判成「还没出够」。
 */
async function scrollSession(to: "top" | "bottom"): Promise<{ h: number; shown: number } | null> {
  return run<{ h: number; shown: number } | null>(`(() => {
    const main = document.querySelector('main') || document.scrollingElement || document.body;
    const box = [...document.querySelectorAll('*')].filter((el) => {
      const cs = getComputedStyle(el);
      return (cs.overflowY === 'auto' || cs.overflowY === 'scroll') &&
        el.scrollHeight > el.clientHeight + 200;
    }).sort((a, b) => b.scrollHeight - a.scrollHeight)[0] || main;
    if (!box) return null;
    box.scrollTop = ${JSON.stringify(to)} === 'bottom' ? box.scrollHeight : 0;
    return { h: box.scrollHeight, shown: box.clientHeight };
  })()`);
}

/**
 * 提交前把会话区扫一遍，把「老图」尽量都记进基线。
 *
 * 为什么不能只查一次：虚拟列表只挂视口里的图，长会话里更早的图要滚下去才会出现。
 * 漏进基线的老图会被当成「这次新出的」，多出来的一两张会让张数校验失败 →
 * 整组退回单发（标准 5），慢但不会绑错——这是刻意的安全侧。
 */
async function sweepBaseline(): Promise<Set<string>> {
  const keys = new Set<string>();
  const collect = async () => {
    for (const src of await listCandidateImages().catch(() => [] as string[])) keys.add(imageKey(src));
  };
  await scrollSession("top").catch(() => null);
  await collect();
  await scrollSession("bottom").catch(() => null);
  await new Promise((r) => setTimeout(r, 600));
  await collect();
  await scrollSession("top").catch(() => null);
  await new Promise((r) => setTimeout(r, 600));
  await collect();
  return keys;
}

/**
 * 按组生图（T-003）：一条消息里写 N 段提示词，等豆包出 N 张，按 DOM 顺序返回。
 *
 * 与单张路径的区别只有两点：等的张数是 N；**张数不符就整体失败**，
 * 由调用方退回单发——绝不把「少了/多了」的序列按顺序硬绑到 N 个镜头上。
 */
export async function generateImagesFromPrompt(
  prompt: string,
  count: number,
  opts: {
    /** 整组的上限，调用方按「组大小 × 单张上限」给（标准 10） */
    timeoutMs?: number;
    fetchTimeoutMs?: number;
    loginTimeoutMs?: number;
    fillTimeoutMs?: number;
    /** 张数稳定窗口，测试用来压短 */
    stableMs?: number;
    autoSubmit?: boolean;
    onPhase?: (message: string) => void;
    /** 真正点下发送之后回调一次（批量队列用它数「提交了几条消息」，标准 2） */
    onSubmitted?: () => void;
  } = {}
): Promise<GeneratedImage[]> {
  const text = prompt.trim();
  if (!text) throw new DoubaoError("这一组还没有画面提示词。", "empty-prompt");
  if (!Number.isFinite(count) || count < 1) {
    throw new DoubaoError("组大小不合法（至少要 1 张）。", "bad-count");
  }

  const timeoutMs = opts.timeoutMs ?? IMAGE_WAIT_MS;
  const stableMs = opts.stableMs ?? IMAGE_STABLE_MS;
  const say = (m: string) => opts.onPhase?.(m);

  requirePage();

  say("正在检查豆包登录状态…");
  if (!(await isDoubaoLoggedIn(opts.loginTimeoutMs))) {
    throw new DoubaoError(
      "请先登录豆包：在豆包窗口里扫码登录一次即可（登录后一直有效）。",
      "not-logged-in"
    );
  }

  say("正在准备豆包页面…");
  await ensureImagePage();
  await closeBlockingModal();
  await humanWait(300, 800);

  const baseline = await sweepBaseline();

  say(`正在把 ${count} 段提示词写进豆包…`);
  await fillPrompt(text, opts.fillTimeoutMs);
  await humanWait(250, 700);

  if (opts.autoSubmit === false) {
    throw new DoubaoError(
      "画面提示词已经填进豆包，请在豆包窗口里点「发送」。",
      "manual-submit"
    );
  }
  say(`已提交，等豆包出 ${count} 张图…`);
  await submitPrompt();
  opts.onSubmitted?.();

  const deadline = Date.now() + timeoutMs;
  /**
   * key → 最新地址。插入顺序 = 首次出现在 DOM 里的顺序，也就是归位依据。
   *
   * 为什么用并集而不是「当前张数」：虚拟列表会把不在视口里的图卸载再挂回来，
   * 实测张数会 5 → 3 → 4 → 5 地回落（试验报告第三轮），只看瞬时张数会误判成「出够了」。
   */
  const seen = new Map<string, string>();
  let lastAddAt = Date.now();
  while (Date.now() < deadline) {
    await humanWait(800, 2000);
    // 出图过程中可能又弹浮层，顺手关掉
    await closeBlockingModal().catch(() => false);
    await scrollSession("bottom").catch(() => null);
    const now = await listCandidateImages().catch(() => [] as string[]);
    for (const src of now) {
      const k = imageKey(src);
      if (baseline.has(k)) continue;
      if (!seen.has(k)) lastAddAt = Date.now();
      // 同一张图的签名会刷新，留最新那个地址（老的签名叫不回字节）
      seen.set(k, src);
    }
    if (seen.size >= count && Date.now() - lastAddAt >= stableMs) break;
  }

  /*
   * 硬校验（标准 5）：张数不是「正好 count」就整体失败。
   * 少一张会让整组错位；多一张说明有别的来源混进来了（例如长会话里没进基线的老图）。
   */
  if (seen.size !== count) {
    throw new DoubaoError(
      `这一组要 ${count} 张，实到 ${seen.size} 张（豆包可能少出/多出，或页面还没画完）。这一组不绑图，退回单张补发。`,
      "count-mismatch"
    );
  }

  const images: GeneratedImage[] = [];
  for (const [k, src] of seen) {
    const remain = deadline - Date.now();
    if (remain <= 0) break;
    const budget = Math.min(opts.fetchTimeoutMs ?? IMAGE_FETCH_MS, Math.max(1, remain));
    let base64 = "";
    try {
      base64 = await fetchImageBase64(src, budget);
    } catch {
      // 取不到字节（超时 / 内容为空）当这一张不成，交给下面的硬校验判整组失败
      continue;
    }
    const ext = sniffRasterImageExt(Buffer.from(base64, "base64"));
    if (!ext) continue;
    images.push({ base64, ext, src });
  }
  if (images.length !== count) {
    throw new DoubaoError(
      `这一组要 ${count} 张，实到 ${images.length} 张（有图没取回字节，或不是位图）。这一组不绑图，退回单张补发。`,
      "count-mismatch"
    );
  }
  return images;
}

/** 重新加载（加载失败时给用户一个重试入口） */
export function reloadDoubao(): DoubaoState {
  if (hasPanel()) {
    open = true;
    setFrozen(false);
    // 用户点的「重载」：窗口本来就看得见，保持亮着，重载时别把白页藏起来
    panelWin!.show();
    setStatus("loading", "正在重新打开豆包…");
    // 重载等于把窗口重新摆给用户看：看门狗也跟着重新起步
    startLoginWatch();
    panelWin!.webContents.loadURL(targetUrl()).catch((e) => {
      console.error("[doubao] 重载失败：", e?.message ?? e);
      setStatus("error", "豆包页面没能打开（网络不通，或豆包已改版）。点「重载」再试一次。");
    });
    return currentState();
  }
  /*
   * 没有豆包窗口、只有离屏 worker：真正加载中时的重试出口（生图那边页面挂了也能救回来）。
   * 重载后窗口并不会因此显示出来 —— worker 一直是"用户看不见"的。
   */
  if (workerWin && !workerWin.isDestroyed()) {
    workerLoaded = false;
    workerStatus = "loading";
    workerMessage = "";
    emit();
    void workerWin.webContents.loadURL(targetUrl()).catch((e) => {
      console.error("[doubao] 后台页面重载失败：", e?.message ?? e);
      workerStatus = "error";
      workerMessage = "豆包页面没能打开（网络不通，或豆包已改版）。点「重载」再试一次。";
      emit();
    });
  }
  return currentState();
}

/**
 * 把分区的登录态落到磁盘。
 *
 * 数据目录迁移前请先调 releaseDoubaoBeforeMigration()：页面开着时 Chromium
 * 一直占着分区的 cookie / 缓存文件，直接复制会拷到半截状态。
 *
 * 必须两个都调：
 *   - cookies.flushStore()：**只**刷 cookie 库。实测只用 flushStorageData()
 *     时，刚 set 的 cookie 经常还没写进 Network/Cookies，迁移数据目录就会把
 *     用户刚登录的状态漏掉（实测：源目录文件里没有该 cookie，复制过去自然也没有）。
 *   - flushStorageData()：刷 localStorage / IndexedDB 等站点存储。
 *
 * 关豆包窗口、迁移数据目录前都会调它。
 */
export function flushDoubaoStorage(): void {
  try {
    const ses = session.fromPartition(PARTITION);
    void ses.cookies.flushStore().catch(() => {});
    ses.flushStorageData();
  } catch {
    /* 没有这个分区（从没打开过豆包窗口）就算了 */
  }
}

/**
 * 数据目录迁移前调用：先释放文件占用，再刷盘。
 *
 * 页面活着的时候 Chromium 一直占着分区的 cookie / 缓存文件，复制会拷到半截状态。
 * 所以先把豆包窗口整个销毁（destroyPanel 内部会刷一次盘），迁移完用户重开即可——
 * 登录态在磁盘上，跟着数据目录一起走。
 */
export function releaseDoubaoBeforeMigration(): void {
  destroyPanel();
  destroyWorker();
  flushDoubaoStorage();
}
