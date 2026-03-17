import { useState, useRef, useCallback, useEffect } from "react";
import { AgentTerminal } from "./AgentTerminal";

export interface TerminalTab {
  id: string;          // agent ID or "term-{uuid}"
  name: string;        // "Architect" or "Terminal 1"
  type: "agent" | "terminal";  // agent terminal vs plain shell
}

interface SideTerminalPanelProps {
  sessionId: string;
  tabs: TerminalTab[];
  height: number;
  onHeightChange: (height: number) => void;
  onClose: () => void;
  onCloseTab: (tabId: string) => void;
  onAddTerminal: () => void;
}

export function SideTerminalPanel({
  sessionId,
  tabs,
  height,
  onHeightChange,
  onClose,
  onCloseTab,
  onAddTerminal,
}: SideTerminalPanelProps) {
  const [activeTabId, setActiveTabId] = useState<string>(tabs[0]?.id || "");
  const dragging = useRef(false);
  const startY = useRef(0);
  const startHeight = useRef(0);

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

      {/* Tab bar + add button + close panel button */}
      <div style={{ display: "flex", alignItems: "center" }}>
        <div className="side-terminal-tabs" style={{ flex: 1 }}>
          {tabs.map((tab) => (
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
              <span
                className="close-tab"
                onClick={(e) => {
                  e.stopPropagation();
                  onCloseTab(tab.id);
                }}
                title="Close tab"
              >
                &times;
              </span>
            </div>
          ))}
          <button
            className="side-terminal-add-tab"
            onClick={onAddTerminal}
            title="New terminal"
          >
            +
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
