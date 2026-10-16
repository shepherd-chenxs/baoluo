/*
 * SPDX-License-Identifier: GPL-3.0-only
 * Copyright (c) 2026 宝螺 / Baoluo contributors
 * 本文件属于「宝螺 / Baoluo」。除 GPL-3.0 外还适用 ADDITIONAL_TERMS.md 里的附加条款：
 * 分发时须保留来源署名；修改版对外分发时不得沿用「宝螺」名称与图标。
 */
const { DialogueParser } = require("../dist/main/dialogue/parser.js");
const { splitSubtitleText, buildSubtitleEntries } = require("../dist/main/dialogue/composer.js");

const p = new DialogueParser();
let fail = 0;
function check(name, cond) {
  console.log(`${cond ? "PASS" : "FAIL"}  ${name}`);
  if (!cond) fail++;
}

// 1. 对话模式原有行为
const d = p.parse("甲：你好。\n乙：你好呀。\n甲：最近怎么样？");
check("dialogue: 3 lines", d.length === 3);
check("dialogue: a/b/a", d[0].speakerType === "a" && d[1].speakerType === "b" && d[2].speakerType === "a");

// 2. 多图解说：图标签 + 角色名 + 默认解说员
const n = p.parse(
  `#图1
解说员A：先看第一张图。
解说员B：注意细节。
这里不写角色名，用默认解说员。
#图2
解说员A：再看第二张图。`,
  { mode: "narration" }
);
check("narration: 4 lines", n.length === 4);
check("narration: scene binding", n[0].sceneId === 0 && n[1].sceneId === 0 && n[3].sceneId === 1);
check("narration: default narrator", n[2].speakerType === "unknown" && n[2].speaker === "");
// 解说模式不再解析角色名：整行照念（音色由每个镜头的解说员配置决定）
check(
  "narration: 名称前缀原样保留",
  n[0].speakerType === "unknown" && n[0].text === "解说员A：先看第一张图。"
);

// 3. 图N：内容 一行式
const one = p.parse("图1：这是第一段解说。\n解说员A：补充一下。", { mode: "narration" });
check("inline scene: sceneId 0", one[0].sceneId === 0);
check("inline scene: narrator", one[0].speakerType === "unknown");
check(
  "inline scene: 后续行同场景且原样保留前缀",
  one[1].sceneId === 0 && one[1].text === "解说员A：补充一下。"
);

// 4. 图N：角色名：内容 组合写法
const combo = p.parse("图1：解说员A：这是组合写法。", { mode: "narration" });
check("combo: scene 0", combo[0].sceneId === 0);
check("combo: text 原样保留", combo[0].text === "解说员A：这是组合写法。");

// 5. 越界校验
const warn = p.validate(p.parse("#图5\n解说员A：内容", { mode: "narration" }), {
  mode: "narration",
  imageCount: 2,
});
check("out-of-range warns", warn.some((w) => w.includes("图5")));

// 6. 续行
const cont = p.parse("甲：第一句\n第二句接上", { mode: "dialogue" });
check("continuation", cont.length === 1 && cont[0].text.includes("第二句接上"));

// 7. 对话模式校验仍工作
const dw = p.validate(p.parse("只有一个人：说话"), { mode: "dialogue" });
check("dialogue validate warns missing B", dw.some((w) => w.includes("乙方")));

// 8. 长字幕自动拆条
const short = splitSubtitleText("短句。");
check("short subtitle untouched", short.length === 1 && short[0] === "短句。");
const longS = splitSubtitleText(
  "第一句很长的解说词，讲了好几个意思，用来测试字幕拆分是否合理。第二句也长，继续验证。"
);
check("long subtitle split", longS.length >= 2 && longS.every((s) => [...s].length <= 30));
check("split keeps total text", longS.join("") ===
  "第一句很长的解说词，讲了好几个意思，用来测试字幕拆分是否合理。第二句也长，继续验证。");
const multiLine = splitSubtitleText(
  "第一段。\n第二段这一段文字确实比较长，这里的内容足够多，需要拆成两条甚至更多条字幕，因为已经远远超过了三十个字符的上限了，所以要拆分显示。"
);
check("multiline subtitle", multiLine.length >= 3);

// 9. 词级时间轴（cues）和这一句文本不一致时，字幕不能跟着串行
const okEntries = buildSubtitleEntries({
  seg: {
    text: "卦辞说：有言不信。",
    audioPath: "",
    imagePath: "",
    cues: [
      { part: "卦辞说：", start: 0, end: 500 },
      { part: "有言不信。", start: 500, end: 1300 },
    ],
  },
  durationSec: 1.5,
});
const stripKaraoke = (s) => s.replace(/\{\\k\d+\}/g, "");
check(
  "cues 匹配时用时间轴文本",
  okEntries.length === 1 && stripKaraoke(okEntries[0].text) === "卦辞说：有言不信。"
);

const mismatched = buildSubtitleEntries({
  seg: {
    text: "卦辞说：有言不信。",
    audioPath: "",
    imagePath: "",
    cues: [
      { part: "初六，跌入幽谷。", start: 0, end: 900 },
      { part: "突如其来的失业、项目崩盘，", start: 900, end: 2000 },
    ],
  },
  durationSec: 2.2,
});
const mismatchedText = mismatched.map((e) => e.text).join("");
check(
  "cues 不匹配时退回按文本拆字幕",
  mismatchedText.includes("卦辞说：有言不信。") && !mismatchedText.includes("初六")
);

process.exit(fail ? 1 : 0);
