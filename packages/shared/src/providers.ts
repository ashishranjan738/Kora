// ============================================================
// CLI Provider interface — the pluggable backend abstraction
// ============================================================

export interface CLIProvider {
  id: string;
  displayName: string;

  /** Build command as argument array (never a shell string) to prevent injection */
  buildCommand(config: CLIProviderConfig): string[];

  /** Format a message/prompt to send to a running CLI instance */
  buildSendInput(message: string): string;

  /** The command to gracefully exit the CLI */
  buildExitCommand(): string;

  /** Parse raw terminal output into structured progress */
  parseOutput(rawOutput: string): ParsedOutput;

  /** Available models for this provider */
  getModels(): ModelOption[];

  /** Whether the CLI supports changing models without restart */
  supportsHotModelSwap: boolean;

  /** Command to switch models at runtime (if supported) */
  buildModelSwapCommand?(model: string): string;

  /** Whether this CLI supports MCP (--mcp-config). Drives MCP message delivery. */
  supportsMcp: boolean;

  /** Allowlist of valid extra CLI flags for this provider */
  allowedExtraArgs: string[];
}

export interface CLIProviderConfig {
  model: string;
  systemPrompt?: string;
  /** Path to temp file containing the system prompt (safe from shell injection) */
  systemPromptFile?: string;
  workingDirectory: string;
  extraArgs?: string[];
  envVars?: Record<string, string>;
}

export interface ParsedOutput {
  currentActivity?: string;
  filesModified?: string[];
  toolCalls?: string[];
  tokenUsage?: { input: number; output: number };
  costUsd?: number;
  isWaitingForInput?: boolean;
  isComplete?: boolean;
}

export interface ModelOption {
  id: string;
  label: string;
  tier: "fast" | "balanced" | "capable";
  inputPricePerMToken?: number;   // $ per million input tokens
  outputPricePerMToken?: number;  // $ per million output tokens
}
