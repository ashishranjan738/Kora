import React, { useEffect, useRef } from "react";

export interface StopSessionDialogProps {
  session: {
    id: string;
    name: string;
    agentCount?: number;
    activeAgentCount?: number;
  };
  onCancel: () => void;
  onConfirm: () => void;
  stopping: boolean;
  success: boolean;
}

export function StopSessionDialog({
  session,
  onCancel,
  onConfirm,
  stopping,
  success,
}: StopSessionDialogProps) {
  const cancelRef = useRef<HTMLButtonElement>(null);

  // Auto-focus cancel button on mount
  useEffect(() => {
    if (!stopping && !success && cancelRef.current) {
      cancelRef.current.focus();
    }
  }, [stopping, success]);

  const agentCount =
    typeof session.activeAgentCount === "number"
      ? session.activeAgentCount
      : session.agentCount ?? 0;

  const sessionName = session.name || "Unnamed Session";

  // Success state
  if (success) {
    return (
      <div className="dialog-overlay" onClick={(e) => e.stopPropagation()}>
        <div
          className="dialog stop-session-dialog"
          onClick={(e) => e.stopPropagation()}
        >
          <div className="stop-progress">
            <div className="stop-progress-check">
              <svg
                width="48"
                height="48"
                viewBox="0 0 24 24"
                fill="none"
                stroke="currentColor"
                strokeWidth="2"
                strokeLinecap="round"
                strokeLinejoin="round"
              >
                <path d="M22 11.08V12a10 10 0 11-5.93-9.14" />
                <polyline points="22 4 12 14.01 9 11.01" />
              </svg>
            </div>
            <p style={{ fontSize: 16, fontWeight: 600 }}>
              Session stopped successfully
            </p>
            <p style={{ fontSize: 13, color: "var(--text-muted)" }}>
              Redirecting...
            </p>
          </div>
        </div>
      </div>
    );
  }

  // Stopping / progress state
  if (stopping) {
    return (
      <div className="dialog-overlay" onClick={(e) => e.stopPropagation()}>
        <div
          className="dialog stop-session-dialog"
          onClick={(e) => e.stopPropagation()}
        >
          <div className="stop-progress">
            <div className="stop-progress-spinner" />
            <p style={{ fontSize: 16, fontWeight: 600 }}>
              Stopping session &ldquo;{sessionName}&rdquo;...
            </p>
            <p style={{ fontSize: 13, color: "var(--text-muted)" }}>
              Killing {agentCount} agent{agentCount !== 1 ? "s" : ""} and
              cleaning up...
            </p>
          </div>
        </div>
      </div>
    );
  }

  // Confirmation state
  return (
    <div className="dialog-overlay" onClick={onCancel}>
      <div
        className="dialog stop-session-dialog"
        onClick={(e) => e.stopPropagation()}
      >
        <h2>Stop Session: &ldquo;{sessionName}&rdquo;</h2>

        <div className="stop-dialog-warning">
          <span style={{ fontSize: 18, lineHeight: 1 }}>&#9888;</span>
          <span>This will:</span>
        </div>

        <ul className="stop-dialog-list">
          <li>
            Kill{" "}
            {agentCount > 0
              ? `all ${agentCount} running agent${agentCount !== 1 ? "s" : ""}`
              : "all running agents"}
          </li>
          <li>Terminate their tmux sessions</li>
          <li>Remove the session from the registry</li>
        </ul>

        <p className="stop-dialog-preserve">
          Agent data and event history will be preserved in the project
          directory.
        </p>

        <div className="form-actions" style={{ marginTop: 20 }}>
          <button ref={cancelRef} onClick={onCancel}>
            Cancel
          </button>
          <button className="danger stop-dialog-confirm-btn" onClick={onConfirm}>
            Stop Session
          </button>
        </div>
      </div>
    </div>
  );
}
