import type {
  CLIProvider,
  CLIProviderConfig,
  ModelOption,
  ParsedOutput,
} from "@kora/shared";


export const kiroProvider: CLIProvider = {
  id: "kiro",
  displayName: "Kiro (Amazon)",

  allowedExtraArgs: ["--verbose", "--profile", "--region"],

  supportsMcp: true,
  supportsHotModelSwap: false,

  buildCommand(config: CLIProviderConfig): string[] {
    const cmd: string[] = ["kiro-cli", "chat"];

    // Model selection
    if (config.model && config.model !== "default") {
      cmd.push("--model", config.model);
    }

    // Agent selection: if user specified a Kiro agent via extraArgs (--agent X),
    // use that. Otherwise don't pass --agent so Kiro uses its default.
    // The MCP server is injected via workspace .kiro/settings/mcp.json,
    // which all agents load automatically via includeMcpJson: true.

    if (config.extraArgs?.length) {
      cmd.push(...config.extraArgs);
    }

    return cmd;
  },

  buildSendInput(message: string): string {
    return message;
  },

  buildExitCommand(): string {
    return "/exit";
  },

  parseOutput(rawOutput: string): ParsedOutput {
    const result: ParsedOutput = {};

    // Kiro shows: "▸ Credits: 0.07 • Time: 2s" after each response
    // Credits are cumulative per-turn cost in Kiro's credit system
    const creditsMatch = rawOutput.match(/Credits:\s*([\d.]+)/);
    if (creditsMatch) {
      // Kiro credits ≈ USD (roughly 1:1 for the free tier)
      result.costUsd = parseFloat(creditsMatch[1]);
    }

    // Kiro shows context usage as "N% !>" or "[plan] N% !>" in the prompt
    // We can estimate tokens from the context percentage
    // Kiro's context window is ~128k tokens
    const contextPctMatch = rawOutput.match(/(\d+)%\s*!?>/);
    if (contextPctMatch) {
      const pct = parseInt(contextPctMatch[1], 10);
      result.contextWindowPercent = pct;
      const estimatedTotalTokens = Math.round((pct / 100) * 128_000);
      // TODO: replace with actual token counts when Kiro exposes them
      // Split estimated tokens: ~60% input, ~40% output (rough heuristic)
      result.tokenUsage = {
        input: Math.round(estimatedTotalTokens * 0.6),
        output: Math.round(estimatedTotalTokens * 0.4),
      };
    }

    // Fallback: if Kiro ever shows explicit token counts
    const inputMatch = rawOutput.match(/[Ii]nput(?:\s+tokens)?:\s*([\d,\.]+)\s*k?/);
    const outputMatch = rawOutput.match(/[Oo]utput(?:\s+tokens)?:\s*([\d,\.]+)\s*k?/);
    if (inputMatch || outputMatch) {
      result.tokenUsage = {
        input: parseTokenCount(inputMatch?.[1] || "0"),
        output: parseTokenCount(outputMatch?.[1] || "0"),
      };
    }

    // Detect activity
    if (rawOutput.includes("Reading") || rawOutput.includes("Searching")) {
      result.currentActivity = "reading";
    } else if (rawOutput.includes("Writing") || rawOutput.includes("Editing")) {
      result.currentActivity = "writing";
    } else if (rawOutput.includes("Running")) {
      result.currentActivity = "running command";
    }

    if (rawOutput.includes("❯") || rawOutput.includes("> ")) {
      result.isWaitingForInput = true;
    }

    return result;
  },

  getModels(): ModelOption[] {
    // Kiro uses Amazon Bedrock models internally.
    // Users can't directly select models via CLI flags,
    // but we list common Bedrock models for the UI.
    return [
      { id: "default", label: "Use CLI Default", tier: "balanced" },
      { id: "claude-sonnet-4-6", label: "Claude Sonnet 4.6 (via Bedrock)", tier: "balanced" },
      { id: "claude-haiku-4-5", label: "Claude Haiku 4.5 (via Bedrock)", tier: "fast" },
      { id: "amazon-nova-pro", label: "Amazon Nova Pro", tier: "balanced" },
      { id: "amazon-nova-lite", label: "Amazon Nova Lite", tier: "fast" },
    ];
  },
};

function parseTokenCount(str: string): number {
  const cleaned = str.replace(/,/g, "");
  if (cleaned.toLowerCase().endsWith("k")) return parseFloat(cleaned) * 1000;
  return parseFloat(cleaned) || 0;
}
