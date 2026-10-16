/*
 * SPDX-License-Identifier: GPL-3.0-only
 * Copyright (c) 2026 宝螺 / Baoluo contributors
 * 本文件属于「宝螺 / Baoluo」。除 GPL-3.0 外还适用 ADDITIONAL_TERMS.md 里的附加条款：
 * 分发时须保留来源署名；修改版对外分发时不得沿用「宝螺」名称与图标。
 */
import { app } from "electron";
import fs from "node:fs";
import path from "node:path";

/** 宝螺的标准用户数据目录名（%APPDATA%/Baoluo） */
export const USER_DATA_FOLDER = "Baoluo";

function isDir(p: string): boolean {
  try {
    return fs.statSync(p).isDirectory();
  } catch {
    return false;
  }
}

/** 必须在任何模块读写 userData 之前调用（main 入口最先执行） */
export function setupUserDataDir(): void {
  const target = currentDataDir();
  // setPath 前先把目录建出来（新默认目录 C:\Baoluo\data 首次启动时还不存在）
  try {
    fs.mkdirSync(target, { recursive: true });
  } catch {
    /* 建不出来就让下面的 setPath / 首次写盘去报错 */
  }
  // 上次迁移后没删干净的旧目录，趁这会儿还没人占用，补删一次
  runPendingCleanup();
  // Chromium 的磁盘缓存也放到数据目录（默认在 C 盘会攒几百 MB）
  try {
    app.commandLine.appendSwitch("disk-cache-dir", path.join(target, "cache"));
  } catch {
    /* 某些环境不允许改命令行开关，忽略 */
  }
  // 老版本留下的转码临时目录（现在的代码已经不引用它），顺手清掉
  try {
    const legacyTmp = path.join(target, "video2c-tmp");
    if (fs.existsSync(legacyTmp)) fs.rmSync(legacyTmp, { recursive: true, force: true });
  } catch {
    /* 被占用就下次启动再清 */
  }
  app.setPath("userData", target);
}

// ---------------------------------------------------------------------------
// 数据目录可配置（方案 A）：默认 C:\Baoluo\data，可在设置里换到别的盘
// ---------------------------------------------------------------------------

/** 默认数据目录：C:\Baoluo\data（固定短路径，和视频输出/素材目录同一处） */
const DATA_DIR_DEFAULT = "C:\\Baoluo\\data";

/** 老版本的默认数据目录：%APPDATA%\Baoluo（升级后要"认领"这里的老数据） */
export function legacyDataDir(): string {
  return path.join(app.getPath("appData"), USER_DATA_FOLDER);
}

/**
 * 默认数据目录（同时也是"指针文件"所在的地方）。
 * 可用环境变量 BAOLUO_DATA_DIR 覆盖——测试和便携部署会用到。
 */
export function defaultDataDir(): string {
  const override = process.env.BAOLUO_DATA_DIR?.trim();
  if (override) return path.resolve(override);
  return DATA_DIR_DEFAULT;
}

/**
 * 指针文件：记录用户选的数据目录。
 * 必须留在默认目录里——数据搬到别处后，只有这里还能找到"数据到底在哪"。
 * 老用户可能把指针留在旧的 %APPDATA%\Baoluo 下，两处都要认。
 */
export function dataRootPointerFile(): string {
  return path.join(defaultDataDir(), "data-root.txt");
}

/** 指针文件候选位置：新默认目录优先，其次旧默认目录（兼容已经迁移过的老用户） */
function pointerCandidates(): string[] {
  return [dataRootPointerFile(), path.join(legacyDataDir(), "data-root.txt")];
}

/** 读取指针文件里的自定义目录（没有/无效则返回 null） */
export function readDataRoot(): string | null {
  for (const p of pointerCandidates()) {
    try {
      const raw = fs.readFileSync(p, "utf-8").trim();
      if (!raw) continue;
      const resolved = path.resolve(raw);
      if (!isDir(resolved)) {
        console.warn("[userData] 指针里的数据目录不存在，忽略:", resolved);
        continue;
      }
      return resolved;
    } catch {
      /* 这个位置没有指针文件，试下一个 */
    }
  }
  return null;
}

/** 判断一个目录里是否已经有"应用数据"（用来认领老目录） */
function hasAppData(dir: string): boolean {
  const markers = ["settings.json", "genie", "models", "runtime"];
  return markers.some((m) => fs.existsSync(path.join(dir, m)));
}

/**
 * 当前生效的数据目录。
 *
 * 优先用指针；没有指针时，如果老目录 %APPDATA%\Baoluo 里已经有数据（老用户升级上来），
 * 就地认领它——否则改默认值等于把用户的授权、模型、设置全丢了。
 */
export function currentDataDir(): string {
  const pointed = readDataRoot();
  if (pointed) return pointed;
  const legacy = legacyDataDir();
  if (hasAppData(legacy)) return legacy;
  return defaultDataDir();
}

/** 写入/清除指针文件（传 null 表示恢复默认） */
export function writeDataRoot(dir: string | null): void {
  const p = dataRootPointerFile();
  if (!dir || path.resolve(dir) === path.resolve(defaultDataDir())) {
    try {
      if (fs.existsSync(p)) fs.unlinkSync(p);
    } catch {
      /* noop */
    }
    return;
  }
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, `${path.resolve(dir)}\n`, "utf-8");
}

export interface MigrateProgress {
  copied: number;
  total: number;
  bytes: number;
  percent: number;
  file: string;
}

export interface MigrateResult {
  copied: number;
  bytes: number;
  /** 复制失败的文件（一般是运行中被占用的缓存文件） */
  skipped: string[];
}

/** 目录占用（用于界面显示与目标盘空间校验） */
export function dirSizeBytes(dir: string): number {
  let sum = 0;
  const walk = (d: string) => {
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(d, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      const full = path.join(d, e.name);
      if (e.isDirectory()) walk(full);
      else if (e.isFile()) {
        try {
          sum += fs.statSync(full).size;
        } catch {
          /* 忽略读不到的文件 */
        }
      }
    }
  };
  walk(dir);
  return sum;
}

/**
 * 把数据从 src 复制到 dst（不删源）。
 * - 跳过指针文件（它必须留在默认目录）；
 * - 运行中被占用的文件（Chromium 缓存）复制失败只记进 skipped，不中断整体迁移。
 */
export async function copyDataDir(
  src: string,
  dst: string,
  opts: { onProgress?: (p: MigrateProgress) => void; signal?: AbortSignal } = {}
): Promise<MigrateResult> {
  const files: Array<{ from: string; to: string; size: number }> = [];
  const pointer = path.resolve(dataRootPointerFile());
  const walk = (d: string) => {
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(d, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      const full = path.join(d, e.name);
      if (path.resolve(full) === pointer) continue;
      if (e.isDirectory()) walk(full);
      else if (e.isFile()) {
        let size = 0;
        try {
          size = fs.statSync(full).size;
        } catch {
          /* noop */
        }
        files.push({ from: full, to: path.join(dst, path.relative(src, full)), size });
      }
    }
  };
  walk(src);

  const totalBytes = files.reduce((n, f) => n + f.size, 0);
  let bytes = 0;
  let copied = 0;
  const skipped: string[] = [];
  for (const f of files) {
    if (opts.signal?.aborted) throw new Error("已取消");
    try {
      fs.mkdirSync(path.dirname(f.to), { recursive: true });
      // 被占用的文件（正在写的缓存）重试一次就放弃
      try {
        fs.copyFileSync(f.from, f.to);
      } catch {
        await new Promise((r) => setTimeout(r, 120));
        fs.copyFileSync(f.from, f.to);
      }
    } catch {
      skipped.push(f.from);
    }
    copied++;
    bytes += f.size;
    opts.onProgress?.({
      copied,
      total: files.length,
      bytes,
      percent: totalBytes > 0 ? Math.min(100, Math.round((bytes / totalBytes) * 100)) : 100,
      file: f.from,
    });
  }
  return { copied, bytes, skipped };
}

/** 清空一个数据目录（默认目录里会保留指针文件） */
export function clearDataDir(dir: string): { failed: string[] } {
  const failed: string[] = [];
  const pointer = path.resolve(dataRootPointerFile());
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return { failed };
  }
  for (const e of entries) {
    const full = path.join(dir, e.name);
    if (path.resolve(full) === pointer) continue;
    try {
      fs.rmSync(full, { recursive: true, force: true });
    } catch {
      failed.push(full);
    }
  }
  return { failed };
}

/** 待清理的旧数据目录（迁移时删不干净的话记在这里，下次启动补删） */
export function pendingCleanupFile(): string {
  return path.join(defaultDataDir(), "pending-cleanup.txt");
}

/** 记下"下次启动时删掉这个旧目录" */
export function scheduleDataDirCleanup(dir: string): void {
  try {
    fs.mkdirSync(path.dirname(pendingCleanupFile()), { recursive: true });
    fs.writeFileSync(pendingCleanupFile(), `${path.resolve(dir)}\n`, "utf-8");
  } catch {
    /* 写不了就算了，残留目录用户可手删 */
  }
}

/**
 * 启动时补删上次迁移残留的旧目录。
 *
 * 迁移是应用运行中做的，Genie 服务正占着模型文件、Chromium 占着缓存，
 * 有一部分删不掉；这里在"还没人占用"的启动早期补一刀，真正把空间还回去。
 */
export function runPendingCleanup(): void {
  const marker = pendingCleanupFile();
  let target = "";
  try {
    target = path.resolve(fs.readFileSync(marker, "utf-8").trim());
  } catch {
    return; // 没有待清理项
  }
  if (!target) {
    try {
      fs.unlinkSync(marker);
    } catch {
      /* noop */
    }
    return;
  }

  const current = currentDataDir();
  // 安全阀：不删当前正在用的目录、不删盘根
  if (target === current || path.dirname(target) === target) {
    try {
      fs.unlinkSync(marker);
    } catch {
      /* noop */
    }
    return;
  }

  try {
    if (target === path.resolve(defaultDataDir())) {
      // 默认目录里放着指针文件，走保留指针的清空逻辑
      clearDataDir(target);
    } else if (fs.existsSync(target)) {
      fs.rmSync(target, { recursive: true, force: true });
    }
    if (!fs.existsSync(target)) fs.unlinkSync(marker);
  } catch {
    /* 这次没删干净就留给下次启动 */
  }
}
