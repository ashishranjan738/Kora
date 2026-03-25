/**
 * Tests for AutoAssigner — Phase 0 Autonomous Orchestrator.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { AutoAssigner } from "../auto-assign.js";

function createMockConfig(overrides: any = {}) {
  const tasks = overrides.tasks || [];
  return {
    sessionId: "test-session",
    database: {
      getTasks: vi.fn().mockReturnValue(tasks),
      updateTask: vi.fn(),
      insertMessage: vi.fn(),
    },
    agentManager: {
      getAgent: vi.fn().mockReturnValue(overrides.agent || {
        id: "worker-1",
        config: { name: "Worker 1", role: "worker", terminalSession: "tmux-1", persona: "backend developer" },
        status: "running",
        activity: "idle",
      }),
      listAgents: vi.fn().mockReturnValue(overrides.agents || []),
    },
    messageQueue: {
      enqueue: vi.fn().mockReturnValue(true),
    },
    eventLog: {
      log: vi.fn().mockResolvedValue(undefined),
    },
    enabled: overrides.enabled,
  } as any;
}

describe("AutoAssigner", () => {
  describe("tryAutoAssign", () => {
    it("assigns highest priority unassigned task to idle agent", async () => {
      const config = createMockConfig({
        tasks: [
          { id: "t1", title: "Low", status: "pending", priority: "P3", assignedTo: null, dependencies: [] },
          { id: "t2", title: "Critical", status: "pending", priority: "P0", assignedTo: null, dependencies: [] },
          { id: "t3", title: "Normal", status: "pending", priority: "P2", assignedTo: null, dependencies: [] },
        ],
      });

      const assigner = new AutoAssigner(config);
      const result = await assigner.tryAutoAssign("worker-1");

      expect(result).not.toBeNull();
      expect(result!.taskId).toBe("t2"); // P0 has highest score
      expect(result!.priority).toBe("P0");
      expect(config.database.updateTask).toHaveBeenCalledWith("t2", { assignedTo: "Worker 1", status: "in-progress" });
    });

    it("skips master agents", async () => {
      const config = createMockConfig({
        agent: {
          id: "master-1",
          config: { name: "Architect", role: "master", terminalSession: "tmux-m" },
          status: "running",
        },
        tasks: [
          { id: "t1", title: "Task", status: "pending", priority: "P2", assignedTo: null, dependencies: [] },
        ],
      });

      const assigner = new AutoAssigner(config);
      const result = await assigner.tryAutoAssign("master-1");
      expect(result).toBeNull();
    });

    it("skips already-assigned tasks", async () => {
      const config = createMockConfig({
        tasks: [
          { id: "t1", title: "Assigned", status: "pending", priority: "P0", assignedTo: "other-agent", dependencies: [] },
        ],
      });

      const assigner = new AutoAssigner(config);
      const result = await assigner.tryAutoAssign("worker-1");
      expect(result).toBeNull();
    });

    it("skips tasks with unmet dependencies", async () => {
      const config = createMockConfig({
        tasks: [
          { id: "dep1", title: "Dep", status: "in-progress", priority: "P2", assignedTo: "other", dependencies: [] },
          { id: "t1", title: "Blocked", status: "pending", priority: "P0", assignedTo: null, dependencies: ["dep1"] },
        ],
      });

      const assigner = new AutoAssigner(config);
      const result = await assigner.tryAutoAssign("worker-1");
      expect(result).toBeNull();
    });

    it("assigns task with met dependencies", async () => {
      const config = createMockConfig({
        tasks: [
          { id: "dep1", title: "Done Dep", status: "done", priority: "P2", assignedTo: "other", dependencies: [] },
          { id: "t1", title: "Ready", status: "pending", priority: "P1", assignedTo: null, dependencies: ["dep1"] },
        ],
      });

      const assigner = new AutoAssigner(config);
      const result = await assigner.tryAutoAssign("worker-1");
      expect(result).not.toBeNull();
      expect(result!.taskId).toBe("t1");
    });

    it("returns null when disabled", async () => {
      const config = createMockConfig({
        enabled: false,
        tasks: [{ id: "t1", title: "Task", status: "pending", priority: "P0", assignedTo: null, dependencies: [] }],
      });

      const assigner = new AutoAssigner(config);
      const result = await assigner.tryAutoAssign("worker-1");
      expect(result).toBeNull();
    });

    it("returns null when no unassigned tasks", async () => {
      const config = createMockConfig({ tasks: [] });
      const assigner = new AutoAssigner(config);
      const result = await assigner.tryAutoAssign("worker-1");
      expect(result).toBeNull();
    });

    it("rate limits to 3 per 5 minutes", async () => {
      const config = createMockConfig({
        tasks: Array.from({ length: 10 }, (_, i) => ({
          id: `t${i}`, title: `Task ${i}`, status: "pending", priority: "P2", assignedTo: null, dependencies: [],
        })),
      });

      const assigner = new AutoAssigner(config);

      // First 3 should succeed
      expect(await assigner.tryAutoAssign("worker-1")).not.toBeNull();
      expect(await assigner.tryAutoAssign("worker-1")).not.toBeNull();
      expect(await assigner.tryAutoAssign("worker-1")).not.toBeNull();

      // 4th should be rate limited
      expect(await assigner.tryAutoAssign("worker-1")).toBeNull();
    });

    it("persists notification to SQLite for check_messages", async () => {
      const config = createMockConfig({
        tasks: [{ id: "t1", title: "Task", status: "pending", priority: "P2", assignedTo: null, dependencies: [] }],
      });

      const assigner = new AutoAssigner(config);
      await assigner.tryAutoAssign("worker-1");

      expect(config.database.insertMessage).toHaveBeenCalledWith(
        expect.objectContaining({
          toAgentId: "worker-1",
          messageType: "task-assignment",
        })
      );
    });
  });

  describe("skill-aware scoring", () => {
    it("prefers tasks matching agent skills (+50 bonus)", async () => {
      const config = createMockConfig({
        agent: {
          id: "worker-1",
          config: { name: "Frontend Dev", role: "worker", terminalSession: "tmux-1", persona: "React frontend developer", skills: ["frontend"] },
          status: "running",
          activity: "idle",
        },
        tasks: [
          { id: "t1", title: "Backend API", status: "pending", priority: "P2", assignedTo: null, dependencies: [], labels: ["backend"] },
          { id: "t2", title: "Fix CSS", status: "pending", priority: "P2", assignedTo: null, dependencies: [], labels: ["frontend"] },
        ],
      });

      const assigner = new AutoAssigner(config);
      const result = await assigner.tryAutoAssign("worker-1");

      expect(result).not.toBeNull();
      expect(result!.taskId).toBe("t2"); // frontend task matches agent skills
    });

    it("penalizes skill mismatches (-100)", async () => {
      const config = createMockConfig({
        agent: {
          id: "worker-1",
          config: { name: "Tester", role: "worker", terminalSession: "tmux-1", persona: "QA tester", skills: ["testing"] },
          status: "running",
          activity: "idle",
        },
        tasks: [
          { id: "t1", title: "Frontend bug", status: "pending", priority: "P2", assignedTo: null, dependencies: [], labels: ["frontend"] },
          { id: "t2", title: "No labels", status: "pending", priority: "P2", assignedTo: null, dependencies: [], labels: [] },
        ],
      });

      const assigner = new AutoAssigner(config);
      const result = await assigner.tryAutoAssign("worker-1");

      expect(result).not.toBeNull();
      expect(result!.taskId).toBe("t2"); // no-label task preferred over mismatched frontend task
    });
  });

  describe("checkDependencyUnblocks", () => {
    it("notifies assignee when all deps are done", async () => {
      const config = createMockConfig({
        tasks: [
          { id: "dep1", title: "Completed", status: "done", dependencies: [] },
          { id: "dep2", title: "Also Done", status: "done", dependencies: [] },
          { id: "t1", title: "Was Blocked", status: "pending", assignedTo: "worker-1", dependencies: ["dep1", "dep2"] },
        ],
        agents: [{ id: "worker-1", config: { name: "Worker 1", terminalSession: "tmux-1" }, status: "running" }],
      });
      config.agentManager.getAgent.mockReturnValue({
        id: "worker-1", config: { name: "Worker 1", terminalSession: "tmux-1" }, status: "running",
      });

      const assigner = new AutoAssigner(config);
      const count = await assigner.checkDependencyUnblocks("dep1");

      expect(count).toBe(1);
      expect(config.messageQueue.enqueue).toHaveBeenCalled();
      expect(config.eventLog.log).toHaveBeenCalledWith(
        expect.objectContaining({ type: "task-unblocked" })
      );
    });

    it("does not notify if some deps still pending", async () => {
      const config = createMockConfig({
        tasks: [
          { id: "dep1", title: "Done", status: "done", dependencies: [] },
          { id: "dep2", title: "Still WIP", status: "in-progress", dependencies: [] },
          { id: "t1", title: "Blocked", status: "pending", assignedTo: "worker-1", dependencies: ["dep1", "dep2"] },
        ],
      });

      const assigner = new AutoAssigner(config);
      const count = await assigner.checkDependencyUnblocks("dep1");

      expect(count).toBe(0);
    });

    it("returns 0 when no tasks have the completed task as dependency", async () => {
      const config = createMockConfig({
        tasks: [
          { id: "unrelated", title: "Unrelated", status: "pending", dependencies: [] },
        ],
      });

      const assigner = new AutoAssigner(config);
      const count = await assigner.checkDependencyUnblocks("some-task");
      expect(count).toBe(0);
    });
  });

  describe("setEnabled", () => {
    it("can be toggled at runtime", async () => {
      const config = createMockConfig({
        tasks: [{ id: "t1", title: "Task", status: "pending", priority: "P2", assignedTo: null, dependencies: [] }],
      });

      const assigner = new AutoAssigner(config);
      expect(assigner.isEnabled()).toBe(true);

      assigner.setEnabled(false);
      expect(assigner.isEnabled()).toBe(false);

      const result = await assigner.tryAutoAssign("worker-1");
      expect(result).toBeNull();
    });
  });
});
