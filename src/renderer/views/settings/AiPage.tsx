/*
 * SPDX-License-Identifier: GPL-3.0-only
 * Copyright (c) 2026 宝螺 / Baoluo contributors
 * 本文件属于「宝螺 / Baoluo」。除 GPL-3.0 外还适用 ADDITIONAL_TERMS.md 里的附加条款：
 * 分发时须保留来源署名；修改版对外分发时不得沿用「宝螺」名称与图标。
 */
import { useEffect, useState } from "react";
import type { DialogueApi, SettingsApi } from "../../../preload";
import type { DialogueSettings } from "../../../shared/dialogue-types";
import {
  MODELSCOPE_DEFAULT_MODEL,
  MODELSCOPE_MODEL_PRESETS,
  MODELSCOPE_SIZE_PRESETS,
  normalizeImageProvider,
  type ImageProviderKey,
} from "../../../shared/image-providers";
import { DEFAULT_AI } from "../../../shared/settings-defaults";
import { AI_PROVIDERS, DEFAULT_PROVIDER_KEY } from "../../../shared/ai-providers";
import SaveResetRow from "./SaveResetRow";
import AppSelect from "../../components/AppSelect";

declare global {
  interface Window {
    dialogue: DialogueApi;
    settings: SettingsApi;
  }
}

/** 按 baseUrl 前缀猜当前是哪家（设置里存的值被手动改过也能对上） */
function guessProviderKey(baseUrl: string): string {
  const hit = AI_PROVIDERS.find((p) => baseUrl.startsWith(p.baseUrl));
  if (hit) return hit.key;
  // 本地网关改端口，前缀对不上时按主机名归组（不区分 Ollama/LMStudio/OneAPI，反正都是本地）
  const local = AI_PROVIDERS.filter((p) => p.baseUrl.startsWith("http://127.0.0.1"));
  if (local.length && baseUrl.startsWith("http://127.0.0.1")) return "oneapi";
  return "";
}

export default function AiPage() {
  const [settings, setSettings] = useState<DialogueSettings | null>(null);
  const [showKey, setShowKey] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [providerKey, setProviderKey] = useState<string>(DEFAULT_PROVIDER_KEY);
  const [models, setModels] = useState<string[]>([]);
  const [listing, setListing] = useState(false);
  const [testing, setTesting] = useState(false);
  const [testOk, setTestOk] = useState<string | null>(null);

  /**
   * 生图引擎（放在这一页：它和文本模型一样都是「连哪个 AI 服务」，只是管出图）。
   * 这部分存在 AppSettings（app 分区），跟上面的文本模型（dialogue 分区）分开落盘，
   * 所以保存/重置要把两块都带上。
   */
  const [imageProvider, setImageProvider] = useState<ImageProviderKey>("modelscope");
  const [msToken, setMsToken] = useState("");
  const [keyHelpOpen, setKeyHelpOpen] = useState(false);
  const [msModel, setMsModel] = useState("");
  const [msSize, setMsSize] = useState("");

  useEffect(() => {
    (async () => {
      try {
        const s = await window.dialogue.getSettings();
        /*
         * 旧配置迁移：没有 aiKeys 时，把现有 apiKey 归到"识别出的服务商"名下。
         * 这样用户从老版本升级后第一次切走再切回来，key 还在。
         */
        if (!s.aiKeys || Object.keys(s.aiKeys).length === 0) {
          const guessed = guessProviderKey(s.baseUrl);
          if (guessed && s.apiKey) {
            s.aiKeys = { [guessed]: s.apiKey };
          }
        }
        setSettings(s);
        setProviderKey(guessProviderKey(s.baseUrl) || "custom");

        const app = await window.settings.get();
        setImageProvider(normalizeImageProvider(app.imageProvider));
        setMsToken(app.modelscopeImage?.token ?? "");
        setMsModel(app.modelscopeImage?.model ?? "");
        setMsSize(app.modelscopeImage?.size ?? "");
      } catch {
        /* ignore */
      }
    })();
  }, []);

  if (!settings) {
    return <p className="subtitle">加载中…</p>;
  }
  const s = settings;
  const current = AI_PROVIDERS.find((p) => p.key === providerKey);

  async function handleSave() {
    setError(null);
    const r = await window.dialogue.saveSettings(s);
    setSettings(r);
    // 生图引擎那块存在 app 分区，跟文本模型分开落盘
    await window.settings.update({
      imageProvider,
      modelscopeImage: { token: msToken, model: msModel, size: msSize },
    });
  }

  async function handleReset() {
    setError(null);
    const cur = await window.dialogue.getSettings();
    const r = await window.dialogue.saveSettings({ ...cur, ...DEFAULT_AI });
    setSettings(r);
    setModels([]);
    setProviderKey(DEFAULT_PROVIDER_KEY);
    // 生图引擎一起回到默认（ModelScope / 清掉配置）
    setImageProvider("modelscope");
    setMsToken("");
    setMsModel("");
    setMsSize("");
    await window.settings.update({
      imageProvider: "modelscope",
      modelscopeImage: {},
    });
  }

  /**
   * 选预设：填 baseUrl + 默认模型名，并把 key **按服务商切换**。
   * 离开当前服务商前，先把输入框里的 key 存进 aiKeys[当前]；再取目标服务商存过的 key。
   * apiKey 字段始终 = 当前服务商的 key（三个 AI 调用点只读它，不用关心是哪家）。
   */
  function pickProvider(key: string) {
    setTestOk(null);
    const keys: Record<string, string> = { ...(s.aiKeys ?? {}) };
    if (providerKey && providerKey !== "custom") keys[providerKey] = s.apiKey;
    const nextKey = keys[key] ?? (key === "custom" ? s.apiKey : "");
    setProviderKey(key);
    const p = AI_PROVIDERS.find((x) => x.key === key);
    if (!p) {
      // custom：地址/模型不动，key 沿用输入框里的（用户可能就是想微调地址）
      setSettings({ ...s, aiKeys: keys });
      return;
    }
    setSettings({ ...s, aiKeys: keys, apiKey: nextKey, baseUrl: p.baseUrl, model: p.model });
    setModels([]);
  }

  /** 编辑 Key 输入框 = 改当前服务商的 key（同时写进 aiKeys 与 apiKey） */
  function editApiKey(v: string) {
    const keys: Record<string, string> = { ...(s.aiKeys ?? {}) };
    if (providerKey && providerKey !== "custom") keys[providerKey] = v;
    setSettings({ ...s, aiKeys: keys, apiKey: v });
  }

  async function loadModels() {
    setError(null);
    setTestOk(null);
    setListing(true);
    try {
      const r = await window.dialogue.aiListModels({ apiKey: s.apiKey, baseUrl: s.baseUrl, model: s.model });
      if (r.ok) {
        setModels(r.models);
        if (!r.models.includes(s.model) && r.models.length) {
          // 当前填的模型不在列表里：自动换第一个（用户也能再改）
          setSettings({ ...s, model: r.models[0] });
        }
      } else {
        setError(r.error ?? "拉取模型列表失败。");
      }
    } finally {
      setListing(false);
    }
  }

  async function runTest() {
    setError(null);
    setTestOk(null);
    setTesting(true);
    try {
      const r = await window.dialogue.aiTest({ apiKey: s.apiKey, baseUrl: s.baseUrl, model: s.model });
      if (r.ok) {
        setTestOk(r.reply ?? "连接成功");
      } else {
        setError(r.error ?? "测试失败。");
      }
    } finally {
      setTesting(false);
    }
  }

  return (
    <>
      <div className="card-pad">
        <div className="panel-title">AI 服务</div>

        {/* 服务商预设：点一下自动填好地址和默认模型，key 仍要自己填（本地的除外）。
            「自定义」入口已去掉（不支持自定义服务），但内部仍认 custom 状态：
            老版本存过自定义地址的用户回显时不亮任何预设，地址栏照常可编辑 */}
        <div className="form-row">
          <label>服务商</label>
          <div className="ai-provider-row">
            {AI_PROVIDERS.map((p) => (
              <button
                key={p.key}
                type="button"
                className={`secondary small ${providerKey === p.key ? "ai-provider-active" : ""}`}
                onClick={() => pickProvider(p.key)}
                title={p.baseUrl}
              >
                {p.label}
              </button>
            ))}
          </div>
        </div>

        {/* 申请入口单独占一行（链接太长，挤在按钮那行会把预设行撑乱） */}
        {current?.keyUrl && (
          <div className="form-row">
            <label>申请 Key</label>
            <a className="ai-key-url" href={current.keyUrl} target="_blank" rel="noreferrer">
              {current.keyUrl}
            </a>
          </div>
        )}
        {current && !current.needsKey && (
          <div className="form-row">
            <label />
            <span className="story-muted">本地服务一般不需要 API Key，留空即可（前提：服务已在跑）。</span>
          </div>
        )}

        <div className="form-row">
          <label>API Key</label>
          <input
            type={showKey ? "text" : "password"}
            value={s.apiKey}
            onChange={(e) => editApiKey(e.target.value)}
            placeholder={current?.needsKey === false ? "本地网关可留空" : "sk-..."}
          />
          <button className="link" onClick={() => setShowKey((v) => !v)}>
            {showKey ? "隐藏" : "显示"}
          </button>
        </div>
        <div className="form-row">
          <label>Base URL</label>
          <input
            value={s.baseUrl}
            onChange={(e) => setSettings({ ...s, baseUrl: e.target.value })}
            placeholder="https://api.deepseek.com/v1"
          />
        </div>
        <div className="form-row">
          <label>模型</label>
          {models.length > 0 ? (
            /*
             * 拉到列表就用真正的下拉：全部平铺展示。
             * 之前用 <datalist> 是个坑——它会按输入框当前值过滤选项，
             * 值只要和某个模型名不匹配，下拉里就几乎什么都不剩。
             */
            <AppSelect
              value={s.model}
              options={models.map((m) => ({ value: m, label: m }))}
              onChange={(v) => setSettings({ ...s, model: v })}
            />
          ) : (
            <input
              value={s.model}
              onChange={(e) => setSettings({ ...s, model: e.target.value })}
              placeholder="手敲模型名，或点右边「拉取模型列表」"
            />
          )}
          <button className="link" disabled={listing} onClick={() => void loadModels()}>
            {listing ? "拉取中…" : models.length ? "重新拉取" : "拉取模型列表"}
          </button>
        </div>

        {/* 保存前就能试：地址/key/模型名三件套通不通，当场知道。结果放按钮下面（回显文字长，挤在右边会把行撑歪） */}
        <div className="form-row">
          <label>连通性</label>
          <button className="secondary" disabled={testing} onClick={() => void runTest()}>
            {testing ? "测试中…" : "测试连接"}
          </button>
        </div>
        {testOk && (
          <div className="form-row">
            <label />
            <span className="story-gen-tip">✓ 连接成功：模型回了「{testOk}」</span>
          </div>
        )}
      </div>

      {/*
        生图引擎：分镜配图走官方 HTTP 接口（ModelScope）。
        跟上面那张卡互不影响——上面是「谁写文案」，这里是「谁画图」。
      */}
      <div className="card-pad" style={{ marginTop: 16 }}>
        <div className="panel-title">生图引擎</div>

        <div className="form-row" style={{ marginTop: 14 }}>
          <label>API Key</label>
          <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
            <input
              type="password"
              value={msToken}
              onChange={(e) => setMsToken(e.target.value)}
              placeholder="粘贴访问令牌（ms- 开头）"
              autoComplete="off"
              style={{ flex: 1 }}
            />
            <button
              type="button"
              className="key-help-icon"
              title="查看获取 API Key 的帮助"
              onClick={() => setKeyHelpOpen((v) => !v)}
            >
              ?
            </button>
          </div>
        </div>
        {keyHelpOpen && (
          <div className="hint" style={{ paddingLeft: 130 }}>
            打开 modelscope.cn，点右上角头像 → 访问令牌，复制 default 那条。
            请先确认账号已绑定阿里云并完成实名认证，否则免费额度不生效（接口会报 401）。
            <a
              className="ai-key-url"
              href="https://modelscope.cn/my/myaccesstoken"
              target="_blank"
              rel="noreferrer"
            >
              打开访问令牌页
            </a>
          </div>
        )}

        <div className="form-row" style={{ marginTop: 12 }}>
          <label>模型</label>
          <input
            value={msModel}
            onChange={(e) => setMsModel(e.target.value)}
            placeholder={MODELSCOPE_DEFAULT_MODEL}
            title="留空用默认模型；也可以手填 ModelScope 上的其它模型 id"
          />
        </div>
        <div className="hint" style={{ paddingLeft: 130 }}>
          留空用默认 <code>{MODELSCOPE_DEFAULT_MODEL}</code>。常用模型（点一下填上）：
        </div>
        <div className="ai-provider-row" style={{ paddingLeft: 130 }}>
          {MODELSCOPE_MODEL_PRESETS.map((m) => (
            <button
              key={m.value}
              type="button"
              className={`secondary small ${msModel === m.value ? "ai-provider-active" : ""}`}
              onClick={() => setMsModel(m.value)}
              title={m.value}
            >
              {m.label}
            </button>
          ))}
        </div>

        <div className="form-row" style={{ marginTop: 12 }}>
          <label>出图尺寸</label>
          <div style={{ minWidth: 260 }}>
            <AppSelect value={msSize} options={MODELSCOPE_SIZE_PRESETS} onChange={setMsSize} />
          </div>
        </div>
        <div className="hint">
          免费额度是「名义每天 2000 次、单模型另有每日额度」，并发很低：连续生成时被限流是正常的，
          宝螺会自动退避重试；额度与规则以 ModelScope 模型页当期标注为准。
        </div>
      </div>

      {error && <div className="error">{error}</div>}
      <SaveResetRow onSave={handleSave} onReset={handleReset} />
    </>
  );
}
