import { BrowserWindow, session, Session } from "electron";

const UA_DESKTOP =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 " +
  "(KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36";

export interface ExtractedPayload {
  videoSrc: string;
  meta: { title?: string; desc?: string; cover?: string };
  router: any | null;
  source?: string;
}

export async function extractShareData(
  awemeId: string,
  opts: { timeoutMs?: number; debug?: boolean } = {}
): Promise<ExtractedPayload> {
  const timeoutMs = opts.timeoutMs ?? 35_000;

  const ses: Session = session.fromPartition("bee-parse-" + Date.now() + "-" + Math.random(), {
    cache: false,
  });

  // 抖音页面偶尔会尝试打开 App 深链，主动接管这些 scheme，避免系统弹窗。
  const DEEP_LINK_SCHEMES = ["snssdk1128", "snssdk", "aweme", "bytedance", "toutiao"];
  for (const scheme of DEEP_LINK_SCHEMES) {
    try {
      if (ses.protocol.isProtocolHandled(scheme)) continue;
      ses.protocol.handle(scheme, () => new Response("", { status: 204 }));
    } catch {
      /* noop */
    }
  }

  const win = new BrowserWindow({
    show: true,
    x: -10000,
    y: -10000,
    width: 1200,
    height: 900,
    skipTaskbar: true,
    focusable: false,
    minimizable: false,
    webPreferences: {
      session: ses,
      contextIsolation: true,
      nodeIntegration: false,
      backgroundThrottling: false,
    },
  });
  win.webContents.setUserAgent(UA_DESKTOP);
  /**
   * 这个窗口是离屏的，但页面里的视频会真的播出来——用户在电脑上就听见声音了，
   * 却不知道是谁在放。抓数据用不着声音，直接静音。
   */
  win.webContents.setAudioMuted(true);

  const isHttpUrl = (u: string) => /^https?:\/\//i.test(u);
  win.webContents.on("will-navigate", (e, u) => {
    if (!isHttpUrl(u)) e.preventDefault();
  });
  win.webContents.on("will-frame-navigate" as any, (e: any, u: string) => {
    const url = typeof u === "string" ? u : e?.url;
    if (url && !isHttpUrl(url)) e.preventDefault?.();
  });
  win.webContents.setWindowOpenHandler(() => ({ action: "deny" }));

  let detailJson: any = null;
  let debuggerReady = false;

  // 先加载一个空白页，确保 renderer 就绪后再 attach CDP，否则 sendCommand 可能挂起。
  try {
    await win.loadURL("about:blank");
    await waitForFinish(win, 5000);
    win.webContents.debugger.attach("1.3");
    await win.webContents.debugger.sendCommand("Network.enable");
    debuggerReady = true;
  } catch {
    debuggerReady = false;
  }

  if (debuggerReady) {
    const detailRequestIds = new Set<string>();
    win.webContents.debugger.on("message", (_e, method, params) => {
      try {
        if (method === "Network.responseReceived") {
          const url: string | undefined = params?.response?.url;
          if (url && /aweme\/v1\/web\/aweme\/detail\//.test(url)) {
            detailRequestIds.add(params.requestId);
          }
        } else if (method === "Network.loadingFinished") {
          if (detailRequestIds.has(params.requestId) && !detailJson) {
            win.webContents.debugger
              .sendCommand("Network.getResponseBody", { requestId: params.requestId })
              .then((body: any) => {
                try {
                  const j = JSON.parse(body?.body ?? "");
                  if (j?.aweme_detail) detailJson = j;
                } catch {
                  /* noop */
                }
              })
              .catch(() => {});
          }
        }
      } catch {
        /* noop */
      }
    });
  }

  try {
    const url = `https://www.douyin.com/video/${awemeId}`;
    win.loadURL(url, { httpReferrer: "https://www.douyin.com/" }).catch(() => {});

    const deadline = Date.now() + timeoutMs;
    /**
     * DOM 兜底什么时候开始认：
     * 详情接口能拿到时优先用接口（标题、作者、时长都在里面）；
     * 接口一直不来（推荐页、精选弹层就是这种）才退到 DOM。
     */
    const domFallbackAfter = debuggerReady ? Date.now() + 6_000 : 0;
    let domMeta: any = {};

    while (Date.now() < deadline) {
      await sleep(400);

      if (detailJson) break;

      /**
       * 一直读 DOM：
       *   1) 拿页面里的标题/封面当提示（最后报错时用得上）
       *   2) 接口没发（推荐页、精选弹层就是这种）或者响应体取不到时，页面里那个
       *      <video> 早就拿到真地址了——CDP 接上了也要留这条兜底，否则就只能干等到超时。
       */
      const p = await safeExecute(win);
      if (p?.meta) domMeta = p.meta;
      if (Date.now() >= domFallbackAfter && p?.state === "ok" && p.videoSrc && !p.videoSrc.startsWith("blob:")) {
        detailJson = {
          aweme_detail: {
            video: { play_addr: { url_list: [p.videoSrc] } },
            desc: p.meta?.desc || p.meta?.title,
          },
          domFallback: true,
        };
        break;
      }
    }

    if (!detailJson) {
      throw new Error(
        "解析超时：未能从抖音详情接口取到视频源（lastState: " +
          JSON.stringify({
            debuggerReady,
            domMeta,
            href: win.isDestroyed() ? "destroyed" : win.webContents.getURL(),
          }) +
          "）"
      );
    }

    const aweme = detailJson?.aweme_detail ?? null;
    const videoSrc = pickBestPlayUrl(aweme);
    if (!videoSrc) {
      throw new Error("详情接口已返回，但其中没有可用的视频播放地址");
    }

    const meta = {
      title: String(aweme?.desc ?? "").trim(),
      desc: String(aweme?.desc ?? "").trim(),
      cover: String(aweme?.video?.cover?.url_list?.[0] ?? aweme?.video?.origin_cover?.url_list?.[0] ?? ""),
    };

    return {
      videoSrc,
      meta,
      router: detailJson ?? null,
      source: detailJson?.domFallback ? "dom" : "api",
    };
  } finally {
    try {
      if (win.webContents.debugger.isAttached()) win.webContents.debugger.detach();
    } catch {
      /* noop */
    }
    if (!win.isDestroyed()) win.destroy();
    try {
      await ses.clearStorageData();
    } catch {
      /* noop */
    }
  }
}

function pickBestPlayUrl(aweme: any): string | null {
  if (!aweme?.video) return null;
  const direct = aweme.video.play_addr?.url_list?.[0] ?? aweme.video.playAddr?.urlList?.[0];
  const bitRates = aweme.video.bit_rate ?? aweme.video.bitRate;
  if (Array.isArray(bitRates) && bitRates.length) {
    const sorted = [...bitRates].sort(
      (a: any, b: any) => (Number(b?.bit_rate ?? b?.bitRate ?? 0)) - (Number(a?.bit_rate ?? a?.bitRate ?? 0))
    );
    const best = sorted[0]?.play_addr?.url_list?.[0] ?? sorted[0]?.playAddr?.urlList?.[0];
    if (typeof best === "string" && best.startsWith("http")) return best;
  }
  return typeof direct === "string" && direct.startsWith("http") ? direct : null;
}

async function safeExecute(win: BrowserWindow): Promise<any> {
  try {
    return await win.webContents.executeJavaScript(EXTRACT_SCRIPT, true);
  } catch {
    return { state: "throw" };
  }
}

async function waitForFinish(win: BrowserWindow, timeoutMs: number): Promise<void> {
  if (win.isDestroyed()) return;
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (!win.webContents.isLoading()) return;
    await sleep(50);
  }
}

const EXTRACT_SCRIPT = `(() => {
  try {
    const href = location.href;
    const ready = document.readyState;
    const v = document.querySelector('video');
    const videoSrc = v ? (v.currentSrc || v.src) : null;
    const desc = document.querySelector('meta[name="description"]')?.content;
    const ogTitle = document.querySelector('meta[property="og:title"]')?.content;
    const ogImage = document.querySelector('meta[property="og:image"]')?.content;
    const meta = { title: ogTitle || document.title, desc, cover: ogImage || (v && v.poster) || '' };
    return { state: 'ok', href, ready, videoSrc, meta };
  } catch (e) {
    return { state: 'err', msg: String(e) };
  }
})()`;

function sleep(ms: number) {
  return new Promise((r) => setTimeout(r, ms));
}
