/**
 * 只读探针：真实豆包页里，生成图和「界面插图」在 DOM / URL 上怎么区分。
 *
 *   npm run probe:doubao-images
 *
 * 背景：批量试验第二轮里，候选筛选把豆包自己的空状态插图（421x360、普通 URL）
 * 当成了生成结果（见 T-003 试验报告第二轮）。现有判据是
 *   main 内 + complete + naturalWidth/Height>=300 + 排除 /rc/icon/ + 排除 data:svg
 * 拦不住它。这个探针不改任何东西，只把页面上所有 img 的特征打出来，
 * 用来找出「生成图独有、插图没有」的硬特征。
 *
 * 需要先退出宝螺（复用同一分区 persist:doubao 的登录态）。
 */
const path = require("node:path");
const fs = require("node:fs");
const { app, BrowserWindow, session } = require("electron");

const ROOT = path.join(__dirname, "..");
const OUT = path.join(ROOT, "tmp", "doubao-probe");
const PARTITION = "persist:doubao";
const DOUBAO_URL = "https://www.doubao.com/chat/create-image";
const UA_DESKTOP =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 " +
  "(KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36";

function resolveDataDir() {
  if (process.env.BAOLUO_DATA_DIR) return path.resolve(process.env.BAOLUO_DATA_DIR);
  const appData = process.env.APPDATA || path.join(process.env.USERPROFILE || "", "AppData", "Roaming");
  // 默认目录 %APPDATA%\Baoluo 优先，老版本留下的 C:\Baoluo\data 其次
  for (const p of [path.join(appData, "Baoluo", "data-root.txt"), path.join("C:\\Baoluo\\data", "data-root.txt")]) {
    try {
      const raw = fs.readFileSync(p, "utf-8").trim();
      if (raw && fs.existsSync(raw)) return path.resolve(raw);
    } catch {}
  }
  return path.join(appData, "Baoluo");
}
app.setPath("userData", resolveDataDir());

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** 把每张图的全部可辨特征抓回来，不做任何过滤 */
const PROBE = `(() => {
  const all = [...document.querySelectorAll('img')];
  const inMain = (el) => !!el.closest('main');
  return all.map((i, idx) => {
    const r = i.getBoundingClientRect();
    return {
      idx,
      inMain: inMain(i),
      complete: i.complete,
      nw: i.naturalWidth,
      nh: i.naturalHeight,
      cw: Math.round(r.width),
      ch: Math.round(r.height),
      visible: r.width > 0 && r.height > 0,
      src: i.src.slice(0, 260),
      // 下面这些是候选判据可能用到的特征
      hasTplv: /tplv-/.test(i.src),
      hasCgen: /cgen/i.test(i.src),
      isIntro: /intro\\./i.test(i.src),
      isIcon: /\\/rc\\/icon\\//.test(i.src),
      isDataSvg: i.src.startsWith('data:image/svg'),
      cls: (i.className || '').toString().slice(0, 120),
      parentCls: (i.parentElement?.className || '').toString().slice(0, 120),
      // 往上 8 层的 class 链，找「生成图容器」的稳定标记
      chain: (() => {
        const out = [];
        let n = i;
        for (let k = 0; k < 8 && n; k++) {
          const c = (n.className || '').toString();
          if (c) out.push(c.slice(0, 80));
          n = n.parentElement;
        }
        return out;
      })(),
    };
  });
})()`;

(async () => {
  await app.whenReady();
  fs.mkdirSync(OUT, { recursive: true });
  const ses = session.fromPartition(PARTITION);
  ses.setUserAgent(UA_DESKTOP);

  const win = new BrowserWindow({
    width: 1280,
    height: 900,
    show: true,
    title: "宝螺探针：豆包图片特征",
    webPreferences: { partition: PARTITION },
  });
  await win.loadURL(DOUBAO_URL);
  console.log("页面已加载，等渲染…");
  await sleep(8000);

  const all = await win.webContents.executeJavaScript(PROBE).catch((e) => {
    console.log("探针失败：", e?.message ?? e);
    return [];
  });

  fs.writeFileSync(path.join(OUT, "all-images.json"), JSON.stringify(all, null, 2), "utf8");

  const cur = `(() => {
    const main = document.querySelector('main') || document.body;
    return [...main.querySelectorAll('img')]
      .filter(i => i.complete)
      .filter(i => i.naturalWidth >= 300 && i.naturalHeight >= 300)
      .filter(i => !i.src.includes('/rc/icon/'))
      .filter(i => !i.src.startsWith('data:image/svg'))
      .map(i => i.src);
  })()`;
  const pass = await win.webContents.executeJavaScript(cur).catch(() => []);
  console.log(`\n页面上 img 总数：${all.length}`);
  console.log(`现有判据的通过数：${pass.length}`);
  console.log("\n通过现有判据的每一条（这些就是「会被当成生成图」的）：");
  for (const s of pass) {
    const hit = all.find((a) => a.src === s.slice(0, 260));
    console.log(`  ${hit ? hit.nw + "x" + hit.nh : "?"}  tplv=${hit?.hasTplv} cgen=${hit?.hasCgen} intro=${hit?.isIntro}  ${s.slice(0, 140)}`);
  }
  const passKeys = new Set(pass.map((s) => s.split("?")[0]));
  const excluded = all.filter(
    (x) => x.inMain && x.nw >= 300 && x.nh >= 300 && !passKeys.has(x.src.split("?")[0])
  );
  console.log(`\n在 main 内、够大、但**没**通过判据的（判据挡掉了什么）：${excluded.length} 张`);
  for (const x of excluded.slice(0, 20)) {
    console.log(`  ${x.nw}x${x.nh}  icon=${x.isIcon} dataSvg=${x.isDataSvg}  ${x.src.slice(0, 130)}`);
  }

  // 按「真实生成图」的可能特征分组统计，看哪个特征能把插图干净地分出去
  const mainBig = all.filter((x) => x.inMain && x.nw >= 300 && x.nh >= 300);
  const byHost = {};
  for (const x of mainBig) {
    let host = "?";
    try {
      host = new URL(x.src).host;
    } catch {}
    byHost[host] = (byHost[host] || 0) + 1;
  }
  console.log("\nmain 内、>=300px 的图按主机分组：");
  for (const [h, n] of Object.entries(byHost).sort((p, q) => q[1] - p[1])) {
    console.log(`  ${String(n).padStart(3)}  ${h}`);
  }
  const withTplv = mainBig.filter((x) => x.hasTplv).length;
  const withGenPath = mainBig.filter((x) => /\\/image_generation\\//.test(x.src)).length;
  const withByteimg = mainBig.filter((x) => /byteimg\\.com/.test(x.src)).length;
  console.log(`\n特征命中（分母 ${mainBig.length}）：`);
  console.log(`  含 ~tplv-          ：${withTplv}`);
  console.log(`  含 /image_generation/：${withGenPath}`);
  console.log(`  主机含 byteimg.com  ：${withByteimg}`);
  console.log(`\n明细已存：${path.join(OUT, "all-images.json")}`);
  app.exit(0);
})().catch((e) => {
  console.error("探针抛错 —", e?.stack || e?.message || e);
  app.exit(1);
});
