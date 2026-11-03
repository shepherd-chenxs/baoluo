import { net } from "electron";
import type { VideoMeta } from "../../shared/dialogue-types";
import { extractAnyUrl } from "./extractUrl";
import {
  deepFind,
  extractScriptJson,
  fetchText,
  firstHttpUrl,
  parseMetaTags,
  UA_DESKTOP,
  UA_MOBILE,
} from "./html";

/**
 * 小红书解析：
 *   xhslink.com 短链 → 302 到 www.xiaohongshu.com/explore/{noteId}
 *   页面 HTML 内嵌 window.__INITIAL_STATE__，视频流在
 *   note.noteDetailMap[noteId].note.video.media.stream.h264[0].masterUrl。
 *   注意：小红书反爬强，未登录时很多视频页不吐流地址（登录墙），会给出明确提示。
 */
export async function parseXiaohongshu(input: string): Promise<VideoMeta> {
  let url = extractAnyUrl(input) ?? input;
  if (/xhslink\.com/i.test(url)) {
    const res = await net.fetch(url, {
      headers: { "User-Agent": UA_MOBILE, "Accept-Language": "zh-CN,zh;q=0.9" },
    });
    if (res.url) url = res.url;
  }

  const noteId =
    url.match(/\/explore\/([0-9a-zA-Z]+)/)?.[1] ??
    url.match(/\/discovery\/item\/([0-9a-zA-Z]+)/)?.[1] ??
    "";

  const html = await fetchText(url, {
    Referer: "https://www.xiaohongshu.com/",
    "User-Agent": UA_DESKTOP,
  });

  const state = extractScriptJson(html, "window.__INITIAL_STATE__");
  const note = deepFind(
    state,
    (v, k, path) => k === "note" && !!v && typeof v === "object" && path.includes("noteDetailMap")
  );

  const stream = note?.video?.media?.stream;
  const masterUrl = firstHttpUrl(
    stream?.h264?.[0]?.masterUrl ??
      stream?.h265?.[0]?.masterUrl ??
      stream?.av1?.[0]?.masterUrl ??
      stream?.h264?.[0]?.backupUrls
  );
  const title = String(note?.title ?? "").trim();
  const cover = String(
    note?.video?.media?.cover?.urlDefault ??
      note?.imageList?.[0]?.urlDefault ??
      note?.cover?.urlDefault ??
      ""
  );
  const author = String(note?.user?.nickname ?? "");

  if (masterUrl) {
    return {
      id: noteId || String(note?.noteId ?? url),
      title: title || "xiaohongshu_video",
      cover,
      author,
      duration: Number(note?.video?.media?.duration ?? 0),
      playUrl: masterUrl,
      platform: "xiaohongshu",
    };
  }

  // 拿不到流地址：多半是登录墙，给出友好提示
  const meta = parseMetaTags(html);
  const ogVideo = meta["og:video:secure_url"] || meta["og:video"] || meta["og:video:url"];
  if (ogVideo) {
    return {
      id: noteId || url,
      title: meta["og:title"] || title || "xiaohongshu_video",
      cover: meta["og:image"] || cover,
      author,
      duration: 0,
      playUrl: ogVideo,
      platform: "xiaohongshu",
    };
  }

  if (/登录|扫码|验证/i.test(html)) {
    throw new Error("小红书该视频需要登录后查看，当前无法提取下载地址。请先在浏览器中登录小红书账号。");
  }
  throw new Error(
    "未能从小红书页面提取到视频地址（视频可能已删除，或小红书风控/登录墙导致）。"
  );
}
