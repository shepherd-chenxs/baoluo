/**
 * 任务列表面板（工作台左栏同款）：导航下方常驻。
 *
 * 为什么单独一个组件：工作台的左栏（任务列表）在切到设置/关于等页时会被
 * NavPage 的左栏替换掉，用户要求「左侧的任务列表区不要动」——所以抽出来
 * 一个自包含的列表，设置/关于等 NavPage 页面的左栏也挂同一份。
 *
 * 自包含状态：自己拉任务列表（agent.list + onProgress 订阅），不依赖工作台。
 * 点任务行 / ＋ 号都通过回调交出去（App 负责切回工作台并打开对应任务）；
 * 删除用同款确认框，删完自己刷新。
 */
import { useEffect, useState } from "react";
import type { AgentApi } from "../../preload";
import type { AgentTask } from "../../shared/agent-types";
import { useConfirm } from "./ConfirmDialog";
import { formatListTime, ListAddButton, SideRow } from "./SideList";

declare global {
  interface Window {
    agent: AgentApi;
  }
}

function statusText(t: AgentTask): string {
  switch (t.status) {
    case "running":
      return "执行中";
    case "done":
      return "已完成";
    case "failed":
      return "出错";
    case "cancelled":
      return "已取消";
    default:
      return "待执行";
  }
}

interface TaskListPanelProps {
  /** ＋ 号（新建任务）：语义交给调用方（通常是「切回工作台进对话形态」） */
  onAdd?: () => void;
  /** 点某条任务：调用方负责跳回工作台并打开它 */
  onOpenTask: (taskId: string) => void;
  /** 当前在工作台里打开的任务（用来高亮行；不知道就传 null，不高亮） */
  activeTaskId?: string | null;
}

export default function TaskListPanel({ onAdd, onOpenTask, activeTaskId }: TaskListPanelProps) {
  const [tasks, setTasks] = useState<AgentTask[]>([]);
  const [confirmDialog, confirmDelete] = useConfirm();

  useEffect(() => {
    let alive = true;
    const load = async () => {
      try {
        const list = await window.agent.list();
        if (alive) setTasks(list);
      } catch {
        /* 主进程没起好时列表拉不到就算了，不打扰设置页 */
      }
    };
    void load();
    const off = window.agent.onProgress((p) => {
      if (!p.task) return;
      setTasks((prev) => {
        const i = prev.findIndex((t) => t.id === p.taskId);
        if (i < 0) return prev;
        const next = prev.slice();
        next[i] = p.task!;
        return next;
      });
    });
    return () => {
      alive = false;
      off();
    };
  }, []);

  return (
    <>
      <div className="panel-title-row">
        <span className="panel-title">任务</span>
        <span className="ws-list-title-right">
          <span className="status">{tasks.length}</span>
          {onAdd && <ListAddButton onClick={onAdd} title="新建任务" />}
        </span>
      </div>
      {tasks.length === 0 ? (
        <p className="split-empty">还没有任务。点上面的 + 新建一个。</p>
      ) : (
        <div className="ws-list-items">
          {tasks.map((t) => (
            /* 行长相与工作台同款（SideRow = .side-row）：删除也走同款悬浮 ✕ */
            <SideRow
              key={t.id}
              title={t.title}
              active={t.id === activeTaskId}
              meta={<span>{statusText(t)}</span>}
              time={formatListTime(t.updatedAt)}
              onOpen={() => onOpenTask(t.id)}
              onDelete={async () => {
                if (
                  await confirmDelete({
                    title: `删除任务「${t.title}」？`,
                    detail: "删除后这条任务的产物目录不会一并删除，但任务卡找不回来了。",
                  })
                ) {
                  await window.agent.remove(t.id);
                  const list = await window.agent.list();
                  setTasks(list);
                }
              }}
              deleteLabel={`删除任务 ${t.title}`}
            />
          ))}
        </div>
      )}
      {confirmDialog}
    </>
  );
}
