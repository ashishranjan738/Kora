import { execFile as execFileCb } from "child_process";
import { promisify } from "util";

const execFile = promisify(execFileCb);

export class TmuxController {
  private tmuxChecked = false;
  private tmuxPath = "tmux";

  /**
   * Ensures tmux is available on the system. Called lazily on first use.
   */
  private async ensureTmux(): Promise<void> {
    if (this.tmuxChecked) return;

    try {
      const { stdout } = await execFile("which", ["tmux"]);
      this.tmuxPath = stdout.trim();
      this.tmuxChecked = true;
    } catch {
      throw new Error(
        "tmux is not installed or not found in PATH. Please install tmux to use the Kora."
      );
    }
  }

  /**
   * Executes a tmux command with the given arguments.
   */
  private async run(...args: string[]): Promise<string> {
    await this.ensureTmux();

    try {
      const { stdout } = await execFile(this.tmuxPath, args);
      return stdout;
    } catch (error: unknown) {
      const message =
        error instanceof Error ? error.message : String(error);
      process.stderr.write(`[TmuxController] Error running tmux ${args[0]}: ${message}\n`);
      throw error;
    }
  }

  /**
   * Creates a new detached tmux session with the given name and optional dimensions.
   * Configures tmux to be invisible to the end user:
   * - Mouse scrolling enabled (no need for Ctrl+B, [)
   * - Status bar hidden (our web UI shows status)
   * - Large scrollback buffer
   * - No escape delay (responsive key input)
   */
  async newSession(
    name: string,
    width: number = 200,
    height: number = 50
  ): Promise<void> {
    await this.run(
      "new-session",
      "-d",
      "-s",
      name,
      "-x",
      String(width),
      "-y",
      String(height)
    );

    // Make tmux completely invisible — user should never know they're in tmux
    await this.run("set-option", "-t", name, "mouse", "on");           // mouse wheel scroll + click
    await this.run("set-option", "-t", name, "status", "off");         // hide tmux status bar
    await this.run("set-option", "-t", name, "history-limit", "50000");// large scrollback
    await this.run("set-option", "-t", name, "escape-time", "0");     // no escape key delay
    await this.run("set-option", "-t", name, "allow-rename", "off");  // don't let CLI change window title
    await this.run("set-option", "-t", name, "display-time", "0");    // don't show tmux messages
    await this.run("set-option", "-t", name, "message-style", "bg=default,fg=default"); // invisible messages
    await this.run("set-option", "-t", name, "pane-border-style", "fg=#0d1117");  // hide pane borders (match bg)
    await this.run("set-option", "-t", name, "pane-active-border-style", "fg=#0d1117"); // hide active pane border too
    await this.run("set-option", "-t", name, "visual-activity", "off");
    await this.run("set-option", "-t", name, "visual-bell", "off");
    await this.run("set-option", "-t", name, "visual-silence", "off");

    // Natural scroll/copy — make tmux behave like a real terminal
    await this.run("set-option", "-t", name, "set-clipboard", "on");         // system clipboard integration
    await this.run("set-option", "-t", name, "mode-keys", "vi");             // vi keys in copy mode
    await this.run("set-option", "-t", name, "terminal-features[0]", "xterm-256color:clipboard:ccolour:cstyle:strikethrough:title:usstyle");
    await this.run("set-option", "-t", name, "scroll-on-clear", "off");      // don't reset scroll position on clear
    await this.run("set-option", "-t", name, "word-separators", " -_@.");    // smarter word selection
    await this.run("set-option", "-t", name, "default-terminal", "xterm-256color"); // proper terminal type
    await this.run("set-window-option", "-t", name, "aggressive-resize", "on"); // resize to smallest connected client
  }

  /**
   * Checks whether a tmux session with the given name exists.
   */
  async hasSession(name: string): Promise<boolean> {
    try {
      await this.run("has-session", "-t", name);
      return true;
    } catch {
      return false;
    }
  }

  /**
   * Kills the tmux session with the given name.
   */
  async killSession(name: string): Promise<void> {
    await this.run("kill-session", "-t", name);
  }

  /**
   * Sends keystrokes to a tmux session. When `literal` is true, the `-l` flag
   * is used to prevent interpretation of escape sequences. An Enter keystroke
   * is sent afterwards.
   */
  async sendKeys(
    session: string,
    keys: string,
    options?: { literal?: boolean }
  ): Promise<void> {
    const args = ["send-keys", "-t", session];

    if (options?.literal) {
      args.push("-l");
    }

    args.push(keys);

    try {
      await this.run(...args);
      // Send Enter after the keys
      await this.run("send-keys", "-t", session, "Enter");
    } catch (error: unknown) {
      const message = error instanceof Error ? error.message : String(error);
      // Gracefully handle stale/dead sessions — don't throw on these
      if (
        message.includes("no current client") ||
        message.includes("session not found") ||
        message.includes("can't find")
      ) {
        process.stderr.write(`[TmuxController] Ignoring stale session error for ${session}: ${message}\n`);
        return;
      }
      throw error;
    }
  }

  /**
   * Send raw terminal input as hex bytes — preserves all escape sequences.
   * Use this for interactive terminal streaming from xterm.js (no Enter appended).
   */
  async sendRawInput(session: string, data: string): Promise<void> {
    // Convert string to hex bytes for tmux send-keys -H
    const hexBytes = Buffer.from(data, "utf-8")
      .toString("hex")
      .match(/.{2}/g)
      ?.join(" ") || "";
    if (hexBytes) {
      await this.run("send-keys", "-t", session, "-H", hexBytes);
    }
  }

  /**
   * Captures the visible pane output from a tmux session.
   * @param session - The session name.
   * @param lines - Number of lines of scrollback to capture (default 1000).
   * @param escapeSequences - If true, preserves ANSI escape sequences via `-e` flag.
   */
  async capturePane(session: string, lines: number = 1000, escapeSequences: boolean = false): Promise<string> {
    const args = ["capture-pane", "-t", session, "-p", "-S", `-${lines}`];
    if (escapeSequences) {
      args.push("-e");
    }
    const output = await this.run(...args);
    return output;
  }

  /**
   * Starts streaming pane output to a file via `tmux pipe-pane`.
   */
  async pipePaneStart(session: string, outputFile: string): Promise<void> {
    await this.run(
      "pipe-pane",
      "-t",
      session,
      `cat >> ${outputFile}`
    );
  }

  /**
   * Stops an active pipe-pane by sending an empty command.
   */
  async pipePaneStop(session: string): Promise<void> {
    await this.run("pipe-pane", "-t", session);
  }

  /**
   * Lists all active tmux session names.
   */
  async listSessions(): Promise<string[]> {
    try {
      const output = await this.run(
        "list-sessions",
        "-F",
        "#{session_name}"
      );
      return output
        .trim()
        .split("\n")
        .filter((name) => name.length > 0);
    } catch {
      // If no tmux server is running, list-sessions will fail
      return [];
    }
  }

  /**
   * Sets an environment variable within a tmux session.
   */
  async setEnvironment(
    session: string,
    key: string,
    value: string
  ): Promise<void> {
    await this.run("set-environment", "-t", session, key, value);
  }

  /**
   * Run a raw tmux command (exposed for resize and other direct operations).
   */
  async run_raw(...args: string[]): Promise<string> {
    return this.run(...args);
  }

  /**
   * Gets the PID of the process running in the pane of the given session.
   * Returns null if the session does not exist or the PID cannot be determined.
   */
  async getPanePID(session: string): Promise<number | null> {
    try {
      const output = await this.run(
        "list-panes",
        "-t",
        session,
        "-F",
        "#{pane_pid}"
      );
      const pid = parseInt(output.trim(), 10);
      return isNaN(pid) ? null : pid;
    } catch {
      return null;
    }
  }
}

const tmux = new TmuxController();
export default tmux;
