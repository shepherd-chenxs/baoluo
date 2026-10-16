/*
 * SPDX-License-Identifier: GPL-3.0-only
 * Copyright (c) 2026 宝螺 / Baoluo contributors
 * 本文件属于「宝螺 / Baoluo」。除 GPL-3.0 外还适用 ADDITIONAL_TERMS.md 里的附加条款：
 * 分发时须保留来源署名；修改版对外分发时不得沿用「宝螺」名称与图标。
 */
/**
 * 「视频生成 → 热点成片」页。
 *
 * 左边是方案列表、右边是分镜工作台。为什么要有这个列表：
 * 工作台那边（图文解说任务卡）一句话就能自动出片，但出完就没地方回头看它了——
 * 想改一句旁白、换一张图，只能从头再来。列表把两边接上：
 * 自动生成的方案在这里能翻出来细改，工作台那边就可以安心定位成「全自动」。
 *
 * 打开方案走工作台的命令式句柄，不用换 key 重挂组件——重挂会把正在跑的 AI 成片打断。
 */
import { useCallback, useEffect, useRef, useState } from "react";
import type { ReactNode } from "react";
import type { StoryboardApi } from "../../preload";
import type { StoryboardSummary } from "../../shared/storyboard-types";
import { usePageActive } from "../components/KeepAlive";
import { useConfirm } from "../components/ConfirmDialog";
import SideList, { SideRow, formatListTime } from "../components/SideList";
import HotStoryWorkbench, {
  type HotStoryWorkbenchHandle,
} from "../components/hot-story/HotStoryWorkbench";

declare global {
  interface Window {
    storyboard: StoryboardApi;
  }
}

interface HotStoryViewProps {
  /** 左栏顶部的导航块（App 传下来的 SideNav） */
  nav?: ReactNode;
  /** 从工作台「去细改」带过来的方案：切到本页后自动打开它 */
  openBoardId?: string | null;
  /** 已经打开过了，宿主可以清掉这个待办 */
  onOpenBoardConsumed?: () => void;
}

export default function HotStoryView({
  nav,
  openBoardId,
  onOpenBoardConsumed,
}: HotStoryViewProps = {}) {
  /** 页面被保活后隐藏的实例仍在运行：进度广播只让当前显示的那份消费 */
  const pageActive = usePageActive();
  /** 删除方案前先问一句（应用内确认框） */
  const [confirmDialog, confirmDelete] = useConfirm();

  const [boards, setBoards] = useState<StoryboardSummary[]>([]);
  /** 列表里高亮的那份（工作台开了/建了/删了方案都会同步过来） */
  const [activeId, setActiveId] = useState<string | null>(null);
  const workbenchRef = useRef<HotStoryWorkbenchHandle | null>(null);

  const reload = useCallback(async () => {
    try {
      setBoards(await window.storyboard.list());
    } catch {
      /* 列表拉不到不影响右边编辑 */
    }
  }, []);

  /*
   * 首次进来、以及每次切回本页都刷一次：
   * 用户可能刚在工作台那边自动生成了方案，切过来就得能在列表里看到它。
   * （页面是保活的，不再重挂，所以光靠 mount 那一次不够。）
   */
  useEffect(() => {
    if (!pageActive) return;
    void reload();
  }, [pageActive, reload]);

  /*
   * 工作台「去细改」带过来的方案：落到本页就把工作台切到那一份。
   * 走命令式句柄（同列表点击），不换 key 重挂——重挂会打断正在跑的 AI 成片。
   */
  useEffect(() => {
    if (!pageActive || !openBoardId) return;
    workbenchRef.current?.openBoard(openBoardId);
    onOpenBoardConsumed?.();
  }, [pageActive, openBoardId, onOpenBoardConsumed]);

  const onBoardIdChange = useCallback(
    (id: string | null) => {
      setActiveId(id);
      void reload();
    },
    [reload]
  );

  async function removeBoard(id: string, title: string) {
    if (
      !(await confirmDelete({
        title: `删除方案「${title}」？`,
        detail: "图片和分镜稿都会被删除，无法恢复。",
      }))
    )
      return;
    try {
      await window.storyboard.remove(id);
    } catch {
      /* 删不掉就让列表自己刷新出真相 */
    }
    await reload();
  }

  return (
    /* 整屏分左右两区（骨架与另外三页共用，见 SideList 组件） */
    <div className="view story-view">
      <SideList
        nav={nav}
        section="方案"
        action={
          <button
            type="button"
            className="secondary small"
            onClick={() => workbenchRef.current?.startFresh()}
            title="开一份新的（不动已有方案）"
          >
            ＋ 新建
          </button>
        }
        hasItems={boards.length > 0}
        empty={
          <>
            还没有方案。右边选一条热点（或填个主题）点「成片」，生成的方案会自动出现在这里。
          </>
        }
        items={boards.map((b) => (
          <SideRow
            key={b.id}
            title={b.title}
            active={b.id === activeId}
            meta={
              <span>
                {b.filledCount}/{b.shotCount} 图
              </span>
            }
            /* 渲染过成片的标一下：用户不用靠时间猜哪份是最终那版 */
            done={b.hasVideo}
            time={formatListTime(b.updatedAt)}
            onOpen={() => workbenchRef.current?.openBoard(b.id)}
            onDelete={() => void removeBoard(b.id, b.title)}
            deleteLabel={`删除方案 ${b.title}`}
          />
        ))}
      >
        {/* 页名放右区顶部（跟其他内容页一致）；左栏只留导航 + 方案列表 */}
        <h2 className="work-title">热点成片</h2>
        <HotStoryWorkbench
          active={pageActive}
          showLastDraft={false}
          flatPanels
          onBoardIdChange={onBoardIdChange}
          controlRef={workbenchRef}
        />
      </SideList>
      {confirmDialog}
    </div>
  );
}
