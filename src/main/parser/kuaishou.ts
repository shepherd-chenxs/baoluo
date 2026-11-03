import type { VideoMeta } from "../../shared/dialogue-types";
import { extractAnyUrl } from "./extractUrl";
import { fetchText, UA_MOBILE } from "./html";

/**
 * 快手解析（免登录方案）：
 *   直接用移动端 UA 抓分享链接（v.kuaishou.com 短链会自动跳转），
 *   返回的 SSR HTML 里明文内嵌完整 photo 对象（mainMvUrls 是 mp4 直链）。
 *   注：PC 版接口对未登录用户返回 photo:null（登录墙），所以不能走 PC 页。
 */
export async function parseKuaishou(shareText: string): Promise<VideoMeta> {
  const url = extractAnyUrl(shareText);
  if (!url) throw new Error("未识别到快手链接");

  const html = await fetchText(url, {
    Referer: "https://m.gifshow.com/",
    "User-Agent": UA_MOBILE,
  });
  let photo = extractJsonObjectContaining(html, "mainMvUrls");

  // 兜底：链接是 /short-video/ 或 /fw/photo/ 时再试一次移动端详情页
  if (!photo) {
    const id =
      url.match(/\/short-video\/([0-9a-zA-Z]+)/)?.[1] ??
      url.match(/\/fw\/photo\/([0-9a-zA-Z]+)/)?.[1] ??
      null;
    if (id) {
      try {
        const mobileHtml = await fetchText(`https://m.gifshow.com/fw/photo/${id}`, {
          Referer: "https://m.gifshow.com/",
          "User-Agent": UA_MOBILE,
        });
        photo = extractJsonObjectContaining(mobileHtml, "mainMvUrls");
      } catch {
        /* noop */
      }
    }
  }

  const photoUrl = photo?.mainMvUrls?.[0]?.url ?? null;
  if (!photoUrl) {
    if (/singlePicture["']?\s*:\s*true|图集|图文/i.test(html)) {
      throw new Error("该快手内容是图文 / 图集，不是视频，暂不支持下载。");
    }
    throw new Error("未能从快手页面提取到视频地址（视频可能已删除或需要登录）");
  }

  const durationRaw = Number(photo?.duration ?? 0);
  const id =
    photoUrl.match(/[?&]clientCacheKey=([0-9a-zA-Z]+)/)?.[1]?.split("_")[0] ??
    String(photo?.photoId ?? "");
  return {
    id,
    title: String(photo?.caption ?? "").trim() || "kuaishou_video",
    cover: photo?.coverUrls?.[0]?.url ?? "",
    author: String(photo?.userName ?? ""),
    // 移动端 duration 是毫秒
    duration: durationRaw && durationRaw < 1000 ? durationRaw * 1000 : durationRaw,
    playUrl: photoUrl,
    platform: "kuaishou",
  };
}

/**
 * 从 HTML 里取出包含指定 key 的完整 JSON 对象。
 * 从锚点向前枚举候选起点，逐段尝试 JSON.parse 并校验 key，
 * 避免页面里括号/转义复杂导致的手写括号计数出错。
 */
function extractJsonObjectContaining(html: string, key: string): any | null {
  const anchor = html.indexOf(`"${key}"`);
  if (anchor < 0) return null;

  // 候选起点：锚点前的每个 {（从近到远，最多 300 个）
  const starts: number[] = [];
  for (let i = anchor; i >= 0 && starts.length < 300; i--) {
    if (html[i] === "{") starts.push(i);
  }

  for (const start of starts) {
    let depth = 0;
    let inStr = false;
    for (let i = start; i < html.length; i++) {
      const c = html[i];
      if (inStr) {
        if (c === '"' && html[i - 1] !== "\\") inStr = false;
        continue;
      }
      if (c === '"') {
        inStr = true;
        continue;
      }
      if (c === "{") depth++;
      else if (c === "}") {
        depth--;
        if (depth === 0) {
          try {
            const j = JSON.parse(cleanJson(html.slice(start, i + 1)));
            if (j && typeof j === "object" && key in j) return j;
          } catch {
            /* 该候选不是合法 JSON 起点，试下一个 */
          }
          break;
        }
      }
    }
  }
  return null;
}

/** 还原 HTML 实体后再交给 JSON.parse */
function cleanJson(raw: string): string {
  return raw
    .replace(/&amp;/g, "&")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">");
}
