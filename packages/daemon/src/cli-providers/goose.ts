import type {
  CLIProvider,
  CLIProviderConfig,
  ModelOption,
  ParsedOutput,
} from "@kora/shared";


export const gooseProvider: CLIProvider = {
  id: "goose",
  displayName: "Goose",

  allowedExtraArgs: ["--verbose", "--max-tokens", "--no-cache", "--profile"],

  supportsMcp: false,
  supportsHotModelSwap: false,

  buildCommand(config: CLIProviderConfig): string[] {
    const cmd: string[] = ["goose"];
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

    const inputMatch = rawOutput.match(/Input tokens:\s*([\d,]+)/i);
    const outputMatch = rawOutput.match(/Output tokens:\s*([\d,]+)/i);
    if (inputMatch || outputMatch) {
      result.tokenUsage = {
        input: inputMatch ? parseInt(inputMatch[1].replace(/,/g, ""), 10) : 0,
        output: outputMatch
          ? parseInt(outputMatch[1].replace(/,/g, ""), 10)
          : 0,
      };
    }

    const costMatch = rawOutput.match(/Cost:\s*\$?([\d.]+)/i);
    if (costMatch) {
      result.costUsd = parseFloat(costMatch[1]);
    }

    return result;
  },

  getModels(): ModelOption[] {
    return [
      { id: "default", label: "Use CLI Default", tier: "balanced" },
      {
        id: "goose-default",
        label: "Goose Default",
        tier: "balanced",
      },
    ];
  },
};
