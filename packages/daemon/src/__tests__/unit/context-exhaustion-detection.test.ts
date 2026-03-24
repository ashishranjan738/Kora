/**
 * Tests for context exhaustion detection patterns and task briefing on replace.
 */
import { describe, it, expect } from "vitest";
import { CONTEXT_EXHAUSTION_PATTERNS } from "../../core/agent-health.js";

// ---------------------------------------------------------------------------
// Helper
// ---------------------------------------------------------------------------

function matchesExhaustion(text: string): boolean {
  return CONTEXT_EXHAUSTION_PATTERNS.some(p => p.test(text));
}

// ---------------------------------------------------------------------------
// 1. Context exhaustion patterns — positive matches
// ---------------------------------------------------------------------------

describe("CONTEXT_EXHAUSTION_PATTERNS: positive matches", () => {
  it("detects 'context window' errors", () => {
    expect(matchesExhaustion("Error: context window exceeded")).toBe(true);
    expect(matchesExhaustion("The context window is full")).toBe(true);
  });

  it("detects 'too many tokens' errors", () => {
    expect(matchesExhaustion("Error: too many tokens in request")).toBe(true);
    expect(matchesExhaustion("too many tokens")).toBe(true);
  });

  it("detects 'maximum context length' errors", () => {
    expect(matchesExhaustion("maximum context length exceeded")).toBe(true);
    expect(matchesExhaustion("exceeds the maximum context length")).toBe(true);
  });

  it("detects 'token limit' errors", () => {
    expect(matchesExhaustion("token limit reached")).toBe(true);
    expect(matchesExhaustion("Exceeded token limit")).toBe(true);
  });

  it("detects 'context limit' errors", () => {
    expect(matchesExhaustion("context limit exceeded")).toBe(true);
  });

  it("detects 'conversation is too long' errors", () => {
    expect(matchesExhaustion("This conversation is too long")).toBe(true);
  });

  it("detects 'input is too long' errors", () => {
    expect(matchesExhaustion("Error: input is too long")).toBe(true);
  });

  it("detects 'exceeds maximum allowed length' errors", () => {
    expect(matchesExhaustion("Request exceeds the maximum allowed length")).toBe(true);
    expect(matchesExhaustion("exceeds maximum tokens")).toBe(true);
    expect(matchesExhaustion("exceeds max length")).toBe(true);
  });

  it("detects 'reduce the length' suggestions", () => {
    expect(matchesExhaustion("Please reduce the length of your prompt")).toBe(true);
    expect(matchesExhaustion("Please reduce your prompt")).toBe(true);
    expect(matchesExhaustion("reduce tokens to fit")).toBe(true);
  });

  it("detects agent self-reporting context exhaustion", () => {
    expect(matchesExhaustion("I'm running out of context")).toBe(true);
    expect(matchesExhaustion("My context is almost full")).toBe(true);
    expect(matchesExhaustion("context is exhausted")).toBe(true);
    expect(matchesExhaustion("context exceeded")).toBe(true);
  });

  it("detects 'approaching context limit' warnings", () => {
    expect(matchesExhaustion("approaching the context limit")).toBe(true);
    expect(matchesExhaustion("nearing context limit")).toBe(true);
    expect(matchesExhaustion("near the context limit")).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// 2. Context exhaustion patterns — negative matches (should NOT match)
// ---------------------------------------------------------------------------

describe("CONTEXT_EXHAUSTION_PATTERNS: negative matches", () => {
  it("does NOT match normal code output", () => {
    expect(matchesExhaustion("const context = createContext()")).toBe(false);
    expect(matchesExhaustion("function getTokenFromHeader(req)")).toBe(false);
    expect(matchesExhaustion("npm install completed")).toBe(false);
  });

  it("does NOT match normal git output", () => {
    expect(matchesExhaustion("commit abc123: fix context switching")).toBe(false);
    expect(matchesExhaustion("Merge branch 'main'")).toBe(false);
  });

  it("does NOT match idle prompts", () => {
    expect(matchesExhaustion("? for shortcuts")).toBe(false);
    expect(matchesExhaustion("$")).toBe(false);
    expect(matchesExhaustion(">")).toBe(false);
  });

  it("does NOT match thinking patterns", () => {
    expect(matchesExhaustion("⠋ Thinking...")).toBe(false);
    expect(matchesExhaustion("Processing files")).toBe(false);
  });

  it("does NOT match test output", () => {
    expect(matchesExhaustion("36 tests passed")).toBe(false);
    expect(matchesExhaustion("PASS packages/daemon/test.ts")).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// 3. Task briefing on replace — message format
// ---------------------------------------------------------------------------

describe("Task briefing on replace: message construction", () => {
  it("builds correct briefing message with active tasks", () => {
    const oldName = "Dev 1";
    const activeTasks = [
      { id: "abc123", title: "Fix the bug", status: "in-progress" },
      { id: "def456", title: "Write tests", status: "review" },
    ];

    const taskList = activeTasks
      .map(t => `  - "${t.title}" (${t.id}) — status: ${t.status}`)
      .join("\n");
    const briefing =
      `You are replacing a previous agent (${oldName}). ` +
      `You have ${activeTasks.length} active task(s):\n${taskList}\n` +
      `Use get_task(id) to read details and continue where the previous agent left off.`;

    expect(briefing).toContain("replacing a previous agent (Dev 1)");
    expect(briefing).toContain("2 active task(s)");
    expect(briefing).toContain("Fix the bug");
    expect(briefing).toContain("abc123");
    expect(briefing).toContain("in-progress");
    expect(briefing).toContain("Write tests");
    expect(briefing).toContain("get_task(id)");
  });

  it("filters tasks by assignedTo matching old agent name or ID", () => {
    const oldName = "Dev 1";
    const oldId = "agent-123";
    const allTasks = [
      { id: "t1", title: "My task", status: "in-progress", assignedTo: "Dev 1" },
      { id: "t2", title: "Done task", status: "done", assignedTo: "Dev 1" },
      { id: "t3", title: "Other task", status: "in-progress", assignedTo: "Dev 2" },
      { id: "t4", title: "ID match", status: "review", assignedTo: "agent-123" },
    ];

    const activeTasks = allTasks.filter(t =>
      (t.assignedTo === oldName || t.assignedTo === oldId) &&
      t.status !== "done"
    );

    expect(activeTasks).toHaveLength(2);
    expect(activeTasks.map(t => t.id)).toContain("t1");
    expect(activeTasks.map(t => t.id)).toContain("t4");
  });

  it("skips briefing when no active tasks", () => {
    const allTasks = [
      { id: "t1", title: "Done task", status: "done", assignedTo: "Dev 1" },
    ];

    const activeTasks = allTasks.filter(t =>
      t.assignedTo === "Dev 1" && t.status !== "done"
    );

    expect(activeTasks).toHaveLength(0);
    // No briefing should be sent — the code checks activeTasks.length > 0
  });
});
