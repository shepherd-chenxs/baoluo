/**
 * 热度显示。
 *
 * 榜单接口有的直接给数字（如 "8740000"），有的已经带单位（"874万"）。
 * 统一在这里格式化，「热点成片」页和工作台共用一份——两处各写一遍迟早会显示不一致。
 * 万 / 亿 都保留一位小数，且去掉没意义的 ".0"。
 */
export function formatHeat(heat?: string): string {
  if (!heat) return "";
  const n = Number(heat);
  // 已经带了单位的（"874万"）：原样用，不再瞎猜
  if (!Number.isFinite(n) || n <= 0) return heat;
  if (n >= 100_000_000) {
    return (n / 100_000_000).toFixed(1).replace(/\.0$/, "") + "亿";
  }
  if (n >= 10_000) {
    return (n / 10_000).toFixed(1).replace(/\.0$/, "") + "万";
  }
  return String(Math.round(n));
}
