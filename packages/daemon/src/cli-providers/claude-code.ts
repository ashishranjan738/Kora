import type {
  CLIProvider,
  CLIProviderConfig,
  ModelOption,
  ParsedOutput,
} from "@kora/shared";


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

    // Strip ANSI escape codes for reliable parsing
    const cleanOutput = rawOutput.replace(/\x1b\[[0-9;]*[a-zA-Z]/g, '');

    // Look for token counts — Claude Code formats
    // Pattern: "nput tokens: X" or "nput: X" (handles "Input tokens: 12,345" and "input: 12.4k")
    // Capture the full value including optional "k" suffix
    const inputMatch = cleanOutput.match(/[Ii]nput(?:\s+tokens)?:\s*([\d,\.]+\s*k?)/i);
    const outputMatch = cleanOutput.match(/[Oo]utput(?:\s+tokens)?:\s*([\d,\.]+\s*k?)/i);

    if (inputMatch || outputMatch) {
      result.tokenUsage = {
        input: parseTokenCount(inputMatch?.[1] || "0"),
        output: parseTokenCount(outputMatch?.[1] || "0"),
      };
    }

    // Parse spinner token counts: "✶Moonwalking… (6m11s·↓4.7k tokens)"
    if (!result.tokenUsage) {
      const spinnerTokenMatch = cleanOutput.match(/[↓↑⬇⬆]([\d,.]+)\s*k?\s*tokens?\)/i);
      if (spinnerTokenMatch) {
        const raw = spinnerTokenMatch[1] + (spinnerTokenMatch[0].includes('k') ? 'k' : '');
        const tokenCount = parseTokenCount(raw);
        result.tokenUsage = { input: tokenCount, output: Math.round(tokenCount * 0.3) };
      }
    }

    // Look for cost — "$X.XX" pattern (e.g. "Cost: $0.42" or "sonnet-4-6 · $0.42")
    const costMatch = cleanOutput.match(/\$(\d+\.?\d*)/);
    if (costMatch) {
      result.costUsd = parseFloat(costMatch[1]);
    }

    // Detect activity
    if (cleanOutput.includes("Reading") || cleanOutput.includes("Searching")) {
      result.currentActivity = "reading";
    } else if (cleanOutput.includes("Writing") || cleanOutput.includes("Editing")) {
      result.currentActivity = "writing";
    } else if (cleanOutput.includes("Running")) {
      result.currentActivity = "running command";
    }

    // Detect waiting for input
    if (cleanOutput.includes("\u276F") || cleanOutput.includes("> ")) {
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
  const cleaned = str.trim().replace(/,/g, "");
  const num = parseFloat(cleaned);

  if (isNaN(num)) {
    return 0;
  }

  // Check if the cleaned string has a "k" suffix (case-insensitive)
  if (/k$/i.test(cleaned)) {
    return num * 1000;
  }

  return num;
}
