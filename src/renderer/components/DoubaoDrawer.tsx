/**
 * 内嵌豆包（v1.0.0）：**铺满内容区的全屏面板**（原来是个 760px 的右侧抽屉）。
 *
 * 真正的豆包页面是主进程挂上来的原生 WebContentsView，不在这棵 DOM 里——
 * 这里只负责：
 *   1) 画面板的壳（标题栏 / 加载态 / 失败重试），
 *   2) 把壳里留给网页的那块区域的坐标量出来，同步给主进程摆视图。
 *
 * 所以「网页区」在 DOM 里必须是一个空的占位盒，不能塞任何内容，否则会被盖住。
 *
 * 尺寸变了不影响这套机制：占位盒跟着 CSS 走（现在是从顶栏下沿铺到窗口底），
 * 量出来的矩形更大，主进程摆出来的豆包页面就更大。
 */
import { useEffect, useLayoutEffect, useRef, useState } from "react";
import type { DoubaoApi, DoubaoState } from "../../preload";

declare global {
  interface Window {
    /** 类型以 preload 暴露的 DoubaoApi 为准，别在这里重复声明 */
    doubao: DoubaoApi;
  }
}

interface Props {
  open: boolean;
  onClose: () => void;
}

/**
 * 把占位盒的位置同步给主进程。
 *
 * 窗口大小变化、页面滚动、面板开合都会改变坐标，所以：
 *   - 用 ResizeObserver 盯尺寸；
 *   - 用 rAF 连续几帧补量一次，等淡入动画结束（动画期间量到的是中间态）。
 */
function useSyncBounds(
  slotRef: React.RefObject<HTMLDivElement>,
  open: boolean,
  onSync: (b: { x: number; y: number; width: number; height: number }) => void
) {
  useEffect(() => {
    if (!open) return;
    let raf = 0;
    let stopped = false;

    const sync = () => {
      const el = slotRef.current;
      if (!el) return;
      const r = el.getBoundingClientRect();
      onSync({
        x: Math.round(r.left),
        y: Math.round(r.top),
        width: Math.round(r.width),
        height: Math.round(r.height),
      });
    };

    // 连续量 30 帧（约 0.5s），覆盖滑入动画 + 字体/滚动条带来的尺寸抖动
    let frames = 0;
    const tick = () => {
      if (stopped) return;
      sync();
      if (++frames < 30) raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);

    const ro = new ResizeObserver(sync);
    if (slotRef.current) ro.observe(slotRef.current);
    window.addEventListener("resize", sync);
    window.addEventListener("scroll", sync, true);

    return () => {
      stopped = true;
      cancelAnimationFrame(raf);
      ro.disconnect();
      window.removeEventListener("resize", sync);
      window.removeEventListener("scroll", sync, true);
    };
  }, [open, onSync, slotRef]);
}

export default function DoubaoDrawer({ open, onClose }: Props) {
  const slotRef = useRef<HTMLDivElement>(null);
  const [state, setState] = useState<DoubaoState | null>(null);

  const syncBounds = (b: { x: number; y: number; width: number; height: number }) => {
    void window.doubao.setBounds(b);
  };
  useSyncBounds(slotRef, open, syncBounds);

  useEffect(() => {
    const off = window.doubao.onState(setState);
    return off;
  }, []);

  /*
   * 视图创建是异步的：面板刚打开时主进程还没建视图，那时发的 setBounds 会被丢掉。
   * 所以每次收到状态更新（尤其是 attached 从 false 变 true）都补量一次，
   * 否则要等到用户拖窗口大小才会重新对齐——面板会一直空着。
   */
  useEffect(() => {
    if (!open) return;
    const el = slotRef.current;
    if (!el) return;
    const r = el.getBoundingClientRect();
    if (r.width < 2 || r.height < 2) return;
    void window.doubao.setBounds({
      x: Math.round(r.left),
      y: Math.round(r.top),
      width: Math.round(r.width),
      height: Math.round(r.height),
    });
  }, [open, state?.attached]);

  /*
   * 开 / 关都通知主进程。首次挂载（open=false）跳过：
   * 那时还没有视图，发过去也是空转。
   */
  const firstRun = useRef(true);
  useEffect(() => {
    if (firstRun.current) {
      firstRun.current = false;
      return;
    }
    void window.doubao.setVisible(open).then(setState);
  }, [open]);

  // 面板关闭时把占位盒尺寸清零，主进程据此把视图也藏起来
  useLayoutEffect(() => {
    if (open || firstRun.current) return;
    void window.doubao.setBounds({ x: 0, y: 0, width: 0, height: 0 });
  }, [open]);

  if (!open) return null;

  const failed = state?.status === "error";

  return (
    <aside className="doubao-drawer">
      <div className="doubao-drawer-head">
        <span className="doubao-drawer-title">豆包</span>
        <span className="doubao-drawer-sub">
          {failed ? "" : "在这里登录一次，之后一直有效；登录成功会自动回到宝螺"}
        </span>
        <div className="doubao-drawer-actions">
          <button
            type="button"
            className="secondary small"
            onClick={() => void window.doubao.reload().then(setState)}
            title="重新加载豆包页面"
          >
            重载
          </button>
          <button type="button" className="secondary small" onClick={onClose} title="回到宝螺">
            关闭
          </button>
        </div>
      </div>

      {/* 网页占位区：豆包页面由主进程摆在这块矩形上，这里不能放内容 */}
      <div className="doubao-drawer-slot" ref={slotRef}>
        {state?.status === "loading" ? (
          <div className="doubao-drawer-mask">正在打开豆包…</div>
        ) : failed ? (
          <div className="doubao-drawer-mask error">
            <p>{state?.message || "豆包页面加载失败。"}</p>
            <button
              type="button"
              className="secondary small"
              onClick={() => void window.doubao.reload().then(setState)}
            >
              重试
            </button>
          </div>
        ) : null}
      </div>
    </aside>
  );
}
