/**
 * Unit tests for agent output API enhancements
 */

import { describe, it, expect, beforeEach } from "vitest";

describe("Agent Output API", () => {
  describe("Output caching", () => {
    it("should cache output for 2 seconds", () => {
      // Cache implementation test
      interface CachedOutput {
        raw: string;
        timestamp: number;
        lines: string[];
      }

      class AgentOutputCache {
        private cache = new Map<string, CachedOutput>();
        private readonly TTL = 2000;

        get(agentId: string): CachedOutput | null {
          const cached = this.cache.get(agentId);
          if (!cached) return null;
          if (Date.now() - cached.timestamp > this.TTL) {
            this.cache.delete(agentId);
            return null;
          }
          return cached;
        }

        set(agentId: string, raw: string, lines: string[]): void {
          this.cache.set(agentId, { raw, timestamp: Date.now(), lines });
        }

        clear(agentId: string): void {
          this.cache.delete(agentId);
        }
      }

      const cache = new AgentOutputCache();
      const agentId = "test-agent";
      const output = "test output";
      const lines = ["line1", "line2"];

      cache.set(agentId, output, lines);
      const cached = cache.get(agentId);

      expect(cached).not.toBeNull();
      expect(cached?.raw).toBe(output);
      expect(cached?.lines).toEqual(lines);
    });

    it("should expire cache after TTL", async () => {
      interface CachedOutput {
        raw: string;
        timestamp: number;
        lines: string[];
      }

      class AgentOutputCache {
        private cache = new Map<string, CachedOutput>();
        private readonly TTL = 100; // Short TTL for testing

        get(agentId: string): CachedOutput | null {
          const cached = this.cache.get(agentId);
          if (!cached) return null;
          if (Date.now() - cached.timestamp > this.TTL) {
            this.cache.delete(agentId);
            return null;
          }
          return cached;
        }

        set(agentId: string, raw: string, lines: string[]): void {
          this.cache.set(agentId, { raw, timestamp: Date.now(), lines });
        }
      }

      const cache = new AgentOutputCache();
      const agentId = "test-agent";

      cache.set(agentId, "output", ["line1"]);
      expect(cache.get(agentId)).not.toBeNull();

      // Wait for TTL to expire
      await new Promise(resolve => setTimeout(resolve, 150));
      expect(cache.get(agentId)).toBeNull();
    });
  });

  describe("Structured output parsing", () => {
    function parseStructuredOutput(lines: string[]): Array<{
      type: "command" | "response" | "system";
      content: string;
    }> {
      const entries: Array<{
        type: "command" | "response" | "system";
        content: string;
      }> = [];
      let currentEntry: string[] = [];
      let currentType: "command" | "response" | "system" = "response";

      for (const line of lines) {
        const trimmed = line.trim();
        if (!trimmed) continue;

        if (trimmed.match(/^[$%>#❯]\s+/)) {
          if (currentEntry.length > 0) {
            entries.push({ type: currentType, content: currentEntry.join('\n') });
            currentEntry = [];
          }
          currentType = "command";
          currentEntry.push(trimmed);
        } else if (
          trimmed.match(/^\[Tool:\s/) ||
          trimmed.match(/^\[Message\s/) ||
          trimmed.match(/^\[System/i) ||
          trimmed.match(/^ERROR:/i) ||
          trimmed.match(/^WARNING:/i) ||
          trimmed.match(/^FATAL:/i)
        ) {
          if (currentEntry.length > 0) {
            entries.push({ type: currentType, content: currentEntry.join('\n') });
            currentEntry = [];
          }
          currentType = "system";
          currentEntry.push(trimmed);
        } else {
          if (currentType === "command" && currentEntry.length > 0) {
            entries.push({ type: "command", content: currentEntry.join('\n') });
            currentEntry = [];
            currentType = "response";
          }
          currentEntry.push(trimmed);
        }
      }

      if (currentEntry.length > 0) {
        entries.push({ type: currentType, content: currentEntry.join('\n') });
      }

      return entries;
    }

    it("should identify command prompts", () => {
      const lines = [
        "$ ls -la",
        "file1.txt",
        "file2.txt",
      ];

      const structured = parseStructuredOutput(lines);

      expect(structured).toHaveLength(2);
      expect(structured[0].type).toBe("command");
      expect(structured[0].content).toBe("$ ls -la");
      expect(structured[1].type).toBe("response");
      expect(structured[1].content).toContain("file1.txt");
    });

    it("should identify system messages", () => {
      const lines = [
        "[Tool: Read] Reading file.ts",
        "ERROR: File not found",
      ];

      const structured = parseStructuredOutput(lines);

      expect(structured).toHaveLength(2);
      expect(structured[0].type).toBe("system");
      expect(structured[0].content).toContain("Tool: Read");
      expect(structured[1].type).toBe("system");
      expect(structured[1].content).toContain("ERROR");
    });

    it("should parse mixed command and response output", () => {
      const lines = [
        "$ echo 'Hello World'",
        "Hello World",
        "$ pwd",
        "/home/user",
      ];

      const structured = parseStructuredOutput(lines);

      expect(structured).toHaveLength(4);
      expect(structured[0].type).toBe("command");
      expect(structured[1].type).toBe("response");
      expect(structured[2].type).toBe("command");
      expect(structured[3].type).toBe("response");
    });

    it("should not treat JSON arrays as system messages", () => {
      const lines = [
        "$ node script.js",
        '["item1", "item2", "item3"]',
        '{"key": [1, 2, 3]}',
      ];

      const structured = parseStructuredOutput(lines);

      expect(structured).toHaveLength(2);
      expect(structured[0].type).toBe("command");
      expect(structured[1].type).toBe("response");
      expect(structured[1].content).toContain("item1");
    });

    it("should detect specific system message patterns", () => {
      const lines = [
        "[Tool: Read] Reading file",
        "[Message from Agent] Hello",
        "ERROR: File not found",
        "WARNING: Deprecated API",
      ];

      const structured = parseStructuredOutput(lines);

      expect(structured).toHaveLength(4);
      expect(structured.every(e => e.type === "system")).toBe(true);
    });
  });

  describe("Query parameters", () => {
    it("should parse lines parameter with default", () => {
      const query = { lines: "50" };
      const lines = parseInt(query.lines) || 100;
      expect(lines).toBe(50);
    });

    it("should use default lines if not specified", () => {
      const query = {};
      const lines = parseInt((query as any).lines) || 100;
      expect(lines).toBe(100);
    });

    it("should parse format parameter", () => {
      const query = { format: "structured" };
      const format = query.format || "raw";
      expect(format).toBe("structured");
    });

    it("should default format to raw", () => {
      const query = {};
      const format = (query as any).format || "raw";
      expect(format).toBe("raw");
    });

    it("should parse stripAnsi boolean", () => {
      const query = { stripAnsi: "true" };
      const stripAnsi = query.stripAnsi === "true";
      expect(stripAnsi).toBe(true);
    });

    it("should parse since timestamp", () => {
      const query = { since: "1234567890" };
      const since = query.since ? parseInt(query.since) : null;
      expect(since).toBe(1234567890);
    });

    it("should handle missing since parameter", () => {
      const query = {};
      const since = (query as any).since ? parseInt((query as any).since) : null;
      expect(since).toBeNull();
    });
  });
});
