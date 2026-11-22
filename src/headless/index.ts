/**
 * index — 宝螺的无窗口入口（headless）。
 *
 * 三种模式，按 argv 分流（同一份 bundle，不同启动参数）：
 *   · 默认              = MCP over stdio —— stdin 可用的环境用（Linux/macOS）；
 *                         Windows 上 Electron 主进程 stdin 不工作，走下面那条。
 *   · --service         = MCP over HTTP（127.0.0.1:<port>/mcp）—— Windows 主形态。
 *                         常驻服务，由 bridge 按需拉起（也可手动/自启）。
 *   · --job-file <文件> = 作业 worker —— jobs.ts 以 detached 方式拉起的执行体，
 *                         跑完写回 job 文件即退（见 worker.ts）。
 *
 * ⚠️ 顺序敏感：applyChromiumSwitches（要赶在 app ready 前）与 setupUserDataDir
 * （要赶在任何能力模块 import 前 —— genie-manager 单例 import 即建目录，
 * test-genie-install-env.cjs 记录过这个坑）。因此下面的能力模块一律动态 import。
 *
 * bandi 连接器登记（stdio 桥形态）：
 *   command: <electron 或 Baoluo.exe>
 *   env:     { ELECTRON_RUN_AS_NODE: "1" }
 *   args:    [bridge.cjs 路径]
 */
import { app } from "electron";
import fs from "node:fs";
import path from "node:path";
import { applyChromiumSwitches } from "../main/chromium-switches";
import { setupUserDataDir } from "../main/userData";

applyChromiumSwitches();
setupUserDataDir();

/** 宝螺自己的版本号（脚本模式下 app.getVersion() 回落成 Electron 的版本，不能直接用） */
function baoluoVersion(): string {
  // dev: dist/headless → 仓库根的 package.json；打包：app.asar.unpacked → resources/package.json
  for (const p of [path.resolve(__dirname, "../../package.json"), path.resolve(__dirname, "../../../../package.json")]) {
    try {
      return String(JSON.parse(fs.readFileSync(p, "utf-8")).version ?? "");
    } catch {
      /* 换下一个候选 */
    }
  }
  return "unknown";
}

// 窗口全关也不退出：headless 本来就没有常规窗口，抖音解析的离屏窗口用完即毁，
// Electron 默认行为会在那一刻把整个进程带走 —— 而服务还要在 HTTP 上说话
app.on("window-all-closed", () => {});

const SERVICE_PORT = Number(process.env.BAOLUO_MCP_PORT || 8765);

async function main(): Promise<void> {
  const argv = process.argv.slice(2);
  const ready = app.whenReady();

  if (argv.includes("--job-file")) {
    const file = argv[argv.indexOf("--job-file") + 1] ?? "";
    const { runJobWorker } = await import("./worker");
    await ready;
    await runJobWorker(file);
    // 作业跑完，worker 功成身退（不挂任何常驻句柄）
    process.exit(0);
    return;
  }

  const { getToolDefs, dispatchToolCall } = await import("./tooldefs");
  const opts = {
    serverInfo: { name: "baoluo", version: baoluoVersion() },
    ready,
    listTools: getToolDefs,
    callTool: dispatchToolCall,
  };

  if (argv.includes("--service")) {
    const { startHttpServer } = await import("./protocol");
    await ready;
    const port = await startHttpServer(opts, SERVICE_PORT);
    console.error(`[baoluo-headless] HTTP 服务已就绪：http://127.0.0.1:${port}/mcp`);
    // http server 的监听句柄会撑住事件循环，进程常驻
    return;
  }

  const { startStdioServer } = await import("./protocol");
  await ready;
  startStdioServer(opts);
  console.error("[baoluo-headless] MCP stdio 服务已就绪");
}

main().catch((e: any) => {
  console.error("[headless] fatal:", e?.stack || e?.message || e);
  process.exitCode = 1;
});
