import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { AgentHealthMonitor, IDLE_PROMPT_PATTERNS, stripAnsi, IDLE_MESSAGE_KEYWORDS } from "../agent-health.js";
import type { AgentState } from "@kora/shared";
import type { IPtyBackend } from "../pty-backend.js";

describe("AgentHealthMonitor — idle detection", () => {
  let monitor: AgentHealthMonitor;
  let mockTmux: IPtyBackend;
  let agents: Map<string, AgentState>;

  beforeEach(() => {
    // Use fake timers
    vi.useFakeTimers();

    // Mock tmux backend
    mockTmux = {
      hasSession: vi.fn().mockResolvedValue(true),
      getPanePID: vi.fn().mockResolvedValue(12345),
      capturePane: vi.fn(),
    } as any;

    // Create agents map
    agents = new Map();
    agents.set("agent-1", {
      id: "agent-1",
      config: { name: "Worker", tmuxSession: "test-session" } as any,
      status: "running",
      activity: "working",
      lastActivityAt: new Date().toISOString(),
      lastOutputAt: new Date().toISOString(),
    } as any);

    monitor = new AgentHealthMonitor(mockTmux, agents);
  });

  afterEach(() => {
    vi.useRealTimers();
    monitor.stopAll();
  });

  it("should detect bash/zsh/powershell shell prompt patterns", () => {
    const prompts = [
      "$ ",              // bash
      "% ",              // zsh
      "> ",              // powershell
      "# ",              // root shell
      "user@host $ ",    // bash with user@host
      "  $ ",            // bash with leading spaces
      "  % ",            // zsh with leading spaces
      "[user@host] $ ",  // bracketed
    ];

    for (const prompt of prompts) {
      const isPrompt = IDLE_PROMPT_PATTERNS.some(pattern => pattern.test(prompt));
      if (!isPrompt) {
        console.log(`Failed to match prompt: "${prompt}"`);
      }
      expect(isPrompt).toBe(true);
    }
  });

  it("should NOT detect work output as prompt", () => {
    const workOutputs = [
      "npm run build",
      "Building application...",
      "Done in 2.5s",
      "Error: Module not found",
      "✓ All tests passed",
      "  src/index.ts",
      "  function main() {",
    ];

    for (const output of workOutputs) {
      const isPrompt = IDLE_PROMPT_PATTERNS.some(pattern => pattern.test(output));
      expect(isPrompt).toBe(false);
    }
  });
});

describe("stripAnsi", () => {
  it("should return plain text unchanged", () => {
    expect(stripAnsi("hello world")).toBe("hello world");
    expect(stripAnsi("$ ")).toBe("$ ");
    expect(stripAnsi("")).toBe("");
  });

  it("should strip CSI color/style sequences", () => {
    expect(stripAnsi("\x1b[1;32mhello\x1b[0m")).toBe("hello");
    expect(stripAnsi("\x1b[31mError: something\x1b[0m")).toBe("Error: something");
  });

  it("should strip CSI cursor movement sequences", () => {
    expect(stripAnsi("line1\x1b[Aline2")).toBe("line1line2");
    expect(stripAnsi("\x1b[H\x1b[2Jhello")).toBe("hello");
  });

  it("should strip OSC sequences (window titles, hyperlinks)", () => {
    expect(stripAnsi("\x1b]0;My Window Title\x07prompt $ ")).toBe("prompt $ ");
    expect(stripAnsi("\x1b]0;title\x1b\\$ ")).toBe("$ ");
  });

  it("should strip complex holdpty-style terminal output", () => {
    const holdptyOutput = [
      "\x1b]0;~/Projects/Kora\x07",
      "\x1b[1;36m\u276F\x1b[0m ",
    ].join("");
    const stripped = stripAnsi(holdptyOutput);
    expect(stripped).toBe("\u276F ");
    expect(IDLE_PROMPT_PATTERNS.some(p => p.test(stripped))).toBe(true);
  });

  it("should produce stable hashes for same visible content with different ANSI wrapping", () => {
    const capture1 = "\x1b[?25l\x1b]0;~/Projects\x07\x1b[1;36m\u276F\x1b[0m \x1b[?25h";
    const capture2 = "\x1b[?25h\x1b]0;~/Projects\x07\x1b[1;36m\u276F\x1b[0m \x1b[?25l";
    expect(stripAnsi(capture1)).toBe(stripAnsi(capture2));
  });

  it("should handle Claude Code prompt patterns after stripping", () => {
    const claudeIdle1 = "\x1b[1;36m\u276F\x1b[0m ";
    const claudeIdle2 = "\x1b[90m? for shortcuts\x1b[0m";

    const stripped1 = stripAnsi(claudeIdle1);
    const stripped2 = stripAnsi(claudeIdle2);

    expect(stripped1).toBe("\u276F ");
    expect(stripped2).toBe("? for shortcuts");
    expect(IDLE_PROMPT_PATTERNS.some(p => p.test(stripped1))).toBe(true);
    expect(IDLE_PROMPT_PATTERNS.some(p => p.test(stripped2))).toBe(true);
  });

  it("should NOT match working output after stripping", () => {
    const workingOutput = "\x1b[32m✓\x1b[0m Building packages/daemon...";
    const stripped = stripAnsi(workingOutput);
    expect(stripped).toBe("✓ Building packages/daemon...");
    expect(IDLE_PROMPT_PATTERNS.some(p => p.test(stripped))).toBe(false);
  });
});

describe("IDLE_PROMPT_PATTERNS — holdpty compatibility", () => {
  it("should match \u276F prompt (Claude Code)", () => {
    expect(IDLE_PROMPT_PATTERNS.some(p => p.test("\u276F "))).toBe(true);
    expect(IDLE_PROMPT_PATTERNS.some(p => p.test("  \u276F "))).toBe(true);
  });

  it("should match '? for shortcuts' prompt", () => {
    expect(IDLE_PROMPT_PATTERNS.some(p => p.test("? for shortcuts"))).toBe(true);
  });

  it("should match standard shell prompts", () => {
    expect(IDLE_PROMPT_PATTERNS.some(p => p.test("$ "))).toBe(true);
    expect(IDLE_PROMPT_PATTERNS.some(p => p.test("% "))).toBe(true);
    expect(IDLE_PROMPT_PATTERNS.some(p => p.test("> "))).toBe(true);
    expect(IDLE_PROMPT_PATTERNS.some(p => p.test("# "))).toBe(true);
  });
});

describe("MCP idle signal — Layer 1", () => {
  it("markIdleFromMcp should set agent to idle immediately", () => {
    const mockTmux = {
      hasSession: vi.fn().mockResolvedValue(true),
      getPanePID: vi.fn().mockResolvedValue(12345),
      capturePane: vi.fn(),
    } as any;

    const agents = new Map<string, AgentState>();
    agents.set("agent-1", {
      id: "agent-1",
      config: { name: "Worker", tmuxSession: "test" } as any,
      status: "running",
      activity: "working",
      lastActivityAt: new Date().toISOString(),
    } as any);

    const monitor = new AgentHealthMonitor(mockTmux, agents);
    const idleEvents: string[] = [];
    monitor.on("agent-idle", (id) => idleEvents.push(id));

    monitor.markIdleFromMcp("agent-1", "task completed");

    expect(agents.get("agent-1")!.activity).toBe("idle");
    expect(agents.get("agent-1")!.idleSince).toBeDefined();
    expect(idleEvents).toContain("agent-1");

    monitor.stopAll();
  });

  it("isMessageIdle should detect completion keywords", () => {
    expect(AgentHealthMonitor.isMessageIdle("Task complete, standing by for next assignment")).toBe(true);
    expect(AgentHealthMonitor.isMessageIdle("I'm standing by for new tasks")).toBe(true);
    expect(AgentHealthMonitor.isMessageIdle("Ready for next task")).toBe(true);
    expect(AgentHealthMonitor.isMessageIdle("All done with the implementation")).toBe(true);
    expect(AgentHealthMonitor.isMessageIdle("Reporting idle")).toBe(true);
  });

  it("isMessageIdle should NOT trigger on normal work messages", () => {
    expect(AgentHealthMonitor.isMessageIdle("Working on the auth module")).toBe(false);
    expect(AgentHealthMonitor.isMessageIdle("Found a bug in the login flow")).toBe(false);
    expect(AgentHealthMonitor.isMessageIdle("Need help with the database schema")).toBe(false);
    expect(AgentHealthMonitor.isMessageIdle("PR #42 is ready for review")).toBe(false);
  });
});
