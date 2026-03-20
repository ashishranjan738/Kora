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
  const [hasData, setHasData] = useState(false);
  const [scrolledUp, setScrolledUp] = useState(false);
  const [manuallyPaused, setManuallyPaused] = useState(false);
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
    entry.onConnectedChange = (c) => {
      setConnected(c);
      if (c) {
        // Mark as having data after a brief delay (content starts streaming)
        setTimeout(() => setHasData(true), 200);
      }
    };
    // Set scroll state callback — tracks when user scrolls away from bottom
    entry.onScrollStateChange = (isScrolledUp) => {
      setScrolledUp(isScrolledUp);
    };
    setConnected(entry.connected);
    setScrolledUp(entry.userScrolledUp);
    // If already connected or terminal has content, mark as having data
    if (entry.connected || entry.term.buffer.active.length > 1) {
      setHasData(true);
    }

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
      entry.onScrollStateChange = undefined;
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

  const showLoading = !connected && !hasData;

  // Tail controls
  function handleResumeLiveFeed() {
    const entry = getOrCreateTerminal(sessionId, agentId, resolvedTerminalColors);
    entry.term.scrollToBottom();
    entry.userScrolledUp = false;
    entry.manuallyPaused = false;
    setScrolledUp(false);
    setManuallyPaused(false);
  }

  function handleToggleManualPause() {
    const entry = getOrCreateTerminal(sessionId, agentId, resolvedTerminalColors);
    if (manuallyPaused) {
      // Resume
      entry.manuallyPaused = false;
      setManuallyPaused(false);
      entry.term.scrollToBottom();
    } else {
      // Pause
      entry.manuallyPaused = true;
      setManuallyPaused(true);
    }
  }

  // Determine Tail visual state
  const isFollowing = !scrolledUp && !manuallyPaused;

  return (
    <div style={{ position: "relative", display: "flex", flexDirection: "column", flex: 1, minHeight: 0, height }}>
      {/* Stacked status badges — top-left */}
      <div style={{
        position: "absolute", top: 8, right: 12, zIndex: 10,
        display: "flex", flexDirection: "row", gap: 6, alignItems: "center",
      }}>
        {/* Live connection badge */}
        <div style={{
          display: "inline-flex", alignItems: "center", gap: 5,
          padding: "3px 10px", borderRadius: 12, fontSize: 11, fontWeight: 500,
          background: connected ? "rgba(63, 185, 80, 0.15)" : "rgba(248, 81, 73, 0.15)",
          color: connected ? "var(--accent-green)" : "var(--accent-red)",
          border: `1px solid ${connected ? "rgba(63, 185, 80, 0.3)" : "rgba(248, 81, 73, 0.3)"}`,
          pointerEvents: "none",
          width: "fit-content",
        }}>
          <span style={{
            width: 6, height: 6, borderRadius: "50%",
            backgroundColor: connected ? "var(--accent-green)" : "var(--accent-red)",
            display: "inline-block",
            animation: connected ? "pulse 2s ease-in-out infinite" : "none",
          }} />
          {connected ? "Live" : "Reconnecting"}
        </div>

        {/* Tail badge */}
        {hasData && (
          <button
            onClick={scrolledUp ? handleResumeLiveFeed : handleToggleManualPause}
            style={{
              display: "inline-flex", alignItems: "center", gap: 5,
              padding: "3px 10px", borderRadius: 12, fontSize: 11, fontWeight: 500,
              background: isFollowing
                ? "rgba(88, 166, 255, 0.15)"
                : manuallyPaused
                  ? "rgba(210, 153, 34, 0.15)"
                  : "rgba(139, 148, 158, 0.15)",
              color: isFollowing
                ? "var(--accent-blue)"
                : manuallyPaused
                  ? "var(--accent-yellow)"
                  : "var(--text-secondary)",
              border: `1px solid ${isFollowing
                ? "rgba(88, 166, 255, 0.3)"
                : manuallyPaused
                  ? "rgba(210, 153, 34, 0.3)"
                  : "rgba(139, 148, 158, 0.3)"}`,
              cursor: "pointer",
              width: "fit-content",
              transition: "all 0.2s ease",
            }}
            title={scrolledUp ? "Jump to bottom and resume tailing" : manuallyPaused ? "Resume tailing" : "Pause tailing"}
          >
            {scrolledUp ? (
              <>{"\u2193"} Tail</>
            ) : manuallyPaused ? (
              <>{"\u23F8"} Paused</>
            ) : (
              <><span style={{ width: 6, height: 6, borderRadius: "50%", backgroundColor: "var(--accent-blue)", display: "inline-block" }} /> Tailing</>
            )}
          </button>
        )}
      </div>

      {/* Loading overlay — shown until first data arrives */}
      {showLoading && (
        <div style={{
          position: "absolute", inset: 0, zIndex: 5,
          display: "flex", flexDirection: "column", alignItems: "center", justifyContent: "center",
          background: resolvedTerminalColors.background || "#0d1117",
          borderRadius: 8, gap: 16,
          animation: "fadeIn 0.2s ease-out",
        }}>
          {/* Typing cursor animation */}
          <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
            <span style={{
              color: "var(--accent-green)", fontFamily: "monospace", fontSize: 14,
              opacity: 0.8,
            }}>
              $
            </span>
            <span style={{
              width: 8, height: 16, backgroundColor: "var(--accent-green)",
              animation: "termCursorBlink 1s step-end infinite",
              borderRadius: 1,
            }} />
          </div>
          <span style={{ color: "var(--text-muted)", fontSize: 13 }}>
            Connecting...
          </span>
        </div>
      )}

      {/* Terminal container */}
      <div ref={wrapperRef} style={{
        flex: 1, minHeight: 0,
        background: resolvedTerminalColors.background,
        borderRadius: 8,
        padding: "4px 4px 4px 8px",
        overflow: "hidden",
        touchAction: "pan-y",
        opacity: hasData ? 1 : 0,
        transition: "opacity 0.3s ease-in",
      }} />

      {/* Tail indicator moved to stacked badges above */}
    </div>
  );
});
