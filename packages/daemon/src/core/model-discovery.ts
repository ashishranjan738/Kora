import { execFile as execFileCb } from "child_process";
import { promisify } from "util";

const execFile = promisify(execFileCb);

export interface DiscoveredModel {
  id: string;
  source: string; // "cli-probe" | "config-file" | "env-var"
}

/**
 * Attempt to discover available models for a CLI provider.
 * Different strategies per provider.
 */
export async function discoverModels(providerId: string): Promise<DiscoveredModel[]> {
  switch (providerId) {
    case "claude-code":
      return discoverClaudeModels();
    case "codex":
      return discoverCodexModels();
    case "aider":
      return discoverAiderModels();
    default:
      return [];
  }
}

async function discoverClaudeModels(): Promise<DiscoveredModel[]> {
  const models: DiscoveredModel[] = [];

  try {
    // Try running: claude --print --model X "exit" to probe if a model works
    // But that's expensive. Instead, check environment for Bedrock config

    // Check for ANTHROPIC_MODEL env var
    if (process.env.ANTHROPIC_MODEL) {
      models.push({ id: process.env.ANTHROPIC_MODEL, source: "env-var" });
    }

    // Check for Claude Code config file
    const os = await import("os");
    const fs = await import("fs/promises");
    const path = await import("path");

    // Claude Code stores config at ~/.config/claude/ or ~/.claude/
    const configPaths = [
      path.join(os.default.homedir(), ".config", "claude", "settings.json"),
      path.join(os.default.homedir(), ".claude", "settings.json"),
      path.join(os.default.homedir(), ".claude.json"),
    ];

    for (const configPath of configPaths) {
      try {
        const raw = await fs.readFile(configPath, "utf-8");
        const config = JSON.parse(raw);
        // Look for model configuration
        if (config.model) models.push({ id: config.model, source: "config-file" });
        if (config.defaultModel) models.push({ id: config.defaultModel, source: "config-file" });
        // Bedrock-specific: look for model mappings
        if (config.modelOverrides) {
          for (const [, modelId] of Object.entries(config.modelOverrides)) {
            if (typeof modelId === "string") models.push({ id: modelId, source: "config-file" });
          }
        }
        // Check for available models list
        if (Array.isArray(config.availableModels)) {
          for (const m of config.availableModels) {
            const id = typeof m === "string" ? m : m.id || m.model;
            if (id) models.push({ id, source: "config-file" });
          }
        }
      } catch {
        // Config file doesn't exist or isn't parseable
      }
    }

    // Check for AWS Bedrock model patterns in env
    if (process.env.CLAUDE_CODE_USE_BEDROCK === "1" || process.env.ANTHROPIC_BEDROCK_BASE_URL) {
      // Add common Bedrock model IDs
      models.push({ id: "us.anthropic.claude-sonnet-4-6-v1", source: "env-var" });
      models.push({ id: "us.anthropic.claude-haiku-4-5-v1", source: "env-var" });
      models.push({ id: "anthropic.claude-sonnet-4-6-v1", source: "env-var" });
      models.push({ id: "anthropic.claude-haiku-4-5-v1", source: "env-var" });
    }

    // Check for Google Vertex patterns
    if (process.env.CLAUDE_CODE_USE_VERTEX === "1" || process.env.ANTHROPIC_VERTEX_PROJECT_ID) {
      models.push({ id: "claude-sonnet-4-6@latest", source: "env-var" });
      models.push({ id: "claude-haiku-4-5@latest", source: "env-var" });
    }

  } catch {
    // Discovery failed, return empty
  }

  // Deduplicate
  const seen = new Set<string>();
  return models.filter(m => {
    if (seen.has(m.id)) return false;
    seen.add(m.id);
    return true;
  });
}

async function discoverCodexModels(): Promise<DiscoveredModel[]> {
  const models: DiscoveredModel[] = [];
  if (process.env.OPENAI_MODEL) {
    models.push({ id: process.env.OPENAI_MODEL, source: "env-var" });
  }
  return models;
}

async function discoverAiderModels(): Promise<DiscoveredModel[]> {
  const models: DiscoveredModel[] = [];
  // Aider stores config at ~/.aider.conf.yml
  try {
    const os = await import("os");
    const fs = await import("fs/promises");
    const path = await import("path");
    const configPath = path.join(os.default.homedir(), ".aider.conf.yml");
    const raw = await fs.readFile(configPath, "utf-8");
    const modelMatch = raw.match(/model:\s*(.+)/);
    if (modelMatch) models.push({ id: modelMatch[1].trim(), source: "config-file" });
  } catch {}
  return models;
}
