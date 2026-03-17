import type {
  CLIProvider,
  CLIProviderConfig,
  ModelOption,
  ParsedOutput,
} from "@kora/shared";
import { validateExtraArgs } from "./arg-validator.js";

export const kiroProvider: CLIProvider = {
  id: "kiro",
  displayName: "Kiro (Amazon)",

  allowedExtraArgs: ["--verbose", "--profile", "--region"],

  supportsMcp: true,
  supportsHotModelSwap: false,

  buildCommand(config: CLIProviderConfig): string[] {
    const cmd: string[] = ["kiro-cli"];

    // Kiro doesn't have --model or --system-prompt flags.
    // Model selection is handled internally via Amazon Bedrock.
    // Persona is injected via steering files (.kiro/steering/*.md),
    // which is handled by agent-manager before spawning.

    if (config.extraArgs?.length) {
      const { valid, invalid } = validateExtraArgs(
        config.extraArgs,
        this.allowedExtraArgs,
        { skipValidation: config.skipArgValidation },
      );
      if (!valid) {
        throw new Error(
          `Invalid extra args for kiro: ${invalid.join(", ")}`,
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

    // Kiro may show token usage similar to other coding CLIs
    const inputMatch = rawOutput.match(/[Ii]nput(?:\s+tokens)?:\s*([\d,\.]+)\s*k?/);
    const outputMatch = rawOutput.match(/[Oo]utput(?:\s+tokens)?:\s*([\d,\.]+)\s*k?/);

    if (inputMatch || outputMatch) {
      result.tokenUsage = {
        input: parseTokenCount(inputMatch?.[1] || "0"),
        output: parseTokenCount(outputMatch?.[1] || "0"),
      };
    }

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
