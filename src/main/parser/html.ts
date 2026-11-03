import { net } from "electron";

export const UA_DESKTOP =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 " +
  "(KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36";

export const UA_MOBILE =
  "Mozilla/5.0 (iPhone; CPU iPhone OS 17_2 like Mac OS X) AppleWebKit/605.1.15 " +
  "(KHTML, like Gecko) Version/17.2 Mobile/15E148 Safari/604.1";

/** 用 Electron 网络栈抓取文本（Chromium 指纹，比 undici 更接近真实浏览器） */
export async function fetchText(
  url: string,
  headers: Record<string, string> = {}
): Promise<string> {
  const res = await net.fetch(url, {
    headers: {
      "User-Agent": UA_DESKTOP,
      "Accept-Language": "zh-CN,zh;q=0.9",
      Accept: "text/html,application/xhtml+xml,application/json;q=0.9,*/*;q=0.8",
      ...headers,
    },
  });
  if (!res.ok) throw new Error(`请求失败: HTTP ${res.status} ${res.statusText}`);
  return await res.text();
}

/** 抓取并解析 JSON 接口 */
export async function fetchJson(
  url: string,
  headers: Record<string, string> = {}
): Promise<any> {
  const res = await net.fetch(url, {
    headers: {
      "User-Agent": UA_DESKTOP,
      "Accept-Language": "zh-CN,zh;q=0.9",
      Accept: "application/json,text/plain,*/*",
      ...headers,
    },
  });
  if (!res.ok) throw new Error(`接口请求失败: HTTP ${res.status} ${res.statusText}`);
  return await res.json();
}

/** 从 <script>window.xxx = {...}</script> 里抽出对象并 JSON.parse */
export function extractScriptJson(html: string, varName: string): any | null {
  const re = new RegExp(`${varName}\\s*=\\s*(\\{.+?\\})\\s*;?\\s*<\\/script>`, "s");
  const m = html.match(re);
  if (!m) return null;
  try {
    return JSON.parse(stripUndefined(m[1]));
  } catch {
    return null;
  }
}

/** 页面内联 JSON 里偶尔出现 `key: undefined`，转成 null 才能 parse */
function stripUndefined(s: string): string {
  return s.replace(/([{,]\s*)(\w+)\s*:\s*undefined/g, '$1"$2":null');
}

/** 深度遍历找第一个符合条件的值（防御各平台 JSON 结构变化） */
export function deepFind(
  obj: unknown,
  test: (v: unknown, key: string, path: string) => boolean,
  path = "",
  depth = 0
): any {
  if (depth > 10 || obj == null || typeof obj !== "object") return undefined;
  const o = obj as Record<string, any>;
  for (const k of Object.keys(o)) {
    const v = o[k];
    if (test(v, k, path + "/" + k)) return v;
    const r = deepFind(v, test, path + "/" + k, depth + 1);
    if (r !== undefined) return r;
  }
  return undefined;
}

/** 从字符串/数组里取第一个 http(s) 地址 */
export function firstHttpUrl(value: unknown): string | null {
  if (typeof value === "string") {
    return /^https?:\/\//i.test(value) ? value : null;
  }
  if (Array.isArray(value)) {
    for (const item of value) {
      const u = firstHttpUrl(item);
      if (u) return u;
    }
  }
  return null;
}

/** 解析页面 og: 等 meta 标签，属性顺序无关 */
export function parseMetaTags(html: string): Record<string, string> {
  const out: Record<string, string> = {};
  const re = /<meta\b[^>]*>/gi;
  let m: RegExpExecArray | null;
  while ((m = re.exec(html))) {
    const tag = m[0];
    const key =
      tag.match(/(?:property|name)\s*=\s*["']([^"']+)["']/i)?.[1] ?? null;
    const content = tag.match(/content\s*=\s*["']([^"']*)["']/i)?.[1] ?? null;
    if (key && content) out[key.toLowerCase()] = content;
  }
  return out;
}
