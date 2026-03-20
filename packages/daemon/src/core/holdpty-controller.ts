/**
 * HoldptyController — drop-in replacement for TmuxController using holdpty.
 *
 * Uses `holdpty launch --bg` for detached session creation (survives daemon restart).
 * Routes sendKeys through PtyManager when a dashboard terminal is connected,
 * falling back to direct socket attach when no dashboard is open.
 *
 * holdpty provides persistent PTY sessions accessible via Unix domain sockets.
 * Protocol: binary frames [1B type][4B length BE][payload]
 * Socket location: /tmp/dt-{UID}/{name}.sock (or HOLDPTY_DIR env override)
 */

import { execFile as execFileCb, type ChildProcess } from "child_process";
import { promisify } from "util";
import * as net from "net";
import * as fs from "fs";
import * as path from "path";
import type { IPtyBackend } from "./pty-backend.js";
import type { PtyManager } from "./pty-manager.js";
import { logger } from "./logger.js";
import { stripAnsi } from "./agent-health.js";

const execFile = promisify(execFileCb);

// Lazy-loaded holdpty modules (ESM)
let _session: any = null;
async function getSessionModule() {
  if (!_session) {
    _session = await import("holdpty/dist/session.js");
  }
  return _session;
}

let _protocol: any = null;
async function getProtocol() {
  if (!_protocol) {
    _protocol = await import("holdpty/dist/protocol.js");
  }
  return _protocol;
}

let _platform: any = null;
async function getPlatform() {
  if (!_platform) {
    _platform = await import("holdpty/dist/platform.js");
  }
  return _platform;
}

/** Cached capturePane result for a session */
interface CaptureCache {
  /** Full raw output (last CAPTURE_CACHE_LINES lines, with ANSI) */
  raw: string;
  /** When this cache entry was fetched */
  fetchedAt: number;
}

/** How many lines to cache per session (covers all callers: 10, 30, 200, 1000) */
const CAPTURE_CACHE_LINES = 1000;

/** How long a cache entry is valid (ms). Most callers poll every 3s, so 1s TTL
 *  means at most 1 socket replay per second per session instead of 4+. */
const CAPTURE_CACHE_TTL_MS = 1000;

export class HoldptyController implements IPtyBackend {
  /** PtyManager reference for routing sendKeys through dashboard terminal connections */
  private ptyManager: PtyManager | null = null;

  /** Track spawned pipe processes (holdpty logs --follow) for proper cleanup */
  private pipeProcesses = new Map<string, ChildProcess>();

  /**
   * Resolved holdpty CLI path — pre-resolved on construction for fast access.
   * Uses local node_modules/.bin/holdpty (67ms) instead of npx (273ms+).
   */
  private cliPath: string;

  /**
   * Per-session capturePane cache. Stores the last CAPTURE_CACHE_LINES lines
   * of raw output. Multiple callers (health, auto-relay, usage-monitor, message-queue)
   * share the same cached fetch within CAPTURE_CACHE_TTL_MS.
   */
  private captureCache = new Map<string, CaptureCache>();

  /**
   * In-flight deduplication: if a socket fetch is already running for a session,
   * subsequent callers await the same promise instead of opening another socket.
   */
  private capturePending = new Map<string, Promise<string>>();

  constructor() {
    // Pre-resolve CLI path synchronously — check both dist/ and src/ relative paths
    const candidates = [
      path.resolve(__dirname, "../../../../../node_modules/.bin/holdpty"),  // from dist/core
      path.resolve(__dirname, "../../../../node_modules/.bin/holdpty"),     // from src/core
    ];
    this.cliPath = candidates.find(p => fs.existsSync(p)) || "npx";
  }

  /**
   * Run a holdpty CLI command using the pre-resolved path.
   */
  private async runCli(...args: string[]): Promise<string> {
    try {
      if (this.cliPath === "npx") {
        const { stdout } = await execFile("npx", ["holdpty", ...args]);
        return stdout;
      }
      const { stdout } = await execFile(this.cliPath, args);
      return stdout;
    } catch (error: unknown) {
      const message = error instanceof Error ? error.message : String(error);
      logger.error(`[HoldptyController] Error running holdpty ${args[0]}: ${message}\n`);
      throw error;
    }
  }

  /**
   * Get the Unix socket path for a session.
   */
  private async getSocketPath(name: string): Promise<string> {
    const plat = await getPlatform();
    const sessionDir = plat.getSessionDir();
    return plat.socketPath(sessionDir, name);
  }

  /**
   * Set PtyManager reference for routing sendKeys through active dashboard connections.
   */
  setPtyManager(pm: PtyManager): void {
    this.ptyManager = pm;
  }

  /**
   * Creates a new holdpty session via `holdpty launch --bg` (detached mode).
   * The session runs as a separate background process that survives daemon restart.
   */
  async newSession(
    name: string,
    width: number = 200,
    height: number = 50,
  ): Promise<void> {
    const shell = process.env.SHELL || "/bin/zsh";

    // Apply stored env vars by prefixing with env command
    const storedEnv = this.envVars.get(name);
    const envArgs: string[] = [];
    if (storedEnv) {
      for (const [key, value] of storedEnv) {
        envArgs.push(`${key}=${value}`);
      }
    }

    // Launch detached holdpty session
    if (envArgs.length > 0) {
      // Use env command to set variables
      await this.runCli("launch", "--bg", "--name", name, "--", "env", ...envArgs, shell);
    } else {
      await this.runCli("launch", "--bg", "--name", name, "--", shell);
    }

    // Wait for socket to be ready (poll 50ms intervals, 3s timeout)
    const socketPath = await this.getSocketPath(name);
    const deadline = Date.now() + 3000;
    while (Date.now() < deadline) {
      try {
        await fs.promises.access(socketPath);
        break;
      } catch {
        await new Promise(r => setTimeout(r, 50));
      }
    }

    // Resize to requested dimensions via socket
    await this.resize(name, width, height);
  }

  /**
   * Resize a holdpty session via the binary protocol.
   */
  async resize(name: string, cols: number, rows: number): Promise<void> {
    const proto = await getProtocol();
    const socketPath = await this.getSocketPath(name);

    return new Promise<void>((resolve) => {
      const socket = net.createConnection(socketPath, () => {
        const hello = proto.encodeHello({ mode: "attach", protocolVersion: 1 });
        socket.write(hello);
      });

      let gotAck = false;
      socket.on("data", (chunk: Buffer) => {
        if (!gotAck && chunk.length >= 5 && chunk[0] === proto.MSG.HELLO_ACK) {
          gotAck = true;
          const resizeFrame = proto.encodeResize(cols, rows);
          socket.write(resizeFrame);
          setTimeout(() => { socket.destroy(); resolve(); }, 50);
        }
      });

      socket.on("error", () => { resolve(); });
      setTimeout(() => { socket.destroy(); resolve(); }, 3000);
    });
  }

  /**
   * Checks whether a holdpty session exists and is alive.
   *
   * Two-phase check:
   * 1. Fast path: metadata + PID check via isSessionActive()
   * 2. Socket liveness probe: connect to the Unix socket with a short timeout
   *    and verify HELLO_ACK handshake. This catches stale sessions where:
   *    - The holder crashed (SIGKILL/OOM) but the socket file persists
   *    - The PID was recycled by the OS (kill(pid, 0) returns true for wrong process)
   *
   * If the socket probe fails, cleans up stale socket + metadata files.
   */
  async hasSession(name: string): Promise<boolean> {
    try {
      const session = await getSessionModule();
      if (!session.isSessionActive(name)) {
        return false;
      }

      // Phase 2: Verify the socket is actually connectable
      const alive = await this.probeSocket(name);
      if (!alive) {
        // Stale session — clean up orphaned files
        logger.debug({ sessionName: name }, "[HoldptyController] hasSession: PID alive but socket dead — cleaning stale session");
        await this.cleanupStaleSession(name);
        return false;
      }

      return true;
    } catch {
      return false;
    }
  }

  /**
   * Probe a holdpty socket with a HELLO handshake to verify liveness.
   * Returns true if socket responds with HELLO_ACK within timeout.
   */
  private async probeSocket(name: string): Promise<boolean> {
    try {
      const proto = await getProtocol();
      const socketPath = await this.getSocketPath(name);

      return await new Promise<boolean>((resolve) => {
        const socket = net.createConnection(socketPath, () => {
          // Send HELLO in "logs" mode (read-only, no exclusive lock)
          const hello = proto.encodeHello({ mode: "logs", protocolVersion: 1 });
          socket.write(hello);
        });

        const timeout = setTimeout(() => {
          socket.destroy();
          resolve(false);
        }, 1000); // 1-second timeout

        socket.on("data", (chunk: Buffer) => {
          clearTimeout(timeout);
          socket.destroy();
          // Any response means the holder is alive
          resolve(chunk.length > 0);
        });

        socket.on("error", () => {
          clearTimeout(timeout);
          socket.destroy();
          resolve(false);
        });
      });
    } catch {
      return false;
    }
  }

  /**
   * Clean up stale socket + metadata files for a dead session.
   */
  private async cleanupStaleSession(name: string): Promise<void> {
    try {
      const socketPath = await this.getSocketPath(name);
      const metadataPath = socketPath.replace(/\.sock$/, ".json");

      try { fs.unlinkSync(socketPath); } catch { /* may already be gone */ }
      try { fs.unlinkSync(metadataPath); } catch { /* may already be gone */ }

      logger.debug({ sessionName: name }, "[HoldptyController] Cleaned up stale session files");
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      logger.debug({ sessionName: name, err: message }, "[HoldptyController] Failed to clean stale session");
    }
  }

  /**
   * Kills a holdpty session via CLI stop command.
   * Forces cleanup of socket + metadata files even if holdpty stop fails.
   */
  async killSession(name: string): Promise<void> {
    // Kill any pipe process before stopping the session
    await this.pipePaneStop(name);

    try {
      await this.runCli("stop", name);
      logger.debug({ sessionName: name }, "[HoldptyController] Successfully called holdpty stop");
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      logger.debug({ sessionName: name, err: message }, "[HoldptyController] holdpty stop failed (session may already be dead)");
    }

    // Force cleanup socket + metadata (respects HOLDPTY_DIR)
    try {
      const socketPath = await this.getSocketPath(name);
      const metadataPath = socketPath.replace(/\.sock$/, ".json");

      logger.debug({ sessionName: name, socketPath, metadataPath }, "[HoldptyController] Attempting manual cleanup");

      try {
        fs.unlinkSync(socketPath);
        logger.debug({ sessionName: name, socketPath }, "[HoldptyController] Deleted socket file");
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        logger.debug({ sessionName: name, socketPath, err: message }, "[HoldptyController] Failed to delete socket file");
      }

      try {
        fs.unlinkSync(metadataPath);
        logger.debug({ sessionName: name, metadataPath }, "[HoldptyController] Deleted metadata file");
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        logger.debug({ sessionName: name, metadataPath, err: message }, "[HoldptyController] Failed to delete metadata file");
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      logger.warn({ sessionName: name, err: message }, "[HoldptyController] getSocketPath failed during cleanup");
    }

    this.envVars.delete(name);
    this.captureCache.delete(name);
    this.capturePending.delete(name);
  }

  /**
   * Public accessor for socket path — used by orchestrator for restore verification.
   */
  async getSocketPathForSession(name: string): Promise<string> {
    return this.getSocketPath(name);
  }

  /**
   * Send keystrokes to a holdpty session.
   * Routes through PtyManager if a dashboard terminal is connected (avoids
   * exclusive attach mode conflict). Falls back to direct socket attach.
   */
  async sendKeys(
    session: string,
    keys: string,
    options?: { literal?: boolean },
  ): Promise<void> {
    // PTY terminals use \r (carriage return) for Enter, not \n.
    // Always append \r — in holdpty, everything is already literal (raw terminal input),
    // so the `literal` flag has no effect. The tmux-controller equivalent always sends
    // Enter after keys regardless of -l flag (line 136 in tmux-controller.ts).
    const data = keys + "\r";

    // Fast path: route through PtyManager if dashboard terminal is connected
    if (this.ptyManager?.hasActiveSession(session)) {
      this.ptyManager.write(session, data);
      return;
    }

    // Fallback: direct socket connection (no dashboard terminal open)
    await this.sendViaSocket(session, data);
  }

  /**
   * Send raw terminal input (no Enter appended).
   * Used for interactive terminal streaming from xterm.js — user keystrokes
   * are forwarded verbatim without adding a carriage return.
   */
  async sendRawInput(session: string, data: string): Promise<void> {
    // Fast path: route through PtyManager if dashboard terminal is connected
    if (this.ptyManager?.hasActiveSession(session)) {
      this.ptyManager.write(session, data);
      return;
    }

    // Fallback: direct socket connection (no dashboard terminal open)
    await this.sendViaSocket(session, data);
  }

  /**
   * Send data to a holdpty session via direct socket connection.
   *
   * Strategy:
   * 1. Try "send" mode first (non-exclusive, holdpty 0.4+).
   *    Multiple senders + an attached client can coexist.
   * 2. Falls back to "attach" mode for holdpty 0.3.x (exclusive).
   *    If attach is rejected (ERROR frame), logs a warning and resolves
   *    immediately instead of silently waiting for timeout.
   *
   * Uses simple byte-level HELLO_ACK/ERROR detection (first byte of response)
   * rather than full FrameDecoder, since the holder always sends a single
   * complete frame as its first response.
   */
  private async sendViaSocket(session: string, data: string): Promise<void> {
    const proto = await getProtocol();
    const socketPath = await this.getSocketPath(session);
    const dataBuffer = Buffer.from(data, "utf-8");
    const MSG_ERROR = proto.MSG.ERROR ?? 0x05;

    // Helper: attempt to send via a given mode, returns true on success
    const trySend = (mode: string, timeoutMs: number): Promise<boolean> => {
      return new Promise<boolean>((resolve) => {
        const socket = net.createConnection(socketPath, () => {
          socket.write(proto.encodeHello({ mode, protocolVersion: 1 }));
        });

        let handled = false;
        socket.on("data", (chunk: Buffer) => {
          if (handled) return;
          if (chunk.length >= 5 && chunk[0] === proto.MSG.HELLO_ACK) {
            handled = true;
            socket.write(proto.encodeDataIn(dataBuffer));
            setTimeout(() => { socket.destroy(); resolve(true); }, 50);
          } else if (chunk.length >= 5 && chunk[0] === MSG_ERROR) {
            // Rejected (unknown mode or exclusive attach conflict)
            handled = true;
            const payloadLen = chunk.readUInt32BE(1);
            const errMsg = payloadLen > 0 && chunk.length >= 5 + payloadLen
              ? chunk.subarray(5, 5 + payloadLen).toString("utf-8")
              : "unknown error";
            logger.warn(`[HoldptyController] sendViaSocket ${mode} rejected for ${session}: ${errMsg}`);
            socket.destroy();
            resolve(false);
          }
        });

        socket.on("error", (err) => {
          if (!handled) {
            handled = true;
            logger.warn(`[HoldptyController] sendViaSocket ${mode} error for ${session}: ${err.message}`);
            resolve(false);
          }
        });

        setTimeout(() => {
          if (!handled) { handled = true; socket.destroy(); resolve(false); }
        }, timeoutMs);
      });
    };

    // Try "send" mode first (non-exclusive, holdpty 0.4+)
    if (await trySend("send", 2000)) return;

    // Fallback: "attach" mode (exclusive, holdpty 0.3.x)
    await trySend("attach", 5000);
  }

  /**
   * Captures terminal output via socket-based logs replay, with caching.
   *
   * Performance optimization: holdpty replays the ENTIRE session history on every
   * socket connection in "logs" mode. With 10+ agents and 4 callers per agent
   * polling every 3s, this causes massive I/O for long-running sessions.
   *
   * Solution: Cache the last 1000 lines of raw output per session with a 1-second
   * TTL. Multiple callers share the same cached fetch. In-flight deduplication
   * prevents concurrent socket connections for the same session.
   *
   * Before: 20+ full history replays per 3-second cycle (scales with session age)
   * After:  ~10 cached replays per 3-second cycle (constant time regardless of age)
   */
  async capturePane(session: string, lines: number = 1000, escapeSequences: boolean = false): Promise<string> {
    try {
      // Check cache first
      const cached = this.captureCache.get(session);
      if (cached && (Date.now() - cached.fetchedAt) < CAPTURE_CACHE_TTL_MS) {
        // Cache hit — slice to requested line count
        const raw = this.sliceLines(cached.raw, lines);
        return escapeSequences ? raw : stripAnsi(raw);
      }

      // Cache miss — fetch from socket (with in-flight deduplication)
      const raw = await this.fetchCapture(session);

      // Slice to requested lines
      const sliced = this.sliceLines(raw, lines);

      // Strip ANSI escape sequences when escapeSequences=false (default).
      // holdpty replays raw PTY output including cursor blink, window titles,
      // color codes etc. — unlike tmux's capture-pane which strips these.
      return escapeSequences ? sliced : stripAnsi(sliced);
    } catch {
      return "";
    }
  }

  /**
   * Fetch full output from holdpty socket, with in-flight deduplication.
   * If a fetch is already running for this session, returns the same promise.
   */
  private fetchCapture(session: string): Promise<string> {
    // Deduplicate concurrent requests for the same session
    const pending = this.capturePending.get(session);
    if (pending) return pending;

    const promise = this.fetchCaptureFromSocket(session)
      .then(raw => {
        // Cache the result
        this.captureCache.set(session, { raw, fetchedAt: Date.now() });
        return raw;
      })
      .finally(() => {
        this.capturePending.delete(session);
      });

    this.capturePending.set(session, promise);
    return promise;
  }

  /**
   * Raw socket fetch — replays session history and returns last CAPTURE_CACHE_LINES.
   */
  private async fetchCaptureFromSocket(session: string): Promise<string> {
    const proto = await getProtocol();
    const socketPath = await this.getSocketPath(session);

    return new Promise<string>((resolve) => {
      const chunks: Buffer[] = [];
      const decoder = new proto.FrameDecoder();
      let resolved = false;

      const socket = net.createConnection(socketPath, () => {
        const hello = proto.encodeHello({ mode: "logs", protocolVersion: 1 });
        socket.write(hello);
      });

      socket.on("data", (chunk: Buffer) => {
        for (const frame of decoder.decode(chunk)) {
          if (frame.type === proto.MSG.DATA_OUT) {
            chunks.push(frame.payload);
          } else if (frame.type === proto.MSG.REPLAY_END) {
            resolved = true;
            socket.destroy();
            const full = Buffer.concat(chunks).toString("utf-8");
            const allLines = full.split("\n");
            resolve(allLines.slice(-CAPTURE_CACHE_LINES).join("\n"));
          }
        }
      });

      socket.on("error", () => { if (!resolved) resolve(""); });

      setTimeout(() => {
        if (!resolved) {
          socket.destroy();
          const full = Buffer.concat(chunks).toString("utf-8");
          const allLines = full.split("\n");
          resolve(allLines.slice(-CAPTURE_CACHE_LINES).join("\n"));
        }
      }, 3000);
    });
  }

  /**
   * Slice cached output to the requested number of lines.
   */
  private sliceLines(text: string, lines: number): string {
    if (lines >= CAPTURE_CACHE_LINES) return text;
    const allLines = text.split("\n");
    return allLines.slice(-lines).join("\n");
  }

  /**
   * Lists all active holdpty sessions.
   */
  async listSessions(): Promise<string[]> {
    try {
      const session = await getSessionModule();
      const sessions = await session.listSessions({ clean: true });
      return sessions.map((s: any) => s.name);
    } catch {
      return [];
    }
  }

  /**
   * Stored env vars — applied during newSession via env command prefix.
   * Also injected via sendKeys export for already-running sessions.
   */
  private envVars = new Map<string, Map<string, string>>();

  async setEnvironment(session: string, key: string, value: string): Promise<void> {
    if (!this.envVars.has(session)) this.envVars.set(session, new Map());
    this.envVars.get(session)!.set(key, value);

    // If session already exists, inject env var via export command
    if (await this.hasSession(session)) {
      await this.sendKeys(session, `export ${key}="${value}"`, { literal: false });
    }
  }

  /**
   * Get stored env vars for a session (for use during spawn).
   */
  getEnvironmentVars(session: string): Record<string, string> {
    const vars = this.envVars.get(session);
    if (!vars) return {};
    return Object.fromEntries(vars);
  }

  /**
   * Start piping session output to a log file via CLI logs --follow.
   * Tracks the spawned child process for proper cleanup via pipePaneStop().
   */
  async pipePaneStart(session: string, outputFile: string): Promise<void> {
    try {
      // Kill any existing pipe process for this session before starting a new one
      await this.pipePaneStop(session);

      const cmd = this.cliPath === "npx" ? "npx" : this.cliPath;
      const args = this.cliPath === "npx"
        ? ["holdpty", "logs", session, "--follow"]
        : ["logs", session, "--follow"];

      const { spawn } = require("child_process");
      const child = spawn(cmd, args, {
        stdio: ["ignore", fs.openSync(outputFile, "a"), "ignore"],
        detached: true,
      });

      // Track the child process for cleanup
      this.pipeProcesses.set(session, child);
      logger.debug({ session, pid: child.pid }, "[HoldptyController] Started pipe process");

      // Auto-cleanup from map when process exits naturally
      child.on("exit", (code: number | null) => {
        logger.debug({ session, pid: child.pid, exitCode: code }, "[HoldptyController] Pipe process exited");
        this.pipeProcesses.delete(session);
      });

      child.unref();
    } catch (err) {
      logger.error({ err: err }, `[HoldptyController] Failed to start pipe for ${session}:`);
    }
  }

  /**
   * Stop piping session output by killing the tracked child process.
   */
  async pipePaneStop(session: string): Promise<void> {
    const child = this.pipeProcesses.get(session);
    if (!child) return;

    try {
      if (child.pid && !child.killed) {
        // Kill the entire process group (detached process)
        try {
          process.kill(-child.pid, "SIGTERM");
        } catch {
          // Process group kill failed, try direct kill
          child.kill("SIGTERM");
        }
        logger.debug({ session, pid: child.pid }, "[HoldptyController] Killed pipe process");
      }
    } catch (err) {
      logger.debug({ session, err }, "[HoldptyController] Error killing pipe process (may already be dead)");
    } finally {
      this.pipeProcesses.delete(session);
    }
  }

  /**
   * Stop all tracked pipe processes (for daemon shutdown / cleanup).
   */
  cleanupAllPipeProcesses(): void {
    for (const [session, child] of this.pipeProcesses) {
      try {
        if (child.pid && !child.killed) {
          try {
            process.kill(-child.pid, "SIGTERM");
          } catch {
            child.kill("SIGTERM");
          }
          logger.debug({ session, pid: child.pid }, "[HoldptyController] Cleanup: killed pipe process");
        }
      } catch {
        // Ignore — process already dead
      }
    }
    this.pipeProcesses.clear();
  }

  /**
   * Gets the PID of the process running in a session via metadata.
   */
  async getPanePID(session: string): Promise<number | null> {
    try {
      const sess = await getSessionModule();
      const meta = sess.readMetadata(session);
      if (meta) return meta.childPid || meta.pid || null;
      return null;
    } catch {
      return null;
    }
  }

  /**
   * Returns the command + args to attach to a session via node-pty (for PtyManager).
   */
  getAttachCommand(session: string): { command: string; args: string[] } {
    if (this.cliPath === "npx") {
      return { command: "npx", args: ["holdpty", "attach", session] };
    }
    return { command: this.cliPath, args: ["attach", session] };
  }

  /**
   * Run a raw holdpty CLI command.
   */
  async run_raw(...args: string[]): Promise<string> {
    return this.runCli(...args);
  }
}
