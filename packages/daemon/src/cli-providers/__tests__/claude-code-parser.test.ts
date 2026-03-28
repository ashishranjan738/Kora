import { describe, it, expect } from "vitest";
import { claudeCodeProvider } from "../claude-code.js";

/* ================================================================== */
/*  Claude Code Provider: buildCommand                                 */
/* ================================================================== */

describe("Claude Code Provider — buildCommand", () => {
  it("builds basic command: claude", () => {
    const cmd = claudeCodeProvider.buildCommand({
      model: "default",
      workingDirectory: "/tmp",
    });
    expect(cmd).toEqual(["claude"]);
  });

  it("adds --model when non-default", () => {
    const cmd = claudeCodeProvider.buildCommand({
      model: "claude-sonnet-4-6",
      workingDirectory: "/tmp",
    });
    expect(cmd).toContain("--model");
    expect(cmd).toContain("claude-sonnet-4-6");
  });

  it("does NOT add --model for 'default'", () => {
    const cmd = claudeCodeProvider.buildCommand({
      model: "default",
      workingDirectory: "/tmp",
    });
    expect(cmd).not.toContain("--model");
  });

  it("does NOT add --model for empty string", () => {
    const cmd = claudeCodeProvider.buildCommand({
      model: "",
      workingDirectory: "/tmp",
    });
    expect(cmd).not.toContain("--model");
  });

  it("uses --append-system-prompt-file (NOT --system-prompt-file) to preserve built-in prompt", () => {
    const cmd = claudeCodeProvider.buildCommand({
      model: "default",
      workingDirectory: "/tmp",
      systemPromptFile: "/path/to/boot-prompt.md",
    });
    expect(cmd).toContain("--append-system-prompt-file");
    expect(cmd).toContain("/path/to/boot-prompt.md");
    // Must NOT use --system-prompt-file which replaces the built-in prompt
    expect(cmd).not.toContain("--system-prompt-file");
  });

  it("does NOT add system prompt flag when systemPromptFile is undefined", () => {
    const cmd = claudeCodeProvider.buildCommand({
      model: "default",
      workingDirectory: "/tmp",
    });
    expect(cmd).not.toContain("--append-system-prompt-file");
    expect(cmd).not.toContain("--system-prompt-file");
  });

  it("passes through extraArgs", () => {
    const cmd = claudeCodeProvider.buildCommand({
      model: "default",
      workingDirectory: "/tmp",
      extraArgs: ["--dangerously-skip-permissions", "--verbose"],
    });
    expect(cmd).toContain("--dangerously-skip-permissions");
    expect(cmd).toContain("--verbose");
  });

  it("orders flags: claude, model, system-prompt, extraArgs", () => {
    const cmd = claudeCodeProvider.buildCommand({
      model: "claude-sonnet-4-6",
      workingDirectory: "/tmp",
      systemPromptFile: "/path/to/prompt.md",
      extraArgs: ["--verbose"],
    });
    expect(cmd[0]).toBe("claude");
    const modelIdx = cmd.indexOf("--model");
    const appendIdx = cmd.indexOf("--append-system-prompt-file");
    const verboseIdx = cmd.indexOf("--verbose");
    expect(modelIdx).toBeLessThan(appendIdx);
    expect(appendIdx).toBeLessThan(verboseIdx);
  });
});

describe("Claude Code parseOutput", () => {
  describe("Token usage parsing", () => {
    it("parses standard token format with commas", () => {
      const output = "Input tokens: 1,234 · Output tokens: 567 · sonnet-4-6 · $0.42";
      const result = claudeCodeProvider.parseOutput(output);

      expect(result.tokenUsage).toBeDefined();
      expect(result.tokenUsage?.input).toBe(1234);
      expect(result.tokenUsage?.output).toBe(567);
    });

    it("parses token format with k suffix", () => {
      const output = "Input tokens: 12.5k · Output tokens: 3.2k · $1.85";
      const result = claudeCodeProvider.parseOutput(output);

      expect(result.tokenUsage).toBeDefined();
      expect(result.tokenUsage?.input).toBe(12500);
      expect(result.tokenUsage?.output).toBe(3200);
    });

    it("parses abbreviated format (input/output without 'tokens')", () => {
      const output = "Input: 5,678 · Output: 890 · $0.23";
      const result = claudeCodeProvider.parseOutput(output);

      expect(result.tokenUsage).toBeDefined();
      expect(result.tokenUsage?.input).toBe(5678);
      expect(result.tokenUsage?.output).toBe(890);
    });

    it("parses tokens without commas", () => {
      const output = "Input tokens: 1234 · Output tokens: 567 · $0.42";
      const result = claudeCodeProvider.parseOutput(output);

      expect(result.tokenUsage).toBeDefined();
      expect(result.tokenUsage?.input).toBe(1234);
      expect(result.tokenUsage?.output).toBe(567);
    });

    it("handles case-insensitive token labels", () => {
      const output = "input tokens: 1,234 · output tokens: 567 · $0.42";
      const result = claudeCodeProvider.parseOutput(output);

      expect(result.tokenUsage).toBeDefined();
      expect(result.tokenUsage?.input).toBe(1234);
      expect(result.tokenUsage?.output).toBe(567);
    });

    it("handles multiline output with tokens on separate lines", () => {
      const output = "Some output here\nInput tokens: 2,345\nOutput tokens: 678\nCost: $0.56";
      const result = claudeCodeProvider.parseOutput(output);

      expect(result.tokenUsage).toBeDefined();
      expect(result.tokenUsage?.input).toBe(2345);
      expect(result.tokenUsage?.output).toBe(678);
    });

    it("returns undefined tokenUsage when no tokens found", () => {
      const output = "Some random output without token info";
      const result = claudeCodeProvider.parseOutput(output);

      expect(result.tokenUsage).toBeUndefined();
    });
  });

  describe("Cost parsing", () => {
    it("parses cost with cents", () => {
      const output = "Input tokens: 1,234 · Output tokens: 567 · $0.42";
      const result = claudeCodeProvider.parseOutput(output);

      expect(result.costUsd).toBe(0.42);
    });

    it("parses cost with dollars and cents", () => {
      const output = "Total cost: $12.34";
      const result = claudeCodeProvider.parseOutput(output);

      expect(result.costUsd).toBe(12.34);
    });

    it("parses cost without cents", () => {
      const output = "Cost: $5";
      const result = claudeCodeProvider.parseOutput(output);

      expect(result.costUsd).toBe(5);
    });

    it("parses cost with three decimal places", () => {
      const output = "Cost: $0.123";
      const result = claudeCodeProvider.parseOutput(output);

      expect(result.costUsd).toBe(0.123);
    });

    it("finds first cost occurrence when multiple dollar signs present", () => {
      const output = "Budget: $100.00 · Spent: $0.42 · Remaining: $99.58";
      const result = claudeCodeProvider.parseOutput(output);

      expect(result.costUsd).toBe(100.0);
    });

    it("returns undefined costUsd when no cost found", () => {
      const output = "Some output without cost information";
      const result = claudeCodeProvider.parseOutput(output);

      expect(result.costUsd).toBeUndefined();
    });
  });

  describe("Activity detection", () => {
    it("detects reading activity", () => {
      const output = "Reading file.ts...";
      const result = claudeCodeProvider.parseOutput(output);

      expect(result.currentActivity).toBe("reading");
    });

    it("detects searching activity", () => {
      const output = "Searching for pattern...";
      const result = claudeCodeProvider.parseOutput(output);

      expect(result.currentActivity).toBe("reading");
    });

    it("detects writing activity", () => {
      const output = "Writing changes to file.ts...";
      const result = claudeCodeProvider.parseOutput(output);

      expect(result.currentActivity).toBe("writing");
    });

    it("detects editing activity", () => {
      const output = "Editing file.ts...";
      const result = claudeCodeProvider.parseOutput(output);

      expect(result.currentActivity).toBe("writing");
    });

    it("detects running command activity", () => {
      const output = "Running npm install...";
      const result = claudeCodeProvider.parseOutput(output);

      expect(result.currentActivity).toBe("running command");
    });

    it("returns undefined activity when no keywords found", () => {
      const output = "Some random output";
      const result = claudeCodeProvider.parseOutput(output);

      expect(result.currentActivity).toBeUndefined();
    });
  });

  describe("Input waiting detection", () => {
    it("detects prompt character", () => {
      const output = "\u276F ";
      const result = claudeCodeProvider.parseOutput(output);

      expect(result.isWaitingForInput).toBe(true);
    });

    it("detects standard prompt", () => {
      const output = "> ";
      const result = claudeCodeProvider.parseOutput(output);

      expect(result.isWaitingForInput).toBe(true);
    });

    it("returns undefined when no prompt found", () => {
      const output = "Processing...";
      const result = claudeCodeProvider.parseOutput(output);

      expect(result.isWaitingForInput).toBeUndefined();
    });
  });

  describe("Real-world output samples", () => {
    it("parses typical Claude Code status line", () => {
      const output = "Input tokens: 15,234 · Output tokens: 4,567 · sonnet-4-6 · $0.89";
      const result = claudeCodeProvider.parseOutput(output);

      expect(result.tokenUsage).toBeDefined();
      expect(result.tokenUsage?.input).toBe(15234);
      expect(result.tokenUsage?.output).toBe(4567);
      expect(result.costUsd).toBe(0.89);
    });

    it("parses output with large token counts in k format", () => {
      const output = "Input tokens: 125.3k · Output tokens: 45.7k · opus-4-6 · $3.45";
      const result = claudeCodeProvider.parseOutput(output);

      expect(result.tokenUsage).toBeDefined();
      expect(result.tokenUsage?.input).toBe(125300);
      expect(result.tokenUsage?.output).toBe(45700);
      expect(result.costUsd).toBe(3.45);
    });

    it("handles terminal output with ANSI escape codes", () => {
      const output = "\x1b[90mInput tokens:\x1b[0m 1,234 · \x1b[90mOutput tokens:\x1b[0m 567 · $0.42";
      const result = claudeCodeProvider.parseOutput(output);

      expect(result.tokenUsage).toBeDefined();
      expect(result.tokenUsage?.input).toBe(1234);
      expect(result.tokenUsage?.output).toBe(567);
      expect(result.costUsd).toBe(0.42);
    });

    it("parses cumulative cost updates", () => {
      const output = "Session total: Input: 50,000 · Output: 12,000 · Cost: $1.23";
      const result = claudeCodeProvider.parseOutput(output);

      expect(result.tokenUsage?.input).toBe(50000);
      expect(result.tokenUsage?.output).toBe(12000);
      expect(result.costUsd).toBe(1.23);
    });
  });

  describe("Edge cases", () => {
    it("handles empty output", () => {
      const output = "";
      const result = claudeCodeProvider.parseOutput(output);

      expect(result.tokenUsage).toBeUndefined();
      expect(result.costUsd).toBeUndefined();
      expect(result.currentActivity).toBeUndefined();
    });

    it("handles malformed token format", () => {
      const output = "Input tokens: abc · Output tokens: xyz";
      const result = claudeCodeProvider.parseOutput(output);

      // Malformed tokens (non-numeric) won't match the regex, so tokenUsage is undefined
      expect(result.tokenUsage).toBeUndefined();
    });

    it("handles partial token information", () => {
      const output = "Input tokens: 1,234";
      const result = claudeCodeProvider.parseOutput(output);

      expect(result.tokenUsage).toBeDefined();
      expect(result.tokenUsage?.input).toBe(1234);
      expect(result.tokenUsage?.output).toBe(0);
    });

    it("handles decimal token counts correctly", () => {
      const output = "Input: 1.5k · Output: 0.8k · $0.15";
      const result = claudeCodeProvider.parseOutput(output);

      expect(result.tokenUsage?.input).toBe(1500);
      expect(result.tokenUsage?.output).toBe(800);
    });
  });
});
