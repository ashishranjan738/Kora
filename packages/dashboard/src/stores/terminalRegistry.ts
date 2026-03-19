import { Terminal } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import { WebglAddon } from "@xterm/addon-webgl";

export interface TerminalEntry {
  term: Terminal;
  fitAddon: FitAddon;
  container: HTMLDivElement;
  ws: WebSocket | null;
  wsUrl: string;
  reconnectTimer: ReturnType<typeof setTimeout> | null;
  disposed: boolean;
  connected: boolean;
  reconnectAttempts: number;
  onConnectedChange?: (connected: boolean) => void;
  onMessageNotification?: (from: string) => void;
}

const MAX_RECONNECT_ATTEMPTS = 10;
const RECONNECT_BASE_DELAY = 2000;

const registry = new Map<string, TerminalEntry>();

function getToken(): string {
  const injected = (window as any).__KORA_TOKEN__ as string | undefined;
  if (injected) return injected;
  return localStorage.getItem("kora_token") ||
    new URLSearchParams(window.location.search).get("token") || "";
}

function buildWsUrl(sessionId: string, agentId: string): string {
  const protocol = window.location.protocol === "https:" ? "wss:" : "ws:";
  return `${protocol}//${window.location.host}/terminal/${sessionId}/${agentId}?token=${getToken()}`;
}

function connectWs(entry: TerminalEntry): void {
  if (entry.disposed) return;

  const ws = new WebSocket(entry.wsUrl);
  entry.ws = ws;

  let firstChunkReceived = false;
  let refreshTimer: ReturnType<typeof setTimeout> | null = null;

  ws.onopen = () => {
    entry.connected = true;
    entry.reconnectAttempts = 0; // Reset on successful connection
    entry.onConnectedChange?.(true);
    // Delay initial resize to avoid racing with first data
    setTimeout(() => {
      if (ws.readyState === WebSocket.OPEN) {
        entry.fitAddon.fit();
        ws.send(JSON.stringify({
          type: "resize",
          cols: entry.term.cols,
          rows: entry.term.rows,
        }));
      }
    }, 50);
  };

  ws.onmessage = (event) => {
    const writeData = (text: string) => {
      // Detect message notification patterns
      const messagePattern = /\[(?:New )?[Mm]essage from ([^\]]+)\]/;
      const match = text.match(messagePattern);
      if (match && entry.onMessageNotification) {
        entry.onMessageNotification(match[1]);
      }

      entry.term.write(text);
      if (!firstChunkReceived) {
        firstChunkReceived = true;
        setTimeout(() => {
          if (ws.readyState === WebSocket.OPEN) {
            ws.send(JSON.stringify({
              type: "resize",
              cols: entry.term.cols,
              rows: entry.term.rows,
            }));
          }
        }, 100);
      }
      // Debounced refresh after rapid output bursts
      if (refreshTimer) clearTimeout(refreshTimer);
      refreshTimer = setTimeout(() => {
        entry.term.refresh(0, entry.term.rows - 1);
      }, 150);
    };

    if (typeof event.data === "string") {
      writeData(event.data);
    } else if (event.data instanceof Blob) {
      event.data.text().then(writeData);
    }
  };

  ws.onclose = () => {
    entry.connected = false;
    entry.onConnectedChange?.(false);
    if (!entry.disposed && entry.reconnectAttempts < MAX_RECONNECT_ATTEMPTS) {
      entry.reconnectAttempts++;
      // Exponential backoff: 2s, 4s, 8s, ... capped at 30s
      const delay = Math.min(RECONNECT_BASE_DELAY * Math.pow(2, entry.reconnectAttempts - 1), 30000);
      entry.reconnectTimer = setTimeout(() => connectWs(entry), delay);
    }
  };

  ws.onerror = () => ws.close();
}

export function getOrCreateTerminal(
  sessionId: string,
  agentId: string,
  theme: any,
): TerminalEntry {
  const key = `${sessionId}:${agentId}`;

  if (registry.has(key)) {
    const entry = registry.get(key)!;
    // Update theme if changed
    entry.term.options.theme = theme;
    // Reset reconnect attempts when component re-mounts (user navigated back)
    entry.reconnectAttempts = 0;
    // Reconnect if WebSocket is dead
    if (!entry.ws || entry.ws.readyState === WebSocket.CLOSED || entry.ws.readyState === WebSocket.CLOSING) {
      if (!entry.disposed) {
        if (entry.reconnectTimer) {
          clearTimeout(entry.reconnectTimer);
          entry.reconnectTimer = null;
        }
        connectWs(entry);
      }
    }
    return entry;
  }

  // Create new terminal
  const term = new Terminal({
    theme,
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

  // Create an offscreen container
  const container = document.createElement("div");
  container.style.cssText = "width:100%;height:100%;";
  term.open(container);

  // Load WebGL renderer
  try {
    const webglAddon = new WebglAddon();
    webglAddon.onContextLoss(() => webglAddon.dispose());
    term.loadAddon(webglAddon);
  } catch {
    console.warn("[terminal-registry] WebGL not available, using canvas renderer");
  }

  // Right-click to copy
  term.element?.addEventListener("contextmenu", (e) => {
    e.preventDefault();
    const selection = term.getSelection();
    if (selection) {
      navigator.clipboard.writeText(selection).catch(() => {});
    }
  });

  // Auto-copy on selection change
  term.onSelectionChange(() => {
    const selection = term.getSelection();
    if (selection) {
      navigator.clipboard.writeText(selection).catch(() => {});
    }
  });

  const wsUrl = buildWsUrl(sessionId, agentId);

  const entry: TerminalEntry = {
    term,
    fitAddon,
    container,
    ws: null,
    wsUrl,
    reconnectTimer: null,
    disposed: false,
    connected: false,
    reconnectAttempts: 0,
  };

  // Send terminal input to WebSocket (must be after entry is created)
  term.onData((data) => {
    if (entry.ws?.readyState === WebSocket.OPEN) {
      entry.ws.send(data);
    }
  });

  registry.set(key, entry);

  // Start WebSocket connection
  connectWs(entry);

  return entry;
}

/** Detach terminal container from DOM but keep alive in registry */
export function detachTerminal(sessionId: string, agentId: string): void {
  const key = `${sessionId}:${agentId}`;
  const entry = registry.get(key);
  if (entry && entry.container.parentElement) {
    entry.container.parentElement.removeChild(entry.container);
  }
}

/** Set callback for message notifications detected in terminal output */
export function setMessageNotificationCallback(
  sessionId: string,
  agentId: string,
  callback: ((from: string) => void) | undefined
): void {
  const key = `${sessionId}:${agentId}`;
  const entry = registry.get(key);
  if (entry) {
    entry.onMessageNotification = callback;
  }
}

/** Full cleanup — close WebSocket, dispose terminal, remove from registry */
export function destroyTerminal(sessionId: string, agentId: string): void {
  const key = `${sessionId}:${agentId}`;
  const entry = registry.get(key);
  if (!entry) return;

  entry.disposed = true;
  if (entry.reconnectTimer) clearTimeout(entry.reconnectTimer);
  entry.ws?.close();
  entry.term.dispose();
  if (entry.container.parentElement) {
    entry.container.parentElement.removeChild(entry.container);
  }
  registry.delete(key);
}

/** Check if a terminal exists in the registry */
export function hasTerminal(sessionId: string, agentId: string): boolean {
  const key = `${sessionId}:${agentId}`;
  return registry.has(key);
}

/** Get all terminal keys in the registry */
export function getAllTerminalKeys(): string[] {
  return Array.from(registry.keys());
}

/** Destroy all terminals in registry */
export function destroyAllTerminals(): void {
  for (const [key, entry] of registry) {
    entry.disposed = true;
    if (entry.reconnectTimer) clearTimeout(entry.reconnectTimer);
    entry.ws?.close();
    entry.term.dispose();
    if (entry.container.parentElement) {
      entry.container.parentElement.removeChild(entry.container);
    }
  }
  registry.clear();
}
