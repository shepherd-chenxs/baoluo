/**
 * 文字卡视频：主进程链路自测（不出界面）。
 *
 *   npx electron scripts/test-textcard.cjs
 *
 * 两个用例：
 *   1) 静音模式：卡片图尺寸、出片、时长/分辨率（回归老行为）；
 *   2) 配音 + BGM：逐卡 TTS、按时长翻页、BGM 混流。TTS 需要联网——
 *      挂了会走静音回退（note 里带提示），用例仍要能出片、有音轨。
 */
const { app } = require("electron");
const fs = require("node:fs");
const path = require("node:path");
const os = require("node:os");

// 截图用的隐藏窗口 destroy 后会触发 window-all-closed；Electron 默认就此退出，
// 后面的 ffmpeg 步骤会"凭空消失"。脚本里得把这条默认行为按住。
app.on("window-all-closed", () => {});

async function probeStream(file) {
  const { runFfmpeg } = require("../dist/main/dialogue/ffmpeg");
  const out = await runFfmpeg(["-hide_banner", "-i", file], {});
  const v = /Stream.*Video:.*?(\d{2,5})x(\d{2,5}).*?(\d+(?:\.\d+)?) fps/.exec(out.stderr);
  const d = /Duration:\s*(\d+):(\d+):(\d+\.\d+)/.exec(out.stderr);
  return {
    video: v ? `${v[1]}x${v[2]} @ ${v[3]}fps` : "未识别",
    duration: d ? +d[1] * 3600 + +d[2] * 60 + +d[3] : 0,
    hasAudio: /Stream.*Audio:/.test(out.stderr),
  };
}

async function main() {
  const { runTextCard, textCardOutputDir } = require("../dist/main/textcard");
  const { parseCards } = require("../dist/shared/textcard-types");

  // ---- 用例 1：静音模式（回归）----
  const text = "想做就去做\n别等准备好了才开始，\n准备永远不会有尽头。\n\n慢一点也没关系\n方向对了，慢就是快。";
  const cards = parseCards(text);
  console.log("解析卡片:", cards.length, JSON.stringify(cards));

  const progress = [];
  const t0 = Date.now();
  const res = await runTextCard(
    {
      requestId: "test-" + Date.now(),
      cards,
      options: { style: "plain", ratio: "portrait", seconds: 1.5 },
    },
    (p) => progress.push(`${p.stage} ${p.percent}% ${p.message}`)
  );
  console.log("耗时:", ((Date.now() - t0) / 1000).toFixed(1) + "s");
  console.log("结果:", res);
  console.log("存在:", fs.existsSync(res.videoPath), fs.statSync(res.videoPath).size, "字节");
  console.log("进度条数:", progress.length, "最后一条:", progress[progress.length - 1]);

  const s1 = await probeStream(res.videoPath);
  console.log("视频流:", s1.video, "时长:", s1.duration.toFixed(2));
  console.log("输出目录:", textCardOutputDir());
  if (!fs.existsSync(res.videoPath)) throw new Error("静音模式没有出片");

  // ---- 用例 2：配音 + BGM + 自动动效 ----
  // BGM 没有现成资产，用 ffmpeg 生成一段 60s 正弦波顶上（只验混流链路，不验好听）。
  const bgm = path.join(os.tmpdir(), `baoluo-test-bgm-${Date.now()}.wav`);
  const { runFfmpeg } = require("../dist/main/dialogue/ffmpeg");
  const g = await runFfmpeg(["-y", "-f", "lavfi", "-i", "sine=frequency=440:duration=60", "-t", "60", bgm], {});
  if (g.code !== 0) throw new Error("测试 BGM 生成失败：" + g.stderr.split(/\r?\n/).pop());

  const cards2 = parseCards(
    "想把日子过成诗\n慢一点，也没关系。\n\n种一棵树最好的时间\n是十年前，其次是现在。"
  );
  const progress2 = [];
  const t1 = Date.now();
  const res2 = await runTextCard(
    {
      requestId: "test-voice-" + Date.now(),
      cards: cards2,
      options: {
        style: "dark",
        ratio: "portrait",
        seconds: 1.5,
        voice: "zh-CN-XiaoxiaoNeural",
        bgmPath: bgm,
        bgmVolume: 0.15,
        motion: "auto",
        transition: "fade",
      },
    },
    (p) => progress2.push(`${p.stage} ${p.percent}% ${p.message}`)
  );
  console.log("\n[配音模式] 耗时:", ((Date.now() - t1) / 1000).toFixed(1) + "s");
  console.log("[配音模式] 结果:", res2);
  console.log("[配音模式] 阶段:", [...new Set(progress2.map((p) => p.split(" ")[0]))].join(" → "));
  if (!fs.existsSync(res2.videoPath)) throw new Error("配音模式没有出片");

  const s2 = await probeStream(res2.videoPath);
  console.log("[配音模式] 视频流:", s2.video, "时长:", s2.duration.toFixed(2), "音轨:", s2.hasAudio ? "有" : "没有");
  if (!s2.hasAudio) throw new Error("配音模式成片没有音轨");
  // 成片实际时长应与逐卡时长求和基本一致（段级取帧有 ±1 帧误差）
  if (Math.abs(s2.duration - res2.durationSec) > 1.5) {
    throw new Error(`时长对不上：实际 ${s2.duration.toFixed(2)}s，统计 ${res2.durationSec}s`);
  }
  if (res2.note) console.log("[配音模式] 提示:", res2.note, "（TTS 失败走了静音回退）");

  try {
    fs.unlinkSync(bgm);
  } catch {
    /* 临时 BGM 删不掉不影响 */
  }
  console.log("\n全部通过。");
  app.quit();
}

app.whenReady().then(() =>
  main().catch((e) => {
    console.error("失败:", e);
    app.exit(1);
  })
);
