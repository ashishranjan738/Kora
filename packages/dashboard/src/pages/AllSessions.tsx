import React, { useEffect, useState, useCallback, useRef } from "react";
import { useNavigate } from "react-router-dom";
import { useSessionStore } from "../stores/sessionStore";
import { useApi } from "../hooks/useApi";
import { StopSessionDialog } from "../components/StopSessionDialog";

interface PlaybookAgent {
  name: string;
  role: string;
  provider?: string;
  model?: string;
  persona?: string;
  initialTask?: string;
}

interface Playbook {
  name: string;
  description?: string;
  agents: PlaybookAgent[];
}

const KNOWN_PROVIDERS = ["claude-code", "codex", "gemini-cli", "aider", "goose", "custom"] as const;

const PROVIDER_MODEL_HINTS: Record<string, string[]> = {
  "claude-code": ["claude-opus-4-6", "claude-sonnet-4-6", "claude-sonnet-4-5-20250514", "claude-haiku-3-5"],
  codex: ["o4-mini", "o3", "gpt-4.1"],
  "gemini-cli": ["gemini-2.5-pro", "gemini-2.5-flash"],
  aider: ["claude-sonnet-4-6", "gpt-4.1", "deepseek-chat"],
  goose: ["claude-sonnet-4-6", "gpt-4.1"],
  custom: [],
};

const PROVIDER_COLORS: Record<string, string> = {
  anthropic: "#bc8cff",
  openai: "#3fb950",
  google: "#58a6ff",
  mistral: "#d29922",
  ollama: "#8b949e",
};

function getProviderColor(provider: string): string {
  const key = provider.toLowerCase();
  for (const [k, v] of Object.entries(PROVIDER_COLORS)) {
    if (key.includes(k)) return v;
  }
  return "#8b949e";
}

export function AllSessions() {
  const { sessions, loading, error, fetchSessions } = useSessionStore();
  const navigate = useNavigate();
  const api = useApi();

  // Dialog states
  const [showCreateDialog, setShowCreateDialog] = useState(false);
  const [showPlaybookPicker, setShowPlaybookPicker] = useState(false);
  const [stopConfirmSession, setStopConfirmSession] = useState<any>(null);
  const [stopping, setStopping] = useState(false);
  const [stopSuccess, setStopSuccess] = useState(false);

  // Create session form
  const [newName, setNewName] = useState("");
  const [newPath, setNewPath] = useState("");
  const [creating, setCreating] = useState(false);
  const [newMessagingMode, setNewMessagingMode] = useState<"mcp" | "terminal" | "manual">("mcp");
  const [newWorktreeMode, setNewWorktreeMode] = useState<"isolated" | "shared">("isolated");

  // Playbook state
  const [playbooks, setPlaybooks] = useState<Playbook[]>([]);
  const [loadingPlaybooks, setLoadingPlaybooks] = useState(false);
  const [selectedPlaybook, setSelectedPlaybook] = useState<Playbook | null>(
    null
  );
  const [playbookPath, setPlaybookPath] = useState("");
  const [launchingPlaybook, setLaunchingPlaybook] = useState(false);
  const [playbookSessionName, setPlaybookSessionName] = useState("");

  // Per-agent model & provider overrides (keyed by agent index)
  const [agentModelOverrides, setAgentModelOverrides] = useState<Record<number, string>>({});
  const [agentProviderOverrides, setAgentProviderOverrides] = useState<Record<number, string>>({});
  const [defaultModelForAll, setDefaultModelForAll] = useState("");
  const [agentCliArgsOverrides, setAgentCliArgsOverrides] = useState<Record<number, string>>({});
  const [playbookMessagingMode, setPlaybookMessagingMode] = useState<"mcp" | "terminal" | "manual">("mcp");
  const [playbookWorktreeMode, setPlaybookWorktreeMode] = useState<"isolated" | "shared">("isolated");

  // Daemon status
  const [daemonStatus, setDaemonStatus] = useState<{
    connected: boolean;
    version?: string;
  }>({ connected: false });

  const pollRef = useRef<ReturnType<typeof setInterval> | null>(null);

  // Fetch sessions + daemon status
  const refreshData = useCallback(async () => {
    fetchSessions();
    try {
      const status = await api.getStatus();
      setDaemonStatus({ connected: true, version: status?.version });
    } catch {
      setDaemonStatus({ connected: false });
    }
  }, [fetchSessions]);

  // Poll every 5 seconds
  useEffect(() => {
    refreshData();
    pollRef.current = setInterval(refreshData, 5000);
    return () => {
      if (pollRef.current) clearInterval(pollRef.current);
    };
  }, [refreshData]);

  // Computed stats
  const totalSessions = sessions.length;
  const totalAgentsRunning = sessions.reduce((sum, s) => {
    const running =
      typeof s.runningAgentCount === "number"
        ? s.runningAgentCount
        : s.agentCount ?? 0;
    return sum + running;
  }, 0);
  const totalCost = sessions.reduce((sum, s) => {
    return sum + (typeof s.cost === "number" ? s.cost : 0);
  }, 0);

  // Create session from scratch
  async function handleCreate() {
    if (!newName.trim()) return;
    setCreating(true);
    try {
      const result: any = await api.createSession({
        name: newName,
        projectPath: newPath,
        messagingMode: newMessagingMode,
        worktreeMode: newWorktreeMode,
      });
      useSessionStore.getState().addSession(result);
      setShowCreateDialog(false);
      setNewName("");
      setNewPath("");
      setNewMessagingMode("mcp");
      setNewWorktreeMode("isolated");
      if (result.id) {
        navigate(`/session/${result.id}`);
      }
    } catch (err: any) {
      alert(`Failed to create session: ${err.message}`);
    } finally {
      setCreating(false);
    }
  }

  // Load playbooks
  async function loadPlaybooks() {
    setLoadingPlaybooks(true);
    try {
      const data = await api.getPlaybooks();
      const names: string[] = data.playbooks || [];
      const loaded: Playbook[] = [];
      for (const name of names) {
        try {
          const pb = await api.getPlaybook(name);
          loaded.push(pb);
        } catch {
          loaded.push({ name, agents: [] });
        }
      }
      setPlaybooks(loaded);
    } catch {
      setPlaybooks([]);
    } finally {
      setLoadingPlaybooks(false);
    }
  }

  function openPlaybookPicker() {
    setShowPlaybookPicker(true);
    loadPlaybooks();
  }

  function selectPlaybook(pb: Playbook) {
    setSelectedPlaybook(pb);
    setPlaybookSessionName(pb.name);
    const modelOverrides: Record<number, string> = {};
    const providerOverrides: Record<number, string> = {};
    pb.agents.forEach((agent, i) => {
      modelOverrides[i] = agent.model || "";
      providerOverrides[i] = agent.provider || "claude-code";
    });
    setAgentModelOverrides(modelOverrides);
    setAgentProviderOverrides(providerOverrides);
    setDefaultModelForAll("");
  }

  function handleDefaultModelChange(value: string) {
    setDefaultModelForAll(value);
    if (selectedPlaybook) {
      const overrides: Record<number, string> = {};
      selectedPlaybook.agents.forEach((_agent, i) => {
        overrides[i] = value;
      });
      setAgentModelOverrides(overrides);
    }
  }

  // Launch playbook
  async function handleLaunchPlaybook() {
    if (!selectedPlaybook || !playbookPath.trim()) return;
    setLaunchingPlaybook(true);
    try {
      const sessionResult: any = await api.createSession({
        name: playbookSessionName.trim() || selectedPlaybook.name,
        projectPath: playbookPath,
        messagingMode: playbookMessagingMode,
        worktreeMode: playbookWorktreeMode,
      });
      useSessionStore.getState().addSession(sessionResult);

      // Spawn all agents from the playbook with overrides
      for (let i = 0; i < selectedPlaybook.agents.length; i++) {
        const agent = selectedPlaybook.agents[i];
        try {
          await api.spawnAgent(sessionResult.id, {
            name: agent.name,
            role: agent.role || "worker",
            provider: agentProviderOverrides[i] || agent.provider,
            model: agentModelOverrides[i] || agent.model,
            persona: agent.persona,
            initialTask: agent.initialTask,
            extraCliArgs: agentCliArgsOverrides[i]?.trim()
              ? agentCliArgsOverrides[i].trim().split(/\s+/)
              : (agent as any).extraCliArgs,
          });
        } catch {
          // continue spawning others if one fails
        }
      }

      setShowPlaybookPicker(false);
      setSelectedPlaybook(null);
      setPlaybookPath("");
      setPlaybookSessionName("");
      setAgentModelOverrides({});
      setAgentProviderOverrides({});
      setAgentCliArgsOverrides({});
      setDefaultModelForAll("");
      setPlaybookMessagingMode("mcp");
      setPlaybookWorktreeMode("isolated");
      navigate(`/session/${sessionResult.id}`);
    } catch (err: any) {
      alert(`Failed to launch playbook: ${err.message}`);
    } finally {
      setLaunchingPlaybook(false);
    }
  }

  // Stop session with confirmation
  async function handleStopSession() {
    if (!stopConfirmSession) return;
    setStopping(true);
    try {
      await api.stopSession(stopConfirmSession.id);
      setStopSuccess(true);
      useSessionStore.getState().removeSession(stopConfirmSession.id);
      setTimeout(() => {
        setStopConfirmSession(null);
        setStopping(false);
        setStopSuccess(false);
      }, 1500);
    } catch (err: any) {
      setStopping(false);
      alert(`Failed to stop session: ${err.message}`);
    }
  }

  function getStatusBadge(status: string) {
    const map: Record<string, string> = {
      active: "badge-green",
      paused: "badge-yellow",
      stopped: "badge-red",
      completed: "badge-blue",
    };
    return map[status] || "badge-blue";
  }

  function getStatusDotClass(status: string) {
    const map: Record<string, string> = {
      active: "green",
      paused: "yellow",
      stopped: "red",
      completed: "blue",
    };
    return map[status] || "blue";
  }

  // Full Stack Team visual for playbook preview
  function renderPlaybookVisual(playbook: Playbook) {
    const agents = playbook.agents || [];
    if (agents.length === 0) {
      return (
        <span
          style={{ fontSize: 12, color: "var(--text-muted)", fontStyle: "italic" }}
        >
          No agents defined
        </span>
      );
    }

    const master = agents.find(
      (a) => a.role === "master" || a.role === "architect"
    );
    const workers = agents.filter(
      (a) => a.role !== "master" && a.role !== "architect"
    );

    return (
      <div className="playbook-visual">
        {master && (
          <>
            <div className="playbook-visual-node playbook-visual-master">
              {master.name}
            </div>
            {workers.length > 0 && (
              <div className="playbook-visual-arrow">
                <svg width="24" height="24" viewBox="0 0 24 24" fill="none">
                  <path
                    d="M12 4v12m0 0l-4-4m4 4l4-4"
                    stroke="var(--text-muted)"
                    strokeWidth="2"
                    strokeLinecap="round"
                    strokeLinejoin="round"
                  />
                </svg>
              </div>
            )}
          </>
        )}
        {workers.length > 0 && (
          <div className="playbook-visual-workers">
            {workers.map((w, i) => (
              <div key={i} className="playbook-visual-node playbook-visual-worker">
                {w.name}
              </div>
            ))}
          </div>
        )}
      </div>
    );
  }

  const hasNoSessions = !loading && sessions.length === 0 && !error;

  return (
    <div className="page page-animate">
      {/* Hero Banner */}
      <div className="hero">
        <div className="hero-content">
          <div className="hero-title-row">
            <h1 className="hero-title">Kora</h1>
            <div className="daemon-status">
              <span
                className={`status-dot ${daemonStatus.connected ? "green" : "red"} ${daemonStatus.connected ? "status-dot-pulse" : ""}`}
              />
              <span
                style={{
                  fontSize: 13,
                  color: daemonStatus.connected
                    ? "var(--accent-green)"
                    : "var(--accent-red)",
                }}
              >
                {daemonStatus.connected ? "Connected" : "Disconnected"}
              </span>
            </div>
          </div>

          <div className="stats-bar">
            <div className="stats-item">
              <span className="stats-value">{totalSessions}</span>
              <span className="stats-label">
                {totalSessions === 1 ? "Session" : "Sessions"}
              </span>
            </div>
            <div className="stats-divider" />
            <div className="stats-item">
              <span className="stats-value">{totalAgentsRunning}</span>
              <span className="stats-label">Agents Running</span>
            </div>
            <div className="stats-divider" />
            <div className="stats-item">
              <span className="stats-value">${totalCost.toFixed(2)}</span>
              <span className="stats-label">Total Cost</span>
            </div>
          </div>
        </div>
      </div>

      {error && (
        <p style={{ color: "var(--accent-red)", marginBottom: 16 }}>{error}</p>
      )}

      {loading && sessions.length === 0 && (
        <div style={{ textAlign: "center", padding: "48px 0" }}>
          <p style={{ color: "var(--text-secondary)", fontSize: 15 }}>
            Loading sessions...
          </p>
        </div>
      )}

      {/* Empty State */}
      {hasNoSessions && (
        <div className="empty-state">
          <div className="empty-state-icon">
            <svg
              width="64"
              height="64"
              viewBox="0 0 24 24"
              fill="none"
              stroke="var(--text-muted)"
              strokeWidth="1"
              strokeLinecap="round"
              strokeLinejoin="round"
            >
              <rect x="2" y="3" width="20" height="14" rx="2" ry="2" />
              <line x1="8" y1="21" x2="16" y2="21" />
              <line x1="12" y1="17" x2="12" y2="21" />
              <path d="M7 8h2m2 0h2m2 0h2" />
              <path d="M7 11h10" />
            </svg>
          </div>
          <h2 className="empty-state-title">No sessions yet</h2>
          <p className="empty-state-text">
            Get started by creating a session or launching a playbook
          </p>
          <div className="empty-state-actions">
            <button
              className="primary"
              onClick={() => setShowCreateDialog(true)}
              style={{ padding: "10px 24px", fontSize: 15 }}
            >
              Create From Scratch
            </button>
            <button
              onClick={openPlaybookPicker}
              style={{ padding: "10px 24px", fontSize: 15 }}
            >
              Launch Playbook
            </button>
          </div>
        </div>
      )}

      {/* Session Cards + Create Options */}
      {!hasNoSessions && (
        <>
          <div
            style={{
              display: "flex",
              alignItems: "center",
              justifyContent: "space-between",
              marginBottom: 16,
            }}
          >
            <h2 style={{ fontSize: 18, fontWeight: 600 }}>Sessions</h2>
          </div>

          <div className="grid">
            {sessions.map((s) => (
              <div
                key={s.id}
                className="card session-card"
                style={s.status === "stopped" ? { opacity: 0.5, filter: "grayscale(0.4)" } : undefined}
                onClick={() => navigate(`/session/${s.id}`)}
              >
                {/* Header: name + status */}
                <div className="session-card-header">
                  <h3 className="session-card-name">
                    {s.name || "Unnamed Session"}
                  </h3>
                  <span className={`badge ${getStatusBadge(s.status)}`}>
                    <span
                      className={`status-dot ${getStatusDotClass(s.status)} ${s.status === "active" ? "status-dot-pulse" : ""}`}
                      style={{
                        width: 6,
                        height: 6,
                        marginRight: 6,
                        verticalAlign: "middle",
                      }}
                    />
                    {s.status || "unknown"}
                  </span>
                </div>

                {/* Project path */}
                <p className="session-card-path" title={s.projectPath || ""}>
                  {s.projectPath || "No path set"}
                </p>

                {/* Agent health breakdown + cost */}
                <div className="session-card-meta">
                  <span>
                    {(() => {
                      const running = s.runningAgentCount ?? 0;
                      const crashed = s.crashedAgentCount ?? 0;
                      const stopped = s.stoppedAgentCount ?? 0;
                      const parts: React.ReactNode[] = [];
                      if (running > 0)
                        parts.push(
                          <span key="r" style={{ color: "var(--accent-green)" }}>
                            {running} running
                          </span>
                        );
                      if (crashed > 0)
                        parts.push(
                          <span key="c" style={{ color: "var(--accent-red)" }}>
                            {crashed} crashed
                          </span>
                        );
                      if (stopped > 0)
                        parts.push(
                          <span key="s" style={{ color: "var(--text-muted)" }}>
                            {stopped} stopped
                          </span>
                        );
                      if (parts.length === 0)
                        return <span style={{ color: "var(--text-muted)" }}>0 agents</span>;
                      return parts.reduce<React.ReactNode[]>(
                        (acc, el, i) =>
                          i === 0 ? [el] : [...acc, <span key={`sep-${i}`}>, </span>, el],
                        []
                      );
                    })()}
                  </span>
                  <span className="session-card-cost">
                    ${typeof s.cost === "number" ? s.cost.toFixed(2) : "0.00"}
                  </span>
                </div>

                {/* Agent names */}
                {s.agentSummaries && (s.agentSummaries as any[]).length > 0 && (
                  <div
                    style={{
                      fontSize: 12,
                      color: "var(--text-muted)",
                      marginBottom: 8,
                      whiteSpace: "nowrap",
                      overflow: "hidden",
                      textOverflow: "ellipsis",
                    }}
                    title={(s.agentSummaries as any[]).map((a: any) => a.name).join(", ")}
                  >
                    {(s.agentSummaries as any[])
                      .slice(0, 3)
                      .map((a: any) => a.name)
                      .join(", ")}
                    {(s.agentSummaries as any[]).length > 3 &&
                      ` +${(s.agentSummaries as any[]).length - 3} more`}
                  </div>
                )}

                {/* Crashed warning badge */}
                {(s.crashedAgentCount ?? 0) > 0 && (
                  <div
                    style={{
                      display: "inline-flex",
                      alignItems: "center",
                      gap: 4,
                      fontSize: 12,
                      color: "var(--accent-red)",
                      backgroundColor: "rgba(248, 81, 73, 0.1)",
                      borderRadius: 4,
                      padding: "2px 8px",
                      marginBottom: 8,
                    }}
                  >
                    <svg
                      width="14"
                      height="14"
                      viewBox="0 0 24 24"
                      fill="none"
                      stroke="currentColor"
                      strokeWidth="2"
                      strokeLinecap="round"
                      strokeLinejoin="round"
                    >
                      <path d="M10.29 3.86L1.82 18a2 2 0 001.71 3h16.94a2 2 0 001.71-3L13.71 3.86a2 2 0 00-3.42 0z" />
                      <line x1="12" y1="9" x2="12" y2="13" />
                      <line x1="12" y1="17" x2="12.01" y2="17" />
                    </svg>
                    {s.crashedAgentCount} agent{s.crashedAgentCount !== 1 ? "s" : ""} crashed
                  </div>
                )}

                {/* Provider badges */}
                {s.providers && s.providers.length > 0 && (
                  <div className="session-card-providers">
                    {(s.providers as string[]).map((p: string, i: number) => (
                      <span
                        key={i}
                        className="badge-provider"
                        style={{
                          borderColor: getProviderColor(p),
                          color: getProviderColor(p),
                        }}
                      >
                        {p}
                      </span>
                    ))}
                  </div>
                )}

                {/* Worktree mode badge */}
                {(s as any).worktreeMode && (
                  <div
                    style={{
                      display: "inline-flex",
                      alignItems: "center",
                      gap: 4,
                      fontSize: 11,
                      color: (s as any).worktreeMode === "isolated" ? "var(--accent-blue)" : "var(--accent-purple)",
                      backgroundColor: (s as any).worktreeMode === "isolated" ? "rgba(88, 166, 255, 0.1)" : "rgba(188, 140, 255, 0.1)",
                      borderRadius: 4,
                      padding: "2px 8px",
                      marginBottom: 8,
                    }}
                  >
                    <svg
                      width="12"
                      height="12"
                      viewBox="0 0 24 24"
                      fill="none"
                      stroke="currentColor"
                      strokeWidth="2"
                      strokeLinecap="round"
                      strokeLinejoin="round"
                    >
                      {(s as any).worktreeMode === "isolated" ? (
                        <>
                          <line x1="6" y1="3" x2="6" y2="15" />
                          <circle cx="18" cy="6" r="3" />
                          <circle cx="6" cy="18" r="3" />
                          <path d="M18 9a9 9 0 01-9 9" />
                        </>
                      ) : (
                        <>
                          <path d="M22 19a2 2 0 01-2 2H4a2 2 0 01-2-2V5a2 2 0 012-2h5l2 3h9a2 2 0 012 2z" />
                        </>
                      )}
                    </svg>
                    {(s as any).worktreeMode === "isolated" ? "Isolated" : "Shared"}
                  </div>
                )}

                {/* Quick actions */}
                <div className="session-card-actions">
                  {s.status === "active" && (
                    <button
                      className="session-action-btn"
                      title="Stop session"
                      onClick={(e) => {
                        e.stopPropagation();
                        setStopConfirmSession(s);
                      }}
                    >
                      <svg
                        width="14"
                        height="14"
                        viewBox="0 0 24 24"
                        fill="currentColor"
                      >
                        <rect x="6" y="6" width="12" height="12" rx="2" />
                      </svg>
                      Stop
                    </button>
                  )}
                  {s.status === "stopped" && (
                    <button
                      className="session-action-btn"
                      title="Revive session"
                      style={{ color: "var(--accent-green)", borderColor: "var(--accent-green)" }}
                      onClick={(e) => {
                        e.stopPropagation();
                        navigate(`/session/${s.id}`);
                      }}
                    >
                      <svg
                        width="14"
                        height="14"
                        viewBox="0 0 24 24"
                        fill="none"
                        stroke="currentColor"
                        strokeWidth="2"
                        strokeLinecap="round"
                        strokeLinejoin="round"
                      >
                        <polyline points="23 4 23 10 17 10" />
                        <path d="M20.49 15a9 9 0 11-2.12-9.36L23 10" />
                      </svg>
                      Revive
                    </button>
                  )}
                </div>
              </div>
            ))}

            {/* Create From Scratch card */}
            <div
              className="card session-card create-option-card"
              onClick={() => setShowCreateDialog(true)}
            >
              <div className="create-option-icon">
                <svg
                  width="32"
                  height="32"
                  viewBox="0 0 24 24"
                  fill="none"
                  stroke="var(--accent-blue)"
                  strokeWidth="2"
                  strokeLinecap="round"
                  strokeLinejoin="round"
                >
                  <line x1="12" y1="5" x2="12" y2="19" />
                  <line x1="5" y1="12" x2="19" y2="12" />
                </svg>
              </div>
              <h3
                style={{
                  fontSize: 15,
                  fontWeight: 600,
                  marginBottom: 4,
                  color: "var(--accent-blue)",
                }}
              >
                From Scratch
              </h3>
              <p
                style={{
                  fontSize: 12,
                  color: "var(--text-muted)",
                }}
              >
                Create a new empty session
              </p>
            </div>

            {/* Create From Playbook card */}
            <div
              className="card session-card create-option-card"
              onClick={openPlaybookPicker}
            >
              <div className="create-option-icon">
                <svg
                  width="32"
                  height="32"
                  viewBox="0 0 24 24"
                  fill="none"
                  stroke="var(--accent-purple)"
                  strokeWidth="2"
                  strokeLinecap="round"
                  strokeLinejoin="round"
                >
                  <path d="M4 19.5A2.5 2.5 0 016.5 17H20" />
                  <path d="M6.5 2H20v20H6.5A2.5 2.5 0 014 19.5v-15A2.5 2.5 0 016.5 2z" />
                  <line x1="9" y1="7" x2="16" y2="7" />
                  <line x1="9" y1="11" x2="14" y2="11" />
                </svg>
              </div>
              <h3
                style={{
                  fontSize: 15,
                  fontWeight: 600,
                  marginBottom: 4,
                  color: "var(--accent-purple)",
                }}
              >
                From Playbook
              </h3>
              <p
                style={{
                  fontSize: 12,
                  color: "var(--text-muted)",
                }}
              >
                Launch a pre-configured team
              </p>
            </div>
          </div>
        </>
      )}

      {/* Create Session Dialog */}
      {showCreateDialog && (
        <div
          className="dialog-overlay"
          onClick={() => setShowCreateDialog(false)}
        >
          <div className="dialog" onClick={(e) => e.stopPropagation()}>
            <h2>Create New Session</h2>
            <div className="form-group">
              <label>Session Name</label>
              <input
                value={newName}
                onChange={(e) => setNewName(e.target.value)}
                placeholder="My Session"
                autoFocus
              />
            </div>
            <div className="form-group">
              <label>Project Path</label>
              <input
                value={newPath}
                onChange={(e) => setNewPath(e.target.value)}
                placeholder="/path/to/project"
              />
            </div>
            <div className="form-group">
              <label>Messaging Mode</label>
              <div style={{ display: "flex", flexDirection: "column", gap: 8, marginTop: 4 }}>
                <label className="radio-option">
                  <input
                    type="radio"
                    name="create-messaging-mode"
                    value="mcp"
                    checked={newMessagingMode === "mcp"}
                    onChange={() => setNewMessagingMode("mcp")}
                    style={{ marginTop: 2 }}
                  />
                  <span>
                    <strong>MCP Tools (recommended)</strong>
                    <span style={{ display: "block", fontSize: 11, color: "var(--text-muted)" }}>
                      Agents use send_message/check_messages. Supports long messages (30k chars).
                    </span>
                  </span>
                </label>
                <label className="radio-option">
                  <input
                    type="radio"
                    name="create-messaging-mode"
                    value="terminal"
                    checked={newMessagingMode === "terminal"}
                    onChange={() => setNewMessagingMode("terminal")}
                    style={{ marginTop: 2 }}
                  />
                  <span>
                    <strong>Terminal (@mentions)</strong>
                    <span style={{ display: "block", fontSize: 11, color: "var(--text-muted)" }}>
                      Agents use @Name: in terminal output. 500 char limit.
                    </span>
                  </span>
                </label>
                <label className="radio-option">
                  <input
                    type="radio"
                    name="create-messaging-mode"
                    value="manual"
                    checked={newMessagingMode === "manual"}
                    onChange={() => setNewMessagingMode("manual")}
                    style={{ marginTop: 2 }}
                  />
                  <span>
                    <strong>Manual</strong>
                    <span style={{ display: "block", fontSize: 11, color: "var(--text-muted)" }}>
                      User relays all messages via dashboard. No auto-messaging.
                    </span>
                  </span>
                </label>
              </div>
            </div>
            <div className="form-group">
              <label>Worktree Mode</label>
              <div style={{ display: "flex", gap: 0, marginTop: 4, borderRadius: 6, overflow: "hidden", border: "1px solid var(--border-color)" }}>
                <button
                  type="button"
                  onClick={() => setNewWorktreeMode("isolated")}
                  style={{
                    flex: 1,
                    padding: "8px 12px",
                    minHeight: 44,
                    fontSize: 13,
                    fontWeight: 500,
                    border: "none",
                    cursor: "pointer",
                    backgroundColor: newWorktreeMode === "isolated" ? "var(--accent-blue)" : "var(--bg-tertiary)",
                    color: newWorktreeMode === "isolated" ? "#fff" : "var(--text-secondary)",
                    transition: "background-color 0.15s, color 0.15s",
                  }}
                >
                  Isolated
                </button>
                <button
                  type="button"
                  onClick={() => setNewWorktreeMode("shared")}
                  style={{
                    flex: 1,
                    padding: "8px 12px",
                    minHeight: 44,
                    fontSize: 13,
                    fontWeight: 500,
                    border: "none",
                    borderLeft: "1px solid var(--border-color)",
                    cursor: "pointer",
                    backgroundColor: newWorktreeMode === "shared" ? "var(--accent-blue)" : "var(--bg-tertiary)",
                    color: newWorktreeMode === "shared" ? "#fff" : "var(--text-secondary)",
                    transition: "background-color 0.15s, color 0.15s",
                  }}
                >
                  Shared
                </button>
              </div>
              <div style={{ fontSize: 11, color: "var(--text-muted)", marginTop: 4 }}>
                {newWorktreeMode === "isolated"
                  ? "Each agent gets its own git worktree branch. Safe for parallel file edits."
                  : "All agents share the same working directory. Use when agents work on different files."}
              </div>
            </div>
            <div className="form-actions">
              <button onClick={() => setShowCreateDialog(false)}>Cancel</button>
              <button
                className="primary"
                onClick={handleCreate}
                disabled={creating || !newName.trim()}
              >
                {creating ? "Creating..." : "Create"}
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Playbook Picker Dialog */}
      {showPlaybookPicker && (
        <div
          className="dialog-overlay"
          onClick={() => {
            setShowPlaybookPicker(false);
            setSelectedPlaybook(null);
            setPlaybookPath("");
            setPlaybookSessionName("");
            setAgentModelOverrides({});
            setAgentProviderOverrides({});
            setAgentCliArgsOverrides({});
            setDefaultModelForAll("");
            setPlaybookMessagingMode("mcp");
            setPlaybookWorktreeMode("isolated");
          }}
        >
          <div
            className="dialog"
            style={{ maxWidth: "min(720px, 90vw)", minWidth: 0, width: "min(720px, calc(100vw - 32px))" }}
            onClick={(e) => e.stopPropagation()}
          >
            {!selectedPlaybook ? (
              <>
                <h2>Choose a Playbook</h2>
                {loadingPlaybooks && (
                  <p
                    style={{
                      color: "var(--text-secondary)",
                      padding: "24px 0",
                      textAlign: "center",
                    }}
                  >
                    Loading playbooks...
                  </p>
                )}
                {!loadingPlaybooks && playbooks.length === 0 && (
                  <div
                    style={{
                      textAlign: "center",
                      padding: "32px 0",
                      color: "var(--text-muted)",
                    }}
                  >
                    <p style={{ marginBottom: 8 }}>No playbooks found.</p>
                    <p style={{ fontSize: 13 }}>
                      Create playbooks in your project to get started.
                    </p>
                  </div>
                )}
                <div
                  style={{
                    display: "flex",
                    flexDirection: "column",
                    gap: 12,
                    maxHeight: 400,
                    overflowY: "auto",
                  }}
                >
                  {playbooks.map((pb) => (
                    <div
                      key={pb.name}
                      className="playbook-card"
                      onClick={() => selectPlaybook(pb)}
                    >
                      <div className="playbook-card-header">
                        <h3 className="playbook-card-name">{pb.name}</h3>
                        <span className="badge badge-purple">
                          {pb.agents.length} agent
                          {pb.agents.length !== 1 ? "s" : ""}
                        </span>
                      </div>
                      {pb.description && (
                        <p className="playbook-card-desc">{pb.description}</p>
                      )}
                      {renderPlaybookVisual(pb)}
                    </div>
                  ))}
                </div>
                <div
                  className="form-actions"
                  style={{ marginTop: 16 }}
                >
                  <button
                    onClick={() => {
                      setShowPlaybookPicker(false);
                      setSelectedPlaybook(null);
                    }}
                  >
                    Cancel
                  </button>
                </div>
              </>
            ) : (
              <>
                <h2>Launch: {selectedPlaybook.name}</h2>
                {selectedPlaybook.description && (
                  <p
                    style={{
                      color: "var(--text-secondary)",
                      fontSize: 14,
                      marginBottom: 16,
                    }}
                  >
                    {selectedPlaybook.description}
                  </p>
                )}

                <div
                  style={{
                    marginBottom: 16,
                    padding: 16,
                    backgroundColor: "var(--bg-primary)",
                    borderRadius: 8,
                    border: "1px solid var(--border-color)",
                  }}
                >
                  <p
                    style={{
                      fontSize: 12,
                      color: "var(--text-muted)",
                      marginBottom: 8,
                      textTransform: "uppercase",
                      letterSpacing: "0.05em",
                    }}
                  >
                    Agent Topology
                  </p>
                  {renderPlaybookVisual(selectedPlaybook)}
                </div>

                <div className="form-group">
                  <label>Session Name</label>
                  <input
                    value={playbookSessionName}
                    onChange={(e) => setPlaybookSessionName(e.target.value)}
                    placeholder={selectedPlaybook.name}
                  />
                </div>

                <div className="form-group">
                  <label>Project Path</label>
                  <input
                    value={playbookPath}
                    onChange={(e) => setPlaybookPath(e.target.value)}
                    placeholder="/path/to/project"
                    autoFocus
                  />
                </div>

                <div className="form-group">
                  <label>Messaging Mode</label>
                  <div style={{ display: "flex", flexDirection: "column", gap: 8, marginTop: 4 }}>
                    <label className="radio-option">
                      <input
                        type="radio"
                        name="playbook-messaging-mode"
                        value="mcp"
                        checked={playbookMessagingMode === "mcp"}
                        onChange={() => setPlaybookMessagingMode("mcp")}
                        style={{ marginTop: 2 }}
                      />
                      <span>
                        <strong>MCP Tools (recommended)</strong>
                        <span style={{ display: "block", fontSize: 11, color: "var(--text-muted)" }}>
                          Agents use send_message/check_messages. Supports long messages (30k chars).
                        </span>
                      </span>
                    </label>
                    <label className="radio-option">
                      <input
                        type="radio"
                        name="playbook-messaging-mode"
                        value="terminal"
                        checked={playbookMessagingMode === "terminal"}
                        onChange={() => setPlaybookMessagingMode("terminal")}
                        style={{ marginTop: 2 }}
                      />
                      <span>
                        <strong>Terminal (@mentions)</strong>
                        <span style={{ display: "block", fontSize: 11, color: "var(--text-muted)" }}>
                          Agents use @Name: in terminal output. 500 char limit.
                        </span>
                      </span>
                    </label>
                    <label className="radio-option">
                      <input
                        type="radio"
                        name="playbook-messaging-mode"
                        value="manual"
                        checked={playbookMessagingMode === "manual"}
                        onChange={() => setPlaybookMessagingMode("manual")}
                        style={{ marginTop: 2 }}
                      />
                      <span>
                        <strong>Manual</strong>
                        <span style={{ display: "block", fontSize: 11, color: "var(--text-muted)" }}>
                          User relays all messages via dashboard. No auto-messaging.
                        </span>
                      </span>
                    </label>
                  </div>
                </div>

                <div className="form-group">
                  <label>Worktree Mode</label>
                  <div style={{ display: "flex", gap: 0, marginTop: 4, borderRadius: 6, overflow: "hidden", border: "1px solid var(--border-color)" }}>
                    <button
                      type="button"
                      onClick={() => setPlaybookWorktreeMode("isolated")}
                      style={{
                        flex: 1,
                        padding: "8px 12px",
                        minHeight: 44,
                        fontSize: 13,
                        fontWeight: 500,
                        border: "none",
                        cursor: "pointer",
                        backgroundColor: playbookWorktreeMode === "isolated" ? "var(--accent-blue)" : "var(--bg-tertiary)",
                        color: playbookWorktreeMode === "isolated" ? "#fff" : "var(--text-secondary)",
                        transition: "background-color 0.15s, color 0.15s",
                      }}
                    >
                      Isolated
                    </button>
                    <button
                      type="button"
                      onClick={() => setPlaybookWorktreeMode("shared")}
                      style={{
                        flex: 1,
                        padding: "8px 12px",
                        minHeight: 44,
                        fontSize: 13,
                        fontWeight: 500,
                        border: "none",
                        borderLeft: "1px solid var(--border-color)",
                        cursor: "pointer",
                        backgroundColor: playbookWorktreeMode === "shared" ? "var(--accent-blue)" : "var(--bg-tertiary)",
                        color: playbookWorktreeMode === "shared" ? "#fff" : "var(--text-secondary)",
                        transition: "background-color 0.15s, color 0.15s",
                      }}
                    >
                      Shared
                    </button>
                  </div>
                  <div style={{ fontSize: 11, color: "var(--text-muted)", marginTop: 4 }}>
                    {playbookWorktreeMode === "isolated"
                      ? "Each agent gets its own git worktree branch. Safe for parallel file edits."
                      : "All agents share the same working directory. Use when agents work on different files."}
                  </div>
                </div>

                {/* Model Configuration Section */}
                {selectedPlaybook.agents.length > 0 && (
                  <div
                    style={{
                      marginBottom: 16,
                      padding: 16,
                      backgroundColor: "var(--bg-primary)",
                      borderRadius: 8,
                      border: "1px solid var(--border-color)",
                    }}
                  >
                    <p
                      style={{
                        fontSize: 12,
                        color: "var(--text-muted)",
                        marginBottom: 12,
                        textTransform: "uppercase",
                        letterSpacing: "0.05em",
                      }}
                    >
                      Configure Models
                    </p>

                    {/* Default model for all */}
                    <div style={{ marginBottom: 12 }}>
                      <label
                        style={{
                          fontSize: 12,
                          color: "var(--text-secondary)",
                          display: "block",
                          marginBottom: 4,
                        }}
                      >
                        Default model for all agents
                      </label>
                      <input
                        value={defaultModelForAll}
                        onChange={(e) => handleDefaultModelChange(e.target.value)}
                        placeholder="Type a model name to set all agents..."
                        style={{
                          width: "100%",
                          fontFamily: "'SF Mono', 'Fira Code', 'Cascadia Code', monospace",
                          fontSize: 13,
                          boxSizing: "border-box",
                        }}
                      />
                    </div>

                    {/* Agent model configuration table */}
                    <div
                      style={{
                        borderRadius: 6,
                        border: "1px solid var(--border-color)",
                        overflow: "hidden",
                      }}
                    >
                      {/* Table header */}
                      <div
                        className="agent-config-header"
                        style={{
                          display: "grid",
                          gridTemplateColumns: "1fr 150px 1fr",
                          gap: 0,
                          padding: "8px 12px",
                          backgroundColor: "rgba(255,255,255,0.03)",
                          borderBottom: "1px solid var(--border-color)",
                          fontSize: 11,
                          color: "var(--text-muted)",
                          textTransform: "uppercase",
                          letterSpacing: "0.05em",
                          fontWeight: 600,
                        }}
                      >
                        <span>Agent</span>
                        <span>Provider</span>
                        <span>Model</span>
                      </div>

                      {/* Agent rows */}
                      {selectedPlaybook.agents.map((agent, i) => {
                        const currentProvider = agentProviderOverrides[i] || agent.provider || "claude-code";
                        const hints = PROVIDER_MODEL_HINTS[currentProvider] || [];
                        return (
                          <div
                            key={i}
                            className="agent-config-row"
                            style={{
                              display: "grid",
                              gridTemplateColumns: "1fr 150px 1fr",
                              gap: 0,
                              padding: "8px 12px",
                              borderBottom:
                                i < selectedPlaybook.agents.length - 1
                                  ? "1px solid rgba(255,255,255,0.06)"
                                  : "none",
                              alignItems: "center",
                            }}
                          >
                            {/* Agent name + role */}
                            <div>
                              <span
                                style={{
                                  fontSize: 13,
                                  fontWeight: 500,
                                  color: "var(--text-primary)",
                                }}
                              >
                                {agent.name}
                              </span>
                              <span
                                style={{
                                  fontSize: 11,
                                  color: "var(--text-muted)",
                                  marginLeft: 6,
                                }}
                              >
                                {agent.role}
                              </span>
                            </div>

                            {/* Provider select */}
                            <select
                              value={currentProvider}
                              onChange={(e) => {
                                setAgentProviderOverrides((prev) => ({
                                  ...prev,
                                  [i]: e.target.value,
                                }));
                              }}
                              style={{
                                fontSize: 12,
                                fontFamily: "'SF Mono', 'Fira Code', 'Cascadia Code', monospace",
                                backgroundColor: "var(--bg-secondary)",
                                color: "var(--text-primary)",
                                border: "1px solid var(--border-color)",
                                borderRadius: 4,
                                padding: "4px 6px",
                                cursor: "pointer",
                              }}
                            >
                              {KNOWN_PROVIDERS.map((p) => (
                                <option key={p} value={p}>
                                  {p}
                                </option>
                              ))}
                            </select>

                            {/* Model text input */}
                            <div style={{ position: "relative" }}>
                              <input
                                value={agentModelOverrides[i] ?? agent.model ?? ""}
                                onChange={(e) =>
                                  setAgentModelOverrides((prev) => ({
                                    ...prev,
                                    [i]: e.target.value,
                                  }))
                                }
                                placeholder={hints[0] || "model name"}
                                style={{
                                  width: "100%",
                                  fontSize: 12,
                                  fontFamily: "'SF Mono', 'Fira Code', 'Cascadia Code', monospace",
                                  boxSizing: "border-box",
                                  padding: "4px 6px",
                                }}
                                list={`model-hints-${i}`}
                              />
                              <datalist id={`model-hints-${i}`}>
                                {hints.map((h) => (
                                  <option key={h} value={h} />
                                ))}
                              </datalist>
                            </div>

                            {/* CLI flags input spanning full row */}
                            <div style={{ gridColumn: "1 / -1", marginTop: 4 }}>
                              <input
                                value={agentCliArgsOverrides[i] ?? ""}
                                onChange={(e) =>
                                  setAgentCliArgsOverrides((prev) => ({
                                    ...prev,
                                    [i]: e.target.value,
                                  }))
                                }
                                placeholder="CLI flags (optional)"
                                style={{
                                  width: "100%",
                                  fontSize: 11,
                                  fontFamily: "var(--font-mono)",
                                  boxSizing: "border-box",
                                  padding: "3px 6px",
                                  color: "var(--accent-yellow)",
                                }}
                              />
                            </div>
                          </div>
                        );
                      })}
                    </div>
                  </div>
                )}

                <div className="form-actions">
                  <button onClick={() => setSelectedPlaybook(null)}>
                    Back
                  </button>
                  <button
                    className="primary"
                    onClick={handleLaunchPlaybook}
                    disabled={launchingPlaybook || !playbookPath.trim()}
                  >
                    {launchingPlaybook
                      ? "Launching..."
                      : `Launch ${selectedPlaybook.agents.length} Agents`}
                  </button>
                </div>
              </>
            )}
          </div>
        </div>
      )}

      {/* Stop Session Dialog */}
      {stopConfirmSession && (
        <StopSessionDialog
          session={{
            id: stopConfirmSession.id,
            name: stopConfirmSession.name || "Unnamed Session",
            agentCount: stopConfirmSession.agentCount ?? 0,
            activeAgentCount: stopConfirmSession.runningAgentCount ?? stopConfirmSession.agentCount ?? 0,
          }}
          onCancel={() => {
            if (!stopping) {
              setStopConfirmSession(null);
            }
          }}
          onConfirm={handleStopSession}
          stopping={stopping}
          success={stopSuccess}
        />
      )}
    </div>
  );
}
