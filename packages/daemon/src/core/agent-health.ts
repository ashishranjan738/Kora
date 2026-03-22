import type { AgentState, AgentHealthCheck } from "@kora/shared";
import { HEALTH_CHECK_INTERVAL_MS, MAX_CONSECUTIVE_FAILURES } from "@kora/shared";
import type { IPtyBackend } from "./pty-backend.js";
import { EventEmitter } from "events";
import { logger } from "./logger.js";

/**
 * Comprehensive ANSI escape sequence regex (matches ansi-regex npm package).
 * Covers:
 * - OSC sequences: ESC ] ... (ST|BEL) — window titles, hyperlinks, etc.
 * - CSI sequences: ESC [ ... letter — colors, cursor movement, erasing
 * - Other C1 escapes: ESC followed by various characters
 *
 * Used to normalize holdpty's raw PTY output before hashing and pattern matching.
 * Without this, cursor blink sequences, window title updates, and other invisible
 * ANSI output causes the hash to change every poll — falsely marking idle agents
 * as "working".
 */
const ANSI_REGEX = /(?:\u001B\][\s\S]*?(?:\u0007|\u001B\u005C|\u009C))|[\u001B\u009B][[\]()#;?]*(?:\d{1,4}(?:[;:]\d{0,4})*)?[\dA-PR-TZcf-nq-uy=><~]/g;

/**
 * Strip all ANSI escape sequences from terminal output.
 * Fast path: returns input unchanged if no ESC/CSI characters present.
 */
export function stripAnsi(text: string): string {
  if (!text.includes('\u001B') && !text.includes('\u009B')) {
    return text;
  }
  return text.replace(ANSI_REGEX, '');
}

/** Shell prompt patterns that indicate the agent is idle at a command prompt */
/**
 * Strong idle signals — mark idle IMMEDIATELY when detected.
 * These are explicit "I'm waiting for input" indicators.
 */
export const STRONG_IDLE_PATTERNS = [
  // Claude Code (handle both spaced and stripped output)
  /\?\s*for\s*shortcuts/i,         // "? for shortcuts" prompt (with or without spaces)
  /bypass\s*permissions\s*on/i,    // Permission mode prompt
  /esc\s*to\s*interrupt/i,         // Interrupt hint
  /shift\+tab\s*to\s*cycle/i,      // Tab cycle hint
  /What\s*would\s*you\s*like/i,    // Asking for input

  // Aider
  /aider>\s*$/i,                   // Aider prompt

  // Codex
  /codex>\s*$/i,                   // Codex prompt
  /What would you like to do/i,    // Codex asking for input

  // Goose
  /goose>\s*$/i,                   // Goose prompt

  // Generic explicit idle (handle stripped whitespace)
  /waiting\s*for\s*your\s*input/i,
  /How\s*can\s*I\s*help/i,
  /ready\s*and\s*waiting/i,
  /Standing\s*by/i,
  /Standingby/i,                   // Fully stripped version
  /Enter\s*your\s*(?:message|prompt|query)/i,
  /Type\s*(?:your|a)\s*(?:message|prompt|question)/i,
];

/**
 * Weak idle signals — wait for IDLE_TIMEOUT before marking idle.
 * These are shell prompts that could just be between commands.
 */
export const WEAK_IDLE_PATTERNS = [
  /[$%>#\u276F]\s*$/,              // Generic shell prompts (❯, $, %, >, #)
  /\s+[$%>\u276F]\s*$/,            // Shell prompts with leading whitespace
  /\w+@\w+\s+[$%>]\s*$/,           // user@host style
  /^\s*\[.*?\]\s*[$%>]\s*$/,       // Bracketed prompts
  /^\s*>\s*$/,                     // Bare ">" prompt
  /^\(\w+\)\s*$/,                  // Virtual env style prompt
];

/** Combined for backward compatibility */
export const IDLE_PROMPT_PATTERNS = [...STRONG_IDLE_PATTERNS, ...WEAK_IDLE_PATTERNS];

/**
 * Thinking/processing patterns — LLM spinner characters and processing text.
 * When detected, agent is WORKING (thinking), NOT idle.
 * These override idle detection to prevent false idle during LLM processing.
 */
export const THINKING_PATTERNS = [
  // Braille spinner characters (Claude Code, various CLI tools)
  /[⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏]/,
  // Unicode spinner/star characters
  /[✳✶✻✽✢⣾⣽⣻⢿⡿⣟⣯⣷]/,
  // Text-based processing indicators (case insensitive)
  /\b(?:thinking|processing|generating|analyzing|reasoning)\b/i,
  // Claude Code fun spinners
  /\b(?:photosynthesizing|hyperspacing|flummoxing|razzmatazzing|brewing|crunching|cooking|baking)\b/i,
  // Generic progress indicators
  /\b(?:loading|compiling|building|running|executing|searching|scanning)\.\.\./i,
];

/**
 * Keywords in agent messages that indicate the agent is idle/done.
 * When detected in send_message content, immediately infer idle status.
 */
export const IDLE_MESSAGE_KEYWORDS = [
  "standing by",
  "task complete",
  "ready for next",
  "ready for new",
  "waiting for",
  "completed the task",
  "finished the task",
  "done with",
  "all done",
  "reporting idle",
];

/** How long to wait at a prompt before considering an agent idle (ms) */
const IDLE_TIMEOUT_MS = 30_000; // 30 seconds — 10s was too aggressive, causing false idle during code reading

/**
 * How long an MCP-reported idle status is protected from terminal override (ms).
 * During this window, only clear non-prompt terminal output will override idle.
 * This prevents terminal polling from flapping the status right after an agent
 * explicitly reports itself as idle.
 */
const MCP_IDLE_PROTECTION_MS = 60_000; // 1 minute (was 2min — reduced; cleared on user message)

export class AgentHealthMonitor extends EventEmitter {
  private intervals = new Map<string, NodeJS.Timeout>();
  private lastOutputTimestamps = new Map<string, number>();
  private lastOutputCache = new Map<string, string>();
  private agents?: Map<string, AgentState>;

  /**
   * Layer 1: MCP-reported idle timestamps.
   * When an agent calls report_idle or sends a completion message,
   * we record the timestamp here. Terminal polling won't override
   * idle status while within the protection window.
   */
  private mcpIdleTimestamps = new Map<string, number>();

  /**
   * Layer 3: MCP tool call activity timestamps.
   * When an agent makes any MCP call (send_message, list_tasks, etc.),
   * we record it here. If within IDLE_TIMEOUT_MS, agent is "working"
   * regardless of terminal output (agent may be reading code silently).
   */
  private lastMcpCallTimestamps = new Map<string, number>();

  constructor(
    private tmux: IPtyBackend,
    agents?: Map<string, AgentState>
  ) {
    super();
    this.agents = agents;
  }

  /** Set the agents map for idle detection (called after AgentManager construction) */
  setAgentsMap(agents: Map<string, AgentState>): void {
    this.agents = agents;
  }

  /**
   * Layer 1 (highest confidence): Mark agent as idle from MCP signal.
   * Called when:
   * - Agent calls report_idle MCP tool (via API)
   * - Agent sends a completion message with idle keywords
   *
   * This immediately sets activity to "idle" and protects it from
   * being overridden by terminal polling for MCP_IDLE_PROTECTION_MS.
   */
  markIdleFromMcp(agentId: string, reason?: string): void {
    const agent = this.agents?.get(agentId);
    if (!agent) return;

    this.mcpIdleTimestamps.set(agentId, Date.now());

    if (agent.activity !== "idle") {
      agent.activity = "idle";
      agent.lastActivityAt = new Date().toISOString();
      agent.idleSince = new Date().toISOString();
      this.emit("agent-idle", agentId);
    }
  }

  /**
   * Check if a message contains idle/completion keywords.
   * Used to infer idle status from send_message content.
   */
  static isMessageIdle(content: string): boolean {
    const lower = content.toLowerCase();
    return IDLE_MESSAGE_KEYWORDS.some(kw => lower.includes(kw));
  }

  /**
   * Clear MCP idle protection — called when user sends a message to the agent.
   * This allows terminal polling to immediately detect the agent as "working"
   * when the agent starts processing the user's input.
   */
  clearIdleProtection(agentId: string): void {
    this.mcpIdleTimestamps.delete(agentId);
    // Also reset the output cache so the next poll detects change
    this.lastOutputCache.delete(agentId);
  }

  /**
   * Layer 3: Record MCP tool call activity.
   * Called when an agent makes any MCP call (send_message, list_tasks, check_messages, etc.).
   * If within IDLE_TIMEOUT_MS, agent is considered "working" even if terminal shows no output
   * (e.g. agent is reading code via Read tool — no terminal output but definitely working).
   */
  recordMcpActivity(agentId: string): void {
    this.lastMcpCallTimestamps.set(agentId, Date.now());
    // If agent was idle, flip to working
    const agent = this.agents?.get(agentId);
    if (agent && agent.activity === "idle") {
      agent.activity = "working";
      agent.lastActivityAt = new Date().toISOString();
      delete agent.idleSince;
      this.mcpIdleTimestamps.delete(agentId);
      this.emit("agent-working", agentId);
    }
  }

  /**
   * Check if agent has recent MCP activity (within IDLE_TIMEOUT_MS).
   */
  private hasMcpActivity(agentId: string): boolean {
    const t = this.lastMcpCallTimestamps.get(agentId);
    return !!t && (Date.now() - t) < IDLE_TIMEOUT_MS;
  }

  /**
   * Check if an agent's idle status is protected by a recent MCP report.
   */
  private isMcpIdleProtected(agentId: string): boolean {
    const mcpTime = this.mcpIdleTimestamps.get(agentId);
    if (!mcpTime) return false;
    return (Date.now() - mcpTime) < MCP_IDLE_PROTECTION_MS;
  }

  /** Start monitoring an agent */
  startMonitoring(agentId: string, tmuxSession: string): void {
    const interval = setInterval(async () => {
      const alive = await this.tmux.hasSession(tmuxSession);
      if (!alive) {
        this.emit("agent-dead", agentId);
        return;
      }

      const pid = await this.tmux.getPanePID(tmuxSession);
      if (pid === null) {
        this.emit("agent-dead", agentId);
        return;
      }

      this.emit("agent-alive", agentId);

      // Idle detection: check terminal output for activity
      if (this.agents) {
        await this.checkIdleState(agentId, tmuxSession);
      }
    }, HEALTH_CHECK_INTERVAL_MS);
    this.intervals.set(agentId, interval);
    this.lastOutputTimestamps.set(agentId, Date.now());
  }

  /**
   * Check if agent is idle by examining terminal output.
   *
   * 3-layer confidence system:
   * - Layer 1 (highest): MCP report_idle / completion message -> instant idle (protected)
   * - Layer 2: Terminal prompt pattern matching (❯, $, %) -> idle after match
   * - Layer 3 (lowest): Hash-based change detection -> idle after 30s no change
   */
  private async checkIdleState(agentId: string, tmuxSession: string): Promise<void> {
    const agent = this.agents?.get(agentId);
    if (!agent) return;

    try {
      // Capture last 10 lines of terminal output.
      // capturePane(escapeSequences=false) strips ANSI in holdpty mode.
      const rawOutput = await this.tmux.capturePane(tmuxSession, 10, false);
      // Normalize output to prevent false "changed" detections from cursor movement,
      // trailing whitespace variations, and shell status line updates
      const output = rawOutput.split('\n').map(l => l.trimEnd()).filter(l => l).join('\n');
      const lastOutput = this.lastOutputCache.get(agentId) || "";

      // Layer 2: Check if current output shows idle or thinking indicators.
      // Check last 5 non-empty lines for patterns.
      const lines = output.trim().split('\n').filter(l => l.trim());
      const lastLines = lines.slice(-5);

      // Check for thinking/spinner patterns FIRST — override idle detection
      const isThinking = lastLines.some(line =>
        THINKING_PATTERNS.some(pattern => pattern.test(line))
      );

      if (isThinking) {
        // LLM is processing — definitely working, update timestamps
        this.lastOutputTimestamps.set(agentId, Date.now());
        if (agent.activity !== "working") {
          agent.activity = "working";
          agent.lastActivityAt = new Date().toISOString();
          agent.lastOutputAt = new Date().toISOString();
          delete agent.idleSince;
          this.mcpIdleTimestamps.delete(agentId);
          this.emit("agent-working", agentId);
        } else {
          agent.lastOutputAt = new Date().toISOString();
        }
        this.lastOutputCache.set(agentId, output);
        return;
      }

      const isStrongIdle = lastLines.some(line =>
        STRONG_IDLE_PATTERNS.some(pattern => pattern.test(line))
      );
      const isWeakIdle = !isStrongIdle && lastLines.some(line =>
        WEAK_IDLE_PATTERNS.some(pattern => pattern.test(line))
      );
      const isAtPrompt = isStrongIdle || isWeakIdle;

      // If output has changed
      if (output !== lastOutput) {
        this.lastOutputCache.set(agentId, output);

        // If at a prompt/idle indicator, don't mark as working
        if (isAtPrompt) {
          // Layer 3: Check MCP activity — if agent made an MCP call recently,
          // it's working (e.g. reading code via Read tool) even though terminal shows prompt
          if (this.hasMcpActivity(agentId)) {
            // Agent is actively using MCP tools — not idle
            this.lastOutputTimestamps.set(agentId, Date.now());
            return;
          }

          // Strong idle signals → mark idle IMMEDIATELY (no timeout wait)
          if (isStrongIdle && agent.activity !== "idle") {
            agent.activity = "idle";
            agent.lastActivityAt = new Date().toISOString();
            agent.idleSince = new Date().toISOString();
            this.emit("agent-idle", agentId);
          }
          // Weak idle signals → wait for timeout before marking idle
          else if (isWeakIdle) {
            // Update timestamp when output actually changes (even at prompt)
            // This prevents stale timestamps from causing premature idle
            this.lastOutputTimestamps.set(agentId, Date.now());
            const timeSinceOutput = Date.now() - (this.lastOutputTimestamps.get(agentId) || Date.now());
            if (timeSinceOutput > IDLE_TIMEOUT_MS && agent.activity !== "idle") {
              agent.activity = "idle";
              agent.lastActivityAt = new Date().toISOString();
              agent.idleSince = new Date().toISOString();
              this.emit("agent-idle", agentId);
            }
          }
          return;
        }

        // Output changed and NOT at a prompt -> real work is happening
        this.lastOutputTimestamps.set(agentId, Date.now());

        // Layer 1 check: If agent recently reported idle via MCP, don't
        // override to "working" from terminal noise. Only clear MCP idle
        // protection when there's sustained new output (not just one poll).
        if (this.isMcpIdleProtected(agentId)) {
          // MCP says idle — trust it over terminal polling
          return;
        }

        // Update activity to "working" if not already
        if (agent.activity !== "working") {
          agent.activity = "working";
          agent.lastActivityAt = new Date().toISOString();
          agent.lastOutputAt = new Date().toISOString();
          delete agent.idleSince;
          this.mcpIdleTimestamps.delete(agentId); // Clear stale MCP idle
          this.emit("agent-working", agentId);
        } else {
          // Still working, just update timestamps
          agent.lastOutputAt = new Date().toISOString();
        }
        return;
      }

      // No output change — check MCP activity before marking idle
      if (this.hasMcpActivity(agentId)) {
        // Agent is using MCP tools (reading code, checking messages, etc.) — not idle
        return;
      }

      if (agent.activity !== "idle") {
        if (isStrongIdle) {
          // Strong pattern + no output change → definitely idle
          agent.activity = "idle";
          agent.lastActivityAt = new Date().toISOString();
          agent.idleSince = new Date().toISOString();
          this.emit("agent-idle", agentId);
        } else if (isWeakIdle) {
          // Weak pattern → wait for timeout
          const lastOutputTime = this.lastOutputTimestamps.get(agentId) || Date.now();
          const timeSinceOutput = Date.now() - lastOutputTime;
          if (timeSinceOutput > IDLE_TIMEOUT_MS) {
            agent.activity = "idle";
            agent.lastActivityAt = new Date().toISOString();
            agent.idleSince = new Date(lastOutputTime).toISOString();
            this.emit("agent-idle", agentId);
          }
        }
      }
    } catch (err) {
      // Ignore errors during idle detection (tmux might be unavailable temporarily)
    }
  }

  /** Stop monitoring an agent */
  stopMonitoring(agentId: string): void {
    const interval = this.intervals.get(agentId);
    if (interval) {
      clearInterval(interval);
      this.intervals.delete(agentId);
    }
    this.lastOutputTimestamps.delete(agentId);
    this.lastOutputCache.delete(agentId);
    this.mcpIdleTimestamps.delete(agentId);
    this.lastMcpCallTimestamps.delete(agentId);
  }

  /** Stop all monitoring */
  stopAll(): void {
    for (const [id] of this.intervals) {
      this.stopMonitoring(id);
    }
  }
}
