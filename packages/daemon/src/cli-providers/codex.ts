import type {
  CLIProvider,
  CLIProviderConfig,
  ModelOption,
  ParsedOutput,
} from "@kora/shared";
import { validateExtraArgs } from "./arg-validator.js";

export const codexProvider: CLIProvider = {
  id: "codex",
  displayName: "OpenAI Codex CLI",

  allowedExtraArgs: ["--full-auto", "--quiet"],

  supportsHotModelSwap: false,

  buildCommand(config: CLIProviderConfig): string[] {
    const cmd: string[] = ["codex"];
    if (config.model && config.model !== "default" && config.model !== "") {
      cmd.push("--model", config.model);
    }

    if (config.systemPromptFile) {
      cmd.push("--instructions-file", config.systemPromptFile);
    }

    if (config.extraArgs?.length) {
      const { valid, invalid } = validateExtraArgs(
        config.extraArgs,
        this.allowedExtraArgs,
      );
      if (!valid) {
        throw new Error(
          `Invalid extra args for codex: ${invalid.join(", ")}`,
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

    // Codex CLI shows "Tokens: 1,234 input / 567 output" or "Input tokens: X"
    const inputMatch = rawOutput.match(/[Ii]nput(?:\s+tokens)?:\s*([\d,\.]+)\s*k?/);
    const outputMatch = rawOutput.match(/[Oo]utput(?:\s+tokens)?:\s*([\d,\.]+)\s*k?/);
    // Also try "Tokens: X input / Y output" format
    const tokensLineMatch = rawOutput.match(/[Tt]okens:\s*([\d,\.]+)\s*k?\s*input\s*\/\s*([\d,\.]+)\s*k?\s*output/);

    if (tokensLineMatch) {
      result.tokenUsage = {
        input: parseCodexTokenCount(tokensLineMatch[1]),
        output: parseCodexTokenCount(tokensLineMatch[2]),
      };
    } else if (inputMatch || outputMatch) {
      result.tokenUsage = {
        input: parseCodexTokenCount(inputMatch?.[1] || "0"),
        output: parseCodexTokenCount(outputMatch?.[1] || "0"),
      };
    }

    // Cost — "$X.XX" pattern
    const costMatch = rawOutput.match(/\$(\d+\.?\d*)/);
    if (costMatch) {
      result.costUsd = parseFloat(costMatch[1]);
    }

    // Activity detection
    if (rawOutput.includes("Reading") || rawOutput.includes("Searching")) {
      result.currentActivity = "reading";
    } else if (rawOutput.includes("Writing") || rawOutput.includes("Editing")) {
      result.currentActivity = "writing";
    } else if (rawOutput.includes("Running")) {
      result.currentActivity = "running command";
    }

    return result;
  },

  getModels(): ModelOption[] {
    return [
      { id: "default", label: "Use CLI Default", tier: "balanced" },
      {
        id: "o4-mini",
        label: "o4-mini",
        tier: "fast",
        inputPricePerMToken: 1.1,
        outputPricePerMToken: 4.4,
      },
      {
        id: "o3",
        label: "o3",
        tier: "balanced",
        inputPricePerMToken: 2,
        outputPricePerMToken: 8,
      },
      {
        id: "gpt-4.1",
        label: "GPT-4.1",
        tier: "capable",
        inputPricePerMToken: 2,
        outputPricePerMToken: 8,
      },
    ];
  },
};

function parseCodexTokenCount(str: string): number {
  const cleaned = str.replace(/,/g, "");
  if (cleaned.endsWith("k") || cleaned.endsWith("K")) {
    return parseFloat(cleaned) * 1000;
  }
  return parseFloat(cleaned) || 0;
}
