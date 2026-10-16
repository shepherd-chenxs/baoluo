/*
 * SPDX-License-Identifier: GPL-3.0-only
 * Copyright (c) 2026 宝螺 / Baoluo contributors
 * 本文件属于「宝螺 / Baoluo」。除 GPL-3.0 外还适用 ADDITIONAL_TERMS.md 里的附加条款：
 * 分发时须保留来源署名；修改版对外分发时不得沿用「宝螺」名称与图标。
 */
/**
 * 内置对话模板：应用自带的一套「开箱即用」配置，不占用户的模板库。
 *
 * 为什么硬编码而不是往模板库里塞一条：
 *   它要"只能用、不能删、不能改"。存进用户数据就得在主进程加一堆保护逻辑，
 *   而保护逻辑总有绕过的缝（改文件、删目录）。不存就没有这个问题——
 *   它根本不是用户数据，是应用资产，模板库只是把它显示出来。
 *
 * 音色跟随「设置」：不写死音色，读设置里那套默认值。用户改了默认音色，
 * 内置模板跟着变，不会出现"我明明改了它还是老音色"的困惑。
 *
 * 两张人物形象图随包分发（electron-builder 的 extraResources → template-assets），
 * 首次用到时复制到用户数据目录：合成链路要的是稳定的绝对路径，
 * 而打包后 resources 目录的位置和 dev 下不一样，复制一份最省心。
 */
import fs from "node:fs";
import path from "node:path";
import { app } from "electron";
import type { TemplateConfig } from "../../shared/dialogue-types";
import * as settings from "../dialogue/settings";

/** 内置模板在界面上的标识（模板库里用它区分"这份是内置的"） */
export const BUILTIN_TEMPLATE_ID = "__builtin__";
export const BUILTIN_TEMPLATE_NAME = "默认对话（内置）";

/** 随包分发的形象图：dev 在项目 resources/ 下，打包后在 resources/template-assets/ */
function bundledAssetPath(file: string): string {
  const dev = path.join(app.getAppPath(), "resources", "template-assets", file);
  if (fs.existsSync(dev)) return dev;
  return path.join(process.resourcesPath, "template-assets", file);
}

/** 复制到用户数据目录的落点（每个用户一份，合成链路直接读这里） */
function userAssetPath(file: string): string {
  return path.join(app.getPath("userData"), "template-assets", file);
}

/**
 * 确保形象图在用户数据目录里就位，返回可用路径。
 * 已存在就复用（用户换了图也不该被覆盖）；复制失败返回空串（配置里不带图，合成时再提示选图）。
 */
function ensureAsset(file: string): string {
  const dest = userAssetPath(file);
  try {
    if (fs.existsSync(dest) && fs.statSync(dest).size > 0) return dest;
    const src = bundledAssetPath(file);
    if (!fs.existsSync(src)) return "";
    fs.mkdirSync(path.dirname(dest), { recursive: true });
    fs.copyFileSync(src, dest);
    return dest;
  } catch {
    return "";
  }
}

/**
 * 内置模板的完整配置。音色/语速跟随设置，运镜用推近 25%（跟「对话模式」页的出厂默认一致）。
 * 每次调用都重新读设置——用户在设置页改了音色，下次建卡就生效。
 */
export function builtinTemplateConfig(): TemplateConfig {
  const s = settings.getSettings();
  return {
    imageFortune: ensureAsset("tpl-role-a.png") || null,
    imageCustomer: ensureAsset("tpl-role-b.png") || null,
    images: [],
    narratorCount: s.narratorCount ?? 2,
    resolution: "portrait",
    imageFit: "cover",
    motionMode: "zoom-in",
    motionAmount: 25,
    motionRoleA: { mode: "zoom-in", amount: 25 },
    motionRoleB: { mode: "zoom-in", amount: 25 },
    motionPerImage: false,
    imageMotions: [],
    voices: {
      voiceFortune: s.voiceFortune,
      voiceCustomer: s.voiceCustomer,
      voiceNarrator: s.voiceNarrator,
      prosody: s.prosody,
    },
  };
}

/** 内置模板在模板库列表里的摘要（跟用户模板同一套写法，界面不区分来源） */
export function builtinTemplateSummary(): string {
  const cfg = builtinTemplateConfig();
  const dir = cfg.resolution === "landscape" ? "横屏" : "竖屏";
  return `${cfg.voices.voiceFortune} / ${cfg.voices.voiceCustomer} · ${dir} · 运镜 推近 / 推近 · 含内置形象图`;
}
