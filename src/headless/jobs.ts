/**
 * jobs — 作业的落盘存储与 worker 进程调度。
 *
 * 为什么是「文件 + detached 子进程」，不是内存里跑：
 * bandi 的 agent 每一轮都是一个**新的 CLI 会话**，stdio 上的 MCP 服务跟着会话
 * 生死 —— 提交完作业，下一轮来查状态时，原来的 MCP 进程可能已经不在了。
 * 作业状态落盘（<dataDir>/mcp/jobs/<id>.json）+ worker 是 detached 子进程，
 * 谁来查都读同一份文件：提交、轮询、取消跨会话全部成立。GUI 关不关无所谓。
 *
 * 并发口径：**全局单飞**（与 GUI 任务卡的 runner.ts 同一个先例）—— 宝螺这边
 * 合成/下载/识别都是吃 CPU 和磁盘的活，两个一起跑除了打架没有好处。
 */
import fs from "node:fs";
import path from "node:path";
import { spawn } from "node:child_process";
import { currentDataDir } from "../main/userData";

export type JobKind =
  | "download"
  | "transcribe"
  | "write_script"
  | "tts"
  | "compose_dialogue"
  | "sniff"
  | "write_storyboard"
  | "generate_image";

export const JOB_KINDS: JobKind[] = [
  "download",
  "transcribe",
  "write_script",
  "tts",
  "compose_dialogue",
  "sniff",
  "write_storyboard",
  "generate_image",
];

export type JobState = "queued" | "running" | "done" | "failed" | "cancelled";

export interface JobRecord {
  id: string;
  kind: JobKind;
  params: Record<string, unknown>;
  state: JobState;
  createdAt: number;
  startedAt?: number;
  endedAt?: number;
  progress: { percent: number; message: string };
  outputPath?: string | null;
  note?: string;
  error?: string | null;
  /** 取消是协作式的：MCP 侧写标志，worker 每个进度节拍检查一次再 abort */
  cancelRequested?: boolean;
  pid?: number;
}

const ID_RE = /^j_[a-z0-9]+$/;

function jobsDir(): string {
  return path.join(currentDataDir(), "mcp", "jobs");
}

function jobFile(id: string): string {
  if (!ID_RE.test(id)) throw new Error(`作业 id 形状不对：${id.slice(0, 40)}`);
  return path.join(jobsDir(), `${id}.json`);
}

/** 原子写：先写临时文件再改名，查询方永远读不到半截 JSON */
function writeJob(job: JobRecord, file?: string): void {
  const f = file ?? jobFile(job.id);
  fs.mkdirSync(path.dirname(f), { recursive: true });
  const tmp = `${f}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(job, null, 2), "utf-8");
  fs.renameSync(tmp, f);
}

function readJob(id: string): JobRecord | null {
  const f = jobFile(id);
  try {
    const raw = JSON.parse(fs.readFileSync(f, "utf-8")) as JobRecord;
    return raw && Array.isArray(raw.params) === false ? raw : null;
  } catch {
    return null;
  }
}

function readAll(): JobRecord[] {
  const dir = jobsDir();
  let names: string[] = [];
  try {
    names = fs.readdirSync(dir).filter((n) => /^j_[a-z0-9]+\.json$/.test(n));
  } catch {
    return [];
  }
  const out: JobRecord[] = [];
  for (const n of names) {
    try {
      const job = JSON.parse(fs.readFileSync(path.join(dir, n), "utf-8")) as JobRecord;
      if (job && job.id && job.kind) out.push(job);
    } catch {
      /* 半截文件（正在写）跳过 */
    }
  }
  return out.sort((a, b) => b.createdAt - a.createdAt);
}

export interface SubmitResult {
  jobId: string;
  kind: JobKind;
  message: string;
}

export function submitJob(kind: JobKind, params: Record<string, unknown>): SubmitResult {
  const busy = readAll().find((j) => j.state === "queued" || j.state === "running");
  if (busy) {
    throw new Error(
      `宝螺这里已经有作业 ${busy.id}（${busy.kind}，${busy.progress?.message ?? "进行中"}）在跑 —— ` +
        `一次只跑一个。先等它完成（baoluo_job_status），或 baoluo_job_cancel 取消后再提交。`
    );
  }
  const id = `j_${Date.now().toString(36)}${Math.floor(Math.random() * 1e6).toString(36)}`;
  const job: JobRecord = {
    id,
    kind,
    params: params ?? {},
    state: "queued",
    createdAt: Date.now(),
    progress: { percent: 0, message: "排队中" },
    outputPath: null,
    error: null,
  };
  writeJob(job);

  // worker = 同一份入口脚本以 detached 方式再拉一个（argv 分流见 index.ts）。
  // stdio 全部落进作业日志，进程树与 MCP 服务彻底脱钩 —— 服务重启作业照跑。
  const script = path.resolve(process.argv[1] ?? __filename);
  const logFd = fs.openSync(path.join(jobsDir(), `${id}.log`), "a");
  try {
    const child = spawn(process.execPath, [script, "--job-file", jobFile(id)], {
      detached: true,
      stdio: ["ignore", logFd, logFd],
      env: { ...process.env, BAOLUO_MCP_WORKER: "1" },
      windowsHide: true,
    });
    child.unref();
    job.pid = child.pid;
  } finally {
    fs.closeSync(logFd);
  }
  writeJob(job);
  return { jobId: id, kind, message: `作业 ${id} 已提交（${kind}）` };
}

export function jobStatus(id: string): JobRecord | null {
  return readJob(id);
}

export function jobList(): JobRecord[] {
  return readAll();
}

export function cancelJob(id: string): string {
  const job = readJob(id);
  if (!job) return `没找到作业 ${id} —— 用 baoluo_job_list 看一眼现在都有哪些。`;
  if (job.state === "done" || job.state === "failed" || job.state === "cancelled") {
    return `作业 ${id} 已经${job.state === "done" ? "完成" : job.state === "cancelled" ? "取消" : "失败"}了（${job.endedAt ? new Date(job.endedAt).toLocaleString() : ""}），不用取消。`;
  }
  job.cancelRequested = true;
  writeJob(job);
  return `已请求取消 ${id}（${job.kind}）。worker 会在下一个进度节拍停手；过一会儿用 baoluo_job_status 确认。`;
}
