import { describe, it, expect } from "vitest";
import { analyzeTerminalOutput, type TerminalStatusResult } from "../terminal-analyzer.js";

const RECENT = new Date().toISOString();
const FIVE_MIN_AGO = new Date(Date.now() - 6 * 60 * 1000).toISOString();
const THIRTY_SEC_AGO = new Date(Date.now() - 10 * 1000).toISOString();

describe("terminal-analyzer", () => {
  describe("idle detection", () => {
    it("detects shell prompt ($) as idle", () => {
      const result = analyzeTerminalOutput("agent-1", ["$ "], FIVE_MIN_AGO);
      expect(result.status).toBe("idle");
      expect(result.confidence).toBe("high");
    });

    it("detects shell prompt (%) as idle", () => {
      const result = analyzeTerminalOutput("agent-1", ["user@host % "], FIVE_MIN_AGO);
      expect(result.status).toBe("idle");
      expect(result.confidence).toBe("high");
    });

    it("detects shell prompt (>) as idle", () => {
      const result = analyzeTerminalOutput("agent-1", ["> "], FIVE_MIN_AGO);
      expect(result.status).toBe("idle");
      expect(result.confidence).toBe("high");
    });

    it("detects shell prompt (❯) as idle", () => {
      const result = analyzeTerminalOutput("agent-1", ["❯ "], FIVE_MIN_AGO);
      expect(result.status).toBe("idle");
      expect(result.confidence).toBe("high");
    });

    it("returns idle with low confidence for empty output", () => {
      const result = analyzeTerminalOutput("agent-1", [], RECENT);
      expect(result.status).toBe("idle");
      expect(result.confidence).toBe("low");
    });
  });

  describe("working detection", () => {
    it("detects 'Channeling' as working", () => {
      const result = analyzeTerminalOutput("agent-1", ["Channeling thoughts..."], RECENT);
      expect(result.status).toBe("working");
      expect(result.confidence).toBe("high");
    });

    it("detects 'Reading file.ts' as working", () => {
      const result = analyzeTerminalOutput("agent-1", ["Reading api-routes.ts"], RECENT);
      expect(result.status).toBe("working");
      expect(result.confidence).toBe("high");
    });

    it("detects 'Writing file.ts' as working", () => {
      const result = analyzeTerminalOutput("agent-1", ["Writing terminal-analyzer.ts"], RECENT);
      expect(result.status).toBe("working");
      expect(result.confidence).toBe("high");
    });

    it("detects 'Running command' as working", () => {
      const result = analyzeTerminalOutput("agent-1", ["Running npm test"], RECENT);
      expect(result.status).toBe("working");
      expect(result.confidence).toBe("high");
    });

    it("detects 'Building' as working", () => {
      const result = analyzeTerminalOutput("agent-1", ["Building project..."], RECENT);
      expect(result.status).toBe("working");
      expect(result.confidence).toBe("high");
    });

    it("detects recent activity without patterns as working (low confidence)", () => {
      const result = analyzeTerminalOutput("agent-1", ["some random output"], THIRTY_SEC_AGO);
      expect(result.status).toBe("working");
      expect(result.confidence).toBe("low");
    });
  });

  describe("waiting-input detection", () => {
    it("detects 'waiting for your input'", () => {
      const result = analyzeTerminalOutput("agent-1", ["Claude is waiting for your input"], RECENT);
      expect(result.status).toBe("waiting-input");
      expect(result.confidence).toBe("high");
    });

    it("detects (y/n) prompts", () => {
      const result = analyzeTerminalOutput("agent-1", ["Do you want to proceed? (y/n)"], RECENT);
      expect(result.status).toBe("waiting-input");
      expect(result.confidence).toBe("high");
    });

    it("detects '? for shortcuts' (Claude Code idle)", () => {
      const result = analyzeTerminalOutput("agent-1", ["? for shortcuts"], RECENT);
      expect(result.status).toBe("waiting-input");
      expect(result.confidence).toBe("high");
    });

    it("detects permission prompts", () => {
      const result = analyzeTerminalOutput("agent-1", ["Allow this permission?"], RECENT);
      expect(result.status).toBe("waiting-input");
      expect(result.confidence).toBe("high");
    });
  });

  describe("error detection", () => {
    it("detects 'Error:' in output", () => {
      const result = analyzeTerminalOutput("agent-1", ["Error: Module not found"], RECENT);
      expect(result.status).toBe("error");
      expect(result.confidence).toBe("medium");
    });

    it("detects ENOENT errors", () => {
      const result = analyzeTerminalOutput("agent-1", ["ENOENT: no such file or directory"], RECENT);
      expect(result.status).toBe("error");
      expect(result.confidence).toBe("medium");
    });

    it("detects 'command not found'", () => {
      const result = analyzeTerminalOutput("agent-1", ["zsh: command not found: foo"], RECENT);
      expect(result.status).toBe("error");
      expect(result.confidence).toBe("medium");
    });
  });

  describe("stuck detection", () => {
    it("detects stuck when no change for >5 minutes without prompt", () => {
      const result = analyzeTerminalOutput("agent-1", ["some old output"], FIVE_MIN_AGO);
      expect(result.status).toBe("stuck");
      expect(result.confidence).toBe("medium");
      expect(result.inferred).toContain("minutes");
    });

    it("does not mark as stuck if at prompt (marks idle instead)", () => {
      const result = analyzeTerminalOutput("agent-1", ["$ "], FIVE_MIN_AGO);
      expect(result.status).toBe("idle");
    });
  });

  describe("priority ordering", () => {
    it("waiting-input takes priority over error patterns", () => {
      const result = analyzeTerminalOutput("agent-1", [
        "Error: something went wrong",
        "Do you want to proceed? (y/n)"
      ], RECENT);
      expect(result.status).toBe("waiting-input");
    });

    it("waiting-input takes priority over working patterns", () => {
      const result = analyzeTerminalOutput("agent-1", [
        "Building project...",
        "Would you like to continue?"
      ], RECENT);
      expect(result.status).toBe("waiting-input");
    });

    it("error takes priority over working patterns", () => {
      const result = analyzeTerminalOutput("agent-1", [
        "Building project...",
        "Error: compilation failed"
      ], RECENT);
      expect(result.status).toBe("error");
    });
  });

  describe("response format", () => {
    it("includes all required fields", () => {
      const result = analyzeTerminalOutput("agent-42", ["$ "], RECENT);
      expect(result.agentId).toBe("agent-42");
      expect(result.status).toBeDefined();
      expect(result.lastLines).toBeInstanceOf(Array);
      expect(result.lastActivity).toBe(RECENT);
      expect(result.inferred).toBeDefined();
      expect(result.confidence).toBeDefined();
    });

    it("preserves all lines in lastLines", () => {
      const lines = ["line 1", "line 2", "line 3"];
      const result = analyzeTerminalOutput("agent-1", lines, RECENT);
      expect(result.lastLines).toEqual(lines);
    });
  });
});
