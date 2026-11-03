/**
 * Chromium 启动开关（必须**在 app ready 之前**设置，所以要单独一个模块，
 * 让主进程和各个测试脚本都能在最早的时刻调用）。
 *
 * 这些开关是为了让「屏幕外的豆包窗口」对页面来说仍然是一扇**可见**的窗口：
 *
 *   - `CalculateNativeWinOcclusion`：Windows 下 Chromium 会判定「窗口被别的窗口盖住 /
 *     在屏幕外」→ 把渲染进程标成 hidden。实测后果很硬：被标 hidden 后
 *     `document.hidden === true`、`innerWidth/Height = 0`、`execCommand('insertText')`
 *     完全失效、发送按钮不渲染 —— 提示词根本填不进去（这就是后台生图曾经坏掉的原因）。
 *   - `disable-backgrounding-occluded-windows` / `disable-renderer-backgrounding`：
 *     别因为"用户看不见"就降低渲染进程的优先级，生成过程要照常轮询。
 *
 * 实测（tmp/probe-offscreen2.log）：加了这些开关之后，屏幕外窗口里的页面
 * `visibilityState: "visible"`、`hasFocus: true`、填词成功、发送按钮可用。
 */
export function applyChromiumSwitches(): void {
  const features = "CalculateNativeWinOcclusion";
  // 别覆盖别人已经设过的 disable-features：合并进去
  const { app } = require("electron") as typeof import("electron");
  const existing = app.commandLine.getSwitchValue("disable-features");
  const merged = existing ? `${existing},${features}` : features;
  app.commandLine.appendSwitch("disable-features", merged);
  app.commandLine.appendSwitch("disable-backgrounding-occluded-windows");
  app.commandLine.appendSwitch("disable-renderer-backgrounding");
}
