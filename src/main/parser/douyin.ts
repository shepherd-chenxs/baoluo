
import { extractAwemeId, extractShortUrl } from "./extractUrl";
import { findVideoPageNode } from "./pickFields";
import { extractShareData } from "./browserFetch";
import type { VideoMeta } from "../../shared/dialogue-types";

export type { VideoMeta } from "../../shared/dialogue-types";

const UA_MOBILE =
  "Mozilla/5.0 (iPhone; CPU iPhone OS 17_6 like Mac OS X) AppleWebKit/605.1.15 " +
  "(KHTML, like Gecko) Version/17.6 Mobile/15E148 Safari/604.1";

const UA_ANDROID =
  "Mozilla/5.0 (Linux; Android 13; Pixel 7) AppleWebKit/537.36 (KHTML, like Gecko) " +
  "Chrome/120.0.0.0 Mobile Safari/537.36";

export async function parseDouyin(shareText: string): Promise<VideoMeta> {
  const shortUrl = extractShortUrl(shareText);
  if (!shortUrl) throw new Error("未识别到抖音链接，请粘贴含 v.douyin.com/... 的分享文本");

  const awemeId = await resolveAwemeId(shortUrl);
  if (!awemeId) throw new Error("无法从短链解析出 aweme_id（抖音短链格式可能变化）");

  const { videoSrc, meta, router } = await extractShareData(awemeId, { debug: false });
  if (!videoSrc) throw new Error("未取到视频播放地址（视频可能已被删除或为图集）");

  const item = router ? extractItem(router) : null;

  return {
    id: String(item?.aweme_id ?? awemeId),
    title: String(item?.desc ?? meta.title ?? "").trim() || "douyin_video",
    cover: String(item?.video?.cover?.url_list?.[0] ?? meta.cover ?? ""),
    author: String(item?.author?.nickname ?? "unknown"),
    duration: Number(item?.duration ?? 0),
    playUrl: normalizeToNoWatermark(videoSrc),
    platform: "douyin",
  };
}

/**
 * v.douyin.com/xxx/ → 302 → iesdouyin.com/share/video/{id}/
 *
 * 改进（应对抖音反爬持续升级）：
 *   - 双 UA 轮换：iOS 17.6 优先、Android 13 后备
 *   - 多跳，最多 8 跳（旧代码仅 5）
 *   - 双层 URL 编码解码
 *   - 多种 ID 抽取模式：/share/video/{id}、modal_id、aweme_id、iid、body 内嵌
 */
async function resolveAwemeId(shortUrl: string, maxHops = 8): Promise<string | null> {
  const direct = extractAwemeId(shortUrl);
  if (direct) return direct;

  for (const ua of [UA_MOBILE, UA_ANDROID]) {
    let cur = shortUrl;
    for (let i = 0; i < maxHops; i++) {
      let res: Response;
      try {
        res = await fetch(cur, {
          method: "GET",
          redirect: "manual",
          headers: {
            "User-Agent": ua,
            "Accept-Language": "zh-CN,zh;q=0.9",
            Accept: "text/html,application/json,*/*",
          },
        });
      } catch {
        break;
      }

      const loc = res.headers.get("location");
      if (loc) {
        let abs: string;
        try {
          abs = new URL(loc, cur).toString();
        } catch {
          abs = loc;
        }
        // 抖音偶发双层 URL 编码
        try {
          const decoded = decodeURIComponent(abs);
          if (/\/(?:share\/)?video\/[0-9]{15,25}/.test(decoded)) abs = decoded;
        } catch {
          /* noop */
        }
        const id = extractAwemeId(abs);
        if (id) return id;
        cur = abs;
        continue;
      }

      // 无 location，看 body 是否含 SSR
      try {
        const text = await res.text();
        const m =
          text.match(/\/(?:share\/)?video\/([0-9]{15,25})/) ||
          text.match(/(?:aweme_id|video_id|modal_id)["\s:=]+['"]?([0-9]{15,25})/);
        if (m) return m[1];
      } catch {
        /* noop */
      }
      break;
    }
  }
  return null;
}

function extractItem(routerData: any): any {
  const vp = findVideoPageNode(routerData?.loaderData) as any;
  return (
    vp?.videoInfoRes?.item_list?.[0] ??
    vp?.videoInfoRes?.itemList?.[0] ??
    vp?.aweme?.detail ??
    routerData?.aweme_detail ??
    deepFindItemList(routerData)
  );
}

function deepFindItemList(obj: unknown, depth = 0): any {
  if (depth > 8 || !obj || typeof obj !== "object") return null;
  const o = obj as Record<string, any>;
  if (Array.isArray(o.item_list) && o.item_list[0]) return o.item_list[0];
  if (Array.isArray(o.itemList) && o.itemList[0]) return o.itemList[0];
  for (const k of Object.keys(o)) {
    const r = deepFindItemList(o[k], depth + 1);
    if (r) return r;
  }
  return null;
}

/** playwm (带水印) → play (无水印) */
export function normalizeToNoWatermark(url: string): string {
  return url.replace("/playwm/", "/play/").replace("playwm=", "play=");
}
