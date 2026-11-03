/** 拆解爆款给出的候选选题：点一个就按同一套方法出分镜方案 */
import type { ReactNode } from "react";

export default function TopicChips({
  topics,
  disabled,
  onPick,
}: {
  topics: string[];
  disabled: boolean;
  onPick: (topic: string) => void;
}): ReactNode {
  if (!topics.length) return null;
  return (
    <div className="ws-topic-row">
      <span className="ws-param-label">挑一个选题，我按这套方法出分镜方案</span>
      <div className="sniff-topic-suggestions">
        {topics.map((t) => (
          <button
            type="button"
            key={t}
            className="sniff-topic-chip"
            disabled={disabled}
            onClick={() => onPick(t)}
          >
            {t}
          </button>
        ))}
      </div>
    </div>
  );
}
