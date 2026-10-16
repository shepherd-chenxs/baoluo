/*
 * SPDX-License-Identifier: GPL-3.0-only
 * Copyright (c) 2026 宝螺 / Baoluo contributors
 * 本文件属于「宝螺 / Baoluo」。除 GPL-3.0 外还适用 ADDITIONAL_TERMS.md 里的附加条款：
 * 分发时须保留来源署名；修改版对外分发时不得沿用「宝螺」名称与图标。
 */
/**
 * dialogue_parser — 把统一脚本解析为结构化 DialogueLine。
 *
 * 脚本里可以混用两种行：
 *   1. 场景标签：「#图1」「图1：」「图2」——切换当前图片（1 起编号），
 *      后面跟的台词（若有）算该图下的第一句。
 *   2. 台词行（仅对话模式）：「名字：内容」（中英文冒号都行），任意角色名。
 *      按出现顺序，第一个说话人 = 角色 a，第二个不同说话人 = 角色 b，
 *      第三个及之后的说话人标记为 unknown。
 *      没有名字的纯文本行 = 默认解说员（unknown，speaker 为空）。
 *   续行（无 speaker 前缀、且不是场景标签）会拼到上一句。
 *
 * 解说模式（图文解说）**不解析角色名**：音色由每个镜头的解说员配置决定，
 * 所以整行都当文案，打了什么就念什么（冒号也照念）。
 */
import type { DialogueLine, SpeakerType, VideoMode } from "../../shared/dialogue-types";

export interface ParseOptions {
  /** 影响校验规则；缺省按对话模式 */
  mode?: VideoMode;
  /** 图片数量，用于校验 图N 是否越界 */
  imageCount?: number;
}

export class DialogueParser {
  private readonly _linePattern = /^(.+?)\s*[：:]\s*(.*)/;
  /** 场景标签：可选 # 前缀，图 + 数字，后接可选冒号和可选解说词 */
  private readonly _scenePattern = /^#?\s*图\s*(\d+)\s*[：:]?\s*(.*)$/;

  /** 按出现顺序把前两个不同说话人映射为 a/b，其余为 unknown */
  private makeTypeResolver(): (rawName: string) => SpeakerType {
    const order: string[] = [];
    return (rawName: string): SpeakerType => {
      const key = rawName.trim().toLowerCase();
      if (!key) return "unknown";
      const idx = order.indexOf(key);
      if (idx >= 0) return idx === 0 ? "a" : idx === 1 ? "b" : "unknown";
      if (order.length >= 2) return "unknown";
      order.push(key);
      return order.length === 1 ? "a" : "b";
    };
  }

  parse(text: string, _opts: ParseOptions = {}): DialogueLine[] {
    const rawLines = text.trim().split(/\r?\n/).filter((l) => l.trim().length);
    if (!rawLines.length) return [];

    const isNarration = _opts.mode === "narration";
    const typeFor = this.makeTypeResolver();
    const out: DialogueLine[] = [];
    let idx = 0;
    let curScene: number | undefined;
    for (const raw of rawLines) {
      const stripped = raw.trim();
      const sc = this._scenePattern.exec(stripped);
      if (sc) {
        curScene = parseInt(sc[1], 10) - 1;
        const rest = sc[2].trim();
        if (rest) {
          // 「图1：角色名：内容」时把角色名解析出来；解说模式不解析（整段都算文案）
          const m2 = isNarration ? null : this._linePattern.exec(rest);
          if (m2) {
            const speaker = m2[1].trim();
            out.push({
              speaker,
              speakerType: typeFor(speaker),
              text: m2[2].trim(),
              index: idx++,
              sceneId: curScene,
            });
          } else {
            out.push({ speaker: "", speakerType: "unknown", text: rest, index: idx++, sceneId: curScene });
          }
        }
        continue;
      }
      // 解说模式不解析「角色名：」前缀：音色看镜头配置，文案原样朗读
      const m = isNarration ? null : this._linePattern.exec(stripped);
      if (m) {
        const speaker = m[1].trim();
        const content = m[2].trim();
        out.push({ speaker, speakerType: typeFor(speaker), text: content, index: idx++, sceneId: curScene });
      } else if (!isNarration && out.length) {
        // 对话模式：无前缀的行续到上一句；解说模式：换行即新解说段
        out[out.length - 1].text += "\n" + stripped;
      } else {
        out.push({ speaker: "", speakerType: "unknown", text: stripped, index: idx++, sceneId: curScene });
      }
    }
    for (const line of out) line.text = line.text.trim();
    return out;
  }

  /** 返回警告/错误信息数组。空数组 = 无问题。 */
  validate(lines: DialogueLine[], opts: ParseOptions = {}): string[] {
    const warnings: string[] = [];
    if (!lines.length) {
      warnings.push("脚本为空，请输入对话内容。");
      return warnings;
    }

    if (opts.mode === "narration") {
      if (!lines.some((l) => l.text.trim())) {
        warnings.push("没有可朗读的解说词，请输入内容。");
        return warnings;
      }
      if (opts.imageCount) {
        for (const l of lines) {
          if (l.sceneId !== undefined && l.sceneId >= opts.imageCount) {
            warnings.push(`图${l.sceneId + 1} 超出图片数量（当前 ${opts.imageCount} 张），请检查脚本。`);
          }
        }
      }
      // 解说模式不解析角色名（音色看镜头配置），整行照念，所以这里没有角色相关提示
      return warnings;
    }

    const hasA = lines.some((l) => l.speakerType === "a");
    const hasB = lines.some((l) => l.speakerType === "b");
    if (!hasA) warnings.push("未检测到甲方（脚本第一句的说话人）。");
    if (!hasB) warnings.push("未检测到乙方。请至少用两个不同说话人，格式：名字：内容");
    const unknowns = lines.filter((l) => l.speakerType === "unknown").length;
    if (unknowns > 0) {
      warnings.push(`有 ${unknowns} 行无法归属到甲方/乙方，将按甲方处理。`);
    }
    return warnings;
  }
}
