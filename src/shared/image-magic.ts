/*
 * SPDX-License-Identifier: GPL-3.0-only
 * Copyright (c) 2026 宝螺 / Baoluo contributors
 * 本文件属于「宝螺 / Baoluo」。除 GPL-3.0 外还适用 ADDITIONAL_TERMS.md 里的附加条款：
 * 分发时须保留来源署名；修改版对外分发时不得沿用「宝螺」名称与图标。
 */
/**
 * 位图魔数识别（主进程共用）。
 *
 * 为什么需要它：光看 URL 后缀和 img 的 naturalWidth 判断不了一张图是不是真的位图。
 * 第三方生图服务出图前有时会挂 SVG 占位图，尺寸属性可以是 1520x2720，URL 也可能带 .png，
 * 但它根本不是位图——存进镜头就是一张显示不出来的破图（实测踩过）。
 */

/** 支持的位图扩展名，与 storyboard/store.ts 的 IMAGE_EXTS 对齐 */
export const RASTER_EXTS = [".png", ".jpg", ".webp", ".bmp"] as const;

/** 按字节魔数认位图；不是位图（如 SVG / HTML / 空）返回 null */
export function sniffRasterImageExt(buf: Buffer): string | null {
  if (buf.length < 26) return null;
  // PNG: 89 50 4E 47
  if (buf[0] === 0x89 && buf[1] === 0x50 && buf[2] === 0x4e && buf[3] === 0x47) return ".png";
  // JPEG: FF D8 FF
  if (buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) return ".jpg";
  // BMP: 'BM'
  if (buf[0] === 0x42 && buf[1] === 0x4d) return ".bmp";
  // WEBP: 'RIFF' .... 'WEBP'
  if (buf.toString("ascii", 0, 4) === "RIFF" && buf.toString("ascii", 8, 12) === "WEBP")
    return ".webp";
  return null;
}
