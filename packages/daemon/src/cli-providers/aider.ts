import type {
  CLIProvider,
  CLIProviderConfig,
  ModelOption,
  ParsedOutput,
} from "@kora/shared";
import { validateExtraArgs } from "./arg-validator.js";

export const aiderProvider: CLIProvider = {
  id: "aider",
  displayName: "Aider",

  allowedExtraArgs: [
    "--no-auto-commits",
    "--yes",
    "--dark-mode",
    "--no-git",
    "--auto-test",
    "--test-cmd",
    "--lint-cmd",
  ],

  supportsMcp: false,
  supportsHotModelSwap: true,

  buildCommand(config: CLIProviderConfig): string[] {
    const cmd: string[] = ["aider", "--no-auto-commits"];
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
          `Invalid extra args for aider: ${invalid.join(", ")}`,
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

  buildModelSwapCommand(model: string): string {
    return `/model ${model}`;
  },

  parseOutput(rawOutput: string): ParsedOutput {
    const result: ParsedOutput = {};

    // Aider shows "Tokens: 12.3k sent, 4.5k received" or "Input tokens: X"
    const aiderTokenMatch = rawOutput.match(/[Tt]okens:\s*([\d,\.]+)\s*k?\s*sent,\s*([\d,\.]+)\s*k?\s*received/);
    const inputMatch = rawOutput.match(/[Ii]nput(?:\s+tokens)?:\s*([\d,\.]+)\s*k?/);
    const outputMatch = rawOutput.match(/[Oo]utput(?:\s+tokens)?:\s*([\d,\.]+)\s*k?/);

    if (aiderTokenMatch) {
      result.tokenUsage = {
        input: parseAiderTokenCount(aiderTokenMatch[1]),
        output: parseAiderTokenCount(aiderTokenMatch[2]),
      };
    } else if (inputMatch || outputMatch) {
      result.tokenUsage = {
        input: parseAiderTokenCount(inputMatch?.[1] || "0"),
        output: parseAiderTokenCount(outputMatch?.[1] || "0"),
      };
    }

    // Cost — Aider shows "Cost: $0.08 message, $0.42 session" or just "$X.XX"
    // Prefer session cost (cumulative) if available
    const sessionCostMatch = rawOutput.match(/\$([\d.]+)\s*session/);
    const costMatch = rawOutput.match(/\$(\d+\.?\d*)/);
    if (sessionCostMatch) {
      result.costUsd = parseFloat(sessionCostMatch[1]);
    } else if (costMatch) {
      result.costUsd = parseFloat(costMatch[1]);
    }

    // Activity detection
    if (rawOutput.includes("Editing") || rawOutput.includes("Applied edit")) {
      result.currentActivity = "writing";
    } else if (rawOutput.includes("Running")) {
      result.currentActivity = "running command";
    }

    // Detect waiting for input — aider uses "> " prompt
    if (rawOutput.includes("> ")) {
      result.isWaitingForInput = true;
    }

    return result;
  },

  getModels(): ModelOption[] {
    return [
      { id: "default", label: "Use CLI Default", tier: "balanced" },
      {
        id: "claude-sonnet-4-6",
        label: "Claude Sonnet 4.6",
        tier: "balanced",
      },
      {
        id: "gpt-4.1",
        label: "GPT-4.1",
        tier: "capable",
      },
      {
        id: "deepseek/deepseek-chat",
        label: "DeepSeek Chat",
        tier: "fast",
      },
    ];
  },
};

function parseAiderTokenCount(str: string): number {
  const cleaned = str.replace(/,/g, "");
  if (cleaned.endsWith("k") || cleaned.endsWith("K")) {
    return parseFloat(cleaned) * 1000;
  }
  return parseFloat(cleaned) || 0;
}
