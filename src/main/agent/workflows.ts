/*
 * SPDX-License-Identifier: GPL-3.0-only
 * Copyright (c) 2026 宝螺 / Baoluo contributors
 * 本文件属于「宝螺 / Baoluo」。除 GPL-3.0 外还适用 ADDITIONAL_TERMS.md 里的附加条款：
 * 分发时须保留来源署名；修改版对外分发时不得沿用「宝螺」名称与图标。
 */
/**
 * 剧本：把「一句话 → 任务卡」这一步定死。
 *
 * 这三条流程是固定的（下载+文案、对话视频、变声），所以直接硬编码，
 * 执行时完全不经过模型——省 token 的大头就在这里，不是靠提示词优化。
 */
import type {
  AgentCreateResult,
  AgentParam,
  AgentParamOption,
  AgentParseResult,
  AgentStep,
  AgentTask,
} from "../../shared/agent-types";
import type { HotItem } from "../../shared/storyboard-types";
import type { TemplateConfig } from "../../shared/dialogue-types";
import * as settings from "../dialogue/settings";
import { builtinTemplateConfig } from "../dialogue/builtin-template";
import { getRecord } from "../records/store";
import { newTaskId, saveTask, taskWorkDir } from "./store";
import { parseInstruction, parseInstructionSmart } from "./router";
import { voiceOptions } from "./voice-options";

function textParam(key: string, label: string, value: string, placeholder?: string): AgentParam {
  return { key, label, value, type: "text", placeholder };
}

/** 画面比例是整条视频的设定，不是某一步的细节，所以放在卡片第一步让人先定下来 */
function resolutionParam(value = "portrait"): AgentParam {
  return {
    key: "resolution",
    label: "画面比例",
    value,
    type: "select",
    options: [
      { value: "portrait", label: "竖版 9:16" },
      { value: "landscape", label: "横版 16:9" },
    ],
  };
}

/** 把画面比例挂到第一步上（用户话里说了就按他说的，没说默认竖版） */
function withResolution(step: AgentStep, resolution?: "portrait" | "landscape"): AgentStep {
  return { ...step, params: [...(step.params ?? []), resolutionParam(resolution ?? "portrait")] };
}

function writeScriptStep(id: string, topic: string, durationSec?: number): AgentStep {
  return {
    id,
    kind: "write-script",
    title: "写对话脚本",
    status: "pending",
    params: [
      {
        key: "topic",
        label: "主题",
        value: topic,
        type: "textarea",
        placeholder: "例如：事业运 / 感情婚姻 / 低谷期（想写长一点也可以，直接换行）",
        // 主题自己占一行，目标时长跟在下一行
        ownLine: true,
      },
      { key: "duration", label: "目标时长(秒)", value: String(durationSec ?? 45), type: "number" },
    ],
  };
}

function composeStep(id: string): AgentStep {
  /*
   * 「合成视频」现在只管合成，参数一个不摆——角色/画面的配置挪到了前一步
   * （dialogueConfigStep）。拆开的理由：它原来顶着「合成视频」的名字，实际是配置面板，
   * 而且排在「写对话脚本」前面（先配角色再写台词），编号和名字都跟实际不符。
   * 现在按 写对话脚本 → 角色与画面 → 合成视频 排，跟热点成片的 ①②③ 一致。
   */
  return {
    id,
    kind: "compose",
    title: "合成视频",
    status: "pending",
    /*
     * 这一步点「执行」才会跑；卡上再摆一个「跑这步」是重复的，所以标成不可单跑。
     * 想重做：改前面的主题/角色参数（会自动打回未开始），再点「执行」。
     */
    rerunnable: false,
    params: [],
  };
}

/**
 * 对话视频的「角色与画面」：甲方/乙方形象图、音色、语速语调音量、运镜，外加整条片子的画面比例。
 * 只配置、不干活——工具是空操作（见 tools.ts 的 dialogueConfigTool）。
 *
 * 默认模板：用户设了默认模板就用它，没设就用内置模板（应用自带，含两张形象图）。
 * 用户在卡上照样能改——模板只是把起点摆好。
 */
function dialogueConfigStep(id: string): AgentStep {
  const dw = settings.getSettings();
  const tpl = defaultTemplateConfig();
  // 模板里的音色/运镜优先；模板没给的字段（老模板可能缺项）回退到设置默认值
  const voiceA = tpl.voices?.voiceFortune || dw.voiceFortune;
  const voiceB = tpl.voices?.voiceCustomer || dw.voiceCustomer;
  const prosodyA = tpl.voices?.prosody?.a ?? dw.prosody.a;
  const prosodyB = tpl.voices?.prosody?.b ?? dw.prosody.b;
  const motionA = tpl.motionRoleA ?? { mode: "zoom-in" as const, amount: 25 };
  const motionB = tpl.motionRoleB ?? { mode: "zoom-in" as const, amount: 25 };
  /* 形象图：内置模板带图（零输入就能一键跑通）；用户模板没存图就留空，由用户自己选 */
  const imgA = tpl.imageFortune ?? "";
  const imgB = tpl.imageCustomer ?? "";
  /** 两个角色各一套：语速 / 语调 / 音量（默认取设置里保存的那套） */
  const prosody = (slot: "A" | "B", p: { rate: number; pitch: number; volume: number }) => [
    { key: `rate${slot}`, label: "语速", value: String(p.rate), type: "number" as const },
    { key: `pitch${slot}`, label: "语调", value: String(p.pitch), type: "number" as const },
    { key: `volume${slot}`, label: "音量", value: String(p.volume), type: "number" as const },
  ];
  /** 运镜：跟「对话模式」页同一套档位（幅度 10~40%），默认推近 25% */
  const motion = (slot: "A" | "B", cfg: { mode: string; amount: number }) => [
    {
      key: `motionMode${slot}`,
      label: "运镜",
      value: cfg.mode,
      type: "select" as const,
      options: [
        { value: "none", label: "无（静止）" },
        { value: "zoom-in", label: "推近" },
        { value: "zoom-out", label: "拉远" },
        { value: "pan-left", label: "左移" },
        { value: "pan-right", label: "右移" },
      ],
    },
    { key: `motionAmount${slot}`, label: "幅度", value: String(cfg.amount), type: "number" as const },
  ];
  return {
    id,
    kind: "dialogue-config",
    title: "角色与画面",
    status: "pending",
    rerunnable: false,
    params: [
      { key: "imageFortune", label: "甲方图", value: imgA, type: "image" },
      { key: "imageCustomer", label: "乙方图", value: imgB, type: "image" },
      { key: "voiceFortune", label: "甲方音色", value: voiceA, type: "select", options: voiceOptions() },
      { key: "voiceCustomer", label: "乙方音色", value: voiceB, type: "select", options: voiceOptions() },
      ...prosody("A", prosodyA),
      ...prosody("B", prosodyB),
      ...motion("A", motionA),
      ...motion("B", motionB),
      /*
       * 这里**不摆**「画面比例」：它是整条片子的设定，已经挂在卡片第一步
       * （withResolution），两处都摆会让用户看到两个同名下拉、还互相打架（踩过）。
       */
    ],
  };
}

/**
 * 读「默认模板」的配置：用户设了默认就用它，没设就用内置模板（应用自带、开箱即用）。
 * 用户设的那份被删了/读不到 → 退回内置模板，不报错（工作台建卡永远有个可用起点）。
 */
function defaultTemplateConfig(): TemplateConfig {
  const id = settings.getAppSettings().defaultTemplateId;
  if (id) {
    try {
      const rec = getRecord<TemplateConfig>("template", id);
      if (rec?.payload) return rec.payload;
    } catch {
      /* 读不到就走内置 */
    }
  }
  return builtinTemplateConfig();
}

/** 默认模板里的画面比例（没设/读不到就是竖版）——用户话里没说时用它 */
function templateResolution(): "portrait" | "landscape" {
  return defaultTemplateConfig().resolution === "landscape" ? "landscape" : "portrait";
}

/**
 * 热点成片 / 图文解说：任务卡里内嵌「热点成片」页同一个分镜工作台
 * （HotStoryWorkbench），选题、旁白/提示词的编辑、生图、合成都直接在工作台上操作——
 * 工作台只是换了个入口，不是再另做一套链路。
 * 主题存成参数只是为了把建卡时的话题带给工作台预填，界面上不渲染这行。
 */
function hotStoryStep(id: string, topic: string): AgentStep {
  return {
    id,
    kind: "hot-story",
    title: "热点成片",
    status: "pending",
    rerunnable: false,
    params: [textParam("topic", "主题", topic)],
  };
}

/** 解说员语速的预设档位：百分比偏移，跟「对话模式」页的语速滑杆同一套语义 */
const NARRATOR_RATES: AgentParamOption[] = [
  { value: "-30", label: "慢 (-30%)" },
  { value: "-15", label: "稍慢 (-15%)" },
  { value: "0", label: "正常" },
  { value: "15", label: "稍快 (+15%)" },
  { value: "30", label: "快 (+30%)" },
  { value: "50", label: "很快 (+50%)" },
];

/** 设置里保存的自定义语速不在档位里时，吸附到最近的一档，保证下拉能对上 */
function nearestRatePreset(rate: number): string {
  let best = NARRATOR_RATES[0];
  for (const o of NARRATOR_RATES) {
    if (Math.abs(Number(o.value) - rate) < Math.abs(Number(best.value) - rate)) best = o;
  }
  return best.value;
}

/** 图文解说 / 热点成片：AI 出分镜（旁白 + 每镜画面提示词） */
function writeStoryboardStep(id: string, topic: string): AgentStep {
  const dw = settings.getSettings();
  return {
    id,
    kind: "write-storyboard",
    title: "生成分镜",
    status: "pending",
    params: [
      {
        key: "topic",
        label: "主题 / 热点",
        value: topic,
        type: "textarea",
        placeholder: "例如：职场焦虑 / 低谷期 / 某个热点（想写长一点也可以，直接换行）",
        // 主题自己占一行，时长和画面跟在下一行
        ownLine: true,
      },
      { key: "duration", label: "目标时长(秒)", value: "60", type: "number", width: "wide" },
      {
        key: "resolution",
        label: "画面",
        value: "portrait",
        type: "select",
        width: "wide",
        options: [
          { value: "portrait", label: "竖版 9:16" },
          { value: "landscape", label: "横版 16:9" },
        ],
      },
      // 音色 + 语速一组挪到第二行：音色下拉放宽（长名不截），语速给几个档位选
      {
        key: "voiceNarrator",
        label: "解说员音色",
        value: dw.voiceNarrator,
        type: "select",
        options: voiceOptions(),
        breakBefore: true,
        width: "wide",
      },
      {
        key: "rateNarrator",
        label: "语速",
        value: nearestRatePreset(dw.prosody.narrator.rate),
        type: "select",
        options: NARRATOR_RATES,
        width: "wide",
      },
    ],
  };
}

/** 爆款拆解：一个本地音视频，一份方法论 */
function sniffStep(inputPath: string): AgentStep {
  return {
    id: "s1",
    kind: "sniff",
    title: "拆解这段爆款",
    status: "pending",
    params: [
      { key: "inputPath", label: "音视频文件", value: inputPath, type: "file" },
      textParam("niche", "你的赛道", "", "可留空，例如：情感 / 职场"),
    ],
  };
}

/**
 * 合成解说视频。
 * 选图参数这一步是先空着的：分镜出来以后由 write-storyboard 按镜头数补齐
 * （不知道有几个镜头，就不知道该让你选几张图）。
 * 音色不在这儿：整条片子的设定挂在第一步「生成分镜」上。
 */
function composeNarrationStep(id: string): AgentStep {
  return {
    id,
    kind: "compose-narration",
    title: "生图 + 合成",
    status: "pending",
    note: "先生成分镜；缺图会自动生图，图齐了直接合成",
    params: [],
  };
}

/** 语音合成：一段文字，一个音色，产出一条音频 */
function ttsStep(text: string): AgentStep {
  const dw = settings.getSettings();
  return {
    id: "s1",
    kind: "tts",
    title: "合成语音",
    status: "pending",
    params: [
      {
        key: "text",
        label: "要念的文本",
        value: text,
        type: "textarea",
        placeholder: "把要念的文字贴进来（可以换行，长文也行）",
        // 文本自己占一行，音色和语速跟在下一行
        ownLine: true,
      },
      { key: "voice", label: "音色", value: dw.voiceNarrator, type: "select", options: voiceOptions() },
      { key: "rate", label: "语速(%)", value: "0", type: "number" },
    ],
  };
}

/** 语音识别：手上已有的音视频 → 文案（本地跑，不联网） */
function transcribeAnyStep(inputPath: string): AgentStep {
  return {
    id: "s1",
    kind: "transcribe",
    title: "识别文案",
    status: "pending",
    params: [
      { key: "inputPath", label: "音视频文件", value: inputPath, type: "file" },
    ],
  };
}

function voiceConvertStep(inputPath: string): AgentStep {
  const dw = settings.getSettings();
  return {
    id: "s1",
    kind: "voice-convert",
    title: "换音色重念",
    status: "pending",
    params: [
      { key: "inputPath", label: "源文件", value: inputPath, type: "file" },
      { key: "voice", label: "目标音色", value: dw.voiceNarrator, type: "select", options: voiceOptions() },
      { key: "rate", label: "语速(%)", value: "0", type: "number" },
    ],
  };
}

/** 意图 + 参数 → 步骤列表 */
export function buildSteps(parse: AgentParseResult): AgentStep[] {
  const topic = parse.params.topic ?? "";
  /* 时长：用户话里说了就用（如「目标时长120s」），没说用步骤默认值 */
  const durationSec = Number(parse.params.duration) || undefined;
  /*
   * 画面比例的优先级：用户话里说的 > 默认模板的 > 竖版。
   * 只挂在卡片第一步（整条片子的设定），「角色与画面」里不再重复摆一个（踩过）。
   */
  const resolution =
    parse.params.resolution === "landscape" || parse.params.resolution === "portrait"
      ? (parse.params.resolution as "portrait" | "landscape")
      : undefined;
  const finalResolution = resolution ?? templateResolution();

  switch (parse.intent) {
    case "dialogue-video":
      // 顺序：先写台词，再配角色画面，最后合成（跟热点成片的 ①②③ 对齐）
      return [
        withResolution(writeScriptStep("s1", topic, durationSec), finalResolution),
        dialogueConfigStep("s2"),
        composeStep("s3"),
      ];

    case "narration-video":
      // 主题/热点 → 任务卡里内嵌分镜工作台（跟「热点成片」页同一套）
      return [hotStoryStep("s1", topic)];

    case "voice-convert":
      return [voiceConvertStep(parse.params.inputPath ?? "")];

    case "tts":
      return [ttsStep(parse.params.text ?? topic)];

    case "asr":
      return [transcribeAnyStep(parse.params.inputPath ?? "")];

    case "sniff":
      // 拆解 → 挑一个选题 → 按同一套方法出分镜方案 → 选图合成（跟手动「爆款拆解」一条链）
      return [
        sniffStep(parse.params.inputPath ?? ""),
        writeStoryboardStep("s2", ""),
        composeNarrationStep("s3"),
      ];

    default:
      return [];
  }
}

/** 拿一份分流结果落一张任务卡（同步/智能两条路共用） */
function taskFromParse(instruction: string, parse: AgentParseResult, hot?: HotItem | null): AgentCreateResult {
  if (parse.intent === "unknown") return { parse, task: null };

  const id = newTaskId();
  const now = Date.now();
  const task: AgentTask = {
    id,
    title: parse.title,
    instruction,
    intent: parse.intent,
    status: "draft",
    createdAt: now,
    updatedAt: now,
    workDir: taskWorkDir(id),
    steps: buildSteps(parse),
    ...(hot ? { hot } : {}),
  };
  return { parse, task: saveTask(task) };
}

/**
 * 一句话 → 任务卡（纯规则版）。
 * 认不出来只回话不建卡：task 为 null。测试脚本走这条，确定性不联网。
 */
export function createTask(instruction: string, hot?: HotItem | null): AgentCreateResult {
  return taskFromParse(instruction, parseInstruction(instruction), hot);
}

/**
 * 一句话 → 任务卡（规则 + AI 兜底版，界面走这条）：
 * 规则拿不准时问一次配置好的模型判意图；模型不可用自动退回规则结果。
 */
export async function createTaskSmart(instruction: string, hot?: HotItem | null): Promise<AgentCreateResult> {
  const parse = await parseInstructionSmart(instruction);
  return taskFromParse(instruction, parse, hot);
}
