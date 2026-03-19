/**
 * Terminal Analyzer — Infers agent status from terminal output.
 *
 * Examines the last N lines of an agent's terminal to determine what the agent
 * is currently doing: idle, working, waiting for input, stuck, or errored.
 */

/** Possible inferred terminal statuses */
export type TerminalStatus =
  | "idle"           // At shell prompt, no activity
  | "working"        // Text is flowing, agent is actively producing output
  | "waiting-input"  // Waiting for user/orchestrator input (permission prompt, question)
  | "stuck"          // Same output for >5 minutes with no prompt
  | "error";         // Error messages visible in terminal

export interface TerminalStatusResult {
  agentId: string;
  status: TerminalStatus;
  lastLines: string[];
  lastActivity: string;       // ISO timestamp
  inferred: string;           // Human-readable description
  confidence: "high" | "medium" | "low";
}

// ── Pattern Definitions ──────────────────────────────────────────────

/** Shell prompt patterns indicating the agent is at an interactive prompt */
const PROMPT_PATTERNS = [
  /[$%>#❯]\s*$/,                        // Generic shell prompts
  /\w+@\w+.*[$%>]\s*$/,                 // user@host style
  /^\s*\[.*?\]\s*[$%>]\s*$/,            // Bracketed prompts
  /\?\s+for shortcuts\s*$/,             // Claude Code "? for shortcuts"
];

/** Patterns that indicate the agent is waiting for user input */
const WAITING_INPUT_PATTERNS = [
  /waiting for your input/i,
  /Do you want to proceed/i,
  /\(y\/n\)/i,
  /\(Y\/n\)/i,
  /\[y\/N\]/i,
  /Press Enter to continue/i,
  /approve|reject|allow|deny/i,
  /permission/i,
  /Would you like to/i,
  /Do you want to/i,
  /\? for shortcuts/,                    // Claude Code idle prompt
];

/** Patterns that indicate the agent is actively working */
const WORKING_PATTERNS = [
  /Channeling/i,
  /Mustering/i,
  /Thinking/i,
  /Reading\s+\S+/i,                     // Reading file.ts
  /Writing\s+\S+/i,                     // Writing file.ts
  /Running\s+\S+/i,                     // Running command
  /Editing\s+\S+/i,                     // Editing file.ts
  /Searching/i,
  /Analyzing/i,
  /Creating\s+\S+/i,
  /Updating\s+\S+/i,
  /Installing/i,
  /Building/i,
  /Compiling/i,
  /Executing/i,
  /[\u2830-\u283f]/,                     // Braille spinner characters
  /[⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏]/,                    // Spinner animation
];

/** Patterns that indicate an error state */
const ERROR_PATTERNS = [
  /Error:/i,
  /FATAL:/i,
  /panic:/i,
  /Traceback \(most recent call last\)/,
  /Segmentation fault/i,
  /SIGKILL|SIGTERM|SIGSEGV/,
  /out of memory/i,
  /Permission denied/i,
  /command not found/i,
  /No such file or directory/,
  /ENOENT|EACCES|ECONNREFUSED/,
];

// ── Analysis Functions ──────────────────────────────────────────────

/**
 * Analyze terminal output lines and infer the agent's current status.
 *
 * @param agentId - The agent ID
 * @param lines - Terminal output lines (last N lines, stripped of ANSI if possible)
 * @param lastActivity - ISO timestamp of last known activity
 * @param stuckThresholdMs - How long without change to consider "stuck" (default 5 min)
 */
export function analyzeTerminalOutput(
  agentId: string,
  lines: string[],
  lastActivity: string,
  stuckThresholdMs: number = 5 * 60 * 1000,
): TerminalStatusResult {
  // Filter out empty lines for analysis but keep all for response
  const nonEmptyLines = lines.filter(l => l.trim().length > 0);

  if (nonEmptyLines.length === 0) {
    return {
      agentId,
      status: "idle",
      lastLines: lines,
      lastActivity,
      inferred: "No terminal output detected",
      confidence: "low",
    };
  }

  // Check last few lines for patterns (most recent output is most relevant)
  const lastFewLines = nonEmptyLines.slice(-5);
  const lastLine = nonEmptyLines[nonEmptyLines.length - 1] || "";

  // 1. Check for waiting-input patterns (highest priority — needs user action)
  for (const line of lastFewLines) {
    if (WAITING_INPUT_PATTERNS.some(p => p.test(line))) {
      return {
        agentId,
        status: "waiting-input",
        lastLines: lines,
        lastActivity,
        inferred: `Agent is waiting for input: "${truncate(line, 80)}"`,
        confidence: "high",
      };
    }
  }

  // 2. Check for error patterns
  for (const line of lastFewLines) {
    if (ERROR_PATTERNS.some(p => p.test(line))) {
      return {
        agentId,
        status: "error",
        lastLines: lines,
        lastActivity,
        inferred: `Error detected: "${truncate(line, 80)}"`,
        confidence: "medium",
      };
    }
  }

  // 3. Check for working patterns
  for (const line of lastFewLines) {
    if (WORKING_PATTERNS.some(p => p.test(line))) {
      return {
        agentId,
        status: "working",
        lastLines: lines,
        lastActivity,
        inferred: `Agent is actively working: "${truncate(line, 80)}"`,
        confidence: "high",
      };
    }
  }

  // 4. Check for shell prompt (idle)
  if (PROMPT_PATTERNS.some(p => p.test(lastLine))) {
    return {
      agentId,
      status: "idle",
      lastLines: lines,
      lastActivity,
      inferred: "At shell prompt, no activity detected",
      confidence: "high",
    };
  }

  // 5. Check if stuck (output hasn't changed for threshold)
  const timeSinceActivity = Date.now() - new Date(lastActivity).getTime();
  if (timeSinceActivity > stuckThresholdMs) {
    return {
      agentId,
      status: "stuck",
      lastLines: lines,
      lastActivity,
      inferred: `No output change for ${Math.round(timeSinceActivity / 60000)} minutes`,
      confidence: "medium",
    };
  }

  // 6. Default: assume working if recent activity, otherwise idle
  if (timeSinceActivity < 30_000) {
    return {
      agentId,
      status: "working",
      lastLines: lines,
      lastActivity,
      inferred: "Recent terminal activity detected",
      confidence: "low",
    };
  }

  return {
    agentId,
    status: "idle",
    lastLines: lines,
    lastActivity,
    inferred: `No recognized pattern, last activity ${Math.round(timeSinceActivity / 1000)}s ago`,
    confidence: "low",
  };
}

/** Truncate a string to maxLen characters */
function truncate(str: string, maxLen: number): string {
  const trimmed = str.trim();
  if (trimmed.length <= maxLen) return trimmed;
  return trimmed.slice(0, maxLen - 3) + "...";
}
