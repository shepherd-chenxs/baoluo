/**
 * 豆包独立窗口（v1.0.0）的渲染层薄壳。
 *
 * 豆包页面不再内嵌在宝螺窗口里（v1.0.0 的 WebContentsView 抽屉已被它取代），
 * 而是主进程弹出的**独立 BrowserWindow**——登录、看生成都在那个窗口里完成，
 * 宝螺这边的 DOM 里没有它的位置，也不需要再量坐标同步 bounds。
 *
 * 这个组件只剩三件事：
 *   1) open 变化时通知主进程开 / 关（= 显示 / 隐藏）豆包窗口；
 *   2) 用户点了豆包窗口自己的 ✕（主进程广播 visible=false）时，把 App 的
 *      open 状态同步回来，否则登录点会一直显示「关闭豆包窗口」；
 *   3) 加载失败时在宝螺里给一张小卡片（人话原因 + 重试）——独立窗口里
 *      只有白页，错误和重试入口得放回宝螺这边。
 */
import { useEffect, useRef, useState } from "react";
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

export default function DoubaoWindow({ open, onClose }: Props) {
  const [state, setState] = useState<DoubaoState | null>(null);
  /**
   * 「窗口真的显示过一次」的标记。
   *
   * 打开窗口的瞬间主进程会广播 visible=false（窗口还在加载），
   * 不能把它当成「用户关掉了」；只有先见过 visible=true、随后变 false，
   * 才是用户点了豆包窗口自己的 ✕。
   */
  const sawVisible = useRef(false);

  useEffect(() => {
    return window.doubao.onState((s) => {
      setState(s);
      if (s.visible) sawVisible.current = true;
      // 用户直接点了独立窗口的关闭按钮：同步回 App 的 open 状态
      if (open && sawVisible.current && !s.visible) onClose();
    });
  }, [open, onClose]);

  // 开 / 关都通知主进程。首次挂载（open=false）跳过：那时还没有窗口，发过去也是空转。
  const firstRun = useRef(true);
  useEffect(() => {
    if (firstRun.current) {
      firstRun.current = false;
      return;
    }
    if (open) sawVisible.current = false;
    void window.doubao.setVisible(open).then(setState);
  }, [open]);

  if (!open) return null;

  const failed = state?.status === "error";

  return (
    <>
      {failed ? (
        <div className="doubao-window-toast" role="alert">
          <p>{state?.message || "豆包页面加载失败。"}</p>
          <div className="doubao-window-toast-actions">
            <button
              type="button"
              className="secondary small"
              onClick={() => void window.doubao.reload().then(setState)}
            >
              重试
            </button>
            <button type="button" className="secondary small" onClick={onClose}>
              关闭
            </button>
          </div>
        </div>
      ) : null}
    </>
  );
}
