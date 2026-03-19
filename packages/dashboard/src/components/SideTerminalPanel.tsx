import { useState, useRef, useCallback, useEffect, useMemo } from "react";
import { AgentTerminal } from "./AgentTerminal";
import { useTerminalSessionStore } from "../stores/terminalSessionStore";
import { useApi } from "../hooks/useApi";
import { setMessageNotificationCallback } from "../stores/terminalRegistry";
import { Badge } from "@mantine/core";

export interface TerminalTab {
  id: string;          // agent ID or "term-{uuid}"
  name: string;        // "Architect" or "Terminal 1"
  type: "agent" | "terminal";  // agent terminal vs plain shell
}

interface SideTerminalPanelProps {
  sessionId: string;
  height: number;
  onHeightChange: (height: number) => void;
  onClose: () => void;
}

export function SideTerminalPanel({
  sessionId,
  height,
  onHeightChange,
  onClose,
}: SideTerminalPanelProps) {
  const [activeTabId, setActiveTabId] = useState<string>("");
  const [isCreatingTerminal, setIsCreatingTerminal] = useState(false);
  const [recentNotification, setRecentNotification] = useState<{ terminalName: string; from: string } | null>(null);
  const notificationTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const dragging = useRef(false);
  const startY = useRef(0);
  const startHeight = useRef(0);
  const api = useApi();

  // Use store for terminal sessions and open tabs
  const terminalSessionsMap = useTerminalSessionStore((state) => state.sessions);
  const terminalSessions = useMemo(() => Array.from(terminalSessionsMap.values()), [terminalSessionsMap]);
  const openTabIds = useTerminalSessionStore((state) => state.openTabs);
  const addSession = useTerminalSessionStore((state) => state.addSession);
  const closeTab = useTerminalSessionStore((state) => state.closeTab);
  const openTab = useTerminalSessionStore((state) => state.openTab);
  const incrementUnread = useTerminalSessionStore((state) => state.incrementUnread);
  const clearUnread = useTerminalSessionStore((state) => state.clearUnread);

  // Build tab list from open tabs and sessions
  const tabs: TerminalTab[] = openTabIds
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

  // Fetch all terminals from server on mount
  useEffect(() => {
    async function fetchTerminals() {
      try {
        const data = await api.getTerminals(sessionId);
        if (data?.terminals) {
          data.terminals.forEach((term: any) => {
            addSession({
              id: term.id,
              tmuxSession: term.tmuxSession,
              name: term.name || `Terminal ${term.id}`,
              type: term.type || "standalone",
              agentName: term.agentName,
              createdAt: term.createdAt || new Date().toISOString(),
            });
          });
        }
      } catch (err) {
        console.debug("Could not fetch terminals from server:", err);
      }
    }
    fetchTerminals();
  }, [sessionId]); // Zustand actions are stable, addSession not needed in deps

  // If tabs list changes and activeTabId is gone, switch to first
  useEffect(() => {
    if (tabs.length > 0 && !tabs.find((t) => t.id === activeTabId)) {
      setActiveTabId(tabs[0].id);
    }
  }, [tabs, activeTabId]);

  // Auto-select newly added tab
  useEffect(() => {
    if (tabs.length > 0) {
      setActiveTabId(tabs[tabs.length - 1].id);
    }
  }, [tabs.length]);

  // Set up message notification callbacks for all open terminals
  useEffect(() => {
    tabs.forEach((tab) => {
      setMessageNotificationCallback(sessionId, tab.id, (from) => {
        // Only increment if this tab is not currently active
        if (tab.id !== activeTabId) {
          incrementUnread(tab.id);

          // Show brief notification toast
          setRecentNotification({ terminalName: tab.name, from });
          if (notificationTimer.current) {
            clearTimeout(notificationTimer.current);
          }
          notificationTimer.current = setTimeout(() => {
            setRecentNotification(null);
          }, 4000);
        }
      });
    });

    // Cleanup callbacks when component unmounts
    return () => {
      tabs.forEach((tab) => {
        setMessageNotificationCallback(sessionId, tab.id, undefined);
      });
      if (notificationTimer.current) {
        clearTimeout(notificationTimer.current);
      }
    };
  }, [tabs, sessionId, activeTabId, incrementUnread]);

  // Clear unread count when active tab changes
  useEffect(() => {
    if (activeTabId) {
      clearUnread(activeTabId);
    }
  }, [activeTabId, clearUnread]);

  const handleMouseDown = useCallback(
    (e: React.MouseEvent) => {
      e.preventDefault();
      dragging.current = true;
      startY.current = e.clientY;
      startHeight.current = height;

      const handleMouseMove = (ev: MouseEvent) => {
        if (!dragging.current) return;
        const delta = startY.current - ev.clientY;
        const newHeight = Math.max(150, Math.min(window.innerHeight * 0.8, startHeight.current + delta));
        onHeightChange(newHeight);
      };

      const handleMouseUp = () => {
        dragging.current = false;
        document.removeEventListener("mousemove", handleMouseMove);
        document.removeEventListener("mouseup", handleMouseUp);
      };

      document.addEventListener("mousemove", handleMouseMove);
      document.addEventListener("mouseup", handleMouseUp);
    },
    [height, onHeightChange]
  );

  if (tabs.length === 0) return null;

  return (
    <div className="side-terminal" style={{ height }}>
      {/* Drag handle */}
      <div className="side-terminal-handle" onMouseDown={handleMouseDown} />

      {/* Message notification toast */}
      {recentNotification && (
        <div
          className="message-notification-toast"
          onClick={() => {
            // Click to focus the terminal
            const terminalId = tabs.find(t => t.name === recentNotification.terminalName)?.id;
            if (terminalId) {
              setActiveTabId(terminalId);
              setRecentNotification(null);
            }
          }}
          style={{
            position: "absolute",
            top: 40,
            right: 12,
            zIndex: 100,
            backgroundColor: "var(--accent-blue)",
            color: "white",
            padding: "8px 12px 8px 12px",
            borderRadius: 6,
            fontSize: 12,
            fontWeight: 500,
            boxShadow: "0 2px 8px rgba(0,0,0,0.3)",
            animation: "slideIn 0.2s ease-out",
            cursor: "pointer",
            display: "flex",
            alignItems: "center",
            gap: 8,
            transition: "background-color 0.15s",
            maxWidth: "400px",
          }}
          onMouseEnter={(e) => {
            e.currentTarget.style.backgroundColor = "var(--accent-blue-hover, #4a8fd8)";
          }}
          onMouseLeave={(e) => {
            e.currentTarget.style.backgroundColor = "var(--accent-blue)";
          }}
        >
          <span style={{ flex: 1 }}>
            📩 New message from {recentNotification.from} in {recentNotification.terminalName}
          </span>
          <button
            onClick={(e) => {
              e.stopPropagation();
              setRecentNotification(null);
              if (notificationTimer.current) {
                clearTimeout(notificationTimer.current);
              }
            }}
            style={{
              background: "none",
              border: "none",
              color: "white",
              cursor: "pointer",
              padding: "2px 4px",
              fontSize: 16,
              lineHeight: 1,
              opacity: 0.8,
              display: "flex",
              alignItems: "center",
              justifyContent: "center",
            }}
            onMouseEnter={(e) => {
              e.currentTarget.style.opacity = "1";
            }}
            onMouseLeave={(e) => {
              e.currentTarget.style.opacity = "0.8";
            }}
            title="Dismiss"
          >
            ×
          </button>
        </div>
      )}

      {/* Tab bar + add button + close panel button */}
      <div style={{ display: "flex", alignItems: "center" }}>
        <div className="side-terminal-tabs" style={{ flex: 1 }}>
          {tabs.map((tab) => {
            const session = terminalSessions.find((s) => s.id === tab.id);
            const unreadCount = session?.unreadCount || 0;

            return (
              <div
                key={tab.id}
                className={`side-terminal-tab${activeTabId === tab.id ? " active" : ""}`}
                data-type={tab.type}
                onClick={() => setActiveTabId(tab.id)}
              >
                <span className="tab-icon">
                  {tab.type === "agent" ? "\u25CF" : "\u25A0"}
                </span>
                {tab.name}
                {unreadCount > 0 && (
                  <Badge
                    size="sm"
                    color="blue"
                    variant="filled"
                    style={{
                      marginLeft: 6,
                      fontSize: 10,
                      height: 16,
                      minWidth: 16,
                      padding: "0 5px",
                      display: "flex",
                      alignItems: "center",
                      justifyContent: "center",
                    }}
                    title={`${unreadCount} unread message${unreadCount !== 1 ? 's' : ''}`}
                  >
                    {unreadCount >= 10 ? "9+" : unreadCount}
                  </Badge>
                )}
                <span
                  className="close-tab"
                  onClick={(e) => {
                    e.stopPropagation();
                    closeTab(tab.id);
                  }}
                  title="Close tab"
                >
                  &times;
                </span>
              </div>
            );
          })}
          <button
            className="side-terminal-add-tab"
            onClick={async () => {
              if (isCreatingTerminal) return;
              setIsCreatingTerminal(true);
              try {
                // Create new standalone terminal
                const result = await api.openTerminal(sessionId);
                const terminalName = `Terminal ${terminalSessions.filter((t) => t.type === "standalone").length + 1}`;

                // Add to session store
                addSession({
                  id: result.id,
                  tmuxSession: result.tmuxSession,
                  name: terminalName,
                  type: "standalone",
                  createdAt: new Date().toISOString(),
                });

                // Open tab
                openTab(result.id);
              } catch (err: any) {
                console.error("Failed to create terminal:", err);
              } finally {
                setIsCreatingTerminal(false);
              }
            }}
            title="New terminal"
            disabled={isCreatingTerminal}
            style={{
              opacity: isCreatingTerminal ? 0.6 : 1,
              cursor: isCreatingTerminal ? "wait" : "pointer",
            }}
          >
            {isCreatingTerminal ? "..." : "+"}
          </button>
        </div>
        <button
          onClick={onClose}
          style={{
            background: "none",
            border: "none",
            color: "var(--text-secondary)",
            cursor: "pointer",
            padding: "6px 12px",
            fontSize: 16,
            lineHeight: 1,
          }}
          title="Close terminal panel"
        >
          &times;
        </button>
      </div>

      {/* Terminal content */}
      <div style={{ flex: 1, minHeight: 0, height: height - 40 }}>
        {tabs
          .filter((t) => t.id === activeTabId)
          .map((t) => (
            <AgentTerminal
              key={t.id}
              sessionId={sessionId}
              agentId={t.id}
              height="100%"
            />
          ))}
      </div>
    </div>
  );
}
