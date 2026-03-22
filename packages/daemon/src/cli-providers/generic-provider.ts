/**
 * GenericCLIProvider — converts a JSON plugin config into a CLIProvider implementation.
 * Enables adding any CLI agent without code changes.
 */

import type { CLIProvider, CLIProviderConfig, ParsedOutput, ModelOption } from "@kora/shared";

export interface PluginConfig {
  id: string;
  displayName: string;
  command: string;
  modelFlag?: string;
  systemPromptFlag?: string;
  exitCommand?: string;
  sendInputPrefix?: string;
  supportsMcp?: boolean;
  supportsHotModelSwap?: boolean;
  allowedExtraArgs?: string[];
  models?: Array<{ id: string; label: string; tier?: string }>;
  outputParsing?: {
    tokenInput?: string;
    tokenOutput?: string;
    cost?: string;
    activity?: string;
  };
}

export class GenericCLIProvider implements CLIProvider {
  id: string;
  displayName: string;
  supportsMcp: boolean;
  supportsHotModelSwap: boolean;
  allowedExtraArgs: string[];

  private config: PluginConfig;
  private parsers: {
    tokenInput?: RegExp;
    tokenOutput?: RegExp;
    cost?: RegExp;
    activity?: RegExp;
  } = {};

  constructor(config: PluginConfig) {
    this.config = config;
    this.id = config.id;
    this.displayName = config.displayName;
    this.supportsMcp = config.supportsMcp ?? false;
    this.supportsHotModelSwap = config.supportsHotModelSwap ?? false;
    this.allowedExtraArgs = config.allowedExtraArgs ?? [];

    // Pre-compile regex patterns for output parsing
    if (config.outputParsing) {
      if (config.outputParsing.tokenInput) this.parsers.tokenInput = new RegExp(config.outputParsing.tokenInput);
      if (config.outputParsing.tokenOutput) this.parsers.tokenOutput = new RegExp(config.outputParsing.tokenOutput);
      if (config.outputParsing.cost) this.parsers.cost = new RegExp(config.outputParsing.cost);
      if (config.outputParsing.activity) this.parsers.activity = new RegExp(config.outputParsing.activity);
    }
  }

  buildCommand(c: CLIProviderConfig): string[] {
    const cmd = [this.config.command];
    if (c.model && c.model !== "default" && this.config.modelFlag) {
      cmd.push(this.config.modelFlag, c.model);
    }
    if (c.systemPromptFile && this.config.systemPromptFlag) {
      cmd.push(this.config.systemPromptFlag, c.systemPromptFile);
    }
    if (c.extraArgs?.length) cmd.push(...c.extraArgs);
    return cmd;
  }

  buildSendInput(message: string): string {
    return this.config.sendInputPrefix
      ? `${this.config.sendInputPrefix}${message}`
      : message;
  }

  buildExitCommand(): string {
    return this.config.exitCommand ?? "exit";
  }

  parseOutput(rawOutput: string): ParsedOutput {
    const result: ParsedOutput = {};

    if (this.parsers.tokenInput) {
      const m = rawOutput.match(this.parsers.tokenInput);
      if (m) {
        const input = parseInt(m[1].replace(/,/g, ""), 10);
        result.tokenUsage = { ...result.tokenUsage, input, output: result.tokenUsage?.output ?? 0 };
      }
    }

    if (this.parsers.tokenOutput) {
      const m = rawOutput.match(this.parsers.tokenOutput);
      if (m) {
        const output = parseInt(m[1].replace(/,/g, ""), 10);
        result.tokenUsage = { ...result.tokenUsage, input: result.tokenUsage?.input ?? 0, output };
      }
    }

    if (this.parsers.cost) {
      const m = rawOutput.match(this.parsers.cost);
      if (m) result.costUsd = parseFloat(m[1]);
    }

    if (this.parsers.activity) {
      const m = rawOutput.match(this.parsers.activity);
      if (m) result.currentActivity = m[1] || m[0];
    }

    return result;
  }

  getModels(): ModelOption[] {
    if (this.config.models?.length) {
      return this.config.models.map(m => ({
        id: m.id,
        label: m.label,
        tier: (m.tier as any) || "balanced",
      }));
    }
    return [{ id: "default", label: "Default", tier: "balanced" as any }];
  }
}

/** Validate a JSON plugin config has required fields */
export function validatePluginConfig(config: any): config is PluginConfig {
  if (!config || typeof config !== "object") throw new Error("Plugin config must be an object");
  if (!config.id || typeof config.id !== "string") throw new Error("Plugin must have a string 'id'");
  if (!config.displayName || typeof config.displayName !== "string") throw new Error("Plugin must have a string 'displayName'");
  if (!config.command || typeof config.command !== "string") throw new Error("Plugin must have a string 'command'");
  return true;
}
