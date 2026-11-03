import crypto from "node:crypto";
import { net } from "electron";
import type { VideoMeta } from "../../shared/dialogue-types";
import { extractAnyUrl } from "./extractUrl";
import { fetchJson, firstHttpUrl, UA_DESKTOP } from "./html";

const BVID_RE = /BV[0-9A-Za-z]{10}/;
const AID_RE = /(?:av|aid=)(\d+)/i;

const BILI_HEADERS = {
  "User-Agent": UA_DESKTOP,
  Referer: "https://www.bilibili.com/",
  "Accept-Language": "zh-CN,zh;q=0.9",
};

/**
 * B站解析：
 *   b23.tv 短链 → 302 到 www.bilibili.com/video/BVxxx
 *   先用 x/web-interface/view 拿标题/封面/cid，再请求 playurl 拿视频流。
 *   playurl 优先 mp4（durl）；拿不到就退 DASH（音视频分离），
 *   下载时由 downloader 用 ffmpeg 合并。
 */
export async function parseBilibili(input: string): Promise<VideoMeta> {
  let url = extractAnyUrl(input) ?? input;
  if (/b23\.tv|bili2233\.cn/i.test(url)) {
    const res = await net.fetch(url, {
      headers: { "User-Agent": UA_DESKTOP, Referer: "https://www.bilibili.com/" },
    });
    if (res.url) url = res.url;
  }

  const bvid = url.match(BVID_RE)?.[0] ?? null;
  const aid = url.match(AID_RE)?.[1] ?? null;
  if (!bvid && !aid) {
    throw new Error("未识别到 B 站视频 ID（链接里需要 BV 号或 av 号）");
  }

  let p = 1;
  try {
    p = Number(new URL(url).searchParams.get("p") ?? 1) || 1;
  } catch {
    /* noop */
  }

  const viewUrl = bvid
    ? `https://api.bilibili.com/x/web-interface/view?bvid=${bvid}`
    : `https://api.bilibili.com/x/web-interface/view?aid=${aid}`;
  const view = await fetchJson(viewUrl, BILI_HEADERS);
  if (view?.code !== 0) {
    throw new Error(`B站接口返回错误：${view?.message ?? view?.code ?? "未知"}`);
  }
  const data = view.data;
  const page = data?.pages?.[p - 1] ?? data?.pages?.[0] ?? null;
  const cid: number | undefined = page?.cid ?? data?.cid;
  if (!cid) throw new Error("B站接口未返回视频 cid");

  const { url: playUrl, audioUrl } = await fetchPlayUrl(
    bvid ?? undefined,
    aid ?? undefined,
    cid
  );

  return {
    id: bvid ?? `av${aid}`,
    title: String(data?.title ?? "").trim() || "bilibili_video",
    cover: String(data?.pic ?? ""),
    author: String(data?.owner?.name ?? ""),
    duration: Number(page?.duration ?? data?.duration ?? 0),
    playUrl,
    audioUrl,
    platform: "bilibili",
  };
}

async function fetchPlayUrl(
  bvid: string | undefined,
  aid: string | undefined,
  cid: number
): Promise<{ url: string; audioUrl?: string }> {
  const base: Record<string, string | number> = {
    cid,
    qn: 64,
    platform: "html5",
    high_quality: 1,
  };
  if (bvid) base.bvid = bvid;
  else if (aid) base.aid = aid;

  // 1) fnval=1：传统 mp4（durl）
  const durlData = await tryPlayurl({ ...base, fnval: 1 });
  const durl = durlData?.durl?.[0];
  const durlUrl = firstHttpUrl(durl?.url);
  if (durlUrl) return { url: durlUrl };

  // 2) fnval=16：DASH（音视频分离）
  const dashData = await tryPlayurl({ ...base, fnval: 16 });
  const dash = dashData?.dash;
  const videoUrl = firstHttpUrl(
    dash?.video?.[0]?.baseUrl ?? dash?.video?.[0]?.base_url
  );
  if (!videoUrl) {
    throw new Error("未获取到 B 站视频流地址（可能需要登录或视频为付费/会员专属）");
  }
  const audioUrl = firstHttpUrl(
    dash?.audio?.[0]?.baseUrl ?? dash?.audio?.[0]?.base_url
  );
  return { url: videoUrl, audioUrl: audioUrl ?? undefined };
}

async function tryPlayurl(params: Record<string, string | number>): Promise<any | null> {
  const qs = Object.entries(params)
    .map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(String(v))}`)
    .join("&");
  const plain = await fetchJson(
    `https://api.bilibili.com/x/player/playurl?${qs}`,
    BILI_HEADERS
  ).catch(() => null);
  if (plain?.code === 0 && plain?.data) return plain.data;

  // 普通接口被风控时走 wbi 签名接口
  try {
    const signedUrl = await getWbiSignedUrl(
      "https://api.bilibili.com/x/player/wbi/playurl",
      params
    );
    const wbi = await fetchJson(signedUrl, BILI_HEADERS).catch(() => null);
    if (wbi?.code === 0 && wbi?.data) return wbi.data;
  } catch {
    /* noop */
  }
  return null;
}

// ------------ B站 wbi 签名（风控兜底） ------------

const MIXIN_KEY_ENC_TAB = [
  46, 47, 18, 2, 53, 8, 23, 32, 15, 50, 10, 31, 58, 3, 45, 35, 27, 43, 5, 49,
  33, 9, 42, 19, 29, 28, 14, 39, 12, 38, 41, 13, 37, 48, 7, 16, 24, 55, 40, 61,
  26, 17, 0, 1, 60, 51, 30, 4, 22, 25, 54, 21, 56, 59, 6, 63, 57, 62, 11, 36,
  20, 34, 44, 52,
];

async function getWbiKeys(): Promise<{ imgKey: string; subKey: string }> {
  const nav = await fetchJson(
    "https://api.bilibili.com/x/web-interface/nav",
    BILI_HEADERS
  );
  const img = nav?.data?.wbi_img;
  if (!img?.img_url || !img?.sub_url) {
    throw new Error("获取 B 站 wbi 密钥失败");
  }
  const keyOf = (u: string) => (u.split("/").pop() ?? "").split(".")[0];
  return { imgKey: keyOf(img.img_url), subKey: keyOf(img.sub_url) };
}

function getMixinKey(imgKey: string, subKey: string): string {
  const raw = imgKey + subKey;
  return MIXIN_KEY_ENC_TAB.map((i) => raw[i]).join("").slice(0, 32);
}

async function getWbiSignedUrl(
  endpoint: string,
  params: Record<string, string | number>
): Promise<string> {
  const { imgKey, subKey } = await getWbiKeys();
  const mixinKey = getMixinKey(imgKey, subKey);
  const q: Record<string, string> = {
    ...Object.fromEntries(Object.entries(params).map(([k, v]) => [k, String(v)])),
    wts: String(Math.round(Date.now() / 1000)),
  };
  const query = Object.keys(q)
    .sort()
    .map((k) => `${encodeURIComponent(k)}=${encodeURIComponent(q[k])}`)
    .join("&");
  const wRid = crypto.createHash("md5").update(query + mixinKey).digest("hex");
  return `${endpoint}?${query}&w_rid=${wRid}`;
}
