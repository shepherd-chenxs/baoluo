/** 带黄色感叹号的提示弹窗（替代原生 alert） */
export default function AlertModal(props: { message: string; onClose: () => void }) {
  return (
    <div className="modal-overlay" onClick={props.onClose}>
      <div className="modal-card" onClick={(e) => e.stopPropagation()}>
        <div className="modal-icon warning">
          <svg
            viewBox="0 0 24 24"
            width="36"
            height="36"
            fill="none"
            stroke="#ff9500"
            strokeWidth="2"
            strokeLinecap="round"
            strokeLinejoin="round"
            aria-hidden
          >
            <path d="M12 3 2.6 19.5h18.8L12 3z" fill="rgba(255,149,0,0.12)" />
            <path d="M12 9.5v4.5" />
            <path d="M12 17.2h.01" />
          </svg>
        </div>
        <div className="modal-message">{props.message}</div>
        <div className="modal-actions">
          <button className="primary" onClick={props.onClose}>
            知道了
          </button>
        </div>
      </div>
    </div>
  );
}
