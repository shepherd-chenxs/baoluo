/*
 * SPDX-License-Identifier: GPL-3.0-only
 * Copyright (c) 2026 宝螺 / Baoluo contributors
 * 本文件属于「宝螺 / Baoluo」。除 GPL-3.0 外还适用 ADDITIONAL_TERMS.md 里的附加条款：
 * 分发时须保留来源署名；修改版对外分发时不得沿用「宝螺」名称与图标。
 */
/**
 * genie-manager — 管理本地 Genie-TTS 服务生命周期：
 *   1. 检测 Python / genie-tts 是否已安装（没装则 pip install）
 *   2. 下载模型资源（GenieData + 中文 RoBERTa + 默认中文角色模型 feibi）
 *   3. 以子进程启动 HTTP 服务，等待就绪
 *   4. 停用时杀掉子进程，不占资源
 *
 * 所有产物都放在 userData/genie 下：
 *   genie/GenieData/                      资源目录（GENIE_DATA_DIR）
 *   genie/CharacterModels/v2ProPlus/feibi 默认中文基础模型
 *   genie/ready.json                      下载完成标记
 *   genie/server.py / download_model.py   由本应用生成的引导脚本
 */
import { app } from "electron";
import { execFile, spawn, type ChildProcess } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import https from "node:https";
import path from "node:path";
import type {
  LocalTtsEnv,
  LocalTtsProgress,
  LocalTtsState,
  LocalTtsTaskResult,
  LocalTtsTaskSnapshot,
} from "../../shared/dialogue-types";
import { DEFAULT_LOCAL_TTS_HOST, DEFAULT_LOCAL_TTS_PORT } from "../../shared/settings-defaults";
import { GenieTtsEngine } from "./genie";

/** genie 数据根目录（模型、资源、日志都在它下面） */
export function genieRootDir(): string {
  return path.join(app.getPath("userData"), "genie");
}

function genieDataDir(): string {
  return path.join(genieRootDir(), "GenieData");
}

/** Genie 角色目录：CharacterModels/v2ProPlus/<key> */
function genieCharacterDir(key: string): string {
  return path.join(genieRootDir(), "CharacterModels", "v2ProPlus", key);
}

/**
 * 确保 genie 根目录（含资源目录）存在。
 *
 * **不能只靠构造函数建目录**：本模块是模块级单例，`new GenieManager()` 在 import 时就执行，
 * 而那时 `setupUserDataDir()` 还没把 userData 重定向到 %APPDATA%/Baoluo ——
 * 于是目录被建在旧位置（%APPDATA%/宝螺/genie），之后所有以 genieRootDir() 作为
 * cwd / 落盘位置的操作（pip 安装、自检、server.py、install.log）全部 ENOENT。
 * 真机复现：pip 进程根本没起来，界面还提示「检查网络」。
 */
function ensureGenieDirs(): void {
  fs.mkdirSync(genieRootDir(), { recursive: true });
  fs.mkdirSync(genieDataDir(), { recursive: true });
}

/** Genie 角色模型必须齐全的关键文件（防止把半成品误判为已下载） */
const GENIE_MODEL_REQUIRED_FILES = [
  "tts_models/t2s_encoder_fp32.onnx",
  "tts_models/t2s_encoder_fp32.bin",
  "tts_models/t2s_first_stage_decoder_fp32.onnx",
  "tts_models/t2s_stage_decoder_fp32.onnx",
  "tts_models/t2s_shared_fp16.bin",
  "tts_models/vits_fp32.onnx",
  "tts_models/vits_fp16.bin",
  "tts_models/prompt_encoder_fp32.onnx",
  "tts_models/prompt_encoder_fp16.bin",
];

/** 扫描本地 CharacterModels 下可用的 Genie 角色模型 */
function listLocalGenieModels(): Array<{ label: string; modelDir: string }> {
  const root = path.join(genieRootDir(), "CharacterModels");
  if (!fs.existsSync(root)) return [];
  const options: Array<{ label: string; modelDir: string }> = [];

  const scan = (dir: string): void => {
    const nestedOk = isGenieModelReady(dir);
    const directOk = GENIE_MODEL_REQUIRED_FILES.every((rel) =>
      fs.existsSync(path.join(dir, rel.split("/").pop()!))
    );
    if (nestedOk || directOk) {
      options.push({ label: path.basename(dir), modelDir: dir });
      return;
    }
    // 有 tts_models 子目录但文件不齐 = 半成品角色，不递归、不列出
    if (fs.existsSync(path.join(dir, "tts_models"))) return;
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      if (entry.isDirectory()) scan(path.join(dir, entry.name));
    }
  };

  scan(root);
  return options;
}

function readyFile(): string {
  return path.join(genieRootDir(), "ready.json");
}

/**
 * 首次使用流程的诊断日志路径。
 *
 * 供「关于」页展示并一键打开所在目录：用户反馈下载/安装问题时，
 * 把这个文件作为 Issue 附件发上来就能定位走到哪一步、卡在哪。
 */
export function genieLogFile(): string {
  return path.join(genieRootDir(), "install.log");
}

/** 角色模型 key 归一化：目录名只认小写字母/数字/下划线/短横线 */
function normalizeModelKey(characterKey: string): string {
  return characterKey.toLowerCase().replace(/[^a-z0-9_-]/g, "") || "feibi";
}

/**
 * 一次下载任务的结局：
 *   ok        —— 依赖与模型都就绪
 *   cancelled —— 用户取消（半成品已清掉，可重新下载）
 *   joined    —— 同一个模型已在下载，本次并到那个任务上，没有新起任务
 */
type DownloadOutcome = "ok" | "cancelled" | "joined";

/** Genie 默认角色模型目录（feibi）下是否包含关键 ONNX 模型（在 tts_models 子目录） */
function isGenieModelReady(modelDir: string | undefined): boolean {
  return (
    !!modelDir &&
    GENIE_MODEL_REQUIRED_FILES.every((rel) => fs.existsSync(path.join(modelDir, rel)))
  );
}

/**
 * 清理 huggingface_hub 的中断残留。
 *
 * 只清「锁」和「0 字节的半成品」：
 *   - *.lock：上次进程被强杀留下的锁会让下次下载卡住
 *   - 0 字节 *.incomplete：会让 snapshot_download 直接抛 IncompleteSnapshotError
 *     （历史上就是它导致"根本不会真正联网下载"）
 * 有内容的 *.incomplete 必须留下 —— 那是已经下到一半的数据，hf 会基于它续传；
 * 之前一并删掉，等于每次重试都从零开始，在慢网/海外镜像上永远下不完。
 */
function clearHfDownloadResidue(rootDir: string): void {
  const cacheRoot = path.join(rootDir, ".cache", "huggingface", "download");
  if (!fs.existsSync(cacheRoot)) return;

  const clearIn = (dir: string): void => {
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      const p = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        clearIn(p);
      } else if (
        entry.name.endsWith(".lock") ||
        (entry.name.endsWith(".incomplete") && sizeOf(p) === 0)
      ) {
        try {
          fs.unlinkSync(p);
          console.log("[genie] 已清理中断下载残留:", p);
        } catch {
          /* 删除失败不影响后续下载 */
        }
      }
    }
  };

  clearIn(cacheRoot);
}

/** 文件字节数；读不到（刚被别的进程删掉）返回 -1，调用方按"别动它"处理 */
function sizeOf(p: string): number {
  try {
    return fs.statSync(p).size;
  } catch {
    return -1;
  }
}

/**
 * 把原始报错归类成一句人话，附在界面提示里。
 * 目的：用户截图（或口述）就能看出是网络、磁盘、权限还是本机 Python 问题，
 * 不用等维护者去要日志。只输出归类，不回显依赖名与路径。
 *
 * `network` 只用来决定要不要提示「检查网络」：进程压根没起来这类故障与网络无关，
 * 再让用户去查网络只会把人引偏（真机复现过：目录缺失导致 pip 没启动，界面却提示查网络）。
 */
export function classifyInstallFailure(lines: string[]): { reason: string; network: boolean } {
  const text = lines.join("\n");
  // 网络类：超时、DNS、证书、连接被掐都算。
  // 必须覆盖中文「已超时」——runStream 到点杀进程时写的就是这句，
  // 慢网被杀掉的安装会只剩这一行，之前因此落进「原因未识别」。
  if (
    /WinError 10060|WinError 10061|WinError 10054|WinError 10053|WinError 10013|timed out|timeout|ETIMEDOUT|Max retries|Retrying|Temporary failure|NewConnectionError|ConnectError|RemoteDisconnected|IncompleteRead|ChunkedEncodingError|ProtocolError|ConnectionReset|Connection aborted|SSLError|CERTIFICATE_VERIFY_FAILED|ProxyError|getaddrinfo|EAI_AGAIN|Name or service not known|已超时/i.test(
      text
    )
  ) {
    return { reason: "下载依赖超时", network: true };
  }
  if (/HashMismatch|hash mismatch|DO NOT MATCH THE HASHES/i.test(text)) {
    // 镜像给了个下坏的包，本质还是网络，重试即可
    return { reason: "下载的依赖包不完整", network: true };
  }
  if (/No space left|ENOSPC|磁盘空间/i.test(text)) return { reason: "磁盘空间不足", network: false };
  if (/PermissionError|WinError 5|Access is denied|EPERM|being used by another process|拒绝访问/i.test(text)) {
    return { reason: "文件被占用或没有写入权限", network: false };
  }
  // 进程没起来（工作目录不存在、exe 被杀软删掉或锁住）。与网络无关。
  if (/启动失败|ENOENT|spawn |Unable to create process/i.test(text)) {
    return { reason: "语音合成组件无法启动", network: false };
  }
  if (/Fatal Python error|No module named pip|ensurepip/i.test(text)) {
    return { reason: "本机 Python 环境异常", network: false };
  }
  if (/自检未通过/i.test(text)) return { reason: "组件安装后自检未通过", network: false };
  if (/Could not find a version|No matching distribution|ResolutionImpossible|conflicting dependencies/i.test(text)) {
    return { reason: "依赖源没有可用版本", network: false };
  }
  if (/Microsoft Visual C\+\+|Failed building wheel|subprocess-exited-with-error/i.test(text)) {
    return { reason: "依赖需要编译环境", network: false };
  }
  return { reason: "原因未识别", network: false };
}

/**
 * 首次使用流程的诊断日志（genie/install.log）。
 *
 * 界面上只给用户一句通用提示（不暴露依赖名、路径、模型仓库），但排查需要原始报错：
 * 到底卡在运行时下载、pip 装依赖，还是自检超时。所以失败时把最后几十行原始输出落盘，
 * 维护者拿到这个文件就能判断是网络、依赖还是本机环境问题。
 */
function appendDiagnosticLog(
  title: string,
  lines: string[],
  meta?: Record<string, string>
): void {
  try {
    // 目录可能不存在（userData 重定向后才第一次落盘），先补上，
    // 否则这份"排查用"的日志反而写不出来，等于失败时什么都不留。
    ensureGenieDirs();
    const file = genieLogFile();
    // 超过 256KB 只留后半段，避免无限增长
    try {
      if (fs.statSync(file).size > 256 * 1024) {
        fs.writeFileSync(file, fs.readFileSync(file, "utf-8").slice(-128 * 1024), "utf-8");
      }
    } catch {
      /* 文件还不存在 */
    }
    const head = Object.entries(meta ?? {})
      .map(([k, v]) => `${k}: ${v}`)
      .join("\n");
    fs.appendFileSync(
      file,
      ["", `===== ${new Date().toISOString()} ${title} =====`, head, ...lines.slice(-60), ""].join(
        "\n"
      ),
      "utf-8"
    );
  } catch (e) {
    console.warn("[genie] 写诊断日志失败（忽略）:", e);
  }
}

interface ReadyInfo {
  modelDir?: string;
  dataDir?: string;
}

function readReady(): ReadyInfo {
  try {
    const raw = JSON.parse(fs.readFileSync(readyFile(), "utf-8"));
    return (raw ?? {}) as ReadyInfo;
  } catch {
    return {};
  }
}

/**
 * 读取 ready.json；如果文件缺失但用户已手动把模型放到标准目录，
 * 自动识别并补写标记，避免重复下载。
 * 标准目录：genie/GenieData 与 genie/CharacterModels/v2ProPlus/feibi
 */
function resolveReady(): ReadyInfo {
  const r = readReady();
  const root = genieRootDir();
  const derived: ReadyInfo = {};
  const feibi = path.join(root, "CharacterModels", "v2ProPlus", "feibi");
  if (
    !r.modelDir &&
    isGenieModelReady(feibi)
  ) {
    derived.modelDir = feibi;
  }
  const data = path.join(root, "GenieData");
  if (
    !r.dataDir &&
    fs.existsSync(path.join(data, "chinese-hubert-base")) &&
    fs.existsSync(path.join(data, "speaker_encoder.onnx"))
  ) {
    derived.dataDir = data;
  }
  if (derived.modelDir || derived.dataDir) {
    const merged = { ...r, ...derived };
    try {
      fs.writeFileSync(readyFile(), JSON.stringify(merged, null, 2), "utf-8");
    } catch {
      /* 写标记失败不阻塞 */
    }
    return merged;
  }
  return r;
}

/** 跑一条命令，收集 stdout/stderr（不流式） */
function runCapture(
  cmd: string,
  args: string[],
  opts: { cwd?: string; env?: NodeJS.ProcessEnv; timeoutMs?: number }
): Promise<{ code: number; out: string; err: string }> {
  return new Promise((resolve) => {
    execFile(
      cmd,
      args,
      {
        cwd: opts.cwd,
        env: { ...process.env, ...(opts.env ?? {}) },
        timeout: opts.timeoutMs ?? 30_000,
        windowsHide: true,
      },
      (err, stdout, stderr) => {
        resolve({
          code: err ? (typeof (err as any).code === "number" ? (err as any).code : -1) : 0,
          out: String(stdout ?? ""),
          err: String(stderr ?? ""),
        });
      }
    );
  });
}

/** 流式跑一条命令，每行回调 */
function runStream(
  cmd: string,
  args: string[],
  opts: {
    cwd?: string;
    env?: NodeJS.ProcessEnv;
    onLine?: (line: string) => void;
    onChild?: (child: ChildProcess) => void;
    /** 超过这个时间就杀掉子进程并按失败处理（默认不限，调用方按需给） */
    timeoutMs?: number;
  }
): Promise<{ code: number | null }> {
  return new Promise((resolve) => {
    const child = spawn(cmd, args, {
      cwd: opts.cwd,
      env: { ...process.env, ...(opts.env ?? {}) },
      windowsHide: true,
      stdio: ["ignore", "pipe", "pipe"],
    });
    opts.onChild?.(child);
    let settled = false;
    const finish = (code: number | null) => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      resolve({ code });
    };
    // 兜底：子进程卡死（网络半开、被安全软件拦住）时不至于让整个流程永远挂着
    const timer = opts.timeoutMs
      ? setTimeout(() => {
          try {
            child.kill();
          } catch {
            /* 忽略 */
          }
          opts.onLine?.(`已超时（${Math.round(opts.timeoutMs! / 60000)} 分钟），已终止`);
        }, opts.timeoutMs)
      : null;
    let tail = "";
    const feed = (chunk: Buffer | string) => {
      tail += chunk.toString();
      // 防病态输出：某些工具只写 \r 不写 \n，tail 会越积越大、indexOf 反复全量扫描把主进程拖死
      if (tail.length > 1_000_000) {
        tail = tail.slice(-100_000);
      }
      let idx: number;
      while ((idx = tail.indexOf("\n")) >= 0) {
        const line = tail.slice(0, idx).replace(/\r$/, "");
        tail = tail.slice(idx + 1);
        if (line.trim()) opts.onLine?.(line);
      }
    };
    child.stdout?.on("data", feed);
    child.stderr?.on("data", feed);
    child.on("close", (code) => finish(code));
    // 关键：pip 之类的工具可能留下继承了输出管道的孙进程，'close' 永远不来。
    // 'exit' 到了就再等 2 秒（让残留输出落完）强行结算，避免整个流程卡死。
    child.on("exit", (code) => {
      setTimeout(() => finish(code), 2_000);
    });
    child.on("error", (e) => {
      opts.onLine?.(`启动失败：${e.message}`);
      finish(-1);
    });
  });
}

/**
 * 语音合成运行环境怎么来（安装包不背 580MB 的运行时）：
 *   1) 便携版 Python：用户首次使用时从公开源下载（约 37MB，多个国内加速镜像依次尝试）
 *   2) 依赖：从国内 PyPI 镜像装（约 175MB）
 *   3) 其中只有 jieba_fast 用户端装不了（PyPI 只有源码包、需要 C 编译器），
 *      由我们编译好后随安装包分发，见 resources/wheels（约 7MB）
 */
const PYTHON_VERSION = "3.10.21";
const PYTHON_RELEASE = "20260901";
const PYTHON_ASSET = `cpython-${PYTHON_VERSION}%2B${PYTHON_RELEASE}-x86_64-pc-windows-msvc-install_only.tar.gz`;
const PYTHON_GH_PATH = `astral-sh/python-build-standalone/releases/download/${PYTHON_RELEASE}/${PYTHON_ASSET}`;

/** 依次尝试；最后一个是直连（国内通常不通，兜底用） */
const PYTHON_DOWNLOAD_URLS = [
  `https://ghfast.top/https://github.com/${PYTHON_GH_PATH}`,
  `https://gh-proxy.com/https://github.com/${PYTHON_GH_PATH}`,
  `https://ghproxy.net/https://github.com/${PYTHON_GH_PATH}`,
  `https://github.com/${PYTHON_GH_PATH}`,
];

/** 国内 PyPI 镜像（约 10MB/s；官方源在国内经常几 KB/s） */
const PYPI_MIRROR = "https://pypi.tuna.tsinghua.edu.cn/simple";

/**
 * 模型下载源，按顺序回退。
 * HF 官方源在国内基本连不上，hf-mirror.com 偶尔会超时/变慢，所以多备两个；
 * 脚本里逐个试，任何一个把文件下齐就算成功。
 */
const GENIE_MODEL_ENDPOINTS = [
  "https://hf-mirror.com",
  "https://aifasthub.com",
  "https://hf-mirror.net",
];

/** 随包分发的预编译轮子目录 */
function bundledWheelsDir(): string {
  return app.isPackaged
    ? path.join(process.resourcesPath, "wheels")
    : path.join(app.getAppPath(), "resources", "wheels");
}

/** 随包/开发目录里的运行时（打包版没有，留作以后想内置时的入口） */
function packagedPythonExe(): string {
  const dir = app.isPackaged
    ? path.join(process.resourcesPath, "python")
    : path.join(app.getAppPath(), "resources", "python");
  return process.platform === "win32"
    ? path.join(dir, "python.exe")
    : path.join(dir, "bin", "python3");
}

/** 首次使用时下载到 userData 的运行时根目录 */
function downloadedRuntimeRoot(): string {
  return path.join(app.getPath("userData"), "runtime");
}

function downloadedPythonExe(): string {
  const dir = path.join(downloadedRuntimeRoot(), "python");
  return process.platform === "win32"
    ? path.join(dir, "python.exe")
    : path.join(dir, "bin", "python3");
}

/** 当前可用的运行时；两个位置都没有则返回 null */
function resolvePythonExe(): string | null {
  for (const p of [packagedPythonExe(), downloadedPythonExe()]) {
    if (fs.existsSync(p)) return p;
  }
  return null;
}

/**
 * 找到可用的 Python。
 *
 * **优先内置运行时**：声音克隆依赖 Python，而普通用户不该自己去装 Python
 * （更不该为此装编译器）。运行时随包分发，见 scripts/setup-python.cjs。
 * 只有在开发环境（未打包）才退回系统 Python，方便调试。
 */
async function findPython(): Promise<{ cmd: string; args: string[]; display: string } | null> {
  const candidates: Array<{ cmd: string; args: string[]; display: string }> = [];

  const runtime = resolvePythonExe();
  if (runtime) candidates.push({ cmd: runtime, args: [], display: "bundled" });
  if (!app.isPackaged) {
    candidates.push({ cmd: "python", args: [], display: "python" });
    candidates.push({ cmd: "py", args: ["-3"], display: "py -3" });
  }

  for (const cand of candidates) {
    // 同一个候选探测 3 次：冷启动、刚解压完 700MB 运行时、杀软扫描时，
    // 第一次执行 python 可能直接失败或超时——只探一次就判"运行环境缺失"会误报。
    for (let attempt = 1; attempt <= 3; attempt++) {
      const r = await runCapture(cand.cmd, [...cand.args, "-c", "import sys; print(sys.executable)"], {
        timeoutMs: 60_000,
      });
      if (r.code === 0 && r.out.trim()) return cand;
      console.warn(
        `[genie] python 探测失败（${cand.display} 第 ${attempt}/3 次）: exit=${r.code} ${r.err.slice(0, 200)}`
      );
      if (attempt < 3) await new Promise((res) => setTimeout(res, 1_500));
    }
  }
  return null;
}

/** 找不到运行时的统一提示（不暴露技术栈） */
function runtimeMissingMessage(): string {
  const hint = app.isPackaged
    ? ""
    : "（开发环境：先执行 node scripts/setup-python.cjs）";
  return `语音合成运行环境缺失，请重新安装软件${hint}；若仍不行，请在仓库提 Issue 并附上「关于」页显示的日志目录里的 install.log。`;
}

function genieCheckCode(): string {
  // 用 find_spec 检测包是否存在，不执行模块（genie_tts 在模型未下载时会 import 报错）
  return [
    "import importlib.util",
    "print('OK' if importlib.util.find_spec('genie_tts') is not None else 'NO')",
  ].join("; ");
}

export class GenieManager {
  private child: ChildProcess | null = null;
  private activeDownload: ChildProcess | null = null;
  private activeDownloadKey: string | null = null;
  /**
   * 正在进行的 HTTP 下载（运行时归档）的中止入口。
   *
   * 这条链路没有子进程可杀，只能靠它主动断开：否则用户点「取消」后要等到下一个数据块
   * 才会被判定成取消——对端已经不发数据时就是一直等下去。
   */
  private activeHttpAbort: (() => void) | null = null;
  private activeDownloadAborted: "cancel" | null = null;
  /**
   * 用户是否点过「取消」。与 activeDownloadAborted 分开：
   * 后者是底层进程的中止信号（会被各步骤自己清掉），
   * 前者粘住直到本次任务真正收尾，供 prepare 的检查点判断。
   */
  private cancelRequested = false;
  /** 当前下载任务的模型 key（install 阶段也在内），界面据此恢复「下载中」状态 */
  private downloadTaskKey: string | null = null;
  /** 当前任务最近一次进度，用于切页面/重进后接着显示 */
  private lastProgress: LocalTtsProgress | null = null;
  private state: LocalTtsState = "idle";
  private message: string | undefined;
  private python: { cmd: string; args: string[]; display: string } | null = null;

  constructor() {
    // 这里建目录只是"尽早"，真正保证可用的是每次使用前的 ensureGenieDirs()：
    // 本单例在 import 时就构造，早于 userData 重定向（见 ensureGenieDirs 注释）。
    ensureGenieDirs();
  }

  private async refreshPython(): Promise<{ cmd: string; args: string[]; display: string } | null> {
    if (!this.python) this.python = await findPython();
    return this.python;
  }

  private envFor(dataDir: string): NodeJS.ProcessEnv {
    return {
      ...process.env,
      GENIE_DATA_DIR: dataDir,
      // 只吃内置运行时自带的包，别被用户自己装过的 Python 包干扰
      PYTHONNOUSERSITE: "1",
    };
  }

  private isChildAlive(): boolean {
    return !!this.child && this.child.exitCode === null && !this.child.killed;
  }

  /** 有下载任务在跑（含装依赖阶段） */
  private isDownloadBusy(): boolean {
    return this.downloadTaskKey !== null;
  }

  /** 取消收尾：清掉半成品与所有在途标记，界面回到「可重新下载」 */
  private finishCancelled(): void {
    this.cancelRequested = false;
    this.activeDownloadAborted = null;
    this.activeDownload = null;
    this.activeDownloadKey = null;
    clearHfDownloadResidue(genieRootDir());
    this.state = "idle";
    this.message = "下载已取消";
  }

  async env(): Promise<LocalTtsEnv> {
    ensureGenieDirs();
    const dataDir = genieDataDir();
    const py = await this.refreshPython();
    let genieInstalled = false;
    if (py) {
      const r = await runCapture(py.cmd, [...py.args, "-c", genieCheckCode()], {
        cwd: genieRootDir(),
        env: this.envFor(dataDir),
        timeoutMs: 30_000,
      });
      genieInstalled = r.code === 0 && r.out.trim().includes("OK");
    }
    const modelOptions = listLocalGenieModels();
    const dataDirOk =
      fs.existsSync(path.join(genieDataDir(), "chinese-hubert-base")) &&
      fs.existsSync(path.join(genieDataDir(), "speaker_encoder.onnx")) &&
      fs.existsSync(path.join(genieDataDir(), "roberta-wwm-ext-large-onnx", "model.onnx"));
    const modelReady = modelOptions.length > 0 && dataDirOk;
    const defaultModelDir =
      modelOptions.find((o) => o.label.toLowerCase() === "feibi")?.modelDir ??
      modelOptions[0]?.modelDir ??
      null;
    const online = await new GenieTtsEngine({ baseUrl: this.baseUrl(), timeoutMs: 4_000 }).ping();
    return {
      python: py?.display ?? null,
      genieInstalled,
      modelReady,
      defaultModelDir,
      modelOptions,
      online,
      managed: this.isChildAlive(),
      state: this.state,
      message: this.message,
      downloadingKey: this.downloadTaskKey,
      progress: this.lastProgress,
    };
  }

  private baseUrl(): string {
    return `http://${DEFAULT_LOCAL_TTS_HOST}:${DEFAULT_LOCAL_TTS_PORT}`;
  }

  /** 准备：安装 genie-tts（如缺）→ 下载公共资源 + 指定角色模型（如缺），不启动服务 */
  /**
   * 下载运行时归档（支持重定向；this.activeDownloadAborted 置位即中止）。
   * 进度按字节回报，复用「下载中」这套 UI。
   */
  private downloadArchive(
    url: string,
    dest: string,
    onProgress: (p: LocalTtsProgress) => void
  ): Promise<void> {
    return new Promise((resolve, reject) => {
      const tmp = dest + ".part";
      // 只结算一次：正常结束、网络错误、用户取消都会走到这里
      let settled = false;
      const finish = (err?: Error) => {
        if (settled) return;
        settled = true;
        this.activeHttpAbort = null;
        if (err) reject(err);
        else resolve();
      };
      const doReq = (reqUrl: string, redirects: number) => {
        if (redirects > 5) return finish(new Error("重定向过多"));
        // 卡死兜底：连接建上了但对端一个字节都不发时（真机见过，见 v0.8.11），
        // 后台下载没有任何界面参与，没人会发现它永远挂着。
        let req: ReturnType<typeof https.get> | null = null;
        const stall = setTimeout(() => {
          try {
            req?.destroy();
          } catch {
            /* 已经结束 */
          }
          finish(new Error("下载超时（长时间无数据）"));
        }, 120_000);
        // 一旦有数据就不算卡死：每次收到 chunk 都会重排（见 res.on("data")）
        const resetStall = () => {
          stall.refresh();
        };
        req = https
          .get(reqUrl, { headers: { "User-Agent": "baoluo/1.0" } }, (res) => {
            const code = res.statusCode ?? 0;
            if (code >= 300 && code < 400 && res.headers.location) {
              clearTimeout(stall);
              res.resume();
              return doReq(new URL(res.headers.location, reqUrl).toString(), redirects + 1);
            }
            if (code >= 400) {
              clearTimeout(stall);
              res.resume();
              return finish(new Error(`HTTP ${code}`));
            }
            const total = Number(res.headers["content-length"] ?? 0);
            const out = fs.createWriteStream(tmp);
            let received = 0;
            let lastLog = 0;
            let aborted = false;
            // 取消时立刻断开这条 HTTP：这条链路没有子进程可杀（见 activeHttpAbort 注释）
            this.activeHttpAbort = () => {
              aborted = true;
              clearTimeout(stall);
              res.destroy();
              out.destroy();
              finish(new Error("已取消"));
            };
            res.on("data", (chunk: Buffer) => {
              if (this.activeDownloadAborted) {
                this.activeHttpAbort?.();
                return;
              }
              resetStall();
              received += chunk.length;
              out.write(chunk);
              if (Date.now() - lastLog > 300) {
                lastLog = Date.now();
                const mb = (n: number) => (n / 1048576).toFixed(1);
                onProgress({
                  phase: "download",
                  message: "正在下载语音合成运行环境（仅首次，约 40MB）…",
                  detail: total > 0 ? `${mb(received)} / ${mb(total)} MB` : `${mb(received)} MB`,
                  percent: total > 0 ? Math.round((received / total) * 100) : undefined,
                });
              }
            });
            res.on("error", (e) => {
              clearTimeout(stall);
              finish(e as Error);
            });
            out.on("error", (e) => {
              clearTimeout(stall);
              finish(e as Error);
            });
            res.on("end", () => {
              clearTimeout(stall);
              if (aborted) return;
              out.end(() => {
                if (aborted) return;
                try {
                  // 关键：写完了才改名成正式文件名。
                  // 上层 ensureRuntime 解压的是 dest，之前这里漏了改名，
                  // 于是归档一直躺在 .part，tar 找不到文件直接判「下载失败」。
                  fs.renameSync(tmp, dest);
                  finish();
                } catch (e) {
                  finish(e as Error);
                }
              });
            });
          })
          .on("error", (e) => {
            clearTimeout(stall);
            finish(e as Error);
          });
      };
      doReq(url, 0);
    });
  }

  /**
   * 确保本地有便携版 Python（打包版不含，第一次用声音克隆时下载到 userData/runtime）。
   * 依赖不在这里装，由 prepare() 从 PyPI 镜像装（其中 jieba_fast 用随包的预编译轮子）。
   */
  private async ensureRuntime(onProgress: (p: LocalTtsProgress) => void): Promise<void> {
    if (resolvePythonExe()) return;

    const root = downloadedRuntimeRoot();
    fs.mkdirSync(root, { recursive: true });
    const archive = path.join(root, "python-runtime.tar.gz");

    appendDiagnosticLog("开始下载便携运行时", [`目标: ${archive}`, `下载源: ${PYTHON_DOWNLOAD_URLS.join(" , ")}`]);
    this.state = "downloading";
    this.activeDownloadAborted = null;
    let lastErr: unknown = null;
    try {
      for (const url of PYTHON_DOWNLOAD_URLS) {
        if (this.activeDownloadAborted) break;
        try {
          onProgress({
            phase: "download",
            message: "正在下载语音合成组件（仅首次，约 40MB）…",
            percent: 0,
          });
          await this.downloadArchive(url, archive, onProgress);
          lastErr = null;
          break;
        } catch (e) {
          lastErr = e;
          console.warn("[genie] Python 下载源失败，换下一个:", url, e);
          try {
            fs.rmSync(archive, { force: true });
            fs.rmSync(archive + ".part", { force: true });
          } catch {
            /* 忽略 */
          }
        }
      }

      if (this.activeDownloadAborted) {
        this.activeDownloadAborted = null;
        this.state = "idle";
        this.message = "下载已取消";
        return;
      }
      if (lastErr) throw lastErr;

      onProgress({
        phase: "download",
        message: "正在解压语音合成组件…",
        percent: 100,
      });
      const r = await runStream("tar", ["-xzf", archive, "-C", root], {
        // 解压没有超时会和下载一样永远挂着（tar 被安全软件拦住时尤其明显）
        timeoutMs: 10 * 60_000,
        onChild: (child) => {
          this.activeDownload = child;
        },
      });
      this.activeDownload = null;
      if (r.code !== 0 || !fs.existsSync(downloadedPythonExe())) {
        throw new Error("解压失败");
      }
      try {
        fs.unlinkSync(archive);
      } catch {
        /* 删不掉不影响使用 */
      }
      console.log("[genie] 便携版 Python 已就绪:", downloadedPythonExe());
    } catch (e) {
      if (this.activeDownloadAborted) {
        this.activeDownloadAborted = null;
        this.state = "idle";
        this.message = "下载已取消";
        return;
      }
      appendDiagnosticLog("语音合成组件（便携运行时）下载失败", [String(e)], {
        已尝试下载源: PYTHON_DOWNLOAD_URLS.join(" , "),
      });
      console.error("[genie] 语音合成组件下载失败:", e);
      this.state = "error";
      this.message = "语音合成组件下载失败，请检查网络后重试；如果一直失败，请在仓库提 Issue 并附上 install.log。";
      throw new Error(this.message);
    }
  }

  private async prepare(
    onProgress: (p: LocalTtsProgress) => void,
    characterKey = "feibi"
  ): Promise<"ok" | "cancelled"> {
    // 目录必须在任何子进程/写文件之前就位（cwd 不存在会让 pip 直接起不来）
    ensureGenieDirs();
    // 0) 运行时（打包版不带，首次使用时下载）
    await this.ensureRuntime(onProgress);
    // 取消可能在运行时下载/解压期间发生：这里收口，别继续往下装依赖、下模型
    if (this.cancelRequested) {
      this.finishCancelled();
      return "cancelled";
    }

    const dataDir = genieDataDir();
    const root = genieRootDir();
    const safeKey = normalizeModelKey(characterKey);
    const targetDir = genieCharacterDir(safeKey);
    const py = await this.refreshPython();
    if (!py) {
      // 这条也是"一点下载就报错"的常见来源：先记下来，别只剩一句通用提示
      appendDiagnosticLog("未找到可用的 Python 运行环境", [
        `packaged: ${packagedPythonExe()}`,
        `downloaded: ${downloadedPythonExe()}`,
        `packaged 存在: ${fs.existsSync(packagedPythonExe())}`,
        `downloaded 存在: ${fs.existsSync(downloadedPythonExe())}`,
      ]);
      this.state = "error";
      this.message = runtimeMissingMessage();
      throw new Error(this.message);
    }

    // 1) 安装 genie-tts
    const check = await runCapture(py.cmd, [...py.args, "-c", genieCheckCode()], {
      cwd: root,
      env: this.envFor(dataDir),
      // 冷启动（刚解压完 700MB 运行时 + 杀软扫描）时 python 起来很慢，30s 会误判成"没装"
      timeoutMs: 120_000,
    });
    if (check.code !== 0 || !check.out.trim().includes("OK")) {
      this.state = "installing";
      this.message = "正在安装语音合成组件（首次约需几分钟）…";
      onProgress({ phase: "install", message: this.message });
      // 走国内镜像；jieba_fast 用随包的预编译轮子（PyPI 上只有源码包，用户端编译不了）
      const lastLines: string[] = [];
      let lastInstallProgress = 0;
      const runInstall = () =>
        runStream(
          py.cmd,
          [
            ...py.args,
            "-m", "pip", "install",
            "--no-input",
            "--disable-pip-version-check",
            "-i", PYPI_MIRROR,
            "--find-links", bundledWheelsDir(),
            "setuptools", "wheel", "genie-tts",
          ],
          {
            cwd: root,
            env: this.envFor(dataDir),
            // 慢网下 pip 可能要几分钟，但卡死不能无限等
            timeoutMs: 20 * 60_000,
            onChild: (child) => {
              this.activeDownload = child;
            },
            onLine: (line) => {
              lastLines.push(line);
              if (lastLines.length > 60) lastLines.shift();
              // 原始输出只留控制台与诊断日志：pip 输出里带依赖包名，不往界面上透
              console.log("[genie] install:", line);
              // 关键：pip 的输出可达上万行，逐行发 IPC 会把主进程和渲染进程一起拖死
              // （真机复现：装完后主进程 100% CPU 空转、IPC 全部无响应）。这里按 300ms 限流。
              const now = Date.now();
              if (now - lastInstallProgress < 300) return;
              lastInstallProgress = now;
              onProgress({
                phase: "install",
                message: this.message!,
                detail: "首次安装约需几分钟，请保持网络畅通…",
              });
            },
          }
        );
      const recheckInstalled = () =>
        runCapture(py.cmd, [...py.args, "-c", genieCheckCode()], {
          cwd: root,
          env: this.envFor(dataDir),
          timeoutMs: 120_000,
        });
      // 首次安装失败多是瞬时故障（索引连接抖一下、或刚解压完的运行时被杀软拖住），
      // 所以整轮重试一次再判失败——比直接报错让用户重来一遍体验好得多。
      let installed = false;
      let attempts = 0;
      for (let attempt = 1; attempt <= 3 && !installed; attempt++) {
        attempts = attempt;
        if (attempt > 1) {
          // 隔一会儿再来：刚解压完运行时、杀软还在扫盘时，立刻重试往往还是失败
          await new Promise((r) => setTimeout(r, attempt === 2 ? 3_000 : 8_000));
        }
        const ins = await runInstall();
        this.activeDownload = null;
        if (this.cancelRequested) {
          this.finishCancelled();
          return "cancelled";
        }
        const recheck = await recheckInstalled();
        installed = ins.code === 0 && recheck.code === 0 && recheck.out.trim().includes("OK");
        if (!installed) {
          console.warn(
            `[genie] 环境安装第 ${attempt} 次失败（pip exit=${ins.code}，自检 exit=${recheck.code}）`
          );
          // pip 说成功但自检不过时，lastLines 里是 pip 的正常输出，归类会掉进「原因未识别」。
          // 把自检本身的失败原因补进诊断行，让归类有据可依（也会落进 install.log）。
          if (ins.code === 0 && !recheck.out.trim().includes("OK")) {
            lastLines.push(
              `自检未通过（exit=${recheck.code}）: ${(recheck.err || recheck.out).trim().slice(0, 500) || "(无输出)"}`
            );
          }
        }
      }
      if (!installed) {
        // 原始输出落盘留证（界面上不暴露依赖名/路径），维护者据此定位
        const { reason, network } = classifyInstallFailure(lastLines);
        appendDiagnosticLog("语音合成环境安装失败", lastLines, {
          attempts: String(attempts),
          归类: reason,
          是否网络问题: String(network),
          python: py.display,
          wheels: bundledWheelsDir(),
        });
        console.error("[genie] 环境安装失败:", lastLines.join("\n").slice(0, 2000));
        this.state = "error";
        // 与网络无关的失败（组件起不来、磁盘、权限、自检不过）不能再让用户"检查网络"——
        // 那是把人往错方向引。只有确实判定为网络问题时才提网络。
        this.message = network
          ? `语音合成环境安装失败（${reason}），请检查网络后重试。`
          : `语音合成环境安装失败（${reason}），请重试；如果一直失败，请在仓库提 Issue 并附上 install.log。`;
        throw new Error(this.message);
      }
    }

    // 2) 下载模型资源 + 指定角色模型
    if (this.cancelRequested) {
      this.finishCancelled();
      return "cancelled";
    }
    const modelFilesOk =
      isGenieModelReady(targetDir);
    const dataOk =
      fs.existsSync(path.join(dataDir, "chinese-hubert-base")) &&
      fs.existsSync(path.join(dataDir, "speaker_encoder.onnx")) &&
      fs.existsSync(path.join(dataDir, "roberta-wwm-ext-large-onnx", "model.onnx")) &&
      fs.existsSync(path.join(dataDir, "roberta-wwm-ext-large-onnx", "tokenizer.json"));
    if (!modelFilesOk || !dataOk) {
      this.state = "downloading";
      this.message = "正在下载语音模型…";
      onProgress({ phase: "download", message: this.message });
      appendDiagnosticLog("开始下载语音模型", [
        `角色: ${safeKey}`,
        `角色目录已就绪: ${modelFilesOk}`,
        `公共资源已就绪: ${dataOk}`,
      ]);
      this.activeDownloadKey = safeKey;
      this.activeDownloadAborted = null;
      this.activeDownload = null;
      const script = path.join(root, "download_model.py");
      fs.writeFileSync(
        script,
        [
          "import os, sys, json",
          "root = os.path.dirname(os.path.abspath(__file__))",
          "data_dir = os.path.join(root, 'GenieData')",
          "os.makedirs(data_dir, exist_ok=True)",
          "os.environ['HF_HUB_DISABLE_XET'] = '1'",
          // 关键：不给超时的话，"连上了但对端不发数据"的挂死连接会永远等下去
          // （真机复现：TCP Established、0 字节、无进展，UI 一直停在"正在下载语音模型…"）
          "os.environ['HF_HUB_DOWNLOAD_TIMEOUT'] = '30'",
          "os.environ['HF_HUB_ETAG_TIMEOUT'] = '30'",
          "from huggingface_hub import snapshot_download",
          "from tqdm import tqdm as _base_tqdm",
          "class _JsonTqdm(_base_tqdm):",
          "    def __init__(self, *args, **kwargs):",
          "        self._tag = kwargs.get('desc', '')",
          "        kwargs['disable'] = False",
          "        kwargs['mininterval'] = 0.15",
          "        super().__init__(*args, **kwargs)",
          "    def display(self, msg=None, pos=None):",
          "        total = getattr(self, 'total', None) or 0",
          "        n = getattr(self, 'n', 0) or 0",
          "        if total > 0:",
          "            print('DLP ' + json.dumps({'tag': self._tag, 'n': n, 'total': total}), flush=True)",
          `model_dir = os.path.join(root, 'CharacterModels', 'v2ProPlus', '${safeKey}')`,
          `ENDPOINTS = ${JSON.stringify(GENIE_MODEL_ENDPOINTS)}`,
          "",
          "MODEL_FILES = ['t2s_encoder_fp32.onnx', 't2s_encoder_fp32.bin', 't2s_first_stage_decoder_fp32.onnx', 't2s_stage_decoder_fp32.onnx', 't2s_shared_fp16.bin', 'vits_fp32.onnx', 'vits_fp16.bin', 'prompt_encoder_fp32.onnx', 'prompt_encoder_fp16.bin']",
          "DATA_FILES = ['chinese-hubert-base', 'speaker_encoder.onnx', 'roberta-wwm-ext-large-onnx/model.onnx', 'roberta-wwm-ext-large-onnx/tokenizer.json']",
          "def files_ok():",
          "    return all(os.path.exists(os.path.join(model_dir, 'tts_models', f)) for f in MODEL_FILES) and all(os.path.exists(os.path.join(data_dir, f)) for f in DATA_FILES)",
          "",
          "def download_all(ep):",
          "    snapshot_download(repo_id='High-Logic/Genie', repo_type='model', allow_patterns='GenieData/*', local_dir=root, tqdm_class=_JsonTqdm, endpoint=ep, etag_timeout=30)",
          "    snapshot_download(repo_id='litagin/chinese-roberta-wwm-ext-large-onnx', repo_type='model', allow_patterns=['model.onnx', 'tokenizer.json'], local_dir=os.path.join(data_dir, 'roberta-wwm-ext-large-onnx'), tqdm_class=_JsonTqdm, endpoint=ep, etag_timeout=30)",
          `    snapshot_download(repo_id='High-Logic/Genie', repo_type='model', allow_patterns='CharacterModels/v2ProPlus/${safeKey}/*', local_dir=root, tqdm_class=_JsonTqdm, endpoint=ep, etag_timeout=30)`,
          "",
          "def main():",
          "    for ep in ENDPOINTS:",
          "        print('DLP_EP ' + ep, flush=True)",
          "        try:",
          "            download_all(ep)",
          "        except Exception as e:",
          "            print('DLP_ERR ' + str(e)[:300], flush=True)",
          "            continue",
          "        if files_ok():",
          "            return True",
          "        print('DLP_ERR 文件仍不完整，换下一个下载源', flush=True)",
          "    return False",
          "",
          "if not main():",
          "    print('DLP_FAIL', flush=True)",
          "    sys.exit(3)",
          "with open(os.path.join(root, 'ready.json'), 'w', encoding='utf-8') as f:",
          "    json.dump({'modelDir': model_dir, 'dataDir': data_dir}, f, ensure_ascii=False, indent=2)",
          "print('MODEL_READY ' + model_dir)",
        ].join("\n"),
        "utf-8"
      );
      clearHfDownloadResidue(root);
      const dlLines: string[] = [];
      let dlpPercent: number | undefined;
      let dlpDetail = "";
      // 记下"到底是网络问题还是别的问题"，好在最后给用户一句有信息量的提示
      let networkHint = false;
      let dlpLastSent = 0;
      const dlpTotal = new Map<string, number>();
      const dlpDone = new Map<string, number>();
      const sendDlp = (rawLine: string) => {
        const now = Date.now();
        if (rawLine.startsWith("DLP ")) {
          try {
            const info = JSON.parse(rawLine.slice(4)) as { tag?: string; n?: number; total?: number };
            const tag = String(info?.tag ?? "");
            const total = Number(info?.total ?? 0);
            const done = Number(info?.n ?? 0);
            if (total > 0) {
              dlpTotal.set(tag, total);
              dlpDone.set(tag, Math.max(dlpDone.get(tag) ?? 0, done));
              const bytesPct = [...dlpTotal.entries()]
                .filter(([t]) => /bytes|reconstruct/i.test(t))
                .map(([t]) => ((dlpDone.get(t) ?? 0) / dlpTotal.get(t)!) * 100);
              if (bytesPct.length > 0) {
                dlpPercent = Math.min(100, Math.max(...bytesPct));
              }
              if (/fetching/i.test(tag)) {
                dlpDetail = `正在处理文件 ${Math.round(done)}/${Math.round(total)}`;
              }
            }
          } catch {
            /* 忽略无法解析的行 */
          }
        } else if (rawLine.startsWith("DLP_EP ")) {
          // 换下载源，别把镜像地址透到界面上
          dlpDetail = "正在连接下载源…";
        } else if (rawLine.startsWith("DLP_ERR ")) {
          networkHint = true;
          dlpDetail = "下载源不稳定，正在换下一个…";
        } else if (rawLine.startsWith("DLP_FAIL")) {
          dlpDetail = "下载源均不可用";
        } else if (rawLine.trim()) {
          dlpDetail = rawLine.trim().slice(0, 180);
        }
        if (now - dlpLastSent < 200 && dlpPercent === undefined) return;
        dlpLastSent = now;
        onProgress({
          phase: "download",
          message: this.message!,
          detail: dlpDetail || undefined,
          percent: dlpPercent,
        });
      };
      const dl = await runStream(py.cmd, [...py.args, script], {
        cwd: root,
        env: this.envFor(dataDir),
        onChild: (child) => {
          this.activeDownload = child;
        },
        onLine: (line) => {
          dlLines.push(line);
          if (dlLines.length > 8) dlLines.shift();
          sendDlp(line);
        },
      });
      if (this.cancelRequested || this.activeDownloadAborted) {
        this.finishCancelled();
        return "cancelled";
      }
      this.activeDownload = null;
      this.activeDownloadKey = null;
      // 下载脚本会写 ready.json，这里等文件真正落盘后再做完整自检；
      // 只要关键文件齐全就视为成功（不因 Python 进程收尾异常而误报失败）。
      const checkDownloaded = (): boolean => {
        const modelOk = isGenieModelReady(targetDir);
        const dataOk =
          fs.existsSync(path.join(dataDir, "chinese-hubert-base")) &&
          fs.existsSync(path.join(dataDir, "speaker_encoder.onnx")) &&
          fs.existsSync(path.join(dataDir, "roberta-wwm-ext-large-onnx", "model.onnx")) &&
          fs.existsSync(path.join(dataDir, "roberta-wwm-ext-large-onnx", "tokenizer.json"));
        return modelOk && dataOk;
      };
      let okAfter = checkDownloaded();
      for (let i = 0; i < 15 && !okAfter; i++) {
        await new Promise((r) => setTimeout(r, 200));
        okAfter = checkDownloaded();
      }
      if (!okAfter) {
        // 原始输出只进控制台（含模型仓库地址与文件名，不往界面上透）
        console.error(
          "[genie] 模型下载失败:",
          `exit=${dl.code}`,
          dlLines.join("\n").slice(0, 2000)
        );
        appendDiagnosticLog("语音模型下载失败", dlLines, {
          exit: String(dl.code),
          下载源: GENIE_MODEL_ENDPOINTS.join(" , "),
          角色模型: safeKey,
        });
        this.state = "error";
        // 不提"离线模型包"：这条链路配了多源回退与断点续传，失败基本是瞬时网络问题，
        // 让用户直接再点一次比引导去找人要包更可能解决问题。
        this.message = networkHint
          ? "语音模型下载失败（下载源连接超时），请检查网络后重新尝试。"
          : "语音模型下载失败，请检查网络后重新尝试。";
        throw new Error(this.message);
      }
    }

    this.state = "idle";
    this.message = "模型已就绪，可以启动服务";
    return "ok";
  }

  /** 启动服务：只启动不下载（模型未就绪时明确提示先下载） */
  private async startService(onProgress: (p: LocalTtsProgress) => void): Promise<void> {
    ensureGenieDirs();
    const dataDir = genieDataDir();
    const root = genieRootDir();
    const py = await this.refreshPython();
    if (!py) {
      this.state = "error";
      this.message = runtimeMissingMessage();
      throw new Error(this.message);
    }
    const availableModels = listLocalGenieModels();
    const dataReady =
      fs.existsSync(path.join(dataDir, "chinese-hubert-base")) &&
      fs.existsSync(path.join(dataDir, "speaker_encoder.onnx"));
    const modelReady =
      availableModels.length > 0 && dataReady;
    if (!modelReady) {
      this.state = "error";
      this.message = "模型尚未就绪，请先在「模型库」下载一个模型，再启动服务。";
      throw new Error(this.message);
    }

    // 3) 启动服务
    if (this.isChildAlive()) {
      this.state = "running";
      this.message = "服务已启动";
      return;
    }
    this.state = "starting";
    this.message = "正在启动本地语音服务…";
    onProgress({ phase: "start", message: this.message });
    const serverScript = path.join(root, "server.py");
    fs.writeFileSync(
      serverScript,
      [
        "import os, sys",
        "root = os.path.dirname(os.path.abspath(__file__))",
        "data_dir = os.path.join(root, 'GenieData')",
        "os.makedirs(data_dir, exist_ok=True)",
        "os.environ['GENIE_DATA_DIR'] = data_dir",
        "os.chdir(root)",
        "import genie_tts as genie",
        "host = sys.argv[1] if len(sys.argv) > 1 else '127.0.0.1'",
        `port = int(sys.argv[2]) if len(sys.argv) > 2 else ${DEFAULT_LOCAL_TTS_PORT}`,
        "genie.start_server(host=host, port=port, workers=1)",
      ].join("\n"),
      "utf-8"
    );
    const child = spawn(
      py.cmd,
      [...py.args, serverScript, DEFAULT_LOCAL_TTS_HOST, String(DEFAULT_LOCAL_TTS_PORT)],
      {
      cwd: root,
      env: this.envFor(dataDir),
      windowsHide: true,
      stdio: ["ignore", "pipe", "pipe"],
      }
    );
    this.child = child;
    let tail = "";
    const feed = (chunk: Buffer | string) => {
      tail += chunk.toString();
      const lines = tail.split(/\r?\n/);
      tail = lines.pop() ?? "";
      const last = lines.filter(Boolean).pop();
      if (last) onProgress({ phase: "start", message: this.message!, detail: last.slice(0, 300) });
    };
    child.stdout?.on("data", feed);
    child.stderr?.on("data", feed);
    child.on("exit", (code) => {
      if (this.child === child) {
        this.child = null;
        this.state = "idle";
        this.message = code === 0 ? "服务已停止" : `服务进程退出（code=${code}）`;
      }
    });

    const engine = new GenieTtsEngine({ baseUrl: this.baseUrl(), timeoutMs: 4_000 });
    const deadline = Date.now() + 180_000;
    while (Date.now() < deadline) {
      if (child.exitCode !== null) break;
      if (await engine.ping()) {
        this.state = "running";
        this.message = "服务已启动";
        onProgress({ phase: "start", message: "服务已启动 ✓" });
        return;
      }
      await new Promise((r) => setTimeout(r, 2_000));
    }
    this.disable();
    this.state = "error";
    this.message = "服务启动超时，请查看上方日志或手动启动排查。";
    throw new Error(this.message);
  }

  /** 取消当前模型下载：结束进程并清掉下载残留 */
  async cancelDownload(): Promise<void> {
    ensureGenieDirs();
    if (this.downloadTaskKey) {
      this.cancelRequested = true;
      this.activeDownloadAborted = "cancel";
      this.message = "正在取消…";
      this.lastProgress = { phase: "download", message: "正在取消…" };
      if (this.activeDownload) {
        this.activeDownload.kill();
      }
      // 运行时归档下载没有子进程可杀，直接断开 HTTP（否则要等下一个数据块才收尾）
      this.activeHttpAbort?.();
      return;
    }
    // 没有下载任务：只做一次残留清理，别把取消标记留到下一次下载
    this.cancelRequested = false;
    this.activeDownloadAborted = null;
    this.activeDownloadKey = null;
    clearHfDownloadResidue(genieRootDir());
    this.state = "idle";
    this.message = "下载已取消";
  }

  /** 删除一个已下载的角色模型（仅删 CharacterModels/v2ProPlus/<key>，不删公共资源） */
  async deleteModel(characterKey: string): Promise<void> {
    ensureGenieDirs();
    // 删除必须拒绝空标识：normalizeModelKey 会把空串兜底成 feibi，
    // 用在这里会把默认中文模型误删（下载路径需要那个兜底，删除路径绝不能有）。
    const safeKey = characterKey.toLowerCase().replace(/[^a-z0-9_-]/g, "");
    if (!safeKey) throw new Error("无效的模型标识。");
    if (this.downloadTaskKey === safeKey) {
      throw new Error("该模型正在下载，请先暂停或取消。");
    }
    const target = genieCharacterDir(safeKey);
    if (!fs.existsSync(target)) throw new Error("该模型尚未下载，无需删除。");
    fs.rmSync(target, { recursive: true, force: true });
    const ready = readReady();
    if (ready.modelDir && path.resolve(ready.modelDir).startsWith(path.resolve(target))) {
      try {
        fs.rmSync(readyFile(), { force: true });
      } catch {
        /* 忽略标记删除失败 */
      }
    }
    this.state = "idle";
    // 只报状态，不回显模型标识（避免把技术命名透给用户）
    this.message = "模型已删除";
  }

  /** 一键启用：下载（如缺）→ 启动（兼容旧入口） */
  async enable(onProgress: (p: LocalTtsProgress) => void): Promise<void> {
    const outcome = await this.runDownloadTask(onProgress, "feibi");
    // 取消、或并到了别人正在跑的同一个任务上：别接着启动服务（模型这时还没就绪）
    if (outcome !== "ok") return;
    await this.startService(onProgress);
  }

  /** 独立步骤：只安装依赖 + 下载指定角色模型（阻塞版，内部仍被 runDownloadTask 串行化） */
  async download(
    onProgress: (p: LocalTtsProgress) => void,
    characterKey = "feibi"
  ): Promise<DownloadOutcome> {
    return this.runDownloadTask(onProgress, characterKey);
  }

  /**
   * 后台开始下载：**立刻返回**，任务由主进程继续跑（装依赖 → 下载模型）。
   *
   * 这是给界面用的入口。之前是「IPC 一直 await 到下载结束」——几分钟里界面只能干等，
   * 切走页面就不知道还在不在下；现在受理即返回，进度走 onProgress、结局走 onDone，
   * 界面（任意页面）随时可以读 task() 拿进度、或点取消。
   *
   * 并发守卫在这里同步抛出（调用方直接拿错误回给界面）：
   * 同一个模型并到正在跑的任务上（不再通知），换一个模型则拒绝，绝不并行两个下载进程。
   */
  startDownloadInBackground(
    onProgress: (p: LocalTtsProgress) => void,
    characterKey: string,
    onDone: (r: LocalTtsTaskResult) => void
  ): void {
    const key = normalizeModelKey(characterKey);
    if (this.isDownloadBusy()) {
      if (this.downloadTaskKey === key) return;
      appendDiagnosticLog("拒绝并发下载", [
        `已有任务在跑: ${this.downloadTaskKey}`,
        `本次请求: ${key}`,
        `当前进度: ${this.lastProgress?.message ?? "(无)"}`,
      ]);
      throw new Error("已有模型正在下载，请等它完成或点「取消」后再换一个。");
    }
    // 注意：download() 的同步段会先把 downloadTaskKey 置位，所以紧接着调 task()/env()
    // 就能看到「下载中」，界面不会先闪一下「未下载」。
    void this.download(onProgress, key)
      .then((outcome) => {
        if (outcome === "joined") return;
        onDone({
          key,
          ok: outcome === "ok",
          cancelled: outcome === "cancelled",
          message: outcome === "ok" ? "语音合成环境已就绪" : "下载已取消",
        });
      })
      .catch((e: any) => {
        onDone({ key, ok: false, message: String(e?.message ?? e) });
      });
  }

  /**
   * 任务快照：只读内存状态，不探测 Python、不 ping 服务。
   * 界面轮询它来恢复/对齐「下载中」状态，因此必须便宜（见 LocalTtsTaskSnapshot 注释）。
   */
  task(): LocalTtsTaskSnapshot {
    return {
      downloadingKey: this.downloadTaskKey,
      progress: this.lastProgress,
      state: this.state,
      message: this.message,
    };
  }

  /**
   * 下载任务的唯一入口。
   *
   * 界面切走再切回（甚至重开窗口）时，组件自己的 busy 状态已经丢了，
   * 只能靠主进程这份状态恢复；所以并发必须在这里挡住——
   * 否则会起第二个 snapshot_download，和进行中的进程抢同一份 local_dir / HF 缓存。
   */
  private async runDownloadTask(
    onProgress: (p: LocalTtsProgress) => void,
    characterKey: string
  ): Promise<DownloadOutcome> {
    const key = normalizeModelKey(characterKey);
    ensureGenieDirs();
    if (this.isDownloadBusy()) {
      // 同一个模型：并到正在跑的任务上；换一个模型则明确拒绝，别并行下载
      if (this.downloadTaskKey === key) return "joined";
      appendDiagnosticLog("拒绝并发下载", [
        `已有任务在跑: ${this.downloadTaskKey}`,
        `本次请求: ${key}`,
        `当前进度: ${this.lastProgress?.message ?? "(无)"}`,
      ]);
      throw new Error("已有模型正在下载，请等它完成或点「取消」后再换一个。");
    }
    this.downloadTaskKey = key;
    this.cancelRequested = false;
    this.activeDownloadAborted = null;
    const send = (p: LocalTtsProgress) => {
      this.lastProgress = p;
      onProgress(p);
    };
    // 受理当刻就发一条进度：界面（含任意页面上的后台下载条）点下去就有反馈，
    // 不用等 prepare 里的 python 自检跑完才有第一条事件。
    this.state = "downloading";
    send({ phase: "download", message: "正在准备下载语音模型…" });
    // 任务从哪一步开始、走到哪一步失败，都留痕：界面只给一句通用提示，
    // 排查要看的是"卡在哪"。日志上限 256KB，正常下载也就几行。
    appendDiagnosticLog("开始下载任务", [], { 角色: key, python: this.python?.display ?? "(未探测)" });
    try {
      const outcome = await this.prepare(send, key);
      appendDiagnosticLog(outcome === "ok" ? "下载任务成功" : "下载任务已取消", [], { 角色: key });
      return outcome;
    } catch (e: any) {
      appendDiagnosticLog("下载任务异常", [String(e?.stack ?? e)], {
        角色: key,
        code: String(e?.code ?? ""),
        阶段: this.state,
        消息: String(e?.message ?? ""),
      });
      throw e;
    } finally {
      this.downloadTaskKey = null;
      this.lastProgress = null;
      this.activeDownload = null;
      this.activeDownloadKey = null;
      this.cancelRequested = false;
      this.activeDownloadAborted = null;
    }
  }

  /** 独立步骤：只启动本地语音服务 */
  async start(onProgress: (p: LocalTtsProgress) => void): Promise<void> {
    await this.startService(onProgress);
  }

  /** 停用：先请求服务停止，再杀子进程 */
  async disable(): Promise<void> {
    this.state = "stopping";
    this.message = "正在停止本地语音服务…";
    if (this.isChildAlive()) {
      try {
        await new GenieTtsEngine({ baseUrl: this.baseUrl(), timeoutMs: 3_000 }).stop();
      } catch {
        /* 忽略 */
      }
      const child = this.child!;
      this.child = null;
      child.kill();
    }
    this.state = "idle";
    this.message = "服务已停止，不再占用资源";
  }

  /**
   * 应用退出时收尾。
   *
   * 后台下载是「不 await 继续跑」的，进程退出不会等它——下载脚本（python）与 pip 是
   * 独立子进程，不杀就会变成孤儿进程继续占带宽/占目录。这里同步杀掉它们；
   * 半成品留在 HF 缓存里，下次点下载接着续传（见 clearHfDownloadResidue）。
   */
  shutdown(): void {
    for (const child of [this.activeDownload, this.child]) {
      if (!child) continue;
      try {
        child.kill();
      } catch {
        /* 已经退出了 */
      }
    }
    // 归档下载走的是自己的 HTTP 连接，没有子进程要杀，直接断开
    this.activeHttpAbort?.();
    this.activeDownload = null;
    this.child = null;
  }
}

export const genieManager = new GenieManager();
