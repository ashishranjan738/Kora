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
