/**
 * IPtyBackend — common interface for terminal session management.
 *
 * Both TmuxController and HoldptyController implement this interface,
 * allowing the daemon to switch backends without changing consumer code.
 */

export interface IPtyBackend {
  /** Create a new detached terminal session */
  newSession(name: string, width?: number, height?: number): Promise<void>;

  /** Check if a session exists */
  hasSession(name: string): Promise<boolean>;

  /** Kill/stop a session */
  killSession(name: string): Promise<void>;

  /** Send keystrokes to a session. If literal, don't append Enter. */
  sendKeys(session: string, keys: string, options?: { literal?: boolean }): Promise<void>;

  /** Send raw terminal input (no Enter appended) */
  sendRawInput(session: string, data: string): Promise<void>;

  /** Capture terminal output (last N lines) */
  capturePane(session: string, lines?: number, escapeSequences?: boolean): Promise<string>;

  /** List all active session names */
  listSessions(): Promise<string[]>;

  /** Set an environment variable in a session */
  setEnvironment(session: string, key: string, value: string): Promise<void>;

  /** Start piping session output to a file */
  pipePaneStart(session: string, outputFile: string): Promise<void>;

  /** Stop piping session output */
  pipePaneStop(session: string): Promise<void>;

  /** Get the PID of the process running in the session */
  getPanePID(session: string): Promise<number | null>;

  /** Run a raw backend command */
  run_raw(...args: string[]): Promise<string>;

  /** Get the command + args to spawn for attaching to a session (for terminal streaming via node-pty) */
  getAttachCommand(session: string): { command: string; args: string[] };

  /** Get the Unix socket path for a session (holdpty only, optional) */
  getSocketPathForSession?(session: string): Promise<string>;
}
