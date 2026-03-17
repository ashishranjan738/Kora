import { useEffect, useRef } from "react";

export interface RestartAllDialogProps {
  agentCount: number;
  onCancel: () => void;
  onConfirm: () => void;
  restarting: boolean;
  result: { restarted: number } | null;
  error: string | null;
}

export function RestartAllDialog({
  agentCount,
  onCancel,
  onConfirm,
  restarting,
  result,
  error,
}: RestartAllDialogProps) {
  const cancelRef = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    if (!restarting && !result && !error && cancelRef.current) {
      cancelRef.current.focus();
    }
  }, [restarting, result, error]);

  // Auto-close on success after 2.5s
  useEffect(() => {
    if (result && !error) {
      const t = setTimeout(onCancel, 2500);
      return () => clearTimeout(t);
    }
  }, [result, error, onCancel]);

  // Success state
  if (result && !error) {
    return (
      <div className="dialog-overlay" onClick={(e) => e.stopPropagation()}>
        <div className="dialog stop-session-dialog" onClick={(e) => e.stopPropagation()}>
          <div className="stop-progress">
            <div className="stop-progress-check" style={{ color: "var(--accent-green)" }}>
              <svg width="48" height="48" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                <path d="M22 11.08V12a10 10 0 1 1-5.93-9.14" />
                <polyline points="22 4 12 14.01 9 11.01" />
              </svg>
            </div>
            <p style={{ fontSize: 16, fontWeight: 600, color: "var(--text-primary)" }}>
              Restarted {result.restarted} agent{result.restarted !== 1 ? "s" : ""} successfully
            </p>
            <p style={{ fontSize: 13, color: "var(--text-muted)" }}>
              Agents are initializing with fresh sessions...
            </p>
          </div>
        </div>
      </div>
    );
  }

  // Error state
  if (error) {
    return (
      <div className="dialog-overlay" onClick={onCancel}>
        <div className="dialog stop-session-dialog" onClick={(e) => e.stopPropagation()}>
          <div className="stop-progress">
            <div style={{ color: "var(--accent-red)", fontSize: 32 }}>
              <svg width="48" height="48" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                <circle cx="12" cy="12" r="10" />
                <line x1="15" y1="9" x2="9" y2="15" />
                <line x1="9" y1="9" x2="15" y2="15" />
              </svg>
            </div>
            <p style={{ fontSize: 16, fontWeight: 600, color: "var(--text-primary)" }}>
              Failed to restart agents
            </p>
            <p style={{ fontSize: 13, color: "var(--text-secondary)", maxWidth: 360 }}>
              {error}
            </p>
            <div className="form-actions" style={{ marginTop: 12 }}>
              <button onClick={onCancel}>Close</button>
            </div>
          </div>
        </div>
      </div>
    );
  }

  // Restarting / progress state
  if (restarting) {
    return (
      <div className="dialog-overlay" onClick={(e) => e.stopPropagation()}>
        <div className="dialog stop-session-dialog" onClick={(e) => e.stopPropagation()}>
          <div className="stop-progress">
            <div className="restart-progress-spinner" />
            <p style={{ fontSize: 16, fontWeight: 600, color: "var(--text-primary)" }}>
              Restarting {agentCount} agent{agentCount !== 1 ? "s" : ""}...
            </p>
            <p style={{ fontSize: 13, color: "var(--text-muted)", maxWidth: 360 }}>
              Killing old sessions and spawning fresh agents with the latest MCP and persona configuration.
            </p>
          </div>
        </div>
      </div>
    );
  }

  // Confirmation state
  return (
    <div className="dialog-overlay" onClick={onCancel}>
      <div className="dialog stop-session-dialog" onClick={(e) => e.stopPropagation()}>
        <h2 style={{ marginBottom: 4 }}>Restart All Agents</h2>
        <p style={{ fontSize: 13, color: "var(--text-muted)", marginBottom: 16 }}>
          {agentCount} agent{agentCount !== 1 ? "s" : ""} currently running
        </p>

        <div className="stop-dialog-warning" style={{ color: "var(--accent-yellow)" }}>
          <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" style={{ flexShrink: 0, marginTop: 1 }}>
            <path d="M10.29 3.86L1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z" />
            <line x1="12" y1="9" x2="12" y2="13" />
            <line x1="12" y1="17" x2="12.01" y2="17" />
          </svg>
          <span>This action will:</span>
        </div>

        <ul className="stop-dialog-list">
          <li>Kill all {agentCount} running agent{agentCount !== 1 ? "s" : ""} and their tmux sessions</li>
          <li>Spawn fresh sessions with the latest MCP and persona config</li>
          <li>Agents will lose their current conversation context</li>
        </ul>

        <p className="stop-dialog-preserve">
          Git worktrees and file changes made by agents will be preserved.
        </p>

        <div className="form-actions" style={{ marginTop: 20 }}>
          <button ref={cancelRef} onClick={onCancel}>
            Cancel
          </button>
          <button className="restart-dialog-confirm-btn" onClick={onConfirm}>
            Restart All Agents
          </button>
        </div>
      </div>
    </div>
  );
}
