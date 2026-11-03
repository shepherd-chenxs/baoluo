/**
 * 抖音分享文本里通常长这样：
 *   "5.63 复制打开抖音，看看【某某】的作品... https://v.douyin.com/iABCdef/ 复制此..."
 * 我们只关心其中的短链，从任意文本里抠出第一个匹配的 URL。
 *
 * 兼容两种主要短链域：
 *   - https://v.douyin.com/xxxxx/
 *   - https://www.iesdouyin.com/share/video/{aweme_id}/
 */
const SHORT_URL_RE =
  /https?:\/\/(?:v\.douyin\.com|www\.iesdouyin\.com|www\.douyin\.com|api\.amemv\.com)\/[^\s]+/i;

/** 从任意文本里抠出第一个形如 http(s):// 的链接（多平台分享文本通用） */
const ANY_URL_RE = /https?:\/\/[^\s'"<>，。、！？；：）】〕》」』\]}]+/i;

export function extractAnyUrl(text: string): string | null {
  if (!text) return null;
  const m = text.match(ANY_URL_RE);
  if (!m) return null;
  return m[0].trim();
}

export function extractShortUrl(text: string): string | null {
  if (!text) return null;
  const m = text.match(SHORT_URL_RE);
  if (!m) return null;
  // 去掉结尾常见的中文标点 / 空白
  return m[0].replace(/[，。、！？；)】\]}]+$/g, "").trim();
}

/**
 * 从形如 https://www.iesdouyin.com/share/video/7xxxxxxxxxxxxxxx/?... 的 URL 里提取 aweme_id
 */
export function extractAwemeId(url: string): string | null {
  const m = url.match(/\/(?:share\/)?video\/(\d{15,25})/);
  if (m) return m[1];
  // 兜底：形如 ?modal_id=7xxxx
  const u = new URL(url);
  const modalId = u.searchParams.get("modal_id");
  if (modalId && /^\d{15,25}$/.test(modalId)) return modalId;
  return null;
}
