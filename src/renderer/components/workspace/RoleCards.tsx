/*
 * SPDX-License-Identifier: GPL-3.0-only
 * Copyright (c) 2026 宝螺 / Baoluo contributors
 * 本文件属于「宝螺 / Baoluo」。除 GPL-3.0 外还适用 ADDITIONAL_TERMS.md 里的附加条款：
 * 分发时须保留来源署名；修改版对外分发时不得沿用「宝螺」名称与图标。
 */
/**
 * 「合成视频」那一步的两个人物卡：左边图片，右边音色 + 音量 + 运镜。
 *
 * 这几根滑杆是**参数**（会存进任务卡），不是纯界面——重开还在，合成时按它跑。
 */
import type { ReactNode } from "react";
import type { AgentStep } from "../../../shared/agent-types";
import AppSelect from "../AppSelect";
import { SpeakerIcon } from "../VoiceIcons";
import ParamField from "./ParamField";
import type { StepFieldApi } from "./fieldApi";

/** 两个角色：左图右音，参数键就是卡片上那几根滑杆 */
const ROLE_CARDS = [
  { slot: "A", name: "甲方", imageKey: "imageFortune", voiceKey: "voiceFortune" },
  { slot: "B", name: "乙方", imageKey: "imageCustomer", voiceKey: "voiceCustomer" },
] as const;

/**
 * 角色卡上还摆着的音色滑杆：只留音量，范围跟「对话模式」页那根一致。
 *
 * 语速、语调两根撤掉了（工作台这张卡上不再让人调）。
 * 注意参数本身没删——`rateA/pitchA` 仍在步骤定义里，值取设置里的默认，
 * 合成与试听都还按它跑，所以撤掉的只是"能改"这件事，不是这个输入。
 */
const ROLE_PROSODY = [{ key: "volume", label: "音量", min: -100, max: 0 }] as const;

/**
 * 卡片上不摆、但要**认领掉**的音色参数。
 * 不认领的话它们会掉进下面那排通用参数行（见文件末尾的 rest）——等于没撤掉，只是换了个位置。
 */
const ROLE_PROSODY_HIDDEN = ["rate", "pitch"] as const;

/** 运镜档位：跟「对话模式」页一致（幅度 10~40%） */
const ROLE_MOTION = [
  { value: "none", label: "无（静止）" },
  { value: "zoom-in", label: "推近" },
  { value: "zoom-out", label: "拉远" },
  { value: "pan-left", label: "左移" },
  { value: "pan-right", label: "右移" },
] as const;

/** 一根滑杆：拖动只改本地，松手/失焦才提交（一路拖不会发几十次 IPC） */
function SliderRow({
  label,
  value,
  min,
  max,
  step = 5,
  suffix = "%",
  onChange,
  onCommit,
}: {
  label: string;
  value: number;
  min: number;
  max: number;
  step?: number;
  suffix?: string;
  onChange: (v: string) => void;
  onCommit: (v: string) => void;
}): ReactNode {
  return (
    <div className="ws-role-row">
      <span className="ws-role-label">{label}</span>
      <input
        type="range"
        min={min}
        max={max}
        step={step}
        value={value}
        onChange={(e) => onChange(e.target.value)}
        onPointerUp={(e) => onCommit((e.target as HTMLInputElement).value)}
        onBlur={(e) => onCommit(e.target.value)}
      />
      <span className="ws-role-value">
        {value > 0 && suffix === "%" ? `+${value}${suffix}` : `${value}${suffix}`}
      </span>
    </div>
  );
}

export default function RoleCards({
  step,
  api,
  previewing,
  onPreview,
}: {
  step: AgentStep;
  api: StepFieldApi;
  /** 正在试听哪个角色（A/B），null = 没在放 */
  previewing: string | null;
  onPreview: (slot: string, voice: string) => void;
}): ReactNode {
  const handled = new Set<string>();

  const cards = ROLE_CARDS.map((r) => {
    const img = step.params?.find((p) => p.key === r.imageKey);
    const voice = step.params?.find((p) => p.key === r.voiceKey);
    if (img) handled.add(img.key);
    if (voice) handled.add(voice.key);
    const image = img ? api.valueOf(step, img) : "";
    const voiceValue = voice ? api.valueOf(step, voice) : "";
    const thumb = image ? api.imageUrls[image] : "";

    // 撤掉的语速/语调参数也要认领，否则会落到下面的通用参数行里
    for (const k of ROLE_PROSODY_HIDDEN) {
      const p = step.params?.find((x) => x.key === `${k}${r.slot}`);
      if (p) handled.add(p.key);
    }

    return (
      <div className="ws-role" key={r.slot}>
        <div className="ws-role-pic">
          {thumb ? (
            <img
              className="ws-role-img"
              src={thumb}
              alt={r.name}
              title={`${image}\n（点一下换图）`}
              onClick={() => img && api.pickFile(step, img)}
            />
          ) : (
            <button
              className="ws-role-img is-empty"
              type="button"
              onClick={() => img && api.pickFile(step, img)}
            >
              ＋<br />
              选图
            </button>
          )}
          {/* 「清除图片」去掉了：图框只负责"点一下换图"。想清空用「选择模板 → 不用模板」 */}
        </div>

        <div className="ws-role-body">
          <div className="ws-role-name">{r.name}</div>
          {voice && (
            <div className="ws-role-row">
              <span className="ws-role-label">音色</span>
              <AppSelect
                value={voiceValue}
                options={voice.options ?? []}
                onChange={(v) => api.commit(step, voice, v)}
                title={`${r.name}音色`}
              />
              <button
                className={`speaker-btn${previewing === r.slot ? " active" : ""}`}
                type="button"
                disabled={!voiceValue || previewing !== null}
                title="试听这个音色（按当前的语速/语调/音量念一句）"
                onClick={() => onPreview(r.slot, voiceValue)}
              >
                {/* 一直显示喇叭，播放中只靠脉冲提示——不换沙漏 */}
                <span className="speaker-icon">
                  <SpeakerIcon />
                </span>
              </button>
            </div>
          )}

          {ROLE_PROSODY.map((f) => {
            const p = step.params?.find((x) => x.key === `${f.key}${r.slot}`);
            if (!p) return null;
            handled.add(p.key);
            return (
              <SliderRow
                key={p.key}
                label={f.label}
                value={Number(api.valueOf(step, p)) || 0}
                min={f.min}
                max={f.max}
                onChange={(v) => api.setLocal(step, p, v)}
                onCommit={(v) => api.commit(step, p, v)}
              />
            );
          })}

          {(() => {
            const mode = step.params?.find((p) => p.key === `motionMode${r.slot}`);
            const amount = step.params?.find((p) => p.key === `motionAmount${r.slot}`);
            if (mode) handled.add(mode.key);
            if (amount) handled.add(amount.key);
            if (!mode || !amount) return null;
            return (
              <>
                <div className="ws-role-row">
                  <span className="ws-role-label">运镜</span>
                  <AppSelect
                    value={api.valueOf(step, mode)}
                    options={[...ROLE_MOTION]}
                    onChange={(v) => api.commit(step, mode, v)}
                    title={`${r.name}运镜`}
                  />
                </div>
                <SliderRow
                  label="幅度"
                  value={Number(api.valueOf(step, amount)) || 0}
                  min={10}
                  max={40}
                  onChange={(v) => api.setLocal(step, amount, v)}
                  onCommit={(v) => api.commit(step, amount, v)}
                />
              </>
            );
          })()}
        </div>
      </div>
    );
  });

  // 卡片没覆盖到的参数（以后再加的）照旧按参数行排在下面
  const rest = (step.params ?? []).filter((p) => !handled.has(p.key));
  return (
    <div className="ws-roles">
      {cards}
      {rest.length > 0 && (
        <div className="ws-params">
          {rest.map((p) => (
            <ParamField key={p.key} step={step} param={p} api={api} />
          ))}
        </div>
      )}
    </div>
  );
}
