/*
 * SPDX-License-Identifier: GPL-3.0-only
 * Copyright (c) 2026 宝螺 / Baoluo contributors
 * 本文件属于「宝螺 / Baoluo」。除 GPL-3.0 外还适用 ADDITIONAL_TERMS.md 里的附加条款：
 * 分发时须保留来源署名；修改版对外分发时不得沿用「宝螺」名称与图标。
 */
/**
 * 「AI 一键成片」顺序编排的用例（T-005）。
 *
 * 为什么要单独测它：这条链路的坑不在某一环的 API，而在**顺序与停机条件**——
 *   - 缺图时必须停下来问用户（不能静默跳过、也不能偷偷换画面）；
 *   - 没有画面提示词的镜头必须在合成前就报错（它生不出图，硬跑会一直等）；
 *   - 缺图重试时不许重写分镜（会冲掉用户改过的文案/提示词，还白花一次 token）；
 *   - 队列收工后必须以**磁盘**为准重数缺图（广播可能错过）。
 * 这些都是纯逻辑，抽在 hotStoryPipeline.ts 里，所以可以用假实现直接跑。
 *
 * 跑法：npm run test:hot-pipeline
 */
const path = require("node:path");
const fs = require("node:fs");
const { execFileSync } = require("node:child_process");

const ROOT = path.join(__dirname, "..");
const OUT = path.join(ROOT, "tmp", "hot-pipeline-build");

let pass = 0;
let fail = 0;
function check(ok, label, detail) {
  if (ok) {
    pass++;
    console.log(`PASS  ${label}${detail ? ` — ${detail}` : ""}`);
  } else {
    fail++;
    console.log(`FAIL  ${label}${detail ? ` — ${detail}` : ""}`);
  }
}

// 这个模块不依赖 React / Electron，单独编一份就能在 node 里跑。
// 注意：单文件 tsc 会把 import 到的类型文件也带上，目录结构按 src/ 铺开，
// 所以产物在 renderer/views/ 下面（这里按路径去找，别写死文件名）。
fs.rmSync(OUT, { recursive: true, force: true });
fs.mkdirSync(OUT, { recursive: true });
execFileSync(
  process.execPath,
  [
    path.join(ROOT, "node_modules", "typescript", "bin", "tsc"),
    path.join("src", "renderer", "views", "hotStoryPipeline.ts"),
    "--outDir",
    OUT,
    "--rootDir",
    "src",
    "--module",
    "commonjs",
    "--target",
    "es2020",
    "--skipLibCheck",
  ],
  { cwd: ROOT, stdio: "inherit" }
);
const compiled = path.join(OUT, "renderer", "views", "hotStoryPipeline.js");
if (!fs.existsSync(compiled)) throw new Error(`没编出模块：${compiled}`);
const { runHotPipeline } = require(compiled);

/** 一个分镜：shots: [有图?, 有提示词?] */
function board(id, shots) {
  return {
    id,
    title: "测试分镜",
    resolution: "portrait",
    shots: shots.map((s, i) => ({
      id: `shot${i + 1}`,
      caption: `第${i + 1}句旁白`,
      imagePrompt: s.prompt === false ? "" : `画面${i + 1}`,
      imagePath: s.image ? `C:/img/${i + 1}.png` : null,
    })),
  };
}

/** 假依赖：按脚本走，记录调用顺序 */
function deps(script) {
  const calls = [];
  const stages = [];
  return {
    calls,
    stages,
    d: {
      generateStoryboard: async () => {
        calls.push("story");
        return script.story();
      },
      loadBoard: async (id) => {
        calls.push("loadBoard");
        return script.reload(id);
      },
      startBatch: async (boardId) => {
        calls.push("startBatch");
        return script.startBatch ? script.startBatch(boardId) : { started: true };
      },
      waitBatch: async () => {
        calls.push("waitBatch");
        if (script.waitBatch) await script.waitBatch();
      },
      compose: async (sb) => {
        calls.push("compose");
        return script.compose ? script.compose(sb) : "C:/out/video.mp4";
      },
      onStage: (stage, status, message, missing) => {
        stages.push({ stage, status, message, missing });
      },
      onNeedConfig: () => {
        calls.push("needConfig");
      },
    },
  };
}

(async () => {
  // ---- 1）顺路的全绿：分镜 → 生图 → 合成，顺序不能乱 ----
  {
    const t = deps({
      story: () => board("b1", [{ image: false }, { image: false }]),
      reload: (id) => board(id, [{ image: true }, { image: true }]),
    });
    const res = await runHotPipeline({ board: null, skipStory: false }, t.d);
    check(res.status === "done", "全绿：跑到 done", JSON.stringify(res));
    check(
      t.calls.join(",") === "story,startBatch,waitBatch,loadBoard,compose",
      "全绿：调用顺序 = 写分镜 → 排队 → 等队列 → 重读磁盘 → 合成",
      t.calls.join(",")
    );
    check(res.outputPath === "C:/out/video.mp4", "全绿：带出成片路径", res.outputPath);
  }

  // ---- 2）已经有图：跳过生图，直接合成 ----
  {
    const t = deps({ story: () => board("b2", [{ image: true }, { image: true }]) });
    const res = await runHotPipeline({ board: null, skipStory: false }, t.d);
    check(res.status === "done" && !t.calls.includes("startBatch"), "已有图：不碰生图队列", t.calls.join(","));
  }

  // ---- 3）生图没出全：停下来问用户，绝不静默合成 ----
  {
    const t = deps({
      story: () => board("b3", [{ image: false }, { image: false }, { image: false }]),
      reload: (id) => board(id, [{ image: true }, { image: false }, { image: false }]),
    });
    const res = await runHotPipeline({ board: null, skipStory: false }, t.d);
    check(res.status === "waiting", "缺图：status=waiting", JSON.stringify(res));
    check(res.missing === 2, "缺图：报出还缺 2 张", `missing=${res.missing}`);
    check(
      !t.calls.includes("compose"),
      "缺图：一次都没调合成（不偷偷把缺图的镜头合成进去）",
      t.calls.join(",")
    );
    const last = t.stages[t.stages.length - 1];
    check(
      last.stage === "images" && last.status === "waiting",
      "缺图：进度条停在「生图」这一步等用户",
      JSON.stringify(last)
    );
  }

  // ---- 4）重试缺图：不重写分镜（省 token、不冲掉用户改过的文案） ----
  {
    const t = deps({ reload: (id) => board(id, [{ image: true }]) });
    const res = await runHotPipeline(
      { board: board("b4", [{ image: false }]), skipStory: true },
      t.d
    );
    check(res.status === "done", "重试缺图：跑到 done", JSON.stringify(res));
    check(
      !t.calls.includes("story"),
      "重试缺图：没有重新生成分镜",
      t.calls.join(",")
    );
    check(t.calls[0] === "startBatch", "重试缺图：第一步就是排队生图", t.calls.join(","));
  }

  // ---- 5）有镜头没有画面提示词：合成前就报错（它永远生不出图） ----
  {
    const t = deps({ story: () => board("b5", [{ image: false, prompt: false }, { image: true }]) });
    const res = await runHotPipeline({ board: null, skipStory: false }, t.d);
    check(res.status === "error", "无提示词：status=error", JSON.stringify(res));
    check(/没有画面提示词/.test(res.message), "无提示词：原因说人话", res.message);
    check(!t.calls.includes("startBatch"), "无提示词：不去排队生图", t.calls.join(","));
    check(!t.calls.includes("compose"), "无提示词：也不合成", t.calls.join(","));
  }

  // ---- 6）生图引擎没配好（ModelScope 缺 Token）：如实报错 + 把出口交给界面 ----
  {
    const t = deps({
      story: () => board("b6", [{ image: false }]),
      startBatch: () => ({ started: false, state: null, error: "还没填 ModelScope 的访问令牌。", code: "ms-no-token" }),
    });
    const res = await runHotPipeline({ board: null, skipStory: false }, t.d);
    check(res.status === "error" && /ModelScope|令牌/.test(res.message), "缺配置：如实报错", res.message);
    check(t.calls.includes("needConfig"), "缺配置：界面拿到引导去设置页的信号", t.calls.join(","));
    check(!t.calls.includes("waitBatch"), "缺配置：不进等待（队列根本没启动）", t.calls.join(","));
    check(!t.calls.includes("compose"), "缺配置：不合成", t.calls.join(","));
  }

  // ---- 6b）队列启动失败但没有具体原因：也要如实停下，不假装在跑 ----
  {
    const t = deps({
      story: () => board("b6b", [{ image: false }]),
      startBatch: () => ({ started: false, state: null, error: "批量生图正在跑别的方案，先等它收工。" }),
    });
    const res = await runHotPipeline({ board: null, skipStory: false }, t.d);
    check(res.status === "error", "启动失败：status=error", JSON.stringify(res));
    check(!t.calls.includes("needConfig"), "启动失败：不该误报成缺配置", t.calls.join(","));
    check(!t.calls.includes("compose"), "启动失败：不合成", t.calls.join(","));
  }

  // ---- 7）合成被用户中止：算中止（不是错误），也不许吞掉 ----
  {
    const t = deps({
      story: () => board("b7", [{ image: true }]),
      compose: () => {
        throw new Error("合成已取消");
      },
    });
    const res = await runHotPipeline({ board: null, skipStory: false }, t.d);
    check(res.status === "cancelled", "中止：status=cancelled", JSON.stringify(res));
    check(/已中止/.test(res.message), "中止：提示是「已中止」而不是报错堆栈", res.message);
  }

  // ---- 8）分镜是空的：别一头扎进生图 ----
  {
    const t = deps({ story: () => board("b8", []) });
    const res = await runHotPipeline({ board: null, skipStory: false }, t.d);
    check(res.status === "error" && /没有镜头/.test(res.message), "空分镜：报「没有镜头」", res.message);
    check(!t.calls.includes("compose"), "空分镜：不合成", t.calls.join(","));
  }

  // ---- 9）「AI 成片」要不要重写分镜：主题没改就沿用（别冲掉用户手改的稿子） ----
  {
    const { shouldReuseStoryboard } = require(compiled);
    const b = board("b9", [{ image: false }]);
    check(shouldReuseStoryboard(b, "同一个主题", "同一个主题") === true, "主题没改：沿用现有分镜（不重写）");
    check(shouldReuseStoryboard(b, "旧主题", "换了主题") === false, "主题改了：重写分镜");
    check(shouldReuseStoryboard(null, "任意", "任意") === false, "还没有分镜：当然要写");
    check(shouldReuseStoryboard(board("b9b", []), "任意", "任意") === false, "空分镜：当作没有，重写");
    check(shouldReuseStoryboard(b, null, "任意") === true, "没记过主题：保守沿用（宁可多花一次点击，也不冲掉手改）");
    check(shouldReuseStoryboard(b, "  两边有空格  ", "两边有空格") === true, "前后空格不算改动");
  }

  /*
   * ---- 10）主进程队列的开工顺序（读源码的防回归判据）----
   *
   * 界面这边是「先拿到 startBatch 的回包，再挂上等收工的钩子」。
   * 所以主进程的 startBatch 必须判完就返回、队列在后台跑：
   * 哪天有人把它改成 await 到底，或删掉队列开头那一下让拍，
   * 碰上「这批一张都不缺」时队列会当场收工，running=false 的广播赶在钩子挂上之前发掉
   * —— 一键成片就此干等不醒。这条坑只有串起两侧才看得出来，所以钉在流水线用例里。
   */
  {
    const batchSrc = fs.readFileSync(path.join(ROOT, "src", "main", "imagegen", "batch.ts"), "utf-8");
    check(
      /void runQueue\(/.test(batchSrc) && !/await runQueue\(/.test(batchSrc),
      "队列：startBatch 判完就返回，不等跑完",
      "队列后台跑"
    );
    check(
      /setImmediate/.test(batchSrc),
      "队列：开跑前让出一拍，保证回包先于收工广播"
    );
  }

  console.log(
    fail === 0 ? `\n全部通过（${pass} 项）` : `\n${fail} 项未通过（共 ${pass + fail} 项）`
  );
  process.exit(fail === 0 ? 0 : 1);
})();
