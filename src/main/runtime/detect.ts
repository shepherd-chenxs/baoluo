/**
 * 运行时识别 —— 只认本机已经装好的智能体 CLI，不代装（与 bandi 同一条口径）。
 *
 * 为什么不能只看 `process.env.PATH`：GUI 进程的 PATH 是**启动那一刻**继承的快照。
 * CLI 在宝螺启动之后才装（改的是注册表里的用户 PATH）、或者用 fnm/nvm 这类
 * 版本管理器装的（只对跑过 `fnm env` 的 shell 可见），快照里都没有 ——
 * 于是"明明装了却显示没装"。所以探测目录要**实时拼**三路：
 *
 *   1) 进程 PATH（排最前，用户手改的优先）
 *   2) Windows 注册表里的系统 PATH（HKLM）+ 用户 PATH（HKCU），`%VAR%` 展开
 *   3) 安装器固定落点（npm / pnpm / bun / scoop / volta / fnm / ~/.local/bin …）
 *
 * 识别 = 找到文件 **且** `--version` 起得来。起不来的（只有 .ps1、shim 坏了）
 * 标 broken，不给「应用」——不然应用完对话区一用就报错，还不知道为什么。
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFile, spawn } from "node:child_process";
import type { RuntimeId, RuntimeInfo } from "../../shared/runtime-types";

const IS_WIN = process.platform === "win32";
/** 探测目录 5 秒记忆化：一次页面加载里三个家族各 stat 一遍，别把注册表也查三遍 */
const DIRS_TTL_MS = 5_000;
/** 识别结果缓存：页面来回切不要每次都重新起子进程（用户点「重新识别」才强制刷新） */
const RESULT_TTL_MS = 30_000;
/** 单次 --version 的上限：起不来的 shim 会一直挂着，必须有超时 */
const PROBE_TIMEOUT_MS = 8_000;

interface FamilyDef {
  id: RuntimeId;
  label: string;
  vendor: string;
  bin: string;
}

const FAMILIES: FamilyDef[] = [
  { id: "codex", label: "Codex CLI", vendor: "OpenAI", bin: "codex" },
  { id: "claude", label: "Claude Code", vendor: "Anthropic", bin: "claude" },
  { id: "gemini", label: "Gemini CLI", vendor: "Google", bin: "gemini" },
];

/** Windows 上同一家族可能有好几种壳：exe 最稳，cmd 次之，ps1 直接起不来 */
const WIN_EXTS = [".exe", ".cmd", ".bat", "", ".ps1"];
const POSIX_EXTS = ["", ".sh"];

let dirsCache: { at: number; dirs: string[] } | null = null;
let resultCache: { at: number; list: RuntimeInfo[] } | null = null;

function uniqueDirs(dirs: Array<string | undefined | null>): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const raw of dirs) {
    const d = (raw ?? "").trim();
    if (!d) continue;
    const key = IS_WIN ? d.toLowerCase() : d;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(d);
  }
  return out;
}

/** 注册表里的 `%USERPROFILE%` 这类占位符要展开，不然拼出来的路径根本不存在 */
function expandEnv(s: string): string {
  return s.replace(/%([^%]+)%/g, (m, name: string) => {
    const v = process.env[name] ?? process.env[name.toUpperCase()];
    return v ?? m;
  });
}

function readRegistryPath(hive: "HKCU" | "HKLM", key: string): Promise<string[]> {
  return new Promise((resolve) => {
    try {
      execFile(
        "reg",
        ["query", key, "/v", "Path"],
        { windowsHide: true, timeout: 3_000 },
        (err, stdout) => {
          if (err || !stdout) {
            resolve([]);
            return;
          }
          // 形如：  Path    REG_EXPAND_SZ    C:\a;D:\b
          const m = /Path\s+REG_(?:EXPAND_)?SZ\s+(.+)/i.exec(stdout);
          if (!m) {
            resolve([]);
            return;
          }
          resolve(
            m[1]
              .split(";")
              .map((s) => expandEnv(s.trim()))
              .filter(Boolean)
          );
        }
      );
    } catch {
      // 安全软件把 reg.exe 拦掉时会直接抛 EPERM（连回调都不给）：静默退回进程 PATH
      resolve([]);
    }
  });
}

/** fnm 每个 Node 版本的安装目录里也可能有全局 CLI（aliases 没指到的那份） */
function fnmVersionDirs(): string[] {
  const root = process.env.APPDATA ? path.join(process.env.APPDATA, "fnm", "node-versions") : "";
  if (!root) return [];
  try {
    return fs
      .readdirSync(root)
      .sort()
      .reverse()
      .slice(0, 4)
      .map((v) => path.join(root, v, "installation"))
      .filter((p) => fs.existsSync(p));
  } catch {
    return [];
  }
}

function wellKnownDirs(): string[] {
  const home = os.homedir();
  if (!IS_WIN) {
    return [
      "/usr/local/bin",
      "/opt/homebrew/bin",
      path.join(home, ".local", "bin"),
      path.join(home, ".npm-global", "bin"),
      path.join(home, ".bun", "bin"),
    ];
  }
  const appData = process.env.APPDATA ?? path.join(home, "AppData", "Roaming");
  const localAppData = process.env.LOCALAPPDATA ?? path.join(home, "AppData", "Local");
  return [
    path.join(appData, "npm"),
    path.join(localAppData, "pnpm"),
    path.join(home, ".bun", "bin"),
    path.join(home, ".local", "bin"),
    path.join(home, "scoop", "shims"),
    path.join(home, ".volta", "bin"),
    path.join(appData, "fnm", "aliases", "default"),
    ...fnmVersionDirs(),
    path.join(process.env.ProgramFiles ?? "C:\\Program Files", "nodejs"),
  ];
}

/** 实时拼探测目录（进程 PATH → 注册表 → 安装器固定落点） */
async function searchDirs(): Promise<string[]> {
  if (dirsCache && Date.now() - dirsCache.at < DIRS_TTL_MS) return dirsCache.dirs;

  const fromPath = (process.env.PATH ?? process.env.Path ?? "")
    .split(IS_WIN ? ";" : ":")
    .map((s) => s.trim())
    .filter(Boolean);
  const fromRegistry = IS_WIN
    ? [
        ...(await readRegistryPath("HKLM", "HKLM\\SYSTEM\\CurrentControlSet\\Control\\Session Manager\\Environment")),
        ...(await readRegistryPath("HKCU", "HKCU\\Environment")),
      ]
    : [];
  const dirs = uniqueDirs([...fromPath, ...fromRegistry, ...wellKnownDirs()]);
  dirsCache = { at: Date.now(), dirs };
  return dirs;
}

/**
 * 起一个 CLI 子进程：`.cmd/.bat` 必须经 shell（Node 直接 spawn 会 EINVAL）。
 * 路径带空格时用引号包住，否则 cmd 会把 `C:\Program Files\…` 拆成两段。
 * 导出给对话执行复用，免得两处各写一套（一处踩过的坑另一处又踩一遍）。
 */
export function spawnCli(file: string, args: string[], opts: { cwd?: string } = {}) {
  const base = {
    cwd: opts.cwd,
    env: process.env,
    windowsHide: true,
    stdio: ["pipe", "pipe", "pipe"] as ["pipe", "pipe", "pipe"],
  };
  if (IS_WIN && /\.(cmd|bat)$/i.test(file)) {
    return spawn(`"${file}"`, args, { ...base, shell: true });
  }
  return spawn(file, args, base);
}

/** 探一次 `--version`：既验"文件在"，也验"起得来" */
function probeVersion(file: string): Promise<{ ok: boolean; version?: string; note?: string }> {
  if (IS_WIN && /\.ps1$/i.test(file)) {
    return Promise.resolve({ ok: false, note: "只有 PowerShell 脚本（.ps1），宝螺直接起不动它" });
  }
  return new Promise((resolve) => {
    let out = "";
    let settled = false;
    const finish = (r: { ok: boolean; version?: string; note?: string }) => {
      if (settled) return;
      settled = true;
      resolve(r);
    };

    let child: ReturnType<typeof spawn>;
    try {
      child = spawnCli(file, ["--version"]);
    } catch (e) {
      finish({ ok: false, note: e instanceof Error ? e.message : String(e) });
      return;
    }

    const timer = setTimeout(() => {
      try {
        child.kill();
      } catch {
        /* noop */
      }
      finish({ ok: false, note: `--version 超过 ${PROBE_TIMEOUT_MS / 1000} 秒没返回` });
    }, PROBE_TIMEOUT_MS);

    child.stdout?.on("data", (d: Buffer) => (out += d.toString()));
    child.stderr?.on("data", (d: Buffer) => (out += d.toString()));
    child.on("error", (e) => {
      clearTimeout(timer);
      finish({ ok: false, note: e.message });
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      const text = out.trim();
      const version = /(\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.]+)?)/.exec(text)?.[1];
      if (code === 0 && text) {
        finish({ ok: true, version });
        return;
      }
      const tail = text.split(/\r?\n/).map((l) => l.trim()).filter(Boolean).slice(-1)[0];
      finish({ ok: false, note: tail || `退出码 ${code ?? "未知"}` });
    });
  });
}

/** 某个 bin 在各个探测目录里的所有安装位置（每个目录只取优先级最高的那个扩展名） */
function findInstalls(bin: string, dirs: string[]): string[] {
  const exts = IS_WIN ? WIN_EXTS : POSIX_EXTS;
  const out: string[] = [];
  for (const dir of dirs) {
    for (const ext of exts) {
      const p = path.join(dir, bin + ext);
      try {
        if (fs.statSync(p).isFile()) {
          out.push(p);
          break;
        }
      } catch {
        /* 没有就试下一个扩展名 */
      }
    }
  }
  return out;
}

/**
 * 扫一遍本机：每个家族取第一份**起得来**的安装（第一份坏了会再试第二份）。
 * 一份都起不来时，把第一份以 broken 列出来 —— 让用户看见"装了但宝螺起不动"，
 * 而不是凭空消失。
 */
export async function detectRuntimes(): Promise<RuntimeInfo[]> {
  const dirs = await searchDirs();
  const list: RuntimeInfo[] = [];

  for (const fam of FAMILIES) {
    const installs = findInstalls(fam.bin, dirs);
    if (!installs.length) continue;

    let picked: RuntimeInfo | null = null;
    for (const file of installs.slice(0, 2)) {
      const probe = await probeVersion(file);
      const info: RuntimeInfo = {
        id: fam.id,
        label: fam.label,
        vendor: fam.vendor,
        path: file,
        version: probe.version,
        status: probe.ok ? "ready" : "broken",
        note: probe.ok ? undefined : probe.note,
        installs: installs.slice(0, 3),
      };
      if (probe.ok) {
        picked = info;
        break;
      }
      picked = picked ?? info;
    }
    if (picked) list.push(picked);
  }

  resultCache = { at: Date.now(), list };
  return list;
}

/** 带缓存版（30 秒）。`force` = 用户点了「重新识别」 */
export async function detectRuntimesCached(force = false): Promise<RuntimeInfo[]> {
  if (!force && resultCache && Date.now() - resultCache.at < RESULT_TTL_MS) {
    return resultCache.list;
  }
  if (force) {
    dirsCache = null; // 用户点重新识别 = 连探测目录一起重读（刚装完 PATH 就变了）
  }
  return detectRuntimes();
}

export function cachedRuntimes(): RuntimeInfo[] {
  return resultCache?.list ?? [];
}

export function detectedAt(): number | null {
  return resultCache?.at ?? null;
}

/** 按 id 找一份能用的运行时（对话区执行前调用；没扫过就先扫一遍） */
export async function findRuntime(id: RuntimeId): Promise<RuntimeInfo | null> {
  const list = await detectRuntimesCached();
  const hit = list.find((r) => r.id === id);
  if (!hit || hit.status !== "ready") return null;
  return hit;
}
