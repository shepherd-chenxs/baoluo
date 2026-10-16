/*
 * SPDX-License-Identifier: GPL-3.0-only
 * Copyright (c) 2026 宝螺 / Baoluo contributors
 * 本文件属于「宝螺 / Baoluo」。除 GPL-3.0 外还适用 ADDITIONAL_TERMS.md 里的附加条款：
 * 分发时须保留来源署名；修改版对外分发时不得沿用「宝螺」名称与图标。
 */
/**
 * 生图引擎（provider）接线测试：设置落盘 / 引擎判定 / ModelScope 报错映射。
 *
 *   electron scripts/test-image-provider.cjs
 *
 * 验三件事：
 *   ① 设置里那两个新键真能存进去、能读回来（updateAppSettings 只认显式处理的键，
 *      漏了就静默丢掉——这种坑不改测试是发现不了的）；
 *   ② 引擎判定与界面拿到的那句话（imageProviderInfo）一致；
 *   ③ 真打一次 ModelScope 接口（用假 Token）：确认真实端点的鉴权失败能被收成
 *      「ModelScope 鉴权失败…」这句人话，而不是漏出英文堆栈。
 *      这一条需要联网；没网时只报 SKIP，不算失败。
 */
const path = require("node:path");
const fs = require("node:fs");
const { app } = require("electron");

const ROOT = path.join(__dirname, "..");
const SANDBOX = path.join(ROOT, "tmp", "image-provider-test");

app.setAppPath(ROOT);
fs.rmSync(SANDBOX, { recursive: true, force: true });
fs.mkdirSync(SANDBOX, { recursive: true });
app.setPath("userData", SANDBOX);

let pass = 0;
let fail = 0;
let skip = 0;
function check(ok, label, extra = "") {
  if (ok) {
    pass++;
    console.log(`PASS  ${label}${extra ? ` — ${extra}` : ""}`);
  } else {
    fail++;
    console.log(`FAIL  ${label}${extra ? ` — ${extra}` : ""}`);
  }
}
function skipCheck(label, why) {
  skip++;
  console.log(`SKIP  ${label} — ${why}`);
}

(async () => {
  await app.whenReady();

  const settings = require(path.join(ROOT, "dist", "main", "dialogue", "settings.js"));
  const imagegen = require(path.join(ROOT, "dist", "main", "imagegen", "index.js"));
  const { generateImageViaModelScope, ModelScopeError } = require(
    path.join(ROOT, "dist", "main", "imagegen", "modelscope.js")
  );

  const settingsFile = path.join(SANDBOX, "settings.json");
  const readApp = () => JSON.parse(fs.readFileSync(settingsFile, "utf-8")).app;

  // ---- ① 设置落盘 ----
  check(imagegen.currentImageProvider() === "modelscope", "没配过时默认引擎 = ModelScope");

  settings.updateAppSettings({
    imageProvider: "modelscope",
    modelscopeImage: { token: "  abc.def  ", model: "  ", size: " 720x1280 " },
  });
  const stored = readApp();
  check(stored.imageProvider === "modelscope", "引擎能存进 settings.json", stored.imageProvider);
  check(
    stored.modelscopeImage?.token === "abc.def",
    "Token 存盘时去掉首尾空格",
    JSON.stringify(stored.modelscopeImage)
  );
  check(
    stored.modelscopeImage?.model === undefined,
    "留空的模型不写盘（用默认模型）",
    JSON.stringify(stored.modelscopeImage)
  );
  check(stored.modelscopeImage?.size === "720x1280", "尺寸能存进盘", stored.modelscopeImage?.size);

  settings.updateAppSettings({ imageProvider: "garbage" });
  check(readApp().imageProvider === "modelscope", "非法引擎值回落到 ModelScope（配置被手改也不崩）");

  settings.updateAppSettings({ imageProvider: "modelscope", modelscopeImage: { token: "abc.def" } });
  check(imagegen.currentImageProvider() === "modelscope", "读回来还是 modelscope");

  const ready = imagegen.imageProviderInfo();
  check(ready.provider === "modelscope" && ready.ready === true, "填了 Token = 就绪", JSON.stringify(ready));
  check(ready.model.length > 0, "未指定模型时会给出默认模型", ready.model);

  settings.updateAppSettings({ modelscopeImage: {} });
  check(readApp().modelscopeImage === undefined, "三项全空时整个键被删掉，不留空对象");
  const notReady = imagegen.imageProviderInfo();
  check(notReady.ready === false && notReady.code === "ms-no-token", "没 Token = 未就绪且说清原因", notReady.message);

  const blocked = imagegen.imageProviderBlocked();
  check(Boolean(blocked?.message.includes("设置")), "未就绪时给的是能照着做的人话", blocked?.message);

  // 本地就能验的失败：没 Token 直接拒
  try {
    await generateImageViaModelScope("一只橘猫", { token: "" });
    check(false, "没 Token 时应当直接报错");
  } catch (e) {
    check(
      e instanceof ModelScopeError && e.code === "ms-no-token",
      "没 Token 时抛 ms-no-token（不发无效请求）",
      e.code
    );
  }

  // ---- ③ 真打一次接口：假 Token 应当被收成「鉴权失败」的人话 ----
  try {
    await generateImageViaModelScope("一只橘猫，午后自然光", {
      token: "invalid-token-for-test",
      model: "Tongyi-MAI/Z-Image-Turbo",
      size: "720x1280",
      timeoutMs: 30_000,
    });
    check(false, "假 Token 应当鉴权失败");
  } catch (e) {
    if (e instanceof ModelScopeError && (e.code === "ms-network" || e.code === "ms-timeout")) {
      skipCheck("假 Token → 鉴权失败的人话", `没连上 ModelScope（${e.message}）`);
    } else {
      check(
        e instanceof ModelScopeError && (e.code === "ms-unauthorized" || e.code === "ms-bad-request"),
        "假 Token → 收成鉴权/参数类人话（端点与错误映射正确）",
        `${e.code}：${e.message}`
      );
      check(
        /[\u4e00-\u9fa5]/.test(e.message) && !/Error invoking|at [\w.$]+\(/.test(e.message),
        "报错里没有英文堆栈",
        e.message
      );
    }
  }

  console.log(
    fail === 0
      ? `\n全部通过（${pass} 项${skip ? `，跳过 ${skip} 项` : ""}）`
      : `\n${fail} 项未通过（共 ${pass + fail} 项）`
  );
  app.exit(fail === 0 ? 0 : 1);
})().catch((e) => {
  console.error("FAIL  测试抛错 —", e?.stack || e);
  app.exit(1);
});
