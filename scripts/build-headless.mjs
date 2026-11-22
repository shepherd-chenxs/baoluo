/**
 * 打包 headless 入口为单文件 CJS bundle。
 *
 *   · external: electron —— 运行时由 electron 本体提供（headless 就是 electron 跑的）；
 *               ffmpeg-static —— 二进制包靠 __dirname 定位 exe，必须保持外部，
 *               从 bundle 所在目录向上解析会命中 app.asar.unpacked/node_modules 里的那份。
 *   · 其余依赖（node-edge-tts / opencc-js / jsonrepair / ws …）全部打进单文件 ——
 *     免去「asar 里的 node_modules 从 unpacked 入口解析不到」的纠结。
 *
 * 产物（electron-builder.yml 已把 dist/headless/** 解出 asar）：
 *   · dist/headless/bundle.cjs —— 服务 / worker 入口（完整 Electron 运行时）
 *   · dist/headless/bridge.cjs —— stdio↔HTTP 桥（纯 node，bandi 连接器 spawn 它，
 *     连接器 env 里带 ELECTRON_RUN_AS_NODE=1）
 */
import { build } from "esbuild";

await build({
  entryPoints: [
    { in: "src/headless/index.ts", out: "bundle" },
    { in: "src/headless/bridge.ts", out: "bridge" },
  ],
  bundle: true,
  platform: "node",
  target: "node20",
  format: "cjs",
  outdir: "dist/headless",
  outExtension: { ".js": ".cjs" },
  external: ["electron", "ffmpeg-static"],
  sourcemap: false,
  legalComments: "none",
  logLevel: "info",
});
