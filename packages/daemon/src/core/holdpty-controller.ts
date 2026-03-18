/**
 * HoldptyController — drop-in replacement for TmuxController using holdpty.
 *
 * Uses holdpty's Node.js API (Holder, session, client) for session management
 * and the binary protocol over Unix sockets for sendKeys/capturePane.
 *
 * holdpty provides persistent PTY sessions accessible via Unix domain sockets.
 * Protocol: binary frames [1B type][4B length BE][payload]
 * Socket location: /tmp/dt-{UID}/{name}.sock (or HOLDPTY_DIR env override)
 *
 * Modes: attach (read+write, exclusive), view (read-only), logs (replay+follow/disconnect)
 * DATA_IN only accepted in attach mode.
 */

import { execFile as execFileCb } from "child_process";
import { promisify } from "util";
import * as net from "net";
import * as fs from "fs";
import type { IPtyBackend } from "./pty-backend.js";

const execFile = promisify(execFileCb);

// Lazy-loaded holdpty modules (ESM)
let _Holder: any = null;
async function getHolder() {
  if (!_Holder) {
    const mod = await import("holdpty/dist/holder.js");
    _Holder = mod.Holder;
  }
  return _Holder;
}

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
  /** Track holders we started (for kill). Not all sessions may be here if daemon restarted. */
  private holders = new Map<string, any>();

  /**
   * Resolve the holdpty CLI path for commands that still need CLI (logs, attach).
   * Cached after first call.
   */
  private cliPath: string | null = null;
  private async getCliPath(): Promise<string> {
    if (this.cliPath) return this.cliPath;

    // Try direct holdpty first (faster)
    try {
      const { stdout } = await execFile("holdpty", ["--version"]);
      if (stdout.includes("holdpty")) {
        this.cliPath = "holdpty";
        return this.cliPath;
      }
    } catch { /* fall through */ }

    // Fallback to npx
    this.cliPath = "npx-holdpty";
    return this.cliPath;
  }

  /**
   * Run a holdpty CLI command (for operations without a Node.js API equivalent).
   */
  private async runCli(...args: string[]): Promise<string> {
    const cli = await this.getCliPath();
    try {
      if (cli === "npx-holdpty") {
        const { stdout } = await execFile("npx", ["holdpty", ...args]);
        return stdout;
      }
      const { stdout } = await execFile(cli, args);
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
   * Creates a new holdpty session using the Node.js Holder API.
   */
  async newSession(
    name: string,
    width: number = 200,
    height: number = 50,
  ): Promise<void> {
    const Holder = await getHolder();
    const shell = process.env.SHELL || "/bin/zsh";

    // Apply any env vars stored via setEnvironment() before session creation
    const storedEnv = this.envVars.get(name);
    const env = storedEnv
      ? { ...process.env, ...Object.fromEntries(storedEnv) }
      : undefined;

    const holder = await Holder.start({
      command: [shell],
      name,
      cols: width,
      rows: height,
      ...(env ? { env } : {}),
    });

    this.holders.set(name, holder);
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
   * Kills a holdpty session.
   */
  async killSession(name: string): Promise<void> {
    try {
      // Try in-process holder first
      const holder = this.holders.get(name);
      if (holder) {
        holder.kill();
        this.holders.delete(name);
        return;
      }
      // Fallback to CLI for sessions we didn't start (e.g. after daemon restart)
      await this.runCli("stop", name);
    } catch {
      // Already dead — that's fine
    }
  }

  /**
   * Send keystrokes to a holdpty session.
   * Uses in-process holder's ptyProcess.write() when available (avoids exclusive
   * attach mode conflict with PtyManager dashboard connections).
   * Falls back to socket-based attach for sessions from before daemon restart.
   */
  async sendKeys(
    session: string,
    keys: string,
    options?: { literal?: boolean },
  ): Promise<void> {
    // Fast path: write directly to the in-process holder's PTY
    const holder = this.holders.get(session);
    if (holder && holder.ptyProcess) {
      try {
        // PTY terminals use \r (carriage return) for Enter, not \n
        const data = options?.literal ? keys : keys + "\r";
        holder.ptyProcess.write(data);
        return;
      } catch {
        // Holder may have died — fall through to socket path
      }
    }

    // Fallback: use CLI send command for sessions from before daemon restart.
    // Socket-based attach fails when PtyManager already holds the exclusive attach.
    const data = options?.literal ? keys : keys + "\r";
    try {
      // Write to stdin of the holdpty session via a short-lived socket connection
      // that connects, sends data, and disconnects immediately.
      const proto = await getProtocol();
      const socketPath = await this.getSocketPath(session);

      return new Promise<void>((resolve, reject) => {
        const socket = net.createConnection(socketPath, () => {
          const hello = proto.encodeHello({
            mode: "attach",
            protocolVersion: 1,
          });
          socket.write(hello);
        });

        let gotAck = false;

        socket.on("data", (chunk: Buffer) => {
          if (!gotAck) {
            if (chunk.length >= 5 && chunk[0] === proto.MSG.HELLO_ACK) {
              gotAck = true;

              const dataFrame = proto.encodeDataIn(Buffer.from(data, "utf-8"));
              socket.write(dataFrame);

              setTimeout(() => {
                socket.destroy();
                resolve();
              }, 50);
            }
          }
        });

        socket.on("error", (err) => {
          const msg = err.message;
          if (msg.includes("ENOENT") || msg.includes("ECONNREFUSED") || msg.includes("no such file")
              || msg.includes("ECONNRESET") || msg.includes("already attached")) {
            process.stderr.write(`[HoldptyController] Ignoring sendKeys error for ${session}: ${msg}\n`);
            resolve();
            return;
          }
          reject(err);
        });

        setTimeout(() => {
          socket.destroy();
          resolve();
        }, 5000);
      });
    } catch {
      // Best effort — ignore errors for stale sessions
    }
  }

  /**
   * Send raw terminal input (no Enter appended). For interactive terminal streaming.
   */
  async sendRawInput(session: string, data: string): Promise<void> {
    await this.sendKeys(session, data, { literal: true });
  }

  /**
   * Captures terminal output from a holdpty session via socket-based logs replay.
   * Avoids spawning a subprocess (which was causing 25-50 processes during prompt-wait polling).
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
              // Replay done — disconnect and return buffered data
              resolved = true;
              socket.destroy();
              const full = Buffer.concat(chunks).toString("utf-8");
              // Tail to requested line count
              const allLines = full.split("\n");
              const tailed = allLines.slice(-lines).join("\n");
              resolve(tailed);
            }
          }
        });

        socket.on("error", () => {
          if (!resolved) resolve("");
        });

        // Timeout — logs mode replay should be fast
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
   * Lists all active holdpty sessions using the session module.
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
   * Sets an environment variable for a session.
   * Note: holdpty doesn't have a direct setEnvironment — env must be set before launch.
   * This stores env vars to be applied on next spawn.
   */
  private envVars = new Map<string, Map<string, string>>();

  async setEnvironment(session: string, key: string, value: string): Promise<void> {
    if (!this.envVars.has(session)) this.envVars.set(session, new Map());
    this.envVars.get(session)!.set(key, value);

    // If session already exists, inject env var via export command
    if (this.holders.has(session)) {
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
      const cli = await this.getCliPath();
      const cmd = cli === "npx-holdpty" ? "npx" : cli;
      const args = cli === "npx-holdpty"
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
   * Stop piping (no-op for holdpty — the detached process dies when session stops).
   */
  async pipePaneStop(_session: string): Promise<void> {
    // No-op: the logs --follow process will end when session stops
  }

  /**
   * Gets the PID of the process running in a session using session metadata.
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
   * Returns the command + args needed to attach to a holdpty session via node-pty.
   * Uses `holdpty attach` which bridges stdin/stdout to the session's Unix socket.
   */
  getAttachCommand(session: string): { command: string; args: string[] } {
    if (this.cliPath === "npx-holdpty" || !this.cliPath) {
      return { command: "npx", args: ["holdpty", "attach", session] };
    }
    return { command: this.cliPath, args: ["attach", session] };
  }

  /**
   * Run a raw holdpty CLI command (for resize and other direct operations).
   */
  async run_raw(...args: string[]): Promise<string> {
    return this.runCli(...args);
  }
}
