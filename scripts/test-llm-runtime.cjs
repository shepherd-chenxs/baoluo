/**
 * 「文案/分镜现在由谁写」的联调脚本（真起 Electron、真调本机 CLI）。
 *
 * 验三件事：
 *   1) 没接运行时、也没填 Key → 报一句能照着做的话（不是崩溃、不是空回答）；
 *   2) 接了运行时 → 普通文本、JSON 两种请求都能从 CLI 拿回来；
 *   3) 运行时报错/超时 → 抛的是人话（带运行时名字），不会被界面吞成"未知原因"。
 *
 * 用临时 userData，绝不碰用户真实的 settings.json。
 * 跑法：npx electron scripts/test-llm-runtime.cjs
 */
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { app } = require("electron");

const dir = fs.mkdtempSync(path.join(os.tmpdir(), "baoluo-llm-"));
app.setPath("userData", dir);

let fail = 0;
function check(name, ok, extra) {
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${extra ? ` — ${extra}` : ""}`);
  if (!ok) fail++;
}

app.whenReady().then(async () => {
  const settings = require("../dist/main/dialogue/settings.js");
  const { detectRuntimes } = require("../dist/main/runtime/detect.js");
  const { llmRoute, llmComplete } = require("../dist/main/llm.js");

  try {
    /* ---------- 一、一条路都没有 ---------- */
    settings.updateAppSettings({ runtime: undefined });
    settings.updateSettings({ apiKey: "" });
    const none = llmRoute();
    check("没运行时没 Key：source=none", none.source === "none", none.source);
    check("没运行时没 Key：给出下一步", /运行时/.test(none.message ?? ""), none.message);

    let threw = "";
    try {
      await llmComplete({ system: "x", user: "y" });
    } catch (e) {
      threw = e.message;
    }
    check("没路可走时抛的是人话", /运行时/.test(threw), threw);

    /* ---------- 二、接了运行时 ---------- */
    const list = await detectRuntimes();
    const ready = list.filter((r) => r.status === "ready");
    if (!ready.length) {
      console.log("（本机没有可用运行时，跳过真调 CLI 的部分）");
    }
    for (const one of ready) {
      settings.updateAppSettings({ runtime: { activeId: one.id, prefs: {} } });
      const route = llmRoute();
      check(`接了${one.label}：source=runtime`, route.source === "runtime", route.source);
      check("label 带运行时名", route.label === one.label, route.label);

      const t0 = Date.now();
      const text = await llmComplete({
        system: "你是连通性测试助手。",
        user: "只回复四个字：连接成功",
        timeoutMs: 180_000,
      });
      check(
        `${one.label}：普通文本能拿回来`,
        /连接成功/.test(text),
        `${JSON.stringify(text)}（${Date.now() - t0}ms）`
      );

      const json = await llmComplete({
        system: '只输出一个 JSON 对象，形如 {"ok":true,"who":"..."}。',
        user: "输出一个 JSON：ok 为 true，who 填你的名字。",
        json: true,
        timeoutMs: 180_000,
      });
      let parsed = null;
      try {
        const { parseAiJson } = require("../dist/main/ai-json.js");
        parsed = parseAiJson(json);
      } catch {
        /* 解析失败下面会报 */
      }
      check(
        `${one.label}：JSON 能解析（围栏/解释文字都能兜住）`,
        parsed && parsed.ok === true,
        JSON.stringify(parsed).slice(0, 120)
      );
    }

    /* ---------- 三、运行时不听话时的报错措辞 ---------- */
    settings.updateAppSettings({ runtime: { activeId: "gemini", prefs: {} } });
    let err = "";
    try {
      await llmComplete({ system: "x", user: "y", timeoutMs: 5000 });
    } catch (e) {
      err = e.message;
    }
    check("一个没装/起不来的运行时会说清原因", /Gemini|识别|起不来/.test(err), err);
  } catch (e) {
    console.error("脚本自己挂了：", e);
    fail++;
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
    console.log(fail ? `\n${fail} 项失败` : "\n全部通过");
    app.exit(fail ? 1 : 0);
  }
});
