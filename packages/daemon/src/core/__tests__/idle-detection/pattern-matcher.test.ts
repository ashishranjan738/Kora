import { describe, it, expect, beforeEach } from "vitest";
import { PatternMatcher } from "../../idle-detection/patterns/pattern-matcher.js";
import { PatternCategory } from "../../idle-detection/patterns/pattern-library.js";

describe("PatternMatcher", () => {
  let matcher: PatternMatcher;

  beforeEach(() => {
    matcher = new PatternMatcher();
  });

  describe("Shell Prompt Detection", () => {
    it("should detect basic $ prompt", () => {
      const result = matcher.analyze("$ ");
      expect(result.matched).toBe(true);
      expect(result.category).toBe(PatternCategory.SHELL_PROMPT);
      expect(result.targetState).toBe("idle");
    });

    it("should detect user@host prompt", () => {
      const result = matcher.analyze("user@localhost $ ");
      expect(result.matched).toBe(true);
      expect(result.category).toBe(PatternCategory.SHELL_PROMPT);
    });

    it("should detect Oh My Zsh git prompt", () => {
      const result = matcher.analyze("➜  main git:(master) ");
      expect(result.matched).toBe(true);
      expect(result.category).toBe(PatternCategory.SHELL_PROMPT);
    });

    it("should not detect command output as prompt", () => {
      const result = matcher.analyze("Command completed successfully");
      expect(result.matched).toBe(false);
    });
  });

  describe("Waiting Input Detection (Bug #3 fix)", () => {
    it("should detect 'Claude is waiting for your input'", () => {
      const result = matcher.analyze("Claude is waiting for your input");
      expect(result.matched).toBe(true);
      expect(result.category).toBe(PatternCategory.WAITING_INPUT);
      expect(result.targetState).toBe("idle");
      expect(result.confidence).toBe(90);
    });

    it("should detect 'waiting for your input' case-insensitive", () => {
      const result = matcher.analyze("WAITING FOR YOUR INPUT");
      expect(result.matched).toBe(true);
      expect(result.category).toBe(PatternCategory.WAITING_INPUT);
    });

    it("should prioritize WAITING_INPUT over SHELL_PROMPT", () => {
      // Multi-line output with both patterns
      const output = "$ npm run build\nwaiting for your input\n$ ";
      const result = matcher.analyze(output);

      // WAITING_INPUT has priority 2, SHELL_PROMPT has priority 8
      // Lower number = higher precedence
      expect(result.matched).toBe(true);
      expect(result.category).toBe(PatternCategory.WAITING_INPUT);
    });
  });

  describe("Error Detection (Priority 1)", () => {
    it("should detect 'Error:' messages", () => {
      const result = matcher.analyze("Error: Module not found");
      expect(result.matched).toBe(true);
      expect(result.category).toBe(PatternCategory.ERROR);
      expect(result.targetState).toBe("error");
      expect(result.confidence).toBe(95);
    });

    it("should detect ENOENT errors", () => {
      const result = matcher.analyze("ENOENT: no such file or directory");
      expect(result.matched).toBe(true);
      expect(result.category).toBe(PatternCategory.ERROR);
    });

    it("should detect fatal git errors", () => {
      const result = matcher.analyze("fatal: not a git repository");
      expect(result.matched).toBe(true);
      expect(result.category).toBe(PatternCategory.ERROR);
    });

    it("should prioritize ERROR over all other patterns", () => {
      // Output with error and shell prompt
      const output = "npm run build\nError: Build failed\n$ ";
      const result = matcher.analyze(output);

      // ERROR has priority 1 (highest)
      expect(result.matched).toBe(true);
      expect(result.category).toBe(PatternCategory.ERROR);
    });
  });

  describe("Interactive Detection", () => {
    it("should detect (y/n) prompts", () => {
      const result = matcher.analyze("Continue? (y/n) ");
      expect(result.matched).toBe(true);
      expect(result.category).toBe(PatternCategory.INTERACTIVE);
      expect(result.targetState).toBe("blocked");
    });

    it("should detect [Y/n] prompts", () => {
      const result = matcher.analyze("Proceed with installation? [Y/n] ");
      expect(result.matched).toBe(true);
      expect(result.category).toBe(PatternCategory.INTERACTIVE);
    });

    it("should detect password prompts", () => {
      const result = matcher.analyze("Password: ");
      expect(result.matched).toBe(true);
      expect(result.category).toBe(PatternCategory.INTERACTIVE);
    });
  });

  describe("Thinking Detection", () => {
    it("should detect 'Thinking...'", () => {
      const result = matcher.analyze("Thinking...");
      expect(result.matched).toBe(true);
      expect(result.category).toBe(PatternCategory.THINKING);
      expect(result.targetState).toBe("thinking");
    });

    it("should detect spinner animations", () => {
      const result = matcher.analyze("⠋ Loading");
      expect(result.matched).toBe(true);
      expect(result.category).toBe(PatternCategory.THINKING);
    });

    it("should detect 'Processing...'", () => {
      const result = matcher.analyze("Processing your request...");
      expect(result.matched).toBe(true);
      expect(result.category).toBe(PatternCategory.THINKING);
    });
  });

  describe("Tool Execution Detection", () => {
    it("should detect npm commands", () => {
      const result = matcher.analyze("npm install express");
      expect(result.matched).toBe(true);
      expect(result.category).toBe(PatternCategory.TOOL_EXECUTION);
      expect(result.targetState).toBe("working");
    });

    it("should detect git commands", () => {
      const result = matcher.analyze("git push origin main");
      expect(result.matched).toBe(true);
      expect(result.category).toBe(PatternCategory.TOOL_EXECUTION);
    });

    it("should detect 'Running command:' prefix", () => {
      const result = matcher.analyze("Running command: ls -la");
      expect(result.matched).toBe(true);
      expect(result.category).toBe(PatternCategory.TOOL_EXECUTION);
    });
  });

  describe("Long Running Detection", () => {
    it("should detect test progress", () => {
      const result = matcher.analyze("Running tests... 50/100 tests completed");
      expect(result.matched).toBe(true);
      expect(result.category).toBe(PatternCategory.LONG_RUNNING);
      expect(result.targetState).toBe("long_running");
    });

    it("should detect percentage progress", () => {
      const result = matcher.analyze("Downloading... [45%]");
      expect(result.matched).toBe(true);
      expect(result.category).toBe(PatternCategory.LONG_RUNNING);
    });

    it("should detect 'Building...'", () => {
      const result = matcher.analyze("Building application...");
      expect(result.matched).toBe(true);
      expect(result.category).toBe(PatternCategory.LONG_RUNNING);
    });
  });

  describe("Spawn Detection (Bug #4 fix)", () => {
    it("should detect empty output (just spawned)", () => {
      const result = matcher.analyze("");
      expect(result.matched).toBe(true);
      expect(result.category).toBe(PatternCategory.SPAWN);
      expect(result.targetState).toBe("spawning");
    });

    it("should detect 'Initialized empty Git'", () => {
      const result = matcher.analyze("Initialized empty Git repository");
      expect(result.matched).toBe(true);
      expect(result.category).toBe(PatternCategory.SPAWN);
    });

    it("should detect 'Welcome to' messages", () => {
      const result = matcher.analyze("Welcome to Ubuntu 22.04");
      expect(result.matched).toBe(true);
      expect(result.category).toBe(PatternCategory.SPAWN);
    });
  });

  describe("Priority Resolution", () => {
    it("should prefer ERROR (P1) over WAITING_INPUT (P2)", () => {
      const output = "Error: Connection failed\nwaiting for your input";
      const result = matcher.analyze(output);
      expect(result.category).toBe(PatternCategory.ERROR);
    });

    it("should prefer WAITING_INPUT (P2) over SPAWN (P3)", () => {
      const output = "Loading...\nwaiting for your input";
      const result = matcher.analyze(output);
      expect(result.category).toBe(PatternCategory.WAITING_INPUT);
    });

    it("should prefer SPAWN (P3) over INTERACTIVE (P4)", () => {
      const output = "Loading...\nContinue? (y/n)";
      const result = matcher.analyze(output);
      // SPAWN has priority 3, INTERACTIVE has priority 4
      expect(result.category).toBe(PatternCategory.SPAWN);
    });

    it("should prefer any pattern over SHELL_PROMPT (P8)", () => {
      const output = "Error: Failed\n$ ";
      const result = matcher.analyze(output);
      expect(result.category).toBe(PatternCategory.ERROR);
      expect(result.category).not.toBe(PatternCategory.SHELL_PROMPT);
    });
  });

  describe("No Match Cases", () => {
    it("should return no match for arbitrary text", () => {
      const result = matcher.analyze("Just some random text");
      expect(result.matched).toBe(false);
      expect(result.category).toBeNull();
    });

    it("should return no match for incomplete commands", () => {
      const result = matcher.analyze("cd /home/user");
      expect(result.matched).toBe(false);
    });
  });
});
