import React, { useEffect, useRef, useState, useCallback } from "react";
import { useThemeStore } from "../stores/themeStore";
import { getOrCreateTerminal, detachTerminal } from "../stores/terminalRegistry";
import "@xterm/xterm/css/xterm.css";

interface AgentTerminalProps {
  sessionId: string;
  agentId: string;
  height?: string;
}

export const AgentTerminal = React.memo(function AgentTerminal({ sessionId, agentId, height = "400px" }: AgentTerminalProps) {
  const wrapperRef = useRef<HTMLDivElement>(null);
  const resizeTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const [connected, setConnected] = useState(false);
  const resolvedTerminalColors = useThemeStore((s) => s.resolvedTerminalColors);

  const handleResize = useCallback((entry: ReturnType<typeof getOrCreateTerminal>) => {
    if (resizeTimer.current) clearTimeout(resizeTimer.current);
    resizeTimer.current = setTimeout(() => {
      entry.fitAddon.fit();
      if (entry.ws?.readyState === WebSocket.OPEN) {
        entry.ws.send(JSON.stringify({
          type: "resize",
          cols: entry.term.cols,
          rows: entry.term.rows,
        }));
      }
    }, 150);
  }, []);

  useEffect(() => {
    if (!wrapperRef.current) return;

    const entry = getOrCreateTerminal(sessionId, agentId, resolvedTerminalColors);

    // Set connected state callback
    entry.onConnectedChange = setConnected;
    setConnected(entry.connected);

    // Attach the terminal container to our wrapper div
    wrapperRef.current.appendChild(entry.container);

    // Fit after attaching
    requestAnimationFrame(() => {
      entry.fitAddon.fit();
    });

    // Resize observer
    const resizeObserver = new ResizeObserver(() => handleResize(entry));
    resizeObserver.observe(wrapperRef.current);

    // Window resize listener
    const onWindowResize = () => handleResize(entry);
    window.addEventListener("resize", onWindowResize);

    return () => {
      // Detach but keep alive in registry
      entry.onConnectedChange = undefined;
      resizeObserver.disconnect();
      window.removeEventListener("resize", onWindowResize);
      if (resizeTimer.current) clearTimeout(resizeTimer.current);
      detachTerminal(sessionId, agentId);
    };
  }, [sessionId, agentId, handleResize]);

  // Apply theme changes to existing terminal
  useEffect(() => {
    const entry = getOrCreateTerminal(sessionId, agentId, resolvedTerminalColors);
    entry.term.options.theme = resolvedTerminalColors;
  }, [resolvedTerminalColors, sessionId, agentId]);

  return (
    <div style={{ position: "relative", display: "flex", flexDirection: "column", flex: 1, minHeight: 0, height }}>
      <div style={{
        position: "absolute", top: 8, right: 12, zIndex: 10,
        display: "flex", alignItems: "center", gap: 6,
        fontSize: 12, color: connected ? "var(--accent-green)" : "var(--accent-red)",
        pointerEvents: "none",
      }}>
        <span style={{
          width: 8, height: 8, borderRadius: "50%",
          backgroundColor: connected ? "var(--accent-green)" : "var(--accent-red)",
          display: "inline-block",
          animation: connected ? "pulse 2s ease-in-out infinite" : "none",
        }} />
        {connected ? "Live" : "Reconnecting..."}
      </div>
      <div ref={wrapperRef} style={{
        flex: 1, minHeight: 0,
        background: resolvedTerminalColors.background,
        borderRadius: 8,
        padding: "4px 4px 4px 8px",
        overflow: "hidden",
        touchAction: "pan-y",
      }} />
    </div>
  );
});
