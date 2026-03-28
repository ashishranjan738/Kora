/**
 * Cross-provider verification for system prompt flag handling.
 * Ensures PR #455 (--append-system-prompt-file for Claude Code)
 * did NOT affect other providers' flag behavior.
 */
import { describe, it, expect } from "vitest";
import { claudeCodeProvider } from "../claude-code.js";
import { aiderProvider } from "../aider.js";
import { gooseProvider } from "../goose.js";
import { codexProvider } from "../codex.js";

const BASE_CONFIG = {
  model: "default",
  workingDirectory: "/tmp",
  systemPromptFile: "/path/to/boot-prompt.md",
};

describe("Cross-provider system prompt flag isolation", () => {
  describe("Claude Code uses --append-system-prompt-file (PR #455)", () => {
    it("uses --append-system-prompt-file, NOT --system-prompt-file", () => {
      const cmd = claudeCodeProvider.buildCommand(BASE_CONFIG);
      expect(cmd).toContain("--append-system-prompt-file");
      expect(cmd).toContain("/path/to/boot-prompt.md");
      expect(cmd).not.toContain("--system-prompt-file");
    });

    it("pairs the flag correctly with the file path", () => {
      const cmd = claudeCodeProvider.buildCommand(BASE_CONFIG);
      const flagIdx = cmd.indexOf("--append-system-prompt-file");
      expect(flagIdx).toBeGreaterThan(-1);
      expect(cmd[flagIdx + 1]).toBe("/path/to/boot-prompt.md");
    });
  });

  describe("Aider still uses --system-prompt-file (NOT affected by PR #455)", () => {
    it("uses --system-prompt-file for aider", () => {
      const cmd = aiderProvider.buildCommand(BASE_CONFIG);
      expect(cmd).toContain("--system-prompt-file");
      expect(cmd).toContain("/path/to/boot-prompt.md");
      expect(cmd).not.toContain("--append-system-prompt-file");
    });

    it("pairs the flag correctly with the file path", () => {
      const cmd = aiderProvider.buildCommand(BASE_CONFIG);
      const flagIdx = cmd.indexOf("--system-prompt-file");
      expect(flagIdx).toBeGreaterThan(-1);
      expect(cmd[flagIdx + 1]).toBe("/path/to/boot-prompt.md");
    });

    it("omits flag when systemPromptFile is undefined", () => {
      const cmd = aiderProvider.buildCommand({ model: "default", workingDirectory: "/tmp" });
      expect(cmd).not.toContain("--system-prompt-file");
    });
  });

  describe("Goose still uses --system-prompt-file (NOT affected by PR #455)", () => {
    it("uses --system-prompt-file for goose", () => {
      const cmd = gooseProvider.buildCommand(BASE_CONFIG);
      expect(cmd).toContain("--system-prompt-file");
      expect(cmd).toContain("/path/to/boot-prompt.md");
      expect(cmd).not.toContain("--append-system-prompt-file");
    });

    it("pairs the flag correctly with the file path", () => {
      const cmd = gooseProvider.buildCommand(BASE_CONFIG);
      const flagIdx = cmd.indexOf("--system-prompt-file");
      expect(flagIdx).toBeGreaterThan(-1);
      expect(cmd[flagIdx + 1]).toBe("/path/to/boot-prompt.md");
    });

    it("omits flag when systemPromptFile is undefined", () => {
      const cmd = gooseProvider.buildCommand({ model: "default", workingDirectory: "/tmp" });
      expect(cmd).not.toContain("--system-prompt-file");
    });
  });

  describe("Codex uses --instructions-file (NOT affected by PR #455)", () => {
    it("uses --instructions-file for codex", () => {
      const cmd = codexProvider.buildCommand(BASE_CONFIG);
      expect(cmd).toContain("--instructions-file");
      expect(cmd).toContain("/path/to/boot-prompt.md");
      expect(cmd).not.toContain("--system-prompt-file");
      expect(cmd).not.toContain("--append-system-prompt-file");
    });

    it("pairs the flag correctly with the file path", () => {
      const cmd = codexProvider.buildCommand(BASE_CONFIG);
      const flagIdx = cmd.indexOf("--instructions-file");
      expect(flagIdx).toBeGreaterThan(-1);
      expect(cmd[flagIdx + 1]).toBe("/path/to/boot-prompt.md");
    });

    it("omits flag when systemPromptFile is undefined", () => {
      const cmd = codexProvider.buildCommand({ model: "default", workingDirectory: "/tmp" });
      expect(cmd).not.toContain("--instructions-file");
    });
  });

  describe("Flag uniqueness across providers", () => {
    it("each provider uses a distinct flag or no flag", () => {
      const claudeCmd = claudeCodeProvider.buildCommand(BASE_CONFIG);
      const aiderCmd = aiderProvider.buildCommand(BASE_CONFIG);
      const gooseCmd = gooseProvider.buildCommand(BASE_CONFIG);
      const codexCmd = codexProvider.buildCommand(BASE_CONFIG);

      // Claude Code is the ONLY one using --append-system-prompt-file
      expect(claudeCmd).toContain("--append-system-prompt-file");
      expect(aiderCmd).not.toContain("--append-system-prompt-file");
      expect(gooseCmd).not.toContain("--append-system-prompt-file");
      expect(codexCmd).not.toContain("--append-system-prompt-file");

      // Codex is the ONLY one using --instructions-file
      expect(codexCmd).toContain("--instructions-file");
      expect(claudeCmd).not.toContain("--instructions-file");
      expect(aiderCmd).not.toContain("--instructions-file");
      expect(gooseCmd).not.toContain("--instructions-file");
    });
  });
});
