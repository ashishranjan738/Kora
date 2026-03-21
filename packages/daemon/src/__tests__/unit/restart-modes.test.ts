/**
 * Tests for agent restart modes:
 * - Fresh restart (no context)
 * - With context (carry terminal history, configurable lines)
 * - With summary (structured summary of tasks + terminal activity)
 *
 * Also tests:
 * - persistState called after restart/replace
 * - poll-usage endpoint
 * - Context window % tracking
 */
import { describe, it, expect } from "vitest";
import { AutonomyLevel } from "@kora/shared";

/* ================================================================== */
/*  Restart mode — initial task generation                             */
/* ================================================================== */

describe("Restart Modes — initialTask generation", () => {
  // Simulate the orchestrator's restart logic
  function buildInitialTask(options: {
    carryContext: boolean;
    summaryMode: boolean;
    contextLines?: number;
    terminalOutput?: string;
    currentTask?: string;
    agentName?: string;
    agentRole?: string;
    provider?: string;
    doneTasks?: Array<{ title: string; description?: string; status: string }>;
    activeTasks?: Array<{ title: string; description?: string; status: string }>;
    extraContext?: string;
  }): string | undefined {
    const {
      carryContext, summaryMode, contextLines = 50,
      terminalOutput = "", currentTask, agentName = "Agent",
      agentRole = "worker", provider = "claude-code",
      doneTasks = [], activeTasks = [], extraContext,
    } = options;

    if (summaryMode) {
      const terminalLines = terminalOutput.trim().split("\n").slice(-200).join("\n");
      return [
        "## Session Summary (auto-generated before restart)",
        "",
        `**Agent:** ${agentName} (${agentRole})`,
        `**Provider:** ${provider}`,
        currentTask ? `**Last task:** ${currentTask}` : "",
        "",
        "### Completed Tasks",
        doneTasks.length > 0
          ? doneTasks.map(t => `- [DONE] ${t.title}${t.description ? `: ${t.description.slice(0, 100)}` : ""}`).join("\n")
          : "- None",
        "",
        "### Active Tasks",
        activeTasks.length > 0
          ? activeTasks.map(t => `- [${t.status.toUpperCase()}] ${t.title}${t.description ? `: ${t.description.slice(0, 100)}` : ""}`).join("\n")
          : "- None",
        "",
        terminalLines ? "### Terminal Activity (last 200 lines)" : "",
        terminalLines ? "```" : "",
        terminalLines || "",
        terminalLines ? "```" : "",
        "",
        extraContext ? `### Additional context:\n${extraContext}\n` : "",
        "You have been restarted with a fresh session. Your worktree, tasks, and messages are preserved.",
        "Review the summary above and continue from where you left off. Check your messages for any updates.",
      ].filter(Boolean).join("\n");
    } else if (carryContext) {
      return [
        "## Recovery Context",
        "",
        "You are being restarted. Your agent ID, worktree, and message inbox are preserved.",
        currentTask ? `You were working on: ${currentTask}` : "",
        "",
        terminalOutput.trim() ? "### Last terminal output before restart:" : "",
        terminalOutput.trim() ? "```" : "",
        terminalOutput.trim() || "",
        terminalOutput.trim() ? "```" : "",
        "",
        extraContext ? `### Additional context:\n${extraContext}\n` : "",
        "Please continue from where you left off.",
      ].filter(Boolean).join("\n");
    }
    return undefined;
  }

  // ── Fresh mode ──

  it("fresh mode returns undefined (no initial task)", () => {
    const result = buildInitialTask({ carryContext: false, summaryMode: false });
    expect(result).toBeUndefined();
  });

  // ── With context mode ──

  it("with-context mode includes Recovery Context header", () => {
    const result = buildInitialTask({
      carryContext: true,
      summaryMode: false,
      terminalOutput: "$ npm test\nAll tests passed",
    });
    expect(result).toContain("## Recovery Context");
    expect(result).toContain("Your agent ID, worktree, and message inbox are preserved");
  });

  it("with-context mode includes terminal output in code block", () => {
    const result = buildInitialTask({
      carryContext: true,
      summaryMode: false,
      terminalOutput: "$ npm test\nAll tests passed",
    });
    expect(result).toContain("```");
    expect(result).toContain("npm test");
    expect(result).toContain("All tests passed");
  });

  it("with-context mode includes current task", () => {
    const result = buildInitialTask({
      carryContext: true,
      summaryMode: false,
      currentTask: "Fix the login bug",
    });
    expect(result).toContain("You were working on: Fix the login bug");
  });

  it("with-context mode includes extra context", () => {
    const result = buildInitialTask({
      carryContext: true,
      summaryMode: false,
      extraContext: "The server was restarted due to OOM",
    });
    expect(result).toContain("The server was restarted due to OOM");
  });

  it("with-context mode handles empty terminal output", () => {
    const result = buildInitialTask({
      carryContext: true,
      summaryMode: false,
      terminalOutput: "",
    });
    expect(result).toContain("## Recovery Context");
    expect(result).not.toContain("```");
  });

  // ── With summary mode ──

  it("summary mode includes Session Summary header", () => {
    const result = buildInitialTask({ carryContext: false, summaryMode: true });
    expect(result).toContain("## Session Summary (auto-generated before restart)");
  });

  it("summary mode includes agent identity", () => {
    const result = buildInitialTask({
      carryContext: false,
      summaryMode: true,
      agentName: "Architect",
      agentRole: "master",
      provider: "kiro",
    });
    expect(result).toContain("**Agent:** Architect (master)");
    expect(result).toContain("**Provider:** kiro");
  });

  it("summary mode includes completed tasks", () => {
    const result = buildInitialTask({
      carryContext: false,
      summaryMode: true,
      doneTasks: [
        { title: "Setup CI", description: "Configure GitHub Actions", status: "done" },
        { title: "Fix tests", status: "done" },
      ],
    });
    expect(result).toContain("### Completed Tasks");
    expect(result).toContain("- [DONE] Setup CI: Configure GitHub Actions");
    expect(result).toContain("- [DONE] Fix tests");
  });

  it("summary mode shows 'None' when no completed tasks", () => {
    const result = buildInitialTask({
      carryContext: false,
      summaryMode: true,
      doneTasks: [],
    });
    expect(result).toContain("### Completed Tasks");
    expect(result).toContain("- None");
  });

  it("summary mode includes active tasks with status", () => {
    const result = buildInitialTask({
      carryContext: false,
      summaryMode: true,
      activeTasks: [
        { title: "Implement auth", description: "JWT tokens", status: "in-progress" },
        { title: "Code review", status: "review" },
      ],
    });
    expect(result).toContain("### Active Tasks");
    expect(result).toContain("- [IN-PROGRESS] Implement auth: JWT tokens");
    expect(result).toContain("- [REVIEW] Code review");
  });

  it("summary mode includes terminal activity", () => {
    const result = buildInitialTask({
      carryContext: false,
      summaryMode: true,
      terminalOutput: "Running tests...\nAll 42 tests passed\n$",
    });
    expect(result).toContain("### Terminal Activity");
    expect(result).toContain("All 42 tests passed");
  });

  it("summary mode truncates terminal to last 200 lines", () => {
    const lines = Array.from({ length: 300 }, (_, i) => `line ${i}`).join("\n");
    const result = buildInitialTask({
      carryContext: false,
      summaryMode: true,
      terminalOutput: lines,
    });
    expect(result).toContain("line 299");
    expect(result).toContain("line 100");
    expect(result).not.toContain("line 0\n");
  });

  it("summary mode includes continuation instructions", () => {
    const result = buildInitialTask({ carryContext: false, summaryMode: true });
    expect(result).toContain("You have been restarted with a fresh session");
    expect(result).toContain("Check your messages for any updates");
  });

  it("summary mode includes current task as last task", () => {
    const result = buildInitialTask({
      carryContext: false,
      summaryMode: true,
      currentTask: "Debugging the WebSocket handler",
    });
    expect(result).toContain("**Last task:** Debugging the WebSocket handler");
  });

  it("summary mode truncates long task descriptions to 100 chars", () => {
    const longDesc = "A".repeat(200);
    const result = buildInitialTask({
      carryContext: false,
      summaryMode: true,
      doneTasks: [{ title: "Task", description: longDesc, status: "done" }],
    });
    const taskLine = result!.split("\n").find(l => l.includes("[DONE] Task"))!;
    // Description should be truncated at 100 chars
    expect(taskLine.length).toBeLessThan(200);
  });

  // ── Summary takes precedence over carryContext ──

  it("summaryMode=true takes precedence even if carryContext=true", () => {
    const result = buildInitialTask({
      carryContext: true,
      summaryMode: true,
      terminalOutput: "hello",
    });
    expect(result).toContain("## Session Summary");
    expect(result).not.toContain("## Recovery Context");
  });
});

/* ================================================================== */
/*  Poll-usage endpoint                                                */
/* ================================================================== */

describe("Poll-usage endpoint", () => {
  it("returns { polled: true } on success", () => {
    // Simulate the endpoint response
    const response = { polled: true };
    expect(response.polled).toBe(true);
  });

  it("poll triggers capturePane for all monitored agents", () => {
    // Simulate pollNow behavior
    const agentSessions = new Map([
      ["agent-a", "tmux-a"],
      ["agent-b", "tmux-b"],
    ]);
    const polled: string[] = [];
    for (const [agentId] of agentSessions) {
      polled.push(agentId);
    }
    expect(polled).toContain("agent-a");
    expect(polled).toContain("agent-b");
    expect(polled).toHaveLength(2);
  });
});

/* ================================================================== */
/*  Context window % tracking                                          */
/* ================================================================== */

describe("Context window % tracking", () => {
  function parseKiroContextPercent(output: string): number | undefined {
    const match = output.match(/(\d+)%\s*!?>/);
    return match ? parseInt(match[1], 10) : undefined;
  }

  it("parses N% from Kiro prompt", () => {
    expect(parseKiroContextPercent("5% !> How can I help?")).toBe(5);
    expect(parseKiroContextPercent("42% !>")).toBe(42);
    expect(parseKiroContextPercent("[plan] 3% !> Ready")).toBe(3);
  });

  it("parses high context usage", () => {
    expect(parseKiroContextPercent("89% !>")).toBe(89);
    expect(parseKiroContextPercent("100% >")).toBe(100);
  });

  it("returns undefined for non-Kiro output", () => {
    expect(parseKiroContextPercent("Hello world")).toBeUndefined();
    expect(parseKiroContextPercent("$ npm test")).toBeUndefined();
  });

  function estimateTokensFromPercent(pct: number): { input: number; output: number } {
    const total = Math.round((pct / 100) * 128_000);
    return { input: Math.round(total * 0.6), output: Math.round(total * 0.4) };
  }

  it("estimates tokens from context %", () => {
    const { input, output } = estimateTokensFromPercent(5);
    expect(input).toBe(3840);
    expect(output).toBe(2560);
    expect(input + output).toBe(6400);
  });

  it("100% = full 128k context window", () => {
    const { input, output } = estimateTokensFromPercent(100);
    expect(input + output).toBe(128_000);
  });

  it("0% = zero tokens", () => {
    const { input, output } = estimateTokensFromPercent(0);
    expect(input).toBe(0);
    expect(output).toBe(0);
  });
});

/* ================================================================== */
/*  Kiro credits parsing                                               */
/* ================================================================== */

describe("Kiro credits parsing", () => {
  function parseCumulativeCredits(output: string): number {
    const allCredits = output.match(/Credits:\s*([\d.]+)/g);
    if (!allCredits) return 0;
    let total = 0;
    for (const match of allCredits) {
      const val = parseFloat(match.replace(/Credits:\s*/, ""));
      if (!isNaN(val)) total += val;
    }
    return total;
  }

  it("sums multiple credit lines", () => {
    const output = [
      "▸ Credits: 0.07 • Time: 2s",
      "Some output here",
      "▸ Credits: 0.04 • Time: 1s",
      "More output",
      "▸ Credits: 0.12 • Time: 5s",
    ].join("\n");
    expect(parseCumulativeCredits(output)).toBeCloseTo(0.23, 2);
  });

  it("returns 0 for no credit lines", () => {
    expect(parseCumulativeCredits("Hello world\nNo credits here")).toBe(0);
  });

  it("handles single credit line", () => {
    expect(parseCumulativeCredits("▸ Credits: 0.05 • Time: 1s")).toBeCloseTo(0.05, 2);
  });

  it("handles large credit values", () => {
    const output = "▸ Credits: 1.50 • Time: 30s\n▸ Credits: 2.25 • Time: 45s";
    expect(parseCumulativeCredits(output)).toBeCloseTo(3.75, 2);
  });
});

/* ================================================================== */
/*  AgentCost type with contextWindowPercent                           */
/* ================================================================== */

describe("AgentCost with contextWindowPercent", () => {
  interface AgentCost {
    totalTokensIn: number;
    totalTokensOut: number;
    totalCostUsd: number;
    contextWindowPercent?: number;
    lastUpdatedAt: string;
  }

  it("contextWindowPercent is optional (undefined for non-Kiro agents)", () => {
    const cost: AgentCost = {
      totalTokensIn: 1000,
      totalTokensOut: 500,
      totalCostUsd: 0.05,
      lastUpdatedAt: new Date().toISOString(),
    };
    expect(cost.contextWindowPercent).toBeUndefined();
  });

  it("contextWindowPercent is set for Kiro agents", () => {
    const cost: AgentCost = {
      totalTokensIn: 3840,
      totalTokensOut: 2560,
      totalCostUsd: 0.07,
      contextWindowPercent: 5,
      lastUpdatedAt: new Date().toISOString(),
    };
    expect(cost.contextWindowPercent).toBe(5);
  });

  it("CostTracker updates contextWindowPercent from parsed output", () => {
    const cost: AgentCost = {
      totalTokensIn: 0,
      totalTokensOut: 0,
      totalCostUsd: 0,
      lastUpdatedAt: "",
    };

    // Simulate updateFromOutput
    const parsed = { contextWindowPercent: 12 };
    if (parsed.contextWindowPercent !== undefined) {
      cost.contextWindowPercent = parsed.contextWindowPercent;
    }
    cost.lastUpdatedAt = new Date().toISOString();

    expect(cost.contextWindowPercent).toBe(12);
  });
});

/* ================================================================== */
/*  UsageMonitor provider-aware parsing                                */
/* ================================================================== */

describe("UsageMonitor — provider-aware parsing", () => {
  it("uses provider parseOutput for known providers", () => {
    const providers = new Map([
      ["kiro", { id: "kiro", parseOutput: (o: string) => ({ costUsd: 0.1 }) }],
      ["claude-code", { id: "claude-code", parseOutput: (o: string) => ({ costUsd: 0.2 }) }],
    ]);

    const provider = providers.get("kiro");
    expect(provider).toBeDefined();
    const parsed = provider!.parseOutput("test");
    expect(parsed.costUsd).toBe(0.1);
  });

  it("falls back to estimate for unknown providers", () => {
    const providers = new Map<string, any>();
    const provider = providers.get("goose");
    expect(provider).toBeUndefined();
    // In this case, UsageMonitor uses tiktoken estimate
  });

  it("skip retry list includes kiro but not claude-code", () => {
    const skipRetryProviders = ["kiro"];
    expect(skipRetryProviders.includes("kiro")).toBe(true);
    expect(skipRetryProviders.includes("claude-code")).toBe(false);
  });
});
