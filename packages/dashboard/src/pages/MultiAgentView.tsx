import React, { useEffect, useState, useCallback, useRef } from "react";
import { useParams, Link } from "react-router-dom";
import { useApi } from "../hooks/useApi";
import { AgentTerminal } from "../components/AgentTerminal";
import { SpawnAgentDialog } from "../components/SpawnAgentDialog";
import { ReplaceAgentDialog } from "../components/ReplaceAgentDialog";
import { EditorTile } from "../components/EditorTile";
import { Mosaic, MosaicWindow, MosaicNode, MosaicPath, MosaicWindowProps, getLeaves, createBalancedTreeFromLeaves } from "react-mosaic-component";
import "react-mosaic-component/react-mosaic-component.css";
import { FlagIndicator, ChannelIndicator } from "../components/FlagIndicator";
import { Indicator, Tooltip } from "@mantine/core";
import { useTerminalSessionStore } from "../stores/terminalSessionStore";
import { setMessageNotificationCallback } from "../stores/terminalRegistry";
import { formatCost, formatTokens } from "../utils/formatters";

const PANEL_BORDER_COLORS = [
  "#58a6ff",
  "#bc8cff",
  "#3fb950",
  "#d29922",
  "#f78166",
  "#39d2c0",
  "#f85149",
  "#79c0ff",
  "#d2a8ff",
  "#56d364",
];

/* ---- Helpers ---- */

function buildInitialMosaic(ids: string[]): MosaicNode<string> | null {
  if (ids.length === 0) return null;
  if (ids.length === 1) return ids[0];
  return createBalancedTreeFromLeaves(ids) ?? null;
}

function getLeafIds(node: MosaicNode<string> | null): string[] {
  if (!node) return [];
  if (typeof node === "string") return [node];
  return getLeaves(node);
}

/** Remove a single leaf from the mosaic tree, collapsing the parent. */
function removeMosaicLeaf(node: MosaicNode<string>, leafId: string): MosaicNode<string> | null {
  if (!node) return null;
  if (typeof node === "string") {
    return node === leafId ? null : node;
  }
  // MosaicNode is either a string or { direction, children, splitPercentages?, type? }
  // react-mosaic-component v7 uses { type: "split", direction, children: [first, second] }
  const n = node as any;
  if (Array.isArray(n.children)) {
    const filtered = (n.children as MosaicNode<string>[])
      .map((child) => removeMosaicLeaf(child, leafId))
      .filter((child): child is MosaicNode<string> => child !== null);
    if (filtered.length === 0) return null;
    if (filtered.length === 1) return filtered[0]; // collapse the split
    return { ...n, children: filtered } as MosaicNode<string>;
  }
  // Fallback for { first, second } format
  if ("first" in n && "second" in n) {
    const first = removeMosaicLeaf(n.first, leafId);
    const second = removeMosaicLeaf(n.second, leafId);
    if (!first && !second) return null;
    if (!first) return second;
    if (!second) return first;
    return { direction: n.direction, first, second, splitPercentage: n.splitPercentage } as any;
  }
  return node;
}

/** Replace a leaf ID in the mosaic tree with a new ID. */
function replaceMosaicLeaf(node: MosaicNode<string> | null, oldId: string, newId: string): MosaicNode<string> | null {
  if (!node) return null;
  if (typeof node === "string") {
    return node === oldId ? newId : node;
  }
  const n = node as any;
  if (Array.isArray(n.children)) {
    return {
      ...n,
      children: (n.children as MosaicNode<string>[]).map((child) => replaceMosaicLeaf(child, oldId, newId)),
    } as MosaicNode<string>;
  }
  if ("first" in n && "second" in n) {
    return {
      direction: n.direction,
      first: replaceMosaicLeaf(n.first, oldId, newId),
      second: replaceMosaicLeaf(n.second, oldId, newId),
      splitPercentage: n.splitPercentage,
    } as any;
  }
  return node;
}

export function MultiAgentView() {
  const { sessionId } = useParams<{ sessionId: string }>();
  const api = useApi();

  const [session, setSession] = useState<any>(null);
  const [agents, setAgents] = useState<any[]>([]);
  const [loading, setLoading] = useState(true);
  const [focusedPanel, setFocusedPanel] = useState<string | null>(null);
  const [messages, setMessages] = useState<Record<string, string>>({});
  const [sendingMap, setSendingMap] = useState<Record<string, boolean>>({});
  const [menuOpen, setMenuOpen] = useState<string | null>(null);
  const [inlineMsgOpen, setInlineMsgOpen] = useState<string | null>(null);
  // "Send as" selection per agent panel: agentId -> sourceAgentId (empty string = "User")
  const [sendAsMap, setSendAsMap] = useState<Record<string, string>>({});
  const pollRef = useRef<ReturnType<typeof setInterval> | null>(null);

  // Mosaic layout state
  const [mosaicValue, setMosaicValue] = useState<MosaicNode<string> | null>(null);
  const mosaicInitialized = useRef(false);
  const knownAgentIdsRef = useRef<string>("__uninitialized__");

  // Broadcast state
  const [broadcastMsg, setBroadcastMsg] = useState("");
  const [broadcasting, setBroadcasting] = useState(false);

  // Toast state
  const [toast, setToast] = useState<string | null>(null);
  const toastTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  // Dialog state
  const [showSpawnDialog, setShowSpawnDialog] = useState(false);
  const [replaceTarget, setReplaceTarget] = useState<{ id: string; name: string } | null>(null);

  // Fullscreen state — CSS position:fixed on tile content (transform removed from terminalSlideIn)
  const [fullscreenAgentId, setFullscreenAgentId] = useState<string | null>(null);

  // Terminal sessions from shared Zustand store
  const addTerminalSession = useTerminalSessionStore((state) => state.addSession);
  const removeTerminalSession = useTerminalSessionStore((state) => state.removeSession);
  const pruneStaleTerminals = useTerminalSessionStore((state) => state.pruneStale);

  // Message flash state — briefly highlights agent tiles when they receive messages
  const [flashingAgents, setFlashingAgents] = useState<Set<string>>(new Set());
  const flashTimers = useRef<Map<string, ReturnType<typeof setTimeout>>>(new Map());

  // Named layout save/reload
  const [savedLayouts, setSavedLayouts] = useState<Record<string, any>>({});
  const [showLayoutMenu, setShowLayoutMenu] = useState(false);

  const broadcastInputRef = useRef<HTMLInputElement>(null);

  const MOSAIC_KEY = `kora-mosaic-${sessionId}`;
  const LAYOUTS_KEY = `kora-saved-layouts-${sessionId}`;

  function showToast(msg: string) {
    setToast(msg);
    if (toastTimer.current) clearTimeout(toastTimer.current);
    toastTimer.current = setTimeout(() => setToast(null), 2500);
  }

  // Load saved named layouts from localStorage on mount
  useEffect(() => {
    const saved = localStorage.getItem(LAYOUTS_KEY);
    if (saved) try { setSavedLayouts(JSON.parse(saved)); } catch { /* ignore */ }
  }, [sessionId]); // eslint-disable-line react-hooks/exhaustive-deps

  // Close layout dropdown when clicking outside
  useEffect(() => {
    if (!showLayoutMenu) return;
    const handleClick = () => setShowLayoutMenu(false);
    setTimeout(() => document.addEventListener("click", handleClick), 0);
    return () => document.removeEventListener("click", handleClick);
  }, [showLayoutMenu]);

  function saveCurrentLayout() {
    const name = prompt("Save layout as:");
    if (!name || !mosaicValue) return;
    const updated = { ...savedLayouts, [name]: mosaicValue };
    setSavedLayouts(updated);
    localStorage.setItem(LAYOUTS_KEY, JSON.stringify(updated));
    showToast(`Layout "${name}" saved`);
  }

  function loadLayout(name: string) {
    const layout = savedLayouts[name];
    if (layout) {
      setMosaicValue(layout);
      setTimeout(() => window.dispatchEvent(new Event("resize")), 200);
      showToast(`Layout "${name}" loaded`);
    }
    setShowLayoutMenu(false);
  }

  function deleteLayout(name: string) {
    const updated = { ...savedLayouts };
    delete updated[name];
    setSavedLayouts(updated);
    localStorage.setItem(LAYOUTS_KEY, JSON.stringify(updated));
    showToast(`Layout "${name}" deleted`);
  }

  const loadData = useCallback(async () => {
    if (!sessionId) return;
    try {
      const [s, a] = await Promise.all([
        api.getSession(sessionId),
        api.getAgents(sessionId),
      ]);
      setSession(s);

      // Only update agents if something actually changed
      const newAgents = a.agents || [];
      setAgents(prev => {
        const prevKey = prev.map(a => `${a.id}:${a.status}:${a.config?.model}`).join("|");
        const newKey = newAgents.map((a: any) => `${a.id}:${a.status}:${a.config?.model}`).join("|");
        return prevKey === newKey ? prev : newAgents;
      });
    } catch (err) {
      console.error("Failed to load session data:", err);
    } finally {
      setLoading(false);
    }
  }, [sessionId]);

  useEffect(() => {
    if (!sessionId) return;
    setLoading(true);
    loadData();
  }, [sessionId, loadData]);

  useEffect(() => {
    if (!sessionId) return;
    pollRef.current = setInterval(loadData, 5000);
    return () => {
      if (pollRef.current) clearInterval(pollRef.current);
    };
  }, [sessionId, loadData]);

  // Cleanup toast timer
  useEffect(() => {
    return () => {
      if (toastTimer.current) clearTimeout(toastTimer.current);
    };
  }, []);

  // Flash an agent tile briefly when it receives a message
  const flashAgent = useCallback((agentId: string) => {
    setFlashingAgents((prev) => {
      const next = new Set(prev);
      next.add(agentId);
      return next;
    });
    // Clear any existing timer for this agent
    const existing = flashTimers.current.get(agentId);
    if (existing) clearTimeout(existing);
    // Remove flash after 2 seconds
    const timer = setTimeout(() => {
      setFlashingAgents((prev) => {
        const next = new Set(prev);
        next.delete(agentId);
        return next;
      });
      flashTimers.current.delete(agentId);
    }, 2000);
    flashTimers.current.set(agentId, timer);
  }, []);

  // Hook into terminal message notifications to trigger flash on agent cards
  useEffect(() => {
    if (!sessionId || agents.length === 0) return;
    for (const agent of agents) {
      setMessageNotificationCallback(sessionId, agent.id, (_from) => {
        flashAgent(agent.id);
      });
    }
    return () => {
      for (const agent of agents) {
        setMessageNotificationCallback(sessionId, agent.id, undefined);
      }
    };
  }, [sessionId, agents, flashAgent]);

  // Cleanup flash timers on unmount
  useEffect(() => {
    return () => {
      for (const timer of flashTimers.current.values()) {
        clearTimeout(timer);
      }
    };
  }, []);

  // Fetch terminals + validate entire mosaic on mount (agents + terminals + editor tiles)
  useEffect(() => {
    if (!sessionId) return;
    async function validateAndSyncMosaic() {
      try {
        // Fetch agents and terminals in parallel
        const [agentData, terminalData] = await Promise.all([
          api.getAgents(sessionId!),
          api.getTerminals(sessionId!),
        ]);

        const serverAgentIds = new Set((agentData?.agents || []).map((a: any) => a.id));
        const serverTerminals = terminalData?.terminals || [];
        const serverTerminalIds = new Set(serverTerminals.map((t: any) => t.id));

        // Sync Zustand store: add server terminals, prune stale ones
        serverTerminals.forEach((term: any) => {
          addTerminalSession({
            id: term.id,
            tmuxSession: term.tmuxSession,
            name: term.name || `Terminal`,
            type: term.type || "standalone",
            agentName: term.agentName,
            createdAt: term.createdAt || new Date().toISOString(),
          });
        });
        pruneStaleTerminals(serverTerminalIds);

        // Validate all mosaic tiles: remove stale agents + stale terminals
        setMosaicValue((prev) => {
          if (!prev) return prev;
          const currentIds = getLeafIds(prev);
          let updated: MosaicNode<string> | null = prev;

          for (const id of currentIds) {
            // Keep editor tiles
            if (id.startsWith("editor-")) continue;

            // Remove orphaned pending terminals from previous mount
            if (id.startsWith("term-pending-")) {
              updated = updated ? removeMosaicLeaf(updated, id) : null;
              continue;
            }

            // Terminal tile: validate against server terminal list
            if (id.startsWith("term-")) {
              if (!serverTerminalIds.has(id)) {
                updated = updated ? removeMosaicLeaf(updated, id) : null;
              }
              continue;
            }

            // Agent tile: validate against server agent list
            if (!serverAgentIds.has(id)) {
              updated = updated ? removeMosaicLeaf(updated, id) : null;
            }
          }

          // Add terminal tiles from server that aren't in mosaic yet
          const updatedIds = updated ? getLeafIds(updated) : [];
          for (const term of serverTerminals) {
            if (!updatedIds.includes(term.id)) {
              updated = updated
                ? { type: "split", direction: "row", children: [updated, term.id], splitPercentages: [70, 30] } as any
                : term.id;
            }
          }

          if (updated !== prev) {
            setTimeout(() => window.dispatchEvent(new Event("resize")), 200);
          }
          return updated;
        });
      } catch (err) {
        console.debug("Could not validate mosaic for Command Center:", err);
      }
    }
    validateAndSyncMosaic();
  }, [sessionId]); // eslint-disable-line react-hooks/exhaustive-deps

  // Load saved mosaic layout on mount
  useEffect(() => {
    const saved = localStorage.getItem(MOSAIC_KEY);
    if (saved) {
      try {
        const parsed = JSON.parse(saved);
        setMosaicValue(parsed);
        mosaicInitialized.current = true;
      } catch { /* ignore */ }
    }
  }, [sessionId]); // eslint-disable-line react-hooks/exhaustive-deps

  // Build initial mosaic from agents when first loaded
  useEffect(() => {
    if (!mosaicInitialized.current && agents.length > 0) {
      const saved = localStorage.getItem(MOSAIC_KEY);
      if (saved) {
        // Already loaded from localStorage, just validate
        try {
          const parsed = JSON.parse(saved);
          const savedIds = getLeafIds(parsed);
          const agentIds = agents.map(a => a.id);
          // Check if saved layout still has valid agents (terminal tiles are always valid)
          const validIds = savedIds.filter(id => agentIds.includes(id) || id.startsWith("term-") || id.startsWith("editor-"));
          const newIds = agentIds.filter(id => !savedIds.includes(id));
          if (validIds.length > 0 && newIds.length === 0) {
            mosaicInitialized.current = true;
            return;
          }
        } catch { /* ignore */ }
      }
      setMosaicValue(buildInitialMosaic(agents.map(a => a.id)));
      mosaicInitialized.current = true;
    }
  }, [agents]); // eslint-disable-line react-hooks/exhaustive-deps

  // When agents change (add/remove), update the mosaic
  useEffect(() => {
    if (!mosaicValue || !mosaicInitialized.current) return;

    const agentIds = agents.map(a => a.id);
    const agentIdsKey = [...agentIds].sort().join(",");

    // Skip if agent set hasn't changed (just status/cost updates)
    if (agentIdsKey === knownAgentIdsRef.current) return;
    knownAgentIdsRef.current = agentIdsKey;

    {
      const currentIds = getLeafIds(mosaicValue);
      let updated: MosaicNode<string> | null = mosaicValue;

      // Remove tiles for agents that no longer exist (but keep term-* and editor-* tiles)
      const staleIds = currentIds.filter(id =>
        !id.startsWith("term-") && !id.startsWith("editor-") && !agentIds.includes(id)
      );
      for (const staleId of staleIds) {
        if (updated) updated = removeMosaicLeaf(updated, staleId);
      }

      // Add tiles for new agents
      const newAgentIds = agentIds.filter(id => !currentIds.includes(id));
      for (const id of newAgentIds) {
        updated = updated
          ? { type: "split", direction: "row", children: [updated, id], splitPercentages: [70, 30] }
          : id;
      }

      if (staleIds.length > 0 || newAgentIds.length > 0) {
        setMosaicValue(updated);
        setTimeout(() => window.dispatchEvent(new Event("resize")), 200);
      }
    }
  }, [agents]); // eslint-disable-line react-hooks/exhaustive-deps


  // Save mosaic layout on change
  useEffect(() => {
    if (mosaicValue && sessionId) {
      localStorage.setItem(MOSAIC_KEY, JSON.stringify(mosaicValue));
    }
  }, [mosaicValue]); // eslint-disable-line react-hooks/exhaustive-deps

  // Keyboard shortcuts
  useEffect(() => {
    function handleKeyDown(e: KeyboardEvent) {
      // Escape: exit fullscreen (restore saved layout)
      if (e.key === "Escape" && fullscreenAgentId) {
        toggleFullscreen(fullscreenAgentId);
        return;
      }

      // Ctrl+1 through Ctrl+9: focus/fullscreen agent by index
      if (e.ctrlKey && e.key >= "1" && e.key <= "9") {
        e.preventDefault();
        const idx = parseInt(e.key, 10) - 1;
        if (idx < agents.length) {
          toggleFullscreen(agents[idx].id);
        }
        return;
      }

      // Ctrl+` : toggle broadcast input focus
      if (e.ctrlKey && e.key === "`") {
        e.preventDefault();
        if (broadcastInputRef.current) {
          if (document.activeElement === broadcastInputRef.current) {
            broadcastInputRef.current.blur();
          } else {
            broadcastInputRef.current.focus();
          }
        }
        return;
      }
    }

    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [fullscreenAgentId, agents]);

  async function handleBroadcast() {
    const msg = broadcastMsg.trim();
    if (!msg || broadcasting || !sessionId) return;
    setBroadcasting(true);
    try {
      await api.broadcastMessage(sessionId, msg);
      setBroadcastMsg("");
      showToast(`Sent to ${agents.length} agent${agents.length !== 1 ? "s" : ""}`);
    } catch (err: any) {
      showToast(`Broadcast failed: ${err.message}`);
    } finally {
      setBroadcasting(false);
    }
  }

  async function handleSendMessage(agentId: string) {
    const msg = messages[agentId]?.trim();
    if (!msg || sendingMap[agentId]) return;
    setSendingMap((prev) => ({ ...prev, [agentId]: true }));
    try {
      const sendAs = sendAsMap[agentId] || "";
      if (sendAs) {
        await api.relayMessage(sessionId!, sendAs, agentId, msg);
      } else {
        await api.sendMessage(sessionId!, agentId, msg);
      }
      setMessages((prev) => ({ ...prev, [agentId]: "" }));
      setInlineMsgOpen(null);
    } catch (err: any) {
      alert(`Failed to send message: ${err.message}`);
    } finally {
      setSendingMap((prev) => ({ ...prev, [agentId]: false }));
    }
  }

  async function handleRestart(agentId: string) {
    if (!confirm("Restart this agent?")) return;
    try {
      await api.restartAgent(sessionId!, agentId);
      setMenuOpen(null);
      showToast("Agent restarting...");
      loadData();
    } catch (err: any) {
      alert(`Failed to restart agent: ${err.message}`);
    }
  }

  async function handleRemove(agentId: string) {
    if (!confirm("Remove this agent?")) return;
    try {
      await api.removeAgent(sessionId!, agentId);
      setMenuOpen(null);
      // Immediately remove from local state AND mosaic
      setAgents((prev) => prev.filter((a) => a.id !== agentId));
      setMosaicValue((prev) => prev ? removeMosaicLeaf(prev, agentId) : prev);
      showToast("Agent removed");
    } catch (err: any) {
      alert(`Failed to remove agent: ${err.message}`);
    }
  }

  function handleOpenReplace(agent: any) {
    setMenuOpen(null);
    setReplaceTarget({ id: agent.id, name: agent.config?.name || agent.name || "Agent" });
  }

  function handleOpenSendMessage(agentId: string) {
    setMenuOpen(null);
    setInlineMsgOpen(agentId);
  }

  function handleSpawned(newAgent: any) {
    setShowSpawnDialog(false);
    if (newAgent && newAgent.id) {
      setAgents((prev) => [...prev, newAgent]);
    }
    showToast("Agent spawned");
    loadData();
  }

  function handleReplaced(_newAgent: any) {
    // Remove old pane immediately; new agent will appear via the poll
    if (replaceTarget) {
      setMosaicValue((prev) => prev ? removeMosaicLeaf(prev, replaceTarget.id) : prev);
      setAgents((prev) => prev.filter((a) => a.id !== replaceTarget.id));
    }
    setReplaceTarget(null);
    showToast("Agent replaced");
    loadData();
  }

  const [isCreatingTerminal, setIsCreatingTerminal] = useState(false);

  async function handleAddTerminal() {
    if (!sessionId || isCreatingTerminal) return;
    setIsCreatingTerminal(true);

    // Optimistic: add tile immediately with pending ID
    const tempId = `term-pending-${Date.now()}`;
    setMosaicValue((prev) => {
      if (!prev) return tempId;
      return { type: "split", direction: "row", children: [prev, tempId], splitPercentages: [70, 30] };
    });

    // 30s timeout: remove pending tile if creation takes too long
    const timeoutId = setTimeout(() => {
      setMosaicValue((prev) => prev ? removeMosaicLeaf(prev, tempId) : prev);
      setIsCreatingTerminal(false);
      showToast("Terminal creation timed out");
    }, 30000);

    try {
      const result = await api.openTerminal(sessionId);
      clearTimeout(timeoutId);
      // Add to shared Zustand store so other views can see it
      addTerminalSession({
        id: result.id,
        tmuxSession: result.tmuxSession,
        name: `Terminal`,
        type: "standalone",
        createdAt: new Date().toISOString(),
      });
      // Replace temp tile with real terminal
      setMosaicValue((prev) => replaceMosaicLeaf(prev, tempId, result.id));
    } catch (err: any) {
      clearTimeout(timeoutId);
      // Remove optimistic tile on failure
      setMosaicValue((prev) => prev ? removeMosaicLeaf(prev, tempId) : prev);
      showToast(`Failed to open terminal: ${err.message}`);
    } finally {
      setIsCreatingTerminal(false);
    }
  }

  function closeTerminal(termId: string) {
    removeTerminalSession(termId);
    // Remove from mosaic by filtering out the terminal leaf
    setMosaicValue((prev) => {
      if (!prev) return null;
      return removeMosaicLeaf(prev, termId);
    });
  }

  function handleAddEditor() {
    const editorId = `editor-${crypto.randomUUID?.()?.slice(0, 8) || Date.now()}`;
    setMosaicValue(prev => prev
      ? { type: "split", direction: "row", children: [prev, editorId], splitPercentages: [70, 30] }
      : editorId
    );
    setTimeout(() => window.dispatchEvent(new Event("resize")), 200);
  }

  function closeEditor(editorId: string) {
    setMosaicValue(prev => prev ? removeMosaicLeaf(prev, editorId) : prev);
  }

  function getRoleBadgeClass(role: string): string {
    return role === "master" ? "badge-purple" : "badge-blue";
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

  function toggleFullscreen(agentId: string) {
    setFullscreenAgentId((prev) => (prev === agentId ? null : agentId));
    setTimeout(() => window.dispatchEvent(new Event('resize')), 300);
  }

  // Compute running / crashed counts
  const runningCount = agents.filter((a) => a.status === "running" || a.status === "idle" || a.status === "waiting").length;
  const crashedCount = agents.filter((a) => a.status === "crashed" || a.status === "error").length;

  /* ---- Render a single mosaic tile ---- */

  function renderTerminalTile(termId: string, path: MosaicPath) {
    // Pending terminal — show loading state
    if (termId.startsWith("term-pending-")) {
      return (
        <MosaicWindow<string>
          path={path}
          title=""
          toolbarControls={<span />}
          renderToolbar={() => (
            <div className="mosaic-panel-header" style={{ borderLeft: "3px solid #39d2c0" }}>
              <span className="mosaic-agent-name">Terminal</span>
              <span className="mosaic-agent-meta" style={{ fontStyle: "italic" }}>Opening...</span>
            </div>
          )}
        >
          <div style={{
            display: "flex", flexDirection: "column", alignItems: "center",
            justifyContent: "center", height: "100%", background: "#0d1117", gap: 12,
          }}>
            <div className="spinner" />
            <span style={{ color: "var(--text-muted)", fontSize: 13 }}>Starting terminal...</span>
          </div>
        </MosaicWindow>
      );
    }

    return (
      <MosaicWindow<string>
        path={path}
        title=""
        toolbarControls={<span />}
        renderToolbar={() => (
          <div
            className="mosaic-panel-header"
            style={{
              borderLeft: "3px solid #39d2c0",
            }}
          >
            <span style={{ color: "var(--text-secondary)", fontSize: 14 }}>&#9641;</span>
            <span className="mosaic-agent-name">Terminal</span>
            <span className="mosaic-agent-meta">{session?.projectPath}</span>
            <div style={{ flex: 1 }} />
            <button
              className="split-panel-btn"
              onClick={(e) => {
                e.stopPropagation();
                closeTerminal(termId);
              }}
              title="Close terminal"
            >
              <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round"><line x1="18" y1="6" x2="6" y2="18" /><line x1="6" y1="6" x2="18" y2="18" /></svg>
            </button>
          </div>
        )}
      >
        <div style={{ display: "flex", flexDirection: "column", height: "100%" }}>
          <div className="agent-panel-terminal" style={{ flex: 1, minHeight: 0, overflow: "hidden" }}>
            <AgentTerminal sessionId={sessionId!} agentId={termId} height="100%" />
          </div>
        </div>
      </MosaicWindow>
    );
  }

  function renderEditorTile(editorId: string, tilePath: MosaicPath) {
    return (
      <MosaicWindow<string>
        path={tilePath}
        title=""
        toolbarControls={<span />}
        renderToolbar={() => (
          <div
            className="mosaic-panel-header"
            style={{ borderLeft: "3px solid #bc8cff" }}
          >
            <span style={{ color: "#bc8cff", fontSize: 14 }}>{"\u270E"}</span>
            <span className="mosaic-agent-name">Editor</span>
            <span className="mosaic-agent-meta">{session?.projectPath}</span>
            <div style={{ flex: 1 }} />
            <button
              className="split-panel-btn"
              onClick={(e) => {
                e.stopPropagation();
                closeEditor(editorId);
              }}
              title="Close"
            >
              <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round"><line x1="18" y1="6" x2="6" y2="18" /><line x1="6" y1="6" x2="18" y2="18" /></svg>
            </button>
          </div>
        )}
      >
        <EditorTile sessionId={sessionId!} />
      </MosaicWindow>
    );
  }

  const renderTile = useCallback(function renderTile(id: string, path: MosaicPath) {
    // Check if this is a plain terminal tile
    if (id.startsWith("term-")) {
      return renderTerminalTile(id, path);
    }

    // Check if this is an editor tile
    if (id.startsWith("editor-")) {
      return renderEditorTile(id, path);
    }

    const agent = agents.find(a => a.id === id);
    if (!agent) return <div className="mosaic-tile-not-found">Agent not found</div>;

    const idx = agents.indexOf(agent);
    const isCrashed = agent.status === "crashed" || agent.status === "error";
    const borderColor = isCrashed ? "#f85149" : PANEL_BORDER_COLORS[idx % PANEL_BORDER_COLORS.length];
    const isFocused = focusedPanel === agent.id;

    const tokenIn = agent.tokenUsage?.input ?? agent.tokensIn ?? agent.tokens_in ?? agent.cost?.totalTokensIn;
    const tokenOut = agent.tokenUsage?.output ?? agent.tokensOut ?? agent.tokens_out ?? agent.cost?.totalTokensOut;
    const cost = agent.tokenUsage?.cost ?? (typeof agent.cost === "number" ? agent.cost : agent.cost?.totalCostUsd);

    return (
      <MosaicWindow<string>
        path={path}
        title=""
        toolbarControls={<span />}
        renderToolbar={(_props: MosaicWindowProps<string>, _draggable: boolean | undefined) => (
          <div
            className={`mosaic-panel-header${flashingAgents.has(agent.id) ? " mosaic-panel-flash" : ""}`}
            onDoubleClick={() => toggleFullscreen(agent.id)}
            style={{
              borderLeft: `3px solid ${isFocused ? "#58a6ff" : borderColor}`,
            }}
          >
            <span className={`agent-status-dot ${getStatusDotClass(agent.status)}`} />
            <span className="mosaic-agent-name">
              {agent.config?.name || agent.name || "Agent"}
            </span>
            {agent.role && (
              <span className={`badge ${getRoleBadgeClass(agent.role)}`} style={{ fontSize: 11, padding: "1px 8px" }}>
                {agent.role}
              </span>
            )}
            <span className="mosaic-agent-meta">
              {[agent.provider, agent.model].filter(Boolean).join("/")}
            </span>
            <FlagIndicator flags={(agent.config?.extraCliArgs as string[]) || []} />
            <ChannelIndicator channels={(agent.config?.channels as string[]) || []} />
            <span className="mosaic-token-usage">
              <span>In: {formatTokens(tokenIn)}</span>
              <span>Out: {formatTokens(tokenOut)}</span>
              <span className="cost">{formatCost(cost)}</span>
            </span>

            <span style={{ flex: 1 }} />
            {isCrashed && (
              <span style={{ fontSize: 11, color: "#f85149", fontWeight: 600 }}>
                Crashed
              </span>
            )}
            {!isCrashed && (
              <span style={{ fontSize: 12, color: "var(--text-secondary)" }}>
                {agent.status || "unknown"}
              </span>
            )}

            {/* Nudge button */}
            <Tooltip label={`${agent.unreadMessages || 0} unread — nudge`}>
              <Indicator disabled={!agent.unreadMessages} label={agent.unreadMessages || 0} size={12} color="red" offset={2}>
                <button
                  className="split-panel-btn"
                  title="Nudge agent"
                  onClick={async (e) => {
                    e.stopPropagation();
                    try { await api.nudgeAgent(sessionId!, agent.id); } catch {}
                  }}
                  style={{ color: agent.unreadMessages ? "var(--accent-yellow)" : undefined }}
                >
                  <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                    <path d="M18 8A6 6 0 0 0 6 8c0 7-3 9-3 9h18s-3-2-3-9"/><path d="M13.73 21a2 2 0 0 1-3.46 0"/>
                  </svg>
                </button>
              </Indicator>
            </Tooltip>

            {/* Fullscreen button */}
            <button
              className="split-panel-btn"
              title="Fullscreen"
              onClick={(e) => {
                e.stopPropagation();
                toggleFullscreen(agent.id);
              }}
            >
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                <polyline points="15 3 21 3 21 9" /><polyline points="9 21 3 21 3 15" />
                <line x1="21" y1="3" x2="14" y2="10" /><line x1="3" y1="21" x2="10" y2="14" />
              </svg>
            </button>

            {/* Gear menu */}
            <div style={{ position: "relative" }}>
              <button
                className="split-panel-btn"
                onClick={(e) => {
                  e.stopPropagation();
                  setMenuOpen(menuOpen === agent.id ? null : agent.id);
                }}
              >
                <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                  <circle cx="12" cy="12" r="1.5" /><circle cx="12" cy="5" r="1.5" /><circle cx="12" cy="19" r="1.5" />
                </svg>
              </button>
              {menuOpen === agent.id && (
                <div
                  style={{
                    position: "absolute",
                    top: "100%",
                    right: 0,
                    background: "var(--bg-secondary)",
                    border: "1px solid var(--border-color)",
                    borderRadius: 6,
                    padding: 4,
                    zIndex: 50,
                    minWidth: 140,
                    boxShadow: "0 8px 24px rgba(0,0,0,0.25)",
                  }}
                  onClick={(e) => e.stopPropagation()}
                >
                  <button
                    style={menuItemStyle}
                    onMouseEnter={menuHoverIn}
                    onMouseLeave={menuHoverOut}
                    onClick={async () => {
                      setMenuOpen(null);
                      showToast("Opening VS Code...");
                      try { await api.openVscode(sessionId!, agent.id); } catch (err: any) { showToast(`Failed: ${err.message}`); }
                    }}
                  >
                    Open in VS Code
                  </button>
                  <div style={{ height: 1, background: "var(--border-color)", margin: "4px 0" }} />
                  <button
                    style={menuItemStyle}
                    onMouseEnter={menuHoverIn}
                    onMouseLeave={menuHoverOut}
                    onClick={() => handleOpenSendMessage(agent.id)}
                  >
                    Send Message
                  </button>
                  <button
                    style={menuItemStyle}
                    onMouseEnter={menuHoverIn}
                    onMouseLeave={menuHoverOut}
                    onClick={() => handleOpenReplace(agent)}
                  >
                    Replace
                  </button>
                  <button
                    style={menuItemStyle}
                    onMouseEnter={menuHoverIn}
                    onMouseLeave={menuHoverOut}
                    onClick={() => handleRestart(agent.id)}
                  >
                    Restart
                  </button>
                  <div style={{ height: 1, background: "var(--border-color)", margin: "4px 0" }} />
                  <button
                    style={{ ...menuItemStyle, color: "var(--accent-red)" }}
                    onMouseEnter={menuHoverIn}
                    onMouseLeave={menuHoverOut}
                    onClick={() => handleRemove(agent.id)}
                  >
                    Remove
                  </button>
                </div>
              )}
            </div>
          </div>
        )}
      >
        <div
          className={fullscreenAgentId === agent.id ? "agent-panel-fullscreen" : undefined}
          style={{ display: "flex", flexDirection: "column", height: "100%" }}
          onClick={() => setFocusedPanel(agent.id)}
        >
          {/* Fullscreen header — only shown when this tile is in fullscreen */}
          {fullscreenAgentId === agent.id && (
            <div style={{
              display: 'flex', alignItems: 'center', gap: 12,
              padding: '8px 16px', background: 'var(--bg-secondary)',
              borderBottom: '1px solid var(--border-color)', flexShrink: 0,
            }}>
              <span className={`agent-status-dot ${getStatusDotClass(agent.status)}`} style={{ width: 10, height: 10 }} />
              <span style={{ fontWeight: 600, fontSize: 16 }}>{agent.config?.name || agent.name || "Agent"}</span>
              <span style={{ color: 'var(--text-secondary)', fontSize: 12 }}>{agent.provider}/{agent.model}</span>
              <span style={{ color: 'var(--text-secondary)', fontSize: 12 }}>
                In: {formatTokens(tokenIn)} | Out: {formatTokens(tokenOut)} | {formatCost(cost)}
              </span>
              <span style={{ color: agent.status === 'running' ? '#3fb950' : '#8b949e', fontSize: 12 }}>{agent.status}</span>
              <div style={{ flex: 1 }} />
              <button
                onClick={() => toggleFullscreen(agent.id)}
                style={{
                  background: 'var(--bg-tertiary)', border: '1px solid var(--border-color)',
                  color: 'var(--text-primary)', padding: '6px 16px', borderRadius: 6,
                  cursor: 'pointer', fontSize: 13, fontWeight: 500,
                }}
              >
                &larr; Exit Fullscreen
              </button>
              {/* Gear menu in fullscreen header */}
              <div style={{ position: "relative" }}>
                <button
                  onClick={(e) => { e.stopPropagation(); setMenuOpen(menuOpen === agent.id ? null : agent.id); }}
                  style={{
                    background: 'var(--bg-tertiary)', border: '1px solid var(--border-color)', color: 'var(--text-primary)',
                    width: 32, height: 32, borderRadius: 6, cursor: 'pointer',
                    display: 'flex', alignItems: 'center', justifyContent: 'center',
                  }}
                >
                  <span style={{ fontSize: 18, lineHeight: 1, letterSpacing: 0 }}>&#8942;</span>
                </button>
                {menuOpen === agent.id && (
                  <div
                    style={{
                      position: "absolute", top: "100%", right: 0,
                      background: "var(--bg-secondary)", border: "1px solid var(--border-color)",
                      borderRadius: 6, padding: 4, zIndex: 51, minWidth: 140,
                      boxShadow: "0 8px 24px rgba(0,0,0,0.4)",
                    }}
                    onClick={(e) => e.stopPropagation()}
                  >
                    <button style={menuItemStyle} onMouseEnter={menuHoverIn} onMouseLeave={menuHoverOut} onClick={async () => { setMenuOpen(null); showToast("Opening VS Code..."); try { await api.openVscode(sessionId!, agent.id); } catch (err: any) { showToast(`Failed: ${err.message}`); } }}>Open in VS Code</button>
                    <div style={{ height: 1, background: "var(--border-color)", margin: "4px 0" }} />
                    <button style={menuItemStyle} onMouseEnter={menuHoverIn} onMouseLeave={menuHoverOut} onClick={() => handleOpenSendMessage(agent.id)}>Send Message</button>
                    <button style={menuItemStyle} onMouseEnter={menuHoverIn} onMouseLeave={menuHoverOut} onClick={() => handleOpenReplace(agent)}>Replace</button>
                    <button style={menuItemStyle} onMouseEnter={menuHoverIn} onMouseLeave={menuHoverOut} onClick={() => handleRestart(agent.id)}>Restart</button>
                    <div style={{ height: 1, background: "var(--border-color)", margin: "4px 0" }} />
                    <button style={{ ...menuItemStyle, color: "var(--accent-red)" }} onMouseEnter={menuHoverIn} onMouseLeave={menuHoverOut} onClick={() => handleRemove(agent.id)}>Remove</button>
                  </div>
                )}
              </div>
            </div>
          )}

          {/* Inline send message input */}
          {inlineMsgOpen === agent.id && (
            <div className="mosaic-panel-inline-msg">
              <input
                style={{ flex: 1, fontSize: 12, padding: "4px 8px" }}
                placeholder="Type message to this agent..."
                value={messages[agent.id] || ""}
                autoFocus
                onChange={(e) =>
                  setMessages((prev) => ({ ...prev, [agent.id]: e.target.value }))
                }
                onKeyDown={(e) => {
                  if (e.key === "Enter") {
                    e.preventDefault();
                    handleSendMessage(agent.id);
                  }
                  if (e.key === "Escape") {
                    setInlineMsgOpen(null);
                  }
                }}
                onClick={(e) => e.stopPropagation()}
                disabled={sendingMap[agent.id]}
              />
              <button
                style={{ fontSize: 12, padding: "4px 10px" }}
                onClick={(e) => {
                  e.stopPropagation();
                  handleSendMessage(agent.id);
                }}
                disabled={sendingMap[agent.id] || !messages[agent.id]?.trim()}
              >
                {sendingMap[agent.id] ? "..." : "Send"}
              </button>
              <button
                style={{ fontSize: 12, padding: "4px 8px", background: "transparent", border: "1px solid var(--border-color)", borderRadius: 4, color: "var(--text-muted)", cursor: "pointer" }}
                onClick={(e) => {
                  e.stopPropagation();
                  setInlineMsgOpen(null);
                }}
              >
                X
              </button>
            </div>
          )}

          {/* Crashed overlay hint */}
          {isCrashed && (
            <div className="mosaic-panel-crashed-hint">
              Crashed -- click gear to restart
            </div>
          )}

          {/* Terminal fills remaining space — always mounted to preserve scroll buffer */}
          <div className="agent-panel-terminal" style={{ flex: 1, minHeight: 0, overflow: "hidden" }}>
            <AgentTerminal
              sessionId={sessionId!}
              agentId={agent.id}
              height="100%"
            />
          </div>

          {/* Chat input */}
          <div className="mosaic-panel-input">
            <select
              style={{
                fontSize: 12,
                padding: "4px 8px",
                background: "var(--bg-tertiary)",
                border: "1px solid var(--border-color)",
                borderRadius: 4,
                color: "var(--text-primary)",
                cursor: "pointer",
                maxWidth: 120,
              }}
              title="Send as"
              value={sendAsMap[agent.id] || ""}
              onChange={(e) => {
                e.stopPropagation();
                setSendAsMap((prev) => ({ ...prev, [agent.id]: e.target.value }));
              }}
              onClick={(e) => e.stopPropagation()}
            >
              <option value="">User</option>
              {agents
                .filter((a) => a.id !== agent.id && (a.status === "running" || a.status === "idle" || a.status === "waiting"))
                .map((a) => (
                  <option key={a.id} value={a.id}>
                    {a.config?.name || a.name || a.id}
                  </option>
                ))}
            </select>
            <input
              style={{ flex: 1, fontSize: 12, padding: "4px 8px" }}
              placeholder={sendAsMap[agent.id] ? `Message as ${agents.find(a => a.id === sendAsMap[agent.id])?.config?.name || "agent"}...` : "Type message..."}
              value={messages[agent.id] || ""}
              onChange={(e) =>
                setMessages((prev) => ({ ...prev, [agent.id]: e.target.value }))
              }
              onKeyDown={(e) => {
                e.stopPropagation();
                if (e.key === "Enter") {
                  e.preventDefault();
                  handleSendMessage(agent.id);
                }
              }}
              onClick={(e) => e.stopPropagation()}
              onFocus={(e) => e.stopPropagation()}
              disabled={sendingMap[agent.id]}
            />
            <button
              style={{ fontSize: 12, padding: "4px 10px" }}
              onClick={(e) => {
                e.stopPropagation();
                handleSendMessage(agent.id);
              }}
              disabled={sendingMap[agent.id] || !messages[agent.id]?.trim()}
            >
              {sendingMap[agent.id] ? "..." : "\u23CE"}
            </button>
          </div>
        </div>
      </MosaicWindow>
    );
  }, [sessionId, agents, focusedPanel, menuOpen, inlineMsgOpen, messages, sendingMap, sendAsMap, fullscreenAgentId, flashingAgents]); // eslint-disable-line react-hooks/exhaustive-deps

  /* Fullscreen is now handled by CSS class on the mosaic tile — no separate overlay needed */

  if (loading) {
    return (
      <div
        style={{
          height: "100vh",
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
          color: "var(--text-secondary)",
        }}
      >
        Loading session...
      </div>
    );
  }

  return (
    <div style={{ height: "100vh", display: "flex", flexDirection: "column", background: "var(--bg-primary)", position: "relative" }}>
      {/* Header */}
      <div
        style={{
          padding: "12px 16px",
          display: "flex",
          alignItems: "center",
          justifyContent: "space-between",
          borderBottom: "1px solid var(--border-color)",
          background: "var(--bg-secondary)",
          flexShrink: 0,
        }}
      >
        <div style={{ display: "flex", alignItems: "center", gap: 12 }}>
          <Link
            to={`/session/${sessionId}`}
            style={{ color: "var(--accent-blue)", fontSize: 13, textDecoration: "none" }}
          >
            &larr; Back to Session
          </Link>
          <h1 style={{ fontSize: 18, fontWeight: 600, margin: 0 }}>
            {session?.name || "Session"} -- Command Center
          </h1>
        </div>
        <div style={{ display: "flex", alignItems: "center", gap: 12 }}>
          <span style={{ fontSize: 13, color: "var(--text-secondary)" }}>
            {agents.length} agent{agents.length !== 1 ? "s" : ""}
            {agents.length > 0 && (
              <span style={{ color: "var(--text-muted)", marginLeft: 4 }}>
                ({runningCount} running{crashedCount > 0 ? `, ${crashedCount} crashed` : ""})
              </span>
            )}
          </span>
          <button
            onClick={async () => {
              const running = agents.filter(a => a.status === "running");
              if (running.length === 0) { showToast("No running agents to restart."); return; }
              if (!confirm(`This will restart all ${running.length} agents with fresh sessions. They'll pick up the latest configuration. Continue?`)) return;
              try {
                const result = await api.restartAllAgents(sessionId!);
                showToast(`Restarted ${result.restarted} agent(s)`);
                loadData();
              } catch (err: any) {
                showToast(`Failed: ${err.message}`);
              }
            }}
            style={{
              background: "var(--accent-yellow)",
              border: "none",
              color: "#1f2328",
              fontWeight: 600,
              padding: "5px 12px",
              borderRadius: 6,
              cursor: "pointer",
              fontSize: 12,
            }}
          >
            Restart All
          </button>
        </div>
      </div>

      {/* Broadcast Bar + Add Agent */}
      <div className="broadcast-bar">
        <span style={{ fontSize: 14, flexShrink: 0 }}>Broadcast to all agents:</span>
        <input
          ref={broadcastInputRef}
          placeholder="Type message..."
          value={broadcastMsg}
          onChange={(e) => setBroadcastMsg(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter") {
              e.preventDefault();
              handleBroadcast();
            }
          }}
          disabled={broadcasting}
        />
        <button
          className={broadcasting ? "broadcast-sending" : ""}
          onClick={handleBroadcast}
          disabled={broadcasting || !broadcastMsg.trim()}
        >
          {broadcasting ? "Sending..." : "Send to All"}
        </button>

        {/* Add Agent button */}
        <button
          className="split-add-agent-btn"
          onClick={() => setShowSpawnDialog(true)}
        >
          + Add Agent
        </button>

        {/* Add Terminal button */}
        <button
          className="split-add-agent-btn"
          onClick={handleAddTerminal}
          disabled={isCreatingTerminal}
          style={isCreatingTerminal ? { opacity: 0.6, cursor: "wait" } : undefined}
        >
          {isCreatingTerminal ? "Opening..." : "+ Terminal"}
        </button>

        {/* Add Editor button */}
        <button
          className="split-add-agent-btn"
          onClick={handleAddEditor}
        >
          + Editor
        </button>

        {/* Layouts dropdown */}
        <div style={{ position: "relative" }}>
          <button
            onClick={(e) => { e.stopPropagation(); setShowLayoutMenu(!showLayoutMenu); }}
            className="split-add-agent-btn"
          >
            Layouts &#9662;
          </button>
          {showLayoutMenu && (
            <div
              style={{
                position: "absolute", top: "100%", right: 0, zIndex: 50,
                background: "var(--bg-secondary)", border: "1px solid var(--border-color)", borderRadius: 8,
                minWidth: 200, padding: 4, boxShadow: "0 8px 24px rgba(0,0,0,0.3)",
              }}
              onClick={(e) => e.stopPropagation()}
            >
              <div
                onClick={() => {
                  // Reset: rebuild balanced grid from all current leaf IDs
                  const currentIds = getLeafIds(mosaicValue);
                  const validIds = currentIds.filter(id => {
                    if (id.startsWith("term-") || id.startsWith("editor-")) return true;
                    return agents.some(a => a.id === id);
                  });
                  if (validIds.length > 0) {
                    setMosaicValue(buildInitialMosaic(validIds));
                    setTimeout(() => window.dispatchEvent(new Event("resize")), 200);
                    setTimeout(() => window.dispatchEvent(new Event("resize")), 500);
                  }
                  setShowLayoutMenu(false);
                }}
                style={{ padding: "8px 12px", cursor: "pointer", color: "#58a6ff", fontSize: 13 }}
                onMouseEnter={(e) => (e.currentTarget.style.background = "rgba(255,255,255,0.06)")}
                onMouseLeave={(e) => (e.currentTarget.style.background = "transparent")}
              >
                Reset to Grid
              </div>
              <div
                onClick={saveCurrentLayout}
                style={{ padding: "8px 12px", cursor: "pointer", color: "#3fb950", fontSize: 13 }}
                onMouseEnter={(e) => (e.currentTarget.style.background = "rgba(255,255,255,0.06)")}
                onMouseLeave={(e) => (e.currentTarget.style.background = "transparent")}
              >
                Save Current Layout
              </div>
              <div style={{ borderTop: "1px solid #30363d", margin: "4px 0" }} />
              {Object.keys(savedLayouts).length === 0 ? (
                <div style={{ padding: "8px 12px", color: "var(--text-muted)", fontSize: 12 }}>No saved layouts</div>
              ) : (
                Object.keys(savedLayouts).map(name => (
                  <div key={name} style={{
                    padding: "6px 12px", display: "flex", alignItems: "center", justifyContent: "space-between",
                    cursor: "pointer", fontSize: 13, color: "var(--text-primary)",
                  }}
                    onMouseEnter={(e) => (e.currentTarget.style.background = "rgba(255,255,255,0.06)")}
                    onMouseLeave={(e) => (e.currentTarget.style.background = "transparent")}
                  >
                    <span onClick={() => loadLayout(name)} style={{ flex: 1 }}>{name}</span>
                    <span
                      onClick={(e) => { e.stopPropagation(); deleteLayout(name); }}
                      style={{ color: "#f85149", cursor: "pointer", fontSize: 11, padding: "2px 4px" }}
                    >{"\u00D7"}</span>
                  </div>
                ))
              )}
            </div>
          )}
        </div>
      </div>

      {/* Mosaic Tiling Area */}
      <div className="mosaic-container" style={{ flex: 1, minHeight: 0, overflow: "hidden" }}>
        {mosaicValue ? (
          <Mosaic<string>
            value={mosaicValue}
            onChange={(newValue) => {
              // Protect terminal tiles from being lost during drag operations
              // If the new value lost a terminal tile that existed before, something went wrong
              if (newValue && mosaicValue) {
                const oldIds = getLeafIds(mosaicValue);
                const newIds = getLeafIds(newValue);
                const lostTerminals = oldIds.filter(id => id.startsWith("term-") && !newIds.includes(id));
                const lostEditors = oldIds.filter(id => id.startsWith("editor-") && !newIds.includes(id));
                const lostSpecial = [...lostTerminals, ...lostEditors];
                if (lostSpecial.length > 0) {
                  // Terminal/editor was removed by the drag — re-add it
                  let restored: MosaicNode<string> = newValue;
                  for (const tileId of lostSpecial) {
                    restored = { type: "split", direction: "row", children: [restored, tileId], splitPercentages: [80, 20] };
                  }
                  setMosaicValue(restored);
                } else {
                  setMosaicValue(newValue);
                }
              } else {
                setMosaicValue(newValue);
              }
              setTimeout(() => window.dispatchEvent(new Event("resize")), 200);
              setTimeout(() => window.dispatchEvent(new Event("resize")), 500);
            }}
            renderTile={renderTile}
            className="kora-mosaic-theme"
          />
        ) : (
          <div className="mosaic-empty-state">
            <span style={{ fontSize: 32, lineHeight: 1, marginBottom: 8 }}>+</span>
            <span>No agents yet. Click "+ Add Agent" above to get started.</span>
          </div>
        )}
      </div>

      {/* Fullscreen is now handled via CSS on the mosaic tile itself — no separate overlay needed */}

      {/* Toast notification */}
      {toast && (
        <div className="toast-notification">{toast}</div>
      )}

      {/* Spawn Agent Dialog */}
      {showSpawnDialog && sessionId && (
        <SpawnAgentDialog
          sessionId={sessionId}
          onClose={() => setShowSpawnDialog(false)}
          onSpawned={handleSpawned}
        />
      )}

      {/* Replace Agent Dialog */}
      {replaceTarget && sessionId && (
        <ReplaceAgentDialog
          sessionId={sessionId}
          agentId={replaceTarget.id}
          agentName={replaceTarget.name}
          onClose={() => setReplaceTarget(null)}
          onReplaced={handleReplaced}
        />
      )}
    </div>
  );
}

/* ---- Shared menu-item styles ---- */

const menuItemStyle: React.CSSProperties = {
  display: "block",
  width: "100%",
  textAlign: "left",
  background: "none",
  border: "none",
  padding: "6px 10px",
  fontSize: 12,
  color: "var(--text-primary)",
  cursor: "pointer",
  borderRadius: 4,
};

function menuHoverIn(e: React.MouseEvent<HTMLButtonElement>) {
  (e.currentTarget as HTMLButtonElement).style.background = "var(--bg-tertiary)";
}

function menuHoverOut(e: React.MouseEvent<HTMLButtonElement>) {
  (e.currentTarget as HTMLButtonElement).style.background = "none";
}
