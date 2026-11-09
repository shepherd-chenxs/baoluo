/**
 * 文字卡视频：文案 → 卡片图 → 成片。
 *
 * 这里只放**纯字符串**的东西（解析、尺寸、HTML 模板），因为两头都要用：
 *   · 渲染层拿它做实时预览（iframe srcDoc）；
 *   · 主进程拿它出图（离屏窗口加载同一份 HTML 再截图）。
 * 同一份模板 = 预览与成片长得一模一样，不会出现"预览好看、导出变样"。
 */

/** 六套外观：极简白 / 黑金 / 便签 / 大字报 / 奶油渐变 / 手写抄书 */
export type TextCardStyle = "plain" | "dark" | "note" | "poster" | "cream" | "hand";
/** 三种画幅 */
export type TextCardRatio = "portrait" | "landscape" | "square";
/** 卡内运动：auto=按卡号在推近/平移/拉远里轮换，其余固定 */
export type TextCardMotion = "auto" | "in" | "out" | "pan" | "still";
/** 卡间转场：黑场淡入淡出 / 白闪 / 硬切 */
export type TextCardTransition = "fade" | "flash" | "cut";

export interface TextCard {
  /** 大字（一句主文案） */
  lead: string;
  /** 小字（可选解释，保留换行） */
  body: string;
}

export interface TextCardOptions {
  style: TextCardStyle;
  ratio: TextCardRatio;
  /** 每张停留秒数：配音失败/无配音的卡用；配音成功时以语音时长为准 */
  seconds: number;
  /**
   * 每张卡各自的停留秒数（模板 auto 档传）：按字数算的节奏，一张一档。
   * 给了就按这张的来，没给的卡回退 seconds。配音成功的卡仍以语音时长为准。
   */
  durations?: number[];
  /** 配音音色：不传/空 = 静音模式；Edge 音色名或 "clone:<id>"（本地克隆） */
  voice?: string;
  /** BGM 音频路径；不传 = 无 BGM */
  bgmPath?: string;
  /** BGM 音量 0~1，缺省 0.15 */
  bgmVolume?: number;
  /** 卡内运动，缺省 auto（轮换） */
  motion?: TextCardMotion;
  /** 卡间转场，缺省 fade */
  transition?: TextCardTransition;
}

export interface TextCardRequest {
  requestId?: string;
  cards: TextCard[];
  options: TextCardOptions;
}

export interface TextCardProgress {
  requestId: string;
  stage: "capture" | "voice" | "compose" | "done";
  /** 当前第几张（从 1 数） */
  index: number;
  total: number;
  percent: number;
  message: string;
}

export interface TextCardResult {
  videoPath: string;
  /** 成片时长（秒） */
  durationSec: number;
  count: number;
  /** 非致命提示（如部分配音失败回退固定节奏）；正常为空 */
  note?: string;
}

export const TEXT_CARD_STYLES: Array<{ value: TextCardStyle; label: string }> = [
  { value: "plain", label: "极简白" },
  { value: "dark", label: "黑金" },
  { value: "note", label: "便签" },
  { value: "poster", label: "大字报" },
  { value: "cream", label: "奶油渐变" },
  { value: "hand", label: "手写抄书" },
];

export const TEXT_CARD_MOTIONS: Array<{ value: TextCardMotion; label: string }> = [
  { value: "auto", label: "自动轮换" },
  { value: "in", label: "推近" },
  { value: "out", label: "拉远" },
  { value: "pan", label: "平移" },
  { value: "still", label: "静止" },
];

export const TEXT_CARD_TRANSITIONS: Array<{ value: TextCardTransition; label: string }> = [
  { value: "fade", label: "淡入淡出" },
  { value: "flash", label: "白闪" },
  { value: "cut", label: "硬切" },
];

export const TEXT_CARD_RATIOS: Array<{ value: TextCardRatio; label: string; hint: string }> = [
  { value: "portrait", label: "竖屏", hint: "9:16 · 1080×1920" },
  { value: "landscape", label: "横屏", hint: "16:9 · 1920×1080" },
  { value: "square", label: "方形", hint: "1:1 · 1080×1080" },
];

/**
 * 模板 = 一次「做同款」的全部参数。
 *
 * 产品定位：用户**选模板**，不调参数——外观、画幅、动效、转场、节奏都由模板自带。
 * seconds 给 "auto" 表示节奏按每张卡的字数自动算（见 autoSeconds），这是默认档；
 * 想要固定节奏的模板（如大字报的卡点）就给数字。
 * 最后一张 "custom" 是伪模板：选它才露出全部参数（老用户的自由档）。
 */
export interface TextCardTemplate {
  id: string;
  name: string;
  /** 一句话：这套模板适合什么内容 */
  tagline: string;
  style: TextCardStyle;
  ratio: TextCardRatio;
  motion: TextCardMotion;
  transition: TextCardTransition;
  seconds: number | "auto";
}

export const TEXT_CARD_TEMPLATES: TextCardTemplate[] = [
  { id: "quote", name: "金句白卡", tagline: "大留白，万能默认", style: "plain", ratio: "portrait", motion: "auto", transition: "fade", seconds: "auto" },
  { id: "dark-gold", name: "黑金质感", tagline: "深底金字，情感夜读", style: "dark", ratio: "portrait", motion: "pan", transition: "fade", seconds: "auto" },
  { id: "note", name: "便签手记", tagline: "手账感，生活记录", style: "note", ratio: "portrait", motion: "still", transition: "fade", seconds: "auto" },
  { id: "poster", name: "大字报", tagline: "卡点快节奏金句", style: "poster", ratio: "portrait", motion: "in", transition: "flash", seconds: 1.5 },
  { id: "cream", name: "奶油渐变", tagline: "小红书卡片感", style: "cream", ratio: "portrait", motion: "pan", transition: "fade", seconds: "auto" },
  { id: "hand", name: "手写抄书", tagline: "信纸楷体，抄书号", style: "hand", ratio: "portrait", motion: "still", transition: "fade", seconds: "auto" },
  { id: "cinema", name: "影院横屏", tagline: "16:9，B 站/桌面", style: "dark", ratio: "landscape", motion: "pan", transition: "fade", seconds: "auto" },
  { id: "square", name: "社媒方图", tagline: "1:1，朋友圈/群发", style: "plain", ratio: "square", motion: "in", transition: "fade", seconds: "auto" },
  { id: "custom", name: "自定义", tagline: "画幅节奏自己调", style: "plain", ratio: "portrait", motion: "auto", transition: "fade", seconds: 2.5 },
];

/** 自定义那张伪模板的 id（界面靠它判断要不要露出参数区） */
export const CUSTOM_TEMPLATE_ID = "custom";

/**
 * auto 档：一张卡停多久。
 * 读一句的节奏 = 大字扫一眼 + 小字按字数；纯大字的卡短、解释长的卡长。
 * 1.2s 底 + 大字 0.08s/字 + 小字 0.13s/字，压在 1.6~8s 之间。
 */
export function autoSeconds(card: TextCard): number {
  const lead = [...stripCardMarkers(card.lead)].length;
  const body = [...stripCardMarkers(card.body).replace(/\s/g, "")].length;
  const t = 1.2 + lead * 0.08 + body * 0.13;
  return +Math.min(8, Math.max(1.6, t)).toFixed(2);
}

/** 画布像素尺寸（都按 1080 短边，字号体系才统一） */
export function cardSize(ratio: TextCardRatio): { w: number; h: number } {
  if (ratio === "landscape") return { w: 1920, h: 1080 };
  if (ratio === "square") return { w: 1080, h: 1080 };
  return { w: 1080, h: 1920 };
}

export const DEFAULT_CARD_TEXT = `想做就去做
别等准备好了才开始，
*准备*永远不会有尽头。

慢一点也没关系
方向对了，
慢就是快。`;

/**
 * 文案 → 卡片。
 *
 * 规则故意简单（用户不用学语法）：
 *   · 空行分卡；
 *   · 每段第一行是大字，其余行是解释；
 *   · 想显式指定大字就给它加 `#`（去掉井号当大字，后面几行仍是解释）。
 * 一段只有一行时，那行就是大字、没有解释。
 */
export function parseCards(text: string): TextCard[] {
  const blocks = (text ?? "")
    .replace(/\r\n?/g, "\n")
    .split(/\n[ \t]*\n/)
    .map((b) => b.trim())
    .filter(Boolean);

  return blocks.map((block) => {
    const lines = block
      .split("\n")
      .map((l) => l.trim())
      .filter(Boolean);
    if (!lines.length) return { lead: "", body: "" };
    const first = lines[0].replace(/^#+\s*/, "");
    if (lines.length === 1) return { lead: first, body: "" };
    return { lead: first, body: lines.slice(1).join("\n") };
  });
}

function esc(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

/** 去掉 *标记* 语法里的星号：字号计算和 TTS 朗读都用纯文本 */
export function stripCardMarkers(s: string): string {
  return (s ?? "").replace(/\*/g, "");
}

/** esc 之后再把 *词* 包成关键词 span（星号不受 esc 影响，先 esc 后包；不跨行配对） */
function marked(s: string): string {
  return s.replace(/\*([^*\n]+)\*/g, '<span class="kw">$1</span>');
}

/**
 * 大字随字数收字号。
 * 可用宽度约 840px（1080 - 左右各 120 留白），按"一行尽量放得下"来排：
 * 7 个字给 132px 会挤成 6+1，很难看，所以超过 6 个字就降一档。
 * 横屏可用宽度是 1600，整体乘 1.35 才不会显得小气（见 leadScale）。
 */
function leadSize(lead: string): number {
  const n = [...lead].length;
  if (n <= 6) return 132;
  if (n <= 8) return 100;
  if (n <= 12) return 82;
  if (n <= 18) return 64;
  if (n <= 26) return 52;
  return 44;
}

/** 横屏字大一号：同样 8 个字，竖屏占满一行，横屏只占一半，看着像忘了放大 */
function leadScale(ratio: TextCardRatio): number {
  return ratio === "landscape" ? 1.35 : 1;
}

/** 内边距：横屏左右留得多、竖屏上下留得多；便签要把纸撑满（胶带要贴到边上）；
 *  奶油渐变的外圈留小些——浮层（.ink 自己的底）要大才有小红书卡片感 */
function padding(ratio: TextCardRatio, style: TextCardStyle): string {
  if (style === "note") return ratio === "landscape" ? "44px 56px" : "44px 44px";
  if (style === "cream") return ratio === "landscape" ? "56px 64px" : "60px 46px";
  if (ratio === "landscape") return "120px 160px";
  if (ratio === "square") return "110px 120px";
  return "150px 120px";
}

const BASE_CSS = `
*{box-sizing:border-box;margin:0;padding:0}
html,body{background:#000}
.card{position:relative;display:flex;flex-direction:column;justify-content:center;overflow:hidden;
  font-family:"Microsoft YaHei","PingFang SC","Noto Sans SC",system-ui,sans-serif;
  -webkit-font-smoothing:antialiased}
.card .ink{position:relative;z-index:2}
.card .lead{font-weight:700;line-height:1.3;letter-spacing:.01em;white-space:pre-wrap;word-break:break-word;text-wrap:balance}
.card .rule{width:calc(64px * var(--s,1));height:calc(3px * var(--s,1));margin:calc(40px * var(--s,1)) 0 calc(34px * var(--s,1));border-radius:2px}
.card .body{font-size:calc(40px * var(--s,1));line-height:1.85;letter-spacing:.01em;white-space:pre-wrap;word-break:break-word}
.card .pg{position:absolute;right:64px;bottom:56px;z-index:3;
  font-size:28px;letter-spacing:.14em;font-variant-numeric:tabular-nums}

/* 极简白：大留白，只有一条短横线 */
.card.plain{background:#ffffff;color:#141414}
.card.plain .rule{background:#141414}
.card.plain .body{color:#5c5c5c}
.card.plain .pg{color:#9a9a9a}

/* 黑金：细框 + 金色大字 + 深底。
   底色**必须是纯色**：分块截图再拼接时，径向渐变会在每块里各自抖动，
   拼缝处出现一道明显的色带（踩过一次，暗色下特别显眼）。 */
.card.dark{background:#0b0b0d;color:#f4f1ea}
.card.dark:before{content:"";position:absolute;inset:44px;border:1px solid rgba(216,178,106,.34)}
.card.dark .lead{color:#e8c88a;font-family:"Songti SC","SimSun","Noto Serif SC",serif}
.card.dark .rule{background:rgba(216,178,106,.75)}
.card.dark .body{color:#b9b3a8}
.card.dark .pg{color:#7d766a}

/* 便签：米色桌面上放一张白纸，纸顶贴一条胶带 */
.card.note{background:#e9e0cc;color:#33291c;justify-content:stretch}
.card.note .ink{flex:1;display:flex;flex-direction:column;justify-content:center;position:relative;
  padding:96px 84px;background:#fffdf7;border:1px solid rgba(0,0,0,.05);
  box-shadow:0 22px 60px rgba(80,62,35,.16)}
.card.note .ink:before{content:"";position:absolute;top:-24px;left:50%;width:240px;height:50px;
  transform:translateX(-50%);background:rgba(255,255,255,.62);box-shadow:0 2px 6px rgba(0,0,0,.05)}
.card.note .lead{font-family:"Songti SC","SimSun","Noto Serif SC",serif;color:#2f2517}
.card.note .rule{background:rgba(120,94,56,.55)}
.card.note .body{color:#5b4c37}
.card.note .pg{color:#9c8b73}

/* 大字报：纯黑 + 特大白字 + 关键词亮黄 —— 金句号标配 */
.card.poster{background:#050505;color:#fff}
.card.poster .lead{font-weight:900;letter-spacing:.02em}
.card.poster .rule{background:rgba(255,255,255,.24)}
.card.poster .body{color:#9a9a9a}
.card.poster .pg{color:#5c5c5c}
.card.poster .kw{color:#ffd60a}

/* 奶油渐变：渐变底画在 body 上（见 bodyBackdrop，按卡高一个周期），卡身透明 +
   白色半透明浮层。渐变不能画在 .card 上——分块截图时每块各自重绘渐变会出拼缝（黑金同款坑），
   画在 body 上整页一次绘制，tile 只是裁同一张已画好的页面。白字压浅渐变靠投影撑可读性。 */
.card.cream{background:transparent;color:#fff}
.card.cream .ink{background:rgba(255,255,255,.17);border-radius:44px;padding:84px 72px;
  box-shadow:0 24px 70px rgba(80,50,120,.20)}
.card.cream .lead{text-shadow:0 4px 22px rgba(90,60,120,.38)}
.card.cream .rule{background:rgba(255,255,255,.62)}
.card.cream .body{color:rgba(255,255,255,.94);text-shadow:0 3px 16px rgba(90,60,120,.32)}
.card.cream .pg{color:rgba(255,255,255,.78)}
.card.cream .kw{color:#ffdf6b}

/* 手写抄书：米色信纸 + 横线（同样画在 body 上整页连续，tile 拼接不错位）+ 系统楷体 */
.card.hand{background:transparent;color:#3a2f23}
.card.hand .lead,.card.hand .body{font-family:"Kaiti SC","STKaiti","KaiTi","楷体","LXGW WenKai",serif}
.card.hand .rule{background:rgba(160,94,60,.5)}
.card.hand .body{color:#55432e}
.card.hand .pg{color:#a08a68}

/* 关键词（*词* 标记）：浅色系荧光黄底，深色系亮黄字 */
.card .kw{border-radius:.16em;padding:0 .1em}
.card.plain .kw,.card.note .kw,.card.hand .kw{background:rgba(255,222,89,.62)}
`;

function cardHtml(
  card: TextCard,
  index: number,
  total: number,
  opts: TextCardOptions
): string {
  const { w, h } = cardSize(opts.ratio);
  const pad = padding(opts.ratio, opts.style);
  const s = leadScale(opts.ratio);
  const pg = `${String(index + 1).padStart(2, "0")} / ${String(total).padStart(2, "0")}`;
  const body = card.body.trim();
  return `<section class="card ${opts.style}" style="width:${w}px;height:${h}px;padding:${pad}">
  <div class="ink" style="--s:${s}">
    <div class="lead" style="font-size:${Math.round(leadSize(stripCardMarkers(card.lead)) * s)}px">${marked(esc(card.lead))}</div>
    ${body ? `<div class="rule"></div><div class="body">${marked(esc(body))}</div>` : ""}
  </div>
  <span class="pg">${pg}</span>
</section>`;
}

/**
 * 整页底：只有奶油渐变和信纸横线这两套模板把底画在 body 上——
 * 必须整页一次绘制（tile 只是从同一张页面上裁块），画在 .card 里会分块重绘出拼缝。
 * 渐变按「一张卡的高度」为一个周期（background-size + repeat-y），保证每张卡的
 * 底色一致、预览（单卡页面）和成片（长页里的一段）长得一样。
 */
function bodyBackdrop(style: TextCardStyle, h: number): string {
  if (style === "cream") {
    return `body{background:linear-gradient(165deg,#cbb9f6 0%,#ffd8e9 52%,#ffeadb 100%);
  background-size:100% ${h}px;background-repeat:repeat-y}`;
  }
  if (style === "hand") {
    return `body{background:repeating-linear-gradient(to bottom,#f7f1e3 0,#f7f1e3 87px,#e9dbc2 87px,#e9dbc2 88px)}`;
  }
  return `body{background:#000}`;
}

/** 预览：只画一张，居中显示 */
export function buildPreviewHtml(
  card: TextCard,
  index: number,
  total: number,
  opts: TextCardOptions
): string {
  const { w, h } = cardSize(opts.ratio);
  return `<!doctype html><html><head><meta charset="utf-8"><style>${BASE_CSS}
${bodyBackdrop(opts.style, h)}
html,body{width:${w}px;height:${h}px;overflow:hidden}
</style></head><body>${cardHtml(card, index, total, opts)}</body></html>`;
}

/**
 * 出图用：所有卡竖着排成一列，一张一屏。
 * 主进程开一个窗口加载它，然后按 `y = i * 高度` 逐块截图——
 * 一次加载多次截取，比一张卡开一次窗口快得多。
 */
export function buildCardsHtml(cards: TextCard[], opts: TextCardOptions): string {
  const { w, h } = cardSize(opts.ratio);
  const list = cards.map((c, i) => cardHtml(c, i, cards.length, opts)).join("\n");
  return `<!doctype html><html><head><meta charset="utf-8"><style>${BASE_CSS}
html,body{width:${w}px;background:#000;overflow:auto}
/* 出图要按块滚动截取（窗口装不下整张卡），滚动条会挡字：藏掉 */
::-webkit-scrollbar{width:0;height:0;display:none}
.card{display:flex}
${bodyBackdrop(opts.style, h)}
</style></head><body>${list}</body></html>`;
}
