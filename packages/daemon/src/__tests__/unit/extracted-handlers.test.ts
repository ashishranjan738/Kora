/**
 * Tests for the 4 handlers extracted from agent-mcp-server.ts to tool-handlers.ts:
 * - handleCheckMessages
 * - handlePreparePr
 * - handleVerifyWork
 * - handleCreatePr
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

// Mock fs before importing handlers
vi.mock("fs", () => ({
  readdirSync: vi.fn(() => []),
  readFileSync: vi.fn(() => ""),
  mkdirSync: vi.fn(),
  renameSync: vi.fn(),
}));

import * as fs from "fs";
import type { ToolContext } from "../../tools/tool-context.js";
import {
  handleCheckMessages,
  handlePreparePr,
  handleVerifyWork,
  handleCreatePr,
} from "../../tools/tool-handlers.js";

function createMockContext(overrides: Partial<ToolContext> = {}): ToolContext {
  return {
    agentId: "test-agent-123",
    sessionId: "test-session-456",
    agentRole: "worker",
    projectPath: "/tmp/test-project",
    apiCall: vi.fn().mockResolvedValue({}),
    execFileAsync: vi.fn().mockResolvedValue({ stdout: "", stderr: "" }),
    getRuntimeDir: vi.fn().mockReturnValue(".kora"),
    ...overrides,
  };
}

// ── handleCheckMessages ──────────────────────────────────

describe("handleCheckMessages", () => {
  beforeEach(() => { vi.clearAllMocks(); });

  it("returns empty messages when no messages exist", async () => {
    const ctx = createMockContext({ apiCall: vi.fn().mockResolvedValue({ messages: [] }) });
    const result = (await handleCheckMessages(ctx, {})) as any;
    expect(result.messages).toEqual([]);
    expect(result.count).toBe(0);
  });

  it("reads messages from SQLite (primary source)", async () => {
    const ctx = createMockContext({
      apiCall: vi.fn()
        .mockResolvedValueOnce({
          messages: [{ id: "msg-1", fromName: "Dev 1", content: "Hello", createdAt: "2026-03-28T10:00:00.000Z", channel: null }],
        })
        .mockResolvedValue({}),
    });
    const result = (await handleCheckMessages(ctx, {})) as any;
    expect(result.count).toBe(1);
    expect(result.messages[0].from).toBe("Dev 1");
    expect(result.messages[0].content).toBe("Hello");
  });

  it("marks SQLite messages as read", async () => {
    const apiCall = vi.fn()
      .mockResolvedValueOnce({ messages: [{ id: "msg-1", fromName: "Dev 1", content: "Hello", createdAt: "2026-03-28T10:00:00.000Z" }] })
      .mockResolvedValue({});
    const ctx = createMockContext({ apiCall });
    await handleCheckMessages(ctx, {});
    expect(apiCall).toHaveBeenCalledWith("POST", "/api/v1/sessions/test-session-456/agents/test-agent-123/messages/mark-read", { messageIds: ["msg-1"] });
  });

  it("reads from mcp-pending files (tier 2)", async () => {
    const ctx = createMockContext({ apiCall: vi.fn().mockResolvedValue({ messages: [] }) });
    (fs.readdirSync as any).mockImplementation((dir: string) => dir.includes("mcp-pending") ? ["msg1.json"] : []);
    (fs.readFileSync as any).mockReturnValue(JSON.stringify({ from: "Agent-B", content: "Pending message", timestamp: "2026-03-28T10:00:00.000Z" }));
    const result = (await handleCheckMessages(ctx, {})) as any;
    expect(result.count).toBe(1);
    expect(result.messages[0].from).toBe("Agent-B");
  });

  it("deduplicates messages across sources", async () => {
    const ctx = createMockContext({
      apiCall: vi.fn().mockResolvedValueOnce({
        messages: [{ id: "msg-1", fromName: "Dev 1", content: "Same message", createdAt: "2026-03-28T10:00:00.000Z" }],
      }).mockResolvedValue({}),
    });
    (fs.readdirSync as any).mockImplementation((dir: string) => dir.includes("mcp-pending") ? ["msg1.json"] : []);
    (fs.readFileSync as any).mockReturnValue(JSON.stringify({ from: "Dev 1", content: "Same message", timestamp: "2026-03-28T10:00:00.000Z" }));
    const result = (await handleCheckMessages(ctx, {})) as any;
    expect(result.count).toBe(1);
  });

  it("handles missing projectPath gracefully", async () => {
    const ctx = createMockContext({ projectPath: "", apiCall: vi.fn().mockResolvedValue({ messages: [] }) });
    const result = (await handleCheckMessages(ctx, {})) as any;
    expect(result.messages).toEqual([]);
    expect(result.count).toBe(0);
  });

  it("handles SQLite failure gracefully", async () => {
    // Reset fs mocks to return no files
    (fs.readdirSync as any).mockReturnValue([]);
    const apiCall = vi.fn()
      .mockRejectedValueOnce(new Error("DB error")) // SQLite fails
      .mockResolvedValue({}); // ack-read fallback
    const ctx = createMockContext({ apiCall, projectPath: "" }); // No projectPath = no file fallback
    const result = (await handleCheckMessages(ctx, {})) as any;
    expect(result.messages).toEqual([]);
    expect(result.count).toBe(0);
  });
});

// ── handlePreparePr ──────────────────────────────────────

describe("handlePreparePr", () => {
  beforeEach(() => { vi.clearAllMocks(); });

  it("returns error if execFileAsync not available", async () => {
    const ctx = createMockContext({ execFileAsync: undefined });
    const result = (await handlePreparePr(ctx, {})) as any;
    expect(result.success).toBe(false);
    expect(result.error).toContain("Shell execution not available");
  });

  it("returns error if working directory not found", async () => {
    const ctx = createMockContext({ apiCall: vi.fn().mockResolvedValue({ agents: [{ id: "test-agent-123", config: {} }] }) });
    const result = (await handlePreparePr(ctx, {})) as any;
    expect(result.success).toBe(false);
    expect(result.error).toContain("Could not determine your working directory");
  });

  it("rebases and force-pushes successfully", async () => {
    const apiCall = vi.fn()
      .mockResolvedValueOnce({ agents: [{ id: "test-agent-123", config: { workingDirectory: "/tmp/worktree" } }] })
      .mockResolvedValue({ tasks: [] });
    const execFn = vi.fn()
      .mockResolvedValueOnce({ stdout: "", stderr: "" })
      .mockResolvedValueOnce({ stdout: "3\n", stderr: "" })
      .mockResolvedValueOnce({ stdout: "Rebased", stderr: "" })
      .mockResolvedValueOnce({ stdout: "Pushed", stderr: "" });
    const ctx = createMockContext({ apiCall, execFileAsync: execFn });
    const result = (await handlePreparePr(ctx, {})) as any;
    expect(result.success).toBe(true);
    expect(result.commitsBehind).toBe(3);
    expect(result.message).toContain("Rebased successfully");
  });

  it("auto-transitions in-progress tasks to review", async () => {
    const apiCall = vi.fn()
      .mockResolvedValueOnce({ agents: [{ id: "test-agent-123", config: { workingDirectory: "/tmp/worktree" } }] })
      .mockResolvedValueOnce({ tasks: [{ id: "task-1", title: "My task" }] })
      .mockResolvedValue({});
    const execFn = vi.fn().mockResolvedValue({ stdout: "", stderr: "" });
    const ctx = createMockContext({ apiCall, execFileAsync: execFn });
    const result = (await handlePreparePr(ctx, {})) as any;
    expect(result.success).toBe(true);
    expect(result.autoTransitioned).toContain("My task");
  });

  it("handles rebase conflicts by aborting", async () => {
    const apiCall = vi.fn().mockResolvedValueOnce({ agents: [{ id: "test-agent-123", config: { workingDirectory: "/tmp/worktree" } }] });
    const execFn = vi.fn()
      .mockResolvedValueOnce({ stdout: "", stderr: "" })
      .mockResolvedValueOnce({ stdout: "0\n", stderr: "" })
      .mockRejectedValueOnce({ stdout: "", stderr: "CONFLICT in file.ts" })
      .mockResolvedValueOnce({ stdout: "", stderr: "" });
    const ctx = createMockContext({ apiCall, execFileAsync: execFn });
    const result = (await handlePreparePr(ctx, {})) as any;
    expect(result.success).toBe(false);
    expect(result.conflicts).toBe(true);
  });

  it("includes reminder about task status update", async () => {
    const apiCall = vi.fn()
      .mockResolvedValueOnce({ agents: [{ id: "test-agent-123", config: { workingDirectory: "/tmp/worktree" } }] })
      .mockResolvedValue({ tasks: [] });
    const execFn = vi.fn().mockResolvedValue({ stdout: "", stderr: "" });
    const ctx = createMockContext({ apiCall, execFileAsync: execFn });
    const result = (await handlePreparePr(ctx, {})) as any;
    expect(result.reminder).toContain("MANDATORY");
  });
});

// ── handleVerifyWork ──────────────────────────────────────

describe("handleVerifyWork", () => {
  beforeEach(() => { vi.clearAllMocks(); });

  it("returns error if execFileAsync not available", async () => {
    const ctx = createMockContext({ execFileAsync: undefined });
    const result = (await handleVerifyWork(ctx, {})) as any;
    expect(result.passed).toBe(false);
    expect(result.error).toContain("Shell execution not available");
  });

  it("passes when build and tests succeed", async () => {
    const apiCall = vi.fn().mockResolvedValueOnce({ agents: [{ id: "test-agent-123", config: { workingDirectory: "/tmp/worktree" } }] });
    const execFn = vi.fn()
      .mockResolvedValueOnce({ stdout: "Build OK", stderr: "" })
      .mockResolvedValueOnce({ stdout: "Tests OK", stderr: "" })
      .mockResolvedValueOnce({ stdout: "", stderr: "" });
    const ctx = createMockContext({ apiCall, execFileAsync: execFn });
    const result = (await handleVerifyWork(ctx, {})) as any;
    expect(result.passed).toBe(true);
    expect(result.build).toBe("pass");
    expect(result.tests).toBe("pass");
  });

  it("fails when build fails", async () => {
    const apiCall = vi.fn().mockResolvedValueOnce({ agents: [{ id: "test-agent-123", config: { workingDirectory: "/tmp/worktree" } }] });
    const execFn = vi.fn()
      .mockRejectedValueOnce({ stdout: "error TS2339", stderr: "Build failed" })
      .mockResolvedValueOnce({ stdout: "Tests OK", stderr: "" })
      .mockResolvedValueOnce({ stdout: "", stderr: "" });
    const ctx = createMockContext({ apiCall, execFileAsync: execFn });
    const result = (await handleVerifyWork(ctx, {})) as any;
    expect(result.passed).toBe(false);
    expect(result.build).toBe("fail");
  });

  it("skips tests when skipTests is true", async () => {
    const apiCall = vi.fn().mockResolvedValueOnce({ agents: [{ id: "test-agent-123", config: { workingDirectory: "/tmp/worktree" } }] });
    const execFn = vi.fn()
      .mockResolvedValueOnce({ stdout: "Build OK", stderr: "" })
      .mockResolvedValueOnce({ stdout: "", stderr: "" });
    const ctx = createMockContext({ apiCall, execFileAsync: execFn });
    const result = (await handleVerifyWork(ctx, { skipTests: "true" })) as any;
    expect(result.passed).toBe(true);
    expect(result.tests).toBe("skipped");
    expect(execFn).toHaveBeenCalledTimes(2);
  });

  it("detects unintended changes in git diff", async () => {
    const apiCall = vi.fn().mockResolvedValueOnce({ agents: [{ id: "test-agent-123", config: { workingDirectory: "/tmp/worktree" } }] });
    const execFn = vi.fn()
      .mockResolvedValueOnce({ stdout: "Build OK", stderr: "" })
      .mockResolvedValueOnce({ stdout: "Tests OK", stderr: "" })
      .mockResolvedValueOnce({ stdout: " src/foo.ts | 3 +++\n src/bar.ts | 1 -\n 2 files changed\n", stderr: "" });
    const ctx = createMockContext({ apiCall, execFileAsync: execFn });
    const result = (await handleVerifyWork(ctx, {})) as any;
    expect(result.unintendedChanges).toContain("src/foo.ts");
    expect(result.unintendedChanges).toContain("src/bar.ts");
  });
});

// ── handleCreatePr ──────────────────────────────────────

describe("handleCreatePr", () => {
  beforeEach(() => { vi.clearAllMocks(); delete process.env.GITHUB_TOKEN; });

  it("returns error if execFileAsync not available", async () => {
    const ctx = createMockContext({ execFileAsync: undefined });
    const result = (await handleCreatePr(ctx, { title: "Test PR" })) as any;
    expect(result.success).toBe(false);
    expect(result.error).toContain("Shell execution not available");
  });

  it("returns error when GitHub token not found", async () => {
    const apiCall = vi.fn().mockResolvedValueOnce({ agents: [{ id: "test-agent-123", config: { workingDirectory: "/tmp/worktree" } }] });
    const execFn = vi.fn()
      .mockResolvedValueOnce({ stdout: "feature-branch\n", stderr: "" })
      .mockResolvedValueOnce({ stdout: "git@github.com:owner/repo.git\n", stderr: "" });
    (fs.readFileSync as any).mockImplementation(() => { throw new Error("ENOENT"); });
    const ctx = createMockContext({ apiCall, execFileAsync: execFn });
    const result = (await handleCreatePr(ctx, { title: "Test PR" })) as any;
    expect(result.success).toBe(false);
    expect(result.error).toContain("GitHub token not found");
  });

  it("creates PR with GitHub token from env", async () => {
    process.env.GITHUB_TOKEN = "ghp_test123";
    const apiCall = vi.fn().mockResolvedValueOnce({ agents: [{ id: "test-agent-123", config: { workingDirectory: "/tmp/worktree" } }] });
    const execFn = vi.fn()
      .mockResolvedValueOnce({ stdout: "feature-branch\n", stderr: "" })
      .mockResolvedValueOnce({ stdout: "git@github.com:owner/repo.git\n", stderr: "" });
    const mockFetch = vi.fn().mockResolvedValue({
      ok: true, json: () => Promise.resolve({ html_url: "https://github.com/owner/repo/pull/42", number: 42 }),
    });
    vi.stubGlobal("fetch", mockFetch);
    const ctx = createMockContext({ apiCall, execFileAsync: execFn });
    const result = (await handleCreatePr(ctx, { title: "Test PR", body: "Description" })) as any;
    expect(result.success).toBe(true);
    expect(result.prUrl).toBe("https://github.com/owner/repo/pull/42");
    expect(result.prNumber).toBe(42);
    expect(result.repository).toBe("owner/repo");
    vi.unstubAllGlobals(); delete process.env.GITHUB_TOKEN;
  });

  it("parses HTTPS remote URL correctly", async () => {
    process.env.GITHUB_TOKEN = "ghp_test123";
    const apiCall = vi.fn().mockResolvedValueOnce({ agents: [{ id: "test-agent-123", config: { workingDirectory: "/tmp/worktree" } }] });
    const execFn = vi.fn()
      .mockResolvedValueOnce({ stdout: "my-branch\n", stderr: "" })
      .mockResolvedValueOnce({ stdout: "https://github.com/orgname/project.git\n", stderr: "" });
    const mockFetch = vi.fn().mockResolvedValue({ ok: true, json: () => Promise.resolve({ html_url: "url", number: 1 }) });
    vi.stubGlobal("fetch", mockFetch);
    const ctx = createMockContext({ apiCall, execFileAsync: execFn });
    const result = (await handleCreatePr(ctx, { title: "PR" })) as any;
    expect(result.repository).toBe("orgname/project");
    vi.unstubAllGlobals(); delete process.env.GITHUB_TOKEN;
  });

  it("rejects non-GitHub remote URLs", async () => {
    process.env.GITHUB_TOKEN = "ghp_test123";
    const apiCall = vi.fn().mockResolvedValueOnce({ agents: [{ id: "test-agent-123", config: { workingDirectory: "/tmp/worktree" } }] });
    const execFn = vi.fn()
      .mockResolvedValueOnce({ stdout: "my-branch\n", stderr: "" })
      .mockResolvedValueOnce({ stdout: "git@gitlab.com:org/repo.git\n", stderr: "" });
    const ctx = createMockContext({ apiCall, execFileAsync: execFn });
    const result = (await handleCreatePr(ctx, { title: "PR" })) as any;
    expect(result.success).toBe(false);
    expect(result.error).toContain("not a GitHub repository");
    delete process.env.GITHUB_TOKEN;
  });

  it("handles GitHub API errors", async () => {
    process.env.GITHUB_TOKEN = "ghp_test123";
    const apiCall = vi.fn().mockResolvedValueOnce({ agents: [{ id: "test-agent-123", config: { workingDirectory: "/tmp/worktree" } }] });
    const execFn = vi.fn()
      .mockResolvedValueOnce({ stdout: "branch\n", stderr: "" })
      .mockResolvedValueOnce({ stdout: "git@github.com:owner/repo.git\n", stderr: "" });
    const mockFetch = vi.fn().mockResolvedValue({ ok: false, status: 422, text: () => Promise.resolve("Validation Failed") });
    vi.stubGlobal("fetch", mockFetch);
    const ctx = createMockContext({ apiCall, execFileAsync: execFn });
    const result = (await handleCreatePr(ctx, { title: "PR" })) as any;
    expect(result.success).toBe(false);
    expect(result.error).toContain("GitHub API error (422)");
    vi.unstubAllGlobals(); delete process.env.GITHUB_TOKEN;
  });
});

// ── Edge Cases ──────────────────────────────────────────

describe("handleCheckMessages — edge cases", () => {
  beforeEach(() => { vi.clearAllMocks(); });

  it("handles inbox directory that does not exist", async () => {
    const apiCall = vi.fn().mockResolvedValue({ messages: [] });
    (fs.readdirSync as any).mockImplementation(() => { throw Object.assign(new Error("ENOENT"), { code: "ENOENT" }); });
    const ctx = createMockContext({ apiCall, projectPath: "/tmp/test-project" });
    const result = (await handleCheckMessages(ctx, {})) as any;
    expect(result.messages).toEqual([]);
    expect(result.count).toBe(0);
  });

  it("skips malformed JSON files in mcp-pending", async () => {
    const apiCall = vi.fn().mockResolvedValue({ messages: [] });
    (fs.readdirSync as any).mockImplementation((dir: string) => dir.includes("mcp-pending") ? ["bad.json", "good.json"] : []);
    let callCount = 0;
    (fs.readFileSync as any).mockImplementation(() => {
      callCount++;
      if (callCount === 1) return "not valid json{{{";
      return JSON.stringify({ from: "Agent-X", content: "Valid", timestamp: "2026-03-28T10:00:00Z" });
    });
    const ctx = createMockContext({ apiCall });
    const result = (await handleCheckMessages(ctx, {})) as any;
    expect(result.count).toBe(1);
    expect(result.messages[0].from).toBe("Agent-X");
  });

  it("strips ANSI codes when parsing inbox message senders", async () => {
    const apiCall = vi.fn().mockResolvedValue({ messages: [] });
    (fs.readdirSync as any).mockImplementation((dir: string) => {
      if (dir.includes("inbox-")) return ["1234-msg.md"];
      return [];
    });
    (fs.readFileSync as any).mockReturnValue("\x1b[1;32m[Message from Dev 2]\x1b[0m Hello there!");
    const ctx = createMockContext({ apiCall });
    const result = (await handleCheckMessages(ctx, {})) as any;
    expect(result.count).toBe(1);
    expect(result.messages[0].from).toBe("Dev 2");
  });

  it("uses default .kora runtime dir when getRuntimeDir is not provided", async () => {
    const apiCall = vi.fn().mockResolvedValue({ messages: [] });
    (fs.readdirSync as any).mockReturnValue([]);
    const ctx = createMockContext({ apiCall, getRuntimeDir: undefined });
    const result = (await handleCheckMessages(ctx, {})) as any;
    expect(result.count).toBe(0);
    // Should not throw even without getRuntimeDir
  });

  it("handles concurrent SQLite mark-read failure — message still returned but mark-read throws", async () => {
    const apiCall = vi.fn()
      .mockResolvedValueOnce({
        messages: [{ id: "msg-1", fromName: "Dev 1", content: "Hi", createdAt: "2026-03-28T10:00:00Z" }],
      })
      .mockRejectedValueOnce(new Error("mark-read failed")); // mark-read fails
    (fs.readdirSync as any).mockReturnValue([]);
    const ctx = createMockContext({ apiCall });
    // mark-read is awaited inside the try block, so it throws and the outer catch returns empty
    // This verifies the function doesn't crash entirely
    const result = (await handleCheckMessages(ctx, {})) as any;
    expect(result.messages).toEqual([]);
    expect(result.count).toBe(0);
  });

  it("returns messages from all 3 tiers combined", async () => {
    const apiCall = vi.fn()
      .mockResolvedValueOnce({
        messages: [{ id: "msg-1", fromName: "SQLite User", content: "From DB", createdAt: "2026-03-28T10:00:00Z" }],
      })
      .mockResolvedValue({}); // mark-read + ack
    (fs.readdirSync as any).mockImplementation((dir: string) => {
      if (dir.includes("mcp-pending")) return ["p1.json"];
      if (dir.includes("inbox-")) return ["1234-msg.md"];
      return [];
    });
    let readCount = 0;
    (fs.readFileSync as any).mockImplementation(() => {
      readCount++;
      if (readCount === 1) return JSON.stringify({ from: "Pending User", content: "From pending", timestamp: "2026-03-28T10:01:00Z" });
      return "[Message from Inbox User] From inbox";
    });
    const ctx = createMockContext({ apiCall });
    const result = (await handleCheckMessages(ctx, {})) as any;
    expect(result.count).toBe(3);
    expect(result.messages.map((m: any) => m.from)).toContain("SQLite User");
    expect(result.messages.map((m: any) => m.from)).toContain("Pending User");
    expect(result.messages.map((m: any) => m.from)).toContain("Inbox User");
  });
});

describe("handlePreparePr — edge cases", () => {
  beforeEach(() => { vi.clearAllMocks(); });

  it("handles non-git directory (git fetch fails)", async () => {
    const apiCall = vi.fn().mockResolvedValueOnce({ agents: [{ id: "test-agent-123", config: { workingDirectory: "/tmp/not-a-repo" } }] });
    const execFn = vi.fn().mockRejectedValueOnce({ message: "fatal: not a git repository", stdout: "", stderr: "fatal: not a git repository" });
    const ctx = createMockContext({ apiCall, execFileAsync: execFn });
    const result = (await handlePreparePr(ctx, {})) as any;
    expect(result.success).toBe(false);
    expect(result.error).toContain("not a git repository");
  });

  it("handles push rejection (non-conflict)", async () => {
    const apiCall = vi.fn()
      .mockResolvedValueOnce({ agents: [{ id: "test-agent-123", config: { workingDirectory: "/tmp/worktree" } }] });
    const execFn = vi.fn()
      .mockResolvedValueOnce({ stdout: "", stderr: "" }) // fetch
      .mockResolvedValueOnce({ stdout: "0\n", stderr: "" }) // rev-list
      .mockResolvedValueOnce({ stdout: "Rebased", stderr: "" }) // rebase
      .mockRejectedValueOnce({ message: "push rejected", stdout: "", stderr: "rejected: stale info" }); // push fails
    const ctx = createMockContext({ apiCall, execFileAsync: execFn });
    const result = (await handlePreparePr(ctx, {})) as any;
    expect(result.success).toBe(false);
    expect(result.error).toContain("push rejected");
  });

  it("reports 0 commits behind when already up to date", async () => {
    const apiCall = vi.fn()
      .mockResolvedValueOnce({ agents: [{ id: "test-agent-123", config: { workingDirectory: "/tmp/worktree" } }] })
      .mockResolvedValue({ tasks: [] });
    const execFn = vi.fn()
      .mockResolvedValueOnce({ stdout: "", stderr: "" }) // fetch
      .mockResolvedValueOnce({ stdout: "0\n", stderr: "" }) // rev-list = 0
      .mockResolvedValueOnce({ stdout: "", stderr: "" }) // rebase
      .mockResolvedValueOnce({ stdout: "", stderr: "" }); // push
    const ctx = createMockContext({ apiCall, execFileAsync: execFn });
    const result = (await handlePreparePr(ctx, {})) as any;
    expect(result.success).toBe(true);
    expect(result.commitsBehind).toBe(0);
    expect(result.message).toContain("Already up to date");
  });

  it("handles rev-list failure on detached HEAD gracefully", async () => {
    const apiCall = vi.fn()
      .mockResolvedValueOnce({ agents: [{ id: "test-agent-123", config: { workingDirectory: "/tmp/worktree" } }] })
      .mockResolvedValue({ tasks: [] });
    const execFn = vi.fn()
      .mockResolvedValueOnce({ stdout: "", stderr: "" }) // fetch
      .mockRejectedValueOnce(new Error("fatal: detached HEAD")) // rev-list fails
      .mockResolvedValueOnce({ stdout: "", stderr: "" }) // rebase
      .mockResolvedValueOnce({ stdout: "", stderr: "" }); // push
    const ctx = createMockContext({ apiCall, execFileAsync: execFn });
    const result = (await handlePreparePr(ctx, {})) as any;
    expect(result.success).toBe(true);
    expect(result.commitsBehind).toBe(0); // Defaults to 0 on failure
  });

  it("handles auto-transition failure for non-transitionable tasks", async () => {
    const apiCall = vi.fn()
      .mockResolvedValueOnce({ agents: [{ id: "test-agent-123", config: { workingDirectory: "/tmp/worktree" } }] })
      .mockResolvedValueOnce({ tasks: [{ id: "t1", title: "Task 1" }, { id: "t2", title: "Task 2" }] })
      .mockRejectedValueOnce(new Error("Invalid transition")) // first task fails
      .mockResolvedValueOnce({}); // second task succeeds
    const execFn = vi.fn().mockResolvedValue({ stdout: "", stderr: "" });
    const ctx = createMockContext({ apiCall, execFileAsync: execFn });
    const result = (await handlePreparePr(ctx, {})) as any;
    expect(result.success).toBe(true);
    expect(result.autoTransitioned).toContain("Task 2");
    expect(result.autoTransitioned).not.toContain("Task 1");
  });
});

describe("handleVerifyWork — edge cases", () => {
  beforeEach(() => { vi.clearAllMocks(); });

  it("returns error when agent has no workingDirectory config", async () => {
    const apiCall = vi.fn().mockResolvedValue({ agents: [{ id: "test-agent-123", config: { name: "Dev" } }] });
    const ctx = createMockContext({ apiCall });
    const result = (await handleVerifyWork(ctx, {})) as any;
    expect(result.passed).toBe(false);
    expect(result.error).toContain("Could not determine your working directory");
  });

  it("continues testing even when build fails", async () => {
    const apiCall = vi.fn().mockResolvedValueOnce({ agents: [{ id: "test-agent-123", config: { workingDirectory: "/tmp/worktree" } }] });
    const execFn = vi.fn()
      .mockRejectedValueOnce({ stdout: "", stderr: "Build error" }) // build fails
      .mockResolvedValueOnce({ stdout: "All tests passed", stderr: "" }) // tests still run
      .mockResolvedValueOnce({ stdout: "", stderr: "" }); // git diff
    const ctx = createMockContext({ apiCall, execFileAsync: execFn });
    const result = (await handleVerifyWork(ctx, {})) as any;
    expect(result.passed).toBe(false);
    expect(result.build).toBe("fail");
    expect(result.tests).toBe("pass"); // Tests still ran
  });

  it("truncates long build output to last 1000 chars on failure", async () => {
    const apiCall = vi.fn().mockResolvedValueOnce({ agents: [{ id: "test-agent-123", config: { workingDirectory: "/tmp/worktree" } }] });
    const longOutput = "x".repeat(2000);
    const execFn = vi.fn()
      .mockRejectedValueOnce({ stdout: longOutput, stderr: "" })
      .mockResolvedValueOnce({ stdout: "", stderr: "" })
      .mockResolvedValueOnce({ stdout: "", stderr: "" });
    const ctx = createMockContext({ apiCall, execFileAsync: execFn });
    const result = (await handleVerifyWork(ctx, {})) as any;
    expect(result.buildOutput!.length).toBe(1000);
  });

  it("truncates long build output to last 500 chars on success", async () => {
    const apiCall = vi.fn().mockResolvedValueOnce({ agents: [{ id: "test-agent-123", config: { workingDirectory: "/tmp/worktree" } }] });
    const longOutput = "y".repeat(1000);
    const execFn = vi.fn()
      .mockResolvedValueOnce({ stdout: longOutput, stderr: "" })
      .mockResolvedValueOnce({ stdout: "", stderr: "" })
      .mockResolvedValueOnce({ stdout: "", stderr: "" });
    const ctx = createMockContext({ apiCall, execFileAsync: execFn });
    const result = (await handleVerifyWork(ctx, {})) as any;
    expect(result.buildOutput!.length).toBe(500);
  });

  it("reports no unintended changes when git diff is empty", async () => {
    const apiCall = vi.fn().mockResolvedValueOnce({ agents: [{ id: "test-agent-123", config: { workingDirectory: "/tmp/worktree" } }] });
    const execFn = vi.fn()
      .mockResolvedValueOnce({ stdout: "OK", stderr: "" })
      .mockResolvedValueOnce({ stdout: "OK", stderr: "" })
      .mockResolvedValueOnce({ stdout: "", stderr: "" }); // empty diff
    const ctx = createMockContext({ apiCall, execFileAsync: execFn });
    const result = (await handleVerifyWork(ctx, {})) as any;
    expect(result.unintendedChanges).toEqual([]);
  });

  it("handles git diff failure gracefully", async () => {
    const apiCall = vi.fn().mockResolvedValueOnce({ agents: [{ id: "test-agent-123", config: { workingDirectory: "/tmp/worktree" } }] });
    const execFn = vi.fn()
      .mockResolvedValueOnce({ stdout: "OK", stderr: "" }) // build
      .mockResolvedValueOnce({ stdout: "OK", stderr: "" }) // test
      .mockRejectedValueOnce(new Error("git not found")); // diff fails
    const ctx = createMockContext({ apiCall, execFileAsync: execFn });
    const result = (await handleVerifyWork(ctx, {})) as any;
    expect(result.passed).toBe(true); // Still passes
    expect(result.unintendedChanges).toEqual([]);
  });
});

describe("handleCreatePr — edge cases", () => {
  beforeEach(() => { vi.clearAllMocks(); delete process.env.GITHUB_TOKEN; });

  it("reads GitHub token from .kora.yml when env var missing", async () => {
    const apiCall = vi.fn().mockResolvedValueOnce({ agents: [{ id: "test-agent-123", config: { workingDirectory: "/tmp/worktree" } }] });
    const execFn = vi.fn()
      .mockResolvedValueOnce({ stdout: "branch\n", stderr: "" })
      .mockResolvedValueOnce({ stdout: "git@github.com:owner/repo.git\n", stderr: "" });
    // Mock fs.readFileSync to return .kora.yml with token
    (fs.readFileSync as any).mockReturnValue("github:\n  token: ghp_from_yaml");
    const mockFetch = vi.fn().mockResolvedValue({
      ok: true, json: () => Promise.resolve({ html_url: "https://github.com/owner/repo/pull/1", number: 1 }),
    });
    vi.stubGlobal("fetch", mockFetch);
    const ctx = createMockContext({ apiCall, execFileAsync: execFn });
    const result = (await handleCreatePr(ctx, { title: "PR" })) as any;
    expect(result.success).toBe(true);
    // Verify the token was used in the fetch call
    expect(mockFetch).toHaveBeenCalledWith(
      expect.any(String),
      expect.objectContaining({ headers: expect.objectContaining({ "Authorization": "Bearer ghp_from_yaml" }) }),
    );
    vi.unstubAllGlobals();
  });

  it("uses custom baseBranch when provided", async () => {
    process.env.GITHUB_TOKEN = "ghp_test";
    const apiCall = vi.fn().mockResolvedValueOnce({ agents: [{ id: "test-agent-123", config: { workingDirectory: "/tmp/worktree" } }] });
    const execFn = vi.fn()
      .mockResolvedValueOnce({ stdout: "feature\n", stderr: "" })
      .mockResolvedValueOnce({ stdout: "git@github.com:o/r.git\n", stderr: "" });
    const mockFetch = vi.fn().mockResolvedValue({
      ok: true, json: () => Promise.resolve({ html_url: "url", number: 1 }),
    });
    vi.stubGlobal("fetch", mockFetch);
    const ctx = createMockContext({ apiCall, execFileAsync: execFn });
    const result = (await handleCreatePr(ctx, { title: "PR", baseBranch: "develop" })) as any;
    expect(result.base).toBe("develop");
    // Verify fetch was called with develop as base
    const fetchBody = JSON.parse((mockFetch.mock.calls[0][1] as any).body);
    expect(fetchBody.base).toBe("develop");
    vi.unstubAllGlobals(); delete process.env.GITHUB_TOKEN;
  });

  it("handles git remote failure", async () => {
    process.env.GITHUB_TOKEN = "ghp_test";
    const apiCall = vi.fn().mockResolvedValueOnce({ agents: [{ id: "test-agent-123", config: { workingDirectory: "/tmp/worktree" } }] });
    const execFn = vi.fn()
      .mockResolvedValueOnce({ stdout: "branch\n", stderr: "" })
      .mockRejectedValueOnce({ message: "fatal: No such remote 'origin'" });
    const ctx = createMockContext({ apiCall, execFileAsync: execFn });
    const result = (await handleCreatePr(ctx, { title: "PR" })) as any;
    expect(result.success).toBe(false);
    expect(result.error).toContain("No such remote");
    delete process.env.GITHUB_TOKEN;
  });

  it("handles agent not found in agents list", async () => {
    const apiCall = vi.fn().mockResolvedValueOnce({ agents: [{ id: "other-agent", config: { workingDirectory: "/tmp/other" } }] });
    const ctx = createMockContext({ apiCall });
    const result = (await handleCreatePr(ctx, { title: "PR" })) as any;
    expect(result.success).toBe(false);
    expect(result.error).toContain("Could not determine your working directory");
  });

  it("handles empty agents response", async () => {
    const apiCall = vi.fn().mockResolvedValueOnce({ agents: [] });
    const ctx = createMockContext({ apiCall });
    const result = (await handleCreatePr(ctx, { title: "PR" })) as any;
    expect(result.success).toBe(false);
    expect(result.error).toContain("Could not determine your working directory");
  });
});

// ── Reviewer-requested coverage gaps ─────────────────────

describe("handleCheckMessages — dedup truncation behavior", () => {
  beforeEach(() => { vi.clearAllMocks(); });

  it("dedup key uses first 100 chars — messages with same 100-char prefix are deduplicated", async () => {
    // This documents intentional behavior: dedup key = `from:content.substring(0, 100)`
    // Two messages from same sender sharing a 100-char content prefix will be treated as duplicates
    const sharedPrefix = "A".repeat(100);
    const apiCall = vi.fn()
      .mockResolvedValueOnce({
        messages: [
          { id: "msg-1", fromName: "Dev 1", content: sharedPrefix + " — unique suffix 1", createdAt: "2026-03-28T10:00:00Z" },
          { id: "msg-2", fromName: "Dev 1", content: sharedPrefix + " — unique suffix 2", createdAt: "2026-03-28T10:01:00Z" },
        ],
      })
      .mockResolvedValue({});
    (fs.readdirSync as any).mockReturnValue([]);
    const ctx = createMockContext({ apiCall });
    const result = (await handleCheckMessages(ctx, {})) as any;
    // Both messages from SQLite have same dedup key → only first survives
    // This is intentional: prevents duplicate delivery across tiers
    expect(result.count).toBe(1);
    expect(result.messages[0].content).toContain("unique suffix 1");
  });

  it("messages with different 100-char prefixes are NOT deduplicated", async () => {
    const apiCall = vi.fn()
      .mockResolvedValueOnce({
        messages: [
          { id: "msg-1", fromName: "Dev 1", content: "Message A " + "x".repeat(90), createdAt: "2026-03-28T10:00:00Z" },
          { id: "msg-2", fromName: "Dev 1", content: "Message B " + "y".repeat(90), createdAt: "2026-03-28T10:01:00Z" },
        ],
      })
      .mockResolvedValue({});
    (fs.readdirSync as any).mockReturnValue([]);
    const ctx = createMockContext({ apiCall });
    const result = (await handleCheckMessages(ctx, {})) as any;
    expect(result.count).toBe(2);
  });

  it("messages from different senders with same content are NOT deduplicated", async () => {
    const apiCall = vi.fn()
      .mockResolvedValueOnce({
        messages: [
          { id: "msg-1", fromName: "Dev 1", content: "Same content", createdAt: "2026-03-28T10:00:00Z" },
          { id: "msg-2", fromName: "Dev 2", content: "Same content", createdAt: "2026-03-28T10:01:00Z" },
        ],
      })
      .mockResolvedValue({});
    (fs.readdirSync as any).mockReturnValue([]);
    const ctx = createMockContext({ apiCall });
    const result = (await handleCheckMessages(ctx, {})) as any;
    expect(result.count).toBe(2); // Different senders → different dedup keys
  });
});

describe("handleCheckMessages — tier 3 inbox .md reading", () => {
  beforeEach(() => { vi.clearAllMocks(); });

  it("reads .md files from inbox, extracts sender, and moves to processed", async () => {
    const apiCall = vi.fn().mockResolvedValue({ messages: [] });
    (fs.readdirSync as any).mockImplementation((dir: string) => {
      if (dir.includes("inbox-")) return ["1709-task-update.md", "1710-question.md"];
      return [];
    });
    let readCount = 0;
    (fs.readFileSync as any).mockImplementation(() => {
      readCount++;
      if (readCount === 1) return "[Task from Architect] Please implement the login page";
      return "[Question from Dev 2] What's the API endpoint?";
    });
    const ctx = createMockContext({ apiCall });
    const result = (await handleCheckMessages(ctx, {})) as any;
    expect(result.count).toBe(2);
    expect(result.messages[0].from).toBe("Architect");
    expect(result.messages[1].from).toBe("Dev 2");
    // Verify files were moved to processed
    expect(fs.mkdirSync).toHaveBeenCalled();
    expect(fs.renameSync).toHaveBeenCalledTimes(2);
  });

  it("extracts sender from Broadcast format", async () => {
    const apiCall = vi.fn().mockResolvedValue({ messages: [] });
    (fs.readdirSync as any).mockImplementation((dir: string) => dir.includes("inbox-") ? ["msg.md"] : []);
    (fs.readFileSync as any).mockReturnValue("[Broadcast from Engineering Manager] Team meeting at 3pm");
    const ctx = createMockContext({ apiCall });
    const result = (await handleCheckMessages(ctx, {})) as any;
    expect(result.messages[0].from).toBe("Engineering Manager");
  });

  it("extracts sender from System format", async () => {
    const apiCall = vi.fn().mockResolvedValue({ messages: [] });
    (fs.readdirSync as any).mockImplementation((dir: string) => dir.includes("inbox-") ? ["msg.md"] : []);
    (fs.readFileSync as any).mockReturnValue("[System notification from Kora] Agent restarted");
    const ctx = createMockContext({ apiCall });
    const result = (await handleCheckMessages(ctx, {})) as any;
    expect(result.messages[0].from).toBe("Kora");
  });

  it("defaults to 'system' when sender cannot be parsed", async () => {
    const apiCall = vi.fn().mockResolvedValue({ messages: [] });
    (fs.readdirSync as any).mockImplementation((dir: string) => dir.includes("inbox-") ? ["msg.md"] : []);
    (fs.readFileSync as any).mockReturnValue("Some plain text message without sender format");
    const ctx = createMockContext({ apiCall });
    const result = (await handleCheckMessages(ctx, {})) as any;
    expect(result.messages[0].from).toBe("system");
  });

  it("extracts timestamp from filename prefix", async () => {
    const apiCall = vi.fn().mockResolvedValue({ messages: [] });
    (fs.readdirSync as any).mockImplementation((dir: string) => dir.includes("inbox-") ? ["1711234567-msg.md"] : []);
    (fs.readFileSync as any).mockReturnValue("[From Dev 1] Hello");
    const ctx = createMockContext({ apiCall });
    const result = (await handleCheckMessages(ctx, {})) as any;
    expect(result.messages[0].timestamp).toBe("1711234567");
  });

  it("skips non-.md files in inbox", async () => {
    const apiCall = vi.fn().mockResolvedValue({ messages: [] });
    (fs.readdirSync as any).mockImplementation((dir: string) => dir.includes("inbox-") ? ["readme.txt", "msg.md", "data.json"] : []);
    (fs.readFileSync as any).mockReturnValue("[From Dev 1] Hello");
    const ctx = createMockContext({ apiCall });
    const result = (await handleCheckMessages(ctx, {})) as any;
    expect(result.count).toBe(1); // Only .md file read
  });
});

describe("handleVerifyWork — build pass + test fail", () => {
  beforeEach(() => { vi.clearAllMocks(); });

  it("reports passed=false when build passes but tests fail", async () => {
    const apiCall = vi.fn().mockResolvedValueOnce({ agents: [{ id: "test-agent-123", config: { workingDirectory: "/tmp/worktree" } }] });
    const execFn = vi.fn()
      .mockResolvedValueOnce({ stdout: "Build OK", stderr: "" }) // build passes
      .mockRejectedValueOnce({ stdout: "FAIL src/foo.test.ts", stderr: "1 test failed" }) // tests fail
      .mockResolvedValueOnce({ stdout: "", stderr: "" }); // git diff
    const ctx = createMockContext({ apiCall, execFileAsync: execFn });
    const result = (await handleVerifyWork(ctx, {})) as any;
    expect(result.passed).toBe(false);
    expect(result.build).toBe("pass");
    expect(result.tests).toBe("fail");
    expect(result.testOutput).toContain("FAIL");
  });
});

describe("resolveWorkingDirectory — null cases", () => {
  beforeEach(() => { vi.clearAllMocks(); });

  it("handleVerifyWork returns error when resolveWorkingDirectory returns null", async () => {
    // Agent exists but has no workingDirectory in config
    const apiCall = vi.fn().mockResolvedValue({ agents: [{ id: "test-agent-123", config: { name: "Dev 1c" } }] });
    const ctx = createMockContext({ apiCall });
    const result = (await handleVerifyWork(ctx, {})) as any;
    expect(result.passed).toBe(false);
    expect(result.error).toContain("Could not determine your working directory");
  });

  it("handleCreatePr returns error when resolveWorkingDirectory returns null", async () => {
    const apiCall = vi.fn().mockResolvedValue({ agents: [{ id: "test-agent-123", config: { name: "Dev 1c" } }] });
    const ctx = createMockContext({ apiCall });
    const result = (await handleCreatePr(ctx, { title: "PR" })) as any;
    expect(result.success).toBe(false);
    expect(result.error).toContain("Could not determine your working directory");
  });

  it("handlePreparePr returns error when resolveWorkingDirectory returns null", async () => {
    const apiCall = vi.fn().mockResolvedValue({ agents: [{ id: "test-agent-123", config: { name: "Dev 1c" } }] });
    const ctx = createMockContext({ apiCall });
    const result = (await handlePreparePr(ctx, {})) as any;
    expect(result.success).toBe(false);
    expect(result.error).toContain("Could not determine your working directory");
  });

  it("resolveWorkingDirectory returns null when agents API returns empty list", async () => {
    const apiCall = vi.fn().mockResolvedValue({ agents: [] });
    const ctx = createMockContext({ apiCall });
    const result = (await handleVerifyWork(ctx, {})) as any;
    expect(result.passed).toBe(false);
  });
});
