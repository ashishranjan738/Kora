/**
 * Single source of truth for CLI provider definitions.
 * Import this everywhere instead of maintaining duplicate lists.
 */

export const PROVIDERS = [
  { label: "Claude Code", value: "claude-code" },
  { label: "Codex", value: "codex" },
  { label: "Gemini CLI", value: "gemini-cli" },
  { label: "Aider", value: "aider" },
  { label: "Kiro", value: "kiro" },
  { label: "Goose", value: "goose" },
  { label: "Custom", value: "custom" },
] as const;

export const PROVIDER_IDS = PROVIDERS.map(p => p.value);

/** Model hints for each provider (used in playbook launch) */
export const PROVIDER_MODEL_HINTS: Record<string, string[]> = {
  "claude-code": ["claude-opus-4-6", "claude-sonnet-4-6", "claude-sonnet-4-5-20250514", "claude-haiku-3-5"],
  codex: ["o4-mini", "o3", "gpt-4.1"],
  "gemini-cli": ["gemini-2.5-pro", "gemini-2.5-flash"],
  aider: ["claude-sonnet-4-6", "gpt-4.1", "deepseek-chat"],
  kiro: ["claude-sonnet-4-6", "claude-opus-4-6"],
  goose: ["claude-sonnet-4-6", "gpt-4.1"],
  custom: [],
};
