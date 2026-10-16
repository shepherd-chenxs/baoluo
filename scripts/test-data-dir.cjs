/*
 * SPDX-License-Identifier: GPL-3.0-only
 * Copyright (c) 2026 宝螺 / Baoluo contributors
 * 本文件属于「宝螺 / Baoluo」。除 GPL-3.0 外还适用 ADDITIONAL_TERMS.md 里的附加条款：
 * 分发时须保留来源署名；修改版对外分发时不得沿用「宝螺」名称与图标。
 */
/**
 * 数据目录（方案 A）逻辑测试 —— 必须在 Electron 下跑。
 *
 *   npm run test:datadir
 *
 * 全程在 tmp/datadirtest 沙箱里（把 appData 指过去），不碰真实用户数据：
 * 验证默认目录识别、指针文件读写、复制时跳过指针、复制后清空旧目录仍保留指针。
 */
const path = require("node:path");
const fs = require("node:fs");
const { app } = require("electron");

const ROOT = path.join(__dirname, "..");
const SANDBOX = path.join(ROOT, "tmp", "datadirtest");
fs.rmSync(SANDBOX, { recursive: true, force: true });
fs.mkdirSync(SANDBOX, { recursive: true });
app.setPath("appData", SANDBOX);
app.setPath("userData", path.join(SANDBOX, "Baoluo"));
// 默认数据目录现在是写死的 C:\Baoluo\data，测试用环境变量把它指到沙箱
process.env.BAOLUO_DATA_DIR = path.join(SANDBOX, "Baoluo");

let failures = 0;
function check(ok, label, extra = "") {
  console.log(`${ok ? "PASS" : "FAIL"}  ${label}${extra ? " — " + extra : ""}`);
  if (!ok) failures++;
}

(async () => {
  const u = require(path.join(ROOT, "dist", "main", "userData.js"));
  const src = path.join(SANDBOX, "Baoluo");
  fs.mkdirSync(path.join(src, "genie", "CharacterModels"), { recursive: true });
  fs.mkdirSync(path.join(src, "runtime"), { recursive: true });
  fs.writeFileSync(path.join(src, "genie", "CharacterModels", "a.bin"), Buffer.alloc(1024));
  fs.writeFileSync(path.join(src, "runtime", "python.exe"), Buffer.alloc(2048));
  fs.writeFileSync(path.join(src, "settings.json"), "{}");

  check(u.defaultDataDir() === src, "默认目录指向 appData/Baoluo");
  check(u.currentDataDir() === src, "未设置时当前目录=默认目录");

  const dst = path.join(SANDBOX, "D-drive", "宝螺数据");
  fs.mkdirSync(dst, { recursive: true }); // 真实流程：先建目录，复制成功后才写指针
  u.writeDataRoot(dst);
  check(fs.existsSync(u.dataRootPointerFile()), "指针文件已写入默认目录");
  check(u.currentDataDir() === path.resolve(dst), "当前目录已切到自定义目录");

  u.writeDataRoot(null);
  check(u.currentDataDir() === src, "清除指针后回到默认目录");
  const dst2 = path.join(SANDBOX, "target");
  const r = await u.copyDataDir(src, dst2);
  check(r.copied === 3, "复制了 3 个数据文件（指针文件被跳过）", `copied=${r.copied}`);
  check(fs.existsSync(path.join(dst2, "genie", "CharacterModels", "a.bin")), "子目录结构保留");
  check(fs.existsSync(path.join(dst2, "settings.json")), "根目录文件复制到位");
  check(!fs.existsSync(path.join(dst2, "data-root.txt")), "指针文件没有被复制过去");

  u.writeDataRoot(dst2);
  const cleared = u.clearDataDir(src);
  check(cleared.failed.length === 0, "清空旧目录没有失败项");
  check(fs.existsSync(u.dataRootPointerFile()), "清空后指针文件仍在");
  check(!fs.existsSync(path.join(src, "genie")), "旧目录里的数据已删除");
  check(u.currentDataDir() === path.resolve(dst2), "指向新目录的指针仍生效");

  console.log(failures ? `\n${failures} 项未通过` : "\n全部通过");
  app.exit(failures ? 1 : 0);
})().catch((e) => {
  console.error("FAIL  数据目录测试抛错 —", e?.message || e);
  app.exit(1);
});
