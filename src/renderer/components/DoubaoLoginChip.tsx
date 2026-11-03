/**
 * 工作台右下角的豆包登录入口（v1.0.0）。
 *
 * 为什么要有它：豆包的入口原来散在各处（分镜页/图文解说页的按钮、设置页的开关、
 * 失败提示里的「打开豆包登录」），用户想知道「到底登没登录」得先切到某个页面去开抽屉。
 * 这里给一个常驻的状态胶囊：
 *   ● 已登录 / ○ 未登录，点这里扫码 / 正在打开… / 打开失败
 * 点一下就把豆包面板打开（登录、看生成、手动发送都在面板里）。
 *
 * 状态从哪来：`window.doubao.accountState()`（主进程查登录态 + 页面状态）。
 * **没打开过页面时不会为了它去加载豆包**（返回 idle），所以停在「工作台」不额外联网。
 */
import { useCallback, useEffect, useState } from "react";
import type { DoubaoAccountState, DoubaoApi, DoubaoState } from "../../preload";

declare global {
  interface Window {
    doubao: DoubaoApi;
  }
}

interface Props {
  /** 面板是否开着（开关状态由 App 持有） */
  open: boolean;
  onOpen: () => void;
  onClose: () => void;
}

export default function DoubaoLoginChip({ open, onOpen, onClose }: Props) {
  const [page, setPage] = useState<DoubaoState | null>(null);
  const [account, setAccount] = useState<DoubaoAccountState | null>(null);

  const refresh = useCallback(async () => {
    try {
      // 页面状态走广播 + 主动查一次（刚挂载时广播可能已经错过）
      const [st, acc] = await Promise.all([
        window.doubao.state().catch(() => null),
        window.doubao.accountState().catch(() => null),
      ]);
      if (st) setPage(st);
      if (acc) setAccount(acc);
    } catch {
      /* 查询失败不影响主流程，界面按「未知」显示 */
    }
  }, []);

  // 主进程广播页面状态（加载中 / 就绪 / 失败）时同步一次
  useEffect(() => {
    const off = window.doubao.onState((s) => setPage(s));
    void refresh();
    return off;
  }, [refresh]);

  // 页面刚就绪（或刚失败）时再查一次登录态：那时 DOM 才可读
  useEffect(() => {
    if (page?.status === "ready" || page?.status === "error") void refresh();
  }, [page?.status, refresh]);

  // 抽屉开合后也刷新：登录往往就是在抽屉里完成的
  useEffect(() => {
    void refresh();
  }, [open, refresh]);

  // 用户刚扫码登录成功：主进程会广播一次，这里跟着把点变绿（面板由 App 收掉）
  useEffect(() => {
    return window.doubao.onLoggedIn(() => void refresh());
  }, [refresh]);

  const status = page?.status ?? "idle";
  const failed = status === "error";
  const loading = status === "loading";
  const loggedIn = account?.loggedIn ?? null;

  let dotClass = "idle";
  let label = "登录豆包";
  let title = "在应用内登录豆包，登录后长期有效";
  if (failed) {
    dotClass = "error";
    label = "豆包打开失败";
    title = (page?.message || "豆包页面没能打开") + "；点一下打开豆包窗口重试";
  } else if (loading) {
    dotClass = "loading";
    label = "豆包加载中…";
    title = "豆包页面加载中";
  } else if (loggedIn === true) {
    dotClass = "ok";
    label = "豆包已登录";
    title = "已登录；点一下打开豆包窗口，可以直接看生成";
  } else if (loggedIn === false) {
    dotClass = "warn";
    label = "豆包未登录";
    title = "点一下打开豆包窗口扫码登录（登录后长期有效）";
  }

  return (
    <button
      type="button"
      className={`doubao-login-chip ${dotClass}${open ? " open" : ""}`}
      onClick={() => (open ? onClose() : onOpen())}
      title={title}
    >
      <span className="doubao-login-dot" />
      <span className="doubao-login-label">{open ? "关闭豆包窗口" : label}</span>
    </button>
  );
}
