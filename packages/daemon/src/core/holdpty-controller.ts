/**
 * HoldptyController — drop-in replacement for TmuxController using holdpty.
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
import * as path from "path";
import * as fs from "fs";

const execFile = promisify(execFileCb);

// Import holdpty protocol helpers
// We use dynamic require since holdpty is an ESM package
let protocol: any = null;
async function getProtocol() {
  if (!protocol) {
    protocol = await import("holdpty/dist/protocol.js");
  }
  return protocol;
}

let platform: any = null;
async function getPlatform() {
  if (!platform) {
    platform = await import("holdpty/dist/platform.js");
  }
  return platform;
}

export class HoldptyController {
  private holdptyPath = "holdpty";
  private holdptyChecked = false;

  /**
   * Ensures holdpty is available (via npx or direct path).
   */
  private async ensureHoldpty(): Promise<void> {
    if (this.holdptyChecked) return;

    try {
      const { stdout } = await execFile("npx", ["holdpty", "--version"]);
      if (stdout.includes("holdpty")) {
        this.holdptyPath = "npx";
        this.holdptyChecked = true;
        return;
      }
    } catch { /* try direct */ }

    try {
      const { stdout } = await execFile("holdpty", ["--version"]);
      if (stdout.includes("holdpty")) {
        this.holdptyPath = "holdpty";
        this.holdptyChecked = true;
        return;
      }
    } catch {
      throw new Error("holdpty is not installed. Run: npm install holdpty");
    }
  }

  /**
   * Run a holdpty CLI command.
   */
  private async run(...args: string[]): Promise<string> {
    await this.ensureHoldpty();

    try {
      if (this.holdptyPath === "npx") {
        const { stdout } = await execFile("npx", ["holdpty", ...args]);
        return stdout;
      }
      const { stdout } = await execFile(this.holdptyPath, args);
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
   * Creates a new holdpty session (replaces tmux newSession).
   */
  async newSession(
    name: string,
    width: number = 200,
    height: number = 50,
  ): Promise<void> {
    const shell = process.env.SHELL || "/bin/bash";
    await this.run(
      "launch", "--bg",
      "--name", name,
      "--cols", String(width),
      "--rows", String(height),
      "--", shell,
    );
  }

  /**
   * Checks whether a holdpty session exists.
   */
  async hasSession(name: string): Promise<boolean> {
    try {
      const output = await this.run("ls", "--json");
      const sessions = JSON.parse(output);
      return sessions.some((s: any) => s.name === name);
    } catch {
      return false;
    }
  }

  /**
   * Kills a holdpty session.
   */
  async killSession(name: string): Promise<void> {
    try {
      await this.run("stop", name);
    } catch {
      // Already dead — that's fine
    }
  }

  /**
   * Send keystrokes to a holdpty session via the binary protocol.
   * Connects in attach mode, sends DATA_IN frame, then disconnects.
   */
  async sendKeys(
    session: string,
    keys: string,
    options?: { literal?: boolean },
  ): Promise<void> {
    const proto = await getProtocol();
    const socketPath = await this.getSocketPath(session);

    const data = options?.literal ? keys : keys;

    return new Promise<void>((resolve, reject) => {
      const socket = net.createConnection(socketPath, () => {
        // Send HELLO with attach mode
        const hello = proto.encodeHello({
          mode: "attach",
          protocolVersion: 1,
        });
        socket.write(hello);
      });

      let gotAck = false;

      socket.on("data", (chunk: Buffer) => {
        if (!gotAck) {
          // First response should be HELLO_ACK — parse header
          if (chunk.length >= 5 && chunk[0] === proto.MSG.HELLO_ACK) {
            gotAck = true;

            // Send DATA_IN with the keys
            const dataFrame = proto.encodeDataIn(Buffer.from(data, "utf-8"));
            socket.write(dataFrame);

            // If not literal, also send Enter
            if (!options?.literal) {
              const enterFrame = proto.encodeDataIn(Buffer.from("\n", "utf-8"));
              socket.write(enterFrame);
            }

            // Disconnect after a brief delay to let data flush
            setTimeout(() => {
              socket.destroy();
              resolve();
            }, 50);
          }
        }
      });

      socket.on("error", (err) => {
        const msg = err.message;
        // Gracefully handle stale/dead sessions
        if (msg.includes("ENOENT") || msg.includes("ECONNREFUSED") || msg.includes("no such file")) {
          process.stderr.write(`[HoldptyController] Ignoring stale session error for ${session}: ${msg}\n`);
          resolve();
          return;
        }
        reject(err);
      });

      // Timeout after 5s
      setTimeout(() => {
        socket.destroy();
        resolve(); // Don't fail on timeout — best effort
      }, 5000);
    });
  }

  /**
   * Send raw terminal input (no Enter appended). For interactive terminal streaming.
   */
  async sendRawInput(session: string, data: string): Promise<void> {
    await this.sendKeys(session, data, { literal: true });
  }

  /**
   * Captures terminal output from a holdpty session (replaces tmux capturePane).
   */
  async capturePane(session: string, lines: number = 1000, _escapeSequences: boolean = false): Promise<string> {
    try {
      const output = await this.run("logs", session, "--tail", String(lines));
      return output;
    } catch {
      return "";
    }
  }

  /**
   * Lists all active holdpty sessions.
   */
  async listSessions(): Promise<string[]> {
    try {
      const output = await this.run("ls", "--json");
      const sessions = JSON.parse(output);
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
   * Start piping session output to a log file (replaces tmux pipePaneStart).
   */
  async pipePaneStart(session: string, outputFile: string): Promise<void> {
    try {
      const child = require("child_process").spawn(
        "npx", ["holdpty", "logs", session, "--follow"],
        {
          stdio: ["ignore", fs.openSync(outputFile, "a"), "ignore"],
          detached: true,
        },
      );
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
   * Gets the PID of the process running in a session.
   */
  async getPanePID(session: string): Promise<number | null> {
    try {
      const output = await this.run("info", session);
      // info returns JSON-like output with metadata
      const info = JSON.parse(output);
      return info.childPid || info.pid || null;
    } catch {
      return null;
    }
  }

  /**
   * Run a raw holdpty command (for resize and other direct operations).
   */
  async run_raw(...args: string[]): Promise<string> {
    return this.run(...args);
  }
}
