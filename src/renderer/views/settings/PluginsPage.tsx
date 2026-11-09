/**
 * 插件管理页 —— 把左侧导航的功能模块当「插件」装/卸。
 *
 * 交互：每行一个插件（名称 + 说明 + 安装开关），改动**即时保存**（不走保存/重置行，
 * 否则用户切走时忘了点保存，导航和「＋」菜单就和设置页对不上）。
 *
 * 「未设置 = 全部安装」的兼容语义收在本页 + effectiveInstalledPlugins：
 * 老配置打开这页时显示为全装；只要用户动过一次开关，就落一份显式列表。
 *
 * 引擎类插件（ModelScope / 豆包生图）额外带一颗「配置」按钮：
 * 点开弹配置窗口——ModelScope 填令牌/模型/尺寸；豆包显示登录状态，未登录给登录按钮
 * （登录本体发生在独立豆包窗口里，这里只是入口）。
 */
import { useEffect, useState } from "react";
import {
  PLUGINS,
  effectiveInstalledPlugins,
  type PluginKey,
} from "../../../shared/plugins";
import {
  MODELSCOPE_DEFAULT_MODEL,
  MODELSCOPE_MODEL_PRESETS,
  MODELSCOPE_SIZE_PRESETS,
  normalizeImageProvider,
  type ImageProviderKey,
} from "../../../shared/image-providers";
import DoubaoLoginChip from "../../components/DoubaoLoginChip";

/** 带配置窗口的插件：点「配置」弹窗 */
const CONFIGURABLE: PluginKey[] = ["modelscope", "doubao"];

export default function PluginsPage({
  onChanged,
  doubaoOpen = false,
  onToggleDoubao,
}: {
  /** 每次安装/卸载后把最新列表回传给 App（导航即时刷新） */
  onChanged?: (keys: PluginKey[]) => void;
  /** 豆包独立窗口开合（窗口本体挂在 App 最外层）：配置窗口里的登录按钮点它 */
  doubaoOpen?: boolean;
  onToggleDoubao?: () => void;
}) {
  const [installed, setInstalled] = useState<PluginKey[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  /** 当前打开的配置窗口：null = 没开 */
  const [configKey, setConfigKey] = useState<PluginKey | null>(null);
  /** 当前生效的生图引擎（原 AI 服务页的引擎切换挪进了这里） */
  const [activeEngine, setActiveEngine] = useState<ImageProviderKey>("doubao");

  useEffect(() => {
    let alive = true;
    window.settings
      .get()
      .then((s) => {
        if (alive) {
          setInstalled(effectiveInstalledPlugins(s.installedPlugins, s.knownPlugins));
          setActiveEngine(normalizeImageProvider(s.imageProvider));
        }
      })
      .catch(() => {
        if (alive) setInstalled([...PLUGINS.map((p) => p.key)]);
      });
    return () => {
      alive = false;
    };
  }, []);

  async function toggle(key: PluginKey) {
    if (!installed) return;
    const next = installed.includes(key)
      ? installed.filter((k) => k !== key)
      : [...installed, key];
    const prev = installed;
    setInstalled(next); // 先更 UI（开关要跟手），失败再回滚
    try {
      await window.settings.update({ installedPlugins: next });
      onChanged?.(next);
    } catch (e: unknown) {
      setInstalled(prev);
      setError(e instanceof Error ? e.message : String(e));
    }
  }

  /** 把某个生图引擎设为当前生效引擎（即时落盘） */
  async function activateEngine(key: ImageProviderKey) {
    try {
      await window.settings.update({ imageProvider: key });
      setActiveEngine(key);
    } catch (e: unknown) {
      setError(e instanceof Error ? e.message : String(e));
    }
  }

  return (
    <>
      <div className="card-pad">
        <div className="panel-title">插件</div>
        <p className="story-muted" style={{ margin: "4px 0 12px" }}>
          按需安装功能模块：卸载后工作台右侧面板的插件卡片和「＋」菜单里不再显示对应入口，数据与配置保留，随时可装回来。
          生图引擎类插件装好后点「配置」填连接参数，并在配置窗口里设为当前引擎。
        </p>
        <div className="plugin-list">
          {PLUGINS.map((p) => {
            const on = !!installed && installed.includes(p.key);
            const configurable = CONFIGURABLE.includes(p.key);
            const engineActive = configurable && activeEngine === p.key;
            return (
              <div key={p.key} className={`plugin-item${on ? " installed" : ""}`}>
                <div className="plugin-item-text">
                  <div className="plugin-item-name">
                    {p.name}
                    {engineActive && <span className="plugin-engine-chip">使用中</span>}
                  </div>
                  <div className="plugin-item-desc">{p.desc}</div>
                </div>
                <div className="plugin-item-ops">
                  {configurable && on && (
                    <button
                      type="button"
                      className="secondary small"
                      onClick={() => setConfigKey(p.key)}
                    >
                      配置
                    </button>
                  )}
                  <button
                    type="button"
                    className={`plugin-switch${on ? " on" : ""}`}
                    role="switch"
                    aria-checked={on}
                    aria-label={`${on ? "卸载" : "安装"}${p.name}`}
                    disabled={!installed}
                    onClick={() => void toggle(p.key)}
                  >
                    <span className="plugin-switch-knob" />
                  </button>
                </div>
              </div>
            );
          })}
        </div>
        {!installed && <p className="status">设置读取中…</p>}
      </div>
      {error && <div className="error">{error}</div>}

      {configKey === "modelscope" && (
        <ModelScopeConfig
          engineActive={activeEngine === "modelscope"}
          onActivate={() => void activateEngine("modelscope")}
          onClose={() => setConfigKey(null)}
        />
      )}
      {configKey === "doubao" && (
        <div className="modal-overlay" onClick={() => setConfigKey(null)}>
          <div
            className="modal-card clone-modal"
            role="dialog"
            aria-label="配置豆包生图"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="clone-modal-head">
              <h3>豆包生图</h3>
              <button type="button" className="secondary small" onClick={() => setConfigKey(null)}>
                关闭
              </button>
            </div>
            <div className="clone-modal-body">
              <p className="story-muted" style={{ margin: 0 }}>
                豆包是网页生图引擎（免费）：登录一次长期有效。未登录时点下面的按钮，
                会在独立窗口打开豆包，扫码登录即可；已登录时点它可以直接看生成。
              </p>
              {onToggleDoubao && (
                <div style={{ display: "flex", justifyContent: "center", padding: "6px 0 2px" }}>
                  <DoubaoLoginChip
                    open={doubaoOpen}
                    onOpen={onToggleDoubao}
                    onClose={onToggleDoubao}
                  />
                </div>
              )}
            </div>
            <div className="clone-modal-actions">
              <button
                type="button"
                className="primary"
                disabled={activeEngine === "doubao"}
                onClick={() => void activateEngine("doubao")}
              >
                {activeEngine === "doubao" ? "当前引擎" : "设为当前生图引擎"}
              </button>
            </div>
          </div>
        </div>
      )}
    </>
  );
}

/**
 * ModelScope 配置窗口：令牌 / 模型 / 出图尺寸。
 * 配置存在 app 分区 modelscopeImage（即时保存）；「设为当前生图引擎」也在窗口里。
 */
function ModelScopeConfig({
  engineActive,
  onActivate,
  onClose,
}: {
  /** ModelScope 是否已是当前生图引擎 */
  engineActive: boolean;
  /** 点「设为当前生图引擎」（落盘由父级做，这里只管叫） */
  onActivate: () => void;
  onClose: () => void;
}) {
  const [token, setToken] = useState("");
  const [model, setModel] = useState("");
  const [size, setSize] = useState("");
  const [loaded, setLoaded] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [helpOpen, setHelpOpen] = useState(false);

  useEffect(() => {
    let alive = true;
    window.settings
      .get()
      .then((s) => {
        if (!alive) return;
        setToken(s.modelscopeImage?.token ?? "");
        setModel(s.modelscopeImage?.model ?? "");
        setSize(s.modelscopeImage?.size ?? "");
        setLoaded(true);
      })
      .catch(() => {
        if (alive) setLoaded(true);
      });
    return () => {
      alive = false;
    };
  }, []);

  async function save() {
    setSaving(true);
    setError(null);
    try {
      await window.settings.update({
        modelscopeImage: { token, model, size },
      });
      onClose();
    } catch (e: unknown) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="modal-overlay" onClick={onClose}>
      <div
        className="modal-card clone-modal"
        role="dialog"
        aria-label="配置 ModelScope 生图"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="clone-modal-head">
          <h3>ModelScope 生图</h3>
          <button type="button" className="secondary small" onClick={onClose}>
            取消
          </button>
        </div>
        <div className="clone-modal-body">
          <div className="form-row">
            <label>API Key</label>
            <input
              type="password"
              value={token}
              autoComplete="off"
              placeholder="粘贴访问令牌（ms- 开头）"
              onChange={(e) => setToken(e.target.value)}
            />
          </div>
          <div className="form-row">
            <label />
            <button type="button" className="key-help-icon" onClick={() => setHelpOpen((v) => !v)}>
              ?
            </button>
          </div>
          {helpOpen && (
            <div className="hint">
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

          <div className="form-row">
            <label>模型</label>
            <input
              value={model}
              placeholder={MODELSCOPE_DEFAULT_MODEL}
              title="留空用默认模型；也可以手填 ModelScope 上的其它模型 id"
              onChange={(e) => setModel(e.target.value)}
            />
          </div>
          <div className="ai-provider-row" style={{ paddingLeft: 130 }}>
            {MODELSCOPE_MODEL_PRESETS.map((m) => (
              <button
                key={m.value}
                type="button"
                className={`secondary small ${model === m.value ? "ai-provider-active" : ""}`}
                title={m.value}
                onClick={() => setModel(m.value)}
              >
                {m.label}
              </button>
            ))}
          </div>

          <div className="form-row">
            <label>出图尺寸</label>
            <select value={size} onChange={(e) => setSize(e.target.value)}>
              {MODELSCOPE_SIZE_PRESETS.map((o) => (
                <option key={o.value} value={o.value}>
                  {o.label}
                </option>
              ))}
            </select>
          </div>
        </div>
        <div className="clone-modal-actions">
          <button
            type="button"
            className="secondary"
            disabled={engineActive}
            onClick={onActivate}
          >
            {engineActive ? "当前引擎" : "设为当前生图引擎"}
          </button>
          <button type="button" className="primary" disabled={!loaded || saving} onClick={() => void save()}>
            {saving ? "保存中…" : "保存"}
          </button>
        </div>
        {error && <div className="error">{error}</div>}
      </div>
    </div>
  );
}
