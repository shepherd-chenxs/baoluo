/*
 * SPDX-License-Identifier: GPL-3.0-only
 * Copyright (c) 2026 宝螺 / Baoluo contributors
 * 本文件属于「宝螺 / Baoluo」。除 GPL-3.0 外还适用 ADDITIONAL_TERMS.md 里的附加条款：
 * 分发时须保留来源署名；修改版对外分发时不得沿用「宝螺」名称与图标。
 */
/**
 * 成片方案落盘：%APPDATA%/Baoluo/storyboards/<id>/
 *   draft.json   # Storyboard
 *   shots/       # 用户拖入的图片副本
 */
import { app, shell } from "electron";
import fs from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { sniffRasterImageExt } from "../../shared/image-magic";
import type {
  AiStoryboardDraft,
  HotItem,
  Shot,
  Storyboard,
  StoryboardSummary,
} from "../../shared/storyboard-types";
import type { VideoResolution } from "../../shared/dialogue-types";

const IMAGE_EXTS = [".jpg", ".jpeg", ".png", ".webp", ".bmp"];

function rootDir(): string {
  return path.join(app.getPath("userData"), "storyboards");
}

function boardDir(id: string): string {
  return path.join(rootDir(), id);
}

function draftPath(id: string): string {
  return path.join(boardDir(id), "draft.json");
}

function shotsDir(id: string): string {
  return path.join(boardDir(id), "shots");
}

function assertId(id: string): void {
  if (!/^[a-zA-Z0-9_-]+$/.test(id)) {
    throw new Error("非法的方案 id。");
  }
}

function readDraft(id: string): Storyboard {
  assertId(id);
  const p = draftPath(id);
  if (!fs.existsSync(p)) throw new Error("方案不存在或已被删除。");
  const raw = JSON.parse(fs.readFileSync(p, "utf-8")) as Storyboard;
  if (!raw || typeof raw !== "object" || !Array.isArray(raw.shots)) {
    throw new Error("方案文件已损坏。");
  }
  return raw;
}

function writeDraft(sb: Storyboard): Storyboard {
  assertId(sb.id);
  fs.mkdirSync(shotsDir(sb.id), { recursive: true });
  sb.updatedAt = Date.now();
  fs.writeFileSync(draftPath(sb.id), JSON.stringify(sb, null, 2), "utf-8");
  return sb;
}

export function newShot(): Shot {
  return {
    id: randomUUID(),
    caption: "",
    imagePrompt: "",
    imagePath: null,
    motion: { mode: "zoom-in", amount: 25 },
  };
}

export function createStoryboard(
  draft: AiStoryboardDraft,
  sourceHot?: HotItem | null,
  resolution?: VideoResolution
): Storyboard {
  const now = Date.now();
  const sb: Storyboard = {
    id: randomUUID(),
    title: draft.title,
    hook: draft.hook,
    style: draft.style,
    ...(draft.trigger ? { trigger: draft.trigger } : {}),
    resolution: resolution ?? "portrait",
    ...(sourceHot ? { sourceHot } : {}),
    shots: draft.shots.map((s) => ({
      ...newShot(),
      caption: s.caption,
      imagePrompt: s.imagePrompt,
      durationHint: s.durationHint,
    })),
    createdAt: now,
    updatedAt: now,
  };
  return writeDraft(sb);
}

export function listStoryboards(): StoryboardSummary[] {
  const root = rootDir();
  if (!fs.existsSync(root)) return [];
  const out: StoryboardSummary[] = [];
  for (const name of fs.readdirSync(root)) {
    const p = path.join(root, name);
    if (!fs.statSync(p).isDirectory()) continue;
    try {
      const sb = readDraft(name);
      out.push({
        id: sb.id,
        title: sb.title || "未命名方案",
        createdAt: sb.createdAt,
        updatedAt: sb.updatedAt,
        shotCount: sb.shots.length,
        filledCount: sb.shots.filter((s) => s.imagePath).length,
        // 列表上要能一眼看出哪几份已经渲染过成片
        hasVideo: !!sb.lastVideoPath,
      });
    } catch {
      /* 目录损坏/空目录不展示 */
    }
  }
  return out.sort((a, b) => b.updatedAt - a.updatedAt);
}

export function getStoryboard(id: string): Storyboard {
  return readDraft(id);
}

export function saveStoryboard(sb: Storyboard): Storyboard {
  if (!sb?.id || !Array.isArray(sb.shots)) {
    throw new Error("方案数据不完整，无法保存。");
  }
  return writeDraft(sb);
}

export function deleteStoryboard(id: string): void {
  assertId(id);
  const dir = boardDir(id);
  if (fs.existsSync(dir)) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

function copyImageInto(dir: string, src: string): string {
  const ext = path.extname(src).toLowerCase();
  if (!IMAGE_EXTS.includes(ext)) {
    throw new Error("只支持 jpg / png / webp / bmp 图片。");
  }
  if (!fs.existsSync(src)) {
    throw new Error("图片文件不存在：请确认原始文件没有被移动或删除。");
  }
  const base = path.basename(src).replace(/[^\w.-]/g, "_");
  const destName = `${Date.now()}-${Math.floor(Math.random() * 10000)}${base || ext}`;
  const dest = path.join(dir, destName);
  fs.copyFileSync(src, dest);
  return dest;
}

export function attachShotImage(id: string, shotId: string, srcPath: string): Storyboard {
  const sb = readDraft(id);
  const shot = sb.shots.find((s) => s.id === shotId);
  if (!shot) throw new Error("镜头不存在，请刷新后重试。");
  const dir = shotsDir(id);
  fs.mkdirSync(dir, { recursive: true });
  const dest = copyImageInto(dir, srcPath);
  shot.imagePath = dest;
  return writeDraft(sb);
}

/**
 * 把内存里的图片字节存成镜头图（T-002 一键生图用）。
 *
 * 扩展名不靠调用方传（那只是从 URL 猜的），一律按字节魔数定；
 * 认不出位图就直接报错，绝不把占位图绑到镜头上。
 * 存完立刻写 draft.json，所以刷新方案后绑定仍在。
 */
export function attachShotImageBytes(
  id: string,
  shotId: string,
  base64: string
): Storyboard {
  const sb = readDraft(id);
  const shot = sb.shots.find((s) => s.id === shotId);
  if (!shot) throw new Error("镜头不存在，请刷新后重试。");
  if (!base64) throw new Error("图片内容为空，无法保存。");

  /*
   * 存盘前的最后一道闸：字节必须真的是位图。
   * 上游（抓图那一侧）已经判过一次，这里再判一次，是为了让「占位图被绑到镜头上」
   * 这种事在数据层就不可能发生——宁可报错让用户重试，也不要留下一张显示不出来的破图。
   */
  const bytes = Buffer.from(base64, "base64");
  const realExt = sniffRasterImageExt(bytes);
  if (!realExt) {
    throw new Error("抓回来的不是图片（可能抓到了加载占位图），请重试一次。");
  }

  const dir = shotsDir(id);
  fs.mkdirSync(dir, { recursive: true });
  // 扩展名以字节为准（上游传进来的 ext 只是从 URL 猜的，可能不符）
  const destName = `${Date.now()}-${Math.floor(Math.random() * 10000)}${realExt}`;
  const dest = path.join(dir, destName);
  fs.writeFileSync(dest, bytes);

  // 落盘后再确认文件真的在、且不是 0 字节，避免把坏数据绑到镜头上
  const st = fs.statSync(dest);
  if (!st.isFile() || st.size === 0) {
    try {
      fs.unlinkSync(dest);
    } catch {
      /* noop */
    }
    throw new Error("图片保存失败（文件为空），请重试。");
  }

  shot.imagePath = dest;
  return writeDraft(sb);
}

export async function openStoryboardDir(
  id: string
): Promise<{ ok: boolean; path: string; error?: string }> {
  const dir = boardDir(id);
  assertId(id);
  if (!fs.existsSync(dir)) return { ok: false, path: dir, error: "方案目录不存在。" };
  const err = await shell.openPath(dir);
  return err ? { ok: false, path: dir, error: err } : { ok: true, path: dir };
}
