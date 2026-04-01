// ============================================================
// PTY Manager — spawns node-pty attached to backend sessions
// for real terminal I/O over WebSocket (binary, not JSON)
// ============================================================

import * as pty from "node-pty";
import type { WebSocket } from "ws";
import { MAX_TERMINAL_CONNECTIONS_PER_AGENT } from "@kora/shared";
import type { IPtyBackend } from "./pty-backend.js";
import { logger } from "./logger.js";

const PTY_GRACE_PERIOD_MS = 60_000; // 60s before killing orphaned PTY

interface PtySession {
  ptyProcess: pty.IPty;
  clients: Set<WebSocket>;
  graceTimer?: ReturnType<typeof setTimeout>;
  /** True when session was registered directly (node-pty backend) — don't kill PTY on cleanup */
  registered?: boolean;
  /** Optional catchup data to send to newly connecting clients */
  catchupData?: () => string;
}

export class PtyManager {
  private sessions = new Map<string, PtySession>();
  private backend: IPtyBackend | null = null;

  /**
   * Set the terminal backend so attach() can use backend-specific commands.
   */
  setBackend(backend: IPtyBackend): void {
    this.backend = backend;
  }

  /**
   * Register an agent's existing node-pty process for direct WebSocket fan-out.
   * Used with node-pty backend — the agent's PTY is already a node-pty process,
   * so we skip spawning a subprocess and fan out directly.
   *
   * @param sessionName - The terminal session name (e.g., "kora--session-agentId")
   * @param ptyProcess - The agent's existing node-pty process
   * @param getCatchup - Optional function returning catchup data (e.g., ring buffer contents)
   */
  registerAgent(sessionName: string, ptyProcess: pty.IPty, getCatchup?: () => string): void {
    // Clean up existing session if any
    const existing = this.sessions.get(sessionName);
    if (existing) {
      if (existing.graceTimer) clearTimeout(existing.graceTimer);
      for (const client of existing.clients) {
        client.close(1000, "Session re-registered");
      }
    }

    const session: PtySession = {
      ptyProcess,
      clients: new Set(),
      registered: true,
      catchupData: getCatchup,
    };
    this.sessions.set(sessionName, session);

    // Fan out PTY output to all connected WebSocket clients
    ptyProcess.onData((data: string) => {
      for (const client of session.clients) {
        if (client.readyState === 1) { // WebSocket.OPEN
          client.send(data);
        }
      }
    });

    // Clean up on PTY exit — but don't kill the process (it's owned by the backend)
    ptyProcess.onExit(() => {
      for (const client of session.clients) {
        client.close(1000, "PTY exited");
      }
      this.sessions.delete(sessionName);
    });

    logger.info(`[pty-manager] Registered agent PTY for ${sessionName}`);
  }

  /**
   * Unregister an agent's PTY (called when agent is stopped/removed).
   * Does NOT kill the PTY process — that's the backend's responsibility.
   */
  unregisterAgent(sessionName: string): void {
    const session = this.sessions.get(sessionName);
    if (!session || !session.registered) return;

    if (session.graceTimer) clearTimeout(session.graceTimer);
    for (const client of session.clients) {
      client.close(1000, "Agent removed");
    }
    this.sessions.delete(sessionName);
    logger.info(`[pty-manager] Unregistered agent PTY for ${sessionName}`);
  }

  /**
   * Attach a WebSocket client to a terminal session via node-pty.
   * If the session was registered via registerAgent(), attaches directly.
   * Otherwise uses the configured backend's getAttachCommand() to spawn a subprocess.
   * Returns false if max connections reached or no backend configured.
   */
  attach(sessionName: string, ws: WebSocket, cols: number = 120, rows: number = 40): boolean {
    let session = this.sessions.get(sessionName);

    // If session exists (either registered or previously spawned), add the client
    if (!session) {
      if (!this.backend) {
        logger.error("[pty-manager] No backend configured — call setBackend() first");
        return false;
      }

      // Check if the backend can provide the PTY process directly (node-pty backend)
      if (this.backend.getPtyProcess) {
        const directPty = this.backend.getPtyProcess(sessionName);
        if (directPty) {
          const getCatchup = this.backend.getCatchupData
            ? () => this.backend!.getCatchupData!(sessionName) || ""
            : undefined;
          this.registerAgent(sessionName, directPty, getCatchup);
          session = this.sessions.get(sessionName)!;
        }
      }

      if (!session) {
        // Fall back to spawning a subprocess via the backend's attach command
        const { command, args } = this.backend.getAttachCommand(sessionName);

        let ptyProcess: pty.IPty;
        try {
          ptyProcess = pty.spawn(command, args, {
            name: "xterm-256color",
            cols,
            rows,
            cwd: process.env.HOME || "/tmp",
            env: { ...process.env, TERM: "xterm-256color" } as Record<string, string>,
          });
        } catch (err) {
          logger.error({ err: err }, `[pty-manager] Failed to spawn PTY for ${sessionName}:`);
          return false;
        }

        session = { ptyProcess, clients: new Set() };
        this.sessions.set(sessionName, session);

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
          this.sessions.delete(sessionName);
        });
      }
    }

    // Enforce max connections
    if (session.clients.size >= MAX_TERMINAL_CONNECTIONS_PER_AGENT) {
      return false;
    }

    // Cancel grace timer if a client is reconnecting to an orphaned PTY
    if (session.graceTimer) {
      clearTimeout(session.graceTimer);
      session.graceTimer = undefined;
      logger.info(`[pty-manager] Client reconnected to ${sessionName} within grace period`);
    }

    // Add this client
    session.clients.add(ws);

    // Send catchup data for registered sessions (ring buffer contents)
    if (session.registered && session.catchupData) {
      try {
        const catchup = session.catchupData();
        if (catchup && ws.readyState === 1) {
          ws.send(catchup);
        }
      } catch {
        // Non-fatal — catchup is best-effort
      }
    }

    // Forward WebSocket input to PTY
    ws.on("message", (data) => {
      const input = typeof data === "string" ? data : data.toString();
      session!.ptyProcess.write(input);
    });

    // Handle resize messages (JSON: { type: "resize", cols, rows })
    // We need to differentiate resize from regular input
    // Convention: if the message starts with '\x01' (SOH), it's a control message
    // Actually, let's use a simpler approach: check if it parses as JSON with a resize type
    const originalOnMessage = ws.listeners("message").pop() as (...args: unknown[]) => void;
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

    // Remove client on close — start grace period instead of killing immediately
    ws.on("close", () => {
      session!.clients.delete(ws);
      if (session!.clients.size === 0) {
        logger.info(`[pty-manager] Last client disconnected from ${sessionName}, starting ${PTY_GRACE_PERIOD_MS / 1000}s grace period`);
        session!.graceTimer = setTimeout(() => {
          const s = this.sessions.get(sessionName);
          if (s && s.clients.size === 0) {
            if (s.registered) {
              // Registered sessions: don't kill PTY — it's owned by the backend.
              // Just log; the session stays in the map for future reconnections.
              logger.info(`[pty-manager] Grace period expired for registered session ${sessionName} — keeping PTY alive`);
            } else {
              logger.info(`[pty-manager] Grace period expired for ${sessionName}, killing PTY`);
              s.ptyProcess.kill();
              this.sessions.delete(sessionName);
            }
          }
        }, PTY_GRACE_PERIOD_MS);
      }
    });

    return true;
  }

  /**
   * Write data directly to a session's PTY process.
   * Used by HoldptyController to route sendKeys through the active dashboard connection.
   */
  write(sessionName: string, data: string): void {
    const session = this.sessions.get(sessionName);
    if (session) {
      session.ptyProcess.write(data);
    }
  }

  /**
   * Check if a session has an active PTY process (dashboard terminal connected).
   */
  hasActiveSession(sessionName: string): boolean {
    return this.sessions.has(sessionName);
  }

  /**
   * Resize the PTY for a session (affects all connected clients).
   */
  resize(sessionName: string, cols: number, rows: number): void {
    const session = this.sessions.get(sessionName);
    if (session) {
      session.ptyProcess.resize(cols, rows);
    }
  }

  /**
   * Detach all clients and kill all PTY sessions.
   */
  destroyAll(): void {
    for (const [key, session] of this.sessions) {
      if (session.graceTimer) clearTimeout(session.graceTimer);
      for (const client of session.clients) {
        client.close(1000, "Shutting down");
      }
      // Don't kill registered PTY processes — they're owned by the backend
      if (!session.registered) {
        session.ptyProcess.kill();
      }
      this.sessions.delete(key);
    }
  }
}
