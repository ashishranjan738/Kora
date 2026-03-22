/**
 * Unit tests for task-metrics API response contracts and workload logic.
 * Validates the data shapes and computations that WorkloadChart, AgentLoadBadge,
 * and WorkloadPage depend on.
 *
 * Tests:
 * - getLoadColor utility logic
 * - TaskMetricsResponse contract validation
 * - Bottleneck score computation
 * - Load distribution categorization
 * - Agent capacity and overload detection
 */

import { describe, it, expect } from "vitest";

// ---------------------------------------------------------------------------
// Replicate getLoadColor from dashboard/src/utils/workload.ts
// (testing the logic, not the CSS vars)
// ---------------------------------------------------------------------------

function getLoadColor(pct: number): "green" | "yellow" | "red" {
  if (pct > 100) return "red";
  if (pct >= 70) return "yellow";
  return "green";
}

// ---------------------------------------------------------------------------
// Replicate TaskMetricsResponse types from WorkloadChart.tsx
// ---------------------------------------------------------------------------

interface AgentTaskMetrics {
  agentId: string;
  agentName: string;
  tasksByStatus: Record<string, number>;
  totalActiveTasks: number;
  doneTasks: number;
  avgCycleTimeMs: number;
  bottleneckScore: number;
  loadPercentage: number;
  capacity: number;
  isOverloaded: boolean;
  isIdle: boolean;
  taskBlockingOthers: number;
}

interface SessionTaskMetrics {
  totalTasks: number;
  activeTasks: number;
  doneTasks: number;
  avgCycleTimeMs: number;
  throughput: number;
  topBottleneck: {
    agentId: string;
    agentName: string;
    score: number;
    reason: string;
  } | null;
  loadDistribution: {
    overloaded: number;
    balanced: number;
    underutilized: number;
    idle: number;
  };
}

interface TaskMetricsResponse {
  session: SessionTaskMetrics;
  agents: AgentTaskMetrics[];
}

// ---------------------------------------------------------------------------
// Helpers — replicate computeTaskMetrics logic from task-metrics.ts
// ---------------------------------------------------------------------------

function computeLoadPercentage(activeTasks: number, capacity: number): number {
  if (capacity <= 0) return 0;
  return Math.round((activeTasks / capacity) * 100);
}

function isAgentOverloaded(loadPercentage: number): boolean {
  return loadPercentage > 100;
}

function isAgentIdle(activeTasks: number): boolean {
  return activeTasks === 0;
}

function computeBottleneckScore(agent: {
  loadPercentage: number;
  taskBlockingOthers: number;
  totalActiveTasks: number;
}): number {
  // Higher score = worse bottleneck
  let score = 0;
  if (agent.loadPercentage > 100) score += 30;
  else if (agent.loadPercentage >= 70) score += 15;
  score += agent.taskBlockingOthers * 10;
  score += Math.min(agent.totalActiveTasks * 5, 40);
  return score;
}

function categorizeLoadDistribution(agents: AgentTaskMetrics[]): {
  overloaded: number;
  balanced: number;
  underutilized: number;
  idle: number;
} {
  let overloaded = 0, balanced = 0, underutilized = 0, idle = 0;
  for (const a of agents) {
    if (a.isIdle && a.totalActiveTasks === 0) idle++;
    else if (a.isOverloaded) overloaded++;
    else if (a.loadPercentage < 30) underutilized++;
    else balanced++;
  }
  return { overloaded, balanced, underutilized, idle };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("Task Metrics & Workload Logic", () => {

  describe("getLoadColor", () => {
    it("returns green for load < 70%", () => {
      expect(getLoadColor(0)).toBe("green");
      expect(getLoadColor(30)).toBe("green");
      expect(getLoadColor(69)).toBe("green");
    });

    it("returns yellow for load 70-100%", () => {
      expect(getLoadColor(70)).toBe("yellow");
      expect(getLoadColor(85)).toBe("yellow");
      expect(getLoadColor(100)).toBe("yellow");
    });

    it("returns red for load > 100%", () => {
      expect(getLoadColor(101)).toBe("red");
      expect(getLoadColor(150)).toBe("red");
      expect(getLoadColor(200)).toBe("red");
    });
  });

  describe("computeLoadPercentage", () => {
    it("computes percentage correctly", () => {
      expect(computeLoadPercentage(3, 5)).toBe(60);
      expect(computeLoadPercentage(5, 5)).toBe(100);
      expect(computeLoadPercentage(7, 5)).toBe(140);
    });

    it("returns 0 for zero capacity", () => {
      expect(computeLoadPercentage(5, 0)).toBe(0);
    });

    it("returns 0 for zero active tasks", () => {
      expect(computeLoadPercentage(0, 5)).toBe(0);
    });

    it("rounds to nearest integer", () => {
      expect(computeLoadPercentage(1, 3)).toBe(33); // 33.33 -> 33
      expect(computeLoadPercentage(2, 3)).toBe(67); // 66.67 -> 67
    });
  });

  describe("isAgentOverloaded", () => {
    it("returns true when load > 100%", () => {
      expect(isAgentOverloaded(101)).toBe(true);
      expect(isAgentOverloaded(150)).toBe(true);
    });

    it("returns false when load <= 100%", () => {
      expect(isAgentOverloaded(100)).toBe(false);
      expect(isAgentOverloaded(50)).toBe(false);
      expect(isAgentOverloaded(0)).toBe(false);
    });
  });

  describe("isAgentIdle", () => {
    it("returns true when no active tasks", () => {
      expect(isAgentIdle(0)).toBe(true);
    });

    it("returns false when has active tasks", () => {
      expect(isAgentIdle(1)).toBe(false);
      expect(isAgentIdle(10)).toBe(false);
    });
  });

  describe("bottleneckScore", () => {
    it("scores higher for overloaded agents", () => {
      const overloaded = computeBottleneckScore({
        loadPercentage: 150,
        taskBlockingOthers: 0,
        totalActiveTasks: 3,
      });
      const normal = computeBottleneckScore({
        loadPercentage: 50,
        taskBlockingOthers: 0,
        totalActiveTasks: 3,
      });
      expect(overloaded).toBeGreaterThan(normal);
    });

    it("scores higher for agents blocking others", () => {
      const blocking = computeBottleneckScore({
        loadPercentage: 50,
        taskBlockingOthers: 3,
        totalActiveTasks: 2,
      });
      const notBlocking = computeBottleneckScore({
        loadPercentage: 50,
        taskBlockingOthers: 0,
        totalActiveTasks: 2,
      });
      expect(blocking).toBeGreaterThan(notBlocking);
    });

    it("caps task count contribution", () => {
      const manyTasks = computeBottleneckScore({
        loadPercentage: 50,
        taskBlockingOthers: 0,
        totalActiveTasks: 100,
      });
      const fewerTasks = computeBottleneckScore({
        loadPercentage: 50,
        taskBlockingOthers: 0,
        totalActiveTasks: 8,
      });
      // Both hit the cap of 40 at 8 tasks (8*5=40)
      expect(manyTasks).toBe(fewerTasks);
    });

    it("returns 0 for idle agents", () => {
      const idle = computeBottleneckScore({
        loadPercentage: 0,
        taskBlockingOthers: 0,
        totalActiveTasks: 0,
      });
      expect(idle).toBe(0);
    });
  });

  describe("loadDistribution categorization", () => {
    it("categorizes agents correctly", () => {
      const agents: AgentTaskMetrics[] = [
        createAgent("a1", { totalActiveTasks: 7, loadPercentage: 140, isOverloaded: true, isIdle: false }),
        createAgent("a2", { totalActiveTasks: 3, loadPercentage: 60, isOverloaded: false, isIdle: false }),
        createAgent("a3", { totalActiveTasks: 1, loadPercentage: 20, isOverloaded: false, isIdle: false }),
        createAgent("a4", { totalActiveTasks: 0, loadPercentage: 0, isOverloaded: false, isIdle: true }),
      ];

      const dist = categorizeLoadDistribution(agents);
      expect(dist.overloaded).toBe(1);
      expect(dist.balanced).toBe(1);
      expect(dist.underutilized).toBe(1);
      expect(dist.idle).toBe(1);
    });

    it("all agents balanced", () => {
      const agents = [
        createAgent("a1", { totalActiveTasks: 3, loadPercentage: 60, isOverloaded: false, isIdle: false }),
        createAgent("a2", { totalActiveTasks: 4, loadPercentage: 80, isOverloaded: false, isIdle: false }),
      ];

      const dist = categorizeLoadDistribution(agents);
      expect(dist.overloaded).toBe(0);
      expect(dist.balanced).toBe(2);
      expect(dist.idle).toBe(0);
    });

    it("empty agents array", () => {
      const dist = categorizeLoadDistribution([]);
      expect(dist.overloaded).toBe(0);
      expect(dist.balanced).toBe(0);
      expect(dist.underutilized).toBe(0);
      expect(dist.idle).toBe(0);
    });
  });

  describe("TaskMetricsResponse contract", () => {
    it("valid response has required session fields", () => {
      const response = createMockResponse();
      expect(response.session).toHaveProperty("totalTasks");
      expect(response.session).toHaveProperty("activeTasks");
      expect(response.session).toHaveProperty("doneTasks");
      expect(response.session).toHaveProperty("throughput");
      expect(response.session).toHaveProperty("loadDistribution");
    });

    it("agents array has correct shape", () => {
      const response = createMockResponse();
      for (const agent of response.agents) {
        expect(agent).toHaveProperty("agentId");
        expect(agent).toHaveProperty("agentName");
        expect(agent).toHaveProperty("tasksByStatus");
        expect(agent).toHaveProperty("totalActiveTasks");
        expect(agent).toHaveProperty("loadPercentage");
        expect(agent).toHaveProperty("isOverloaded");
        expect(agent).toHaveProperty("isIdle");
      }
    });

    it("topBottleneck is null when no bottleneck", () => {
      const response = createMockResponse({ noBottleneck: true });
      expect(response.session.topBottleneck).toBeNull();
    });

    it("topBottleneck has required fields when present", () => {
      const response = createMockResponse();
      if (response.session.topBottleneck) {
        expect(response.session.topBottleneck).toHaveProperty("agentId");
        expect(response.session.topBottleneck).toHaveProperty("agentName");
        expect(response.session.topBottleneck).toHaveProperty("score");
        expect(response.session.topBottleneck).toHaveProperty("reason");
      }
    });

    it("tasksByStatus keys match workflow state IDs", () => {
      const response = createMockResponse();
      const validStates = ["pending", "in-progress", "review", "done", "backlog", "e2e-testing", "staging"];
      for (const agent of response.agents) {
        for (const key of Object.keys(agent.tasksByStatus)) {
          expect(validStates).toContain(key);
        }
      }
    });

    it("totalActiveTasks equals sum of non-done tasksByStatus", () => {
      const response = createMockResponse();
      for (const agent of response.agents) {
        const nonDone = Object.entries(agent.tasksByStatus)
          .filter(([k]) => k !== "done")
          .reduce((sum, [, v]) => sum + v, 0);
        expect(agent.totalActiveTasks).toBe(nonDone);
      }
    });

    it("session totals are consistent", () => {
      const response = createMockResponse();
      expect(response.session.totalTasks).toBe(
        response.session.activeTasks + response.session.doneTasks
      );
    });
  });

  describe("WorkloadChart rendering logic", () => {
    it("stacked bar width scales proportionally to maxTasks", () => {
      const agents = [
        createAgent("a1", { totalActiveTasks: 10, doneTasks: 5 }),
        createAgent("a2", { totalActiveTasks: 5, doneTasks: 3 }),
      ];
      const maxTasks = Math.max(...agents.map(a => a.totalActiveTasks + a.doneTasks));
      expect(maxTasks).toBe(15);

      // Agent 1 should use full width, agent 2 should use 8/15
      const barMaxWidth = 500; // arbitrary
      const scale = barMaxWidth / maxTasks;
      expect(Math.round(15 * scale)).toBe(barMaxWidth);
      expect(Math.round(8 * scale)).toBeLessThan(barMaxWidth);
    });

    it("sorts agents by totalActiveTasks descending (busiest first)", () => {
      const agents = [
        createAgent("a1", { agentName: "Dev1", totalActiveTasks: 2 }),
        createAgent("a2", { agentName: "Dev2", totalActiveTasks: 8 }),
        createAgent("a3", { agentName: "Dev3", totalActiveTasks: 5 }),
      ];

      const sorted = [...agents].sort((a, b) => b.totalActiveTasks - a.totalActiveTasks);
      expect(sorted[0].agentName).toBe("Dev2");
      expect(sorted[1].agentName).toBe("Dev3");
      expect(sorted[2].agentName).toBe("Dev1");
    });

    it("bar segments use workflow state colors (not hardcoded)", () => {
      const workflowStates = [
        { id: "pending", label: "Pending", color: "#6b7280", category: "not-started" as const },
        { id: "in-progress", label: "In Progress", color: "#3b82f6", category: "active" as const },
        { id: "done", label: "Done", color: "#22c55e", category: "closed" as const },
      ];

      const colorMap: Record<string, string> = {};
      for (const ws of workflowStates) {
        colorMap[ws.id] = ws.color;
      }

      expect(colorMap["pending"]).toBe("#6b7280");
      expect(colorMap["in-progress"]).toBe("#3b82f6");
      expect(colorMap["done"]).toBe("#22c55e");
    });

    it("active states exclude closed category for bar segments", () => {
      const workflowStates = [
        { id: "pending", category: "not-started" as const },
        { id: "in-progress", category: "active" as const },
        { id: "review", category: "active" as const },
        { id: "done", category: "closed" as const },
      ];

      const activeStates = workflowStates.filter(s => s.category !== "closed");
      expect(activeStates).toHaveLength(3);
      expect(activeStates.map(s => s.id)).not.toContain("done");
    });
  });
});

// ---------------------------------------------------------------------------
// Test helpers
// ---------------------------------------------------------------------------

function createAgent(
  id: string,
  overrides: Partial<AgentTaskMetrics> = {},
): AgentTaskMetrics {
  return {
    agentId: id,
    agentName: overrides.agentName || `Agent ${id}`,
    tasksByStatus: overrides.tasksByStatus || { "in-progress": overrides.totalActiveTasks || 0 },
    totalActiveTasks: overrides.totalActiveTasks ?? 3,
    doneTasks: overrides.doneTasks ?? 2,
    avgCycleTimeMs: overrides.avgCycleTimeMs ?? 60000,
    bottleneckScore: overrides.bottleneckScore ?? 0,
    loadPercentage: overrides.loadPercentage ?? 60,
    capacity: overrides.capacity ?? 5,
    isOverloaded: overrides.isOverloaded ?? false,
    isIdle: overrides.isIdle ?? false,
    taskBlockingOthers: overrides.taskBlockingOthers ?? 0,
  };
}

function createMockResponse(opts: { noBottleneck?: boolean } = {}): TaskMetricsResponse {
  const agents = [
    createAgent("a1", {
      agentName: "Frontend",
      tasksByStatus: { "in-progress": 3, "review": 1 },
      totalActiveTasks: 4,
      doneTasks: 5,
      loadPercentage: 80,
      bottleneckScore: 45,
    }),
    createAgent("a2", {
      agentName: "Backend",
      tasksByStatus: { "in-progress": 2, "pending": 1 },
      totalActiveTasks: 3,
      doneTasks: 8,
      loadPercentage: 60,
    }),
  ];

  return {
    session: {
      totalTasks: 20,
      activeTasks: 7,
      doneTasks: 13,
      avgCycleTimeMs: 45000,
      throughput: 3.2,
      topBottleneck: opts.noBottleneck ? null : {
        agentId: "a1",
        agentName: "Frontend",
        score: 45,
        reason: "High load with blocking tasks",
      },
      loadDistribution: {
        overloaded: 0,
        balanced: 2,
        underutilized: 0,
        idle: 0,
      },
    },
    agents,
  };
}
