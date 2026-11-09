import { useEffect, useState } from "react";
import type { DialogueApi, LlmApi, SettingsApi } from "../../../preload";
import type { DialogueSettings } from "../../../shared/dialogue-types";
import type { LlmRoute } from "../../../shared/llm-types";
import { DEFAULT_AI } from "../../../shared/settings-defaults";
import { AI_PROVIDERS, DEFAULT_PROVIDER_KEY, LOCAL_GATEWAY_HINT_KEY } from "../../../shared/ai-providers";
import SaveResetRow from "./SaveResetRow";
import BeeSelect from "../../components/BeeSelect";

declare global {
  interface Window {
    dialogue: DialogueApi;
    settings: SettingsApi;
    llm: LlmApi;
  }
}

/** 按 baseUrl 前缀猜当前是哪家（设置里存的值被手动改过也能对上） */
function guessProviderKey(baseUrl: string): string {
  const hit = AI_PROVIDERS.find((p) => baseUrl.startsWith(p.baseUrl));
  if (hit) return hit.key;
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
  /** 文本生成现在走哪条路：应用了运行时就用它，这一页只是兜底 */
  const [route, setRoute] = useState<LlmRoute | null>(null);

  useEffect(() => {
    let alive = true;
    window.llm
      .route()
      .then((r) => {
        if (alive) setRoute(r);
      })
      .catch(() => {
        /* 读不到就当没有运行时 */
      });
    return () => {
      alive = false;
    };
  }, []);

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
  }

  async function handleReset() {
    setError(null);
    const cur = await window.dialogue.getSettings();
    const r = await window.dialogue.saveSettings({ ...cur, ...DEFAULT_AI });
    setSettings(r);
    setModels([]);
    setProviderKey(DEFAULT_PROVIDER_KEY);
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
    const nextKey =
      keys[key] ?? (key === "custom" ? s.apiKey : key === "magpie" ? LOCAL_GATEWAY_HINT_KEY : "");
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

        {/* 应用了运行时就不再走这里：明说一句，免得用户以为还得再买一份 Key */}
        {route?.source === "runtime" && (
          <div className="hint">
            写文案、写分镜已经交给「{route.label}」了（要换去「设置 → 运行时」）。
            这一页只在没接运行时的时候兜底，Key 可以先不填。
          </div>
        )}

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
          {/* 链接内嵌在输入框右缘（悬浮层），几个输入框的右边线才能对齐 */}
          <div className="ai-input-wrap">
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
          {/* 链接内嵌在输入框右缘（悬浮层），和上面 API Key、Base URL 右边线对齐 */}
          <div className="ai-input-wrap">
            {models.length > 0 ? (
              /*
               * 拉到列表就用真正的下拉：全部平铺展示。
               * 之前用 <datalist> 是个坑——它会按输入框当前值过滤选项，
               * 值是 group/group-baoluo 时下拉里就只剩它自己，其它 7 个全被藏了。
               */
              <BeeSelect
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

      {error && <div className="error">{error}</div>}
      <SaveResetRow onSave={handleSave} onReset={handleReset} />
    </>
  );
}
