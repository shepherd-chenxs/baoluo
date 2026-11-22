/**
 * 端到端验证（需要联网，不挂进 npm test）：宝螺 headless 全链真跑一条配音。
 *
 * 链路：bridge（纯 node，ELECTRON_RUN_AS_NODE）→ 确保 HTTP 服务在 → 提交
 * baoluo_tts 作业 → detached worker 用 Edge TTS 真合成 → 轮询到 done → 校验产物。
 *
 * 跑法：node scripts/e2e-headless-tts.cjs
 */
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { spawn } = require("node:child_process");

const ROOT = path.resolve(__dirname, "..");
const ELECTRON = require("electron");

let failed = 0;
const check = (label, ok, detail = "") => {
  console.log(`  ${ok ? "✓" : "✗"} ${label}${ok ? "" : " — " + detail}`);
  if (!ok) failed += 1;
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function startBridge(dataDir) {
  const bridge = path.join(ROOT, "dist", "headless", "bridge.cjs");
  if (!fs.existsSync(bridge)) throw new Error("先 npm run build:headless");
  const child = spawn(ELECTRON, [bridge], {
    cwd: ROOT,
    env: {
      ...process.env,
      BAOLUO_DATA_DIR: dataDir,
      ELECTRON_RUN_AS_NODE: "1",
      ELECTRON_DISABLE_SECURITY_WARNINGS: "1",
    },
    stdio: ["pipe", "pipe", "pipe"],
    windowsHide: true,
  });
  const pending = new Map();
  let nextId = 1;
  const buf = [];
  child.stdout.on("data", (chunk) => {
    buf.push(String(chunk));
    let all = buf.join("");
    let idx;
    while ((idx = all.indexOf("\n")) >= 0) {
      const line = all.slice(0, idx).trim();
      all = all.slice(idx + 1);
      if (!line) continue;
      let msg;
      try {
        msg = JSON.parse(line);
      } catch {
        continue;
      }
      const key = msg.id !== undefined && msg.id !== null ? String(msg.id) : null;
      if (key && pending.has(key)) {
        const { resolve } = pending.get(key);
        pending.delete(key);
        resolve(msg);
      }
    }
    buf.length = 0;
    buf.push(all);
  });
  const request = (method, params, timeoutMs = 60_000) =>
    new Promise((resolve, reject) => {
      const id = nextId++;
      const timer = setTimeout(() => {
        pending.delete(String(id));
        reject(new Error(`请求超时：${method}`));
      }, timeoutMs);
      pending.set(String(id), { resolve: (msg) => { clearTimeout(timer); resolve(msg); } });
      child.stdin.write(JSON.stringify({ jsonrpc: "2.0", id, method, params }) + "\n");
    });
  return { child, request };
}

async function main() {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "baoluo-e2e-"));
  const server = startBridge(tmp);
  const text = (msg) => msg?.result?.content?.[0]?.text ?? "";

  try {
    await server.request("initialize", {
      protocolVersion: "2025-06-18",
      capabilities: {},
      clientInfo: { name: "e2e", version: "0" },
    });
    console.log("  ✓ 握手成功（服务已由桥拉起）");

    const sub = await server.request("tools/call", {
      name: "baoluo_tts",
      arguments: { text: "你好，我是宝螺的 headless 服务，这条配音是班底的数字员工派过来的。", voice: "zh-CN-XiaoxiaoNeural" },
    });
    const jobId = (text(sub).match(/j_[a-z0-9]+/) || [])[0];
    check("tts 作业已提交", !!jobId, text(sub).slice(0, 120));

    let final = null;
    for (let i = 0; i < 120 && !final; i++) {
      await sleep(1000);
      const st = await server.request("tools/call", { name: "baoluo_job_status", arguments: { jobId } });
      const body = JSON.parse(text(st));
      if (["done", "failed", "cancelled"].includes(body.state)) final = body;
    }
    check("tts 作业终态 = done", final?.state === "done", JSON.stringify(final ?? {}).slice(0, 200));
    const out = final?.outputPath ?? "";
    check("产物 mp3 落盘且非空", !!out && fs.existsSync(out) && fs.statSync(out).size > 5000,
      out ? `${out}（${fs.existsSync(out) ? fs.statSync(out).size : 0} 字节）` : "没有 outputPath");

    // 收尾：把演示产物留下给用户听一眼
    const keep = path.join(tmp, "keep");
    if (out && fs.existsSync(out)) {
      fs.mkdirSync(keep, { recursive: true });
      fs.copyFileSync(out, path.join(keep, "e2e-tts.mp3"));
      console.log(`  产物副本：${path.join(keep, "e2e-tts.mp3")}`);
    }
  } catch (e) {
    check("E2E 过程无异常", false, String(e?.message ?? e));
  } finally {
    try { server.child.kill(); } catch { /* 已退 */ }
    await sleep(300);
  }

  console.log(failed ? `\n✗ ${failed} 项没过` : "\n✓ 全部通过");
  process.exit(failed ? 1 : 0);
}

main();
