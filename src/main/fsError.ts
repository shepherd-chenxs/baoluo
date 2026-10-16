/*
 * SPDX-License-Identifier: GPL-3.0-only
 * Copyright (c) 2026 宝螺 / Baoluo contributors
 * 本文件属于「宝螺 / Baoluo」。除 GPL-3.0 外还适用 ADDITIONAL_TERMS.md 里的附加条款：
 * 分发时须保留来源署名；修改版对外分发时不得沿用「宝螺」名称与图标。
 */
/**
 * 把文件系统错误翻译成用户能看懂的中文。
 *
 * 默认输出目录/素材目录是写死的 C 盘路径；如果用户没有写权限（或磁盘满了），
 * 直接把 EACCES/EPERM 抛给界面只会看到一串英文，这里统一提示"没权限，请改目录"。
 */
export function describeFsError(err: unknown, target: string, fieldLabel: string): Error {
  const code = (err as NodeJS.ErrnoException | undefined)?.code;
  if (code === "EACCES" || code === "EPERM") {
    return new Error(
      `没有权限写入 ${target}。请在「设置 → 通用设置」里把「${fieldLabel}」改到有写权限的目录（例如 D 盘）后重试。`
    );
  }
  if (code === "ENOSPC") {
    return new Error(`磁盘空间不足，无法写入 ${target}。请清理磁盘，或把「${fieldLabel}」改到别的盘。`);
  }
  if (code === "EROFS") {
    return new Error(`目标位置是只读的，无法写入 ${target}。请把「${fieldLabel}」改到可写目录。`);
  }
  return err instanceof Error ? err : new Error(String(err));
}
