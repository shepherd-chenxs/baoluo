import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import { readFileSync } from "node:fs";
import path from "node:path";

/**
 * 版本号唯一来源：package.json。
 * 渲染层用构建时注入的 __APP_VERSION__，主进程用 electron 的 app.getVersion()（同样读它）。
 */
function readAppVersion(): string {
  const raw = readFileSync(path.resolve(__dirname, "package.json"), "utf-8");
  return (JSON.parse(raw) as { version?: string }).version ?? "0.0.0";
}

export default defineConfig({
  plugins: [react()],
  define: {
    __APP_VERSION__: JSON.stringify(readAppVersion()),
  },
  root: path.resolve(__dirname, "src/renderer"),
  base: "./",
  build: {
    outDir: path.resolve(__dirname, "dist/renderer"),
    emptyOutDir: true,
  },
  server: {
    port: 5173,
    strictPort: true,
  },
});
