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

import { execFile as execFileCb } from "child_process";
import { promisify } from "util";
import * as net from "net";
import * as fs from "fs";
import * as path from "path";
import type { IPtyBackend } from "./pty-backend.js";
import type { PtyManager } from "./pty-manager.js";

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

export class HoldptyController implements IPtyBackend {
  /** PtyManager reference for routing sendKeys through dashboard terminal connections */
  private ptyManager: PtyManager | null = null;

  /**
   * Resolved holdpty CLI path — pre-resolved on construction for fast access.
   * Uses local node_modules/.bin/holdpty (67ms) instead of npx (273ms+).
   */
  private cliPath: string;

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
      process.stderr.write(`[HoldptyController] Error running holdpty ${args[0]}: ${message}\n`);
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
   */
  async hasSession(name: string): Promise<boolean> {
    try {
      const session = await getSessionModule();
      return session.isSessionActive(name);
    } catch {
      return false;
    }
  }

  /**
   * Kills a holdpty session via CLI stop command.
   * Forces cleanup of socket + metadata files even if holdpty stop fails.
   */
  async killSession(name: string): Promise<void> {
    try {
      await this.runCli("stop", name);
    } catch {
      // Already dead — that's fine
    }

    // Force cleanup socket + metadata (respects HOLDPTY_DIR)
    try {
      const socketPath = await this.getSocketPath(name);
      const metadataPath = socketPath.replace(/\.sock$/, ".json");
      try { fs.unlinkSync(socketPath); } catch { /* may not exist */ }
      try { fs.unlinkSync(metadataPath); } catch { /* may not exist */ }
    } catch { /* getSocketPath may fail */ }

    this.envVars.delete(name);
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
    // PTY terminals use \r (carriage return) for Enter, not \n
    const data = options?.literal ? keys : keys + "\r";

    // Fast path: route through PtyManager if dashboard terminal is connected
    if (this.ptyManager?.hasActiveSession(session)) {
      this.ptyManager.write(session, data);
      return;
    }

    // Fallback: direct socket attach (no dashboard terminal open)
    const proto = await getProtocol();
    const socketPath = await this.getSocketPath(session);

    return new Promise<void>((resolve) => {
      const socket = net.createConnection(socketPath, () => {
        const hello = proto.encodeHello({ mode: "attach", protocolVersion: 1 });
        socket.write(hello);
      });

      let gotAck = false;
      socket.on("data", (chunk: Buffer) => {
        if (!gotAck && chunk.length >= 5 && chunk[0] === proto.MSG.HELLO_ACK) {
          gotAck = true;
          const dataFrame = proto.encodeDataIn(Buffer.from(data, "utf-8"));
          socket.write(dataFrame);
          setTimeout(() => { socket.destroy(); resolve(); }, 50);
        }
      });

      socket.on("error", (err) => {
        const msg = err.message;
        if (msg.includes("ENOENT") || msg.includes("ECONNREFUSED") || msg.includes("no such file")
            || msg.includes("ECONNRESET") || msg.includes("already attached")) {
          process.stderr.write(`[HoldptyController] Ignoring sendKeys error for ${session}: ${msg}\n`);
        }
        resolve();
      });

      setTimeout(() => { socket.destroy(); resolve(); }, 5000);
    });
  }

  /**
   * Send raw terminal input (no Enter appended).
   */
  async sendRawInput(session: string, data: string): Promise<void> {
    await this.sendKeys(session, data, { literal: true });
  }

  /**
   * Captures terminal output via socket-based logs replay.
   * Avoids spawning a subprocess per call.
   */
  async capturePane(session: string, lines: number = 1000, _escapeSequences: boolean = false): Promise<string> {
    try {
      const proto = await getProtocol();
      const socketPath = await this.getSocketPath(session);

      return await new Promise<string>((resolve) => {
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
              resolve(allLines.slice(-lines).join("\n"));
            }
          }
        });

        socket.on("error", () => { if (!resolved) resolve(""); });

        setTimeout(() => {
          if (!resolved) {
            socket.destroy();
            const full = Buffer.concat(chunks).toString("utf-8");
            const allLines = full.split("\n");
            resolve(allLines.slice(-lines).join("\n"));
          }
        }, 3000);
      });
    } catch {
      return "";
    }
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
   */
  async pipePaneStart(session: string, outputFile: string): Promise<void> {
    try {
      const cmd = this.cliPath === "npx" ? "npx" : this.cliPath;
      const args = this.cliPath === "npx"
        ? ["holdpty", "logs", session, "--follow"]
        : ["logs", session, "--follow"];

      const child = require("child_process").spawn(cmd, args, {
        stdio: ["ignore", fs.openSync(outputFile, "a"), "ignore"],
        detached: true,
      });
      child.unref();
    } catch (err) {
      console.error(`[HoldptyController] Failed to start pipe for ${session}:`, err);
    }
  }

  /**
   * Stop piping (no-op — the detached logs process dies when session stops).
   */
  async pipePaneStop(_session: string): Promise<void> {
    // No-op
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
