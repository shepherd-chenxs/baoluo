/**
 * 豆包生图的每日用量上限（自保用，不是产品功能）。
 *
 * 为什么要它：风险不在"能不能被发现"，而在"被风控打分的频率"。短时间跑量
 * （几百张/天、无人值守）是最容易招来限流/验证码的行为，而这类代价落在用户自己的账号上。
 * 所以这里给一个宽松但存在的闸门：到量就拒绝并说人话，第二天自动恢复。
 *
 * 计数落在 settings.json 的 app 分区（只记日期 + 张数，不记内容）。
 */
import * as settings from "./dialogue/settings";

/** 每日上限（张）。想放宽/收紧改这一个常量即可。 */
export const DAILY_IMAGE_CAP = 300;

function today(): string {
  const d = new Date();
  const mm = String(d.getMonth() + 1).padStart(2, "0");
  const dd = String(d.getDate()).padStart(2, "0");
  return `${d.getFullYear()}-${mm}-${dd}`;
}

/** 今天已经生成几张（跨天自动归零） */
export function doubaoUsedToday(): number {
  const rec = settings.getAppSettings().doubaoGenDaily;
  return rec && rec.date === today() ? Math.max(0, rec.count) : 0;
}

/** 到上限就返回人话原因（界面直接显示），否则 null */
export function doubaoDailyCapBlocked(): { code: string; message: string } | null {
  const used = doubaoUsedToday();
  if (used < DAILY_IMAGE_CAP) return null;
  return {
    code: "daily-cap",
    message:
      `今天已经用豆包生成了 ${used} 张图（自设上限 ${DAILY_IMAGE_CAP} 张/天），先歇一天：` +
      "短时间跑量最容易招来限流或验证码。明天零点自动恢复。",
  };
}

/** 成功出图后记一笔 */
export function noteDoubaoGenerated(n = 1): void {
  const count = doubaoUsedToday() + Math.max(0, Math.floor(n));
  settings.updateAppSettings({ doubaoGenDaily: { date: today(), count } });
}
