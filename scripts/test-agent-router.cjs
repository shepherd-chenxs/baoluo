/*
 * SPDX-License-Identifier: GPL-3.0-only
 * Copyright (c) 2026 宝螺 / Baoluo contributors
 * 本文件属于「宝螺 / Baoluo」。除 GPL-3.0 外还适用 ADDITIONAL_TERMS.md 里的附加条款：
 * 分发时须保留来源署名；修改版对外分发时不得沿用「宝螺」名称与图标。
 */
/**
 * 工作台「规则分流器」的回归测试。
 *
 * 分流是 0 token 层的第一道闸：分错了，后面整条链就跑偏。
 * 这里只测纯函数（不碰磁盘、不联网、不启 Electron）。
 *
 * 「素材捕手」（平台链接解析/下载）已删除：本工具只处理用户已有的本地文件。
 * 贴进来的链接只做两件事——抽主题时剔掉它、以及给一句「不能从链接取视频」的明确回应。
 */
const { parseInstruction, extractFilePath, extractTopic } = require("../dist/main/agent/router.js");

let fail = 0;
function check(name, ok, extra) {
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${extra ? ` — ${extra}` : ""}`);
  if (!ok) fail++;
}

// 1. 纯链接 → 不再建下载卡：如实说明"这里不能从链接取视频"
const linkOnly = parseInstruction("https://v.douyin.com/iABCdEf/");
check("纯链接 → unknown（下载意图已删）", linkOnly.intent === "unknown", linkOnly.intent);
check("纯链接 → missing 提示要本地文件", linkOnly.missing.includes("音视频文件"), `missing=${linkOnly.missing.join()}`);
check("纯链接 → 标题说明不能从链接取视频", linkOnly.title.includes("链接") && linkOnly.title.includes("不能"), linkOnly.title);
check("纯链接 → summary 明说不解析不下载", linkOnly.summary.includes("不解析") && linkOnly.summary.includes("不下载"), linkOnly.summary);
check("纯链接 → 不再往 params 里塞链接", linkOnly.params.link === undefined);

// 2. 分享文案：链接只用来剔主题，本身不再触发任何下载链
const shareText =
  "7.68 复制打开抖音，看看【某某的作品】这个方法真的有用 https://v.douyin.com/xyz123/ 嗯";
const shared = parseInstruction(shareText);
check("分享文本（只有链接没有动作）→ unknown", shared.intent === "unknown", shared.intent);
check("分享文本 → params 里没有链接", shared.params.link === undefined);

// 3. 链接 + 「对话」→ 对话视频（链接不再进卡片），并且别把「对话视频」当成主题
const linkDialogue = parseInstruction("把这个链接做成对话视频 https://v.douyin.com/aaa111/");
check("链接+对话 → dialogue-video", linkDialogue.intent === "dialogue-video", linkDialogue.intent);
check("链接+对话 → 链接不再挂到卡片参数上", linkDialogue.params.link === undefined);
check("链接+对话 → 主题留空（交给用户补）", linkDialogue.params.topic === "", `topic="${linkDialogue.params.topic}"`);

// 4. 只给主题 → 写脚本出片
const topicOnly = parseInstruction("对话 事业运");
check("主题 → dialogue-video", topicOnly.intent === "dialogue-video", topicOnly.intent);
check("主题 → 抽到「事业运」", topicOnly.params.topic === "事业运", `topic="${topicOnly.params.topic}"`);
check("主题 → 没有链接", !topicOnly.params.link);
check("主题 → 标题是「主题 → 对话视频」", topicOnly.title === "主题 → 对话视频", topicOnly.title);
check("主题 → summary 里不再出现「下载」字样", !topicOnly.summary.includes("下载"), topicOnly.summary);

// 5. 图文解说优先于对话（「图文解说」四个字里没有「对话」，但顺序仍然不能反）
const narration = parseInstruction("做一条图文解说，讲职场焦虑");
check("图文解说 → narration-video", narration.intent === "narration-video", narration.intent);

// 6. 本地文件 + 变声
const voice = parseInstruction("把 D:\\素材\\口播.mp3 变声，换成晓晓");
check("文件+变声 → voice-convert", voice.intent === "voice-convert", voice.intent);
check("文件+变声 → 路径取到", voice.params.inputPath === "D:\\素材\\口播.mp3", voice.params.inputPath);

// 7. 说了动作但缺输入：不能瞎建卡
const dlWords = parseInstruction("帮我下载一下这个视频 https://v.douyin.com/abc/");
check("说「下载」只给了链接 → unknown（不再有 download）", dlWords.intent === "unknown", dlWords.intent);
check("说「下载」只给了链接 → missing 提示音视频文件", dlWords.missing.includes("音视频文件"), `missing=${dlWords.missing.join()}`);

const bareDownloadWords = parseInstruction("帮我下载一下这个视频");
check("说「下载」连链接都没给 → unknown", bareDownloadWords.intent === "unknown", bareDownloadWords.intent);

const noFile = parseInstruction("帮我变声");
check("缺文件 → unknown", noFile.intent === "unknown", noFile.intent);
check("缺文件 → missing 提示文件", noFile.missing.includes("音视频文件"));

// 8. 光给文件、没说干什么 → 问一句，而不是猜
const fileOnly = parseInstruction("C:\\Users\\me\\Desktop\\test.wav");
check("只有文件 → unknown（先问一句）", fileOnly.intent === "unknown", fileOnly.intent);
check("只有文件 → 路径仍然留下", fileOnly.params.inputPath === "C:\\Users\\me\\Desktop\\test.wav");

// 9. 什么都认不出来 → 给可操作的提示，不要空回答
const empty = parseInstruction("   ");
check("空指令 → unknown + 提示", empty.intent === "unknown" && empty.summary.length > 10);

// 10. 两个纯函数单独兜一下底
check("extractFilePath 不误伤普通句子", extractFilePath("今天天气不错") === null);
check(
  "extractTopic 会丢掉动作词",
  extractTopic("帮我把这条视频下载一下", null, null) === ""
);

// 11. 剧本：一句话 → 步骤列表（顺序错了整条链就跑偏）
//     workflows 会读设置里的默认音色，所以这里把 electron 顶掉，指到临时目录
const os = require("node:os");
const Module = require("node:module");
const origLoad = Module._load;
Module._load = function (request) {
  if (request === "electron") {
    const appStub = new Proxy(
      {
        getPath: () => os.tmpdir(),
        getAppPath: () => os.tmpdir(),
        getVersion: () => "0.0.0-test",
        isPackaged: false,
      },
      {
        // 设置模块还可能顺手问别的（缓存目录之类），一律给个安全的空实现
        get(target, prop) {
          return prop in target ? target[prop] : () => undefined;
        },
      }
    );
    return { app: appStub, net: { fetch: () => Promise.reject(new Error("单测不联网")) } };
  }
  return origLoad.apply(this, arguments);
};

const { buildSteps, createTask } = require("../dist/main/agent/workflows.js");
const kinds = (list) => list.map((s) => s.kind).join(" > ");

// 解析/下载两步已从所有剧本里删掉：对话视频恒定三步
const topicSteps = buildSteps(parseInstruction("对话 事业运"));
check(
  "对话剧本 = 写脚本 → 角色与画面 → 合成",
  kinds(topicSteps) === "write-script > dialogue-config > compose",
  kinds(topicSteps)
);

const linkedDialogueSteps = buildSteps(
  parseInstruction("把这个链接做成对话视频 https://v.douyin.com/abc/")
);
check(
  "带链接的对话剧本也不再解析下载（和只给主题同一条链）",
  kinds(linkedDialogueSteps) === "write-script > dialogue-config > compose",
  kinds(linkedDialogueSteps)
);
check(
  "任何剧本里都不该再出现 parse-link / download 步骤",
  ![...topicSteps, ...linkedDialogueSteps].some((s) => s.kind === "parse-link" || s.kind === "download")
);

const vcSteps = buildSteps(parseInstruction("把 D:\\素材\\口播.mp3 变声"));
check("变声剧本 = 一步到位", kinds(vcSteps) === "voice-convert", kinds(vcSteps));
check(
  "变声那步带上了源文件路径",
  vcSteps[0].params.some((p) => p.key === "inputPath" && p.value === "D:\\素材\\口播.mp3")
);
check(
  "「角色与画面」那步要你选两张人物图",
  linkedDialogueSteps[1].params.filter((p) => p.type === "image").length === 2,
  `第 2 步 = ${linkedDialogueSteps[1]?.kind}`
);
check(
  "合成排最后（跟热点成片的 ③ 一致）",
  kinds(topicSteps).endsWith("compose"),
  kinds(topicSteps)
);

// 12. 热点成片 / 图文解说：同一条链路，能建卡
const narrationTask = createTask("图文解说 职场焦虑");
check("图文解说 → 建卡", narrationTask.task !== null);
check(
  "图文解说剧本 = 内嵌分镜工作台（跟「热点成片」页同一套）",
  kinds(narrationTask.task.steps) === "hot-story",
  kinds(narrationTask.task.steps)
);
check(
  "建卡时的话题会带给工作台预填",
  narrationTask.task.steps[0].params.some((p) => p.key === "topic" && p.value === "职场焦虑")
);
check(
  "「热点」也走同一条链路",
  parseInstruction("按今天的热点写一条成片").intent === "narration-video",
  parseInstruction("按今天的热点写一条成片").intent
);
check(
  "带链接的解说：不再前置解析下载，直接进内嵌工作台",
  kinds(createTask("解说 https://v.douyin.com/aaa/").task.steps) === "hot-story",
  kinds(createTask("解说 https://v.douyin.com/aaa/").task.steps)
);
const withHot = createTask("图文解说 职场焦虑", {
  id: "weibo-1",
  title: "职场焦虑",
  source: "微博",
  rank: 1,
  fetchedAt: Date.now(),
});
check("从榜单点的热点会记下来源（分镜里也看得到）", withHot.task.hot?.id === "weibo-1");

// 13. 认不出来的不建卡（宁可回句话，也不要建一张跑不动的卡）
const gibberish = createTask("???");
check("认不出来的 → 不建卡", gibberish.task === null);
// 只贴链接也不建卡：它只会回一句「这里不能从链接取视频」
check("只贴链接 → 不建卡", createTask("https://v.douyin.com/abc/").task === null);

// 14. @ 点名：输入框里打 @ 弹出的那份名单，点到谁就走谁的剧本
check("@对话 事业运 → dialogue-video", parseInstruction("@对话 事业运").intent === "dialogue-video");
check(
  "@对话 之后的内容才算主题",
  parseInstruction("@对话 事业运").params.topic === "事业运",
  parseInstruction("@对话 事业运").params.topic
);
// @下载 已从点名名单里删掉：带不带链接都到不了 download
check("@下载 + 链接 → 不再是 download", parseInstruction("@下载 https://v.douyin.com/aaa/").intent !== "download");
check(
  "@下载 + 链接 → unknown 且提示缺本地文件",
  parseInstruction("@下载 https://v.douyin.com/aaa/").missing.includes("音视频文件"),
  parseInstruction("@下载 https://v.douyin.com/aaa/").intent
);
check("@下载 孤零零一句 → unknown（没有这个点名了）", parseInstruction("@下载").intent === "unknown");
check("@图文 职场焦虑 → narration-video", parseInstruction("@图文 职场焦虑").intent === "narration-video");
check(
  "@变声 + 文件 → voice-convert",
  parseInstruction("@变声 D:\\素材\\口播.mp3").intent === "voice-convert"
);
check(
  "@热点 也走图文解说那条（界面会拦下来先弹榜单）",
  parseInstruction("@热点").intent === "narration-video"
);
check(
  "@点名本身不会被当成主题",
  !parseInstruction("@对话 事业运").params.topic.includes("@")
);

// 15. 爆款嗅探：现在按**本地音视频文件**判定，链接不再是入口
const sniffFile = parseInstruction("@爆款 D:\\素材\\口播.mp3");
check("@爆款 + 本地 mp3 → sniff", sniffFile.intent === "sniff", sniffFile.intent);
check("@爆款 + 本地 mp3 → 取到 inputPath", sniffFile.params.inputPath === "D:\\素材\\口播.mp3", sniffFile.params.inputPath);
check("@爆款 + 本地 mp3 → 不缺输入", sniffFile.missing.length === 0, `missing=${sniffFile.missing.join()}`);
// 只说要拆解、没给文件 → 仍按 sniff 建卡，但 missing 标出来，第一步留空等你补文件
const sniffNoFile = parseInstruction("@爆款");
check("@爆款 没给文件 → 仍是 sniff（卡上补文件）", sniffNoFile.intent === "sniff", sniffNoFile.intent);
check(
  "@爆款 没给文件 → missing 提示音视频文件",
  sniffNoFile.missing.includes("音视频文件"),
  `missing=${sniffNoFile.missing.join()}`
);
check(
  "说「拆解这条爆款」也走 sniff（不会被「成片」抢走）",
  parseInstruction("帮我拆解这条爆款 https://v.douyin.com/aaa/").intent === "sniff",
  parseInstruction("帮我拆解这条爆款 https://v.douyin.com/aaa/").intent
);
check(
  "「拆解爆款」只给了链接 → 不再取链接，missing 提示音视频文件",
  parseInstruction("帮我拆解这条爆款 https://v.douyin.com/aaa/").missing.includes("音视频文件")
);
check(
  "「热点」还是走图文解说（只有爆款/嗅探/拆解才归 sniff）",
  parseInstruction("按今天的热点写一条成片").intent === "narration-video"
);
const sniffSteps = buildSteps(sniffFile);
// 拆解 → 挑选题 → 按同一套方法出分镜 → 选图合成（跟手动「爆款拆解」一条链）
check(
  "拆解剧本 = 拆解 → 分镜 → 合成",
  kinds(sniffSteps) === "sniff > write-storyboard > compose-narration",
  kinds(sniffSteps)
);
check(
  "拆解那步带上了文件和赛道",
  sniffSteps[0].params.map((p) => p.key).join(",") === "inputPath,niche",
  sniffSteps[0].params.map((p) => p.key).join(",")
);
// 「爆款链接」这一栏没了：第一步的入参是本地文件
check(
  "拆解第一步参数是 inputPath（file），不再是 link",
  sniffSteps[0].params[0].key === "inputPath" &&
    sniffSteps[0].params[0].type === "file" &&
    !sniffSteps[0].params.some((p) => p.key === "link"),
  JSON.stringify(sniffSteps[0].params[0])
);

// ---- 语音合成 / 语音识别（v1.0 加进工作台的两条链）----
const tts = parseInstruction("@语音 大家好，欢迎来到宝螺");
check("@语音 → tts", tts.intent === "tts", tts.intent);
check("tts 剧本 = 一步", kinds(buildSteps(tts)) === "tts", kinds(buildSteps(tts)));

const ttsByWords = parseInstruction("朗读一段：今天天气不错");
check("说「朗读」也走 tts", ttsByWords.intent === "tts", ttsByWords.intent);

const asr = parseInstruction("@识别 D:\\media\\a.mp3");
check("@识别 + 文件 → asr", asr.intent === "asr", asr.intent);
check("asr 剧本 = 一步识别", kinds(buildSteps(asr)) === "transcribe", kinds(buildSteps(asr)));
check(
  "识别那步带上了文件",
  buildSteps(asr)[0].params.find((p) => p.key === "inputPath").value === "D:\\media\\a.mp3"
);

const asrNoFile = parseInstruction("帮我把这段语音识别成文字");
check("识别但没给文件 → unknown 且提示缺文件", asrNoFile.intent === "unknown" && asrNoFile.missing.includes("音视频文件"), `${asrNoFile.intent} missing=${asrNoFile.missing.join()}`);

// 「转文字」+ 裸链接：不再有「下载再转录」这条路，如实回「不能从链接取视频」
const asrWithLink = parseInstruction("把这个链接的视频转文字 https://v.douyin.com/bbb/");
check("带链接的「转文字」不再是 download", asrWithLink.intent !== "download", asrWithLink.intent);
check(
  "带链接的「转文字」→ unknown 且提示缺音视频文件",
  asrWithLink.intent === "unknown" && asrWithLink.missing.includes("音视频文件"),
  `${asrWithLink.intent} missing=${asrWithLink.missing.join()}`
);

// 16. 规则把握度：哪些直接放行、哪些要交给 AI（parseByRules 的第二返回值）
const { parseByRules, resultForIntent } = require("../dist/main/agent/router.js");
const conf = (s) => parseByRules(s).confident;
check("@点名 → 有把握（不用问模型）", conf("@对话 事业运") === true);
check("裸链接 → 有把握（明确回「不能从链接取视频」，不用再问模型）", conf("https://v.douyin.com/abc/") === true);
check("关键词命中（解说…）→ 有把握", conf("做个图文解说 职场") === true);
check("只有主题 → 没把握（该问模型，规则默认对话容易猜错）", conf("职场焦虑") === false);
check("只有文件 → 没把握（话可能很随意）", conf("D:\\media\\a.mp3") === false);

// 17. resultForIntent：AI 判出意图后，产出的卡和规则一模一样
// （topic 给两边同一个值再比——AI 的意义之一就是修规则抽不准的主题，如「做个对话视频 事业运」）
const viaIntent = resultForIntent("dialogue-video", { topic: "事业运", link: null, filePath: null });
check("AI 意图 → 建出对话卡", viaIntent.intent === "dialogue-video" && viaIntent.params.topic === "事业运");
check("AI 意图 → 卡片文案与规则同构", viaIntent.summary === parseByRules("对话 事业运").result.summary);
// AI 判 sniff：有文件带 inputPath，没文件 missing 标出来（链接不进参数）
const sniffAi = resultForIntent("sniff", { topic: "", link: null, filePath: "D:\\素材\\a.mp4" });
check("AI 判 sniff 带文件 → 参数是本地路径", sniffAi.intent === "sniff" && sniffAi.params.inputPath === "D:\\素材\\a.mp4");
const sniffAiNoFile = resultForIntent("sniff", { topic: "", link: "https://v.douyin.com/x/", filePath: null });
check("AI 判 sniff 只有链接 → 仍是 sniff 卡但提示缺本地文件", sniffAiNoFile.intent === "sniff" && sniffAiNoFile.missing.includes("音视频文件") && sniffAiNoFile.params.link === undefined);
// AI 判 voice-convert 但没文件 → 同样缺输入
const vcNoFile = resultForIntent("voice-convert", { topic: "", link: null, filePath: null });
check("AI 判变声但缺文件 → unknown + 提示", vcNoFile.intent === "unknown" && vcNoFile.missing.includes("音视频文件"));
// AI 判 narration：link 只是事实记录，不再进卡片参数
const narLink = resultForIntent("narration-video", { topic: "职场", link: "https://v.douyin.com/x/", filePath: null });
check("AI 判图文解说 → 走解说链且不带链接参数", narLink.intent === "narration-video" && narLink.params.link === undefined, JSON.stringify(narLink.params));
// 认不出的意图名（含已删除的 download）落到兜底话术
const legacyDownload = resultForIntent("download", { topic: "", link: "https://v.douyin.com/x/", filePath: null });
check("已删除的 download 意图 → 兜底 unknown", legacyDownload.intent === "unknown" && legacyDownload.params.link === undefined);

// 18. 话里的参数要抽出来（时长 / 画面比例），且不能污染主题
const { extractDuration, extractResolution } = require("../dist/main/agent/router.js");
const p1 = parseInstruction("@对话 生成对话脚本，目标时长120s，横板16：9，以恰逢年少你明媚我自卑为主题");
check("参数：时长 120s → 120", p1.params.duration === "120", p1.params.duration);
check("参数：横板16:9 → landscape（错别字「板」也认）", p1.params.resolution === "landscape", p1.params.resolution);
check("参数：主题不被参数词污染", p1.params.topic === "恰逢年少你明媚我自卑", `topic="${p1.params.topic}"`);

check("中文数字：两分钟 → 120", extractDuration("来个两分钟的对话视频") === 120);
check("中文数字：三分钟 → 180", extractDuration("做个三分钟的视频") === 180);
check("分秒写法：1分30秒 → 90", extractDuration("对话 1分30秒 关于低谷期") === 90);
check("冒号写法：1:30 → 90", extractDuration("对话 1:30") === 90);
check("竖版 → portrait", extractResolution("做个对话视频，竖版") === "portrait");
check("横屏 → landscape", extractResolution("横屏") === "landscape");
check("没提时长 → null（用参数默认值）", extractDuration("对话 事业运") === null);
check("没提比例 → null", extractResolution("对话 事业运") === null);
// 「个人成长」不能被「个」误伤（词表里故意不列单个「个」）
check("主题不被量词削坏：个人成长", parseInstruction("对话 个人成长").params.topic === "个人成长");

// 19. 参数要落到卡片上
const paramSteps = buildSteps(p1);
const ws = paramSteps.find((s) => s.kind === "write-script");
const dc = paramSteps.find((s) => s.kind === "dialogue-config");
check("卡片：写脚本那步的时长 = 120", ws.params.find((p) => p.key === "duration").value === "120");
/*
 * 画面比例挂在第一步（整条片子的设定）；「角色与画面」里**不该再有**一个——
 * 两处都摆会让用户看到两个同名下拉、还互相打架（踩过，这里锁住）。
 */
check("卡片：画面比例 = landscape（挂第一步）", ws.params.find((p) => p.key === "resolution").value === "landscape");
check("卡片：角色与画面里不再重复摆画面比例", !dc.params.some((p) => p.key === "resolution"));
const resCount = paramSteps.reduce((n, s) => n + (s.params ?? []).filter((p) => p.key === "resolution").length, 0);
check("卡片：画面比例全卡只出现一次", resCount === 1, `出现 ${resCount} 次`);

/*
 * 20. AI 分流：事实拼装。
 * 真调模型的部分不进单测（要网络和 Key），这里只锁"给模型看的事实对不对"——
 * 这段拼错了模型会拿到空事实，判定就退化成瞎猜（「换声音」被判成做视频就是这么来的）。
 */
const { factsBlock } = require("../dist/main/agent/intent-ai.js");
const fb = factsBlock({
  filePath: "D:\\素材\\口播.mp3",
  link: null,
  durationSec: 120,
  resolution: "landscape",
});
check("事实块：带文件", fb.includes("D:\\素材\\口播.mp3"), fb.replace(/\n/g, " "));
check("事实块：带时长", fb.includes("120 秒"));
check("事实块：带比例", fb.includes("横版 16:9"));
check("事实块：没有的事实不出现", !fb.includes("检测到链接"));
check("事实块：全空 → 空串（不塞废话给模型）", factsBlock({}) === "");
check("事实块：不传 → 空串", factsBlock() === "");

process.exit(fail ? 1 : 0);
