/**
 * bridge — stdio↔HTTP 桥（**纯 node**，bandi 连接器以 ELECTRON_RUN_AS_NODE=1 拉起它）。
 *
 * 为什么要有这座桥：
 *   ① Windows 的 Electron 主进程 stdin 不吐数据 —— MCP over stdio 没法直接跑在
 *      完整 Electron 运行时里，而能力层（抖音解析的离屏窗口、electron.net）又
 *      离不开 Electron —— 所以服务进程保持完整 Electron，桥另起一个纯 node。
 *   ② 桥负责服务的**生命周期**：先探测 127.0.0.1:<port>/mcp 的健康，不在就
 *      detached 拉起（服务常驻，桥随会话退出无影响 —— 作业状态在文件里，见 jobs.ts）。
 *   ③ 桥本身无状态：stdin 上每条 JSON-RPC POST 给服务，响应原样写回 stdout。
 *      通知（无 id）不转发 —— 服务无状态，无需理会。
 *
 * 桥怎么找到 electron 与 bundle：按两种目录布局推导（dev 仓库 / 安装目录），
 * 可用 BAOLUO_MCP_ELECTRON 显式指定。端口 BAOLUO_MCP_PORT（默认 8765）。
 */
import readline from "node:readline";
import fs from "node:fs";
import path from "node:path";
import { spawn } from "node:child_process";

const PORT = Number(process.env.BAOLUO_MCP_PORT || 8765);
const BASE = `http://127.0.0.1:${PORT}`;

function electronCandidates(): string[] {
  const out: string[] = [];
  if (process.env.BAOLUO_MCP_ELECTRON) out.push(process.env.BAOLUO_MCP_ELECTRON);
  const here = __dirname; // dev: <仓库>/dist/headless；打包: <安装>/resources/app.asar.unpacked/dist/headless
  out.push(path.resolve(here, "../../node_modules/electron/dist/electron.exe"));
  out.push(path.resolve(here, "../../../../Baoluo.exe"));
  return out;
}

async function health(): Promise<boolean> {
  try {
    const r = await fetch(`${BASE}/mcp`, { signal: AbortSignal.timeout(900) });
    return r.ok;
  } catch {
    return false;
  }
}

async function ensureService(): Promise<void> {
  if (await health()) return;
  const exe = electronCandidates().find((p) => fs.existsSync(p));
  if (!exe) {
    throw new Error(
      "找不到宝螺的 electron —— 确认宝螺已安装；装在非默认位置就用 BAOLUO_MCP_ELECTRON 指到 Baoluo.exe。"
    );
  }
  const bundle = path.resolve(__dirname, "bundle.cjs");
  if (!fs.existsSync(bundle)) throw new Error(`找不到 headless bundle：${bundle}`);
  // ⚠️ 桥自己是被 ELECTRON_RUN_AS_NODE=1 拉起来的（纯 node）；把这个变量原样
  // 遗传给服务进程，服务就会被"降级"成纯 node —— app/net/离屏窗口全没了。
  // 所以这里必须显式摘掉。
  const env = { ...process.env };
  delete env.ELECTRON_RUN_AS_NODE;
  const child = spawn(exe, [bundle, "--service"], {
    detached: true,
    stdio: "ignore",
    env,
    windowsHide: true,
  });
  child.unref();
  const deadline = Date.now() + 20_000;
  while (Date.now() < deadline) {
    if (await health()) return;
    await new Promise((r) => setTimeout(r, 300));
  }
  throw new Error(`宝螺 headless 服务没能起来（${BASE}）—— 在终端手动跑一次看报错：\n  "${exe}" "${bundle}" --service`);
}

async function relay(line: string): Promise<void> {
  let msg: any;
  try {
    msg = JSON.parse(line.trim());
  } catch {
    return; // 噪音行丢弃（与 protocol.ts 的 stdio 纪律一致）
  }
  if (msg.id === undefined || msg.id === null) return; // 通知不转发
  try {
    const r = await fetch(`${BASE}/mcp`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: line,
      signal: AbortSignal.timeout(120_000),
    });
    const body = await r.text();
    process.stdout.write(body.trim() + "\n");
  } catch (e: any) {
    process.stdout.write(
      JSON.stringify({
        jsonrpc: "2.0",
        id: msg.id,
        error: { code: -32603, message: `宝螺 headless 服务不可达：${String(e?.message ?? e)}` },
      }) + "\n"
    );
  }
}

async function main(): Promise<void> {
  await ensureService();
  console.error(`[baoluo-bridge] 服务就绪 ${BASE}`);
  const rl = readline.createInterface({ input: process.stdin, terminal: false });
  rl.on("line", (line) => {
    if (line.trim()) void relay(line);
  });
  rl.on("close", () => process.exit(0));
}

main().catch((e: any) => {
  console.error("[baoluo-bridge] fatal:", e?.message ?? e);
  process.exit(1);
});
