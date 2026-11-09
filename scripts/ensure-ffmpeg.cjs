#!/usr/bin/env node
/**
 * 兜底修复 ffmpeg-static 的二进制文件。
 *
 * 为什么需要它：
 *   1. ffmpeg-static 的 install.js 只从 GitHub releases 下载（国内链路经常半途断流），
 *      它不读 npm registry 的镜像配置，`registry=https://registry.npmmirror.com` 对它无效。
 *   2. 下载中断时它已经把半个文件写进了 ffmpeg.exe，而且**失败后不清理**；
 *      下次安装时它只判断「文件存在」就打印 "is installed already" 跳过 ——
 *      于是一个 757KB 的死文件能潜伏很久，直到合成视频时 `spawn UNKNOWN`。
 *
 * 这里做两件事：按大小判定是否损坏 → 损坏就从 npmmirror 镜像重装（同样是官方 .gz 包）。
 *
 * 用法：node scripts/ensure-ffmpeg.cjs      （已挂在 npm postinstall 上）
 *       SKIP_FFMPEG_CHECK=1 可跳过；网络不通只警告，不让 npm install 整体失败。
 */
const fs = require("node:fs");
const path = require("node:path");
const https = require("node:https");
const zlib = require("node:zlib");
const { pipeline } = require("node:stream/promises");

/** npmmirror 的 ffmpeg-static 二进制镜像（路径结构与 GitHub release 一致） */
const MIRROR = "https://registry.npmmirror.com/-/binary/ffmpeg-static";
/** 小于这个体积的一定是坏文件：正常的 win32 包 82MB、darwin-arm64 45MB */
const MIN_BYTES = 20 * 1024 * 1024;

function log(msg) {
  console.log(`[ffmpeg] ${msg}`);
}

/** 找到 ffmpeg-static 包目录与它应有的可执行文件名 */
function locate() {
  const pkgJson = require.resolve("ffmpeg-static/package.json", { paths: [__dirname, process.cwd()] });
  const dir = path.dirname(pkgJson);
  const pkg = JSON.parse(fs.readFileSync(pkgJson, "utf-8"));
  const meta = pkg["ffmpeg-static"] || {};
  return {
    dir,
    pkg,
    release: process.env.FFMPEG_BINARY_RELEASE || meta["binary-release-tag"],
    exeName: process.platform === "win32" ? "ffmpeg.exe" : "ffmpeg",
  };
}

/** 跟随重定向下载到文件（写 .part 再改名，绝不直接写目标文件） */
async function download(url, dest, redirects = 0) {
  if (redirects > 5) throw new Error("重定向次数过多");
  await new Promise((resolve, reject) => {
    const req = https.get(url, { timeout: 60_000 }, (res) => {
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        res.resume();
        const next = new URL(res.headers.location, url).href;
        download(next, dest, redirects + 1).then(resolve, reject);
        return;
      }
      if (res.statusCode !== 200) {
        res.resume();
        reject(new Error(`HTTP ${res.statusCode} ${url}`));
        return;
      }
      const total = Number(res.headers["content-length"] || 0);
      const isGz = url.endsWith(".gz");
      const out = fs.createWriteStream(dest);
      const streams = isGz ? [res, zlib.createGunzip(), out] : [res, out];
      pipeline(...streams)
        .then(() => {
          if (total && !isGz && fs.statSync(dest).size !== total) {
            reject(new Error(`下载不完整：${fs.statSync(dest).size}/${total} 字节`));
          } else {
            resolve();
          }
        })
        .catch(reject);
    });
    req.on("timeout", () => req.destroy(new Error("下载超时（60s 没数据）")));
    req.on("error", reject);
  });
}

async function main() {
  if (process.env.SKIP_FFMPEG_CHECK === "1") return;
  let info;
  try {
    info = locate();
  } catch {
    log("没装 ffmpeg-static，跳过。");
    return;
  }
  const { dir, release, exeName } = info;
  const target = path.join(dir, exeName);

  const size = (() => {
    try {
      return fs.statSync(target).size;
    } catch {
      return 0;
    }
  })();

  if (size >= MIN_BYTES) {
    // 正常时安静退出；手动跑 `npm run fix:ffmpeg` 才回一句，免得以为没执行
    if (process.env.npm_lifecycle_event === "fix:ffmpeg") {
      log(`已就绪：${(size / 1024 / 1024).toFixed(1)}MB`);
    }
    return;
  }

  const why = size ? `只有 ${(size / 1024 / 1024).toFixed(1)}MB，是残缺文件` : "不存在";
  log(`${exeName} ${why}，从国内镜像重装…`);

  if (!release) {
    log("读不到 binary-release-tag，跳过（请手动检查 node_modules/ffmpeg-static）。");
    return;
  }

  const arch = process.env.npm_config_arch || process.arch;
  const platform = process.env.npm_config_platform || process.platform;
  const url = `${MIRROR}/${release}/${exeName.replace(/\.exe$/, "")}-${platform}-${arch}.gz`;
  const part = `${target}.part`;

  try {
    await download(url, part);
    const got = fs.statSync(part).size;
    if (got < MIN_BYTES) throw new Error(`镜像给的也是坏文件（${got} 字节）`);
    fs.renameSync(part, target);
    try {
      fs.chmodSync(target, 0o755);
    } catch {
      /* Windows 不需要 */
    }
    log(`完成：${(got / 1024 / 1024).toFixed(1)}MB ← ${url}`);
  } catch (e) {
    try {
      if (fs.existsSync(part)) fs.unlinkSync(part);
    } catch {
      /* 留着也无害，下次覆盖 */
    }
    // 不 exit(1)：装依赖不该因为这个整体失败，用户手动跑 npm run fix:ffmpeg 还能再试
    log(`自动修复失败：${e instanceof Error ? e.message : e}`);
    log(`可手动执行：npm run fix:ffmpeg`);
  }
}

main().catch((e) => log(`检查失败：${e instanceof Error ? e.message : e}`));
