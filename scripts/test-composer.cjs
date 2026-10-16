/*
 * SPDX-License-Identifier: GPL-3.0-only
 * Copyright (c) 2026 宝螺 / Baoluo contributors
 * 本文件属于「宝螺 / Baoluo」。除 GPL-3.0 外还适用 ADDITIONAL_TERMS.md 里的附加条款：
 * 分发时须保留来源署名；修改版对外分发时不得沿用「宝螺」名称与图标。
 */
/**
 * 字幕排布与镜头转场的回归用例（不需要 Electron，直接跑 Node）。
 *
 *   npm run test:composer
 *
 * 守三条真机缺陷（2026-10-05 用户报）：
 *   1) 镜头之间的 xfade offset 必须**累加**：老实现从第 3 段起少了第 2 段的时长，
 *      后一段被提前插进来，把第 2 镜的画面和第 2 句字幕整段盖掉（实测成片里第 2 句字幕看不到）；
 *   2) 一行字幕的字数要按画面宽度算：竖屏 1080、字号 50 时一行只放得下约 19 字，
 *      老实现固定 30 字 → 字幕左右被裁（实测「字幕在竖屏时没有显示完」）；
 *   3) 排在本段画面之外的字幕（cues 末尾常超出音频长度）不许丢字，要并进上一条。
 */
const path = require("node:path");
const fs = require("node:fs");

const ROOT = path.join(__dirname, "..");
const composer = require(path.join(ROOT, "dist", "main", "dialogue", "composer.js"));
const { crossfadeOffsets, crossfadeDuration, maxCharsPerLine, splitSubtitleText, buildSubtitleEntries, writeAssFile } =
  composer;

let failures = 0;
function check(ok, label, extra = "") {
  console.log(`${ok ? "PASS" : "FAIL"}  ${label}${extra ? " — " + extra : ""}`);
  if (!ok) failures++;
}
const eq = (a, b) => JSON.stringify(a) === JSON.stringify(b);

// ---------- 1) xfade offset 累加 ----------
{
  const audio = [5.9, 6.7, 6.9, 5.8, 6.6];
  const f = 0.5;
  const offs = crossfadeOffsets(audio, f);
  const sum = audio.reduce((a, b) => a + b, 0);
  const expect = [];
  let cum = audio[0];
  for (let i = 1; i < audio.length; i++) {
    expect.push(Number((cum - f).toFixed(3)));
    cum += audio[i] - f;
  }
  check(
    eq(offs.map((n) => Number(n.toFixed(3))), expect),
    "offset 按累加算（第 k 次 = 链上长度 − 淡化时长）",
    JSON.stringify(offs.map((n) => Number(n.toFixed(3))))
  );
  check(
    offs.length === audio.length - 1,
    "n 段有 n-1 个 offset",
    `${offs.length}`
  );
  const total = offs[offs.length - 1] + audio[audio.length - 1];
  check(
    Math.abs(total - (sum - (audio.length - 1) * f)) < 0.001,
    "成片总长 = 各段音频之和 − (n−1)×淡化时长",
    `${total.toFixed(3)} vs ${(sum - (audio.length - 1) * f).toFixed(3)}`
  );
  // 老实现的错法：offset_k = a1 − k×f（少了第 2 段的时长）——必须显著不同
  const old = audio.map((_, i) => audio[0] - (i + 1) * f).slice(0, audio.length - 1);
  check(
    !eq(offs.map((n) => Number(n.toFixed(2))), old.map((n) => Number(n.toFixed(2)))),
    "不再复现老实现的错误 offset（否则第 3 段起会提前盖住前一段）",
    `新=${JSON.stringify(offs.map((n) => Number(n.toFixed(2))))} 老=${JSON.stringify(old.map((n) => Number(n.toFixed(2))))}`
  );
  // 每一段都不许与前一段重叠（相邻 offset 间距应 >= 前一段音频 − 淡化时长）
  let ok = true;
  for (let i = 1; i < offs.length; i++) {
    if (offs[i] - offs[i - 1] < audio[i] - f - 0.001) ok = false;
  }
  check(ok, "相邻两段的插入位置不重叠（后一段不会盖住前一段）", JSON.stringify(offs.map((n) => Number(n.toFixed(2)))));
}

// ---------- 1.5) 淡化时长：极短旁白不许把镜头吃掉 ----------
{
  /*
   * 守一个真机现象（2026-10-06 实测）：旁白只有 1 秒左右时，
   * 老实现把淡化算成「最短旁白的一半」（约 0.47 秒）→ xfade 的 offset 只有 0.51 秒，
   * 1.28 秒的第 1 镜画面只露 0.51 秒、其中 0.47 秒还在淡化里，等于一闪而过。
   * 现在收紧到「最短旁白的 1/4」：淡化最晚从旁白走完 3/4 处才开始。
   */
  const normal = crossfadeDuration([9.2, 8.8], 0.5);
  check(normal === 0.5, "正常旁白（9 秒）：淡化仍是设置的 0.5 秒，行为不变", `${normal}`);

  const short = crossfadeDuration([0.98, 0.98], 0.5);
  check(
    Math.abs(short - 0.98 / 4) < 0.001,
    "极短旁白（1 秒）：淡化收紧到 1/4（约 0.25 秒），不再占掉半镜",
    `${short}`
  );

  const offsShort = crossfadeOffsets([0.98, 0.98], short);
  check(
    offsShort[0] > 0.7,
    "极短旁白：第 2 镜至少等到旁白走完 3/4 才插进来",
    `offset=${offsShort[0].toFixed(2)}s（老实现约 0.51s）`
  );

  const tiny = crossfadeDuration([0.3, 0.3], 0.5);
  check(tiny === 0.1, "旁白极短（0.3 秒）：淡化兜底 0.1 秒，不会算出 0", `${tiny}`);

  check(
    crossfadeDuration([2, 2], 0.5) <= crossfadeDuration([8, 8], 0.5),
    "旁白越长，淡化越不受限制（单调不减）"
  );
  check(crossfadeDuration([], 0.5) === 0.5, "没有片段时按设置值返回，不抛错");
}

// ---------- 2) 一行放几个字 ----------
{
  const portrait = maxCharsPerLine(1080, 50);
  const landscape = maxCharsPerLine(1920, 50);
  check(portrait === 19, "竖屏 1080 + 字号 50 → 一行 19 字", `${portrait}`);
  check(landscape === 35, "横屏 1920 + 字号 50 → 一行 35 字", `${landscape}`);
  check(maxCharsPerLine(1080, 90) < portrait, "字号越大一行越少", `${maxCharsPerLine(1080, 90)}`);
  check(maxCharsPerLine(300, 50) >= 6, "极窄画面也至少给 6 字，不会算出 0", `${maxCharsPerLine(300, 50)}`);
}

// ---------- 3) 长句拆分：不超行宽、不丢字 ----------
{
  const text = "18岁坐硬座去拉萨，40小时不觉得累，下车时风一吹，整个人都在发光。";
  const parts = splitSubtitleText(text, 19);
  check(
    parts.every((p) => [...p].length <= 19),
    "按文本拆分时每段都不超过行宽",
    JSON.stringify(parts.map((p) => [...p].length))
  );
  check(
    parts.join("") === text,
    "拆分不丢字（拼回去与原句一致）",
    JSON.stringify(parts)
  );
  const def = splitSubtitleText("短句。", 19);
  check(eq(def, ["短句。"]), "短句不拆", JSON.stringify(def));
}

// ---------- 4) 有 cues 的字幕排布 ----------
/** 造一份与 Edge 同形的 cues：每 1~2 个字一个词，每字 160ms */
function makeCues(text, perCharMs = 160) {
  const chars = [...text];
  let t = 100;
  const cues = [];
  for (let i = 0; i < chars.length; ) {
    const step = i + 1 < chars.length && /[，。！？；]/.test(chars[i + 1]) ? 1 : 2;
    const part = chars.slice(i, i + step).join("");
    cues.push({ part, start: t, end: t + perCharMs * step });
    t += perCharMs * step;
    i += step;
  }
  return cues;
}
{
  const text = "18岁坐硬座去拉萨，40小时不觉得累，下车时风一吹，整个人都在发光。";
  const durationSec = 5.5; // 比 cues 末尾（约 5.4s+）短一点，模拟「尾巴排到画面外」
  const entries = buildSubtitleEntries(
    { seg: { text, audioPath: "x.mp3", imagePath: "x.png", cues: makeCues(text) }, durationSec },
    { maxChars: 19 }
  );
  check(entries.length >= 2, "长句切成多条字幕", `${entries.length} 条`);
  check(
    entries.every((e) => [...e.text].length <= 19),
    "每条字幕都不超过行宽（不再出现被裁的 30 字长条）",
    JSON.stringify(entries.map((e) => [...e.text].length))
  );
  check(
    entries.every((e) => e.startSec < durationSec && e.endSec <= durationSec + 0.001),
    "没有排在画面之外的字幕（老实现里最后一条 6.06s 起、整条看不到）",
    JSON.stringify(entries.map((e) => [Number(e.startSec.toFixed(2)), Number(e.endSec.toFixed(2))]))
  );
  check(
    entries.map((e) => e.text).join("") === text,
    "所有字都在（排到段外的那半句并进上一条，不丢字）",
    JSON.stringify(entries.map((e) => e.text))
  );
  const mono = entries.every((e, i) => i === 0 || e.startSec >= entries[i - 1].startSec);
  check(mono, "字幕按时间顺序排列");
}

// ---------- 5) ass 文件本身 ----------
{
  const out = path.join(ROOT, "tmp", "composer-test.ass");
  fs.mkdirSync(path.dirname(out), { recursive: true });
  writeAssFile({
    outPath: out,
    entries: [
      { text: "第一句字幕。", startSec: 0.1, endSec: 1.5 },
      { text: "第二句字幕。", startSec: 1.6, endSec: 3.0 },
    ],
    fontPath: "C:/Windows/Fonts/msyh.ttc",
    fontSize: 50,
    textColor: "#FFFFFF",
    backgroundColor: "transparent",
    backgroundOpacity: 0,
    positionPct: 0.85,
    width: 1080,
    height: 1920,
  });
  const ass = fs.readFileSync(out, "utf-8");
  check(/WrapStyle: 2/.test(ass), "ass 用 WrapStyle 2（中文长句允许在任意字间断行）", ass.match(/WrapStyle: \d/)?.[0] ?? "");
  check(/PlayResX: 1080/.test(ass) && /PlayResY: 1920/.test(ass), "PlayRes 与成片分辨率一致");
  check(
    (ass.match(/^Dialogue: /gm) || []).length === 2,
    "两条字幕都写进了 Events",
    `${(ass.match(/^Dialogue: /gm) || []).length}`
  );
  // 样式行是位置参数：…,Alignment,MarginL,MarginR,MarginV,Encoding
  const style = (ass.match(/^Style: .*$/m) || [""])[0].split(",").map((s) => s.trim());
  const marginV = Number(style[style.length - 2]);
  const expectV = Math.round(1920 * (1 - 0.85) - 20);
  check(
    marginV === expectV,
    "字幕位置由 positionPct 换算成 MarginV",
    `MarginV=${marginV} 期望=${expectV}`
  );
  check(style[style.length - 4] === "40" && style[style.length - 3] === "40", "左右边距 40（与 maxCharsPerLine 用的是同一组边距）");
}

console.log(failures ? `\n${failures} 项未通过` : "\n全部通过");
process.exit(failures ? 1 : 0);
