/*
 * SPDX-License-Identifier: GPL-3.0-only
 * Copyright (c) 2026 宝螺 / Baoluo contributors
 * 本文件属于「宝螺 / Baoluo」。除 GPL-3.0 外还适用 ADDITIONAL_TERMS.md 里的附加条款：
 * 分发时须保留来源署名；修改版对外分发时不得沿用「宝螺」名称与图标。
 */
/**
 * 下载 whisper.cpp 预编译 Windows BLAS 二进制文件。
 *
 * 在 npm postinstall 阶段自动运行，也支持手动：
 *   node scripts/setup-whisper.cjs
 *
 * 二进制文件解压到 resources/whisper/Release/
 * 若目标已存在则跳过（幂等）。
 */

const fs = require("node:fs");
const path = require("node:path");
const https = require("node:https");
const { spawnSync } = require("node:child_process");
const zlib = require("node:zlib");

// ---------- 配置 ----------

const WHISPER_VERSION = "v1.9.1";
const TARGET_DIR = path.join(__dirname, "..", "resources", "whisper");

// 只走 ghproxy 国内代理，不直连 GitHub
const DOWNLOAD_URLS = [
  `https://ghproxy.net/https://github.com/ggml-org/whisper.cpp/releases/download/${WHISPER_VERSION}/whisper-blas-bin-x64.zip`,
];

// 需要校验的关键文件，用来判断是否已就绪
const CHECK_FILE = path.join(TARGET_DIR, "Release", "whisper-cli.exe");

// ---------- 工具函数 ----------

function log(...args) {
  console.log("[setup-whisper]", ...args);
}

function isReady() {
  return fs.existsSync(CHECK_FILE);
}

/**
 * 下载文件到临时路径，支持自动跟随重定向。
 */
function download(url, destPath) {
  return new Promise((resolve, reject) => {
    const tmp = destPath + ".part";
    if (fs.existsSync(tmp)) fs.unlinkSync(tmp);

    const doReq = (reqUrl, redirects) => {
      if (redirects > 5) return reject(new Error("Too many redirects"));
      https
        .get(reqUrl, { headers: { "User-Agent": "setup-whisper/1.0" } }, (res) => {
          if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
            return doReq(res.headers.location, redirects + 1);
          }
          if (res.statusCode >= 400) {
            return reject(new Error(`HTTP ${res.statusCode} from ${reqUrl}`));
          }
          const total = Number(res.headers["content-length"] ?? 0);
          const out = fs.createWriteStream(tmp);
          let received = 0;
          let lastLog = 0;
          res.on("data", (chunk) => {
            received += chunk.length;
            out.write(chunk);
            if (Date.now() - lastLog > 1000) {
              lastLog = Date.now();
              const pct = total > 0 ? ((received / total) * 100).toFixed(1) : "?";
              log(`  ${(received / 1024 / 1024).toFixed(1)} MB${total > 0 ? " / " + (total / 1024 / 1024).toFixed(1) + " MB" : ""} (${pct}%)`);
            }
          });
          res.on("end", () => {
            out.end();
            out.on("finish", () => {
              fs.renameSync(tmp, destPath);
              resolve();
            });
          });
          res.on("error", reject);
        })
        .on("error", reject);
    };
    doReq(url, 0);
  });
}

/**
 * 解压 zip 到目标目录。
 * 优先用系统 tar（Windows 10+ 内置），否则用 Node 内置 fallback。
 */
function extractZip(zipPath, destDir) {
  // Windows 10 build 17063+ 内置 tar 支持解压 zip
  const tarResult = spawnSync("tar", ["-xf", zipPath, "-C", destDir], {
    windowsHide: true,
    stdio: "pipe",
  });
  if (tarResult.status === 0) return;

  // Fallback: PowerShell
  const psResult = spawnSync(
    "powershell",
    [
      "-NoProfile",
      "-Command",
      `Expand-Archive -Path '${zipPath}' -DestinationPath '${destDir}' -Force`,
    ],
    { windowsHide: true, stdio: "pipe" }
  );
  if (psResult.status === 0) return;

  throw new Error(
    "Failed to extract zip. Please extract manually:\n" +
      `  zip: ${zipPath}\n` +
      `  to:  ${destDir}`
  );
}

// ---------- 主流程 ----------

async function main() {
  if (isReady()) {
    log(`whisper.cpp binaries already exist, skip. (${CHECK_FILE})`);
    return;
  }

  fs.mkdirSync(TARGET_DIR, { recursive: true });

  // 下载 zip 到临时目录
  const zipPath = path.join(TARGET_DIR, `whisper-blas-bin-x64-${WHISPER_VERSION}.zip`);

  let downloaded = false;
  for (const url of DOWNLOAD_URLS) {
    log(`Downloading ${url}`);
    try {
      await download(url, zipPath);
      downloaded = true;
      break;
    } catch (e) {
      log(`Failed: ${e.message}`);
      if (fs.existsSync(zipPath)) fs.unlinkSync(zipPath);
      if (fs.existsSync(zipPath + ".part")) fs.unlinkSync(zipPath + ".part");
    }
  }

  if (!downloaded) {
    console.error("");
    console.error("============================================");
    console.error("  无法自动下载 whisper.cpp 二进制文件。");
    console.error("  请手动从以下地址下载并解压到：");
    console.error(`  ${TARGET_DIR}`);
    console.error("");
    console.error(`  ${DOWNLOAD_URLS[0]}`);
    console.error("");
    console.error("  解压后应存在文件：");
    console.error(`  ${CHECK_FILE}`);
    console.error("============================================");
    console.error("");
    // 不阻塞安装流程，运行时 transcribe.ts 会报更清晰的错
    return;
  }

  // 解压
  log("Extracting...");
  fs.mkdirSync(TARGET_DIR, { recursive: true });
  extractZip(zipPath, TARGET_DIR);

  // 清理 zip
  try {
    fs.unlinkSync(zipPath);
  } catch {}

  // 验证
  if (isReady()) {
    log("Done! whisper.cpp binaries are ready.");
  } else {
    log("WARNING: extraction completed but whisper-cli.exe not found at expected path.");
    log(`  Expected: ${CHECK_FILE}`);

    // 尝试查找 zip 内的目录结构（有的 zip 会多一层文件夹）
    const releaseDir = path.join(TARGET_DIR, "Release");
    if (fs.existsSync(releaseDir)) {
      log(`  Release/ directory already exists.`);
    } else {
      // 尝试把 zip 内多一层目录的内容移出来
      const entries = fs.readdirSync(TARGET_DIR, { withFileTypes: true });
      for (const e of entries) {
        if (e.isDirectory() && e.name !== "Release") {
          const innerRelease = path.join(TARGET_DIR, e.name, "Release");
          if (fs.existsSync(innerRelease)) {
            log(`  Moving ${innerRelease} -> ${releaseDir}`);
            fs.renameSync(innerRelease, releaseDir);
            // 清理多余的中间目录
            try { fs.rmdirSync(path.join(TARGET_DIR, e.name)); } catch {}
            break;
          }
        }
      }
    }

    if (isReady()) {
      log("Fixed! whisper.cpp binaries are ready.");
    }
  }
}

main().catch((e) => {
  console.error("[setup-whisper] Unexpected error:", e.message);
  // 不阻塞 npm install
});
