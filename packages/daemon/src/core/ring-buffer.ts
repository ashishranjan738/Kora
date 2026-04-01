/**
 * RingBuffer — fixed-capacity line buffer fed by terminal output.
 *
 * Stores the last N lines of terminal output per agent session.
 * Used as the capturePane replacement for the node-pty backend.
 * Handles ANSI escape sequences and partial line accumulation.
 */

const DEFAULT_CAPACITY = 1000;

export class RingBuffer {
  private lines: string[];
  private head = 0; // next write position
  private count = 0;
  private partial = ""; // accumulates data until a newline
  readonly capacity: number;

  constructor(capacity = DEFAULT_CAPACITY) {
    this.capacity = capacity;
    this.lines = new Array(capacity);
  }

  /** Feed raw terminal data (may contain partial lines, ANSI sequences, \r\n or \n). */
  write(data: string): void {
    const combined = this.partial + data;
    // Split on \n but also handle \r\n
    const parts = combined.split(/\r?\n/);
    // Last element is the new partial (incomplete line)
    this.partial = parts.pop()!;

    for (const line of parts) {
      this.pushLine(line);
    }
  }

  /** Push a complete line into the ring buffer. */
  private pushLine(line: string): void {
    this.lines[this.head] = line;
    this.head = (this.head + 1) % this.capacity;
    if (this.count < this.capacity) this.count++;
  }

  /**
   * Get the last N lines (most recent first → oldest last).
   * Returns lines in chronological order (oldest first).
   */
  getLastLines(n?: number): string[] {
    const requested = Math.min(n ?? this.count, this.count);
    if (requested <= 0) return [];

    const result: string[] = new Array(requested);
    // head points to next write position, so head-1 is the most recent line
    let idx = (this.head - 1 + this.capacity) % this.capacity;
    for (let i = requested - 1; i >= 0; i--) {
      result[i] = this.lines[idx];
      idx = (idx - 1 + this.capacity) % this.capacity;
    }
    return result;
  }

  /** Get all stored lines in chronological order. */
  getAll(): string[] {
    return this.getLastLines(this.count);
  }

  /** Get the most recent complete line, or empty string if none. */
  getLastLine(): string {
    if (this.count === 0) return "";
    const idx = (this.head - 1 + this.capacity) % this.capacity;
    return this.lines[idx];
  }

  /** Get current partial (incomplete) line being accumulated. */
  getPartial(): string {
    return this.partial;
  }

  /** Number of complete lines currently stored. */
  get size(): number {
    return this.count;
  }

  /** Strip ANSI escape sequences from a string. */
  static stripAnsi(str: string): string {
    // Matches: CSI sequences, OSC sequences, simple escapes
    return str.replace(
      // eslint-disable-next-line no-control-regex
      /\x1b\[[0-9;]*[a-zA-Z]|\x1b\][^\x07]*\x07|\x1b[()][0-9A-Z]|\x1b[>=<]|\x1b\[[0-9;]*m|\r/g,
      ""
    );
  }

  /**
   * Get last N lines with ANSI sequences stripped.
   * Useful for text analysis (idle detection, @mention parsing, etc.).
   */
  getLastLinesClean(n?: number): string[] {
    return this.getLastLines(n).map(RingBuffer.stripAnsi);
  }

  /** Clear all data. */
  clear(): void {
    this.lines = new Array(this.capacity);
    this.head = 0;
    this.count = 0;
    this.partial = "";
  }
}
