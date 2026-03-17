import { useState } from "react";
import { useApi } from "../hooks/useApi";

interface ReplaceAgentDialogProps {
  sessionId: string;
  agentId: string;
  agentName: string;
  onClose: () => void;
  onReplaced: (newAgent: any) => void;
}

export function ReplaceAgentDialog({
  sessionId,
  agentId,
  agentName,
  onClose,
  onReplaced,
}: ReplaceAgentDialogProps) {
  const api = useApi();

  const [contextLines, setContextLines] = useState(50);
  const [extraContext, setExtraContext] = useState("");
  const [replacing, setReplacing] = useState(false);
  const [error, setError] = useState("");

  async function handleReplaceWithContext() {
    setError("");
    setReplacing(true);
    try {
      const result = await api.replaceAgent(sessionId, agentId, {
        contextLines,
        extraContext: extraContext.trim() || undefined,
        freshStart: false,
      });
      onReplaced(result);
      onClose();
    } catch (err: any) {
      setError(err.message || "Failed to replace agent");
    } finally {
      setReplacing(false);
    }
  }

  async function handleFreshRestart() {
    setError("");
    setReplacing(true);
    try {
      const result = await api.replaceAgent(sessionId, agentId, {
        freshStart: true,
      });
      onReplaced(result);
      onClose();
    } catch (err: any) {
      setError(err.message || "Failed to replace agent");
    } finally {
      setReplacing(false);
    }
  }

  return (
    <div className="dialog-overlay" onClick={onClose}>
      <div
        className="dialog"
        style={{ maxWidth: 680, minWidth: 480 }}
        onClick={(e) => e.stopPropagation()}
      >
        <h2>Replace Agent: {agentName}</h2>

        <p
          style={{
            color: "var(--text-secondary)",
            fontSize: 14,
            marginBottom: 16,
            lineHeight: 1.5,
          }}
        >
          The current agent will be killed and a new one will be spawned with
          the same configuration.
        </p>

        {error && (
          <div
            style={{
              padding: "8px 12px",
              marginBottom: 12,
              borderRadius: 6,
              backgroundColor: "rgba(248, 81, 73, 0.1)",
              border: "1px solid var(--accent-red)",
              color: "var(--accent-red)",
              fontSize: 13,
            }}
          >
            {error}
          </div>
        )}

        {replacing ? (
          <div
            style={{
              display: "flex",
              flexDirection: "column",
              alignItems: "center",
              justifyContent: "center",
              padding: "40px 0",
              gap: 12,
            }}
          >
            <span
              className="spinner"
              style={{ width: 28, height: 28, borderWidth: 3 }}
            />
            <span style={{ color: "var(--text-secondary)", fontSize: 14 }}>
              Replacing agent...
            </span>
          </div>
        ) : (
          <div style={{ display: "flex", gap: 12 }}>
            {/* Card 1: Replace with Context */}
            <div
              style={{
                flex: 1,
                border: "1px solid var(--border-color)",
                borderRadius: 8,
                padding: 16,
                display: "flex",
                flexDirection: "column",
                gap: 12,
                backgroundColor: "var(--bg-secondary)",
              }}
            >
              <div style={{ fontSize: 20 }}>[refresh]</div>
              <h3 style={{ fontSize: 15, fontWeight: 600, margin: 0 }}>
                Replace with Context
              </h3>
              <p
                style={{
                  fontSize: 12,
                  color: "var(--text-secondary)",
                  lineHeight: 1.5,
                  margin: 0,
                }}
              >
                Captures the last {contextLines} lines of terminal output and
                passes them to the new agent as recovery context. Best when the
                agent was making progress but went off track.
              </p>

              {/* Context lines slider */}
              <div>
                <label
                  style={{
                    fontSize: 12,
                    color: "var(--text-muted)",
                    display: "block",
                    marginBottom: 4,
                  }}
                >
                  Context lines: {contextLines}
                </label>
                <input
                  type="range"
                  min={10}
                  max={200}
                  step={10}
                  value={contextLines}
                  onChange={(e) => setContextLines(Number(e.target.value))}
                  style={{ width: "100%" }}
                />
              </div>

              {/* Extra instructions */}
              <div>
                <label
                  style={{
                    fontSize: 12,
                    color: "var(--text-muted)",
                    display: "block",
                    marginBottom: 4,
                  }}
                >
                  Additional instructions (optional)
                </label>
                <textarea
                  value={extraContext}
                  onChange={(e) => setExtraContext(e.target.value)}
                  placeholder="e.g. Focus on the header, not the footer"
                  rows={3}
                  style={{
                    width: "100%",
                    fontFamily: "inherit",
                    fontSize: 13,
                    padding: "6px 10px",
                    border: "1px solid var(--border-color)",
                    borderRadius: 6,
                    backgroundColor: "var(--bg-tertiary)",
                    color: "var(--text-primary)",
                    outline: "none",
                    resize: "vertical",
                  }}
                />
              </div>

              <button
                className="primary"
                onClick={handleReplaceWithContext}
                style={{
                  width: "100%",
                  fontSize: 13,
                  marginTop: "auto",
                  backgroundColor: "var(--accent-blue)",
                  borderColor: "var(--accent-blue)",
                }}
              >
                Replace with Context
              </button>
            </div>

            {/* Card 2: Fresh Restart */}
            <div
              style={{
                flex: 1,
                border: "1px solid var(--border-color)",
                borderRadius: 8,
                padding: 16,
                display: "flex",
                flexDirection: "column",
                gap: 12,
                backgroundColor: "var(--bg-secondary)",
              }}
            >
              <div style={{ fontSize: 20 }}>[new]</div>
              <h3 style={{ fontSize: 15, fontWeight: 600, margin: 0 }}>
                Fresh Restart
              </h3>
              <p
                style={{
                  fontSize: 12,
                  color: "var(--text-secondary)",
                  lineHeight: 1.5,
                  margin: 0,
                }}
              >
                Starts a completely clean agent with no memory of the previous
                one. Best when the agent was completely wrong and you want to
                start over.
              </p>

              <div style={{ flex: 1 }} />

              <button
                onClick={handleFreshRestart}
                style={{
                  width: "100%",
                  fontSize: 13,
                  marginTop: "auto",
                  backgroundColor: "transparent",
                  color: "var(--accent-green)",
                  borderColor: "var(--accent-green)",
                  cursor: "pointer",
                }}
              >
                Fresh Restart
              </button>
            </div>
          </div>
        )}

        {!replacing && (
          <div
            style={{
              display: "flex",
              justifyContent: "flex-end",
              marginTop: 16,
            }}
          >
            <button onClick={onClose}>Cancel</button>
          </div>
        )}
      </div>
    </div>
  );
}
