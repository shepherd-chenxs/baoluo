/*
 * SPDX-License-Identifier: GPL-3.0-only
 * Copyright (c) 2026 宝螺 / Baoluo contributors
 * 本文件属于「宝螺 / Baoluo」。除 GPL-3.0 外还适用 ADDITIONAL_TERMS.md 里的附加条款：
 * 分发时须保留来源署名；修改版对外分发时不得沿用「宝螺」名称与图标。
 */
/**
 * 声音克隆首次安装的回归测试：
 *   1. genie 目录必须在 pip 用之前就存在（userData 重定向早于模块加载时最容易踩）
 *   2. 安装失败的归类要能说清原因，且不把非网络故障引向"检查网络"
 *
 * 需要先构建：npm run build:main
 */
const Module = require("node:module");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

let fail = 0;
function check(name, cond) {
  console.log(`${cond ? "PASS" : "FAIL"}  ${name}`);
  if (!cond) fail++;
}

// ---------------------------------------------------------------------------
// 1) 目录就位：userData 重定向发生在"模块已加载"之后（main/index.ts 的真实顺序）
// ---------------------------------------------------------------------------
const OLD_USER_DATA = fs.mkdtempSync(path.join(os.tmpdir(), "baoluo-old-"));
const NEW_USER_DATA = fs.mkdtempSync(path.join(os.tmpdir(), "baoluo-new-"));

let userData = OLD_USER_DATA;
const electronStub = {
  app: {
    getPath: (k) => {
      if (k === "userData") return userData;
      if (k === "appData") return os.tmpdir();
      return os.tmpdir();
    },
    setPath: (k, v) => {
      if (k === "userData") userData = v;
    },
    isPackaged: true,
    getAppPath: () => path.join(os.tmpdir(), "baoluo-apppath"),
    getVersion: () => "0.0.0",
  },
};
const origLoad = Module._load;
Module._load = function (request) {
  if (request === "electron") return electronStub;
  return origLoad.apply(this, arguments);
};

const { genieManager, classifyInstallFailure } = require("../dist/main/dialogue/genie-manager.js");

check(
  "模块加载时（重定向前）目录建在旧位置——这正是 bug 的成因",
  fs.existsSync(path.join(OLD_USER_DATA, "genie"))
);

// 模拟 main/index.ts 的下一步：重定向 userData
userData = NEW_USER_DATA;

// 模拟用户点「下载」：任意入口都要先把目录补齐，否则 pip 的 cwd 不存在
genieManager
  .cancelDownload()
  .then(() => {
    check("重定向后、pip 用之前，genie 目录已就位", fs.existsSync(path.join(NEW_USER_DATA, "genie")));
    check(
      "GenieData 目录也已就位",
      fs.existsSync(path.join(NEW_USER_DATA, "genie", "GenieData"))
    );

    // 目录存在与否直接决定 spawn 能不能起来（真机就是这里 ENOENT）
    const { execFileSync } = require("node:child_process");
    let spawnOk = true;
    try {
      execFileSync(process.execPath, ["-e", "0"], {
        cwd: path.join(NEW_USER_DATA, "genie"),
        stdio: "pipe",
      });
    } catch {
      spawnOk = false;
    }
    check("以 genie 目录为 cwd 起子进程不再 ENOENT", spawnOk);

    // -----------------------------------------------------------------------
    // 2) 失败归类：真机上被误判成「原因未识别」的几种情况
    // -----------------------------------------------------------------------
    const cases = [
      ["pip 根本没起来", "启动失败：spawn C:\\x\\python.exe ENOENT", "语音合成组件无法启动", false],
      ["慢网被杀（中文超时行）", "已超时（20 分钟），已终止", "下载依赖超时", true],
      ["连接超时", "ConnectTimeoutError: Connection to pypi timed out", "下载依赖超时", true],
      ["镜像下坏包", "THESE PACKAGES DO NOT MATCH THE HASHES", "下载的依赖包不完整", true],
      ["装完自检不过", "自检未通过（exit=0）: Traceback (most recent call last)", "组件安装后自检未通过", false],
      ["磁盘满", "OSError: [Errno 28] No space left on device", "磁盘空间不足", false],
      ["权限/占用", "PermissionError: [WinError 5] Access is denied", "文件被占用或没有写入权限", false],
      ["依赖源无版本", "Could not find a version that satisfies the requirement", "依赖源没有可用版本", false],
      ["确实不认识", "totally unknown failure text", "原因未识别", false],
    ];
    for (const [label, line, wantReason, wantNetwork] of cases) {
      const got = classifyInstallFailure([line]);
      check(
        `归类·${label} → ${wantReason}（网络=${wantNetwork}）`,
        got.reason === wantReason && got.network === wantNetwork
      );
    }

    // 非网络故障不能再让用户去查网络
    check(
      "非网络故障不提示「检查网络」",
      classifyInstallFailure(["启动失败：spawn python.exe ENOENT"]).network === false
    );

    for (const d of [OLD_USER_DATA, NEW_USER_DATA]) {
      try {
        fs.rmSync(d, { recursive: true, force: true });
      } catch {
        /* 忽略 */
      }
    }
    process.exit(fail ? 1 : 0);
  })
  .catch((e) => {
    console.error("测试异常:", e);
    process.exit(1);
  });
