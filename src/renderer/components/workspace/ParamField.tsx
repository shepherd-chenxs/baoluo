/** 一个参数一行：标签 + 控件（下拉 / 文本域 / 图缩略图 / 输入框） */
import type { ReactNode } from "react";
import type { AgentParam, AgentStep } from "../../../shared/agent-types";
import BeeSelect from "../BeeSelect";
import type { StepFieldApi } from "./fieldApi";

export default function ParamField({
  step,
  param: p,
  api,
}: {
  step: AgentStep;
  param: AgentParam;
  api: StepFieldApi;
}): ReactNode {
  const value = api.valueOf(step, p);
  const commit = (v: string) => api.commit(step, p, v);
  // 「一镜一行」：图参数各占一行，别几个镜头挤在同一排
  const isImage = p.type === "image";
  const ownLine = p.ownLine || isImage;
  /** 图参数左边摆图框，点它选图（跟人物卡一个交互） */
  const thumb = !isImage ? null : value && api.imageUrls[value] ? (
    <img
      className="ws-param-thumb"
      src={api.imageUrls[value]}
      alt={p.label}
      title={`${value}\n（点一下换图）`}
      onClick={() => api.pickFile(step, p)}
    />
  ) : (
    <span
      className="ws-param-thumb is-empty"
      title="点一下选图"
      onClick={() => api.pickFile(step, p)}
    />
  );

  return (
    <label
      className={`ws-param${ownLine ? " is-own-line" : ""}${p.width ? ` is-${p.width}` : ""}${
        p.type === "textarea" ? " is-textarea" : ""
      }`}
    >
      {thumb}
      <span className="ws-param-label">{p.label}</span>
      {p.type === "select" ? (
        // 和别处一样走自定义下拉：原生 select 的弹层是系统菜单，样式改不动
        <>
          <BeeSelect value={value} options={p.options ?? []} onChange={commit} title={p.label} />
          {/* 音色参数给个试听：按当前选的音色（和配套语速）念一句示例 */}
          {p.key.startsWith("voice") && api.preview && (
            <button
              type="button"
              className="link"
              disabled={api.previewing != null && api.previewing !== `param:${p.key}`}
              onClick={() => api.preview!(step, p)}
              title="试听这句"
            >
              {api.previewing === `param:${p.key}` ? "试听中…" : "试听"}
            </button>
          )}
        </>
      ) : p.type === "file" ? (
        <>
          <input value={value} readOnly placeholder="还没有选" title={value} />
          <button className="secondary" onClick={() => api.pickFile(step, p)}>
            选择
          </button>
        </>
      ) : p.type === "image" ? (
        // 图参数不放按钮也不放路径框：选没选都点左边的图框
        null
      ) : p.type === "textarea" ? (
        // 需要写一段话的参数（如「主题 / 热点」）用文本域，能换行
        <textarea
          value={value}
          rows={3}
          placeholder={p.placeholder}
          onChange={(e) => api.setLocal(step, p, e.target.value)}
          onBlur={(e) => commit(e.target.value)}
        />
      ) : (
        <input
          value={value}
          type={p.type === "number" ? "number" : "text"}
          placeholder={p.placeholder}
          onChange={(e) => api.setLocal(step, p, e.target.value)}
          onBlur={(e) => commit(e.target.value)}
        />
      )}
    </label>
  );
}
