import { useEffect, useState, useCallback, useRef, useMemo } from "react";
import { useParams, useNavigate, Link } from "react-router-dom";
import { useApi } from "../hooks/useApi";
import { useWebSocket } from "../hooks/useWebSocket";
import { SpawnAgentDialog } from "../components/SpawnAgentDialog";
import { ReplaceAgentDialog } from "../components/ReplaceAgentDialog";
import { SessionSettingsDialog } from "../components/SessionSettingsDialog";
import { StopSessionDialog } from "../components/StopSessionDialog";
import { RestartAllDialog } from "../components/RestartAllDialog";
import { PlaybookGrid, PlaybookUploadModal } from "../components/playbook";
import { PersonaLibrary } from "../components/PersonaLibrary";
import type { AgentActivity } from "../components/AgentCardTerminal";
import { AgentActivityBadge, AgentUtilization, ActivitySparkline } from "../components/AgentActivityBadge";
import { TaskBoard } from "../components/TaskBoard";
import { SessionSummary } from "../components/SessionSummary";
import { KnowledgeViewer } from "../components/KnowledgeViewer";
import { TimelineView } from "../components/timeline/TimelineView";
import { ExecutionTracing } from "../components/ExecutionTracing";
import { SideTerminalPanel } from "../components/SideTerminalPanel";
import { EditorTile } from "../components/EditorTile";
import { GitChanges } from "../components/GitChanges";
import type { TerminalTab } from "../components/SideTerminalPanel";
import { FlagIndicator, ChannelIndicator } from "../components/FlagIndicator";
import { MobileLogViewer } from "../components/MobileLogViewer";
import { useMessageBufferEvents, MessageBufferBadge } from "../components/MessageBufferIndicator";
import { SessionCostSummary, extractCostData, formatCostSmart, hasCostData } from "../components/CostSummary";
import { SessionReport } from "../components/SessionReport";
import { useApprovalRequests, type ApprovalRequest } from "../hooks/useApprovalRequests";
import { ApprovalPrompt } from "../components/ApprovalPrompt";
import { useTerminalSessionStore } from "../stores/terminalSessionStore";
import { hasTerminal } from "../stores/terminalRegistry";
import { formatCost, formatTokens, formatUptime, formatLastSeen } from "../utils/formatters";
import { showSuccess, showError } from "../utils/notifications";
import { ConfirmDialog } from "../components/ConfirmDialog";
import {
  ActionIcon,
  Indicator,
  Tooltip,
  Modal,
  Button,
  Menu,
  Stack,
  Group,
  Text,
  Paper,
  Badge,
  TextInput,
  Textarea,
  Loader,
  Code,
  CopyButton,
} from "@mantine/core";
import { useMediaQuery } from "@mantine/hooks";

type TabId = "editor" | "agents" | "tasks" | "execution" | "timeline" | "changes" | "knowledge";

function getInitialTab(): TabId {
  const hash = window.location.hash.replace("#", "");
  if (["agents", "tasks", "execution", "timeline", "changes", "knowledge"].includes(hash)) return hash as TabId;
  return "editor";
}

const activityLabels: Record<AgentActivity, string> = {
  working: "Working...",
  idle: "Idle \u2014 waiting for input",
  reading: "Reading files...",
  writing: "Writing files...",
  "running-command": "Running command...",
  crashed: "Crashed",
  stopped: "Stopped",
};

const activityDotClass: Record<AgentActivity, string> = {
  working: "activity-working",
  idle: "activity-idle",
  reading: "activity-reading",
  writing: "activity-writing",
  "running-command": "activity-running",
  crashed: "activity-crashed",
  stopped: "activity-stopped",
};

export function SessionDetail() {
  const { sessionId } = useParams<{ sessionId: string }>();
  const navigate = useNavigate();
  const api = useApi();
  const isMobile = useMediaQuery("(max-width: 640px)");
  const isTablet = useMediaQuery("(max-width: 1024px)");

  // Listen for message buffer/expiry WebSocket events
  useMessageBufferEvents();

  // Approval requests for autonomy enforcement
  const { requests: approvalRequests, approve, reject, getPendingForAgent } = useApprovalRequests(sessionId);

  const [session, setSession] = useState<any>(null);
  const [agents, setAgents] = useState<any[]>([]);
  const [events, setEvents] = useState<any[]>([]);
  const [loading, setLoading] = useState(true);
  const [activeTab, setActiveTab] = useState<TabId>(getInitialTab);
  const [showSpawnDialog, setShowSpawnDialog] = useState(false);
  // Playbook launcher state — at page level so dialog works from any tab
  const [showPlaybookDialog, setShowPlaybookDialog] = useState(false);
  const [playbookNames, setPlaybookNames] = useState<string[]>([]);
  const [playbookDetails, setPlaybookDetails] = useState<Record<string, any>>({});
  const [selectedPlaybookName, setSelectedPlaybookName] = useState<string | null>(null);
  const [playbookTask, setPlaybookTask] = useState("");
  const [launchingPlaybook, setLaunchingPlaybook] = useState(false);
  const [loadingPlaybooks, setLoadingPlaybooks] = useState(false);
  const [playbookError, setPlaybookError] = useState<string | null>(null);
  const [showPlaybookUpload, setShowPlaybookUpload] = useState(false);
  // Per-agent overrides for playbook launch
  const [agentModelOverrides, setAgentModelOverrides] = useState<Record<number, string>>({});
  const [agentProviderOverrides, setAgentProviderOverrides] = useState<Record<number, string>>({});
  const [agentCliArgsOverrides, setAgentCliArgsOverrides] = useState<Record<number, string>>({});
  const [agentPersonaOverrides, setAgentPersonaOverrides] = useState<Record<number, string>>({});
  const [defaultModelForAll, setDefaultModelForAll] = useState("");
  const [defaultCliFlagsForAll, setDefaultCliFlagsForAll] = useState("");
  const [personaEditIndex, setPersonaEditIndex] = useState<number | null>(null);
  const [personaLibraryForIndex, setPersonaLibraryForIndex] = useState<number | null>(null);
  const [replaceAgentId, setReplaceAgentId] = useState<string | null>(null);
  const [showSettingsDialog, setShowSettingsDialog] = useState(false);
  const [sendingTo, setSendingTo] = useState<string | null>(null);
  const [quickMessage, setQuickMessage] = useState("");
  const [editorFullscreen, setEditorFullscreen] = useState(false);
  const [sendingMsg, setSendingMsg] = useState(false);
  const [terminalHeight, setTerminalHeight] = useState(300);
  const [showBroadcastModal, setShowBroadcastModal] = useState(false);
  const [broadcastMessage, setBroadcastMessage] = useState("");
  const [sendingBroadcast, setSendingBroadcast] = useState(false);
  const [pendingTaskId, setPendingTaskId] = useState<string | null>(null);
  const [showReport, setShowReport] = useState(false);
  const [confirmRemoveAgentId, setConfirmRemoveAgentId] = useState<string | null>(null);
  const [confirmCloseTerminal, setConfirmCloseTerminal] = useState<{ id: string; name: string } | null>(null);

  // Use terminal session store for tabs
  const terminalSessionsMap = useTerminalSessionStore((state) => state.sessions);
  const terminalSessions = useMemo(() => Array.from(terminalSessionsMap.values()), [terminalSessionsMap]);
  const openTabIds = useTerminalSessionStore((state) => state.openTabs);
  const openTab = useTerminalSessionStore((state) => state.openTab);
  const closeTab = useTerminalSessionStore((state) => state.closeTab);
  const addSession = useTerminalSessionStore((state) => state.addSession);

  // Build terminal tabs from open tabs
  const terminalTabs: TerminalTab[] = openTabIds
    .map((id) => {
      const session = terminalSessions.find((s) => s.id === id);
      if (!session) return null;
      return {
        id: session.id,
        name: session.name,
        type: session.type === "standalone" ? "terminal" : "agent",
      } as TerminalTab;
    })
    .filter((t): t is TerminalTab => t !== null);

  // Optimistic terminal creation — show tab immediately, create session async
  const createTerminalOptimistic = useCallback(() => {
    const pendingId = `term-pending-${Date.now()}`;
    const terminalName = `Terminal ${terminalSessions.filter((t) => t.type === "standalone").length + 1}`;

    // Show tab immediately with pending ID
    addSession({
      id: pendingId,
      name: terminalName,
      type: "standalone",
      createdAt: new Date().toISOString(),
    });
    openTab(pendingId);

    // Create session in background
    api.openTerminal(sessionId!).then((result) => {
      // Replace pending entry with real one
      useTerminalSessionStore.getState().removeSession(pendingId);
      useTerminalSessionStore.getState().closeTab(pendingId);
      addSession({
        id: result.id,
        tmuxSession: result.tmuxSession,
        name: terminalName,
        type: "standalone",
        createdAt: new Date().toISOString(),
      });
      openTab(result.id);
    }).catch(() => {
      // Remove pending tab on failure
      useTerminalSessionStore.getState().removeSession(pendingId);
    });
  }, [sessionId, terminalSessions, addSession, openTab, api]);

  const [showStopConfirm, setShowStopConfirm] = useState(false);
  const [stoppingSession, setStoppingSession] = useState(false);
  const [stopSuccess, setStopSuccess] = useState(false);
  const [showRestartAll, setShowRestartAll] = useState(false);
  const [restartingAll, setRestartingAll] = useState(false);
  const [restartAllResult, setRestartAllResult] = useState<{ restarted: number } | null>(null);
  const [restartAllError, setRestartAllError] = useState<string | null>(null);
  const pollRef = useRef<ReturnType<typeof setInterval> | null>(null);

  // Escape key exits editor focus mode
  useEffect(() => {
    if (!editorFullscreen) return;
    const handleKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setEditorFullscreen(false);
    };
    window.addEventListener("keydown", handleKey);
    return () => window.removeEventListener("keydown", handleKey);
  }, [editorFullscreen]);

  // Clear pendingTaskId after switching to tasks tab
  useEffect(() => {
    if (activeTab === "tasks" && pendingTaskId) {
      // Clear after a short delay to ensure TaskBoard has mounted
      const timer = setTimeout(() => setPendingTaskId(null), 100);
      return () => clearTimeout(timer);
    }
  }, [activeTab, pendingTaskId]);

  const loadData = useCallback(async () => {
    if (!sessionId) return;
    try {
      const [s, a, e] = await Promise.all([
        api.getSession(sessionId),
        api.getAgents(sessionId),
        api.getEvents(sessionId, { limit: 50 }),
      ]);
      setSession(s);
      setAgents(a.agents || []);
      setEvents(e.events || []);
    } catch (err: unknown) {
      console.error("Failed to load session data:", err);
    } finally {
      setLoading(false);
    }
  }, [sessionId]);

  // Initial load
  useEffect(() => {
    if (!sessionId) return;
    setLoading(true);
    loadData();
  }, [sessionId, loadData]);

  // WebSocket push — instant refresh on server events
  const handleWsEvent = useCallback((event: any) => {
    if (!sessionId) return;
    const eid = event.sessionId || event.data?.sessionId;
    if (eid && eid !== sessionId) return; // ignore events from other sessions

    if (event.event === "agent-spawned" || event.event === "agent-removed" ||
        event.event === "task-created" || event.event === "task-updated" ||
        event.event === "task-deleted" || event.event === "session-stopped" ||
        event.type === "agent-spawned" || event.type === "agent-crashed" ||
        event.type === "message-sent") {
      loadData();
    }
  }, [sessionId, loadData]);

  const { subscribe, unsubscribe } = useWebSocket(handleWsEvent);

  // Subscribe to this session's events
  useEffect(() => {
    if (!sessionId) return;
    subscribe(sessionId);
    return () => {
      unsubscribe(sessionId);
    };
  }, [sessionId, subscribe, unsubscribe]);

  // Polling as fallback — slower since WebSocket handles instant updates
  useEffect(() => {
    if (!sessionId) return;
    pollRef.current = setInterval(loadData, 10000); // 10s instead of 3s
    return () => {
      if (pollRef.current) clearInterval(pollRef.current);
    };
  }, [sessionId, loadData]);

  // Persist tab to URL hash
  useEffect(() => {
    window.location.hash = activeTab;
  }, [activeTab]);

  async function handleRemoveAgent(agentId: string) {
    setConfirmRemoveAgentId(agentId);
  }

  async function executeRemoveAgent() {
    if (!confirmRemoveAgentId) return;
    try {
      await api.removeAgent(sessionId!, confirmRemoveAgentId);
      setConfirmRemoveAgentId(null);
      loadData();
    } catch (err: any) {
      showError(err.message, "Failed to remove agent");
    }
  }

  async function handleQuickSend(agentId: string) {
    if (!quickMessage.trim() || sendingMsg) return;
    setSendingMsg(true);
    try {
      await api.sendMessage(sessionId!, agentId, quickMessage);
      setQuickMessage("");
      setSendingTo(null);
    } catch (err: any) {
      showError(err.message, "Failed to send message");
    } finally {
      setSendingMsg(false);
    }
  }

  async function handleRestartAgent(agentId: string) {
    try {
      await api.restartAgent(sessionId!, agentId);
      loadData();
    } catch (err: any) {
      showError(err.message, "Failed to restart agent");
    }
  }

  async function handleBroadcastMessage() {
    if (!broadcastMessage.trim() || sendingBroadcast) return;
    setSendingBroadcast(true);
    try {
      await api.broadcastMessage(sessionId!, broadcastMessage);
      setShowBroadcastModal(false);
      setBroadcastMessage("");
      showSuccess(`Broadcast sent to ${agents.length} agent${agents.length !== 1 ? "s" : ""}!`);
    } catch (err: any) {
      showError(err.message, "Failed to broadcast message");
    } finally {
      setSendingBroadcast(false);
    }
  }

  async function handleRestartAllAgents() {
    setRestartingAll(true);
    setRestartAllResult(null);
    setRestartAllError(null);
    try {
      const result = await api.restartAllAgents(sessionId!);
      setRestartAllResult(result);
      loadData();
    } catch (err: any) {
      setRestartAllError(err.message || "Unknown error");
    } finally {
      setRestartingAll(false);
    }
  }

  async function handlePauseSession() {
    try {
      await api.pauseSession(sessionId!);
      loadData();
    } catch (err: any) {
      showError(err.message, "Failed to pause session");
    }
  }

  async function handleStopSession() {
    setStoppingSession(true);
    try {
      await api.stopSession(sessionId!);
      setStopSuccess(true);
      setTimeout(() => navigate("/"), 1500);
    } catch (err: any) {
      setStoppingSession(false);
      showError(err.message, "Failed to stop session");
    }
  }

  const openPlaybookDialog = useCallback(async () => {
    setShowPlaybookDialog(true);
    setLoadingPlaybooks(true);
    setPlaybookError(null);
    try {
      const data = await api.getPlaybooks();
      const names = data.playbooks || [];
      setPlaybookNames(names);
      const details: Record<string, any> = {};
      for (const name of names) {
        try {
          details[name] = await api.getPlaybook(name);
        } catch {
          // Individual playbook detail fetch failed — skip silently, list still shows
        }
      }
      setPlaybookDetails(details);
    } catch (err: any) {
      console.error("Failed to load playbooks:", err);
      setPlaybookError(err?.message || "Failed to load playbooks. Check daemon connection.");
    } finally {
      setLoadingPlaybooks(false);
    }
  }, [api]);

  async function handleLaunchPlaybook() {
    if (!selectedPlaybookName) return;
    setLaunchingPlaybook(true);
    try {
      const pb = playbookDetails[selectedPlaybookName];
      const hasOverrides = Object.keys(agentProviderOverrides).length > 0 ||
        Object.keys(agentModelOverrides).length > 0 ||
        Object.keys(agentCliArgsOverrides).length > 0;

      if (!hasOverrides) {
        // No overrides — use server-side playbook launch (faster, single request)
        try {
          await api.launchPlaybook(sessionId!, selectedPlaybookName, playbookTask || undefined);
        } catch {
          // Fallback: spawn agents individually
          if (pb?.agents) {
            for (const agent of pb.agents) {
              await api.spawnAgent(sessionId!, {
                name: agent.name,
                role: agent.role || "worker",
                provider: agent.provider || "claude-code",
                model: agent.model,
                persona: agent.persona,
                initialTask: playbookTask || agent.initialTask,
                channels: agent.channels,
                extraCliArgs: agent.extraCliArgs,
              });
            }
          }
        }
      } else {
        // Has overrides — spawn agents individually with per-agent config
        if (pb?.agents) {
          for (let i = 0; i < pb.agents.length; i++) {
            const agent = pb.agents[i];
            const cliArgsStr = agentCliArgsOverrides[i]?.trim();
            await api.spawnAgent(sessionId!, {
              name: agent.name,
              role: agent.role || "worker",
              provider: agentProviderOverrides[i] || agent.provider || "claude-code",
              model: agentModelOverrides[i] || agent.model,
              persona: agentPersonaOverrides[i] || agent.persona,
              initialTask: playbookTask || agent.initialTask,
              channels: agent.channels,
              extraCliArgs: cliArgsStr ? cliArgsStr.split(/\s+/) : agent.extraCliArgs,
            });
          }
        }
      }
      setShowPlaybookDialog(false);
      setSelectedPlaybookName(null);
      setPlaybookTask("");
      setPlaybookError(null);
      setAgentModelOverrides({});
      setAgentProviderOverrides({});
      setAgentCliArgsOverrides({}); setAgentPersonaOverrides({}); setPersonaEditIndex(null); setPersonaLibraryForIndex(null);
      setDefaultModelForAll("");
      setDefaultCliFlagsForAll("");
      loadData();
    } catch (err: any) {
      console.error("Failed to launch playbook:", err);
      setPlaybookError(err?.message || "Failed to launch playbook. Please try again.");
    } finally {
      setLaunchingPlaybook(false);
    }
  }

  function getStatusBadge(status: string): string {
    const map: Record<string, string> = {
      running: "badge-green",
      active: "badge-green",
      idle: "badge-blue",
      paused: "badge-yellow",
      stopped: "badge-red",
      error: "badge-red",
    };
    return map[status] || "badge-blue";
  }

  function getStatusDotClass(status: string): string {
    const map: Record<string, string> = {
      running: "running",
      idle: "idle",
      waiting: "waiting",
      paused: "paused",
      stopped: "stopped",
      error: "error",
      crashed: "crashed",
    };
    return map[status] || "waiting";
  }

  function getRoleBadgeClass(role: string): string {
    return role === "master" ? "badge-purple" : "badge-blue";
  }

  function getRoleCardClass(role: string): string {
    return role === "master" ? "role-master" : "role-worker";
  }

  // Computed stats
  const totalCost = agents.reduce(
    (sum, a) => sum + extractCostData(a).costUsd,
    0
  );
  const _hasCostData = hasCostData(agents);

  if (loading) {
    return (
      <div className="page">
        <p style={{ color: "var(--text-secondary)" }}>Loading session...</p>
      </div>
    );
  }

  return (
    <div className="page">
      {/* Breadcrumb */}
      <nav className="breadcrumb">
        <Link to="/">All Sessions</Link>
        <span className="separator">/</span>
        <span style={{ color: "var(--text-primary)" }}>
          {session?.name || "Session"}
        </span>
      </nav>

      {/* Header */}
      <div className="session-header">
        <div className="session-header-left">
          <h1>
            {session?.name || "Session"}
            <span className={`badge ${getStatusBadge(session?.status)}`}>
              {session?.status || "unknown"}
            </span>
          </h1>
          {session?.projectPath && (
            <div className="session-meta">{session.projectPath}</div>
          )}
          <div className="session-stats">
            <span className="stat-item">
              {agents.length} agent{agents.length !== 1 ? "s" : ""}
            </span>
            <span className="stat-divider" />
            <span className="stat-item">{_hasCostData ? `$${totalCost.toFixed(2)} cost` : "No cost data"}</span>
            <span className="stat-divider" />
            <span className="stat-item">
              {events.length} event{events.length !== 1 ? "s" : ""}
            </span>
          </div>
        </div>
        <div className="session-header-actions">
          {/* Primary actions — always visible */}
          <Button
            size={isMobile ? "xs" : "sm"}
            color="red" fw={600}
            leftSection={!isMobile ? "\uD83C\uDFAE" : undefined}
            onClick={() => navigate(`/session/${sessionId}/overview`)}
          >
            {isMobile ? "\uD83C\uDFAE" : "Command Center"}
          </Button>
          <Button
            size={isMobile ? "xs" : "sm"}
            color="blue"
            leftSection={!isMobile ? "\u2795" : undefined}
            onClick={() => setShowSpawnDialog(true)}
          >
            {isMobile ? "\u2795" : isTablet ? "Agent" : "Add Agent"}
          </Button>
          {!isMobile && (
            <Button
              size="sm" variant="default"
              leftSection={"\uD83D\uDE80"}
              onClick={openPlaybookDialog}
              styles={{ root: { backgroundColor: "var(--bg-tertiary)", borderColor: "var(--border-color)", color: "var(--text-primary)" } }}
            >
              {isTablet ? "Playbook" : "Launch Playbook"}
            </Button>
          )}

          {/* More menu — secondary + danger actions */}
          <Menu position="bottom-end" width={220} shadow="lg" styles={{
            dropdown: { backgroundColor: "var(--bg-secondary)", borderColor: "var(--border-color)" },
            item: { color: "var(--text-primary)", fontSize: 13 },
            label: { color: "var(--text-muted)", fontSize: 11 },
          }}>
            <Menu.Target>
              <Button size={isMobile ? "xs" : "sm"} variant="default"
                styles={{ root: { backgroundColor: "var(--bg-tertiary)", borderColor: "var(--border-color)", color: "var(--text-secondary)" } }}>
                {isMobile ? "\u22EF" : "\u22EF More"}
              </Button>
            </Menu.Target>
            <Menu.Dropdown>
              {isMobile && (
                <>
                  <Menu.Item leftSection={"\uD83D\uDE80"} onClick={openPlaybookDialog}>Launch Playbook</Menu.Item>
                  <Menu.Divider />
                </>
              )}
              <Menu.Label>Tools</Menu.Label>
              <Menu.Item leftSection={"\uD83D\uDCBB"} onClick={async () => { try { await api.openVscodeSession(sessionId!); } catch (err: any) { showError(err.message, "Failed to open VS Code"); } }}>
                Open in VS Code
              </Menu.Item>
              <Menu.Item leftSection={"\uD83D\uDDA5"} onClick={createTerminalOptimistic}>Terminal</Menu.Item>
              <Menu.Item leftSection={"\u2699"} onClick={() => setShowSettingsDialog(true)}>Settings</Menu.Item>
              <Menu.Item leftSection={"\uD83D\uDCCA"} onClick={() => setShowReport(true)}>Report</Menu.Item>

              <Menu.Divider />
              <Menu.Label>Session Control</Menu.Label>
              <Menu.Item leftSection={"\u23F8"} onClick={handlePauseSession}>Pause Session</Menu.Item>
              <Menu.Item leftSection={"\uD83D\uDD04"} color="yellow"
                disabled={agents.filter(a => a.status === "running").length === 0}
                onClick={() => { setShowRestartAll(true); setRestartAllResult(null); setRestartAllError(null); }}>
                Restart All
              </Menu.Item>

              <Menu.Divider />
              <Menu.Item leftSection={"\u23F9"} color="red" onClick={() => setShowStopConfirm(true)}>
                Stop Session
              </Menu.Item>
            </Menu.Dropdown>
          </Menu>
        </div>
      </div>

      {/* Tab bar */}
      <div className="tab-bar">
        <button
          className={activeTab === "editor" ? "tab-active" : ""}
          onClick={() => setActiveTab("editor")}
        >
          Editor
        </button>
        <button
          className={activeTab === "changes" ? "tab-active" : ""}
          onClick={() => setActiveTab("changes")}
        >
          Changes
        </button>
        <button
          className={activeTab === "agents" ? "tab-active" : ""}
          onClick={() => setActiveTab("agents")}
        >
          Agents
          <span className="tab-count">{agents.length}</span>
        </button>
        <button
          className={activeTab === "tasks" ? "tab-active" : ""}
          onClick={() => setActiveTab("tasks")}
        >
          Tasks
        </button>
        <button
          className={activeTab === "execution" ? "tab-active" : ""}
          onClick={() => setActiveTab("execution")}
        >
          Execution
        </button>
        <button
          className={activeTab === "timeline" ? "tab-active" : ""}
          onClick={() => setActiveTab("timeline")}
        >
          Timeline
          <span className="tab-count">{events.length}</span>
        </button>
        <button
          className={activeTab === "knowledge" ? "tab-active" : ""}
          onClick={() => setActiveTab("knowledge")}
        >
          Knowledge
        </button>
      </div>

      {/* Tab content */}
      {activeTab === "editor" && (
        editorFullscreen ? (
          <div style={{
            position: "fixed", top: 0, left: 0, right: 0,
            bottom: terminalTabs.length > 0 ? terminalHeight + 40 : 0,
            zIndex: 40, background: "var(--bg-primary)",
            display: "flex", flexDirection: "column",
          }}>
            <div style={{
              display: "flex", alignItems: "center", gap: 8, padding: "4px 12px",
              background: "var(--bg-secondary)", borderBottom: "1px solid var(--border-color)", flexShrink: 0,
            }}>
              <span style={{ fontWeight: 600, fontSize: 13, color: "var(--text-primary)" }}>
                Editor — {session?.name || sessionId}
              </span>

              {/* Divider */}
              <div style={{ width: 1, height: 20, background: "var(--border-color)", margin: "0 4px" }} />

              {/* Agents dropdown — open agent terminals in debug panel */}
              <div style={{ position: "relative" }}>
                <select
                  onChange={(e) => {
                    const agentId = e.target.value;
                    if (!agentId) return;
                    const agent = agents.find(a => a.id === agentId);
                    if (agent) {
                      // Add agent session if not already there
                      if (!terminalSessions.find((s) => s.id === agentId)) {
                        addSession({
                          id: agentId,
                          tmuxSession: agent.config?.tmuxSession || "",
                          name: agent.config?.name || agentId,
                          type: "agent",
                          agentName: agent.config?.name || agentId,
                          createdAt: agent.startedAt || new Date().toISOString(),
                        });
                      }
                      // Open tab
                      openTab(agentId);
                    }
                    e.target.value = "";
                  }}
                  style={{
                    background: "var(--bg-tertiary)", border: "1px solid var(--border-color)", color: "var(--text-secondary)",
                    padding: "3px 8px", borderRadius: 4, cursor: "pointer", fontSize: 11,
                  }}
                >
                  <option value="">Agents ▾</option>
                  {agents.filter(a => a.status === "running").map(a => (
                    <option key={a.id} value={a.id}>
                      {a.config?.name || a.id}
                    </option>
                  ))}
                </select>
              </div>

              {/* New terminal */}
              <button
                onClick={createTerminalOptimistic}
                style={{
                  background: "var(--bg-tertiary)", border: "1px solid var(--border-color)", color: "var(--text-secondary)",
                  padding: "3px 10px", borderRadius: 4, cursor: "pointer", fontSize: 11,
                }}
              >
                + Terminal
              </button>

              {/* VS Code */}
              <button
                onClick={async () => {
                  try { await api.openVscodeSession(sessionId!); } catch {}
                }}
                style={{
                  background: "var(--bg-tertiary)", border: "1px solid var(--border-color)", color: "var(--text-secondary)",
                  padding: "3px 10px", borderRadius: 4, cursor: "pointer", fontSize: 11,
                }}
              >
                VS Code
              </button>

              <div style={{ flex: 1 }} />

              {/* Exit */}
              <button
                onClick={() => setEditorFullscreen(false)}
                style={{
                  background: "var(--bg-tertiary)", border: "1px solid var(--border-color)", color: "var(--text-primary)",
                  padding: "4px 12px", borderRadius: 6, cursor: "pointer", fontSize: 12,
                }}
              >
                Exit Focus Mode
              </button>
            </div>
            <div style={{ flex: 1, minHeight: 0 }}>
              <EditorTile sessionId={sessionId!} />
            </div>
          </div>
        ) : (
          <div style={{ position: "relative" }}>
            <button
              onClick={() => setEditorFullscreen(true)}
              style={{
                position: "absolute", top: 4, right: 4, zIndex: 10,
                background: "var(--bg-tertiary)", border: "1px solid var(--border-color)", color: "var(--text-secondary)",
                padding: "4px 10px", borderRadius: 6, cursor: "pointer", fontSize: 11,
              }}
              title="Focus Mode (hide header, expand editor)"
            >
              ⛶ Focus
            </button>
            <div style={{ height: "calc(100vh - 350px)", minHeight: 400 }}>
              <EditorTile sessionId={sessionId!} />
            </div>
          </div>
        )
      )}

      {activeTab === "agents" && (
        <AgentsTab
          agents={agents}
          sessionId={sessionId!}
          sendingTo={sendingTo}
          quickMessage={quickMessage}
          sendingMsg={sendingMsg}
          onNavigate={navigate}
          onSendingToChange={(id) => {
            setSendingTo(id);
            setQuickMessage("");
          }}
          onQuickMessageChange={setQuickMessage}
          onQuickSend={handleQuickSend}
          onRemoveAgent={handleRemoveAgent}
          onReplaceAgent={(id: string) => setReplaceAgentId(id)}
          onShowSpawnDialog={() => setShowSpawnDialog(true)}
          onRestartAgent={handleRestartAgent}
          onOpenTerminal={(agentId: string, agentName: string) => {
            // Add agent session to store if not already there
            if (!terminalSessions.find((s) => s.id === agentId)) {
              addSession({
                id: agentId,
                tmuxSession: agents.find((a) => a.id === agentId)?.config?.tmuxSession || "",
                name: agentName,
                type: "agent",
                agentName,
                createdAt: agents.find((a) => a.id === agentId)?.startedAt || new Date().toISOString(),
              });
            }

            // Open tab (will add if not already open)
            openTab(agentId);
          }}
          getStatusDotClass={getStatusDotClass}
          getRoleBadgeClass={getRoleBadgeClass}
          getRoleCardClass={getRoleCardClass}
          openPlaybookDialog={openPlaybookDialog}
          getPendingForAgent={getPendingForAgent}
          approve={approve}
          reject={reject}
          onBroadcast={() => setShowBroadcastModal(true)}
          onCloseTerminal={(id, name) => setConfirmCloseTerminal({ id, name })}
        />
      )}

      {activeTab === "tasks" && sessionId && (
        <TaskBoard
          sessionId={sessionId}
          initialTaskId={pendingTaskId || undefined}
        />
      )}

      {activeTab === "execution" && sessionId && (
        <ExecutionTracing sessionId={sessionId} />
      )}

      {activeTab === "changes" && sessionId && (
        <div style={{ height: "calc(100vh - 350px)", minHeight: 400 }}>
          <GitChanges sessionId={sessionId} />
        </div>
      )}

      {activeTab === "timeline" && sessionId && (
        <TimelineView
          sessionId={sessionId}
          agents={agents}
          onJumpToTerminal={(agentId) => {
            // Open terminal for agent
            const agent = agents.find((a) => a.id === agentId);
            if (agent) {
              if (!terminalSessions.find((s) => s.id === agentId)) {
                addSession({
                  id: agentId,
                  tmuxSession: agent.config?.tmuxSession || "",
                  name: agent.config?.name || agentId,
                  type: "agent",
                  agentName: agent.config?.name || agentId,
                  createdAt: agent.startedAt || new Date().toISOString(),
                });
              }
              openTab(agentId);
            }
          }}
          onJumpToTaskBoard={(taskId) => {
            if (taskId) setPendingTaskId(taskId);
            setActiveTab("tasks");
          }}
          onRestartAgent={handleRestartAgent}
        />
      )}

      {activeTab === "knowledge" && sessionId && (
        <KnowledgeViewer sessionId={sessionId} />
      )}

      {/* Close Terminal Confirm Dialog */}
      <ConfirmDialog
        opened={!!confirmCloseTerminal}
        onClose={() => setConfirmCloseTerminal(null)}
        onConfirm={async () => {
          if (!confirmCloseTerminal || !sessionId) return;
          try {
            await api.deleteTerminal(sessionId, confirmCloseTerminal.id);
            useTerminalSessionStore.getState().removeSession(confirmCloseTerminal.id);
          } catch (err: any) {
            showError(err.message, "Failed to close terminal");
          }
          setConfirmCloseTerminal(null);
        }}
        title="Close Terminal"
        message={`Close terminal "${confirmCloseTerminal?.name || "terminal"}"?`}
        confirmLabel="Close"
        confirmColor="red"
      />

      {/* Remove Agent Confirm Dialog */}
      <ConfirmDialog
        opened={!!confirmRemoveAgentId}
        onClose={() => setConfirmRemoveAgentId(null)}
        onConfirm={executeRemoveAgent}
        title="Remove Agent"
        message={`Remove agent "${agents.find(a => a.id === confirmRemoveAgentId)?.config?.name || confirmRemoveAgentId}"? This will stop the agent and clean up its resources.`}
        confirmLabel="Remove"
        confirmColor="red"
      />

      {/* Spawn Agent Dialog */}
      {showSpawnDialog && sessionId && (
        <SpawnAgentDialog
          sessionId={sessionId}
          onClose={() => setShowSpawnDialog(false)}
          onSpawned={() => {
            setShowSpawnDialog(false);
            loadData();
          }}
        />
      )}

      {/* Session Settings Dialog */}
      {showSettingsDialog && sessionId && (
        <SessionSettingsDialog
          sessionId={sessionId}
          onClose={() => setShowSettingsDialog(false)}
        />
      )}

      {/* Side Terminal Panel */}
      {terminalTabs.length > 0 && sessionId && (
        <SideTerminalPanel
          sessionId={sessionId}
          height={terminalHeight}
          onHeightChange={setTerminalHeight}
          onClose={() => {
            // Close all open tabs
            useTerminalSessionStore.getState().setOpenTabs([]);
          }}
        />
      )}

      {/* Replace Agent Dialog */}
      {replaceAgentId && sessionId && (
        <ReplaceAgentDialog
          sessionId={sessionId}
          agentId={replaceAgentId}
          agentName={
            agents.find((a) => a.id === replaceAgentId)?.name || agents.find((a) => a.id === replaceAgentId)?.config?.name || replaceAgentId
          }
          onClose={() => setReplaceAgentId(null)}
          onReplaced={() => {
            setReplaceAgentId(null);
            loadData();
          }}
        />
      )}

      {/* Restart All Dialog */}
      {showRestartAll && (
        <RestartAllDialog
          agentCount={agents.filter(a => a.status === "running").length}
          onCancel={() => {
            setShowRestartAll(false);
            setRestartingAll(false);
            setRestartAllResult(null);
            setRestartAllError(null);
          }}
          onConfirm={handleRestartAllAgents}
          restarting={restartingAll}
          result={restartAllResult}
          error={restartAllError}
        />
      )}

      {/* Stop Session Dialog */}
      {showStopConfirm && (
        <StopSessionDialog
          session={{
            id: sessionId!,
            name: session?.name || "Session",
            agentCount: agents.length,
            activeAgentCount: agents.filter(
              (a) => a.status === "running" || a.status === "active" || a.status === "idle"
            ).length,
          }}
          onCancel={() => {
            if (!stoppingSession) {
              setShowStopConfirm(false);
            }
          }}
          onConfirm={handleStopSession}
          stopping={stoppingSession}
          success={stopSuccess}
        />
      )}

      {/* Session Report Modal */}
      <SessionReport
        sessionId={sessionId!}
        sessionName={session?.name || "Session"}
        agents={agents}
        opened={showReport}
        onClose={() => setShowReport(false)}
      />

      {/* Playbook Dialog — at page level so it works from any tab */}
      <Modal
        opened={showPlaybookDialog}
        onClose={() => {
          setShowPlaybookDialog(false);
          setSelectedPlaybookName(null);
          setPlaybookTask("");
        }}
        title={selectedPlaybookName ? `Launch: ${selectedPlaybookName}` : "Launch Playbook"}
        size="lg"
        centered
        styles={{
          header: { backgroundColor: "var(--bg-secondary)", borderBottom: "1px solid var(--border-color)" },
          body: { backgroundColor: "var(--bg-secondary)" },
          content: { backgroundColor: "var(--bg-secondary)" },
          title: { color: "var(--text-primary)", fontWeight: 600, fontSize: 18 },
          close: { color: "var(--text-secondary)" },
        }}
      >
        <Stack gap="md">
          {playbookError && (
            <Paper p="sm" style={{ backgroundColor: "rgba(248,81,73,0.1)", border: "1px solid var(--accent-red)", borderRadius: 6 }}>
              <Text size="sm" c="var(--accent-red)">{playbookError}</Text>
            </Paper>
          )}
          {!selectedPlaybookName ? (
            <>
              <Group justify="space-between" align="center" mt="sm">
                <Text size="sm" c="dimmed">Select a playbook to launch into this session:</Text>
                <Button
                  size="compact-sm"
                  onClick={() => setShowPlaybookUpload(true)}
                  styles={{ root: { backgroundColor: "var(--accent-blue)", borderColor: "var(--accent-blue)" } }}
                >
                  Upload
                </Button>
              </Group>
              <div style={{ maxHeight: "calc(80vh - 200px)", overflowY: "auto", paddingRight: 4 }}>
                <PlaybookGrid
                  playbooks={playbookNames.map((name) => {
                    const pb = playbookDetails[name];
                    return {
                      name,
                      description: pb?.description,
                      agents: pb?.agents || [],
                      source: pb?.source,
                      tags: pb?.tags,
                    };
                  })}
                  selectedPlaybook={null}
                  onSelectPlaybook={(pb) => setSelectedPlaybookName(pb.name)}
                  loading={loadingPlaybooks}
                />
              </div>
              <Group justify="flex-end" mt="sm">
                <Button
                  variant="default"
                  onClick={() => {
                    setShowPlaybookDialog(false);
                    setSelectedPlaybookName(null);
                    setPlaybookTask("");
                  }}
                  styles={{ root: { backgroundColor: "var(--bg-tertiary)", borderColor: "var(--border-color)", color: "var(--text-primary)" } }}
                >
                  Cancel
                </Button>
              </Group>
            </>
          ) : (
            <>
              {/* Selected playbook — full configuration */}
              {(() => {
                const pb = playbookDetails[selectedPlaybookName];
                const pbAgents = pb?.agents || [];
                return (
                  <Stack gap="md">
                    {pb?.description && (
                      <Text size="sm" c="dimmed">{pb.description}</Text>
                    )}

                    {/* Defaults for all agents */}
                    {pbAgents.length > 0 && (
                      <Paper p="sm" withBorder style={{ backgroundColor: "var(--bg-primary)", borderColor: "var(--border-color)" }}>
                        <Text size="xs" fw={600} c="var(--text-secondary)" mb={8}>Defaults for all agents</Text>
                        <Group gap={8} grow>
                          <div>
                            <Text size="xs" c="var(--text-muted)" mb={2}>Model</Text>
                            <input
                              value={defaultModelForAll}
                              onChange={(e) => {
                                const val = e.target.value;
                                setDefaultModelForAll(val);
                                // Apply to all agents
                                const overrides: Record<number, string> = {};
                                pbAgents.forEach((_: any, i: number) => { overrides[i] = val; });
                                setAgentModelOverrides(overrides);
                              }}
                              placeholder="Set model for all agents..."
                              style={{
                                width: "100%", fontSize: 12, padding: "5px 8px", backgroundColor: "var(--bg-tertiary)",
                                border: "1px solid var(--border-color)", borderRadius: 4, color: "var(--text-primary)",
                              }}
                            />
                          </div>
                          <div>
                            <Text size="xs" c="var(--text-muted)" mb={2}>CLI Flags</Text>
                            <input
                              value={defaultCliFlagsForAll}
                              onChange={(e) => {
                                const val = e.target.value;
                                setDefaultCliFlagsForAll(val);
                                // Apply to all agents
                                const overrides: Record<number, string> = {};
                                pbAgents.forEach((_: any, i: number) => { overrides[i] = val; });
                                setAgentCliArgsOverrides(overrides);
                              }}
                              placeholder="e.g. --dangerously-skip-permissions"
                              style={{
                                width: "100%", fontSize: 12, padding: "5px 8px", backgroundColor: "var(--bg-tertiary)",
                                border: "1px solid var(--border-color)", borderRadius: 4, color: "var(--text-primary)",
                                fontFamily: "var(--font-mono)",
                              }}
                            />
                          </div>
                        </Group>
                      </Paper>
                    )}

                    {/* Per-agent configuration */}
                    {pbAgents.length > 0 && (
                      <div>
                        <Text size="sm" fw={600} c="var(--text-primary)" mb={8}>
                          Agents ({pbAgents.length})
                        </Text>
                        <Stack gap={6}>
                          {pbAgents.map((a: any, i: number) => (
                            <Paper key={i} p="xs" withBorder style={{
                              backgroundColor: "var(--bg-primary)", borderColor: "var(--border-color)",
                            }}>
                              <Group gap={8} align="center" wrap="nowrap" mb={6}>
                                <Badge variant="light" color={a.role === "master" ? "yellow" : "blue"} size="xs">
                                  {a.role || "worker"}
                                </Badge>
                                <Text size="sm" fw={600} c="var(--text-primary)" style={{ flex: 1 }}>
                                  {a.name}
                                </Text>
                              </Group>
                              <Group gap={6} grow>
                                <select
                                  value={agentProviderOverrides[i] || a.provider || "claude-code"}
                                  onChange={(e) => setAgentProviderOverrides(prev => ({ ...prev, [i]: e.target.value }))}
                                  style={{
                                    fontSize: 12, padding: "4px 8px", backgroundColor: "var(--bg-tertiary)",
                                    border: "1px solid var(--border-color)", borderRadius: 4, color: "var(--text-primary)",
                                  }}
                                >
                                  {["claude-code", "codex", "gemini-cli", "aider", "goose", "kiro"].map(p => (
                                    <option key={p} value={p}>{p}</option>
                                  ))}
                                </select>
                                <input
                                  value={agentModelOverrides[i] ?? a.model ?? ""}
                                  onChange={(e) => setAgentModelOverrides(prev => ({ ...prev, [i]: e.target.value }))}
                                  placeholder="model (default)"
                                  style={{
                                    fontSize: 12, padding: "4px 8px", backgroundColor: "var(--bg-tertiary)",
                                    border: "1px solid var(--border-color)", borderRadius: 4, color: "var(--text-primary)",
                                  }}
                                />
                                <input
                                  value={agentCliArgsOverrides[i] ?? ""}
                                  onChange={(e) => setAgentCliArgsOverrides(prev => ({ ...prev, [i]: e.target.value }))}
                                  placeholder="CLI flags"
                                  style={{
                                    fontSize: 12, padding: "4px 8px", backgroundColor: "var(--bg-tertiary)",
                                    border: "1px solid var(--border-color)", borderRadius: 4, color: "var(--text-primary)",
                                    fontFamily: "var(--font-mono)",
                                  }}
                                />
                              </Group>
                              {/* Persona row */}
                              <div style={{ marginTop: 6 }}>
                                {(() => {
                                  const currentPersona = agentPersonaOverrides[i] ?? a.persona ?? "";
                                  const isBuiltin = currentPersona.startsWith("builtin:");
                                  const preview = isBuiltin
                                    ? currentPersona.replace("builtin:", "Built-in: ")
                                    : currentPersona.length > 80
                                      ? currentPersona.slice(0, 80) + "..."
                                      : currentPersona || "(no persona)";
                                  return (
                                    <Group gap={6} align="center">
                                      <Text size="xs" c="var(--text-muted)" style={{
                                        flex: 1, overflow: "hidden", textOverflow: "ellipsis",
                                        whiteSpace: "nowrap", fontStyle: currentPersona ? "normal" : "italic",
                                      }}>
                                        {preview}
                                      </Text>
                                      <Button
                                        variant="subtle" size="compact-xs"
                                        onClick={() => setPersonaEditIndex(i)}
                                        styles={{ root: { color: "var(--accent-blue)", fontSize: 11, height: 22, padding: "0 8px" } }}
                                      >
                                        Edit
                                      </Button>
                                      <Button
                                        variant="subtle" size="compact-xs"
                                        onClick={() => setPersonaLibraryForIndex(i)}
                                        styles={{ root: { color: "var(--accent-purple)", fontSize: 11, height: 22, padding: "0 8px" } }}
                                      >
                                        Library
                                      </Button>
                                    </Group>
                                  );
                                })()}
                              </div>
                              {/* Inline persona editor */}
                              {personaEditIndex === i && (
                                <div style={{ marginTop: 6 }}>
                                  <textarea
                                    value={agentPersonaOverrides[i] ?? a.persona ?? ""}
                                    onChange={(e) => setAgentPersonaOverrides(prev => ({ ...prev, [i]: e.target.value }))}
                                    placeholder="Describe the agent's persona and instructions..."
                                    rows={4}
                                    style={{
                                      width: "100%", fontSize: 12, padding: "8px", backgroundColor: "var(--bg-tertiary)",
                                      border: "1px solid var(--border-color)", borderRadius: 6, color: "var(--text-primary)",
                                      resize: "vertical", fontFamily: "inherit", lineHeight: 1.5,
                                    }}
                                  />
                                  <Group justify="flex-end" gap={4} mt={4}>
                                    <Button size="compact-xs" variant="subtle"
                                      onClick={() => setPersonaEditIndex(null)}
                                      styles={{ root: { color: "var(--text-muted)", fontSize: 11 } }}
                                    >
                                      Close
                                    </Button>
                                  </Group>
                                </div>
                              )}
                            </Paper>
                          ))}
                        </Stack>
                      </div>
                    )}

                    <TextInput
                      label="Initial task (optional)"
                      placeholder="Describe the task for the agents..."
                      value={playbookTask}
                      onChange={(e) => setPlaybookTask(e.currentTarget.value)}
                      styles={{
                        input: { backgroundColor: "var(--bg-tertiary)", borderColor: "var(--border-color)", color: "var(--text-primary)" },
                        label: { color: "var(--text-secondary)", fontSize: 13 },
                      }}
                    />
                  </Stack>
                );
              })()}

              <Group justify="flex-end" mt="sm">
                <Button
                  variant="default"
                  onClick={() => {
                    setSelectedPlaybookName(null);
                    setAgentModelOverrides({});
                    setAgentProviderOverrides({});
                    setAgentCliArgsOverrides({}); setAgentPersonaOverrides({}); setPersonaEditIndex(null); setPersonaLibraryForIndex(null);
                    setDefaultModelForAll("");
                    setDefaultCliFlagsForAll("");
                  }}
                  styles={{ root: { backgroundColor: "var(--bg-tertiary)", borderColor: "var(--border-color)", color: "var(--text-primary)" } }}
                >
                  Back
                </Button>
                <Button
                  onClick={handleLaunchPlaybook}
                  disabled={launchingPlaybook}
                  loading={launchingPlaybook}
                  styles={{ root: { backgroundColor: "var(--accent-blue)", borderColor: "var(--accent-blue)" } }}
                >
                  {launchingPlaybook ? "Launching..." : "Launch"}
                </Button>
              </Group>
            </>
          )}
        </Stack>
      </Modal>

      {/* Playbook Upload Modal */}
      <PlaybookUploadModal
        opened={showPlaybookUpload}
        onClose={() => setShowPlaybookUpload(false)}
        onSuccess={() => {
          setShowPlaybookUpload(false);
          openPlaybookDialog(); // Reload playbooks
        }}
      />

      {/* Persona Library for playbook agent override */}
      <PersonaLibrary
        opened={personaLibraryForIndex !== null}
        onClose={() => setPersonaLibraryForIndex(null)}
        onSelect={(persona) => {
          if (personaLibraryForIndex !== null) {
            setAgentPersonaOverrides(prev => ({ ...prev, [personaLibraryForIndex]: persona.fullText }));
            setPersonaLibraryForIndex(null);
          }
        }}
      />

      {/* Broadcast Message Dialog */}
      {showBroadcastModal && (
        <Modal
          opened={showBroadcastModal}
          onClose={() => {
            if (!sendingBroadcast) {
              setShowBroadcastModal(false);
              setBroadcastMessage("");
            }
          }}
          title="Broadcast Message to All Agents"
          size="md"
          centered
          styles={{
            header: { backgroundColor: "var(--bg-secondary)", borderBottom: "1px solid var(--border-color)" },
            body: { backgroundColor: "var(--bg-secondary)" },
            content: { backgroundColor: "var(--bg-secondary)" },
            title: { color: "var(--text-primary)", fontWeight: 600, fontSize: 18 },
            close: { color: "var(--text-secondary)" },
          }}
        >
          <Stack gap="md">
            <Text size="sm" c="dimmed">
              Send a message to all {agents.length} agent{agents.length !== 1 ? "s" : ""} in this session.
            </Text>
            <Textarea
              placeholder="Type your message to all agents..."
              value={broadcastMessage}
              onChange={(e) => setBroadcastMessage(e.currentTarget.value)}
              minRows={4}
              maxRows={8}
              autoFocus
              disabled={sendingBroadcast}
              styles={{
                input: {
                  backgroundColor: "var(--bg-tertiary)",
                  borderColor: "var(--border-color)",
                  color: "var(--text-primary)",
                },
              }}
              onKeyDown={(e) => {
                if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) {
                  e.preventDefault();
                  if (broadcastMessage.trim() && !sendingBroadcast) {
                    handleBroadcastMessage();
                  }
                }
              }}
            />
            <Group justify="flex-end">
              <Button
                variant="default"
                onClick={() => {
                  setShowBroadcastModal(false);
                  setBroadcastMessage("");
                }}
                disabled={sendingBroadcast}
                styles={{
                  root: {
                    backgroundColor: "var(--bg-tertiary)",
                    borderColor: "var(--border-color)",
                    color: "var(--text-primary)",
                  },
                }}
              >
                Cancel
              </Button>
              <Button
                onClick={handleBroadcastMessage}
                disabled={!broadcastMessage.trim() || sendingBroadcast}
                loading={sendingBroadcast}
                styles={{
                  root: {
                    backgroundColor: "var(--accent-blue)",
                    borderColor: "var(--accent-blue)",
                  },
                }}
              >
                Send Broadcast
              </Button>
            </Group>
          </Stack>
        </Modal>
      )}
    </div>
  );
}

/* ------------------------------------------------------------------ */
/* Agents Tab                                                          */
/* ------------------------------------------------------------------ */

/** Reconstruct the full CLI command used to spawn an agent */
function buildCliCommand(agent: any): string {
  const provider = agent.config?.cliProvider || "claude-code";
  const model = agent.config?.model;
  const extraArgs = agent.config?.extraCliArgs || [];

  let cmd = provider === "claude-code" ? "claude" :
            provider === "aider" ? "aider" :
            provider === "codex" ? "codex" :
            provider === "kiro" ? "kiro" :
            provider === "goose" ? "goose" : provider;

  const parts = [cmd];

  if (model && model !== "default" && model !== "") {
    parts.push("--model", model);
  }

  if (agent.config?.persona) {
    parts.push("--system-prompt-file", `<persona/${agent.config.id}-prompt.md>`);
  }

  if (extraArgs.length > 0) {
    parts.push(...extraArgs);
  }

  // Show MCP config for MCP-capable providers
  if (["claude-code", "aider", "goose"].includes(provider)) {
    parts.push("--mcp-config", `<mcp/${agent.config?.id}-mcp.json>`);
    parts.push("--allowedTools", "Read", "Glob", "Grep", "LS", "mcp__kora__*");
  }

  return parts.join(" \\\n  ");
}

interface AgentsTabProps {
  agents: any[];
  sessionId: string;
  sendingTo: string | null;
  quickMessage: string;
  sendingMsg: boolean;
  onNavigate: (path: string) => void;
  onSendingToChange: (id: string | null) => void;
  onQuickMessageChange: (msg: string) => void;
  onQuickSend: (agentId: string) => void;
  onRemoveAgent: (agentId: string) => void;
  onReplaceAgent: (agentId: string) => void;
  onShowSpawnDialog: () => void;
  onRestartAgent: (agentId: string) => void;
  onOpenTerminal: (agentId: string, agentName: string) => void;
  getStatusDotClass: (status: string) => string;
  getRoleBadgeClass: (role: string) => string;
  getRoleCardClass: (role: string) => string;
  openPlaybookDialog: () => void;
  getPendingForAgent: (agentId: string) => any[];
  approve: (agentId: string, requestId: string) => Promise<void>;
  reject: (agentId: string, requestId: string) => Promise<void>;
  onBroadcast: () => void;
  onCloseTerminal: (id: string, name: string) => void;
}

function AgentsTab({
  agents,
  sessionId,
  sendingTo,
  quickMessage,
  sendingMsg,
  onNavigate,
  onSendingToChange,
  onQuickMessageChange,
  onQuickSend,
  onRemoveAgent,
  onReplaceAgent,
  onShowSpawnDialog,
  onRestartAgent,
  onOpenTerminal,
  getStatusDotClass,
  getRoleBadgeClass,
  getRoleCardClass,
  openPlaybookDialog,
  getPendingForAgent,
  approve,
  reject,
  onBroadcast,
  onCloseTerminal,
}: AgentsTabProps) {
  const api = useApi();
  const [agentActivities, setAgentActivities] = useState<Record<string, AgentActivity>>({});
  const [activityHistory, setActivityHistory] = useState<Record<string, AgentActivity[]>>({});
  const [activitySince, setActivitySince] = useState<Record<string, string>>({});
  const [gearOpen, setGearOpen] = useState<string | null>(null);
  const [personaModalAgent, setPersonaModalAgent] = useState<any | null>(null);
  const [tasks, setTasks] = useState<any[]>([]);

  // Close gear dropdown when clicking outside
  useEffect(() => {
    if (!gearOpen) return;
    const close = () => setGearOpen(null);
    setTimeout(() => document.addEventListener("click", close), 0);
    return () => document.removeEventListener("click", close);
  }, [gearOpen]);

  // Activity detection: use backend's agent.activity field (set by AgentHealthMonitor
  // with 24 idle prompt patterns, output normalization, and MCP signal integration).
  // The backend polls every 10s and detects idle in ~2s — much more reliable than
  // the frontend's old hash-based approach.
  useEffect(() => {
    const updates: Record<string, AgentActivity> = {};
    for (const a of agents) {
      // Map backend activity to frontend AgentActivity type
      let activity: AgentActivity;
      if (a.status === "crashed" || a.status === "error") {
        activity = "crashed";
      } else if (a.status === "stopped") {
        activity = "stopped";
      } else if (a.activity === "idle") {
        activity = "idle";
      } else {
        // Backend says "working" — default. We can still refine with output hints
        // from lastOutputAt for more granular UI (reading/writing/running-command)
        activity = "working";
      }
      updates[a.id] = activity;
    }

    // Always record history samples for sparkline + utilization (every poll cycle)
    setActivityHistory(prev => {
      const next = { ...prev };
      for (const [id, act] of Object.entries(updates)) {
        const hist = next[id] || [];
        next[id] = [...hist, act].slice(-30);
      }
      return next;
    });

    setAgentActivities(prev => {
      // Only update activities state if something changed
      let changed = false;
      for (const [id, act] of Object.entries(updates)) {
        if (prev[id] !== act) { changed = true; break; }
      }
      if (!changed) return prev;

      // Track when activity changed
      for (const [id, act] of Object.entries(updates)) {
        if (prev[id] !== act) {
          setActivitySince(s => ({ ...s, [id]: new Date().toISOString() }));
        }
      }
      return { ...prev, ...updates };
    });
  }, [agents]);

  // Fetch tasks for task indicators on agent cards
  useEffect(() => {
    const fetchTasks = async () => {
      try {
        const data = await api.getTasks(sessionId);
        setTasks(data.tasks || []);
      } catch (err) {
        console.debug("[agent-cards] Failed to fetch tasks:", err);
      }
    };
    fetchTasks();
    const interval = setInterval(fetchTasks, 10000); // Refresh every 10s
    return () => clearInterval(interval);
  }, [sessionId, api]);

  // Terminal session store — hooks must be above any early returns (React rules of hooks)
  const terminalSessionsMap = useTerminalSessionStore((state) => state.sessions);
  const terminalSessions = useMemo(() => Array.from(terminalSessionsMap.values()), [terminalSessionsMap]);
  const addSession = useTerminalSessionStore((state) => state.addSession);
  const removeSession = useTerminalSessionStore((state) => state.removeSession);
  const openTab = useTerminalSessionStore((state) => state.openTab);
  const closeTab = useTerminalSessionStore((state) => state.closeTab);
  const pruneStaleTerminals = useTerminalSessionStore((state) => state.pruneStale);

  // Fetch terminals from server on mount + prune stale entries
  useEffect(() => {
    async function fetchTerminals() {
      try {
        const data = await api.getTerminals(sessionId);
        const serverTerminals = data?.terminals || [];
        const serverTerminalIds = new Set(serverTerminals.map((t: any) => t.id));

        // Add server terminals to store
        serverTerminals.forEach((term: any) => {
          addSession({
            id: term.id,
            tmuxSession: term.tmuxSession,
            name: term.name || `Terminal ${term.id}`,
            type: term.type || "standalone",
            agentName: term.agentName,
            createdAt: term.createdAt || new Date().toISOString(),
          });
        });

        // Remove stale terminals not on server
        pruneStaleTerminals(serverTerminalIds);
      } catch (err) {
        console.debug("Could not fetch terminals from server:", err);
      }
    }
    fetchTerminals();
  }, [sessionId]); // Zustand actions are stable, not needed in deps

  return (
    <>
    {agents.length === 0 && (
      <div className="empty-callout">
        <h3>No agents running</h3>
        <p>
          Launch a playbook to spin up a pre-configured team, or spawn an
          individual agent.
        </p>
        <Group gap="sm" justify="center" mt="md">
          <Button
            size="md"
            onClick={openPlaybookDialog}
            styles={{ root: { backgroundColor: "var(--accent-blue)", borderColor: "var(--accent-blue)" } }}
            leftSection={<span style={{ fontSize: 16 }}>&#128640;</span>}
          >
            Launch Playbook
          </Button>
          <Button
            size="md"
            variant="default"
            onClick={onShowSpawnDialog}
            styles={{ root: { backgroundColor: "var(--bg-tertiary)", borderColor: "var(--border-color)", color: "var(--text-primary)" } }}
          >
            + Spawn Agent
          </Button>
        </Group>
      </div>
    )}

    {/* Session Cost Summary */}
    {/* Session Summary Dashboard */}
    <SessionSummary
      sessionId={sessionId}
      agents={agents}
      onNudgeAgent={async (agentId) => {
        try { await api.nudgeAgent(sessionId, agentId); } catch {}
      }}
      onBroadcast={onBroadcast}
    />

    <SessionCostSummary agents={agents} />

    <div className="agent-grid">
      {agents.map((a) => {
        const activity = agentActivities[a.id] || "working";
        const { tokensIn, tokensOut, costUsd } = extractCostData(a);
        const agentHasCost = costUsd > 0 || tokensIn > 0 || tokensOut > 0;
        const isCrashed = a.status === "crashed" || a.status === "error";
        const isStopped = a.status === "stopped";
        const stateClass = isCrashed ? "state-crashed" : isStopped ? "state-stopped" : activity === "idle" ? "state-idle" : "state-working";
        const pendingRequests = getPendingForAgent(a.id);
        const pendingCount = pendingRequests.length;

        // Calculate task counts for this agent
        const agentTasks = tasks.filter(t => t.assignedTo === a.id && t.status !== "done");
        const taskCount = agentTasks.length;
        const overdueTasks = agentTasks.filter(t => {
          if (!t.dueDate) return false;
          return new Date(t.dueDate) < new Date();
        });
        const hasOverdue = overdueTasks.length > 0;

        return (
          <div
            key={a.id}
            className={`agent-card-v2 ${stateClass}`}
          >
            {/* Header: dot + name + role + channels/flags + uptime — all one line */}
            <div className="ac2-header">
              <div className="ac2-header-left">
                <span className={`ac2-status-dot ${stateClass}`} />
                <h3 className="ac2-name">{a.config?.name || a.name || "Agent"}</h3>
                {a.role && (
                  <span className="ac2-role-badge">{a.role}</span>
                )}
                <ChannelIndicator channels={(a.config?.channels as string[]) || []} />
                <FlagIndicator flags={(a.config?.extraCliArgs as string[]) || []} />
                <MessageBufferBadge agentId={a.id} />
                {taskCount > 0 && (
                  <Tooltip
                    label={
                      <div style={{ fontSize: 11 }}>
                        <div style={{ fontWeight: 600, marginBottom: 4 }}>
                          {taskCount} active task{taskCount !== 1 ? "s" : ""}
                        </div>
                        {agentTasks.slice(0, 3).map(t => (
                          <div key={t.id} style={{ marginBottom: 2 }}>
                            • {t.title}
                            {t.dueDate && new Date(t.dueDate) < new Date() && (
                              <span style={{ color: "var(--accent-red)", marginLeft: 4 }}>(overdue)</span>
                            )}
                          </div>
                        ))}
                        {agentTasks.length > 3 && (
                          <div style={{ marginTop: 4, opacity: 0.7 }}>
                            +{agentTasks.length - 3} more...
                          </div>
                        )}
                      </div>
                    }
                    position="bottom"
                    withArrow
                  >
                    <Badge
                      size="xs"
                      color={hasOverdue ? "red" : "grape"}
                      variant="filled"
                      style={{ marginLeft: 4, cursor: "pointer" }}
                    >
                      {taskCount} task{taskCount !== 1 ? "s" : ""}
                    </Badge>
                  </Tooltip>
                )}
                {pendingCount > 0 && (
                  <Badge
                    size="xs"
                    color="yellow"
                    variant="filled"
                    style={{ marginLeft: 4 }}
                  >
                    {pendingCount} approval{pendingCount > 1 ? "s" : ""}
                  </Badge>
                )}
              </div>
              <span className="ac2-uptime">{formatUptime(a.startedAt)}</span>
            </div>

            {/* Activity — badge + sparkline */}
            <div className="ac2-activity">
              <div className="ac2-current-action">
                <AgentActivityBadge
                  activity={activity}
                  since={activitySince[a.id]}
                  compact
                />
                <ActivitySparkline
                  history={activityHistory[a.id] || []}
                  width={60}
                  height={14}
                />
                {(a.provider || a.model) && (
                  <span className="ac2-model-inline">{[a.provider, a.model].filter(Boolean).join("/")}</span>
                )}
              </div>
              {a.currentTask && (
                <div className="ac2-task" title={a.currentTask}>
                  {a.currentTask}
                </div>
              )}
            </div>

            {/* Stats — single inline row with dot separators + utilization */}
            <div className="ac2-stats-row">
              <span className="ac2-stat">
                <span className="ac2-stat-dim">{"\u2193"}</span>{tokensIn > 0 ? formatTokens(tokensIn) : "--"}
                {" "}
                <span className="ac2-stat-dim">{"\u2191"}</span>{tokensOut > 0 ? formatTokens(tokensOut) : "--"}
              </span>
              <span className="ac2-stat-sep">{"\u00B7"}</span>
              <span className="ac2-stat">{formatCostSmart(costUsd, agentHasCost)}</span>
              <span className="ac2-stat-sep">{"\u00B7"}</span>
              <span className="ac2-stat">{formatUptime(a.startedAt)}</span>
              <span className="ac2-stat-sep">{"\u00B7"}</span>
              <Tooltip label={`Last terminal output: ${a.lastOutputAt ? new Date(a.lastOutputAt).toLocaleTimeString() : "unknown"}`}>
                <span className="ac2-stat" style={{
                  color: (() => {
                    if (!a.lastOutputAt) return undefined;
                    const ago = Date.now() - new Date(a.lastOutputAt).getTime();
                    if (ago < 30000) return "var(--accent-green)";
                    if (ago < 180000) return undefined;
                    return "var(--accent-yellow)";
                  })(),
                }}>
                  {formatLastSeen(a.lastOutputAt)}
                </span>
              </Tooltip>
              <span className="ac2-stat-sep">{"\u00B7"}</span>
              <AgentUtilization
                utilization={(() => {
                  const hist = activityHistory[a.id] || [];
                  if (hist.length === 0) return activity === "working" ? 1 : 0;
                  const active = hist.filter(h => h === "working" || h === "reading" || h === "writing" || h === "running-command").length;
                  return active / hist.length;
                })()}
              />
            </div>

            {/* Agent Details — opens modal with CLI command + persona */}
            <div
              onClick={() => setPersonaModalAgent(a)}
              style={{
                display: "flex", alignItems: "center", gap: 8, cursor: "pointer",
                margin: "10px 5px 8px", padding: "7px 12px", borderRadius: 6,
                backgroundColor: "var(--bg-tertiary)", border: "1px solid var(--border-color)",
                transition: "border-color 0.15s",
              }}
              onMouseEnter={(e) => { e.currentTarget.style.borderColor = "var(--text-muted)"; }}
              onMouseLeave={(e) => { e.currentTarget.style.borderColor = "var(--border-color)"; }}
            >
              <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="var(--text-muted)" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                <polyline points="4 17 10 11 4 5" /><line x1="12" y1="19" x2="20" y2="19" />
              </svg>
              <span style={{ fontSize: 11, color: "var(--text-secondary)", fontWeight: 500 }}>
                CLI Command
              </span>
              {a.config?.persona && (
                <>
                  <span style={{ color: "var(--border-color)" }}>|</span>
                  <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="var(--text-muted)" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                    <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z" />
                    <polyline points="14 2 14 8 20 8" />
                  </svg>
                  <span style={{ fontSize: 11, color: "var(--text-secondary)", fontWeight: 500 }}>
                    Persona
                  </span>
                  <span style={{ fontSize: 10, color: "var(--text-muted)" }}>
                    ({Math.round(a.config.persona.length / 1000)}k)
                  </span>
                </>
              )}
              {a.config?.workingDirectory && (
                <>
                  <span style={{ color: "var(--border-color)" }}>|</span>
                  <span style={{ fontSize: 10, color: "var(--text-muted)", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                    {a.config.workingDirectory}
                  </span>
                </>
              )}
            </div>

            {/* Approval Prompts — show pending requests for autonomyLevel = 0 (Suggest) */}
            {pendingRequests.length > 0 && (
              <div style={{ marginTop: 12 }}>
                <Stack gap={8}>
                  {pendingRequests.map((request: ApprovalRequest) => (
                    <ApprovalPrompt
                      key={request.id}
                      request={request}
                      onApprove={() => approve(a.id, request.id)}
                      onReject={() => reject(a.id, request.id)}
                    />
                  ))}
                </Stack>
              </div>
            )}

            {/* Inline message input (slides down) */}
            {sendingTo === a.id && (
              <div className="agent-card-message-input">
                <input
                  value={quickMessage}
                  onChange={(e) => onQuickMessageChange(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === "Enter") { e.preventDefault(); onQuickSend(a.id); }
                    if (e.key === "Escape") onSendingToChange(null);
                  }}
                  placeholder="Type a message..."
                  autoFocus
                  disabled={sendingMsg}
                />
                <button className="primary" onClick={() => onQuickSend(a.id)} disabled={sendingMsg || !quickMessage.trim()}>
                  {sendingMsg ? "..." : "Send"}
                </button>
              </div>
            )}

            {/* Action bar — compact */}
            <div className="ac2-actions">
              {isCrashed || isStopped ? (
                <>
                  <button className="ac2-btn ac2-btn-primary" onClick={() => onRestartAgent(a.id)}>Restart</button>
                  <button className="ac2-btn" onClick={() => onReplaceAgent(a.id)}>Replace</button>
                  <div style={{ flex: 1 }} />
                  <button className="ac2-btn ac2-btn-danger" onClick={() => onRemoveAgent(a.id)}>Remove</button>
                </>
              ) : (
                <>
                  <button className="ac2-btn ac2-btn-primary" onClick={() => onNavigate(`/session/${sessionId}/agent/${a.id}`)}>Chat</button>
                  <button className="ac2-btn" onClick={() => onOpenTerminal(a.id, a.config?.name || a.name || "Agent")}>Terminal</button>
                  <button className="ac2-btn" onClick={async () => { try { await api.openVscode(sessionId, a.id); } catch {} }}>VS Code</button>
                  <Tooltip label={`${a.unreadMessages || 0} unread — nudge agent`}>
                    <Indicator disabled={!a.unreadMessages} label={a.unreadMessages || 0} size={14} color="red" offset={2}>
                      <ActionIcon
                        variant="subtle"
                        size="xs"
                        onClick={async () => {
                          try { await api.nudgeAgent(sessionId, a.id); } catch {}
                        }}
                        style={{ color: a.unreadMessages ? "var(--accent-yellow)" : "var(--text-muted)" }}
                      >
                        <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                          <path d="M18 8A6 6 0 0 0 6 8c0 7-3 9-3 9h18s-3-2-3-9"/><path d="M13.73 21a2 2 0 0 1-3.46 0"/>
                        </svg>
                      </ActionIcon>
                    </Indicator>
                  </Tooltip>
                  <div style={{ flex: 1 }} />
                  <div style={{ position: "relative" }}>
                    <button className="ac2-btn ac2-btn-settings" onClick={() => setGearOpen(gearOpen === a.id ? null : a.id)}>
                      <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                        <circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 0 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 0 1-2.83-2.83l.06-.06A1.65 1.65 0 0 0 4.68 15a1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 0 1 2.83-2.83l.06.06A1.65 1.65 0 0 0 9 4.68a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 0 1 2.83 2.83l-.06.06A1.65 1.65 0 0 0 19.4 9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z"/>
                      </svg>
                    </button>
                    {gearOpen === a.id && (
                      <div className="agent-settings-dropdown" style={{ bottom: "100%", top: "auto", marginBottom: 4 }}>
                        <div className="dropdown-item" onClick={() => { onSendingToChange(sendingTo === a.id ? null : a.id); setGearOpen(null); }}>Send Message</div>
                        <div className="dropdown-item" onClick={() => { onReplaceAgent(a.id); setGearOpen(null); }}>Replace Agent</div>
                        <div className="dropdown-item" onClick={() => { onRestartAgent(a.id); setGearOpen(null); }}>Restart</div>
                        <div className="divider" />
                        <div className="dropdown-item danger" onClick={() => { onRemoveAgent(a.id); setGearOpen(null); }}>Remove Agent</div>
                      </div>
                    )}
                  </div>
                </>
              )}
            </div>

            {/* Mobile: inline read-only log viewer (hidden on desktop via CSS) */}
            {a.status === "running" && (
              <div className="mobile-only-log">
                <MobileLogViewer sessionId={sessionId} agentId={a.id} maxLines={50} />
              </div>
            )}
          </div>
        );
      })}
    </div>

    {/* Terminals Section */}
    <div style={{ marginTop: 48 }}>
      {/* Filter to standalone only — agents are shown in the Agents section */}
      {(() => {
        const standaloneTerminals = terminalSessions.filter(t => t.type === "standalone");

        return (
          <>
            <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 16 }}>
              <h2 style={{ fontSize: 18, fontWeight: 600, color: "var(--text-primary)", margin: 0 }}>
                Terminals
                <Badge
                  variant="light"
                  color="blue"
                  size="sm"
                  style={{ marginLeft: 8 }}
                >
                  {standaloneTerminals.length}
                </Badge>
              </h2>
        <Button
          size="sm"
          onClick={() => {
            const pendingId = `term-pending-${Date.now()}`;
            const terminalName = `Terminal ${terminalSessions.filter((t) => t.type === "standalone").length + 1}`;
            addSession({ id: pendingId, name: terminalName, type: "standalone", createdAt: new Date().toISOString() });
            openTab(pendingId);
            api.openTerminal(sessionId).then((result) => {
              useTerminalSessionStore.getState().removeSession(pendingId);
              useTerminalSessionStore.getState().closeTab(pendingId);
              addSession({ id: result.id, tmuxSession: result.tmuxSession, name: terminalName, type: "standalone", createdAt: new Date().toISOString() });
              openTab(result.id);
            }).catch(() => {
              useTerminalSessionStore.getState().removeSession(pendingId);
            });
          }}
          styles={{ root: { backgroundColor: "var(--accent-blue)", borderColor: "var(--accent-blue)" } }}
        >
          + New Terminal
        </Button>
            </div>

            {standaloneTerminals.length === 0 ? (
              <Paper
                p="xl"
                withBorder
                style={{
                  backgroundColor: "var(--bg-secondary)",
                  borderColor: "var(--border-color)",
                  textAlign: "center",
                }}
              >
                <Text size="sm" c="dimmed">
                  No standalone terminals. Click "+ New Terminal" to create one.
                </Text>
              </Paper>
            ) : (
              <div style={{ display: "grid", gap: 12 }}>
                {standaloneTerminals.map((terminal) => {
            const isAgent = terminal.type === "agent";
            const createdDate = new Date(terminal.createdAt);
            const relativeTime = formatUptime(terminal.createdAt);
            const isCached = hasTerminal(sessionId, terminal.id);

            return (
              <Paper
                key={terminal.id}
                p="md"
                withBorder
                style={{
                  backgroundColor: "var(--bg-secondary)",
                  borderColor: "var(--border-color)",
                  cursor: "pointer",
                  transition: "border-color 0.15s, background-color 0.15s",
                }}
                onMouseEnter={(e) => {
                  e.currentTarget.style.borderColor = "var(--accent-blue)";
                  e.currentTarget.style.backgroundColor = "rgba(88,166,255,0.05)";
                }}
                onMouseLeave={(e) => {
                  e.currentTarget.style.borderColor = "var(--border-color)";
                  e.currentTarget.style.backgroundColor = "var(--bg-secondary)";
                }}
                onClick={() => {
                  // Open terminal in side panel
                  openTab(terminal.id);
                }}
              >
                <Group justify="space-between" align="flex-start">
                  <div style={{ flex: 1 }}>
                    <Group gap="xs" mb={4}>
                      <Text fw={600} size="sm" c="var(--text-primary)">
                        {terminal.name}
                      </Text>
                      <Badge
                        variant="light"
                        color={isAgent ? "blue" : "gray"}
                        size="xs"
                      >
                        {terminal.type}
                      </Badge>
                      {isCached && (
                        <Tooltip label="Terminal cached (instant open)">
                          <Badge variant="dot" color="green" size="xs">
                            Ready
                          </Badge>
                        </Tooltip>
                      )}
                      {isAgent && terminal.agentName && (
                        <Badge variant="outline" color="gray" size="xs">
                          {terminal.agentName}
                        </Badge>
                      )}
                    </Group>
                    <Group gap={8}>
                      <Text size="xs" c="dimmed">
                        {terminal.tmuxSession || terminal.id}
                      </Text>
                      <Text size="xs" c="dimmed">·</Text>
                      <Text size="xs" c="dimmed">
                        Created {relativeTime} ago
                      </Text>
                    </Group>
                  </div>
                  <Group gap={4}>
                    <ActionIcon
                      variant="subtle"
                      size="sm"
                      onClick={(e) => {
                        e.stopPropagation();
                        // Open terminal
                        openTab(terminal.id);
                      }}
                      style={{ color: "var(--text-secondary)" }}
                    >
                      <svg
                        width="16"
                        height="16"
                        viewBox="0 0 24 24"
                        fill="none"
                        stroke="currentColor"
                        strokeWidth="2"
                        strokeLinecap="round"
                        strokeLinejoin="round"
                      >
                        <polyline points="9 10 4 15 9 20" />
                        <path d="M20 4v7a4 4 0 0 1-4 4H4" />
                      </svg>
                    </ActionIcon>
                    {terminal.type === "standalone" && (
                      <ActionIcon
                        variant="subtle"
                        size="sm"
                        color="red"
                        onClick={(e) => {
                          e.stopPropagation();
                          onCloseTerminal(terminal.id, terminal.name);
                        }}
                        style={{ color: "var(--text-secondary)" }}
                      >
                        <svg
                          width="16"
                          height="16"
                          viewBox="0 0 24 24"
                          fill="none"
                          stroke="currentColor"
                          strokeWidth="2"
                          strokeLinecap="round"
                          strokeLinejoin="round"
                        >
                          <line x1="18" y1="6" x2="6" y2="18" />
                          <line x1="6" y1="6" x2="18" y2="18" />
                        </svg>
                      </ActionIcon>
                    )}
                  </Group>
                </Group>
              </Paper>
            );
                })}
              </div>
            )}
          </>
        );
      })()}
    </div>

    {/* Agent Details Modal — CLI Command + Persona */}
    <Modal
      opened={!!personaModalAgent}
      onClose={() => setPersonaModalAgent(null)}
      title={`${personaModalAgent?.config?.name || "Agent"} — Details`}
      size="lg"
      centered
      styles={{
        header: { backgroundColor: "var(--bg-secondary)", borderBottom: "1px solid var(--border-color)" },
        body: { backgroundColor: "var(--bg-secondary)", maxHeight: "70vh", overflowY: "auto" },
        content: { backgroundColor: "var(--bg-secondary)" },
        title: { color: "var(--text-primary)", fontWeight: 600, fontSize: 16 },
        close: { color: "var(--text-secondary)" },
      }}
    >
      <Stack gap="md">
        {/* CLI Command */}
        <div>
          <Group justify="space-between" mb={6}>
            <Text size="sm" fw={600} c="var(--text-primary)">CLI Command</Text>
            {personaModalAgent && (
              <CopyButton value={buildCliCommand(personaModalAgent)} timeout={2000}>
                {({ copied, copy }) => (
                  <Tooltip label={copied ? "Copied!" : "Copy command"}>
                    <ActionIcon variant="subtle" size="xs" onClick={copy}
                      style={{ color: copied ? "var(--accent-green)" : "var(--text-muted)" }}>
                      {copied ? (
                        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><polyline points="20 6 9 17 4 12" /></svg>
                      ) : (
                        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><rect x="9" y="9" width="13" height="13" rx="2" /><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1" /></svg>
                      )}
                    </ActionIcon>
                  </Tooltip>
                )}
              </CopyButton>
            )}
          </Group>
          <Code block style={{
            fontSize: 12, padding: 12, backgroundColor: "var(--bg-tertiary)",
            color: "var(--text-primary)", borderRadius: 6, border: "1px solid var(--border-color)",
            fontFamily: "ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace",
            whiteSpace: "pre-wrap", wordBreak: "break-all", lineHeight: 1.6,
          }}>
            {personaModalAgent ? buildCliCommand(personaModalAgent) : ""}
          </Code>
          {personaModalAgent?.config?.workingDirectory && (
            <Text size="xs" c="var(--text-muted)" mt={6}>
              Working directory: {personaModalAgent.config.workingDirectory}
            </Text>
          )}
        </div>

        {/* Persona & Instructions */}
        {personaModalAgent?.config?.persona && (
          <div>
            <Text size="sm" fw={600} c="var(--text-primary)" mb={6}>
              Persona & Instructions
            </Text>
            <div style={{
              padding: 12, backgroundColor: "var(--bg-tertiary)",
              borderRadius: 6, border: "1px solid var(--border-color)",
              fontSize: 12, lineHeight: 1.6, color: "var(--text-secondary)",
              fontFamily: "ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace",
              whiteSpace: "pre-wrap", wordBreak: "break-word",
              maxHeight: 400, overflowY: "auto",
            }}>
              {personaModalAgent.config.persona}
            </div>
          </div>
        )}
      </Stack>
    </Modal>
    </>
  );
}
