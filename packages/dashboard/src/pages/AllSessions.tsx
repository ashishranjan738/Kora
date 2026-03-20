import React, { useEffect, useState, useCallback, useRef } from "react";
import { useNavigate } from "react-router-dom";
import { useSessionStore } from "../stores/sessionStore";
import { useApi } from "../hooks/useApi";
import { StopSessionDialog } from "../components/StopSessionDialog";
import { PlaybookGrid, PlaybookPreview, PlaybookUploadModal, VariableForm } from "../components/playbook";
import { PersonaLibrary } from "../components/PersonaLibrary";
import { showError } from "../utils/notifications";

interface PlaybookAgent {
  name: string;
  role: string;
  provider?: string;
  model?: string;
  persona?: string;
  initialTask?: string;
  extraCliArgs?: string[];
}

interface VariableDefinition {
  description?: string;
  default?: string;
  options?: string[];
}

interface Playbook {
  name: string;
  description?: string;
  agents: PlaybookAgent[];
  variables?: Record<string, VariableDefinition>;
  tags?: string[];
  source?: "builtin" | "global" | "project";
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
  const [newWorkflowStates, setNewWorkflowStates] = useState([
    { id: "pending", label: "Pending", color: "#6b7280", category: "not-started" as const, transitions: ["in-progress"] as string[], skippable: false },
    { id: "in-progress", label: "In Progress", color: "#3b82f6", category: "active" as const, transitions: ["review"] as string[], skippable: false },
    { id: "review", label: "Review", color: "#f59e0b", category: "active" as const, transitions: ["done"] as string[], skippable: false },
    { id: "done", label: "Done", color: "#22c55e", category: "closed" as const, transitions: [] as string[], skippable: false },
  ]);
  const [recentPaths, setRecentPaths] = useState<string[]>([]);

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
  const [defaultCliFlagsForAll, setDefaultCliFlagsForAll] = useState("");
  const [agentCliArgsOverrides, setAgentCliArgsOverrides] = useState<Record<number, string>>({});
  const [playbookMessagingMode, setPlaybookMessagingMode] = useState<"mcp" | "terminal" | "manual">("mcp");
  const [playbookWorktreeMode, setPlaybookWorktreeMode] = useState<"isolated" | "shared">("isolated");
  const [playbookWorkflowStates, setPlaybookWorkflowStates] = useState([
    { id: "pending", label: "Pending", color: "#6b7280", category: "not-started" as const, transitions: ["in-progress"] as string[], skippable: false },
    { id: "in-progress", label: "In Progress", color: "#3b82f6", category: "active" as const, transitions: ["review"] as string[], skippable: false },
    { id: "review", label: "Review", color: "#f59e0b", category: "active" as const, transitions: ["done"] as string[], skippable: false },
    { id: "done", label: "Done", color: "#22c55e", category: "closed" as const, transitions: [] as string[], skippable: false },
  ]);
  const [topologyExpanded, setTopologyExpanded] = useState(false);
  const [expandedCliFlags, setExpandedCliFlags] = useState<Record<number, boolean>>({});

  // Playbook variables state
  const [playbookVariables, setPlaybookVariables] = useState<Record<string, string>>({});
  const [showUploadModal, setShowUploadModal] = useState(false);
  const [showPersonaLibrary, setShowPersonaLibrary] = useState(false);

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
      typeof s.activeAgentCount === "number"
        ? s.activeAgentCount
        : s.agentCount ?? 0;
    return sum + running;
  }, 0);
  const totalCost = sessions.reduce((sum, s) => {
    return sum + (typeof s.cost === "number" ? s.cost : 0);
  }, 0);

  // Open create session dialog and load recent paths
  async function openCreateDialog() {
    setShowCreateDialog(true);
    try {
      const data = await api.getRecentPaths(10);
      setRecentPaths(data.paths || []);
    } catch {
      // Non-fatal: suggestions are optional
    }
  }

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
        workflowStates: newWorkflowStates.length > 0
          ? newWorkflowStates.map((s, i, arr) => ({
              ...s,
              // Auto-generate transitions: each state → next state (+ back to previous active)
              transitions: s.transitions?.length ? s.transitions : (
                i < arr.length - 1
                  ? [arr[i + 1].id, ...(i > 0 ? [arr[i - 1].id] : [])]
                  : [] // terminal state
              ),
            }))
          : undefined,
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
      showError(err.message, "Failed to create session");
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
    setDefaultModelForAll(""); setDefaultCliFlagsForAll("");

    // Initialize variables with defaults
    const initialVars: Record<string, string> = {};
    if (pb.variables) {
      Object.entries(pb.variables).forEach(([key, def]) => {
        initialVars[key] = def.default || "";
      });
    }
    setPlaybookVariables(initialVars);
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

  // Helper: Interpolate variables in text (replaces {{varName}} with values)
  function interpolateVariables(text: string | undefined, vars: Record<string, string>): string | undefined {
    if (!text) return text;
    return text.replace(/\{\{([\w-]+)\}\}/g, (_, key) => vars[key] ?? `{{${key}}}`);
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
        workflowStates: playbookWorkflowStates.length > 0
          ? playbookWorkflowStates.map((s, i, arr) => ({
              ...s,
              transitions: s.transitions?.length ? s.transitions : (
                i < arr.length - 1 ? [arr[i + 1].id, ...(i > 0 ? [arr[i - 1].id] : [])] : []
              ),
            }))
          : undefined,
      });
      useSessionStore.getState().addSession(sessionResult);

      // Spawn all agents from the playbook with overrides and variable interpolation
      for (let i = 0; i < selectedPlaybook.agents.length; i++) {
        const agent = selectedPlaybook.agents[i];
        try {
          await api.spawnAgent(sessionResult.id, {
            name: agent.name,
            role: agent.role || "worker",
            provider: agentProviderOverrides[i] || agent.provider,
            model: agentModelOverrides[i] || agent.model,
            persona: interpolateVariables(agent.persona, playbookVariables),
            initialTask: interpolateVariables(agent.initialTask, playbookVariables),
            extraCliArgs: agentCliArgsOverrides[i]?.trim()
              ? agentCliArgsOverrides[i].trim().split(/\s+/)
              : agent.extraCliArgs,
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
      setDefaultModelForAll(""); setDefaultCliFlagsForAll("");
      setPlaybookMessagingMode("mcp");
      setPlaybookWorktreeMode("isolated");
      setTopologyExpanded(false);
      setPlaybookVariables({});
      setExpandedCliFlags({});
      navigate(`/session/${sessionResult.id}`);
    } catch (err: any) {
      showError(err.message, "Failed to launch playbook");
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
      showError(err.message, "Failed to stop session");
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
              onClick={() => openCreateDialog()}
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
            <div style={{ display: "flex", gap: 8 }}>
              <button
                onClick={() => setShowPersonaLibrary(true)}
                style={{
                  background: "var(--bg-tertiary)", border: "1px solid var(--border-color)",
                  color: "var(--text-secondary)", padding: "6px 14px", borderRadius: 6,
                  cursor: "pointer", fontSize: 13, fontWeight: 500, display: "flex", alignItems: "center", gap: 6,
                }}
              >
                <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                  <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z" /><polyline points="14 2 14 8 20 8" />
                </svg>
                Personas
              </button>
              <button
                onClick={() => navigate("/playbooks")}
                style={{
                  background: "var(--bg-tertiary)", border: "1px solid var(--border-color)",
                  color: "var(--text-secondary)", padding: "6px 14px", borderRadius: 6,
                  cursor: "pointer", fontSize: 13, fontWeight: 500, display: "flex", alignItems: "center", gap: 6,
                }}
              >
                <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                  <path d="M4 19.5A2.5 2.5 0 016.5 17H20" /><path d="M6.5 2H20v20H6.5A2.5 2.5 0 014 19.5v-15A2.5 2.5 0 016.5 2z" />
                </svg>
                Playbooks
              </button>
            </div>
          </div>

          <div className="grid">
            {/* Create options — at the top */}
            <div
              className="card session-card create-option-card"
              onClick={() => openCreateDialog()}
            >
              <div className="create-option-icon">
                <svg width="32" height="32" viewBox="0 0 24 24" fill="none" stroke="var(--accent-blue)" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                  <line x1="12" y1="5" x2="12" y2="19" /><line x1="5" y1="12" x2="19" y2="12" />
                </svg>
              </div>
              <h3 style={{ fontSize: 15, fontWeight: 600, marginBottom: 4, color: "var(--accent-blue)" }}>From Scratch</h3>
              <p style={{ fontSize: 12, color: "var(--text-muted)" }}>Create a new empty session</p>
            </div>
            <div
              className="card session-card create-option-card"
              onClick={openPlaybookPicker}
            >
              <div className="create-option-icon">
                <svg width="32" height="32" viewBox="0 0 24 24" fill="none" stroke="var(--accent-purple)" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                  <path d="M4 19.5A2.5 2.5 0 016.5 17H20" /><path d="M6.5 2H20v20H6.5A2.5 2.5 0 014 19.5v-15A2.5 2.5 0 016.5 2z" />
                  <line x1="9" y1="7" x2="16" y2="7" /><line x1="9" y1="11" x2="14" y2="11" />
                </svg>
              </div>
              <h3 style={{ fontSize: 15, fontWeight: 600, marginBottom: 4, color: "var(--accent-purple)" }}>From Playbook</h3>
              <p style={{ fontSize: 12, color: "var(--text-muted)" }}>Launch a pre-configured team</p>
            </div>

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
                      const total = s.agentCount ?? 0;
                      const crashed = s.crashedAgentCount ?? 0;
                      const stopped = s.stoppedAgentCount ?? 0;
                      const running = s.activeAgentCount ?? Math.max(0, total - crashed - stopped);
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
                    <>
                      <button
                        className="session-action-btn"
                        title="Stop session"
                        onClick={(e) => {
                          e.stopPropagation();
                          setStopConfirmSession(s);
                        }}
                      >
                        <svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor">
                          <rect x="6" y="6" width="12" height="12" rx="2" />
                        </svg>
                        Stop
                      </button>
                      <button
                        className="session-action-btn"
                        title="Session settings"
                        style={{ color: "var(--text-secondary)", borderColor: "var(--border-color)" }}
                        onClick={(e) => {
                          e.stopPropagation();
                          navigate(`/session/${s.id}#agents`);
                        }}
                      >
                        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                          <circle cx="12" cy="12" r="3" /><path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 0 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 0 1-2.83-2.83l.06-.06A1.65 1.65 0 0 0 4.68 15a1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 0 1 2.83-2.83l.06.06A1.65 1.65 0 0 0 9 4.68a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 0 1 2.83 2.83l-.06.06A1.65 1.65 0 0 0 19.4 9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z" />
                        </svg>
                        Settings
                      </button>
                    </>
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

          </div>
        </>
      )}

      {/* Create Session Dialog */}
      {showCreateDialog && (
        <div
          className="dialog-overlay"
          onClick={() => setShowCreateDialog(false)}
        >
          <div className="dialog" onClick={(e) => e.stopPropagation()} style={{ maxHeight: "90vh", overflowY: "auto" }}>
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
                list="recent-paths-datalist"
              />
              <datalist id="recent-paths-datalist">
                {recentPaths.map((path, i) => (
                  <option key={i} value={path} />
                ))}
              </datalist>
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
            <div className="form-group">
              <label style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
                <span>Task Pipeline</span>
                <button
                  type="button"
                  onClick={() => {
                    const id = `custom-${Date.now()}`;
                    setNewWorkflowStates(prev => {
                      const insertIdx = prev.length > 0 ? prev.length - 1 : 0; // Before "done"
                      const newState = { id, label: "New State", color: "#8b5cf6", category: "active" as const, transitions: [] as string[], skippable: false };
                      const updated = [...prev];
                      updated.splice(insertIdx, 0, newState);
                      return updated;
                    });
                  }}
                  style={{
                    fontSize: 11, padding: "3px 10px", background: "var(--accent-blue)",
                    border: "none", borderRadius: 4, color: "white", cursor: "pointer",
                  }}
                >
                  + Add State
                </button>
              </label>
              <div style={{ fontSize: 11, color: "var(--text-muted)", marginBottom: 8 }}>
                Define the task workflow pipeline. States are frozen after session creation. Agents will be instructed to follow this pipeline.
              </div>
              <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
                {newWorkflowStates.map((state, i) => (
                  <div key={state.id} style={{
                    display: "flex", alignItems: "center", gap: 6,
                    padding: "6px 10px", borderRadius: 6,
                    background: "var(--bg-tertiary)", border: "1px solid var(--border-color)",
                  }}>
                    <input
                      type="color"
                      value={state.color}
                      onChange={(e) => {
                        const updated = [...newWorkflowStates];
                        updated[i] = { ...updated[i], color: e.target.value };
                        setNewWorkflowStates(updated);
                      }}
                      style={{ width: 24, height: 24, border: "none", background: "none", cursor: "pointer", padding: 0 }}
                    />
                    <input
                      value={state.label}
                      onChange={(e) => {
                        const updated = [...newWorkflowStates];
                        const newId = e.target.value.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
                        updated[i] = { ...updated[i], label: e.target.value, id: newId || state.id };
                        setNewWorkflowStates(updated);
                      }}
                      style={{
                        flex: 1, fontSize: 12, padding: "4px 8px", fontWeight: 600,
                        background: "var(--bg-secondary)", border: "1px solid var(--border-color)",
                        borderRadius: 4, color: "var(--text-primary)",
                      }}
                    />
                    <select
                      value={state.category}
                      onChange={(e) => {
                        const updated = [...newWorkflowStates];
                        updated[i] = { ...updated[i], category: e.target.value as any };
                        setNewWorkflowStates(updated);
                      }}
                      style={{
                        fontSize: 11, padding: "4px 6px", background: "var(--bg-secondary)",
                        border: "1px solid var(--border-color)", borderRadius: 4,
                        color: "var(--text-secondary)", cursor: "pointer",
                      }}
                    >
                      <option value="not-started">Not Started</option>
                      <option value="active">Active</option>
                      <option value="closed">Closed</option>
                    </select>
                    <label style={{ fontSize: 11, color: "var(--text-muted)", display: "flex", alignItems: "center", gap: 3, whiteSpace: "nowrap" }}>
                      <input
                        type="checkbox"
                        checked={state.skippable}
                        onChange={(e) => {
                          const updated = [...newWorkflowStates];
                          updated[i] = { ...updated[i], skippable: e.target.checked };
                          setNewWorkflowStates(updated);
                        }}
                      />
                      Skip
                    </label>
                    {newWorkflowStates.length > 2 && (
                      <button
                        type="button"
                        onClick={() => setNewWorkflowStates(prev => prev.filter((_, j) => j !== i))}
                        style={{
                          background: "none", border: "none", color: "var(--accent-red)",
                          cursor: "pointer", fontSize: 14, padding: "0 4px",
                        }}
                      >
                        ×
                      </button>
                    )}
                  </div>
                ))}
              </div>
              <div style={{ fontSize: 11, color: "var(--text-muted)", marginTop: 6 }}>
                Pipeline: {newWorkflowStates.map(s => s.skippable ? `${s.label}?` : s.label).join(" → ")}
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
            setDefaultModelForAll(""); setDefaultCliFlagsForAll("");
            setPlaybookMessagingMode("mcp");
            setPlaybookWorktreeMode("isolated");
            setTopologyExpanded(false);
            setExpandedCliFlags({});
            setPlaybookVariables({});
          }}
        >
          <div
            className="dialog"
            style={{ maxWidth: "min(700px, 90vw)", minWidth: 0, width: "min(700px, calc(100vw - 32px))" }}
            onClick={(e) => e.stopPropagation()}
          >
            {!selectedPlaybook ? (
              <>
                <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 16 }}>
                  <h2 style={{ margin: 0 }}>Choose a Playbook</h2>
                  <button
                    onClick={() => setShowUploadModal(true)}
                    style={{
                      backgroundColor: "var(--accent-blue)",
                      color: "white",
                      border: "none",
                      padding: "8px 16px",
                      borderRadius: 6,
                      cursor: "pointer",
                      fontSize: 14,
                    }}
                  >
                    Upload
                  </button>
                </div>
                <div style={{ maxHeight: "calc(80vh - 200px)", overflowY: "auto", paddingRight: 4 }}>
                  <PlaybookGrid
                    playbooks={playbooks}
                    selectedPlaybook={selectedPlaybook}
                    onSelectPlaybook={selectPlaybook}
                    loading={loadingPlaybooks}
                  />
                </div>
                <div
                  className="form-actions"
                  style={{ marginTop: 16 }}
                >
                  <button
                    onClick={() => {
                      setShowPlaybookPicker(false);
                      setSelectedPlaybook(null);
                      setPlaybookVariables({});
                    }}
                  >
                    Cancel
                  </button>
                </div>
              </>
            ) : (
              <div className="playbook-launch-dialog">
                {/* Dialog header */}
                <div className="playbook-launch-header">
                  <h2>Launch: {selectedPlaybook.name}</h2>
                  {selectedPlaybook.description && (
                    <p className="playbook-launch-desc">{selectedPlaybook.description}</p>
                  )}
                </div>

                {/* Scrollable content area */}
                <div className="playbook-launch-content">

                  {/* Section: Session Settings */}
                  <div className="playbook-section">
                    <div className="playbook-section-title">Session Settings</div>
                    <div className="playbook-settings-grid">
                      <label className="playbook-grid-label">Session Name</label>
                      <input
                        className="playbook-grid-input"
                        value={playbookSessionName}
                        onChange={(e) => setPlaybookSessionName(e.target.value)}
                        placeholder={selectedPlaybook.name}
                      />

                      <label className="playbook-grid-label">Project Path</label>
                      <input
                        className="playbook-grid-input"
                        value={playbookPath}
                        onChange={(e) => setPlaybookPath(e.target.value)}
                        placeholder="/path/to/project"
                        autoFocus
                      />

                      <label className="playbook-grid-label">Messaging</label>
                      <div>
                        <select
                          className="playbook-grid-input"
                          value={playbookMessagingMode}
                          onChange={(e) => setPlaybookMessagingMode(e.target.value as "mcp" | "terminal" | "manual")}
                        >
                          <option value="mcp">MCP Tools (recommended)</option>
                          <option value="terminal">Terminal (@mentions)</option>
                          <option value="manual">Manual</option>
                        </select>
                        <div className="playbook-setting-hint">
                          {playbookMessagingMode === "mcp"
                            ? "Agents use send_message/check_messages. Supports long messages."
                            : playbookMessagingMode === "terminal"
                            ? "Agents use @Name: in terminal output. 500 char limit."
                            : "User relays all messages via dashboard. No auto-messaging."}
                        </div>
                      </div>

                      <label className="playbook-grid-label">Worktree</label>
                      <div>
                        <div className="playbook-worktree-toggle">
                          <button
                            type="button"
                            className={`playbook-worktree-btn ${playbookWorktreeMode === "isolated" ? "active" : ""}`}
                            onClick={() => setPlaybookWorktreeMode("isolated")}
                          >
                            Isolated
                          </button>
                          <button
                            type="button"
                            className={`playbook-worktree-btn ${playbookWorktreeMode === "shared" ? "active" : ""}`}
                            onClick={() => setPlaybookWorktreeMode("shared")}
                          >
                            Shared
                          </button>
                        </div>
                        <div className="playbook-setting-hint">
                          {playbookWorktreeMode === "isolated"
                            ? "Each agent gets its own git worktree branch."
                            : "All agents share the same working directory."}
                        </div>
                      </div>
                    </div>
                  </div>

                  {/* Section: Task Pipeline */}
                  <div className="playbook-section">
                    <div className="playbook-section-title" style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
                      <span>Task Pipeline</span>
                      <button
                        type="button"
                        onClick={() => {
                          const id = `custom-${Date.now()}`;
                          setPlaybookWorkflowStates(prev => {
                            const idx = prev.length > 0 ? prev.length - 1 : 0;
                            const updated = [...prev];
                            updated.splice(idx, 0, { id, label: "New State", color: "#8b5cf6", category: "active" as const, transitions: [] as string[], skippable: false });
                            return updated;
                          });
                        }}
                        style={{ fontSize: 11, padding: "3px 10px", background: "var(--accent-blue)", border: "none", borderRadius: 4, color: "white", cursor: "pointer" }}
                      >
                        + Add
                      </button>
                    </div>
                    <div style={{ display: "flex", flexDirection: "column", gap: 4, marginTop: 8 }}>
                      {playbookWorkflowStates.map((state, i) => (
                        <div key={state.id} style={{
                          display: "flex", alignItems: "center", gap: 6, padding: "4px 8px",
                          borderRadius: 4, background: "var(--bg-tertiary)", border: "1px solid var(--border-color)",
                        }}>
                          <input type="color" value={state.color} onChange={(e) => {
                            const u = [...playbookWorkflowStates]; u[i] = { ...u[i], color: e.target.value }; setPlaybookWorkflowStates(u);
                          }} style={{ width: 20, height: 20, border: "none", background: "none", cursor: "pointer", padding: 0 }} />
                          <input value={state.label} onChange={(e) => {
                            const u = [...playbookWorkflowStates];
                            const newId = e.target.value.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
                            u[i] = { ...u[i], label: e.target.value, id: newId || state.id };
                            setPlaybookWorkflowStates(u);
                          }} placeholder="State name" style={{ flex: 1, fontSize: 12, padding: "3px 6px", background: "var(--bg-primary)", border: "1px solid var(--border-color)", borderRadius: 4, color: "var(--text-primary)" }} />
                          <label style={{ fontSize: 10, color: "var(--text-muted)", display: "flex", alignItems: "center", gap: 2, whiteSpace: "nowrap" }}>
                            <input type="checkbox" checked={state.skippable} onChange={(e) => {
                              const u = [...playbookWorkflowStates]; u[i] = { ...u[i], skippable: e.target.checked }; setPlaybookWorkflowStates(u);
                            }} /> Skip
                          </label>
                          {playbookWorkflowStates.length > 2 && (
                            <button type="button" onClick={() => setPlaybookWorkflowStates(prev => prev.filter((_, j) => j !== i))}
                              style={{ background: "none", border: "none", color: "var(--accent-red)", cursor: "pointer", fontSize: 12, padding: "0 3px" }}>×</button>
                          )}
                        </div>
                      ))}
                    </div>
                    <div style={{ fontSize: 10, color: "var(--text-muted)", marginTop: 4 }}>
                      {playbookWorkflowStates.map(s => s.skippable ? `${s.label}?` : s.label).join(" → ")}
                    </div>
                  </div>

                  {/* Section: Variables */}
                  {selectedPlaybook.variables && Object.keys(selectedPlaybook.variables).length > 0 && (
                    <div className="playbook-section">
                      <div className="playbook-section-title">Variables</div>
                      <div style={{ marginTop: 12 }}>
                        <VariableForm
                          variables={selectedPlaybook.variables}
                          values={playbookVariables}
                          onChange={(key, value) => {
                            setPlaybookVariables(prev => ({ ...prev, [key]: value }));
                          }}
                        />
                      </div>
                    </div>
                  )}

                  {/* Section: Agent Topology (collapsible, default collapsed) */}
                  <div className="playbook-section playbook-section-collapsible">
                    <button
                      type="button"
                      className="playbook-section-toggle"
                      onClick={() => setTopologyExpanded(!topologyExpanded)}
                    >
                      <span className={`playbook-chevron ${topologyExpanded ? "expanded" : ""}`}>&#9654;</span>
                      <span className="playbook-section-title">Agent Topology</span>
                    </button>
                    {topologyExpanded && (
                      <div className="playbook-topology-content">
                        {renderPlaybookVisual(selectedPlaybook)}
                      </div>
                    )}
                  </div>

                  {/* Section: Agents */}
                  {selectedPlaybook.agents.length > 0 && (
                    <div className="playbook-section">
                      <div className="playbook-section-title">
                        Agents ({selectedPlaybook.agents.length})
                      </div>

                      {/* Default model for all */}
                      <div className="playbook-default-model">
                        <label className="playbook-default-model-label">Default model:</label>
                        <input
                          value={defaultModelForAll}
                          onChange={(e) => handleDefaultModelChange(e.target.value)}
                          placeholder="Set model for all agents..."
                          className="playbook-default-model-input"
                        />
                      </div>

                      {/* Default CLI flags for all */}
                      <div className="playbook-default-model">
                        <label className="playbook-default-model-label">Default CLI flags:</label>
                        <input
                          value={defaultCliFlagsForAll}
                          onChange={(e) => {
                            const val = e.target.value;
                            setDefaultCliFlagsForAll(val);
                            if (selectedPlaybook) {
                              const overrides: Record<number, string> = {};
                              selectedPlaybook.agents.forEach((_agent, i) => {
                                overrides[i] = val;
                              });
                              setAgentCliArgsOverrides(overrides);
                              // Auto-expand CLI flags for all agents
                              const expanded: Record<number, boolean> = {};
                              selectedPlaybook.agents.forEach((_agent, i) => {
                                expanded[i] = !!val.trim();
                              });
                              setExpandedCliFlags(expanded);
                            }
                          }}
                          placeholder="e.g. --dangerously-skip-permissions"
                          className="playbook-default-model-input"
                          style={{ fontFamily: "var(--font-mono)" }}
                        />
                      </div>

                      {/* Agent list */}
                      <div className="playbook-agent-list">
                        {selectedPlaybook.agents.map((agent, i) => {
                          const currentProvider = agentProviderOverrides[i] || agent.provider || "claude-code";
                          const hints = PROVIDER_MODEL_HINTS[currentProvider] || [];
                          const hasCliFlags = !!(agentCliArgsOverrides[i]?.trim());
                          const showCliFlags = expandedCliFlags[i] || hasCliFlags;
                          return (
                            <div
                              key={i}
                              className={`playbook-agent-row ${i % 2 === 1 ? "playbook-agent-row-alt" : ""}`}
                            >
                              {/* Line 1: Name + role badge + provider + model */}
                              <div className="playbook-agent-main">
                                <span className="playbook-agent-name">{agent.name}</span>
                                <span className={`playbook-agent-role badge ${agent.role === "master" ? "badge-yellow" : "badge-blue"}`}>
                                  {agent.role}
                                </span>
                                <select
                                  className="playbook-agent-provider"
                                  value={currentProvider}
                                  onChange={(e) => {
                                    setAgentProviderOverrides((prev) => ({
                                      ...prev,
                                      [i]: e.target.value,
                                    }));
                                  }}
                                >
                                  {KNOWN_PROVIDERS.map((p) => (
                                    <option key={p} value={p}>{p}</option>
                                  ))}
                                </select>
                                <div className="playbook-agent-model-wrapper">
                                  <input
                                    className="playbook-agent-model"
                                    value={agentModelOverrides[i] ?? agent.model ?? ""}
                                    onChange={(e) =>
                                      setAgentModelOverrides((prev) => ({
                                        ...prev,
                                        [i]: e.target.value,
                                      }))
                                    }
                                    placeholder={hints[0] || "model name"}
                                    list={`model-hints-${i}`}
                                  />
                                  <datalist id={`model-hints-${i}`}>
                                    {hints.map((h) => (
                                      <option key={h} value={h} />
                                    ))}
                                  </datalist>
                                </div>
                                {!showCliFlags && (
                                  <button
                                    type="button"
                                    className="playbook-agent-flags-toggle"
                                    title="Add CLI flags"
                                    onClick={() => setExpandedCliFlags(prev => ({ ...prev, [i]: true }))}
                                  >
                                    +flags
                                  </button>
                                )}
                              </div>
                              {/* Line 2: CLI flags (shown if expanded or has content) */}
                              {showCliFlags && (
                                <div className="playbook-agent-cli-row">
                                  <input
                                    className="playbook-agent-cli-input"
                                    value={agentCliArgsOverrides[i] ?? ""}
                                    onChange={(e) =>
                                      setAgentCliArgsOverrides((prev) => ({
                                        ...prev,
                                        [i]: e.target.value,
                                      }))
                                    }
                                    placeholder="CLI flags (e.g. --verbose --max-tokens 4096)"
                                  />
                                </div>
                              )}
                            </div>
                          );
                        })}
                      </div>
                    </div>
                  )}
                </div>

                {/* Fixed footer */}
                <div className="playbook-launch-footer">
                  <button onClick={() => {
                    setSelectedPlaybook(null);
                    setPlaybookVariables({});
                  }}>
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
              </div>
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
            activeAgentCount: stopConfirmSession.activeAgentCount ?? stopConfirmSession.agentCount ?? 0,
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

      {/* Playbook Upload Modal */}
      <PlaybookUploadModal
        opened={showUploadModal}
        onClose={() => setShowUploadModal(false)}
        onSuccess={() => {
          setShowUploadModal(false);
          loadPlaybooks();
        }}
      />

      {/* Persona Library — global, browse-only from All Sessions */}
      <PersonaLibrary
        opened={showPersonaLibrary}
        onClose={() => setShowPersonaLibrary(false)}
        onSelect={() => setShowPersonaLibrary(false)}
        browseOnly
      />
    </div>
  );
}
