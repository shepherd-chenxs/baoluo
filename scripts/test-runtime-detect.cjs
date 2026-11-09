/**
 * 「集成运行时」的两块纯逻辑回归测试（不启 Electron、不联网）。
 *
 *   1) 识别：本机扫描的产出结构是否可信（去重、路径必须真在、ready 的必须带版本）；
 *   2) 对话协议：`@@TOOL` 那一行能不能揪出来、映射成宝螺的意图（缺参数不能硬建卡）。
 *
 * 识别那部分**不假设本机装了哪几个**：跑测试的机器可能一个都没有（CI）。
 * 有就逐条验，没有就只验"空数组也是合法结果"。
 */
const fs = require("node:fs");
const { detectRuntimes } = require("../dist/main/runtime/detect.js");
const { takeToolCall, planFromTool } = require("../dist/main/runtime/chat.js");

let fail = 0;
function check(name, ok, extra) {
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${extra ? ` — ${extra}` : ""}`);
  if (!ok) fail++;
}

(async () => {
  /* ---------------- 一、识别 ---------------- */
  const list = await detectRuntimes();
  check("识别返回数组", Array.isArray(list), `count=${list.length}`);
  check(
    "同一家族不重复",
    new Set(list.map((r) => r.id)).size === list.length
  );

  for (const r of list) {
    const tag = r.label;
    check(`${tag}：状态合法`, r.status === "ready" || r.status === "broken", r.status);
    check(`${tag}：路径真的存在`, fs.existsSync(r.path), r.path);
    check(`${tag}：installs 含选中路径`, r.installs.includes(r.path));
    check(`${tag}：installs 去重`, new Set(r.installs).size === r.installs.length);
    if (r.status === "ready") {
      check(`${tag}：ready 带版本号`, /^\d+\.\d+\.\d+/.test(r.version ?? ""), r.version ?? "(空)");
      check(`${tag}：ready 没有报错说明`, !r.note);
    } else {
      check(`${tag}：broken 带原因`, !!r.note, r.note);
    }
  }
  console.log(
    list.length
      ? `（本机识别到：${list.map((r) => `${r.label} ${r.version ?? "-"}`).join("、")}）`
      : "（本机一个运行时都没识别到 —— 空结果也算通过）"
  );

  /* ---------------- 二、工具协议 ---------------- */
  const plain = takeToolCall("好，这条我直接给你下下来。");
  check("普通聊天不误判成工具调用", plain === null);

  const call = takeToolCall(
    '我按图文解说做。\n@@TOOL {"tool":"make_narration_video","args":{"topic":"蒙卦","durationSec":90}}'
  );
  check("揪出 @@TOOL 那一行", call && call.tool === "make_narration_video", call && call.tool);
  check("工具参数原样带回", call && call.args.topic === "蒙卦");

  const nar = planFromTool(call);
  check("图文解说 → narration-video", nar.intent === "narration-video", nar.intent);
  check("主题不丢", nar.params.topic === "蒙卦", nar.params.topic);
  check("时长带进参数", nar.params.duration === "90", nar.params.duration);
  check("不缺输入", nar.missing.length === 0);

  const dl = planFromTool({ tool: "download_video", args: { link: "https://v.douyin.com/x/" } });
  check("下载 → download", dl.intent === "download", dl.intent);
  check("链接带进参数", dl.params.link === "https://v.douyin.com/x/");

  const missing = planFromTool({ tool: "download_video", args: {} });
  check("下载没给链接 → 不建卡（unknown）", missing.intent === "unknown", missing.intent);
  check("并说清缺什么", missing.missing.includes("链接"), JSON.stringify(missing.missing));

  const unknownTool = planFromTool({ tool: "make_coffee", args: {} });
  check("不认识的工具返回 null", unknownTool === null);

  /* ---------------- 三、权限范围 / 模型 → CLI 参数 ---------------- */
  const { argsFor } = require("../dist/main/runtime/chat.js");
  const { normalizePrefs } = require("../dist/shared/runtime-types.js");
  const codexArgs = argsFor("codex", "/tmp/last.txt", { model: null, permission: "agent" });
  check(
    "codex 可执行 → 只读沙箱",
    codexArgs.includes("--sandbox") && codexArgs[codexArgs.indexOf("--sandbox") + 1] === "read-only",
    codexArgs.join(" ")
  );
  check("codex 不指定模型时不带 --model", !codexArgs.includes("--model"));
  const codexFull = argsFor("codex", "/tmp/last.txt", { model: "gpt-5", permission: "full" });
  check(
    "codex 完全访问 → danger-full-access",
    codexFull[codexFull.indexOf("--sandbox") + 1] === "danger-full-access"
  );
  check(
    "codex 模型紧跟 --model",
    codexFull[codexFull.indexOf("--model") + 1] === "gpt-5",
    codexFull.join(" ")
  );
  check(
    "codex 仍然从 stdin 读提示词",
    codexFull[codexFull.length - 1] === "-",
    codexFull[codexFull.length - 1]
  );

  const claudeArgs = argsFor("claude", "/tmp/last.txt", { model: "sonnet", permission: "agent" });
  check("claude 带模型别名", claudeArgs[claudeArgs.indexOf("--model") + 1] === "sonnet");
  check("claude 可执行不放开权限档", !claudeArgs.includes("--permission-mode"));
  const claudeFull = argsFor("claude", "/tmp/last.txt", { model: null, permission: "full" });
  check(
    "claude 完全访问 → bypassPermissions",
    claudeFull[claudeFull.indexOf("--permission-mode") + 1] === "bypassPermissions"
  );
  check("claude 不猜模型的沙箱参数", !claudeFull.includes("--sandbox"));

  const geminiArgs = argsFor("gemini", "/tmp/last.txt", { model: null, permission: "full" });
  check(
    "gemini 只给模型，不猜权限开关",
    geminiArgs.join(" ") === "-p --output-format json",
    geminiArgs.join(" ")
  );

  check("默认权限是可执行", normalizePrefs(null).permission === "agent");
  check("不认识的权限回落到可执行", normalizePrefs({ permission: "root" }).permission === "agent");
  check("空模型名存成 null", normalizePrefs({ model: "   " }).model === null);
  check("模型名去空格", normalizePrefs({ model: " gpt-5 " }).model === "gpt-5");
  check("模型名超长截断", normalizePrefs({ model: "x".repeat(200) }).model.length === 60);

  /* ---------------- 四、模型清单：从 CLI 自己的配置里读 ---------------- */
  const { tomlScan, parseCodexCatalog, parseClaudeSettings, modelsFor } = require(
    "../dist/main/runtime/models.js"
  );

  const toml = tomlScan(`
# magpie: 注释里也有 model = "假的"，不能当真
model_provider = "magpie"
model_catalog_json = "magpie-models.json"
model = "group/never-stuck"

[model_providers.magpie]
name = "magpie"
base_url = "http://127.0.0.1:3425/v1"
`);
  check("toml 读顶层键", toml.top.model === "group/never-stuck", toml.top.model);
  check("toml 忽略注释里的伪键", toml.top.model_provider === "magpie");
  check(
    "toml 读段里的键",
    toml.sections["model_providers.magpie"]?.base_url === "http://127.0.0.1:3425/v1",
    toml.sections["model_providers.magpie"]?.base_url
  );

  const cat = parseCodexCatalog({
    models: [
      { slug: "group/never-stuck", display_name: "永不卡住 · routing group", description: "永不卡住 · routing group via magpie" },
      { slug: "zcode/GLM-5.3[1m]", display_name: "GLM-5.3 · ZCode" },
      { slug: "w/ctx", context_window: 128000 },
      { display_name: "没有 slug 的丢掉" },
      { slug: "group/never-stuck", display_name: "重复的丢掉" },
    ],
  });
  check("目录解析出 3 条（丢掉没 id 的、去重）", cat.length === 3, cat.length);
  check("显示名优先于 slug", cat[0].label === "永不卡住 · routing group", cat[0].label);
  check("描述去掉重复的名字后进 hint", cat[0].hint === "via magpie", cat[0].hint);
  check("没描述时用上下文长度", cat[2].hint === "上下文 128k", cat[2].hint);
  check("没显示名时退回 id", cat[2].label === "w/ctx", cat[2].label);

  const claude = parseClaudeSettings({
    model: "group/never-stuck[1m]",
    modelPicker: {
      options: [
        { label: "永不卡住 · routing group", model: "group/never-stuck[1m]", description: "via magpie" },
        { label: "GLM-5.3 · ZCode", model: "zcode/GLM-5.3[1m]" },
        { label: "没有 model 的丢掉" },
      ],
    },
    env: { ANTHROPIC_BASE_URL: "http://127.0.0.1:3425", ANTHROPIC_AUTH_TOKEN: "sk-x" },
  });
  check("claude 读 modelPicker.options", claude.models.length === 2, claude.models.length);
  check("claude 默认模型", claude.defaultModel === "group/never-stuck[1m]", claude.defaultModel);
  check("claude 网关地址", claude.baseUrl === "http://127.0.0.1:3425", claude.baseUrl);

  // 端到端：本机真有配置就必须读得出东西（没装的机器跳过）
  const os = require("node:os");
  const pathMod = require("node:path");
  const codexCfg = pathMod.join(process.env.CODEX_HOME ?? pathMod.join(os.homedir(), ".codex"), "config.toml");
  if (fs.existsSync(codexCfg)) {
    const list = await modelsFor("codex", true);
    check("codex 真配置读得出模型", list.ok && list.models.length > 0, `count=${list.models.length}`);
    check("codex 带出默认模型", !!list.defaultModel, list.defaultModel ?? "(空)");
    console.log(`（codex 清单来自 ${list.source}，共 ${list.models.length} 个）`);
  } else {
    console.log("（本机没有 ~/.codex/config.toml —— 跳过端到端读取）");
  }

  console.log(fail ? `\n${fail} 项失败` : "\n全部通过");
  process.exit(fail ? 1 : 0);
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
