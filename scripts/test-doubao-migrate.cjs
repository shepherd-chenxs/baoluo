/**
 * 「豆包登录态随数据目录迁移一起走」测试（必须在 Electron 下跑）。
 *
 *   npm run test:doubao-migrate
 *
 * 分两个进程（Chromium 对同一 userData 目录有独占锁，父进程活着时子进程起不来）：
 *   --phase1：在源目录的豆包分区写 cookie → 落盘 → copyDataDir 复制到新目录
 *   --phase2：以新目录为 userData 启动，看能不能读到那个 cookie
 *
 * 这个用例是回归测试：早期只用 flushStorageData() 刷盘，cookie 库其实没落盘，
 * 复制过去后新目录里没有登录态（实测源/目标文件哈希相同但都不含该 cookie）。
 */
const path = require("node:path");
const fs = require("node:fs");
const crypto = require("node:crypto");
const { app, session } = require("electron");
const ROOT = path.join(__dirname, "..");

const SRC = path.join(ROOT, "tmp", "doubao-migrate", "src");
const DST = path.join(ROOT, "tmp", "doubao-migrate", "dst");
const RESULT = path.join(ROOT, "tmp", "doubao-migrate", "result.txt");
const COOKIE = "baoluo-test-login";
const PHASE2 = process.argv.includes("--phase2");
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const cookieFile = (root) => path.join(root, "Partitions", "doubao", "Network", "Cookies");
const hasMarker = (p) => {
  try {
    return fs.readFileSync(p, "latin1").includes(COOKIE);
  } catch {
    return false;
  }
};
const hash = (p) => crypto.createHash("sha256").update(fs.readFileSync(p)).digest("hex").slice(0, 16);

let failures = 0;
const check = (ok, label, extra = "") => {
  console.log(`${ok ? "PASS" : "FAIL"}  ${label}${extra ? " — " + extra : ""}`);
  if (!ok) failures++;
};

if (PHASE2) {
  app.setPath("userData", DST);
  (async () => {
    await app.whenReady();
    const ses = session.fromPartition("persist:doubao");
    const hit = (await ses.cookies.get({ url: "https://www.doubao.com" })).find(
      (c) => c.name === COOKIE
    );
    const ok = !!hit && hit.value === "kept";
    fs.writeFileSync(
      RESULT,
      `${ok ? "PASS" : "FAIL"}  新数据目录里仍能读到登录 cookie — value=${hit ? hit.value : "none"}\n`,
      "utf8"
    );
    console.log(
      `${ok ? "PASS" : "FAIL"}  新数据目录里仍能读到登录 cookie — value=${hit ? hit.value : "none"}`
    );
    app.exit(ok ? 0 : 1);
  })();
  return;
}

fs.rmSync(path.join(ROOT, "tmp", "doubao-migrate"), { recursive: true, force: true });
fs.mkdirSync(SRC, { recursive: true });
app.setPath("userData", SRC);
app.setPath("appData", path.join(ROOT, "tmp", "doubao-migrate", "appdata"));

(async () => {
  await app.whenReady();
  const doubao = require(path.join(ROOT, "dist", "main", "doubao.js"));
  const ses = session.fromPartition("persist:doubao");

  await ses.cookies.set({
    url: "https://www.doubao.com",
    name: COOKIE,
    value: "kept",
    expirationDate: Math.floor(Date.now() / 1000) + 3600,
  });
  doubao.flushDoubaoStorage();
  await sleep(2500);
  doubao.flushDoubaoStorage();
  await sleep(800);

  check(hasMarker(cookieFile(SRC)), "落盘后源目录的 Cookies 文件里能搜到该 cookie");

  const { copyDataDir } = require(path.join(ROOT, "dist", "main", "userData.js"));
  const r = await copyDataDir(SRC, DST);
  check(r.copied > 0 && r.skipped.length === 0, "数据目录复制完成且无跳过项", `copied=${r.copied} skipped=${r.skipped.length}`);
  check(fs.existsSync(cookieFile(DST)), "新目录里有豆包分区的 Cookies 文件");
  check(
    hash(cookieFile(SRC)) === hash(cookieFile(DST)),
    "新目录的 Cookies 文件与源目录一致（内容哈希）",
    `${hash(cookieFile(SRC))} vs ${hash(cookieFile(DST))}`
  );
  check(hasMarker(cookieFile(DST)), "新目录的 Cookies 文件里带着该 cookie");

  console.log(failures ? `\n${failures} 项未通过` : "\n第 1 趟全部通过");
  app.exit(failures ? 1 : 0);
})().catch((e) => {
  console.error("FAIL  抛错 —", e?.stack || e?.message || e);
  app.exit(1);
});
