/**
 * protocol — 最小 MCP（Model Context Protocol）服务，双传输：
 *
 *   · stdio（换行分帧 JSON-RPC） —— 给 stdin 可用的环境（Linux/macOS 的
 *     Electron 主进程）用。**Windows 上 Electron 主进程的 stdin 不吐数据**
 *     （老已知问题），所以 Windows 走下面那条。
 *   · HTTP（127.0.0.1:<port>/mcp，POST 一条 JSON-RPC 回一条） —— Windows 主形态。
 *     进程由 bridge（src/headless/bridge.ts）按需拉起并常驻，服务无状态：
 *     每条请求独立处理，会话/进程重启都不影响（作业状态在文件里，见 jobs.ts）。
 *
 * 为什么手写、不用官方 SDK：只用到 4 个方法（initialize / tools/list /
 * tools/call / ping）+ 少量通知，200 行解决，零新运行时依赖 —— 符合宝螺与
 * 班底共同的零依赖哲学。协议行为由 scripts/test-headless-mcp.cjs 钉住。
 *
 * **stdout/stderr 纪律**：HTTP 模式无所谓；stdio 模式下 stdout 是协议通道，
 * 任何日志只准走 stderr。
 */
import http from "node:http";
import readline from "node:readline";

export interface ToolDef {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
}

export interface ToolCallResult {
  /** 给模型看的正文（纯文本；结构化信息序列化在里面） */
  text: string;
  /** true = 这次调用业务失败（错误作为结果返回，不炸协议层） */
  isError?: boolean;
}

export interface McpServerOptions {
  serverInfo: { name: string; version: string };
  listTools: () => ToolDef[];
  /** 工具执行。抛错会被收成 isError 结果，不断协议 */
  callTool: (name: string, args: Record<string, unknown>) => Promise<ToolCallResult>;
  /** 能力就绪的门（app.whenReady）—— tools/call 前会等它；list 不等 */
  ready?: Promise<void>;
}

const METHODS = new Set(["initialize", "tools/list", "tools/call", "ping"]);

/** 处理一条 JSON-RPC 请求（有 id），返回响应对象；通知走 handleNotification */
async function handleRequest(
  id: number | string,
  method: string,
  params: any,
  opts: McpServerOptions
): Promise<Record<string, unknown>> {
  if (!METHODS.has(method)) {
    return { jsonrpc: "2.0", id, error: { code: -32601, message: `方法不存在：${method}` } };
  }
  if (method === "initialize") {
    // 协议版本回显客户端要的那一版：本服务实现的子集在哪个版本里都成立
    return {
      jsonrpc: "2.0",
      id,
      result: {
        protocolVersion:
          typeof params?.protocolVersion === "string" ? params.protocolVersion : "2024-11-05",
        capabilities: { tools: {} },
        serverInfo: opts.serverInfo,
      },
    };
  }
  if (method === "ping") {
    return { jsonrpc: "2.0", id, result: {} };
  }
  if (method === "tools/list") {
    return { jsonrpc: "2.0", id, result: { tools: opts.listTools() } };
  }
  // tools/call
  const name = String(params?.name ?? "");
  const args = (params?.arguments ?? {}) as Record<string, unknown>;
  try {
    if (opts.ready) await opts.ready;
    const r = await opts.callTool(name, args);
    return {
      jsonrpc: "2.0",
      id,
      result: {
        content: [{ type: "text", text: r.text }],
        ...(r.isError ? { isError: true } : {}),
      },
    };
  } catch (e: any) {
    // 工具抛错 = 业务失败，按 MCP 约定作为结果返回（isError），不断协议
    return { jsonrpc: "2.0", id, result: { content: [{ type: "text", text: String(e?.message ?? e) }], isError: true } };
  }
}

/** ---------------------------------------------------------------- HTTP */

export const MCP_HTTP_PATH = "/mcp";

/** 起一个 127.0.0.1 的 JSON-RPC over HTTP 服务。EADDRINUSE 时探测是不是同类服务：是 → 安静退出 */
export function startHttpServer(opts: McpServerOptions, port: number): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = http.createServer((req, res) => {
      if (req.method === "GET" && (req.url ?? "").split("?")[0] === MCP_HTTP_PATH) {
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ service: opts.serverInfo.name, version: opts.serverInfo.version, mcp: true }));
        return;
      }
      if (req.method !== "POST" || (req.url ?? "").split("?")[0] !== MCP_HTTP_PATH) {
        res.writeHead(404, { "content-type": "application/json" });
        res.end(JSON.stringify({ error: "只有 GET/POST /mcp" }));
        return;
      }
      const chunks: Buffer[] = [];
      req.on("data", (c) => chunks.push(c as Buffer));
      req.on("end", async () => {
        let msg: any;
        try {
          msg = JSON.parse(Buffer.concat(chunks).toString("utf-8"));
        } catch {
          res.writeHead(400, { "content-type": "application/json" });
          res.end(JSON.stringify({ jsonrpc: "2.0", id: null, error: { code: -32700, message: "JSON 解析失败" } }));
          return;
        }
        if (msg === null || typeof msg !== "object" || typeof msg.method !== "string") {
          res.writeHead(400, { "content-type": "application/json" });
          res.end(JSON.stringify({ jsonrpc: "2.0", id: null, error: { code: -32600, message: "不像一条 JSON-RPC" } }));
          return;
        }
        // 通知：无 id，无响应体（202 接收即可）
        if (msg.id === undefined || msg.id === null) {
          res.writeHead(202, { "content-type": "application/json" });
          res.end("{}");
          return;
        }
        try {
          const out = await handleRequest(msg.id, msg.method, msg.params ?? {}, opts);
          res.writeHead(200, { "content-type": "application/json" });
          res.end(JSON.stringify(out));
        } catch (e: any) {
          res.writeHead(200, { "content-type": "application/json" });
          res.end(JSON.stringify({ jsonrpc: "2.0", id: msg.id, error: { code: -32603, message: String(e?.message ?? e) } }));
        }
      });
    });
    server.on("error", (e: any) => {
      if (e?.code === "EADDRINUSE") {
        // 端口被占：探测一下是不是已经在跑的宝螺服务 —— 是就安静收工
        fetch(`http://127.0.0.1:${port}${MCP_HTTP_PATH}`, { signal: AbortSignal.timeout(800) })
          .then((r) => r.json())
          .then((j: any) => {
            if (j?.service === opts.serverInfo.name) {
              console.error(`[baoluo-headless] ${port} 上已有一个宝螺服务，本实例不重复起`);
              process.exit(0);
            }
            reject(new Error(`端口 ${port} 被别的程序占着 —— 用 BAOLUO_MCP_PORT 换一个。`));
          })
          .catch(() => reject(new Error(`端口 ${port} 被别的程序占着 —— 用 BAOLUO_MCP_PORT 换一个。`)));
        return;
      }
      reject(e);
    });
    server.listen(port, "127.0.0.1", () => resolve(port));
  });
}

/** ---------------------------------------------------------------- stdio */

/** stdio 传输：Windows 的 Electron 主进程 stdin 不工作，那条路走 bridge+HTTP */
export function startStdioServer(opts: McpServerOptions): void {
  const rl = readline.createInterface({ input: process.stdin, terminal: false });
  rl.on("line", (line) => {
    const trimmed = line.trim();
    if (!trimmed) return;
    let msg: any;
    try {
      msg = JSON.parse(trimmed);
    } catch {
      console.error(`[mcp] 忽略一行非 JSON 输出：${trimmed.slice(0, 80)}`);
      return;
    }
    if (msg === null || typeof msg !== "object" || typeof msg.method !== "string") return;
    if (msg.id === undefined || msg.id === null) return; // 通知静默
    handleRequest(msg.id, msg.method, msg.params ?? {}, opts)
      .then((out) => process.stdout.write(JSON.stringify(out) + "\n"))
      .catch((e) => {
        console.error(`[mcp] 处理 ${msg.method} 异常：${e?.message ?? e}`);
        write({ jsonrpc: "2.0", id: msg.id, error: { code: -32603, message: String(e?.message ?? e) } });
      });
  });
  rl.on("close", () => process.exit(0));
}

function write(msg: unknown): void {
  process.stdout.write(JSON.stringify(msg) + "\n");
}
