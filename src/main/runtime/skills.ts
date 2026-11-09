/**
 * 技能（Skill）—— 运行时能"学到"的额外说明。
 *
 * 形态刻意做得最轻：`%APPDATA%/Baoluo/skills/<名字>/SKILL.md`，一份 Markdown。
 * 前半段可选的 front matter 写 name / description，正文就是给运行时看的补充规则
 * （比如"这个用户习惯竖版 9:16，脚本别超过 40 字一句"）。
 *
 * 为什么不做安装器/市场：技能本质是提示词，装 = 放一份文件进去。
 * 界面上只提供「打开技能目录」，用户自己拖进去，识别一次就生效。
 */
import { app } from "electron";
import fs from "node:fs";
import path from "node:path";
import type { RuntimeSkill } from "../../shared/runtime-types";

/** 单份技能进提示词的上限：技能是补充，不该把主提示词挤掉 */
const PER_SKILL_CHARS = 1_200;
/** 全部技能进提示词的上限 */
const TOTAL_SKILL_CHARS = 6_000;

export function skillsDir(): string {
  return path.join(app.getPath("userData"), "skills");
}

function parseFrontMatter(text: string): { meta: Record<string, string>; body: string } {
  const m = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?/.exec(text);
  if (!m) return { meta: {}, body: text };
  const meta: Record<string, string> = {};
  for (const line of m[1].split(/\r?\n/)) {
    const kv = /^\s*([A-Za-z_][\w-]*)\s*:\s*(.*)$/.exec(line);
    if (!kv) continue;
    meta[kv[1]] = kv[2].replace(/^["']|["']$/g, "").trim();
  }
  return { meta, body: text.slice(m[0].length) };
}

function firstParagraph(body: string): string {
  const clean = body
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter((l) => l && !l.startsWith("#") && !l.startsWith(">"));
  return clean[0] ?? "";
}

function readSkill(dirName: string, file: string): RuntimeSkill {
  let text = "";
  try {
    text = fs.readFileSync(file, "utf-8");
  } catch {
    /* 读不到就当空文件，名字还用目录名 */
  }
  const { meta, body } = parseFrontMatter(text);
  return {
    key: dirName,
    name: (meta.name || dirName).slice(0, 60),
    description: (meta.description || firstParagraph(body) || "（没有写说明）").slice(0, 120),
    path: file,
  };
}

/** 列出技能目录下所有「子目录/SKILL.md」；目录不存在返回空数组（不主动创建） */
export function listSkills(): RuntimeSkill[] {
  const root = skillsDir();
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(root, { withFileTypes: true });
  } catch {
    return [];
  }
  const out: RuntimeSkill[] = [];
  for (const ent of entries) {
    if (!ent.isDirectory()) continue;
    const dir = path.join(root, ent.name);
    let names: string[] = [];
    try {
      names = fs.readdirSync(dir);
    } catch {
      continue;
    }
    const md = names.find((n) => n.toLowerCase() === "skill.md");
    if (!md) continue;
    out.push(readSkill(ent.name, path.join(dir, md)));
  }
  return out.sort((a, b) => a.name.localeCompare(b.name, "zh-CN"));
}

/** 技能正文拼成提示词的一段（没有技能就返回空串） */
export function skillPromptText(): string {
  const root = skillsDir();
  const blocks: string[] = [];
  let used = 0;
  for (const skill of listSkills()) {
    let body = "";
    try {
      body = parseFrontMatter(fs.readFileSync(skill.path, "utf-8")).body.trim();
    } catch {
      continue;
    }
    if (!body) continue;
    const block = `### 技能：${skill.name}\n${body.slice(0, PER_SKILL_CHARS)}`;
    if (used + block.length > TOTAL_SKILL_CHARS) break;
    used += block.length;
    blocks.push(block);
  }
  if (!blocks.length) return "";
  return `\n\n【用户装的技能（优先遵守）】\n${blocks.join("\n\n")}`;
}

/** 确保技能目录存在（点「打开技能目录」时调用） */
export function ensureSkillsDir(): string {
  const dir = skillsDir();
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}
