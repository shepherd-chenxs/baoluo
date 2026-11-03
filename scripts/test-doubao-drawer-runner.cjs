/**
 * 内嵌豆包抽屉测试的入口（npm run test:doubao 跑这个）。
 *
 * 为什么要分两个进程：
 *   「登录态跨重启保留」必须真的重启一次才测得准——同一个进程里 session 是复用的。
 *   但 Chromium 对同一个 userData 目录有独占锁，父进程还活着时子进程起不来，
 *   所以由本 runner 先跑完第 1 趟、等它退出，再起第 2 趟。
 *
 * 用法：node scripts/test-doubao-drawer-runner.cjs
 */
const path = require("node:path");
const fs = require("node:fs");
const { spawnSync } = require("node:child_process");

const ROOT = path.join(__dirname, "..");
const ELECTRON = path.join(ROOT, "node_modules", "electron", "dist", "electron.exe");
const CASE = path.join(__dirname, "test-doubao-drawer.cjs");
const SANDBOX = path.join(ROOT, "tmp", "doubao-drawer-test");
const PHASE2_OUT = path.join(SANDBOX, "phase2-result.txt");

function run(args) {
  return spawnSync(ELECTRON, [CASE, ...args], {
    encoding: "utf8",
    env: { ...process.env },
    timeout: 180000,
  });
}

console.log("=== 第 1 趟：功能检查 ===");
const p1 = run([]);
process.stdout.write(p1.stdout || "");
if (p1.stderr) process.stderr.write(p1.stderr);

if (p1.status !== 0) {
  console.log("\n第 1 趟未通过，跳过第 2 趟");
  process.exit(1);
}

console.log("\n=== 第 2 趟：重启后登录态检查 ===");
fs.rmSync(PHASE2_OUT, { force: true });
const p2 = run(["--phase2"]);
process.stdout.write(p2.stdout || "");
if (p2.stderr) process.stderr.write(p2.stderr);

let line = "";
try {
  line = fs.readFileSync(PHASE2_OUT, "utf8").trim();
} catch {
  line = "";
}
const ok = p2.status === 0 && (/^PASS/.test(line) || /PASS\s+重启后登录态仍在/.test(p2.stdout || ""));
if (!ok) {
  console.log(line || "FAIL  重启后登录态仍在（分区 cookie 保留） — 第 2 趟没写出结果");
  console.log("\n1 项未通过");
  process.exit(1);
}
console.log(line || "PASS  重启后登录态仍在（分区 cookie 保留）");
console.log("\n全部通过");
process.exit(0);
