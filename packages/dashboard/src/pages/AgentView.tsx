import { useEffect, useState, useRef, useCallback } from "react";
import { useParams, Link, useNavigate } from "react-router-dom";
import { useApi } from "../hooks/useApi";
import { AgentTerminal } from "../components/AgentTerminal";
import { ReplaceAgentDialog } from "../components/ReplaceAgentDialog";
import { useMediaQuery } from "@mantine/hooks";
import { formatUptime, formatTokens } from "../utils/formatters";
import { useApprovalRequests } from "../hooks/useApprovalRequests";
import { ApprovalHistory } from "../components/ApprovalHistory";

const AUTONOMY_LABELS = ["Manual", "Suggest", "Auto-confirm", "Full Auto"];

type InfoTab = "details" | "cost" | "actions" | "approvals";

export function AgentView() {
  const { sessionId, agentId } = useParams<{
    sessionId: string;
    agentId: string;
  }>();
  const navigate = useNavigate();
  const api = useApi();
  const isMobile = useMediaQuery("(max-width: 48em)");
  const { getHistoryForAgent } = useApprovalRequests(sessionId);
  const [agent, setAgent] = useState<any>(null);
  const [session, setSession] = useState<any>(null);
  const [message, setMessage] = useState("");
  const [sending, setSending] = useState(false);
  const [sentMessages, setSentMessages] = useState<{ text: string; time: number }[]>([]);
  const [showConfirmRemove, setShowConfirmRemove] = useState(false);
  const [showReplaceDialog, setShowReplaceDialog] = useState(false);
  const [showInfo, setShowInfo] = useState(false);
  const [infoTab, setInfoTab] = useState<InfoTab>("details");
  const [showModelDropdown, setShowModelDropdown] = useState(false);
  const [models, setModels] = useState<any[]>([]);
  const [uptime, setUptime] = useState("--");
  const [toast, setToast] = useState<string | null>(null);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const terminalRef = useRef<HTMLDivElement>(null);

  // Load agent and session
  const loadAgent = useCallback(async () => {
    if (!sessionId || !agentId) return;
    try {
      const [agentsRes, sessionRes] = await Promise.all([
        api.getAgents(sessionId),
        api.getSession(sessionId),
      ]);
      const found = (agentsRes.agents || []).find((a: any) => a.id === agentId);
      if (found) setAgent(found);
      if (sessionRes) setSession(sessionRes);
    } catch (err) {
      console.error("Failed to load agent:", err);
    }
  }, [sessionId, agentId]);

  useEffect(() => {
    loadAgent();
  }, [loadAgent]);

  // Poll agent data every 5s
  useEffect(() => {
    const interval = setInterval(loadAgent, 5000);
    return () => clearInterval(interval);
  }, [loadAgent]);

  // Update uptime every second
  useEffect(() => {
    if (!agent?.startedAt) return;
    const tick = () => setUptime(formatUptime(agent.startedAt));
    tick();
    const interval = setInterval(tick, 1000);
    return () => clearInterval(interval);
  }, [agent?.startedAt]);

  // Keyboard shortcuts
  useEffect(() => {
    function handleGlobalKey(e: KeyboardEvent) {
      if (e.key === "Escape") {
        // Focus terminal area
        terminalRef.current?.focus();
        textareaRef.current?.blur();
      }
      if ((e.ctrlKey || e.metaKey) && e.key === "i") {
        e.preventDefault();
        setShowInfo((prev) => !prev);
      }
    }
    window.addEventListener("keydown", handleGlobalKey);
    return () => window.removeEventListener("keydown", handleGlobalKey);
  }, []);

  function showToast(msg: string) {
    setToast(msg);
    setTimeout(() => setToast(null), 3000);
  }

  async function handleSend() {
    if (!message.trim() || sending) return;
    setSending(true);
    try {
      await api.sendMessage(sessionId!, agentId!, message);
      setSentMessages((prev) => [
        ...prev.slice(-2),
        { text: message.trim(), time: Date.now() },
      ]);
      setMessage("");
      if (textareaRef.current) textareaRef.current.style.height = "auto";
    } catch (err: any) {
      showToast(`Failed to send: ${err.message}`);
    } finally {
      setSending(false);
    }
  }

  function handleKeyDown(e: React.KeyboardEvent) {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      handleSend();
    }
  }

  function handleTextareaInput(e: React.ChangeEvent<HTMLTextAreaElement>) {
    setMessage(e.target.value);
    const el = e.target;
    el.style.height = "auto";
    el.style.height = Math.min(el.scrollHeight, 100) + "px";
  }

  async function handlePauseResume() {
    if (!agent) return;
    const action = agent.status === "paused" ? "resume" : "pause";
    try {
      await api.pauseResumeAgent(sessionId!, agentId!, action);
      showToast(`Agent ${action}d`);
      await loadAgent();
    } catch (err: any) {
      showToast(`Failed to ${action}: ${err.message}`);
    }
  }

  async function handleRemove() {
    try {
      await api.removeAgent(sessionId!, agentId!);
      showToast("Agent removed");
      window.location.href = `/session/${sessionId}`;
    } catch (err: any) {
      showToast(`Failed to remove: ${err.message}`);
      setShowConfirmRemove(false);
    }
  }

  async function handleChangeModel(model: string) {
    try {
      await api.changeModel(sessionId!, agentId!, model);
      showToast(`Model changed to ${model}`);
      setShowModelDropdown(false);
      await loadAgent();
    } catch (err: any) {
      showToast(`Failed to change model: ${err.message}`);
    }
  }

  async function handleOpenModels() {
    setShowModelDropdown((prev) => !prev);
    if (models.length === 0) {
      try {
        const res = await api.getProviders();
        const allModels: any[] = [];
        (res.providers || []).forEach((p: any) => {
          (p.models || []).forEach((m: any) => {
            allModels.push({ ...m, provider: p.name || p.id });
          });
        });
        setModels(allModels);
      } catch {
        setModels([]);
      }
    }
  }

  function getStatusClass(status: string): string {
    if (status === "running") return "running";
    if (status === "paused") return "paused";
    if (status === "idle") return "idle";
    if (status === "error" || status === "stopped" || status === "crashed") return "error";
    return "idle";
  }

  const agentName = agent?.name || agent?.config?.name || "Agent";
  const agentRole = agent?.role || agent?.config?.role || "worker";
  const agentProvider = agent?.provider || agent?.config?.cliProvider || "--";
  const agentModel = agent?.model || agent?.config?.model || "--";
  const agentStatus = agent?.status || "unknown";
  const tokensIn = agent?.tokensIn ?? agent?.cost?.totalTokensIn;
  const tokensOut = agent?.tokensOut ?? agent?.cost?.totalTokensOut;
  const totalCost = agent?.cost?.totalCostUsd ?? (typeof agent?.cost === "number" ? agent.cost : 0);
  const autonomyLevel = typeof agent?.autonomy === "number" ? agent.autonomy : 0;
  const spawnedBy = agent?.spawnedBy || "User";
  const workingDir = agent?.workingDir || agent?.cwd || "--";
  const tmuxSession = agent?.tmuxSession || agent?.tmux || "--";
  const crashes = agent?.crashes ?? agent?.healthCheck?.crashes ?? 0;
  const statusClass = getStatusClass(agentStatus);

  return (
    <div className="agent-view-page">
      {/* Breadcrumbs */}
      <nav className="av-breadcrumbs">
        <Link to="/">Sessions</Link>
        <span className="av-breadcrumb-sep">/</span>
        <Link to={`/session/${sessionId}`}>
          {session?.name || sessionId?.slice(0, 8) || "Session"}
        </Link>
        <span className="av-breadcrumb-sep">/</span>
        <span className="av-breadcrumb-current">{agentName}</span>
      </nav>

      {/* Agent Header Bar */}
      {isMobile ? (
        <div className="agent-header-bar" style={{ flexDirection: "column", gap: 6, alignItems: "stretch" }}>
          {/* Row 1: identity + activity + actions */}
          <div style={{ display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap" }}>
            <span className={`agent-header-dot ${statusClass}`} />
            <span className="agent-name-large" style={{ fontSize: 15 }}>{agentName}</span>
            <span className="badge-role-compact">{agentRole}</span>
            <span className="activity-status">{agentStatus}</span>
            <div style={{ flex: 1 }} />
            <div className="header-actions">
              <button
                title="Open in VS Code"
                onClick={async () => {
                  showToast("Opening VS Code...");
                  try { await api.openVscode(sessionId!, agentId!); } catch (err: any) { showToast(`Failed: ${err.message}`); }
                }}
              >&#128193;</button>
              <button title="Replace Agent" onClick={() => setShowReplaceDialog(true)}>&#8635;</button>
              <button
                title="Toggle Info Panel (Ctrl+I)"
                onClick={() => setShowInfo(!showInfo)}
                className={showInfo ? "active" : ""}
              >i</button>
              <button title="Remove Agent" className="danger" onClick={() => setShowConfirmRemove(true)}>&#10005;</button>
            </div>
          </div>
          {/* Row 2: provider/model + stats */}
          <div style={{ display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap", fontSize: 12 }}>
            <span className="provider-model" style={{ fontSize: 11 }}>{agentProvider} / {agentModel}</span>
            <span className="header-separator" />
            <span className="header-stat" title="Uptime">&#9201; {uptime}</span>
            <span className="header-stat" title="Tokens In">&#8595; {formatTokens(tokensIn)}</span>
            <span className="header-stat" title="Tokens Out">&#8593; {formatTokens(tokensOut)}</span>
            <span className="header-stat cost" title="Cost">${typeof totalCost === "number" ? totalCost.toFixed(2) : "0.00"}</span>
          </div>
        </div>
      ) : (
        <div className="agent-header-bar">
          <span className={`agent-header-dot ${statusClass}`} />
          <span className="agent-name-large">{agentName}</span>
          <span className="badge-role-compact">{agentRole}</span>
          <span className="provider-model">{agentProvider} / {agentModel}</span>
          <span className="header-separator" />
          <span className="activity-status">{agentStatus}</span>
          <div className="header-stats">
            <span className="header-stat" title="Uptime">&#9201; {uptime}</span>
            <span className="header-stat" title="Tokens In">&#8595; {formatTokens(tokensIn)}</span>
            <span className="header-stat" title="Tokens Out">&#8593; {formatTokens(tokensOut)}</span>
            <span className="header-stat cost" title="Cost">${typeof totalCost === "number" ? totalCost.toFixed(2) : "0.00"}</span>
          </div>
          <div className="header-actions">
            <button
              title="Open in VS Code"
              onClick={async () => {
                showToast("Opening VS Code...");
                try { await api.openVscode(sessionId!, agentId!); } catch (err: any) { showToast(`Failed: ${err.message}`); }
              }}
            >&#128193;</button>
            <button title="Replace Agent" onClick={() => setShowReplaceDialog(true)}>&#8635;</button>
            <button
              title="Toggle Info Panel (Ctrl+I)"
              onClick={() => setShowInfo(!showInfo)}
              className={showInfo ? "active" : ""}
            >
              i
            </button>
            <button title="Remove Agent" className="danger" onClick={() => setShowConfirmRemove(true)}>&#10005;</button>
          </div>
        </div>
      )}

      {/* Terminal Section */}
      <div className="terminal-section" ref={terminalRef} tabIndex={-1}>
        <AgentTerminal sessionId={sessionId!} agentId={agentId!} height="100%" />
      </div>

      {/* Chat Input Bar */}
      <div className="chat-input-bar">
        {sentMessages.length > 0 && (
          <div className="sent-messages">
            {sentMessages.map((m) => (
              <span key={m.time} className="sent-chip" title={m.text}>
                {m.text}
              </span>
            ))}
          </div>
        )}
        <div className="chat-input-row">
          <textarea
            ref={textareaRef}
            value={message}
            onChange={handleTextareaInput}
            onKeyDown={handleKeyDown}
            placeholder="Send message to agent... (Enter to send, Shift+Enter for newline)"
            disabled={sending}
            rows={1}
          />
          <span className="char-count">{message.length}</span>
          <button
            className="send-btn"
            onClick={handleSend}
            disabled={sending || !message.trim()}
          >
            {sending ? (
              <span className="spinner" style={{ width: 14, height: 14, borderWidth: 2 }} />
            ) : (
              "Send"
            )}
          </button>
        </div>
      </div>

      {/* Collapsible Info Panel Toggle */}
      <div
        className="info-panel-toggle"
        onClick={() => setShowInfo(!showInfo)}
        title="Toggle info panel (Ctrl+I)"
      >
        <span className={`info-panel-chevron ${showInfo ? "open" : ""}`}>&#9660;</span>
      </div>

      {/* Collapsible Info Panel */}
      {showInfo && (
        <div className="info-panel">
          <div className="info-panel-tabs">
            <div
              className={`info-panel-tab ${infoTab === "details" ? "active" : ""}`}
              onClick={() => setInfoTab("details")}
            >
              Agent Details
            </div>
            <div
              className={`info-panel-tab ${infoTab === "cost" ? "active" : ""}`}
              onClick={() => setInfoTab("cost")}
            >
              Cost &amp; Usage
            </div>
            <div
              className={`info-panel-tab ${infoTab === "actions" ? "active" : ""}`}
              onClick={() => setInfoTab("actions")}
            >
              Actions
            </div>
            <div
              className={`info-panel-tab ${infoTab === "approvals" ? "active" : ""}`}
              onClick={() => setInfoTab("approvals")}
            >
              Approvals
            </div>
          </div>

          <div className="info-panel-content">
            {/* Details Tab */}
            {infoTab === "details" && (
              <div className="info-grid">
                <div className="info-item">
                  <label>Provider</label>
                  <span className="info-value">{agentProvider}</span>
                </div>
                <div className="info-item">
                  <label>Model</label>
                  <span className="info-value mono">{agentModel}</span>
                </div>
                <div className="info-item">
                  <label>Role</label>
                  <span className="info-value">{agentRole}</span>
                </div>
                <div className="info-item">
                  <label>Autonomy</label>
                  <span className="info-value">
                    Level {autonomyLevel} &mdash; {AUTONOMY_LABELS[autonomyLevel] || "Unknown"}
                  </span>
                </div>
                <div className="info-item">
                  <label>Spawned By</label>
                  <span className="info-value">{spawnedBy}</span>
                </div>
                <div className="info-item">
                  <label>Health</label>
                  <span className="info-value">{crashes} crash{crashes !== 1 ? "es" : ""}</span>
                </div>
                <div className="info-item">
                  <label>Working Directory</label>
                  <span className="info-value mono">{workingDir}</span>
                </div>
                <div className="info-item">
                  <label>Tmux Session</label>
                  <span className="info-value mono">{tmuxSession}</span>
                </div>
              </div>
            )}

            {/* Cost & Usage Tab */}
            {infoTab === "cost" && (
              <div className="cost-tab-content">
                <div className="token-bars">
                  <div className="token-bar-row">
                    <span className="token-bar-label">Tokens In</span>
                    <div className="token-bar-track">
                      <div
                        className="token-bar-fill in"
                        style={{
                          width: `${Math.min(100, ((tokensIn || 0) / Math.max((tokensIn || 0) + (tokensOut || 0), 1)) * 100)}%`,
                        }}
                      />
                    </div>
                    <span className="token-bar-value">{typeof tokensIn === "number" ? tokensIn.toLocaleString() : "--"}</span>
                  </div>
                  <div className="token-bar-row">
                    <span className="token-bar-label">Tokens Out</span>
                    <div className="token-bar-track">
                      <div
                        className="token-bar-fill out"
                        style={{
                          width: `${Math.min(100, ((tokensOut || 0) / Math.max((tokensIn || 0) + (tokensOut || 0), 1)) * 100)}%`,
                        }}
                      />
                    </div>
                    <span className="token-bar-value">{typeof tokensOut === "number" ? tokensOut.toLocaleString() : "--"}</span>
                  </div>
                </div>
                <div className="cost-summary">
                  <span className="cost-summary-label">Total Cost</span>
                  <span className="cost-summary-value">${typeof totalCost === "number" ? totalCost.toFixed(4) : "0.0000"}</span>
                </div>
              </div>
            )}

            {/* Actions Tab */}
            {infoTab === "actions" && (
              <div className="actions-tab-content">
                {/* Change Model */}
                <div className="action-row" style={{ position: "relative" }}>
                  <button onClick={handleOpenModels} className="action-btn">
                    Change Model
                  </button>
                  {showModelDropdown && (
                    <div className="model-dropdown">
                      {models.length === 0 ? (
                        <div className="model-dropdown-loading">
                          <span className="spinner" style={{ width: 14, height: 14, borderWidth: 2, display: "inline-block", marginRight: 8 }} />
                          Loading models...
                        </div>
                      ) : (
                        models.map((m: any) => (
                          <div
                            key={`${m.provider}-${m.id || m.name}`}
                            className="model-dropdown-item"
                            onClick={() => handleChangeModel(m.id || m.name)}
                          >
                            <span>{m.id || m.name}</span>
                            <span className="model-dropdown-provider">{m.provider}</span>
                          </div>
                        ))
                      )}
                    </div>
                  )}
                </div>
                <div className="action-row">
                  <button
                    onClick={handlePauseResume}
                    className={`action-btn ${agent?.status === "paused" ? "btn-resume" : "btn-pause"}`}
                  >
                    {agent?.status === "paused" ? "Resume Agent" : "Pause Agent"}
                  </button>
                </div>
                <div className="action-row">
                  <button onClick={() => setShowReplaceDialog(true)} className="action-btn btn-replace">
                    Replace Agent
                  </button>
                </div>
                <div className="action-row">
                  <button onClick={() => setShowConfirmRemove(true)} className="action-btn btn-remove">
                    Remove Agent
                  </button>
                </div>
              </div>
            )}

            {/* Approvals Tab */}
            {infoTab === "approvals" && agentId && (
              <div className="approvals-tab-content" style={{ padding: "12px" }}>
                <ApprovalHistory requests={getHistoryForAgent(agentId)} />
              </div>
            )}
          </div>
        </div>
      )}

      {/* Confirmation dialog */}
      {showConfirmRemove && (
        <div className="confirm-overlay" onClick={() => setShowConfirmRemove(false)}>
          <div className="confirm-dialog" onClick={(e) => e.stopPropagation()}>
            <h3 style={{ marginBottom: 12, fontSize: 16 }}>Remove Agent</h3>
            <p style={{ color: "var(--text-secondary)", fontSize: 14, marginBottom: 20 }}>
              Are you sure you want to remove <strong>{agentName}</strong>?
              This action cannot be undone.
            </p>
            <div style={{ display: "flex", justifyContent: "flex-end", gap: 8 }}>
              <button onClick={() => setShowConfirmRemove(false)}>Cancel</button>
              <button className="btn-danger" onClick={handleRemove} style={{ background: "#da3633", color: "#fff", borderColor: "#da3633" }}>
                Remove
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Replace Agent Dialog */}
      {showReplaceDialog && sessionId && agentId && (
        <ReplaceAgentDialog
          sessionId={sessionId}
          agentId={agentId}
          agentName={agentName}
          onClose={() => setShowReplaceDialog(false)}
          onReplaced={(newAgent: any) => {
            setShowReplaceDialog(false);
            const newId = newAgent?.id || newAgent?.agentId;
            if (newId) {
              navigate(`/session/${sessionId}/agent/${newId}`);
            } else {
              loadAgent();
            }
          }}
        />
      )}

      {/* Toast */}
      {toast && <div className="toast">{toast}</div>}
    </div>
  );
}
