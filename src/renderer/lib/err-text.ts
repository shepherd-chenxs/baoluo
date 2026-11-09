/**
 * 界面上的报错文案收口。
 *
 * 主进程抛的错经 IPC 回到渲染层会被包一层
 * `Error invoking remote method 'x': Error: …`，直接弹给用户看就是一串英文噪音。
 * 这里统一剥前缀，并把几类常见故障翻成人话。
 */

/** 剥掉 IPC 包装，只留里层那句话 */
export function stripIpc(message: string): string {
  return message.replace(/^Error invoking remote method '[^']+':\s*(Error:\s*)?/, "").trim();
}

/**
 * 语音合成（Edge 在线音色）失败时的用户可读文案。
 *
 * 原始报错长这样：`Unexpected server response: 403`（ws 库在握手被拒时抛的），
 * 对用户没有任何指导意义，得说清「是谁拒了、该干什么」。
 */
export function ttsErrorText(e: unknown): string {
  const raw = stripIpc(e instanceof Error ? e.message : String(e));
  if (/403|forbidden|unauthorized/i.test(raw)) {
    return "微软在线音色接口拒绝了连接（403）。通常是服务端改了鉴权，重开宝螺再试；还不行就先换本地克隆音色。";
  }
  if (/429|too many requests|rate limit/i.test(raw)) {
    return "请求太频繁，微软那边限流了（429）。等一两分钟再试，别连续点不同音色。";
  }
  if (/ECONNRESET|ETIMEDOUT|ENOTFOUND|EAI_AGAIN|ECONNREFUSED|socket hang up|network/i.test(raw)) {
    return "连不上微软在线音色服务（网络问题），检查网络或代理后再试。";
  }
  if (/timeout|timed out/i.test(raw)) {
    return "该音色当前不可用（合成超时），请换个音色试试。";
  }
  if (/empty|没有合成/i.test(raw)) {
    return "这次没合成出声音，再点一次试听。";
  }
  return raw || "试听失败，稍后再试。";
}
