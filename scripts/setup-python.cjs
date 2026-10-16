/*
 * SPDX-License-Identifier: GPL-3.0-only
 * Copyright (c) 2026 宝螺 / Baoluo contributors
 * 本文件属于「宝螺 / Baoluo」。除 GPL-3.0 外还适用 ADDITIONAL_TERMS.md 里的附加条款：
 * 分发时须保留来源署名；修改版对外分发时不得沿用「宝螺」名称与图标。
 */
/**
 * 下载便携版 CPython（python-build-standalone）到 resources/python/。
 *
 * 目的：声音克隆依赖 Python 运行时，但**不能让用户自己装 Python**。
 * 这里把运行时随包分发，运行时由 genie-manager 优先使用它（见 bundledPythonDir）。
 *
 * 在 npm postinstall 阶段自动运行，也支持手动：
 *   node scripts/setup-python.cjs
 *
 * 目标已存在且能跑起来就跳过（幂等）。下载失败不阻塞 npm install。
 */

const fs = require("node:fs");
const path = require("node:path");
const https = require("node:https");
const { spawnSync } = require("node:child_process");

// ---------- 配置 ----------

// 与软件里提示的「Python 3.10+」对齐；3.10 的第三方 wheel 覆盖最全
const PY_VERSION = "3.10.21";
const PY_RELEASE = "20260901";
const ASSET = `cpython-${PY_VERSION}%2B${PY_RELEASE}-x86_64-pc-windows-msvc-install_only.tar.gz`;
const GH_PATH = `astral-sh/python-build-standalone/releases/download/${PY_RELEASE}/${ASSET}`;

// 国内镜像依次尝试（实测 ghfast.top 最快），最后一个直连 GitHub 兜底
const DOWNLOAD_URLS = [
  `https://ghfast.top/https://github.com/${GH_PATH}`,
  `https://gh-proxy.com/https://github.com/${GH_PATH}`,
  `https://ghproxy.net/https://github.com/${GH_PATH}`,
  `https://github.com/${GH_PATH}`,
];

/** 解压后是 resources/python/（tar 包里本身带一层 python/） */
const EXTRACT_DIR = path.join(__dirname, "..", "resources");
const RUNTIME_DIR = path.join(EXTRACT_DIR, "python");
const PY_EXE = path.join(RUNTIME_DIR, "python.exe");

// 国内 PyPI 镜像（实测 9MB/s 级别；官方源在国内经常几 KB/s）
const PYPI_MIRROR = "https://pypi.tuna.tsinghua.edu.cn/simple";

// ---------- 工具函数 ----------

function log(...args) {
  console.log("[setup-python]", ...args);
}

/** 已就绪判定：不仅文件在，还要能真的跑起来（避免上次解压到一半） */
function isReady() {
  if (!fs.existsSync(PY_EXE)) return false;
  const r = spawnSync(PY_EXE, ["-c", "import sys; print(sys.version_info[:2])"], {
    windowsHide: true,
    stdio: "pipe",
    timeout: 30_000,
  });
  return r.status === 0;
}

/**
 * 依赖是否已装好。
 * genie-tts 的依赖里 jieba_fast 只有源码包（没有 cp310 wheel），
 * 用户机器上没有 MSVC 必然装不上——所以必须在打包机（有 VS 生成工具）上预装好，
 * 随运行时一起分发，运行时就不再需要 pip 与编译器。
 */
function depsReady() {
  if (!isReady()) return false;
  const r = spawnSync(
    PY_EXE,
    ["-c", "import importlib.util as u; print('OK' if u.find_spec('genie_tts') else 'NO')"],
    { windowsHide: true, stdio: "pipe", timeout: 60_000, encoding: "utf8" }
  );
  return r.status === 0 && String(r.stdout || "").includes("OK");
}

/**
 * 瘦身：运行时用不到、但占地方的东西。
 * 实测能省 70MB 左右（.pdb 调试符号 ~61MB + tcl/tk/ensurepip）。
 * 注意别删 site-packages 里的东西：日语模型要 sudachi 词典和 pyopenjtalk（合计 300MB+）。
 */
function cleanupRuntimeBloat() {
  let removed = 0;
  let bytes = 0;
  const isPdb = (name) => name.toLowerCase().endsWith(".pdb");
  const isCache = (name) => name === "__pycache__";

  // 整目录删除（不存在就跳过）
  for (const rel of ["tcl", "Lib\\tkinter", "Lib\\idlelib", "Lib\\ensurepip", "Lib\\test"]) {
    const p = path.join(RUNTIME_DIR, rel);
    if (!fs.existsSync(p)) continue;
    const size = (() => {
      try {
        return fs
          .readdirSync(p, { recursive: true, withFileTypes: true })
          .reduce((sum, e) => sum + (e.isFile() ? 1 : 0), 0);
      } catch {
        return 0;
      }
    })();
    try {
      fs.rmSync(p, { recursive: true, force: true });
      removed += size;
    } catch {
      /* 删不掉就算了 */
    }
  }

  const walk = (dir) => {
    let entries;
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      const p = path.join(dir, e.name);
      if (e.isDirectory()) {
        if (isCache(e.name)) {
          try {
            fs.rmSync(p, { recursive: true, force: true });
            removed++;
          } catch {
            /* 忽略 */
          }
          continue;
        }
        walk(p);
      } else if (isPdb(e.name)) {
        try {
          bytes += fs.statSync(p).size;
          fs.unlinkSync(p);
          removed++;
        } catch {
          /* 单个删不掉就算了 */
        }
      }
    }
  };
  walk(RUNTIME_DIR);
  if (removed > 0) log(`已清理 ${removed} 项调试符号 / 缓存目录（其中 .pdb 约 ${(bytes / 1024 / 1024).toFixed(1)} MB）`);
}

/** 把语音合成依赖预装进内置运行时 */
function installDeps() {
  log("安装语音合成依赖（首次约 3~10 分钟，取决于网速）…");
  const r = spawnSync(
    PY_EXE,
    [
      "-m", "pip", "install",
      "--no-input",
      "--disable-pip-version-check",
      "-i", PYPI_MIRROR,
      "setuptools", "wheel", "genie-tts",
    ],
    { windowsHide: true, stdio: "inherit" }
  );
  if (r.status === 0) {
    log("依赖安装完成。");
    return true;
  }
  console.error("");
  console.error("============================================");
  console.error("  语音合成依赖预装失败。");
  console.error("  打包出来的安装包在用户机器上仍需联网 pip 安装，");
  console.error("  且 jieba_fast 需要 MSVC 才能编译 —— 请在有 VS 生成工具的机器上重跑：");
  console.error("    node scripts/setup-python.cjs");
  console.error("============================================");
  console.error("");
  return false;
}

/** 下载文件到目标路径，自动跟随重定向 */
function download(url, destPath) {
  return new Promise((resolve, reject) => {
    const tmp = destPath + ".part";
    if (fs.existsSync(tmp)) fs.unlinkSync(tmp);

    const doReq = (reqUrl, redirects) => {
      if (redirects > 5) return reject(new Error("Too many redirects"));
      https
        .get(reqUrl, { headers: { "User-Agent": "setup-python/1.0" } }, (res) => {
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
            if (Date.now() - lastLog > 1500) {
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

/** 解压 tar.gz（Windows 10+ 内置 bsdtar 支持） */
function extractTarGz(file, destDir) {
  const r = spawnSync("tar", ["-xzf", file, "-C", destDir], {
    windowsHide: true,
    stdio: "pipe",
  });
  if (r.status === 0) return;
  throw new Error(
    "解压失败。请手动解压后放到目标目录：\n" +
      `  tar 包：${file}\n` +
      `  解压到：${destDir}（应得到 ${RUNTIME_DIR}）`
  );
}

/**
 * 导出用户端需要的预编译轮子。
 *
 * jieba_fast 在 PyPI 上只有源码包，用户机器上没有 MSVC 编译不了，
 * 所以这一个轮子必须由我们编译好、随安装包分发（其余依赖用户端从 PyPI 镜像装）。
 */
function exportWheels() {
  const outDir = path.join(__dirname, "..", "resources", "wheels");
  fs.mkdirSync(outDir, { recursive: true });
  const existing = fs.readdirSync(outDir).filter((f) => f.endsWith(".whl"));
  if (existing.length > 0) {
    log(`预编译轮子已存在，跳过：${existing.join(", ")}`);
    return;
  }

  log("导出预编译轮子（jieba_fast）…");
  const r = spawnSync(
    PY_EXE,
    [
      "-m", "pip", "wheel",
      "--no-deps",
      "--disable-pip-version-check",
      "-i", PYPI_MIRROR,
      "-w", outDir,
      "jieba_fast==0.53",
    ],
    { windowsHide: true, stdio: "inherit" }
  );
  const files = fs.readdirSync(outDir).filter((f) => f.endsWith(".whl"));
  if (r.status !== 0 || files.length === 0) {
    console.error("[setup-python] 轮子导出失败：用户端将无法安装语音合成依赖");
    return;
  }
  log(`轮子已导出：${files.join(", ")}`);
}

// ---------- 主流程 ----------

async function main() {
  if (process.platform !== "win32") {
    log("非 Windows 平台，跳过。");
    return;
  }

  // 1) 便携版运行时
  if (isReady()) {
    log(`内置 Python 已存在，跳过下载。（${PY_EXE}）`);
  } else {
    fs.mkdirSync(EXTRACT_DIR, { recursive: true });
    const tarPath = path.join(EXTRACT_DIR, ASSET.replace("%2B", "+"));

    let downloaded = false;
    for (const url of DOWNLOAD_URLS) {
      log(`下载 ${url}`);
      try {
        await download(url, tarPath);
        downloaded = true;
        break;
      } catch (e) {
        log(`失败：${e.message}`);
        if (fs.existsSync(tarPath)) fs.unlinkSync(tarPath);
        if (fs.existsSync(tarPath + ".part")) fs.unlinkSync(tarPath + ".part");
      }
    }

    if (!downloaded) {
      console.error("");
      console.error("============================================");
      console.error("  无法自动下载便携版 Python。");
      console.error("  请手动下载并解压到：");
      console.error(`  ${EXTRACT_DIR}（解压后应有 python\\python.exe）`);
      console.error("");
      console.error(`  ${DOWNLOAD_URLS[0]}`);
      console.error("============================================");
      console.error("");
      // 不阻塞安装：运行时缺失时软件会给出明确提示
      return;
    }

    log("解压中…");
    extractTarGz(tarPath, EXTRACT_DIR);
    try {
      fs.unlinkSync(tarPath);
    } catch {
      /* 删不掉不影响使用 */
    }

    if (!isReady()) {
      log("警告：解压完成但 python.exe 不可用，请检查 " + PY_EXE);
      return;
    }
  }

  // 1.5) 瘦身（幂等，重复运行只会越来越少）
  cleanupRuntimeBloat();

  // 2) 预装语音合成依赖（用户机器上没有编译器，必须在这里装好）
  if (!depsReady()) {
    installDeps();
  } else {
    log("语音合成依赖已就绪，跳过安装。");
  }

  // 3) 导出用户端需要的预编译轮子
  exportWheels();

  const ver = spawnSync(PY_EXE, ["-c", "import sys; print(sys.version.split()[0])"], {
    windowsHide: true,
    stdio: "pipe",
    encoding: "utf8",
  });
  log(`完成！内置运行时 Python ${String(ver.stdout || "").trim()}，依赖${depsReady() ? "已就绪" : "未就绪"}。`);

}

main().catch((e) => {
  console.error("[setup-python] 未预期的错误：", e.message);
  // 不阻塞 npm install
});
