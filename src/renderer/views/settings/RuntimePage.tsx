/**
 * 设置 → 运行时（集成运行时）。
 *
 * 三件事：
 *   1) 识别本机装好的智能体 CLI（只识别，不代装 —— 跟 bandi 同一条口径）；
 *   2) 从识别到的若干个里**应用一个**（同一时间只允许一个，应用新的即替换旧的）；
 *   3) 让用户把技能（`技能名/SKILL.md`）丢进目录，运行时下一轮就带上。
 *
 * 这里刻意没有"取消应用"：应用是单选，跟"默认模板"一个道理 ——
 * 只有已应用的那个从本机卸载了（识别不到）才给一个「取消应用」的逃生口。
 */
import { useCallback, useEffect, useRef, useState } from "react";
import type { RuntimeInfo, RuntimeState } from "../../../shared/runtime-types";
import { usePageActive } from "../../components/KeepAlive";

function errText(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

function statusText(r: RuntimeInfo): string {
  return r.status === "ready" ? "可用" : "起不来";
}

export default function RuntimePage() {
  const pageActive = usePageActive();
  const [state, setState] = useState<RuntimeState | null>(null);
  const [scanning, setScanning] = useState(false);
  const [applying, setApplying] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const loadedRef = useRef(false);

  const scan = useCallback(async () => {
    setScanning(true);
    setError(null);
    try {
      setState(await window.runtime.detect());
    } catch (e: unknown) {
      setError(errText(e));
    } finally {
      setScanning(false);
    }
  }, []);

  useEffect(() => {
    if (!pageActive || loadedRef.current) return;
    loadedRef.current = true;
    let alive = true;
    (async () => {
      try {
        const s = await window.runtime.state();
        if (!alive) return;
        setState(s);
        // 刚打开且没扫过：自动扫一次（用户不用先点一下才知道装了啥）
        if (!s.detectedAt) await scan();
      } catch (e: unknown) {
        if (alive) setError(errText(e));
      }
    })();
    return () => {
      alive = false;
    };
  }, [pageActive, scan]);

  async function apply(id: string | null) {
    setApplying(id ?? "clear");
    setError(null);
    try {
      setState(await window.runtime.apply(id));
    } catch (e: unknown) {
      setError(errText(e));
    } finally {
      setApplying(null);
    }
  }

  const detected = state?.detected ?? [];
  const activeId = state?.activeId ?? null;
  const active = detected.find((r) => r.id === activeId) ?? null;
  const activeMissing = !!activeId && !active;

  return (
    <div className="runtime-page">
      <div className="runtime-tip">
        <b>同一时间只能应用一个运行时。</b>
        应用后，工作台对话区（田螺姑娘）的指令交给它听懂、聊清楚，再按宝螺现有的流程去做；
        没应用时对话区仍走本地规则。
        <span className="runtime-tip-sub">
          运行时只负责「听懂 + 规划」，不会直接改你的文件，也不执行命令。
        </span>
      </div>

      <div className="runtime-head">
        <span className="runtime-head-title">
          已识别 <span className="count">{detected.length}</span>
        </span>
        <button className="secondary small" disabled={scanning} onClick={() => void scan()}>
          {scanning ? "识别中…" : detected.length ? "重新识别" : "识别运行时"}
        </button>
      </div>

      {detected.length > 0 && (
        <div className="runtime-list">
          {detected.map((r) => {
            const applied = r.id === activeId;
            return (
              <div key={r.id} className={`runtime-item${applied ? " applied" : ""}`}>
                <div className="runtime-mark" aria-hidden="true">
                  {r.label.slice(0, 1)}
                </div>
                <div className="runtime-text">
                  <div className="runtime-name">
                    <span>{r.label}</span>
                    {r.version && <span className="runtime-version">{r.version}</span>}
                    <span className={`runtime-badge ${r.status === "ready" ? "ok" : "warn"}`}>
                      {statusText(r)}
                    </span>
                    {applied && <span className="runtime-applied">已应用</span>}
                  </div>
                  <div className="runtime-path" title={r.path}>
                    {r.path}
                  </div>
                  {r.status === "broken" && r.note && <div className="runtime-note">{r.note}</div>}
                  {r.installs.length > 1 && (
                    <div className="runtime-note">
                      这台机器上还有 {r.installs.length - 1} 处同款安装；宝螺用的是上面这个。
                    </div>
                  )}
                </div>
                <div className="runtime-ops">
                  <button
                    type="button"
                    className={applied ? "secondary small" : "primary small"}
                    disabled={applied || r.status !== "ready" || applying !== null}
                    onClick={() => void apply(r.id)}
                  >
                    {applied ? "已应用" : applying === r.id ? "应用中…" : "应用"}
                  </button>
                </div>
              </div>
            );
          })}
        </div>
      )}

      {state && detected.length === 0 && !scanning && (
        <div className="runtime-empty">
          <b>这台机器上还没识别到智能体 CLI</b>
          <span>
            先装一个（Codex CLI / Claude Code / Gemini CLI），装完回到这里点「重新识别」。
            宝螺不代装，只负责认出来。
          </span>
        </div>
      )}

      {activeMissing && (
        <div className="runtime-warn">
          <span>
            已应用的运行时（{activeId}）在这台机器上没识别到，可能已经被卸载了。
            对话区现在用不了它，换一个应用即可。
          </span>
          <button
            type="button"
            className="secondary small"
            disabled={applying !== null}
            onClick={() => void apply(null)}
          >
            取消应用
          </button>
        </div>
      )}

      <div className="runtime-skills">
        <div className="runtime-head">
          <span className="runtime-head-title">
            技能 <span className="count">{state?.skills.length ?? 0}</span>
          </span>
          <button
            type="button"
            className="secondary small"
            onClick={() => void window.runtime.openSkillsDir().catch((e) => setError(errText(e)))}
          >
            打开技能目录
          </button>
        </div>
        <p className="runtime-skills-hint">
          在目录里新建 <code>技能名/SKILL.md</code>，写清「什么时候用、怎么做」；运行时下一轮就会带上它。
        </p>
        {(state?.skills ?? []).map((s) => (
          <div key={s.key} className="runtime-skill">
            <div className="runtime-skill-name">{s.name}</div>
            <div className="runtime-skill-desc">{s.description}</div>
          </div>
        ))}
        {state && state.skills.length === 0 && <div className="runtime-note">还没装技能。</div>}
      </div>

      {error && <div className="error">{error}</div>}
    </div>
  );
}
