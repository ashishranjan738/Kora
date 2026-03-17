import type {
  CLIProvider,
  CLIProviderConfig,
  ModelOption,
  ParsedOutput,
} from "@kora/shared";
import { validateExtraArgs } from "./arg-validator.js";

export const claudeCodeProvider: CLIProvider = {
  id: "claude-code",
  displayName: "Claude Code",

  allowedExtraArgs: [
    "--verbose",
    "--no-suggestions",
    "--allowedTools",
    "--max-tokens",
    "--dangerously-skip-permissions",
    "--permission-mode",
    "--output-format",
    "--continue",
    "--resume",
    "--no-cache",
  ],

  supportsMcp: true,
  supportsHotModelSwap: false,

  buildCommand(config: CLIProviderConfig): string[] {
    const cmd: string[] = ["claude"];
    // Only pass --model if explicitly set (empty/"default" = use CLI's configured default)
    if (config.model && config.model !== "default" && config.model !== "") {
      cmd.push("--model", config.model);
    }

    if (config.systemPromptFile) {
      cmd.push("--system-prompt-file", config.systemPromptFile);
    }

    if (config.extraArgs?.length) {
      const { valid, invalid } = validateExtraArgs(
        config.extraArgs,
        this.allowedExtraArgs,
        { skipValidation: config.skipArgValidation },
      );
      if (!valid) {
        throw new Error(
          `Invalid extra args for claude-code: ${invalid.join(", ")}`,
        );
      }
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

    // Look for token counts — Claude Code formats
    // Pattern: "nput tokens: X" or "nput: X" (handles "Input tokens: 12,345" and "input: 12.4k")
    const inputMatch = rawOutput.match(/[Ii]nput(?:\s+tokens)?:\s*([\d,\.]+)\s*k?/);
    const outputMatch = rawOutput.match(/[Oo]utput(?:\s+tokens)?:\s*([\d,\.]+)\s*k?/);

    if (inputMatch || outputMatch) {
      result.tokenUsage = {
        input: parseTokenCount(inputMatch?.[1] || "0"),
        output: parseTokenCount(outputMatch?.[1] || "0"),
      };
    }

    // Look for cost — "$X.XX" pattern (e.g. "Cost: $0.42" or "sonnet-4-6 · $0.42")
    const costMatch = rawOutput.match(/\$(\d+\.?\d*)/);
    if (costMatch) {
      result.costUsd = parseFloat(costMatch[1]);
    }

    // Detect activity
    if (rawOutput.includes("Reading") || rawOutput.includes("Searching")) {
      result.currentActivity = "reading";
    } else if (rawOutput.includes("Writing") || rawOutput.includes("Editing")) {
      result.currentActivity = "writing";
    } else if (rawOutput.includes("Running")) {
      result.currentActivity = "running command";
    }

    // Detect waiting for input
    if (rawOutput.includes("\u276F") || rawOutput.includes("> ")) {
      result.isWaitingForInput = true;
    }

    return result;
  },

  getModels(): ModelOption[] {
    return [
      {
        id: "default",
        label: "Use CLI Default",
        tier: "balanced",
      },
      {
        id: "claude-opus-4-6",
        label: "Claude Opus 4.6",
        tier: "capable",
        inputPricePerMToken: 15,
        outputPricePerMToken: 75,
      },
      {
        id: "claude-sonnet-4-6",
        label: "Claude Sonnet 4.6",
        tier: "balanced",
        inputPricePerMToken: 3,
        outputPricePerMToken: 15,
      },
      {
        id: "claude-haiku-4-5",
        label: "Claude Haiku 4.5",
        tier: "fast",
        inputPricePerMToken: 0.8,
        outputPricePerMToken: 4,
      },
    ];
  },
};

function parseTokenCount(str: string): number {
  // Handle "12,345" or "12.4k" or "12345"
  const cleaned = str.replace(/,/g, "");
  if (cleaned.endsWith("k") || cleaned.endsWith("K")) {
    return parseFloat(cleaned) * 1000;
  }
  return parseFloat(cleaned) || 0;
}
