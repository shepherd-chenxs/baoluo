/**
 * 沿多个候选字段路径尝试取值。抖音分享页 JSON 结构会随版本变，
 * 所以我们保留一组已知路径，第一个能取到非 undefined 的就返回。
 *
 * 路径元素可以是 string / number / 特殊 wildcard "*"（表示对象里唯一/第一个 key）。
 */
export type PathSegment = string | number;
export type Path = PathSegment[];

export function pickFields<T = unknown>(root: unknown, paths: Path[]): T | undefined {
  for (const p of paths) {
    const v = getByPath(root, p);
    if (v !== undefined && v !== null) return v as T;
  }
  return undefined;
}

export function getByPath(root: unknown, path: Path): unknown {
  let cur: any = root;
  for (const seg of path) {
    if (cur == null) return undefined;
    if (seg === "*") {
      // 取对象的第一个可枚举值
      if (typeof cur !== "object") return undefined;
      const keys = Object.keys(cur);
      if (!keys.length) return undefined;
      cur = cur[keys[0]];
      continue;
    }
    cur = cur[seg as any];
  }
  return cur;
}

/**
 * 找到 loaderData 下第一个形如 "video_(id)/page" 的 key 对应的值。
 * 抖音会把动态路由名编码到 key 里，例如 "video_(id)/page"。
 */
export function findVideoPageNode(loaderData: unknown): unknown {
  if (!loaderData || typeof loaderData !== "object") return undefined;
  const obj = loaderData as Record<string, unknown>;
  for (const key of Object.keys(obj)) {
    if (/video.*page/i.test(key)) return obj[key];
  }
  return undefined;
}
