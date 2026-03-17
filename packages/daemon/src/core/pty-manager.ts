// ============================================================
// PTY Manager — spawns node-pty attached to tmux sessions
// for real terminal I/O over WebSocket (binary, not JSON)
// ============================================================

import * as pty from "node-pty";
import type { WebSocket } from "ws";
import { execFileSync } from "child_process";
import { MAX_TERMINAL_CONNECTIONS_PER_AGENT } from "@kora/shared";

// Resolve tmux path once at module load
let tmuxPath = "tmux";
try {
  tmuxPath = execFileSync("which", ["tmux"], { encoding: "utf-8" }).trim();
} catch {
  // Will fail later when trying to spawn
}

interface PtySession {
  ptyProcess: pty.IPty;
  clients: Set<WebSocket>;
}

export class PtyManager {
  private sessions = new Map<string, PtySession>();

  /**
   * Attach a WebSocket client to a tmux session via node-pty.
   * Spawns `tmux attach -t {tmuxSession}` in a PTY if not already running.
   * Returns false if max connections reached.
   */
  attach(tmuxSession: string, ws: WebSocket, cols: number = 120, rows: number = 40): boolean {
    let session = this.sessions.get(tmuxSession);

    if (!session) {
      // Spawn a PTY running `tmux attach -t {tmuxSession}`
      let ptyProcess: pty.IPty;
      try {
        ptyProcess = pty.spawn(tmuxPath, ["attach-session", "-t", tmuxSession], {
          name: "xterm-256color",
          cols,
          rows,
          cwd: process.env.HOME || "/tmp",
          env: { ...process.env, TERM: "xterm-256color" } as Record<string, string>,
        });
      } catch (err) {
        console.error(`[pty-manager] Failed to spawn PTY for ${tmuxSession}:`, err);
        return false;
      }

      session = { ptyProcess, clients: new Set() };
      this.sessions.set(tmuxSession, session);

      // Fan out PTY output to all connected WebSocket clients
      ptyProcess.onData((data: string) => {
        for (const client of session!.clients) {
          if (client.readyState === 1) { // WebSocket.OPEN
            client.send(data);
          }
        }
      });

      // Clean up when PTY exits
      ptyProcess.onExit(() => {
        for (const client of session!.clients) {
          client.close(1000, "PTY exited");
        }
        this.sessions.delete(tmuxSession);
      });
    }

    // Enforce max connections
    if (session.clients.size >= MAX_TERMINAL_CONNECTIONS_PER_AGENT) {
      return false;
    }

    // Add this client
    session.clients.add(ws);

    // Forward WebSocket input to PTY
    ws.on("message", (data) => {
      const input = typeof data === "string" ? data : data.toString();
      session!.ptyProcess.write(input);
    });

    // Handle resize messages (JSON: { type: "resize", cols, rows })
    // We need to differentiate resize from regular input
    // Convention: if the message starts with '\x01' (SOH), it's a control message
    // Actually, let's use a simpler approach: check if it parses as JSON with a resize type
    const originalOnMessage = ws.listeners("message").pop() as Function;
    ws.removeAllListeners("message");
    ws.on("message", (raw) => {
      const str = typeof raw === "string" ? raw : raw.toString();
      // Try to parse as JSON control message
      if (str.startsWith("{")) {
        try {
          const msg = JSON.parse(str);
          if (msg.type === "resize" && typeof msg.cols === "number" && typeof msg.rows === "number") {
            session!.ptyProcess.resize(msg.cols, msg.rows);
            return;
          }
        } catch {
          // Not JSON, treat as terminal input
        }
      }
      // Regular terminal input
      session!.ptyProcess.write(str);
    });

    // Remove client on close
    ws.on("close", () => {
      session!.clients.delete(ws);
      // If no more clients, kill the PTY (detaches from tmux, doesn't kill the session)
      if (session!.clients.size === 0) {
        session!.ptyProcess.kill();
        this.sessions.delete(tmuxSession);
      }
    });

    return true;
  }

  /**
   * Resize the PTY for a tmux session (affects all connected clients).
   */
  resize(tmuxSession: string, cols: number, rows: number): void {
    const session = this.sessions.get(tmuxSession);
    if (session) {
      session.ptyProcess.resize(cols, rows);
    }
  }

  /**
   * Detach all clients and kill all PTY sessions.
   */
  destroyAll(): void {
    for (const [key, session] of this.sessions) {
      for (const client of session.clients) {
        client.close(1000, "Shutting down");
      }
      session.ptyProcess.kill();
      this.sessions.delete(key);
    }
  }
}

export const ptyManager = new PtyManager();
