import type { MediaPlatform, VideoMeta } from "../../shared/dialogue-types";
import { extractAnyUrl } from "./extractUrl";
import { parseDouyin } from "./douyin";
import { parseKuaishou } from "./kuaishou";
import { parseBilibili } from "./bilibili";
import { parseXiaohongshu } from "./xiaohongshu";
import { fetchText, parseMetaTags } from "./html";

/** 按域名识别平台；不认识返回 null（走通用网页解析） */
export function detectPlatform(url: string): MediaPlatform | null {
  try {
    const host = new URL(url).hostname.toLowerCase().replace(/^www\./, "");
    if (/(^|\.)(douyin|iesdouyin|amemv)\.com$/.test(host)) return "douyin";
    if (/(^|\.)kuaishou\.com$/.test(host)) return "kuaishou";
    if (/(^|\.)(bilibili|b23|bili2233)\.(com|tv|cn)$/.test(host)) return "bilibili";
    if (/(^|\.)(xiaohongshu|xhslink)\.com$/.test(host)) return "xiaohongshu";
  } catch {
    /* URL 非法时走通用解析 */
  }
  return null;
}

/** 统一入口：任意平台分享文本 → 平台识别 → 对应解析器 */
export async function parseMedia(shareText: string): Promise<VideoMeta> {
  const url = extractAnyUrl(shareText);
  if (!url) {
    throw new Error(
      "未识别到链接，请粘贴包含视频链接的分享文本（抖音 / 快手 / B站 / 小红书等）"
    );
  }
  const platform = detectPlatform(url);
  switch (platform) {
    case "douyin":
      return parseDouyin(shareText);
    case "kuaishou":
      return parseKuaishou(url);
    case "bilibili":
      return parseBilibili(url);
    case "xiaohongshu":
      return parseXiaohongshu(url);
    default:
      return parseGeneric(url);
  }
}

/** 通用网页解析：优先 og:video，其次页面里的 <video> 标签 */
async function parseGeneric(url: string): Promise<VideoMeta> {
  const html = await fetchText(url);
  const meta = parseMetaTags(html);
  const rel =
    meta["og:video:secure_url"] ||
    meta["og:video:url"] ||
    meta["og:video"] ||
    html.match(/<video\b[^>]*\bsrc\s*=\s*["']([^"']+)["']/i)?.[1] ||
    "";
  const playUrl = /^https?:\/\//i.test(rel)
    ? rel
    : new URL(rel, url).toString();
  if (!rel) {
    throw new Error("未能识别该网页中的视频地址，仅支持常见视频平台或带 og:video 的网页。");
  }
  const title =
    meta["og:title"] ||
    html.match(/<title[^>]*>([^<]*)<\/title>/i)?.[1]?.trim() ||
    "web_video";
  return {
    id: url,
    title: String(title),
    cover: meta["og:image"] || "",
    author: "",
    duration: 0,
    playUrl,
    platform: "generic",
  };
}
