/**
 * worker — 作业执行器（独立进程）。
 *
 * 由 jobs.ts 以 detached 方式拉起：`electron bundle.cjs --job-file <job文件>`。
 * 进度/终态全部**原子写回 job 文件** —— 谁来查状态都读同一份，MCP 服务重启
 * 也不丢账。取消是协作式的：MCP 侧写 cancelRequested 标志，这里每个进度节拍
 * （外加一个 800ms 的兜底轮询）检查一次再 abort。
 */
import fs from "node:fs";

export async function runJobWorker(jobFilePath: string): Promise<void> {
  if (!jobFilePath || !fs.existsSync(jobFilePath)) {
    console.error(`[worker] 缺 --job-file 参数或文件不存在：${jobFilePath}`);
    process.exit(2);
  }

  const job = JSON.parse(fs.readFileSync(jobFilePath, "utf-8"));
  const readJob = () => JSON.parse(fs.readFileSync(jobFilePath, "utf-8"));
  const writeJob = () => {
    const tmp = `${jobFilePath}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(job, null, 2), "utf-8");
    fs.renameSync(tmp, jobFilePath);
  };

  job.state = "running";
  job.startedAt = Date.now();
  job.pid = process.pid;
  writeJob();

  const controller = new AbortController();
  // 兜底轮询：能力的进度回调之间可能隔很久（比如下载大文件没到百分比跳变点）
  const poll = setInterval(() => {
    try {
      const cur = readJob();
      if (cur?.cancelRequested && !controller.signal.aborted) {
        controller.abort(new Error("已按请求取消"));
      }
    } catch {
      /* 读文件抖一下不算事 */
    }
  }, 800);

  let lastMsg = "";
  let lastPct = -1;
  const emit = (p: { percent?: number; message?: string }) => {
    if (p.percent !== undefined && p.percent !== lastPct) {
      lastPct = p.percent;
      job.progress.percent = p.percent;
    }
    if (p.message !== undefined && p.message !== lastMsg) {
      lastMsg = p.message;
      job.progress.message = p.message;
    }
    writeJob();
  };

  try {
    const { runJob } = await import("./capabilities");
    const result = await runJob(job.kind, job.params ?? {}, {
      jobId: String(job.id ?? "unknown"),
      signal: controller.signal,
      emit,
    });
    job.state = "done";
    job.outputPath = result.outputPath ?? null;
    job.note = result.note ?? "";
    job.data = result.data ?? null;
    job.progress = { percent: 100, message: result.note || "完成" };
    job.endedAt = Date.now();
  } catch (e: any) {
    const msg = String(e?.message ?? e);
    const cancelled = controller.signal.aborted || job.cancelRequested === true || /取消/.test(msg);
    job.state = cancelled ? "cancelled" : "failed";
    job.error = cancelled ? "已取消" : msg;
    job.endedAt = Date.now();
    job.progress = { percent: job.progress?.percent ?? 0, message: cancelled ? "已取消" : `失败：${msg}` };
  } finally {
    clearInterval(poll);
    writeJob();
  }
}
