import { useEffect, useState, useCallback, useRef, useMemo } from "react";
import { useParams, useNavigate, Link } from "react-router-dom";
import { useApi } from "../hooks/useApi";
import { useWebSocket } from "../hooks/useWebSocket";
import { SpawnAgentDialog } from "../components/SpawnAgentDialog";
import { ReplaceAgentDialog } from "../components/ReplaceAgentDialog";
import { SessionSettingsDialog } from "../components/SessionSettingsDialog";
import { StopSessionDialog } from "../components/StopSessionDialog";
import { RestartAllDialog } from "../components/RestartAllDialog";
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
import {
  ActionIcon,
  Indicator,
  Tooltip,
  Modal,
  Button,
  Stack,
  Group,
  Text,
  Paper,
  Badge,
  TextInput,
  Textarea,
  Loader,
  Collapse,
  Code,
  CopyButton,
} from "@mantine/core";

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
    if (!confirm("Remove this agent?")) return;
    try {
      await api.removeAgent(sessionId!, agentId);
      loadData();
    } catch (err: any) {
      alert(`Failed to remove agent: ${err.message}`);
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
      alert(`Failed to send message: ${err.message}`);
    } finally {
      setSendingMsg(false);
    }
  }

  async function handleRestartAgent(agentId: string) {
    try {
      await api.restartAgent(sessionId!, agentId);
      loadData();
    } catch (err: any) {
      alert(`Failed to restart agent: ${err.message}`);
    }
  }

  async function handleBroadcastMessage() {
    if (!broadcastMessage.trim() || sendingBroadcast) return;
    setSendingBroadcast(true);
    try {
      await api.broadcastMessage(sessionId!, broadcastMessage);
      setShowBroadcastModal(false);
      setBroadcastMessage("");
      alert(`Broadcast sent to ${agents.length} agent${agents.length !== 1 ? "s" : ""}!`);
    } catch (err: any) {
      alert(`Failed to broadcast message: ${err.message}`);
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
      alert(`Failed to pause session: ${err.message}`);
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
      alert(`Failed to stop session: ${err.message}`);
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
      try {
        await api.launchPlaybook(sessionId!, selectedPlaybookName, playbookTask || undefined);
      } catch {
        const pb = playbookDetails[selectedPlaybookName];
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
      setShowPlaybookDialog(false);
      setSelectedPlaybookName(null);
      setPlaybookTask("");
      setPlaybookError(null);
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
          <button
            style={{
              backgroundColor: "var(--accent-red)",
              borderColor: "var(--accent-red)",
              color: "#fff",
              fontWeight: 600,
            }}
            onClick={() => navigate(`/session/${sessionId}/overview`)}
          >
            &#127918; Command Center
          </button>
          <button
            className="primary"
            onClick={() => setShowSpawnDialog(true)}
          >
            &#10133; Add Agent
          </button>
          <button
            onClick={openPlaybookDialog}
          >
            &#128640; Launch Playbook
          </button>
          <button
            style={{
              backgroundColor: "var(--accent-blue, #58a6ff)",
              borderColor: "var(--accent-blue, #58a6ff)",
              color: "#fff",
              fontWeight: 600,
            }}
            onClick={async () => {
              try {
                await api.openVscodeSession(sessionId!);
              } catch (err: any) {
                alert(`Failed to open VS Code: ${err.message}`);
              }
            }}
          >
            &#128187; Open in VS Code
          </button>
          <button
            onClick={createTerminalOptimistic}
          >
            &#128421; Terminal
          </button>
          <button onClick={() => setShowSettingsDialog(true)}>
            &#9881; Settings
          </button>
          <button onClick={() => setShowReport(true)}>
            &#128202; Report
          </button>
          <button onClick={handlePauseSession}>&#9208; Pause Session</button>
          <button
            onClick={() => {
              setShowRestartAll(true);
              setRestartAllResult(null);
              setRestartAllError(null);
            }}
            disabled={agents.filter(a => a.status === "running").length === 0}
            style={{
              background: "var(--accent-yellow)",
              border: "none",
              color: "#0d1117",
              fontWeight: 600,
              padding: "6px 14px",
              borderRadius: 6,
              cursor: "pointer",
            }}
          >
            &#128260; Restart All
          </button>
          <button className="danger" onClick={() => setShowStopConfirm(true)}>
            &#9724; Stop Session
          </button>
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
            agents.find((a) => a.id === replaceAgentId)?.name || "Agent"
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
        title="Launch Playbook"
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
          {playbookError && (
            <Paper p="sm" style={{ backgroundColor: "rgba(248,81,73,0.1)", border: "1px solid var(--accent-red)", borderRadius: 6 }}>
              <Text size="sm" c="var(--accent-red)">{playbookError}</Text>
            </Paper>
          )}
          {loadingPlaybooks ? (
            <Stack align="center" py="xl">
              <Loader size="sm" color="blue" />
              <Text size="sm" c="dimmed">Loading playbooks...</Text>
            </Stack>
          ) : playbookNames.length === 0 ? (
            <Stack align="center" py="xl">
              <Text size="sm" c="dimmed">No playbooks found.</Text>
              <Text size="xs" c="dimmed">Create playbooks in ~/.kora/playbooks/ or ~/.kora-dev/playbooks/</Text>
            </Stack>
          ) : (
            <>
              <Text size="sm" c="dimmed">Select a playbook to launch into this session:</Text>
              <Stack gap="xs">
                {playbookNames.map((name) => {
                  const pb = playbookDetails[name];
                  const isSelected = selectedPlaybookName === name;
                  return (
                    <Paper
                      key={name}
                      p="sm"
                      withBorder
                      style={{
                        cursor: "pointer",
                        borderColor: isSelected ? "var(--accent-blue)" : "var(--border-color)",
                        backgroundColor: isSelected ? "rgba(88,166,255,0.08)" : "var(--bg-primary)",
                        transition: "border-color 0.15s, background-color 0.15s",
                      }}
                      onClick={() => setSelectedPlaybookName(name)}
                    >
                      <Group justify="space-between" align="flex-start">
                        <div>
                          <Text fw={600} size="sm" c="var(--text-primary)">{name}</Text>
                          {pb?.description && (
                            <Text size="xs" c="dimmed" mt={2}>{pb.description}</Text>
                          )}
                        </div>
                        {pb?.agents && (
                          <Badge variant="light" color="blue" size="sm">
                            {pb.agents.length} agent{pb.agents.length !== 1 ? "s" : ""}
                          </Badge>
                        )}
                      </Group>
                      {isSelected && pb?.agents && (
                        <Group gap={4} mt="xs" wrap="wrap">
                          {pb.agents.map((a: any, i: number) => (
                            <Badge key={i} variant="outline" color="gray" size="xs">
                              {a.name} ({a.role || "worker"})
                            </Badge>
                          ))}
                        </Group>
                      )}
                    </Paper>
                  );
                })}
              </Stack>

              {selectedPlaybookName && (
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
              )}

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
                <Button
                  onClick={handleLaunchPlaybook}
                  disabled={!selectedPlaybookName || launchingPlaybook}
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

/** Reconstruct the CLI command used to spawn an agent */
function buildCliCommand(agent: any): string {
  const provider = agent.config?.cliProvider || "claude-code";
  const model = agent.config?.model;
  const extraArgs = agent.config?.extraCliArgs || [];
  const workDir = agent.config?.workingDirectory;

  // Base command
  let cmd = provider === "claude-code" ? "claude" :
            provider === "aider" ? "aider" :
            provider === "codex" ? "codex" :
            provider === "kiro" ? "kiro" :
            provider === "goose" ? "goose" : provider;

  const parts = [cmd];

  // Add model flag if not default
  if (model && model !== "default" && model !== "") {
    parts.push(`--model ${model}`);
  }

  // Add extra CLI args
  if (extraArgs.length > 0) {
    parts.push(...extraArgs);
  }

  // Note: We don't show --system-prompt-file or --mcp-config as those are internal runtime paths
  // Just show the user-visible flags

  return parts.join(" ");
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
}: AgentsTabProps) {
  const api = useApi();
  const [agentActivities, setAgentActivities] = useState<Record<string, AgentActivity>>({});
  const [activityHistory, setActivityHistory] = useState<Record<string, AgentActivity[]>>({});
  const [activitySince, setActivitySince] = useState<Record<string, string>>({});
  const [gearOpen, setGearOpen] = useState<string | null>(null);
  const [cliExpanded, setCliExpanded] = useState<Record<string, boolean>>({});
  const [tasks, setTasks] = useState<any[]>([]);

  // Close gear dropdown when clicking outside
  useEffect(() => {
    if (!gearOpen) return;
    const close = () => setGearOpen(null);
    setTimeout(() => document.addEventListener("click", close), 0);
    return () => document.removeEventListener("click", close);
  }, [gearOpen]);

  // Activity detection: text flow + pattern matching
  // If terminal output is changing → working. No change for 3min → idle.
  const outputSnapshotsRef = useRef<Record<string, { hash: number; lastChangeAt: number }>>({});
  const IDLE_THRESHOLD_MS = 3 * 60 * 1000; // 3 minutes

  useEffect(() => {
    const runningAgents = agents.filter(a => a.status === "running");
    if (runningAgents.length === 0) return;

    // Simple string hash for change detection
    function hashStr(s: string): number {
      let h = 0;
      for (let i = 0; i < s.length; i++) {
        h = ((h << 5) - h + s.charCodeAt(i)) | 0;
      }
      return h;
    }

    async function detectActivities() {
      const now = Date.now();

      for (const agent of runningAgents) {
        try {
          const data = await api.getOutput(sessionId, agent.id, 15);
          const rawLines: string[] = data?.output || [];
          const outputText = rawLines.join("\n");
          const currentHash = hashStr(outputText);

          // Get or init snapshot for this agent
          const prev = outputSnapshotsRef.current[agent.id];
          if (!prev) {
            outputSnapshotsRef.current[agent.id] = { hash: currentHash, lastChangeAt: now };
          }

          const snapshot = outputSnapshotsRef.current[agent.id];
          const textChanged = snapshot.hash !== currentHash;

          if (textChanged) {
            snapshot.hash = currentHash;
            snapshot.lastChangeAt = now;
          }

          const idleDuration = now - snapshot.lastChangeAt;

          // Primary: text flow detection
          let activity: AgentActivity;

          if (textChanged) {
            // Text is actively flowing — determine what kind of work
            const lines = rawLines.filter(l => l.trim());
            const last5 = lines.slice(-5).join(" ");

            if (last5.match(/Bash\(|Running|Bash command/) || last5.match(/\b(npm|cargo|pip|yarn|make)\b/)) {
              activity = "running-command";
            } else if (last5.includes("Read ") || last5.includes("Searched") || last5.match(/Glob|Grep/)) {
              activity = "reading";
            } else if (last5.includes("Wrote") || last5.includes("Edit(") || last5.includes("Writing")) {
              activity = "writing";
            } else {
              activity = "working";
            }
          } else if (idleDuration > IDLE_THRESHOLD_MS) {
            // No text change for 3+ minutes → idle
            activity = "idle";
          } else {
            // Text hasn't changed recently but within threshold — still working (thinking/processing)
            activity = "working";
          }

          setAgentActivities(prev => {
            if (prev[agent.id] === activity) return prev;
            // Track when activity changed
            setActivitySince(s => ({ ...s, [agent.id]: new Date().toISOString() }));
            return { ...prev, [agent.id]: activity };
          });

          // Record history for sparkline (keep last 20 samples)
          setActivityHistory(prev => {
            const hist = prev[agent.id] || [];
            const updated = [...hist, activity].slice(-20);
            return { ...prev, [agent.id]: updated };
          });
        } catch {
          // ignore
        }
      }
    }

    detectActivities();
    const interval = setInterval(detectActivities, 3000);
    return () => clearInterval(interval);
  }, [agents, sessionId]);

  // Map crashed/stopped agents directly
  useEffect(() => {
    const updates: Record<string, AgentActivity> = {};
    for (const a of agents) {
      if (a.status === "crashed" || a.status === "error") updates[a.id] = "crashed";
      else if (a.status === "stopped") updates[a.id] = "stopped";
    }
    if (Object.keys(updates).length > 0) {
      setAgentActivities(prev => ({ ...prev, ...updates }));
    }
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

            {/* CLI Command — collapsible */}
            <div style={{ marginTop: 8 }}>
              <div
                onClick={() => setCliExpanded(prev => ({ ...prev, [a.id]: !prev[a.id] }))}
                style={{
                  display: "flex",
                  alignItems: "center",
                  gap: 6,
                  cursor: "pointer",
                  padding: "4px 0",
                  color: "var(--text-secondary)",
                  fontSize: 12,
                  fontWeight: 500,
                  userSelect: "none",
                }}
              >
                <svg
                  width="10"
                  height="10"
                  viewBox="0 0 24 24"
                  fill="none"
                  stroke="currentColor"
                  strokeWidth="2"
                  strokeLinecap="round"
                  strokeLinejoin="round"
                  style={{
                    transform: cliExpanded[a.id] ? "rotate(90deg)" : "rotate(0deg)",
                    transition: "transform 0.15s ease",
                  }}
                >
                  <polyline points="9 18 15 12 9 6" />
                </svg>
                <span>CLI Command</span>
              </div>
              <Collapse in={cliExpanded[a.id]}>
                <div style={{ marginTop: 6, position: "relative" }}>
                  <Code
                    block
                    style={{
                      fontSize: 11,
                      padding: "8px 32px 8px 8px",
                      backgroundColor: "var(--bg-tertiary)",
                      color: "var(--text-primary)",
                      borderRadius: 4,
                      border: "1px solid var(--border-color)",
                      fontFamily: "ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace",
                      whiteSpace: "pre-wrap",
                      wordBreak: "break-all",
                    }}
                  >
                    {buildCliCommand(a)}
                  </Code>
                  <CopyButton value={buildCliCommand(a)} timeout={2000}>
                    {({ copied, copy }) => (
                      <Tooltip label={copied ? "Copied!" : "Copy command"} position="left">
                        <ActionIcon
                          onClick={copy}
                          variant="subtle"
                          size="sm"
                          style={{
                            position: "absolute",
                            top: 8,
                            right: 8,
                            color: copied ? "var(--accent-green)" : "var(--text-secondary)",
                          }}
                        >
                          {copied ? (
                            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                              <polyline points="20 6 9 17 4 12" />
                            </svg>
                          ) : (
                            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                              <rect x="9" y="9" width="13" height="13" rx="2" ry="2" />
                              <path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1" />
                            </svg>
                          )}
                        </ActionIcon>
                      </Tooltip>
                    )}
                  </CopyButton>
                  {a.config?.workingDirectory && (
                    <div style={{ marginTop: 6, fontSize: 11, color: "var(--text-muted)" }}>
                      <span style={{ fontWeight: 500 }}>Working dir:</span> {a.config.workingDirectory}
                    </div>
                  )}
                </div>
              </Collapse>
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
                        onClick={async (e) => {
                          e.stopPropagation();
                          if (!confirm(`Close terminal "${terminal.name}"?`)) return;
                          try {
                            await api.deleteTerminal(sessionId, terminal.id);
                            // Remove from store (this also closes the tab)
                            removeSession(terminal.id);
                          } catch (err: any) {
                            alert(`Failed to close terminal: ${err.message}`);
                          }
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
    </>
  );
}
