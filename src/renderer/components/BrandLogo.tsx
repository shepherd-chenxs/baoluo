/*
 * SPDX-License-Identifier: GPL-3.0-only
 * Copyright (c) 2026 宝螺 / Baoluo contributors
 * 本文件属于「宝螺 / Baoluo」。除 GPL-3.0 外还适用 ADDITIONAL_TERMS.md 里的附加条款：
 * 分发时须保留来源署名；修改版对外分发时不得沿用「宝螺」名称与图标。
 */
import brandIconUrl from "../../../build/icon.png";

/** 品牌图标（透明背景 PNG），统一用于各界面入口 */
export default function BrandLogo({ className }: { className?: string }) {
  return (
    <img
      className={className}
      src={brandIconUrl}
      alt=""
      draggable={false}
    />
  );
}
