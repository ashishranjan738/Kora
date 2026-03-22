/**
 * Unit tests for task metrics computation and bottleneck detection.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import {
  computeTaskMetrics,
  computeBottleneckScore,
  TaskMetricsDebouncer,
  type AgentInfo,
} from "../task-metrics.js";
import type { WorkflowState } from "@kora/shared";
import { DEFAULT_WORKFLOW_STATES } from "@kora/shared";

// ─── Mock Database ──────────────────────────────────────────────────

function createMockDb(tasks: any[]) {
  return {
    getTasks: vi.fn().mockReturnValue(tasks),
  } as any;
}

// ─── Test Data Helpers ──────────────────────────────────────────────

const now = Date.now();
const oneHourAgo = new Date(now - 60 * 60 * 1000).toISOString();
const twoHoursAgo = new Date(now - 2 * 60 * 60 * 1000).toISOString();
const thirtyMinAgo = new Date(now - 30 * 60 * 1000).toISOString();
const nowIso = new Date(now).toISOString();

function makeTask(overrides: Partial<{
  id: string;
  status: string;
  assignedTo: string | null;
  createdAt: string;
  updatedAt: string;
  dependencies: string[];
  priority: string;
}> = {}) {
  return {
    id: overrides.id ?? `task-${Math.random().toString(36).slice(2, 8)}`,
    status: overrides.status ?? "pending",
    assignedTo: overrides.assignedTo ?? null,
    createdAt: overrides.createdAt ?? oneHourAgo,
    updatedAt: overrides.updatedAt ?? nowIso,
    dependencies: overrides.dependencies ?? [],
    priority: overrides.priority ?? "P2",
  };
}

const defaultAgents: AgentInfo[] = [
  { id: "agent-1", name: "Frontend", role: "worker", activity: "working" },
  { id: "agent-2", name: "Backend", role: "worker", activity: "working" },
  { id: "agent-3", name: "Architect", role: "master", activity: "idle" },
];

// ─── Tests ──────────────────────────────────────────────────────────

describe("computeTaskMetrics", () => {
  describe("empty session", () => {
    it("returns zeros for 0 tasks and 0 agents", () => {
      const db = createMockDb([]);
      const result = computeTaskMetrics(db, "test-session", []);

      expect(result.session.totalTasks).toBe(0);
      expect(result.session.activeTasks).toBe(0);
      expect(result.session.doneTasks).toBe(0);
      expect(result.session.avgCycleTimeMs).toBe(0);
      expect(result.session.throughput).toBe(0);
      expect(result.session.topBottleneck).toBeNull();
      expect(result.session.loadDistribution).toEqual({
        overloaded: 0, balanced: 0, underutilized: 0, idle: 0,
      });
      expect(result.agents).toEqual([]);
    });

    it("returns session metrics with 0 agents but some tasks", () => {
      const tasks = [
        makeTask({ status: "pending" }),
        makeTask({ status: "done" }),
      ];
      const db = createMockDb(tasks);
      const result = computeTaskMetrics(db, "test-session", []);

      expect(result.session.totalTasks).toBe(2);
      expect(result.session.activeTasks).toBe(1);
      expect(result.session.doneTasks).toBe(1);
      expect(result.agents).toEqual([]);
    });
  });

  describe("task counting", () => {
    it("counts tasks correctly per agent by status", () => {
      const tasks = [
        makeTask({ id: "t1", status: "pending", assignedTo: "agent-1" }),
        makeTask({ id: "t2", status: "in-progress", assignedTo: "agent-1" }),
        makeTask({ id: "t3", status: "in-progress", assignedTo: "agent-1" }),
        makeTask({ id: "t4", status: "review", assignedTo: "agent-2" }),
        makeTask({ id: "t5", status: "done", assignedTo: "agent-2" }),
        makeTask({ id: "t6", status: "done", assignedTo: "agent-2" }),
      ];

      const db = createMockDb(tasks);
      const result = computeTaskMetrics(db, "s1", defaultAgents);

      // Session-level
      expect(result.session.totalTasks).toBe(6);
      expect(result.session.activeTasks).toBe(4); // pending + in-progress + review
      expect(result.session.doneTasks).toBe(2);

      // Frontend agent
      const frontend = result.agents.find(a => a.agentId === "agent-1")!;
      expect(frontend.tasksByStatus["pending"]).toBe(1);
      expect(frontend.tasksByStatus["in-progress"]).toBe(2);
      expect(frontend.totalActiveTasks).toBe(3);
      expect(frontend.doneTasks).toBe(0);

      // Backend agent
      const backend = result.agents.find(a => a.agentId === "agent-2")!;
      expect(backend.tasksByStatus["review"]).toBe(1);
      expect(backend.totalActiveTasks).toBe(1);
      expect(backend.doneTasks).toBe(2);
    });

    it("resolves tasks assigned by agent name (not ID)", () => {
      const tasks = [
        makeTask({ status: "in-progress", assignedTo: "Frontend" }),
        makeTask({ status: "review", assignedTo: "Backend" }),
      ];

      const db = createMockDb(tasks);
      const result = computeTaskMetrics(db, "s1", defaultAgents);

      const frontend = result.agents.find(a => a.agentId === "agent-1")!;
      expect(frontend.totalActiveTasks).toBe(1);

      const backend = result.agents.find(a => a.agentId === "agent-2")!;
      expect(backend.totalActiveTasks).toBe(1);
    });
  });

  describe("workflow states", () => {
    it("uses custom workflow states for tasksByStatus keys", () => {
      const customStates: WorkflowState[] = [
        { id: "backlog", label: "Backlog", color: "#888", category: "not-started" },
        { id: "dev", label: "Development", color: "#3b82f6", category: "active" },
        { id: "qa", label: "QA", color: "#f59e0b", category: "active" },
        { id: "shipped", label: "Shipped", color: "#22c55e", category: "closed" },
      ];

      const tasks = [
        makeTask({ status: "backlog", assignedTo: "agent-1" }),
        makeTask({ status: "dev", assignedTo: "agent-1" }),
        makeTask({ status: "qa", assignedTo: "agent-1" }),
        makeTask({ status: "shipped", assignedTo: "agent-1" }),
      ];

      const db = createMockDb(tasks);
      const result = computeTaskMetrics(db, "s1", defaultAgents, customStates);

      const frontend = result.agents.find(a => a.agentId === "agent-1")!;
      expect(frontend.tasksByStatus).toHaveProperty("backlog", 1);
      expect(frontend.tasksByStatus).toHaveProperty("dev", 1);
      expect(frontend.tasksByStatus).toHaveProperty("qa", 1);
      expect(frontend.tasksByStatus).toHaveProperty("shipped", 1);
      expect(frontend.totalActiveTasks).toBe(3); // backlog + dev + qa (not shipped)
      expect(frontend.doneTasks).toBe(1); // shipped
    });

    it("falls back to DEFAULT_WORKFLOW_STATES when none provided", () => {
      const tasks = [
        makeTask({ status: "pending", assignedTo: "agent-1" }),
      ];

      const db = createMockDb(tasks);
      const result = computeTaskMetrics(db, "s1", defaultAgents);

      const frontend = result.agents.find(a => a.agentId === "agent-1")!;
      expect(frontend.tasksByStatus).toHaveProperty("pending");
      expect(frontend.tasksByStatus).toHaveProperty("in-progress");
      expect(frontend.tasksByStatus).toHaveProperty("review");
      expect(frontend.tasksByStatus).toHaveProperty("done");
    });
  });

  describe("capacity and load", () => {
    it("uses role-based capacity (master=3, worker=5)", () => {
      const tasks = [
        makeTask({ status: "in-progress", assignedTo: "agent-3" }), // master
        makeTask({ status: "in-progress", assignedTo: "agent-3" }),
        makeTask({ status: "in-progress", assignedTo: "agent-3" }),
        makeTask({ status: "in-progress", assignedTo: "agent-3" }),
      ];

      const db = createMockDb(tasks);
      const result = computeTaskMetrics(db, "s1", defaultAgents);

      const architect = result.agents.find(a => a.agentId === "agent-3")!;
      expect(architect.capacity).toBe(3); // master role
      expect(architect.loadPercentage).toBe(133); // 4/3 * 100
      expect(architect.isOverloaded).toBe(true);
    });

    it("marks agent idle when no active tasks and activity is idle", () => {
      const db = createMockDb([]);
      const agents: AgentInfo[] = [
        { id: "agent-1", name: "Frontend", role: "worker", activity: "idle" },
      ];

      const result = computeTaskMetrics(db, "s1", agents);

      const frontend = result.agents.find(a => a.agentId === "agent-1")!;
      expect(frontend.isIdle).toBe(true);
      expect(frontend.loadPercentage).toBe(0);
    });

    it("does not mark agent idle if activity is working", () => {
      const db = createMockDb([]);
      const agents: AgentInfo[] = [
        { id: "agent-1", name: "Frontend", role: "worker", activity: "working" },
      ];

      const result = computeTaskMetrics(db, "s1", agents);
      expect(result.agents[0].isIdle).toBe(false);
    });
  });

  describe("load distribution", () => {
    it("categorizes agents into overloaded/balanced/underutilized/idle", () => {
      const tasks = [
        // Frontend: 6 tasks = 120% load (overloaded)
        ...Array.from({ length: 6 }, (_, i) =>
          makeTask({ id: `f${i}`, status: "in-progress", assignedTo: "agent-1" })
        ),
        // Backend: 3 tasks = 60% load (balanced)
        ...Array.from({ length: 3 }, (_, i) =>
          makeTask({ id: `b${i}`, status: "in-progress", assignedTo: "agent-2" })
        ),
        // Architect: 0 tasks (idle)
      ];

      const agents: AgentInfo[] = [
        { id: "agent-1", name: "Frontend", role: "worker", activity: "working" },
        { id: "agent-2", name: "Backend", role: "worker", activity: "working" },
        { id: "agent-3", name: "Architect", role: "master", activity: "idle" },
      ];

      const db = createMockDb(tasks);
      const result = computeTaskMetrics(db, "s1", agents);

      expect(result.session.loadDistribution.overloaded).toBe(1);  // Frontend
      expect(result.session.loadDistribution.balanced).toBe(1);    // Backend
      expect(result.session.loadDistribution.idle).toBe(1);        // Architect
    });
  });

  describe("cycle time", () => {
    it("computes average cycle time from done tasks", () => {
      // Two done tasks: one took 1 hour, one took 2 hours
      const tasks = [
        makeTask({
          id: "t1", status: "done", assignedTo: "agent-1",
          createdAt: twoHoursAgo, updatedAt: oneHourAgo, // 1 hour
        }),
        makeTask({
          id: "t2", status: "done", assignedTo: "agent-1",
          createdAt: twoHoursAgo, updatedAt: nowIso, // 2 hours
        }),
      ];

      const db = createMockDb(tasks);
      const result = computeTaskMetrics(db, "s1", defaultAgents);

      // Team avg should be ~1.5 hours = 5400000ms
      expect(result.session.avgCycleTimeMs).toBeGreaterThan(5000000);
      expect(result.session.avgCycleTimeMs).toBeLessThan(6000000);
    });

    it("returns 0 cycle time when no done tasks", () => {
      const tasks = [
        makeTask({ status: "in-progress", assignedTo: "agent-1" }),
      ];

      const db = createMockDb(tasks);
      const result = computeTaskMetrics(db, "s1", defaultAgents);
      expect(result.session.avgCycleTimeMs).toBe(0);
    });
  });

  describe("throughput", () => {
    it("calculates tasks done per hour in last 2 hours", () => {
      // 4 tasks done in the last 2 hours
      const tasks = Array.from({ length: 4 }, (_, i) =>
        makeTask({
          id: `t${i}`, status: "done", assignedTo: "agent-1",
          createdAt: twoHoursAgo, updatedAt: thirtyMinAgo,
        })
      );

      const db = createMockDb(tasks);
      const result = computeTaskMetrics(db, "s1", defaultAgents);

      expect(result.session.throughput).toBe(2); // 4 tasks / 2 hours
    });
  });

  describe("blocking detection", () => {
    it("detects when an agent's task blocks another agent's task", () => {
      const tasks = [
        makeTask({ id: "blocker", status: "in-progress", assignedTo: "agent-1" }),
        makeTask({ id: "blocked1", status: "pending", assignedTo: "agent-2", dependencies: ["blocker"] }),
        makeTask({ id: "blocked2", status: "pending", assignedTo: "agent-3", dependencies: ["blocker"] }),
      ];

      const db = createMockDb(tasks);
      const result = computeTaskMetrics(db, "s1", defaultAgents);

      const frontend = result.agents.find(a => a.agentId === "agent-1")!;
      expect(frontend.taskBlockingOthers).toBe(2);
    });

    it("does not count done dependencies as blocking", () => {
      const tasks = [
        makeTask({ id: "dep", status: "done", assignedTo: "agent-1" }),
        makeTask({ id: "dependent", status: "pending", assignedTo: "agent-2", dependencies: ["dep"] }),
      ];

      const db = createMockDb(tasks);
      const result = computeTaskMetrics(db, "s1", defaultAgents);

      const frontend = result.agents.find(a => a.agentId === "agent-1")!;
      expect(frontend.taskBlockingOthers).toBe(0);
    });
  });

  describe("top bottleneck", () => {
    it("identifies the agent with highest bottleneck score", () => {
      const tasks = [
        // Frontend: overloaded with 7 tasks and blocking others
        ...Array.from({ length: 7 }, (_, i) =>
          makeTask({ id: `f${i}`, status: "in-progress", assignedTo: "agent-1" })
        ),
        makeTask({ id: "blocked", status: "pending", assignedTo: "agent-2", dependencies: ["f0"] }),
      ];

      const db = createMockDb(tasks);
      const result = computeTaskMetrics(db, "s1", defaultAgents);

      expect(result.session.topBottleneck).not.toBeNull();
      expect(result.session.topBottleneck!.agentId).toBe("agent-1");
      expect(result.session.topBottleneck!.score).toBeGreaterThan(0);
      expect(result.session.topBottleneck!.reason).toBeTruthy();
    });

    it("returns null when no agents have bottleneck signals", () => {
      const db = createMockDb([]);
      const agents: AgentInfo[] = [
        { id: "agent-1", name: "Frontend", role: "worker", activity: "working" },
      ];

      const result = computeTaskMetrics(db, "s1", agents);
      // Agent has 0 tasks, 0 blocking, so score should be 0
      expect(result.session.topBottleneck).toBeNull();
    });
  });
});

describe("computeBottleneckScore", () => {
  it("returns 0 for no signals", () => {
    const score = computeBottleneckScore({
      blockingCount: 0,
      reviewCount: 0,
      agentAvgCycleTimeMs: 0,
      teamAvgCycleTimeMs: 0,
      oldestActiveAgeMs: 0,
      isOverloaded: false,
      isIdleWithTasks: false,
    });
    expect(score).toBe(0);
  });

  it("maxes out blocking score at 25 (5+ tasks)", () => {
    const score = computeBottleneckScore({
      blockingCount: 10,
      reviewCount: 0,
      agentAvgCycleTimeMs: 0,
      teamAvgCycleTimeMs: 0,
      oldestActiveAgeMs: 0,
      isOverloaded: false,
      isIdleWithTasks: false,
    });
    expect(score).toBe(25);
  });

  it("adds review score proportionally (max 15)", () => {
    const score = computeBottleneckScore({
      blockingCount: 0,
      reviewCount: 5,
      agentAvgCycleTimeMs: 0,
      teamAvgCycleTimeMs: 0,
      oldestActiveAgeMs: 0,
      isOverloaded: false,
      isIdleWithTasks: false,
    });
    expect(score).toBe(15);
  });

  it("adds cycle time penalty when agent is slower", () => {
    const score = computeBottleneckScore({
      blockingCount: 0,
      reviewCount: 0,
      agentAvgCycleTimeMs: 200000, // 2x team average
      teamAvgCycleTimeMs: 100000,
      oldestActiveAgeMs: 0,
      isOverloaded: false,
      isIdleWithTasks: false,
    });
    // ratio = 2, penalty = min(2-1, 1) * 20 = 20
    expect(score).toBe(20);
  });

  it("does not penalize cycle time when agent is faster", () => {
    const score = computeBottleneckScore({
      blockingCount: 0,
      reviewCount: 0,
      agentAvgCycleTimeMs: 50000,
      teamAvgCycleTimeMs: 100000,
      oldestActiveAgeMs: 0,
      isOverloaded: false,
      isIdleWithTasks: false,
    });
    expect(score).toBe(0); // faster agents get 0 penalty
  });

  it("adds overload (15) and idle-with-tasks (10) bonuses", () => {
    const score = computeBottleneckScore({
      blockingCount: 0,
      reviewCount: 0,
      agentAvgCycleTimeMs: 0,
      teamAvgCycleTimeMs: 0,
      oldestActiveAgeMs: 0,
      isOverloaded: true,
      isIdleWithTasks: true,
    });
    expect(score).toBe(25); // 15 + 10
  });

  it("caps total at 100", () => {
    const score = computeBottleneckScore({
      blockingCount: 10,  // 25
      reviewCount: 10,    // 15
      agentAvgCycleTimeMs: 500000, // 20
      teamAvgCycleTimeMs: 100000,
      oldestActiveAgeMs: 7200000,  // 15
      isOverloaded: true,  // 15
      isIdleWithTasks: true, // 10
    });
    expect(score).toBe(100);
  });

  it("scales task age proportionally (1 hour = max)", () => {
    const score30min = computeBottleneckScore({
      blockingCount: 0,
      reviewCount: 0,
      agentAvgCycleTimeMs: 0,
      teamAvgCycleTimeMs: 0,
      oldestActiveAgeMs: 30 * 60 * 1000, // 30 min
      isOverloaded: false,
      isIdleWithTasks: false,
    });
    expect(score30min).toBeCloseTo(7.5, 0); // 50% of 15

    const score1h = computeBottleneckScore({
      blockingCount: 0,
      reviewCount: 0,
      agentAvgCycleTimeMs: 0,
      teamAvgCycleTimeMs: 0,
      oldestActiveAgeMs: 60 * 60 * 1000, // 1 hour
      isOverloaded: false,
      isIdleWithTasks: false,
    });
    expect(score1h).toBe(15); // maxed out
  });
});

describe("TaskMetricsDebouncer", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("calls callback after 5 second delay", () => {
    const debouncer = new TaskMetricsDebouncer();
    const callback = vi.fn();

    debouncer.schedule("session-1", callback);
    expect(callback).not.toHaveBeenCalled();

    vi.advanceTimersByTime(5000);
    expect(callback).toHaveBeenCalledOnce();

    debouncer.clear();
  });

  it("debounces multiple calls within 5 seconds", () => {
    const debouncer = new TaskMetricsDebouncer();
    const callback1 = vi.fn();
    const callback2 = vi.fn();

    debouncer.schedule("session-1", callback1);
    vi.advanceTimersByTime(2000);
    debouncer.schedule("session-1", callback2);

    vi.advanceTimersByTime(3000);
    expect(callback1).not.toHaveBeenCalled();
    expect(callback2).not.toHaveBeenCalled();

    vi.advanceTimersByTime(2000);
    expect(callback1).not.toHaveBeenCalled();
    expect(callback2).toHaveBeenCalledOnce();

    debouncer.clear();
  });

  it("handles different sessions independently", () => {
    const debouncer = new TaskMetricsDebouncer();
    const cb1 = vi.fn();
    const cb2 = vi.fn();

    debouncer.schedule("session-1", cb1);
    debouncer.schedule("session-2", cb2);

    vi.advanceTimersByTime(5000);
    expect(cb1).toHaveBeenCalledOnce();
    expect(cb2).toHaveBeenCalledOnce();

    debouncer.clear();
  });

  it("clear() cancels all pending callbacks", () => {
    const debouncer = new TaskMetricsDebouncer();
    const callback = vi.fn();

    debouncer.schedule("session-1", callback);
    debouncer.clear();

    vi.advanceTimersByTime(10000);
    expect(callback).not.toHaveBeenCalled();
  });
});
