import type { AgentActivity } from "@kora/shared";

export enum PatternCategory {
  SHELL_PROMPT = "shell_prompt",
  WAITING_INPUT = "waiting_input",
  THINKING = "thinking",
  TOOL_EXECUTION = "tool_execution",
  INTERACTIVE = "interactive",
  ERROR = "error",
  LONG_RUNNING = "long_running",
  SPAWN = "spawn"
}

export interface PatternDetectorConfig {
  category: PatternCategory;
  targetState: AgentActivity;
  confidence: number;
  priority: number;
  patterns: RegExp[];
}

export interface PatternMatchResult {
  matched: boolean;
  confidence: number;
  category: PatternCategory | null;
  targetState?: AgentActivity;
  priority?: number;
  matchedPattern?: string;
}

/**
 * Comprehensive pattern library for detecting agent activity states
 *
 * Priority order (lower = higher precedence):
 * 1. ERROR - Must catch immediately
 * 2. WAITING_INPUT - Critical for Bug #3 fix
 * 3. SPAWN - Special handling for Bug #4 fix
 * 4. INTERACTIVE - Prevent premature idle marking
 * 5. THINKING - Agent processing
 * 6. TOOL_EXECUTION - Command execution
 * 7. LONG_RUNNING - Long-running tasks
 * 8. SHELL_PROMPT - Default fallback (idle detection)
 */
export const PATTERN_LIBRARY: Record<string, PatternDetectorConfig> = {
  // Category 1: Shell Prompts (11 patterns) - LOWEST PRIORITY (fallback)
  SHELL_PROMPT: {
    category: PatternCategory.SHELL_PROMPT,
    targetState: "idle" as AgentActivity,
    confidence: 80,
    priority: 8,
    patterns: [
      /[$%>#]\s*$/,                        // Generic shell prompts (❯, $, %, >, #)
      /\s+[$%>]\s*$/,                      // Shell prompts with leading whitespace
      /\w+@\w+\s+[$%>]\s*$/,               // user@host style (user@host $ )
      /^\s*\[.*?\]\s*[$%>]\s*$/,           // [user@host] $
      /\(.*?\)\s*[$%>]\s*$/,               // (venv) $
      /\[.*?\]\(.*?\)\s*[$%>]\s*$/,        // [branch](venv) $
      /❯\s*$/,                             // Starship prompt
      /➜\s+\w+\s+git:\(\w+\)\s*$/,         // Oh My Zsh git prompt
      /^\s*bash-[\d.]+[$%>]\s*$/,          // bash-5.1$
      /^\s*[a-zA-Z]:\\.*?>\s*$/,           // Windows: C:\>
      /^Press\s+.*?\s+to\s+edit\s+queued/i // Claude specific
    ]
  },

  // Category 2: Waiting for User Input (8 patterns) - HIGH PRIORITY (Bug #3 fix)
  WAITING_INPUT: {
    category: PatternCategory.WAITING_INPUT,
    targetState: "idle" as AgentActivity,
    confidence: 90,
    priority: 2,
    patterns: [
      /Claude is waiting for your input/i,
      /waiting for your input/i,
      /Waiting for you to respond/i,
      /Press\s+Cmd\+Shift\+M/i,
      /Type your message/i,
      /What would you like me to do\?/i,
      /How can I help\?/i,
      /\[Waiting for user\]/i
    ]
  },

  // Category 3: Thinking/Processing (6 patterns)
  THINKING: {
    category: PatternCategory.THINKING,
    targetState: "thinking" as AgentActivity,
    confidence: 85,
    priority: 5,
    patterns: [
      /Thinking/i,
      /⠋|⠙|⠹|⠸|⠼|⠴|⠦|⠧|⠇|⠏/,      // Spinner animation
      /Processing/i,
      /Analyzing/i,
      /Claude is thinking/i,
      /\[.*?loading.*?\]/i
    ]
  },

  // Category 4: Tool/Command Execution (7 patterns)
  TOOL_EXECUTION: {
    category: PatternCategory.TOOL_EXECUTION,
    targetState: "working" as AgentActivity,
    confidence: 85,
    priority: 6,
    patterns: [
      /^\$ \w+/,                              // Command with args (not just prompt)
      /^❯ \w+/,                               // Starship command with args
      /\[Tool: \w+\]/i,
      /Executing:/i,
      /Running command:/i,
      /^npm (install|run|test|build)/i,       // npm command at line start
      /^git (clone|pull|push|commit|rebase)/i // git command at line start
    ]
  },

  // Category 5: Interactive Prompts (10 patterns)
  INTERACTIVE: {
    category: PatternCategory.INTERACTIVE,
    targetState: "blocked" as AgentActivity,
    confidence: 90,
    priority: 4,
    patterns: [
      /\(y\/n\)\s*$/i,
      /\[Y\/n\]\s*$/i,
      /Press any key to continue/i,
      /Enter passphrase/i,
      /Password:/i,
      /Are you sure\?/i,
      /Continue\?/i,
      /Select an option:/i,
      /\d+\)\s+.*?\s+\d+\)\s+/,        // Numbered menu
      />\s+\[.*?\]\s+\[.*?\]/          // Arrow selection
    ]
  },

  // Category 6: Error States (12 patterns) - HIGHEST PRIORITY
  ERROR: {
    category: PatternCategory.ERROR,
    targetState: "error" as AgentActivity,
    confidence: 95,
    priority: 1,
    patterns: [
      /Error:/i,
      /ECONNREFUSED/i,
      /ENOENT/i,
      /EPERM/i,
      /command not found/i,
      /No such file or directory/i,
      /Permission denied/i,
      /fatal:/i,
      /Segmentation fault/i,
      /Killed/i,
      /SIGTERM/i,
      /Stack trace:/i
    ]
  },

  // Category 7: Long-Running Task Indicators (7 patterns)
  LONG_RUNNING: {
    category: PatternCategory.LONG_RUNNING,
    targetState: "long_running" as AgentActivity,
    confidence: 75,
    priority: 7,
    patterns: [
      /\d+\/\d+\s+test/i,                     // Test progress
      /\[\d+%\]/,                             // Percentage progress
      /Downloading/i,
      /Uploading/i,
      /Compiling/i,
      /Building/i,
      /\d+\s+passed,\s+\d+\s+failed/i         // Test results
    ]
  },

  // Category 8: Agent Spawn States (5 patterns) - Special handling (Bug #4 fix)
  SPAWN: {
    category: PatternCategory.SPAWN,
    targetState: "spawning" as AgentActivity,
    confidence: 90,
    priority: 3,
    patterns: [
      /^$/,                                   // Empty output (just spawned)
      /Initialized empty Git/i,
      /Welcome to/i,
      /^Loading\.\.\.$/im,                    // Loading on its own line (not progress)
      /Connecting to/i
    ]
  }
};

/**
 * Count total patterns across all categories
 */
export function getTotalPatternCount(): number {
  return Object.values(PATTERN_LIBRARY).reduce(
    (sum, config) => sum + config.patterns.length,
    0
  );
}

/**
 * Get pattern configs sorted by priority (highest first)
 */
export function getOrderedConfigs(): PatternDetectorConfig[] {
  return Object.values(PATTERN_LIBRARY).sort((a, b) => a.priority - b.priority);
}
