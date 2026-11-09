/**
 * 「这个运行时能用哪些模型」——**直接读各个 CLI 自己的配置**，本地不存账本。
 *
 * 为什么不在代码里写死一份清单（第一版就是这么写的，半天就过期了）：
 * 真正知道有哪些模型的是 CLI 背后的服务端，而写进来的清单是**事实的副本**；
 * 用户换了个网关（比如 magpie 接了新供应商），副本还是旧的，界面就会把人带沟里。
 *
 * 所以每家各找各的源头（参考 bandi 的 cli-models 做法）：
 *
 *   codex  : `~/.codex/config.toml`
 *              · `model_catalog_json` 指向的目录文件（本地、离线、带显示名）
 *              · 没目录文件就退回它配的 provider `base_url` + GET /models
 *              · 默认模型是顶层 `model = "..."`
 *   claude : `~/.claude/settings.json` 的 `modelPicker.options`（label 给人看、model 传给 CLI）
 *              没有就退回 `env.ANTHROPIC_BASE_URL` 上的 /v1/models；都没有就是手工填
 *   gemini : 没有可查的清单 —— 老实说清楚，让人手工填
 *
 * 代价：读一次有成本（本地文件 2ms，网关要发 HTTP），也可能失败。
 * 所以调用方**按需读**（用户点开菜单才读），失败时**降级**（别给空盒子，
 * 至少把"当前默认模型"和手工填摆出来）。
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { RuntimeId, RuntimeModelChoice, RuntimeModelList } from "../../shared/runtime-types";

const CODEX_HOME = process.env.CODEX_HOME ?? path.join(os.homedir(), ".codex");
const CLAUDE_HOME = process.env.CLAUDE_CONFIG_DIR ?? path.join(os.homedir(), ".claude");

/** 去掉解码失败留下的替换字符，压掉连续空白 */
const clean = (s: unknown): string =>
  String(s ?? "")
    .replace(/\uFFFD/g, "")
    .replace(/\s{2,}/g, " ")
    .trim();

/** 同一个 id 只留第一条（magpie 的目录里会有重复的分组别名） */
function dedupe(models: RuntimeModelChoice[]): RuntimeModelChoice[] {
  const seen = new Set<string>();
  const out: RuntimeModelChoice[] = [];
  for (const m of models) {
    if (!m.id || seen.has(m.id)) continue;
    seen.add(m.id);
    out.push(m);
  }
  return out;
}

/**
 * 一个够用的 TOML 取值：只认 `键 = "值"` 和 `[段]`。
 * 读 codex 那几行（model / model_provider / model_catalog_json）足够了，
 * 不值得为此引一个 TOML 依赖。
 */
export function tomlScan(text: string): {
  top: Record<string, string>;
  sections: Record<string, Record<string, string>>;
} {
  const top: Record<string, string> = {};
  const sections: Record<string, Record<string, string>> = {};
  let section: string | null = null;
  for (const raw of String(text).split(/\r?\n/)) {
    const line = raw.replace(/(^|\s)#.*$/, "").trim();
    if (!line) continue;
    const head = /^\[([^\]]+)\]$/.exec(line);
    if (head) {
      section = head[1].trim();
      sections[section] = sections[section] ?? {};
      continue;
    }
    const kv = /^([A-Za-z0-9_.-]+)\s*=\s*(.*)$/.exec(line);
    if (!kv) continue;
    const value = kv[2].trim().replace(/^["']|["']$/g, "");
    if (section) sections[section][kv[1]] = value;
    else top[kv[1]] = value;
  }
  return { top, sections };
}

/** codex 的模型目录文件（`{ models: [{ slug, display_name, description, ... }] }`） */
export function parseCodexCatalog(doc: unknown): RuntimeModelChoice[] {
  const raw = (doc as { models?: unknown })?.models;
  const list = Array.isArray(raw) ? raw : [];
  const out: RuntimeModelChoice[] = [];
  for (const item of list) {
    const m = item as Record<string, unknown>;
    const id = clean(m?.slug ?? m?.id);
    if (!id) continue;
    const label = clean(m?.display_name) || id;
    let hint = clean(m?.description);
    /*
     * codex 目录里的 description 往往是"显示名 + via xxx"（`永不卡住 · routing group via magpie`），
     * 整句放上去等于把名字念两遍。把前缀的名字剥掉，只留后面那句"从哪来的"。
     */
    if (hint && label && hint.toLowerCase().startsWith(label.toLowerCase())) {
      hint = hint
        .slice(label.length)
        .replace(/^[\s·,，:：\-]+/, "")
        .trim();
    }
    const cw = Number(m?.context_window) || 0;
    out.push({
      id,
      label,
      // 目录里的 description 往往就是"哪个供应商、什么分组"，比上下文长度有用
      hint: hint || (cw >= 1000 ? `上下文 ${Math.round(cw / 1000)}k` : undefined),
    });
  }
  return dedupe(out);
}

/** Claude Code 的 `settings.json`：`modelPicker.options` 才是真清单 */
export function parseClaudeSettings(doc: unknown): {
  models: RuntimeModelChoice[];
  defaultModel: string | null;
  baseUrl: string | null;
  key: string | null;
} {
  const d = (doc ?? {}) as {
    model?: unknown;
    modelPicker?: { options?: unknown };
    env?: { ANTHROPIC_BASE_URL?: unknown; ANTHROPIC_AUTH_TOKEN?: unknown };
  };
  const opts = Array.isArray(d.modelPicker?.options) ? d.modelPicker.options : [];
  const models: RuntimeModelChoice[] = [];
  for (const item of opts) {
    const o = item as Record<string, unknown>;
    const id = clean(o?.model);
    if (!id) continue;
    models.push({
      id,
      label: clean(o?.label) || id,
      hint: clean(o?.description) || undefined,
    });
  }
  return {
    models: dedupe(models),
    defaultModel: clean(d.model) || null,
    baseUrl: clean(d.env?.ANTHROPIC_BASE_URL) || null,
    key: clean(d.env?.ANTHROPIC_AUTH_TOKEN) || null,
  };
}

/** OpenAI 兼容的 /models —— 本地网关通常不鉴权，远程要带 Key */
async function fetchModels(url: string, key: string | null): Promise<RuntimeModelChoice[]> {
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), 5_000);
  try {
    const res = await fetch(url, {
      headers: key ? { Authorization: `Bearer ${key}` } : undefined,
      signal: ctl.signal,
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const doc = (await res.json()) as { data?: unknown; models?: unknown };
    const list = Array.isArray(doc.data) ? doc.data : Array.isArray(doc.models) ? doc.models : [];
    const models: RuntimeModelChoice[] = [];
    for (const item of list) {
      const m = item as Record<string, unknown>;
      const id = clean(m?.id ?? m?.slug);
      if (!id) continue;
      models.push({ id, label: clean(m?.name ?? m?.display_name) || id, hint: clean(m?.description) || undefined });
    }
    return dedupe(models);
  } finally {
    clearTimeout(timer);
  }
}

async function codexModels(): Promise<RuntimeModelList> {
  const cfgPath = path.join(CODEX_HOME, "config.toml");
  let cfg = "";
  try {
    cfg = fs.readFileSync(cfgPath, "utf-8");
  } catch {
    return {
      ok: false,
      models: [],
      defaultModel: null,
      source: cfgPath,
      error: "没读到 ~/.codex/config.toml —— 下拉里只有「默认」和手工填。",
    };
  }

  const { top, sections } = tomlScan(cfg);
  const defaultModel = clean(top.model) || null;
  const provider = clean(top.model_provider);
  const section = provider ? sections[`model_providers.${provider}`] : undefined;
  const providerBase = clean(section?.base_url);
  // 只拿 openai_base_url 当兜底：magpie 的 `…/backend-api/codex` 不提供 /models，
  // 但别的网关可能就是这么配的，试一下不亏
  const base = providerBase || clean(top.openai_base_url);
  const catalogs = [top.model_catalog_json, top.model_catalog].map(clean).filter(Boolean);

  for (const catalog of catalogs) {
    const file = path.isAbsolute(catalog) ? catalog : path.join(CODEX_HOME, catalog);
    try {
      const models = parseCodexCatalog(JSON.parse(fs.readFileSync(file, "utf-8")));
      if (models.length) return { ok: true, models, defaultModel, source: file };
    } catch {
      /* 目录读不了就往下走网关 */
    }
  }

  if (base) {
    const url = `${base.replace(/\/+$/, "")}/models`;
    const key = clean(section?.experimental_bearer_token) || null;
    try {
      const models = await fetchModels(url, key);
      if (models.length) return { ok: true, models, defaultModel, source: url };
      return {
        ok: true,
        models: [],
        defaultModel,
        source: url,
        error: `${url} 没返回模型 —— 下面的名字可以手工填。`,
      };
    } catch (e) {
      return {
        ok: false,
        models: [],
        defaultModel,
        source: url,
        error: `codex 的服务端没给出列表（${e instanceof Error ? e.message : String(e)}）—— 名字可以手工填。`,
      };
    }
  }

  return {
    ok: false,
    models: [],
    defaultModel,
    source: cfgPath,
    error: "config.toml 里既没有模型目录，也没有可问的服务端地址 —— 名字可以手工填。",
  };
}

async function claudeModels(): Promise<RuntimeModelList> {
  const file = path.join(CLAUDE_HOME, "settings.json");
  let doc: unknown;
  try {
    doc = JSON.parse(fs.readFileSync(file, "utf-8"));
  } catch {
    return {
      ok: false,
      models: [],
      defaultModel: null,
      source: file,
      error: "没读到 ~/.claude/settings.json —— 下拉里只有「默认」和手工填。",
    };
  }
  const info = parseClaudeSettings(doc);
  // ① 首选：Claude Code 自己的 settings.json（离线、带显示名、还知道当前默认是哪个）
  if (info.models.length) {
    return { ok: true, models: info.models, defaultModel: info.defaultModel, source: file };
  }
  // ② 退路：问它配的那个网关（同机网关照例是 OpenAI 兼容的）
  if (info.baseUrl) {
    const base = info.baseUrl.replace(/\/+$/, "");
    const tried: string[] = [];
    for (const url of [`${base}/v1/models`, `${base}/models`]) {
      tried.push(url);
      try {
        const models = await fetchModels(url, info.key);
        if (models.length) {
          return { ok: true, models, defaultModel: info.defaultModel, source: url };
        }
      } catch {
        /* 换下一条地址试 */
      }
    }
    return {
      ok: false,
      models: [],
      defaultModel: info.defaultModel,
      source: tried[tried.length - 1] ?? base,
      error: "Claude Code 的配置里没有可选清单，网关也没返回模型 —— 名字可以手工填。",
    };
  }
  // ③ 兜底：确实没有清单（不是读失败），让人手工填
  return {
    ok: true,
    models: [],
    defaultModel: info.defaultModel,
    source: file,
    error: "settings.json 里没有 modelPicker 清单 —— 完整模型名可以手工填。",
  };
}

async function geminiModels(): Promise<RuntimeModelList> {
  const file = path.join(os.homedir(), ".gemini", "settings.json");
  let defaultModel: string | null = null;
  try {
    const doc = JSON.parse(fs.readFileSync(file, "utf-8")) as { model?: unknown };
    defaultModel = clean(doc.model) || null;
  } catch {
    /* 没装过 / 没配置都正常 */
  }
  return {
    ok: false,
    models: [],
    defaultModel,
    source: file,
    error: "Gemini CLI 没有可读的模型清单 —— 直接填完整模型名。",
  };
}

/* 读一次是有成本的（网关要走 HTTP），短时间内重复点开菜单不必再读 */
const CACHE_MS = 30_000;
const cache = new Map<RuntimeId, { at: number; list: RuntimeModelList }>();

export async function modelsFor(id: RuntimeId, force = false): Promise<RuntimeModelList> {
  const hit = cache.get(id);
  if (!force && hit && Date.now() - hit.at < CACHE_MS) return hit.list;
  const list =
    id === "codex" ? await codexModels() : id === "claude" ? await claudeModels() : await geminiModels();
  cache.set(id, { at: Date.now(), list });
  return list;
}
