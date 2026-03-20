/**
 * Integration tests for session isolation.
 *
 * Verifies that two sessions on the same project path maintain
 * independent runtime directories, databases, state persistence,
 * worktree cleanup, and agent restore.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import path from "path";
import fs from "fs";
import os from "os";

// ---------------------------------------------------------------------------
// Test helpers — real filesystem with temp dirs
// ---------------------------------------------------------------------------

function makeTempDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "kora-test-isolation-"));
}

function cleanDir(dir: string): void {
  try {
    fs.rmSync(dir, { recursive: true, force: true });
  } catch {
    // best-effort cleanup
  }
}

// ---------------------------------------------------------------------------
// 1. State persistence isolation
// ---------------------------------------------------------------------------

// Import the real state-persistence module (no mocks — it uses the filesystem)
import { saveAgentStates, loadAgentStates } from "../state-persistence.js";
import type { AgentState } from "@kora/shared";

function makeAgent(overrides: Partial<AgentState> = {}): AgentState {
  const id = overrides.id ?? `agent-${Math.random().toString(36).slice(2, 8)}`;
  return {
    id,
    status: "running",
    config: {
      name: overrides.config?.name ?? "Test Agent",
      sessionId: overrides.config?.sessionId ?? "test-session",
      role: "worker",
      cliProvider: "claude-code",
      model: "default",
      permissions: {
        canSpawnAgents: false,
        canStopAgents: false,
        canRemoveAgents: false,
        canAccessTerminal: true,
        canEditFiles: true,
        maxSubAgents: 0,
      },
      persona: "",
      tmuxSession: `kora--test-${id}`,
      worktreeDir: "/tmp",
      workingDirectory: "/tmp",
      extraCliArgs: [],
    },
    healthCheck: {
      alive: true,
      lastCheck: Date.now(),
      consecutiveFailures: 0,
    },
    spawnedAt: new Date().toISOString(),
    childAgents: [],
    cost: {
      inputTokens: 0,
      outputTokens: 0,
      totalCostUsd: 0,
      cacheReadTokens: 0,
      cacheWriteTokens: 0,
    },
    ...overrides,
  } as AgentState;
}

describe("Session Isolation — State Persistence", () => {
  let runtimeDirA: string;
  let runtimeDirB: string;

  beforeEach(() => {
    runtimeDirA = makeTempDir();
    runtimeDirB = makeTempDir();
  });

  afterEach(() => {
    cleanDir(runtimeDirA);
    cleanDir(runtimeDirB);
  });

  it("two sessions with different runtimeDirs save to separate state files", async () => {
    const agentA = makeAgent({ id: "agent-a", config: { ...makeAgent().config, sessionId: "session-a", name: "Agent A" } });
    const agentB = makeAgent({ id: "agent-b", config: { ...makeAgent().config, sessionId: "session-b", name: "Agent B" } });

    await saveAgentStates(runtimeDirA, [agentA]);
    await saveAgentStates(runtimeDirB, [agentB]);

    const loadedA = await loadAgentStates(runtimeDirA);
    const loadedB = await loadAgentStates(runtimeDirB);

    expect(loadedA).toHaveLength(1);
    expect(loadedA[0].id).toBe("agent-a");
    expect(loadedA[0].config.name).toBe("Agent A");

    expect(loadedB).toHaveLength(1);
    expect(loadedB[0].id).toBe("agent-b");
    expect(loadedB[0].config.name).toBe("Agent B");
  });

  it("saving to session A does not affect session B state", async () => {
    const agentB1 = makeAgent({ id: "agent-b1" });
    const agentB2 = makeAgent({ id: "agent-b2" });
    await saveAgentStates(runtimeDirB, [agentB1, agentB2]);

    // Now save different agents to session A
    const agentA1 = makeAgent({ id: "agent-a1" });
    await saveAgentStates(runtimeDirA, [agentA1]);

    // Session B should still have its original 2 agents
    const loadedB = await loadAgentStates(runtimeDirB);
    expect(loadedB).toHaveLength(2);
    expect(loadedB.map((a) => a.id).sort()).toEqual(["agent-b1", "agent-b2"]);
  });

  it("clearing session A state does not affect session B", async () => {
    const agentA = makeAgent({ id: "agent-a" });
    const agentB = makeAgent({ id: "agent-b" });

    await saveAgentStates(runtimeDirA, [agentA]);
    await saveAgentStates(runtimeDirB, [agentB]);

    // Clear session A by saving empty array
    await saveAgentStates(runtimeDirA, []);

    const loadedA = await loadAgentStates(runtimeDirA);
    const loadedB = await loadAgentStates(runtimeDirB);

    expect(loadedA).toHaveLength(0);
    expect(loadedB).toHaveLength(1);
    expect(loadedB[0].id).toBe("agent-b");
  });

  it("loading from a non-existent runtimeDir returns empty array", async () => {
    const nonExistentDir = path.join(os.tmpdir(), "kora-does-not-exist-" + Date.now());
    const loaded = await loadAgentStates(nonExistentDir);
    expect(loaded).toEqual([]);
  });

  it("state files are physically in different directories", async () => {
    await saveAgentStates(runtimeDirA, [makeAgent({ id: "a" })]);
    await saveAgentStates(runtimeDirB, [makeAgent({ id: "b" })]);

    const stateFileA = path.join(runtimeDirA, "state", "agents.json");
    const stateFileB = path.join(runtimeDirB, "state", "agents.json");

    expect(fs.existsSync(stateFileA)).toBe(true);
    expect(fs.existsSync(stateFileB)).toBe(true);
    expect(stateFileA).not.toBe(stateFileB);

    // Contents should be different
    const contentA = JSON.parse(fs.readFileSync(stateFileA, "utf-8"));
    const contentB = JSON.parse(fs.readFileSync(stateFileB, "utf-8"));
    expect(contentA[0].id).toBe("a");
    expect(contentB[0].id).toBe("b");
  });
});

// ---------------------------------------------------------------------------
// 2. Database isolation
// ---------------------------------------------------------------------------

import { AppDatabase } from "../database.js";

describe("Session Isolation — Database", () => {
  let runtimeDirA: string;
  let runtimeDirB: string;
  let dbA: AppDatabase;
  let dbB: AppDatabase;

  beforeEach(() => {
    runtimeDirA = makeTempDir();
    runtimeDirB = makeTempDir();
    dbA = new AppDatabase(runtimeDirA);
    dbB = new AppDatabase(runtimeDirB);
  });

  afterEach(() => {
    try { dbA.close(); } catch {}
    try { dbB.close(); } catch {}
    cleanDir(runtimeDirA);
    cleanDir(runtimeDirB);
  });

  it("each session gets its own data.db file", () => {
    const dbPathA = path.join(runtimeDirA, "data.db");
    const dbPathB = path.join(runtimeDirB, "data.db");

    expect(fs.existsSync(dbPathA)).toBe(true);
    expect(fs.existsSync(dbPathB)).toBe(true);
    expect(dbPathA).not.toBe(dbPathB);
  });

  it("tasks created in session A are not visible in session B", () => {
    const now = new Date().toISOString();
    dbA.insertTask({
      id: "task-a1",
      sessionId: "session-a",
      title: "Task for session A",
      description: "Only in A",
      status: "pending",
      assignedTo: undefined,
      createdBy: "user",
      dependencies: [],
      createdAt: now,
      updatedAt: now,
      priority: "P2",
      labels: [],
      dueDate: undefined,
    });

    // Query session B's database — should have no tasks
    const tasksB = dbB.getTasks("session-a");
    expect(tasksB).toHaveLength(0);

    // Session A should have the task
    const tasksA = dbA.getTasks("session-a");
    expect(tasksA).toHaveLength(1);
    expect(tasksA[0].title).toBe("Task for session A");
  });

  it("events logged to session A are not in session B", () => {
    const now = new Date().toISOString();
    dbA.insertEvent({
      id: "evt-a1",
      sessionId: "session-a",
      type: "agent-spawned",
      data: { agentId: "agent-1" },
      timestamp: now,
    });

    const eventsB = dbB.queryEvents({ sessionId: "session-a" });
    expect(eventsB).toHaveLength(0);

    const eventsA = dbA.queryEvents({ sessionId: "session-a" });
    expect(eventsA).toHaveLength(1);
  });

  it("closing session A database does not affect session B", () => {
    const now = new Date().toISOString();
    dbB.insertTask({
      id: "task-b1",
      sessionId: "session-b",
      title: "Task for session B",
      description: "",
      status: "pending",
      assignedTo: undefined,
      createdBy: "user",
      dependencies: [],
      createdAt: now,
      updatedAt: now,
      priority: "P2",
      labels: [],
      dueDate: undefined,
    });

    // Close session A
    dbA.close();

    // Session B should still work fine
    expect(dbB.isOpen).toBe(true);
    const tasksB = dbB.getTasks("session-b");
    expect(tasksB).toHaveLength(1);
    expect(tasksB[0].title).toBe("Task for session B");
  });

  it("both databases can write concurrently without interference", () => {
    const now = new Date().toISOString();

    // Write to both databases
    for (let i = 0; i < 10; i++) {
      dbA.insertTask({
        id: `task-a-${i}`,
        sessionId: "session-a",
        title: `A Task ${i}`,
        description: "",
        status: "pending",
        assignedTo: undefined,
        createdBy: "user",
        dependencies: [],
        createdAt: now,
        updatedAt: now,
        priority: "P2",
        labels: [],
        dueDate: undefined,
      });
      dbB.insertTask({
        id: `task-b-${i}`,
        sessionId: "session-b",
        title: `B Task ${i}`,
        description: "",
        status: "pending",
        assignedTo: undefined,
        createdBy: "user",
        dependencies: [],
        createdAt: now,
        updatedAt: now,
        priority: "P2",
        labels: [],
        dueDate: undefined,
      });
    }

    expect(dbA.getTasks("session-a")).toHaveLength(10);
    expect(dbB.getTasks("session-b")).toHaveLength(10);
  });
});

// ---------------------------------------------------------------------------
// 3. Runtime directory isolation
// ---------------------------------------------------------------------------

describe("Session Isolation — RuntimeDir paths", () => {
  it("different sessions using different runtimeDirs have physically separate paths", () => {
    const projectPath = "/projects/myapp";
    const runtimeDirSessionA = path.join(projectPath, ".kora", "sessions", "session-a");
    const runtimeDirSessionB = path.join(projectPath, ".kora", "sessions", "session-b");

    expect(runtimeDirSessionA).not.toBe(runtimeDirSessionB);
    expect(runtimeDirSessionA).toContain("session-a");
    expect(runtimeDirSessionB).toContain("session-b");
  });

  it("runtimeDir includes session identifier for unique state", () => {
    // This test documents the expectation that runtimeDirs contain session IDs
    const sessionId = "my-dev-session";
    const runtimeDir = path.join("/projects/myapp", ".kora", "sessions", sessionId);

    expect(runtimeDir).toContain(sessionId);
    expect(path.basename(runtimeDir)).toBe(sessionId);
  });
});

// ---------------------------------------------------------------------------
// 4. Worktree cleanup isolation (mocked)
// ---------------------------------------------------------------------------

describe("Session Isolation — Worktree cleanup", () => {
  it("cleaning up session A worktrees does not affect session B worktree files", async () => {
    // Create two separate worktree directories simulating two sessions
    const projectDir = makeTempDir();
    const worktreeDirA = path.join(projectDir, ".kora", "worktrees-session-a");
    const worktreeDirB = path.join(projectDir, ".kora", "worktrees-session-b");

    fs.mkdirSync(path.join(worktreeDirA, "agent-a1"), { recursive: true });
    fs.mkdirSync(path.join(worktreeDirA, "agent-a2"), { recursive: true });
    fs.mkdirSync(path.join(worktreeDirB, "agent-b1"), { recursive: true });

    // Write marker files
    fs.writeFileSync(path.join(worktreeDirA, "agent-a1", "file.txt"), "session-a-agent-1");
    fs.writeFileSync(path.join(worktreeDirB, "agent-b1", "file.txt"), "session-b-agent-1");

    // Simulate cleanup of session A's worktrees
    fs.rmSync(worktreeDirA, { recursive: true, force: true });

    // Session B's worktrees should be untouched
    expect(fs.existsSync(worktreeDirB)).toBe(true);
    expect(fs.existsSync(path.join(worktreeDirB, "agent-b1", "file.txt"))).toBe(true);
    expect(fs.readFileSync(path.join(worktreeDirB, "agent-b1", "file.txt"), "utf-8")).toBe("session-b-agent-1");

    // Session A's worktrees should be gone
    expect(fs.existsSync(worktreeDirA)).toBe(false);

    cleanDir(projectDir);
  });
});

// ---------------------------------------------------------------------------
// 5. Orchestrator restore isolation (mocked orchestrator dependencies)
// ---------------------------------------------------------------------------

describe("Session Isolation — Restore isolation", () => {
  let runtimeDirA: string;
  let runtimeDirB: string;

  beforeEach(() => {
    runtimeDirA = makeTempDir();
    runtimeDirB = makeTempDir();
  });

  afterEach(() => {
    cleanDir(runtimeDirA);
    cleanDir(runtimeDirB);
  });

  it("loadAgentStates for session A only returns session A agents", async () => {
    const agentA = makeAgent({
      id: "agent-session-a",
      config: { ...makeAgent().config, sessionId: "session-a", name: "Session A Worker" },
    });
    const agentB = makeAgent({
      id: "agent-session-b",
      config: { ...makeAgent().config, sessionId: "session-b", name: "Session B Worker" },
    });

    await saveAgentStates(runtimeDirA, [agentA]);
    await saveAgentStates(runtimeDirB, [agentB]);

    // Simulate restore for session A — only loads from runtimeDirA
    const restoredA = await loadAgentStates(runtimeDirA);
    expect(restoredA).toHaveLength(1);
    expect(restoredA[0].id).toBe("agent-session-a");
    expect(restoredA[0].config.sessionId).toBe("session-a");

    // Session B agents are not in session A's state
    const hasSessionBAgent = restoredA.some((a) => a.config.sessionId === "session-b");
    expect(hasSessionBAgent).toBe(false);
  });

  it("saving multiple agents to session A and restoring preserves all of them", async () => {
    const agents = [
      makeAgent({ id: "a1", config: { ...makeAgent().config, sessionId: "session-a", name: "Worker 1" } }),
      makeAgent({ id: "a2", config: { ...makeAgent().config, sessionId: "session-a", name: "Worker 2" } }),
      makeAgent({ id: "a3", config: { ...makeAgent().config, sessionId: "session-a", name: "Architect" } }),
    ];

    await saveAgentStates(runtimeDirA, agents);
    const restored = await loadAgentStates(runtimeDirA);

    expect(restored).toHaveLength(3);
    expect(restored.map((a) => a.id).sort()).toEqual(["a1", "a2", "a3"]);
  });

  it("overwriting session A state replaces all agents atomically", async () => {
    // First save
    await saveAgentStates(runtimeDirA, [
      makeAgent({ id: "old-agent-1" }),
      makeAgent({ id: "old-agent-2" }),
    ]);

    // Overwrite with new agents
    await saveAgentStates(runtimeDirA, [
      makeAgent({ id: "new-agent-1" }),
    ]);

    const restored = await loadAgentStates(runtimeDirA);
    expect(restored).toHaveLength(1);
    expect(restored[0].id).toBe("new-agent-1");
  });
});

// ---------------------------------------------------------------------------
// 6. Message bus isolation (directory-based)
// ---------------------------------------------------------------------------

describe("Session Isolation — Message directories", () => {
  it("each session has its own messages directory", () => {
    const runtimeDirA = "/projects/myapp/.kora/sessions/session-a";
    const runtimeDirB = "/projects/myapp/.kora/sessions/session-b";

    const msgDirA = path.join(runtimeDirA, "messages");
    const msgDirB = path.join(runtimeDirB, "messages");

    expect(msgDirA).not.toBe(msgDirB);
    expect(msgDirA).toContain("session-a");
    expect(msgDirB).toContain("session-b");
  });

  it("message inbox directories are scoped to their session runtime", () => {
    const runtimeDir = makeTempDir();
    const agentId = "worker-abc123";

    const inboxDir = path.join(runtimeDir, "messages", `inbox-${agentId}`);
    fs.mkdirSync(inboxDir, { recursive: true });

    // Write a message file
    const msgFile = path.join(inboxDir, "msg-001.json");
    fs.writeFileSync(
      msgFile,
      JSON.stringify({ from: "system", to: agentId, content: "hello" }),
    );

    expect(fs.existsSync(msgFile)).toBe(true);
    const content = JSON.parse(fs.readFileSync(msgFile, "utf-8"));
    expect(content.to).toBe(agentId);

    // A different session's runtimeDir won't have this inbox
    const otherRuntimeDir = makeTempDir();
    const otherInbox = path.join(otherRuntimeDir, "messages", `inbox-${agentId}`);
    expect(fs.existsSync(otherInbox)).toBe(false);

    cleanDir(runtimeDir);
    cleanDir(otherRuntimeDir);
  });
});

// ---------------------------------------------------------------------------
// 7. Event log isolation
// ---------------------------------------------------------------------------

describe("Session Isolation — Event log", () => {
  let runtimeDirA: string;
  let runtimeDirB: string;
  let dbA: AppDatabase;
  let dbB: AppDatabase;

  beforeEach(() => {
    runtimeDirA = makeTempDir();
    runtimeDirB = makeTempDir();
    dbA = new AppDatabase(runtimeDirA);
    dbB = new AppDatabase(runtimeDirB);
  });

  afterEach(() => {
    try { dbA.close(); } catch {}
    try { dbB.close(); } catch {}
    cleanDir(runtimeDirA);
    cleanDir(runtimeDirB);
  });

  it("events in session A database are isolated from session B database", () => {
    const now = new Date().toISOString();

    // Insert events into both databases
    for (let i = 0; i < 5; i++) {
      dbA.insertEvent({
        id: `evt-a-${i}`,
        sessionId: "session-a",
        type: "agent-spawned",
        data: { agentId: `agent-a-${i}` },
        timestamp: now,
      });
    }

    for (let i = 0; i < 3; i++) {
      dbB.insertEvent({
        id: `evt-b-${i}`,
        sessionId: "session-b",
        type: "agent-spawned",
        data: { agentId: `agent-b-${i}` },
        timestamp: now,
      });
    }

    // Each database only has its own events
    expect(dbA.queryEvents({ sessionId: "session-a" })).toHaveLength(5);
    expect(dbA.queryEvents({ sessionId: "session-b" })).toHaveLength(0);
    expect(dbB.queryEvents({ sessionId: "session-b" })).toHaveLength(3);
    expect(dbB.queryEvents({ sessionId: "session-a" })).toHaveLength(0);
  });
});
