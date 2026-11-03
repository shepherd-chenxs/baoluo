/**
 * 「豆包登录态随数据目录迁移」测试入口（npm run test:doubao-migrate）。
 * 分两个进程跑，理由见 test-doubao-migrate.cjs 顶部注释。
 */
const path = require("node:path");
const fs = require("node:fs");
const { spawnSync } = require("node:child_process");

const ROOT = path.join(__dirname, "..");
const ELECTRON = path.join(ROOT, "node_modules", "electron", "dist", "electron.exe");
const CASE = path.join(__dirname, "test-doubao-migrate.cjs");
const RESULT = path.join(ROOT, "tmp", "doubao-migrate", "result.txt");

function run(args) {
  return spawnSync(ELECTRON, [CASE, ...args], {
    encoding: "utf8",
    env: { ...process.env },
    timeout: 180000,
  });
}

console.log("=== 第 1 趟：写 cookie、落盘、复制数据目录 ===");
const p1 = run([]);
process.stdout.write(p1.stdout || "");
if (p1.stderr) process.stderr.write(p1.stderr);
if (p1.status !== 0) {
  console.log("\n第 1 趟未通过，跳过第 2 趟");
  process.exit(1);
}

console.log("\n=== 第 2 趟：以新数据目录启动，读 cookie ===");
fs.rmSync(RESULT, { force: true });
const p2 = run(["--phase2"]);
process.stdout.write(p2.stdout || "");
if (p2.stderr) process.stderr.write(p2.stderr);

let line = "";
try {
  line = fs.readFileSync(RESULT, "utf8").trim();
} catch {
  line = "";
}
const ok = p2.status === 0 && (/^PASS/.test(line) || /PASS\s+新数据目录里仍能读到登录 cookie/.test(p2.stdout || ""));
if (!ok) {
  console.log(line || "FAIL  新数据目录里仍能读到登录 cookie — 第 2 趟没写出结果");
  console.log("\n1 项未通过");
  process.exit(1);
}
console.log(line || "PASS  新数据目录里仍能读到登录 cookie");
console.log("\n全部通过");
process.exit(0);
