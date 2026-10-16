/*
 * SPDX-License-Identifier: GPL-3.0-only
 * Copyright (c) 2026 宝螺 / Baoluo contributors
 * 本文件属于「宝螺 / Baoluo」。除 GPL-3.0 外还适用 ADDITIONAL_TERMS.md 里的附加条款：
 * 分发时须保留来源署名；修改版对外分发时不得沿用「宝螺」名称与图标。
 */
/**
 * 页面保活。
 *
 * 顶栏切页原来是「卸载旧页 + 从零挂载新页」：每页首屏都得等一圈 IPC 回来才有内容，
 * 于是切过去先看到空壳、内容再弹出，看着就是一顿。这里把访问过的页面留在原地，
 * 只把非当前页的整棵子树从布局里摘掉：
 *   - 活动页 `display: contents`——容器自身不产生盒子，页面仍按原来的布局参与
 *   - 非活动页 `display: none`——不占位、不渲染，但组件实例和 state 都还在
 *
 * 首次访问前不挂载（`everActive`），否则所有页面会在启动时一起初始化。
 * 切走的页面如果正在出声（试听音频/视频），这里顺手停掉——以前是靠卸载页面顺带停的。
 */
import {
  createContext,
  useContext,
  useEffect,
  useRef,
  useState,
  type ReactNode,
} from "react";

/**
 * 当前页面是否正在显示。
 *
 * 隐藏的页面不该继续消费进度广播（同一个广播所有页面都能收到，会串状态），
 * 也不该继续轮询——所以常驻的定时器、进度订阅都要看这个值。
 */
const PageActiveContext = createContext(true);

export function usePageActive(): boolean {
  return useContext(PageActiveContext);
}

interface KeepAliveProps {
  active: boolean;
  children: ReactNode;
}

export default function KeepAlive({ active, children }: KeepAliveProps): ReactNode {
  const boxRef = useRef<HTMLDivElement>(null);
  const [everActive, setEverActive] = useState(active);

  useEffect(() => {
    if (active) setEverActive(true);
  }, [active]);

  useEffect(() => {
    if (active) return;
    const box = boxRef.current;
    if (!box) return;
    for (const el of box.querySelectorAll("audio, video")) {
      try {
        (el as HTMLMediaElement).pause();
      } catch {
        /* 停不下来不影响切页 */
      }
    }
  }, [active]);

  if (!everActive) return null;

  return (
    <PageActiveContext.Provider value={active}>
      <div ref={boxRef} className={`keep-alive${active ? "" : " is-hidden"}`}>
        {children}
      </div>
    </PageActiveContext.Provider>
  );
}
