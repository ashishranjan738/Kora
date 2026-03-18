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
  onConnectedChange?: (connected: boolean) => void;
}

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
    if (!entry.disposed) {
      entry.reconnectTimer = setTimeout(() => connectWs(entry), 3000);
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
