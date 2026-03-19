/**
 * MockPtyBackend — in-memory mock implementation of IPtyBackend for integration tests.
 * Simulates terminal sessions without spawning actual processes.
 */

import type { IPtyBackend } from "../core/pty-backend.js";

export class MockPtyBackend implements IPtyBackend {
  private sessions = new Map<string, {
    output: string[];
    env: Map<string, string>;
    pid: number;
    alive: boolean;
  }>();

  private nextPid = 10000;

  async newSession(name: string, width: number = 200, height: number = 50): Promise<void> {
    this.sessions.set(name, {
      output: [`Session ${name} created (${width}x${height})`],
      env: new Map(),
      pid: this.nextPid++,
      alive: true,
    });
  }

  async hasSession(name: string): Promise<boolean> {
    const session = this.sessions.get(name);
    return session !== undefined && session.alive;
  }

  async killSession(name: string): Promise<void> {
    const session = this.sessions.get(name);
    if (session) {
      session.alive = false;
    }
  }

  async sendKeys(session: string, keys: string, options?: { literal?: boolean }): Promise<void> {
    const sess = this.sessions.get(session);
    if (sess && sess.alive) {
      // Always append newline — mirrors holdpty/tmux behavior where Enter is always sent
      sess.output.push(`> ${keys}\n`);
    }
  }

  async sendRawInput(session: string, data: string): Promise<void> {
    // Raw input: no Enter appended (for xterm.js keystroke forwarding)
    const sess = this.sessions.get(session);
    if (sess && sess.alive) {
      sess.output.push(`> ${data}`);
    }
  }

  async capturePane(session: string, lines: number = 1000, _escapeSequences: boolean = false): Promise<string> {
    const sess = this.sessions.get(session);
    if (!sess) {
      return "";
    }
    return sess.output.slice(-lines).join("\n");
  }

  async listSessions(): Promise<string[]> {
    return Array.from(this.sessions.entries())
      .filter(([_, sess]) => sess.alive)
      .map(([name]) => name);
  }

  async setEnvironment(session: string, key: string, value: string): Promise<void> {
    const sess = this.sessions.get(session);
    if (sess) {
      sess.env.set(key, value);
    }
  }

  async pipePaneStart(_session: string, _outputFile: string): Promise<void> {
    // No-op in mock
  }

  async pipePaneStop(_session: string): Promise<void> {
    // No-op in mock
  }

  async getPanePID(session: string): Promise<number | null> {
    const sess = this.sessions.get(session);
    return sess?.alive ? sess.pid : null;
  }

  async run_raw(..._args: string[]): Promise<string> {
    return "mock run_raw output";
  }

  getAttachCommand(session: string): { command: string; args: string[] } {
    return {
      command: "echo",
      args: [`Mock attach to ${session}`],
    };
  }

  // Helper methods for testing
  addOutput(session: string, output: string): void {
    const sess = this.sessions.get(session);
    if (sess) {
      sess.output.push(output);
    }
  }

  getSessionOutput(session: string): string[] {
    return this.sessions.get(session)?.output || [];
  }

  reset(): void {
    this.sessions.clear();
    this.nextPid = 10000;
  }
}
