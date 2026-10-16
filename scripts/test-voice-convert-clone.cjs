/*
 * SPDX-License-Identifier: GPL-3.0-only
 * Copyright (c) 2026 宝螺 / Baoluo contributors
 * 本文件属于「宝螺 / Baoluo」。除 GPL-3.0 外还适用 ADDITIONAL_TERMS.md 里的附加条款：
 * 分发时须保留来源署名；修改版对外分发时不得沿用「宝螺」名称与图标。
 */
/**
 * 变声器（方案 A）· 克隆音色分支端到端测试。
 *
 *   npm run test:convert-clone
 *
 * 比 test-voice-convert.cjs 多两步：先把本地 Genie 服务拉起来，
 * 再临时注册一个用 feibi 模型 + 自带参考音频的克隆音色（跑完会还原设置）。
 * 需要已下载 Genie 模型（「设置 → 声音克隆 → 模型库」）。
 */
const path = require("node:path");
const fs = require("node:fs");
const { spawn } = require("node:child_process");
const { app } = require("electron");

const ROOT = path.join(__dirname, "..");
app.setAppPath(ROOT);
const USER_DATA = path.join(process.env.APPDATA || "", "Baoluo");
app.setPath("userData", USER_DATA);

const ffmpeg = require(path.join(ROOT, "node_modules", "ffmpeg-static"));
const { EdgeTTS } = require(path.join(ROOT, "node_modules", "node-edge-tts"));
const dist = (p) => path.join(ROOT, "dist", "main", p);

const TMP = path.join(ROOT, "tmp", "voice-convert-clone");
const OUT = path.join(TMP, "out");
const FEIBI_DIR = path.join(USER_DATA, "genie", "CharacterModels", "v2ProPlus", "feibi");
const REF_WAV = path.join(FEIBI_DIR, "prompt_wav", "zh_vo_Main_Linaxita_2_1_10_26.wav");
const REF_TEXT = "在此之前，请您务必继续享受旅居拉古那的时光。";
const TEST_VOICE_ID = "vc-test-feibi";

const SRC_TEXT = "日月有更替，四季长轮转。心里有啥事儿，阁下请直言。";

let failures = 0;
function check(ok, label, extra = "") {
  console.log(`${ok ? "PASS" : "FAIL"}  ${label}${extra ? " — " + extra : ""}`);
  if (!ok) failures++;
}

function probeDuration(file) {
  return new Promise((resolve) => {
    const c = spawn(ffmpeg, ["-hide_banner", "-i", file], { windowsHide: true });
    let err = "";
    c.stderr.on("data", (b) => (err += b.toString("utf8")));
    c.on("close", () => {
      const m = /Duration:\s*(\d+):(\d+):(\d+\.\d+)/.exec(err);
      resolve(m ? +m[1] * 3600 + +m[2] * 60 + +m[3] : 0);
    });
  });
}

(async () => {
  await app.whenReady();

  if (!fs.existsSync(REF_WAV)) {
    console.log(`SKIP  没找到 feibi 参考音频（${REF_WAV}），先下载模型再跑`);
    app.exit(0);
    return;
  }

  fs.rmSync(TMP, { recursive: true, force: true });
  fs.mkdirSync(OUT, { recursive: true });

  const settings = require(dist("dialogue/settings.js"));
  const { genieManager } = require(dist("dialogue/genie-manager.js"));
  const { runVoiceConvert } = require(dist("dialogue/voice-convert.js"));

  // 1) 造源音频
  const srcPath = path.join(TMP, "src.mp3");
  await new EdgeTTS({ voice: "zh-CN-YunjianNeural", timeout: 30_000 }).ttsPromise(
    SRC_TEXT,
    srcPath
  );
  check(fs.existsSync(srcPath), "源音频已生成");

  // 2) 启动本地 Genie 服务
  const t0 = Date.now();
  await genieManager.start((p) => console.log(`      [genie] ${p.phase} ${p.message ?? ""}`));
  const env = await genieManager.env();
  check(env.online, "本地语音服务已启动", `${((Date.now() - t0) / 1000).toFixed(1)}s`);

  // 3) 临时注册一个克隆音色（跑完还原，不动用户原有配置）
  const before = settings.getAppSettings().cloneVoices ?? [];
  settings.updateAppSettings({
    cloneVoices: [
      ...before,
      {
        id: TEST_VOICE_ID,
        name: "测试音色",
        modelDir: FEIBI_DIR,
        audioPath: REF_WAV,
        audioText: REF_TEXT,
        language: "zh",
        createdAt: Date.now(),
      },
    ],
  });

  try {
    const stages = [];
    const t1 = Date.now();
    const res = await runVoiceConvert({
      inputPath: srcPath,
      voice: `clone:${TEST_VOICE_ID}`,
      outputDir: OUT,
      onProgress: (p) => {
        if (stages[stages.length - 1] !== p.stage) {
          stages.push(p.stage);
          console.log(`      [${p.stage}] ${p.message ?? ""}`);
        }
      },
    });
    const cost = ((Date.now() - t1) / 1000).toFixed(1);

    const outDur = await probeDuration(res.audioPath);
    const size = fs.statSync(res.audioPath).size;
    check(fs.existsSync(res.audioPath), "产物已生成", path.relative(ROOT, res.audioPath));
    check(res.doneCount === res.segmentCount && res.segmentCount > 0, "每一句都用克隆音色合成成功", `${res.doneCount}/${res.segmentCount} 句`);
    check(outDur > 0.5, "产物有可听时长", `${outDur.toFixed(2)}s`);
    check(size > 10_000, "产物不是空文件", `${(size / 1024).toFixed(1)} KB`);
    check(
      !fs.existsSync(path.join(OUT, "seg")) && !fs.existsSync(path.join(OUT, "norm")),
      "中间产物已清理"
    );
    console.log(`      耗时 ${cost}s（含 CPU 推理）`);
    console.log(`      成品：${res.audioPath}`);
  } finally {
    // 还原设置 + 关服务
    settings.updateAppSettings({ cloneVoices: before });
    await genieManager.disable();
  }

  console.log(failures ? `\n${failures} 项未通过` : "\n全部通过");
  app.exit(failures ? 1 : 0);
})().catch(async (e) => {
  console.error("FAIL  克隆音色变声抛错 —", e?.message || e);
  try {
    const { genieManager } = require(dist("dialogue/genie-manager.js"));
    await genieManager.disable();
  } catch {
    /* noop */
  }
  app.exit(1);
});
