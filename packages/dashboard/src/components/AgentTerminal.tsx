import React, { useEffect, useRef, useState } from "react";
import { Terminal } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import { WebglAddon } from "@xterm/addon-webgl";
import { useThemeStore } from "../stores/themeStore";
import "@xterm/xterm/css/xterm.css";

interface AgentTerminalProps {
  sessionId: string;
  agentId: string;
  height?: string;
}

export const AgentTerminal = React.memo(function AgentTerminal({ sessionId, agentId, height = "400px" }: AgentTerminalProps) {
  const termRef = useRef<HTMLDivElement>(null);
  const terminalRef = useRef<Terminal | null>(null);
  const wsRef = useRef<WebSocket | null>(null);
  const resizeTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const [connected, setConnected] = useState(false);
  const resolvedTerminalColors = useThemeStore((s) => s.resolvedTerminalColors);

  // Apply theme changes to existing terminal
  useEffect(() => {
    if (terminalRef.current) {
      terminalRef.current.options.theme = resolvedTerminalColors;
    }
  }, [resolvedTerminalColors]);

  useEffect(() => {
    if (!termRef.current) return;

    const term = new Terminal({
      theme: resolvedTerminalColors,
      fontFamily: "'JetBrains Mono', 'Fira Code', 'Cascadia Code', 'Menlo', monospace",
      fontSize: 13,
      lineHeight: 1.2,
      cursorBlink: true,
      scrollback: 100000,
      smoothScrollDuration: 80,
      scrollSensitivity: 1,
      fastScrollSensitivity: 5,
      scrollOnUserInput: true,
      rightClickSelectsWord: true,
      allowProposedApi: true,
    });

    const fitAddon = new FitAddon();
    term.loadAddon(fitAddon);
    term.open(termRef.current);

    // Load WebGL renderer for better performance
    try {
      const webglAddon = new WebglAddon();
      webglAddon.onContextLoss(() => {
        webglAddon.dispose();
      });
      term.loadAddon(webglAddon);
    } catch {
      // WebGL not available, fall back to canvas renderer
      console.warn('[terminal] WebGL not available, using canvas renderer');
    }

    // Right-click to copy selected text
    term.element?.addEventListener('contextmenu', (e) => {
      e.preventDefault();
      const selection = term.getSelection();
      if (selection) {
        navigator.clipboard.writeText(selection).catch(() => {
          // Fallback for older browsers
          const textarea = document.createElement('textarea');
          textarea.value = selection;
          document.body.appendChild(textarea);
          textarea.select();
          document.execCommand('copy');
          document.body.removeChild(textarea);
        });
      }
    });

    // Auto-copy to clipboard on text selection (before mouse release clears it)
    // tmux mouse mode intercepts mouse-release which clears xterm.js selection,
    // so we copy as soon as the selection changes
    const selectionDisposable = term.onSelectionChange(() => {
      const selection = term.getSelection();
      if (selection) {
        navigator.clipboard.writeText(selection).catch(() => {});
      }
    });

    fitAddon.fit();
    terminalRef.current = term;

    // Auto-fit on container resize + notify server for tmux resize (debounced)
    const resizeObserver = new ResizeObserver(() => {
      if (resizeTimer.current) clearTimeout(resizeTimer.current);
      resizeTimer.current = setTimeout(() => {
        fitAddon.fit();
        // Send new size to tmux via WebSocket
        if (wsRef.current?.readyState === WebSocket.OPEN) {
          wsRef.current.send(JSON.stringify({
            type: "resize",
            cols: term.cols,
            rows: term.rows,
          }));
        }
      }, 150);
    });
    resizeObserver.observe(termRef.current);

    // Also re-fit when window fires a resize event (e.g. fullscreen toggle)
    const onWindowResize = () => {
      if (resizeTimer.current) clearTimeout(resizeTimer.current);
      resizeTimer.current = setTimeout(() => {
        fitAddon.fit();
        if (wsRef.current?.readyState === WebSocket.OPEN) {
          wsRef.current.send(JSON.stringify({
            type: "resize",
            cols: term.cols,
            rows: term.rows,
          }));
        }
      }, 150);
    };
    window.addEventListener("resize", onWindowResize);

    // WebSocket — raw data via node-pty on the server
    const token = (window as any).__KORA_TOKEN__ ||
                  localStorage.getItem("kora_token") ||
                  new URLSearchParams(window.location.search).get("token") || "";
    const wsProtocol = window.location.protocol === "https:" ? "wss:" : "ws:";
    const wsUrl = `${wsProtocol}//${window.location.host}/terminal/${sessionId}/${agentId}?token=${token}`;

    let reconnectTimer: ReturnType<typeof setTimeout> | null = null;
    let disposed = false;

    const connect = () => {
      if (disposed) return;
      const ws = new WebSocket(wsUrl);
      wsRef.current = ws;

      ws.onopen = () => {
        setConnected(true);
        // Delay initial resize to avoid racing with first data from tmux
        setTimeout(() => {
          if (ws.readyState === WebSocket.OPEN) {
            fitAddon.fit();
            ws.send(JSON.stringify({
              type: "resize",
              cols: term.cols,
              rows: term.rows,
            }));
          }
        }, 50);
      };

      // Raw data from node-pty — write directly to xterm
      // Track whether we need to re-sync size after first chunk
      let firstChunkReceived = false;
      let refreshTimer: ReturnType<typeof setTimeout> | null = null;

      ws.onmessage = (event) => {
        const writeData = (text: string) => {
          term.write(text);

          // After first data chunk, re-send resize to ensure tmux and xterm agree on size
          if (!firstChunkReceived) {
            firstChunkReceived = true;
            setTimeout(() => {
              if (ws.readyState === WebSocket.OPEN) {
                ws.send(JSON.stringify({
                  type: "resize",
                  cols: term.cols,
                  rows: term.rows,
                }));
              }
            }, 100);
          }

          // Debounced refresh after rapid output bursts to fix garbled rendering
          if (refreshTimer) clearTimeout(refreshTimer);
          refreshTimer = setTimeout(() => {
            term.refresh(0, term.rows - 1);
          }, 150);
        };

        if (typeof event.data === "string") {
          writeData(event.data);
        } else if (event.data instanceof Blob) {
          event.data.text().then(writeData);
        }
      };

      ws.onclose = () => {
        setConnected(false);
        if (!disposed) {
          reconnectTimer = setTimeout(connect, 3000);
        }
      };

      ws.onerror = () => ws.close();
    };

    connect();

    // Send terminal input — raw characters, no JSON wrapping
    const dataDisposable = term.onData((data) => {
      if (wsRef.current?.readyState === WebSocket.OPEN) {
        wsRef.current.send(data);
      }
    });

    return () => {
      disposed = true;
      if (reconnectTimer) clearTimeout(reconnectTimer);
      if (resizeTimer.current) clearTimeout(resizeTimer.current);
      resizeObserver.disconnect();
      window.removeEventListener("resize", onWindowResize);
      dataDisposable.dispose();
      selectionDisposable.dispose();
      wsRef.current?.close();
      term.dispose();
    };
  }, [sessionId, agentId, height]);

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
      <div ref={termRef} style={{
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
