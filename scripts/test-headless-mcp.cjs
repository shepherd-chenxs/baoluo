/**
 * 冒烟测试：宝螺 headless MCP 服务（协议 + 作业生命周期）。
 *
 * 覆盖：
 *   ① initialize 握手 —— serverInfo=baoluo、protocolVersion 回显、capabilities.tools
 *   ② tools/list —— 12 个工具（9 能力 + 3 作业），名字与 schema 都在
 *   ③ ping
 *   ④ tools/call baoluo_job_status（不存在的 id）→ isError + 人话
 *   ⑤ tools/call baoluo_transcribe（不存在的文件）→ 提交成功返回 jobId
 *   ⑥ 轮询 job_status —— detached worker 真被拉起、跑完落成 failed，错误是"文件找不到了"
 *      （离线可测：不存在文件在碰 whisper 之前就被挡掉）
 *   ⑦ job_cancel 已结束的作业 → 说"不用取消"
 *   ⑧ job_list 包含刚才那条
 *
 * 隔离：BAOLUO_DATA_DIR 指到临时目录，不碰真实 %APPDATA%/Baoluo。
 * 前置：npm run build:headless（或 build:main，二者产物任一在即可）。
 * 跑法：node scripts/test-headless-mcp.cjs
 */
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { spawn } = require("node:child_process");

const ROOT = path.resolve(__dirname, "..");
const ELECTRON = require("electron"); // 纯 node 下这个包导出的是 electron.exe 的路径

let failed = 0;
const check = (label, ok, detail = "") => {
  console.log(`  ${ok ? "✓" : "✗"} ${label}${ok ? "" : " — " + detail}`);
  if (!ok) failed += 1;
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// 入口 = 桥（与 bandi 连接器同款 spawn 形态）；桥会确保服务进程在
function resolveEntry() {
  const bridge = path.join(ROOT, "dist", "headless", "bridge.cjs");
  if (fs.existsSync(bridge)) return bridge;
  const plain = path.join(ROOT, "dist", "headless", "index.js");
  if (fs.existsSync(plain)) return plain;
  return null;
}

function startServer(entry, dataDir) {
  // 与 bandi 连接器同款：桥以 ELECTRON_RUN_AS_NODE=1 被拉起（纯 node，stdin 可用），
  // 服务进程由桥确保在（完整 Electron 运行时，桥会摘掉这个环境变量）
  const child = spawn(ELECTRON, [entry], {
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
  child.stderr.on("data", () => {}); // 日志只进 stderr，测试不打印（崩溃时 dump 尾部）
  let stderrTail = "";
  child.stderr.on("data", (c) => {
    stderrTail = (stderrTail + String(c)).slice(-800);
  });

  const pending = new Map(); // id → resolve
  let nextId = 1;
  const buf = [];
  let waiters = [];
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
        continue; // 壳层噪音，协议层允许丢弃
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
    const w = waiters;
    waiters = [];
    for (const fn of w) fn();
  });

  const request = (method, params, timeoutMs = 30_000) =>
    new Promise((resolve, reject) => {
      const id = nextId++;
      const timer = setTimeout(() => {
        pending.delete(String(id));
        reject(new Error(`请求超时：${method}（${timeoutMs}ms）`));
      }, timeoutMs);
      pending.set(String(id), { resolve: (msg) => { clearTimeout(timer); resolve(msg); } });
      child.stdin.write(JSON.stringify({ jsonrpc: "2.0", id, method, params }) + "\n");
    });

  const notify = (method, params) => {
    child.stdin.write(JSON.stringify({ jsonrpc: "2.0", method, params }) + "\n");
  };

  return { child, request, notify, stderrTail: () => stderrTail, waitFlush: () => new Promise((r) => waiters.push(r)) };
}

async function main() {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "baoluo-headless-"));
  const entry = resolveEntry();
  check("headless 入口已构建", !!entry, entry ? "" : "没有 dist/headless/bundle.cjs（先 npm run build:headless）也没有 dist/headless/index.js");
  if (!entry) {
    fs.rmSync(tmp, { recursive: true, force: true });
    process.exit(1);
  }
  console.log(`  入口：${entry}`);

  const server = startServer(entry, tmp);
  const text = (msg) => msg?.result?.content?.[0]?.text ?? "";
  const isErr = (msg) => msg?.result?.isError === true;

  try {
    console.log("\n① initialize 握手");
    const init = await server.request("initialize", {
      protocolVersion: "2025-06-18",
      capabilities: {},
      clientInfo: { name: "smoke", version: "0" },
    });
    check("serverInfo.name = baoluo", init?.result?.serverInfo?.name === "baoluo", JSON.stringify(init?.result?.serverInfo));
    check("protocolVersion 回显客户端要的那一版", init?.result?.protocolVersion === "2025-06-18", String(init?.result?.protocolVersion));
    check("capabilities.tools 声明了", !!init?.result?.capabilities?.tools);
    server.notify("notifications/initialized", {});

    console.log("\n② ping");
    const ping = await server.request("ping", {});
    check("ping → 空 result", ping?.result && Object.keys(ping.result).length === 0, JSON.stringify(ping?.result));

    console.log("\n③ tools/list");
    const list = await server.request("tools/list", {});
    const tools = list?.result?.tools ?? [];
    const names = tools.map((t) => t.name);
    const expect = [
      "baoluo_parse_link",
      "baoluo_download",
      "baoluo_transcribe",
      "baoluo_write_script",
      "baoluo_tts",
      "baoluo_compose_dialogue",
      "baoluo_sniff",
      "baoluo_write_storyboard",
      "baoluo_generate_image",
      "baoluo_job_status",
      "baoluo_job_list",
      "baoluo_job_cancel",
    ];
    check("工具数量 = 12（9 能力 + 3 作业）", tools.length === 12, `实际 ${tools.length}：${names.join(",")}`);
    check("12 个名字一个不少", expect.every((n) => names.includes(n)), expect.filter((n) => !names.includes(n)).join(","));
    check("每个工具都带 inputSchema", tools.every((t) => t.inputSchema && t.inputSchema.type === "object"));

    console.log("\n④ 作业工具：查一个不存在的 id");
    const miss = await server.request("tools/call", { name: "baoluo_job_status", arguments: { jobId: "j_nonexistent" } });
    check("isError=true + 说人话", isErr(miss) && /没找到作业/.test(text(miss)), `${isErr(miss)} ${text(miss).slice(0, 80)}`);

    console.log("\n⑤ 提交一个必败作业（文件不存在，碰不到 whisper 就挡掉）");
    const missing = path.join(tmp, "missing.mp4");
    const sub = await server.request("tools/call", {
      name: "baoluo_transcribe",
      arguments: { inputPath: missing },
    });
    const jobId = (text(sub).match(/j_[a-z0-9]+/) || [])[0];
    check("提交即返回 jobId", !!jobId, text(sub).slice(0, 100));

    console.log("\n⑥ 轮询到终态：worker 独立进程真跑完并落账");
    let final = null;
    for (let i = 0; i < 60 && !final; i++) {
      await sleep(1000);
      const st = await server.request("tools/call", { name: "baoluo_job_status", arguments: { jobId } });
      const body = JSON.parse(text(st));
      if (body.state === "failed" || body.state === "done" || body.state === "cancelled") final = body;
    }
    check("作业终态 = failed（文件不存在）", final?.state === "failed", JSON.stringify(final ?? {}).slice(0, 160));
    check("错误文案点名了文件", /文件找不到了/.test(final?.error ?? ""), String(final?.error ?? "").slice(0, 120));

    console.log("\n⑦ 取消一个已结束的作业");
    const cancel = await server.request("tools/call", { name: "baoluo_job_cancel", arguments: { jobId } });
    check("说清「已经失败，不用取消」", /不用取消|已经失败/.test(text(cancel)), text(cancel).slice(0, 100));

    console.log("\n⑧ job_list 里能看到它");
    const listing = await server.request("tools/call", { name: "baoluo_job_list", arguments: {} });
    check("列表包含刚才的作业", text(listing).includes(jobId), text(listing).slice(0, 160));
  } catch (e) {
    check("测试过程中没有异常", false, String(e?.message ?? e));
  } finally {
    try { server.child.kill(); } catch { /* 已退 */ }
    await sleep(500);
    try { fs.rmSync(tmp, { recursive: true, force: true }); } catch { /* 删不掉就算了 */ }
  }

  if (failed) console.log(`\n（服务端 stderr 尾部）\n${server.stderrTail().slice(-400)}`);
  console.log(failed ? `\n✗ ${failed} 项没过` : "\n✓ 全部通过");
  process.exit(failed ? 1 : 0);
}

main();
