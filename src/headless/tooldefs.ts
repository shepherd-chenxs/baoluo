/**
 * tooldefs — MCP 工具表：name / description / inputSchema + 分派。
 *
 * 参数是扁平化的（GUI 任务卡把参数挂在多个步骤上，这里摊平成一个对象），
 * 形状逆向自 agent/workflows.ts 的步骤构造器。所有长任务一律「提交即返回
 * jobId」，轮询/取消走三个作业工具 —— 见 jobs.ts 的注释（跨会话可见性）。
 */
import type { ToolDef, ToolCallResult } from "./protocol";
import { submitJob, jobStatus, jobList, cancelJob, type JobKind } from "./jobs";

/** 长任务工具名 → 作业 kind */
const JOB_TOOLS: Record<string, JobKind> = {
  baoluo_download: "download",
  baoluo_transcribe: "transcribe",
  baoluo_write_script: "write_script",
  baoluo_tts: "tts",
  baoluo_compose_dialogue: "compose_dialogue",
  baoluo_sniff: "sniff",
  baoluo_write_storyboard: "write_storyboard",
  baoluo_generate_image: "generate_image",
};

const obj = (
  properties: Record<string, unknown>,
  required: string[] = []
): Record<string, unknown> => ({ type: "object", properties, required, additionalProperties: false });

const s = (description: string): Record<string, unknown> => ({ type: "string", description });

export function getToolDefs(): ToolDef[] {
  return [
    {
      name: "baoluo_parse_link",
      description:
        "解析视频分享文本/链接（抖音/快手/B站/小红书），返回标题、作者、时长、播放地址。秒级，同步返回。",
      inputSchema: obj({ link: s("分享文本或链接") }, ["link"]),
    },
    {
      name: "baoluo_download",
      description: "下载无水印视频原片。提交后台作业，返回 jobId。",
      inputSchema: obj({ link: s("分享文本或链接"), outDir: s("产物目录（默认宝螺素材目录）") }, ["link"]),
    },
    {
      name: "baoluo_transcribe",
      description: "本地 Whisper 识别音视频人声，输出文案 txt（不联网）。提交后台作业，返回 jobId。",
      inputSchema: obj(
        { inputPath: s("音视频文件完整路径"), language: s("语言代码，默认 zh"), outDir: s("产物目录（默认文件所在目录）") },
        ["inputPath"]
      ),
    },
    {
      name: "baoluo_write_script",
      description: "用宝螺配置的大模型（DeepSeek 或 CLI 运行时）把主题/文案写成双人对话脚本。提交后台作业，返回 jobId。",
      inputSchema: obj(
        {
          topic: s("主题"),
          transcript: s("参考文案（可选，照着改写成对话）"),
          durationSeconds: { type: "number", description: "目标时长秒数，默认 45" },
          outDir: s("产物目录（默认宝螺输出目录）"),
        },
        []
      ),
    },
    {
      name: "baoluo_tts",
      description: "文本转语音。在线音色（zh-CN-XiaoxiaoNeural 等）或本地克隆音色（voice 填 clone:<音色id>）；voice 不传时用宝螺设置的默认音色。提交后台作业，返回 jobId。",
      inputSchema: obj(
        {
          text: s("要念的文字"),
          voice: s("音色名或 clone:<音色id>（不传 = 宝螺设置的默认音色）"),
          rate: { type: "number", description: "语速百分比变化，如 10 = +10%（仅在线音色）" },
          outDir: s("产物目录（默认宝螺输出目录/tts）"),
        },
        ["text"]
      ),
    },
    {
      name: "baoluo_compose_dialogue",
      description:
        "对话视频合成：脚本 + 两张角色图 + 两个音色 → 逐句配音、拼画面、烧字幕，出 mp4。提交后台作业，返回 jobId。图不传时用内置模板形象图；音色不传时用宝螺设置里的默认。",
      inputSchema: obj(
        {
          script: s("对话脚本文本（甲：…/乙：…）"),
          scriptPath: s("脚本文件路径（script 与 scriptPath 二选一）"),
          voiceFortune: s("甲方音色（默认取宝螺设置）"),
          voiceCustomer: s("乙方音色（默认取宝螺设置）"),
          imageFortune: s("甲方角色图路径（默认内置模板形象图）"),
          imageCustomer: s("乙方角色图路径（默认内置模板形象图）"),
          resolution: s("portrait（竖版，默认）或 landscape（横版）"),
          name: s("成片名（默认 mcp_<作业id>）"),
          outDir: s("产物目录（默认宝螺设置的输出目录）"),
          rateA: { type: "number", description: "甲方语速%" },
          pitchA: { type: "number", description: "甲方音调%" },
          volumeA: { type: "number", description: "甲方音量%" },
          rateB: { type: "number", description: "乙方语速%" },
          pitchB: { type: "number", description: "乙方音调%" },
          volumeB: { type: "number", description: "乙方音量%" },
        },
        []
      ),
    },
    {
      name: "baoluo_sniff",
      description: "爆款拆解：一条链接 → 开头钩子/叙事结构/可复用方法/同方法选题，出「爆款拆解.txt」。提交后台作业，返回 jobId。",
      inputSchema: obj({ link: s("视频链接"), niche: s("领域（可选，让拆解更对口）"), outDir: s("产物目录") }, ["link"]),
    },
    {
      name: "baoluo_write_storyboard",
      description: "按主题写分镜：旁白 + 每镜画面提示词，出「分镜提示词.txt」（提示词可拿去任意生图工具）。提交后台作业，返回 jobId。",
      inputSchema: obj(
        {
          topic: s("主题或热点"),
          durationSeconds: { type: "number", description: "目标时长秒数，默认 60" },
          resolution: s("portrait（默认）或 landscape"),
          outDir: s("产物目录"),
        },
        ["topic"]
      ),
    },
    {
      name: "baoluo_generate_image",
      description: "按提示词生成一张图（仅 ModelScope 引擎；豆包要在宝螺界面里用）。提交后台作业，返回 jobId。",
      inputSchema: obj(
        {
          prompt: s("画面描述"),
          resolution: s("portrait（720x1280，默认）或 landscape（1280x720）"),
          outDir: s("产物目录"),
        },
        ["prompt"]
      ),
    },
    {
      name: "baoluo_job_status",
      description: "查一个作业的状态：state / percent / message / outputPath / error。",
      inputSchema: obj({ jobId: s("作业 id") }, ["jobId"]),
    },
    {
      name: "baoluo_job_list",
      description: "列出最近的作业（新到旧）。",
      inputSchema: obj({}),
    },
    {
      name: "baoluo_job_cancel",
      description: "请求取消一个还在跑的作业（协作式：worker 在下一个进度节拍停手）。",
      inputSchema: obj({ jobId: s("作业 id") }, ["jobId"]),
    },
  ];
}

const str = (v: unknown): string => String(v ?? "").trim();

export async function dispatchToolCall(name: string, args: Record<string, unknown>): Promise<ToolCallResult> {
  if (name === "baoluo_parse_link") {
    const { parseLink } = await import("./capabilities");
    const r = await parseLink(str(args.link), new AbortController().signal);
    return { text: `${r.note}\n${JSON.stringify(r.data ?? {}, null, 2)}` };
  }

  const kind = JOB_TOOLS[name];
  if (kind) {
    const r = submitJob(kind, args ?? {});
    return {
      text:
        `${r.message}。用 baoluo_job_status {jobId:"${r.jobId}"} 查进度（宝螺一次只跑一个作业）；` +
        `完成后 outputPath 是产物文件完整路径。`,
    };
  }

  if (name === "baoluo_job_status") {
    const id = str(args.jobId);
    const j = jobStatus(id);
    if (!j) return { text: `没找到作业 ${id} —— 用 baoluo_job_list 看一眼现在都有哪些。`, isError: true };
    return {
      text: JSON.stringify(
        {
          jobId: j.id,
          kind: j.kind,
          state: j.state,
          percent: j.progress?.percent ?? 0,
          message: j.progress?.message ?? "",
          outputPath: j.outputPath ?? null,
          note: j.note ?? "",
          error: j.error ?? null,
          createdAt: j.createdAt,
          endedAt: j.endedAt ?? null,
        },
        null,
        2
      ),
    };
  }

  if (name === "baoluo_job_list") {
    const jobs = jobList();
    if (!jobs.length) return { text: "还没有作业。" };
    return {
      text: jobs
        .map((j) => `${j.id} · ${j.kind} · ${j.state} · ${j.progress?.message ?? ""}${j.outputPath ? ` · ${j.outputPath}` : ""}`)
        .join("\n"),
    };
  }

  if (name === "baoluo_job_cancel") {
    return { text: cancelJob(str(args.jobId)) };
  }

  return { text: `没有这个工具：${name}`, isError: true };
}
