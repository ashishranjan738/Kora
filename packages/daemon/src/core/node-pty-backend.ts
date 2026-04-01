/**
 * NodePtyBackend — IPtyBackend implementation using node-pty directly.
 *
 * Each agent gets a node-pty process with a ring buffer for output capture.
 *
 * Key characteristics:
 * - No external processes required
 * - capturePane reads from in-memory ring buffer
 * - Sessions do NOT survive daemon restart (no persistence layer yet)
 */

import * as pty from "node-pty";
import type { IPty } from "node-pty";
import type { IPtyBackend } from "./pty-backend.js";
import { RingBuffer } from "./ring-buffer.js";
import { logger } from "./logger.js";
import fs from "fs";

interface NodePtySession {
  ptyProcess: IPty;
  buffer: RingBuffer;
  name: string;
  env: Record<string, string>;
  pipeFile?: string;
  pipeStream?: fs.WriteStream;
  pipeDisposable?: { dispose(): void };
}

const RING_BUFFER_CAPACITY = 1000;

export class NodePtyBackend implements IPtyBackend {
  private sessions = new Map<string, NodePtySession>();

  async newSession(name: string, width = 120, height = 40): Promise<void> {
    if (this.sessions.has(name)) {
      logger.warn(`[node-pty-backend] Session "${name}" already exists, killing old one`);
      await this.killSession(name);
    }

    const shell = process.env.SHELL || "/bin/bash";
    const env = { ...process.env, TERM: "xterm-256color" } as Record<string, string>;

    const ptyProcess = pty.spawn(shell, [], {
      name: "xterm-256color",
      cols: width,
      rows: height,
      cwd: process.env.HOME || "/tmp",
      env,
    });

    const buffer = new RingBuffer(RING_BUFFER_CAPACITY);

    // Feed all output into the ring buffer
    ptyProcess.onData((data: string) => {
      buffer.write(data);
    });

    const session: NodePtySession = { ptyProcess, buffer, name, env };
    this.sessions.set(name, session);

    logger.info(`[node-pty-backend] Created session "${name}" (PID: ${ptyProcess.pid})`);
  }

  async hasSession(name: string): Promise<boolean> {
    return this.sessions.has(name);
  }

  async killSession(name: string): Promise<void> {
    const session = this.sessions.get(name);
    if (!session) return;

    // Stop pipe if active
    if (session.pipeStream) {
      try { session.pipeStream.end(); } catch {}
    }

    try {
      session.ptyProcess.kill();
    } catch (err) {
      logger.warn({ err }, `[node-pty-backend] Error killing session "${name}"`);
    }

    this.sessions.delete(name);
    logger.info(`[node-pty-backend] Killed session "${name}"`);
  }

  async sendKeys(session: string, keys: string, _options?: { literal?: boolean }): Promise<void> {
    const s = this.sessions.get(session);
    if (!s) throw new Error(`Session "${session}" not found`);
    // sendKeys always appends Enter (\r) per IPtyBackend contract
    s.ptyProcess.write(keys + "\r");
  }

  async sendRawInput(session: string, data: string): Promise<void> {
    const s = this.sessions.get(session);
    if (!s) throw new Error(`Session "${session}" not found`);
    s.ptyProcess.write(data);
  }

  async capturePane(session: string, lines = 50, _escapeSequences?: boolean): Promise<string> {
    const s = this.sessions.get(session);
    if (!s) throw new Error(`Session "${session}" not found`);
    return s.buffer.getLastLines(lines).join("\n");
  }

  async listSessions(): Promise<string[]> {
    return Array.from(this.sessions.keys());
  }

  async setEnvironment(session: string, key: string, value: string): Promise<void> {
    const s = this.sessions.get(session);
    if (!s) throw new Error(`Session "${session}" not found`);
    // Set env var via shell export command
    s.ptyProcess.write(`export ${key}=${JSON.stringify(value)}\r`);
    s.env[key] = value;
  }

  async pipePaneStart(session: string, outputFile: string): Promise<void> {
    const s = this.sessions.get(session);
    if (!s) throw new Error(`Session "${session}" not found`);

    // Stop existing pipe if any
    await this.pipePaneStop(session);

    s.pipeFile = outputFile;
    s.pipeStream = fs.createWriteStream(outputFile, { flags: "a" });

    // Tap into pty output for file logging — store disposable to avoid leaks
    const disposable = s.ptyProcess.onData((data: string) => {
      if (s.pipeStream && !s.pipeStream.destroyed) {
        s.pipeStream.write(data);
      }
    });
    s.pipeDisposable = disposable;
  }

  async pipePaneStop(session: string): Promise<void> {
    const s = this.sessions.get(session);
    if (!s) return;
    if (s.pipeDisposable) {
      try { s.pipeDisposable.dispose(); } catch {}
      s.pipeDisposable = undefined;
    }
    if (s.pipeStream) {
      try { s.pipeStream.end(); } catch {}
      s.pipeStream = undefined;
      s.pipeFile = undefined;
    }
  }

  async getPanePID(session: string): Promise<number | null> {
    const s = this.sessions.get(session);
    if (!s) return null;
    return s.ptyProcess.pid;
  }

  async run_raw(..._args: string[]): Promise<string> {
    // No external backend binary to run raw commands against
    return "";
  }

  getAttachCommand(session: string): { command: string; args: string[] } {
    // For node-pty backend, terminal streaming is handled directly
    // via the PtyManager, not by attaching to an external process.
    // Return a dummy command that the PtyManager will detect.
    return { command: "echo", args: [`node-pty-session:${session}`] };
  }

  /** Get the ring buffer for a session (for direct access by consumers). */
  getBuffer(session: string): RingBuffer | undefined {
    return this.sessions.get(session)?.buffer;
  }

  /** Destroy all sessions (daemon shutdown). */
  async destroyAll(): Promise<void> {
    const names = Array.from(this.sessions.keys());
    await Promise.allSettled(names.map(name => this.killSession(name)));
  }
}
