/**
 * Task metrics computation for workload visualization and bottleneck detection.
 *
 * Computes per-agent task distribution, cycle times, bottleneck scores,
 * and session-level aggregates. All data comes from the SQLite tasks table.
 */

import type { AppDatabase } from "./database.js";
import type { WorkflowState } from "@kora/shared";
import { DEFAULT_WORKFLOW_STATES } from "@kora/shared";
import type {
  AgentTaskMetrics,
  SessionTaskMetrics,
  TaskMetricsResponse,
} from "@kora/shared";

/** Agent info needed for metrics computation */
export interface AgentInfo {
  id: string;
  name: string;
  role: "master" | "worker" | string;
  activity: string; // "idle" | "working" | etc.
}

/** Default capacity limits by role */
const CAPACITY_BY_ROLE: Record<string, number> = {
  master: 3,
  worker: 5,
  reviewer: 3,
};
const DEFAULT_CAPACITY = 5;

/**
 * Compute task metrics for all agents in a session.
 *
 * @param db - Session database
 * @param sessionId - Session ID
 * @param agents - Active agents in the session
 * @param workflowStates - Session's workflow states (for dynamic status keys)
 */
export function computeTaskMetrics(
  db: AppDatabase,
  sessionId: string,
  agents: AgentInfo[],
  workflowStates?: WorkflowState[],
): TaskMetricsResponse {
  const states = workflowStates || DEFAULT_WORKFLOW_STATES;
  const closedStateIds = new Set(states.filter(s => s.category === "closed").map(s => s.id));
  const activeStateIds = new Set(
    states.filter(s => s.category === "active" || s.category === "not-started").map(s => s.id)
  );

  // Fetch all tasks for this session
  const allTasks = db.getTasks(sessionId) as Array<{
    id: string;
    status: string;
    assignedTo: string | null;
    createdAt: string;
    updatedAt: string;
    dependencies?: string[];
    priority?: string;
  }>;

  if (allTasks.length === 0 && agents.length === 0) {
    return emptyMetrics();
  }

  // Build lookup: taskId -> task
  const taskById = new Map(allTasks.map(t => [t.id, t]));

  // Partition tasks
  const doneTasks = allTasks.filter(t => closedStateIds.has(t.status));
  const activeTasks = allTasks.filter(t => !closedStateIds.has(t.status));

  // Cycle time for done tasks: updated_at - created_at
  const cycleTimesMs = doneTasks.map(t => {
    const created = new Date(t.createdAt).getTime();
    const updated = new Date(t.updatedAt).getTime();
    return updated - created;
  }).filter(ms => ms >= 0);

  const teamAvgCycleTimeMs = cycleTimesMs.length > 0
    ? cycleTimesMs.reduce((a, b) => a + b, 0) / cycleTimesMs.length
    : 0;

  // Throughput: done tasks per hour in the last 2 hours
  const twoHoursAgo = Date.now() - 2 * 60 * 60 * 1000;
  const recentDoneTasks = doneTasks.filter(t => new Date(t.updatedAt).getTime() >= twoHoursAgo);
  const throughput = recentDoneTasks.length / 2; // per hour

  // Compute blocking: which tasks have unmet dependencies
  const blockingByAgent = computeBlocking(allTasks, taskById, closedStateIds);

  // Per-agent metrics
  const agentMetrics: AgentTaskMetrics[] = [];

  for (const agent of agents) {
    // Tasks assigned to this agent (by ID or name)
    const agentTasks = allTasks.filter(t =>
      t.assignedTo === agent.id || t.assignedTo === agent.name
    );

    // Count by status (using workflow states)
    const tasksByStatus: Record<string, number> = {};
    for (const state of states) {
      tasksByStatus[state.id] = 0;
    }
    for (const t of agentTasks) {
      if (tasksByStatus[t.status] !== undefined) {
        tasksByStatus[t.status]++;
      } else {
        // Unknown status (shouldn't happen with workflow enforcement)
        tasksByStatus[t.status] = (tasksByStatus[t.status] || 0) + 1;
      }
    }

    const agentActiveTasks = agentTasks.filter(t => !closedStateIds.has(t.status));
    const agentDoneTasks = agentTasks.filter(t => closedStateIds.has(t.status));

    // Agent-specific cycle time
    const agentCycleTimes = agentDoneTasks.map(t => {
      const created = new Date(t.createdAt).getTime();
      const updated = new Date(t.updatedAt).getTime();
      return updated - created;
    }).filter(ms => ms >= 0);

    const agentAvgCycleTimeMs = agentCycleTimes.length > 0
      ? agentCycleTimes.reduce((a, b) => a + b, 0) / agentCycleTimes.length
      : 0;

    const capacity = CAPACITY_BY_ROLE[agent.role] || DEFAULT_CAPACITY;
    const loadPercentage = capacity > 0
      ? Math.round((agentActiveTasks.length / capacity) * 100)
      : 0;

    const blockingCount = blockingByAgent.get(agent.id) || blockingByAgent.get(agent.name) || 0;

    // Count review tasks (any "active" category status that contains "review")
    const reviewStates = states.filter(s => s.category === "active" && s.id.includes("review")).map(s => s.id);
    const reviewCount = agentTasks.filter(t => reviewStates.includes(t.status)).length;

    // Oldest active task age
    const oldestActiveAgeMs = agentActiveTasks.length > 0
      ? Math.max(...agentActiveTasks.map(t => Date.now() - new Date(t.createdAt).getTime()))
      : 0;

    // Bottleneck score computation
    const bottleneckScore = computeBottleneckScore({
      blockingCount,
      reviewCount,
      agentAvgCycleTimeMs,
      teamAvgCycleTimeMs,
      oldestActiveAgeMs,
      isOverloaded: loadPercentage > 100,
      isIdleWithTasks: agent.activity === "idle" && agentActiveTasks.length > 0,
    });

    agentMetrics.push({
      agentId: agent.id,
      agentName: agent.name,
      tasksByStatus,
      totalActiveTasks: agentActiveTasks.length,
      doneTasks: agentDoneTasks.length,
      avgCycleTimeMs: Math.round(agentAvgCycleTimeMs),
      bottleneckScore: Math.round(bottleneckScore),
      loadPercentage,
      capacity,
      isOverloaded: loadPercentage > 100,
      isIdle: agentActiveTasks.length === 0 && agent.activity === "idle",
      taskBlockingOthers: blockingCount,
    });
  }

  // Find top bottleneck
  const topBottleneck = findTopBottleneck(agentMetrics, teamAvgCycleTimeMs);

  // Load distribution
  const loadDistribution = {
    overloaded: agentMetrics.filter(a => a.isOverloaded).length,
    balanced: agentMetrics.filter(a => !a.isOverloaded && !a.isIdle && a.loadPercentage >= 30).length,
    underutilized: agentMetrics.filter(a => !a.isIdle && a.loadPercentage > 0 && a.loadPercentage < 30).length,
    idle: agentMetrics.filter(a => a.isIdle).length,
  };

  return {
    session: {
      totalTasks: allTasks.length,
      activeTasks: activeTasks.length,
      doneTasks: doneTasks.length,
      avgCycleTimeMs: Math.round(teamAvgCycleTimeMs),
      throughput: Math.round(throughput * 10) / 10, // 1 decimal place
      topBottleneck,
      loadDistribution,
    },
    agents: agentMetrics,
  };
}

/** Empty response for sessions with 0 tasks and 0 agents */
function emptyMetrics(): TaskMetricsResponse {
  return {
    session: {
      totalTasks: 0,
      activeTasks: 0,
      doneTasks: 0,
      avgCycleTimeMs: 0,
      throughput: 0,
      topBottleneck: null,
      loadDistribution: { overloaded: 0, balanced: 0, underutilized: 0, idle: 0 },
    },
    agents: [],
  };
}

/**
 * Compute how many tasks each agent is blocking.
 * A task is "blocked" if it has a dependency that isn't done yet.
 * The blocking agent is the one assigned to the not-done dependency.
 */
function computeBlocking(
  allTasks: Array<{ id: string; status: string; assignedTo: string | null; dependencies?: string[] }>,
  taskById: Map<string, { id: string; status: string; assignedTo: string | null }>,
  closedStateIds: Set<string>,
): Map<string, number> {
  const blocking = new Map<string, number>();

  for (const task of allTasks) {
    if (!task.dependencies || task.dependencies.length === 0) continue;
    if (closedStateIds.has(task.status)) continue; // done tasks aren't blocked

    for (const depId of task.dependencies) {
      const depTask = taskById.get(depId);
      if (!depTask) continue;
      if (closedStateIds.has(depTask.status)) continue; // dep is done, not blocking

      // The agent assigned to the dep is blocking this task
      const blockingAgent = depTask.assignedTo;
      if (blockingAgent) {
        blocking.set(blockingAgent, (blocking.get(blockingAgent) || 0) + 1);
      }
    }
  }

  return blocking;
}

/**
 * Compute raw bottleneck score for a single agent.
 * Weighted sum of factors, capped at 100.
 */
export function computeBottleneckScore(params: {
  blockingCount: number;
  reviewCount: number;
  agentAvgCycleTimeMs: number;
  teamAvgCycleTimeMs: number;
  oldestActiveAgeMs: number;
  isOverloaded: boolean;
  isIdleWithTasks: boolean;
}): number {
  const {
    blockingCount,
    reviewCount,
    agentAvgCycleTimeMs,
    teamAvgCycleTimeMs,
    oldestActiveAgeMs,
    isOverloaded,
    isIdleWithTasks,
  } = params;

  // (1) Blocking others: 25 weight, scale by count (cap at 5 for max score)
  const blockingScore = Math.min(blockingCount / 5, 1) * 25;

  // (2) Review queue: 15 weight, scale by count (cap at 5)
  const reviewScore = Math.min(reviewCount / 5, 1) * 15;

  // (3) Relative cycle time: 20 weight
  let cycleTimeScore = 0;
  if (teamAvgCycleTimeMs > 0 && agentAvgCycleTimeMs > 0) {
    const ratio = agentAvgCycleTimeMs / teamAvgCycleTimeMs;
    cycleTimeScore = Math.min(ratio - 1, 1) * 20; // only penalize if slower
    if (cycleTimeScore < 0) cycleTimeScore = 0;
  }

  // (4) Task age: 15 weight, scale by age (1 hour = max)
  const ONE_HOUR_MS = 60 * 60 * 1000;
  const ageScore = Math.min(oldestActiveAgeMs / ONE_HOUR_MS, 1) * 15;

  // (5) Overloaded: 15 weight (binary)
  const overloadScore = isOverloaded ? 15 : 0;

  // (6) Idle with tasks: 10 weight (binary)
  const idleScore = isIdleWithTasks ? 10 : 0;

  const total = blockingScore + reviewScore + cycleTimeScore + ageScore + overloadScore + idleScore;
  return Math.min(total, 100);
}

/**
 * Find the agent with the highest bottleneck score and build a human-readable reason.
 */
function findTopBottleneck(
  metrics: AgentTaskMetrics[],
  teamAvgCycleTimeMs: number,
): SessionTaskMetrics["topBottleneck"] {
  if (metrics.length === 0) return null;

  const top = metrics.reduce((a, b) => a.bottleneckScore > b.bottleneckScore ? a : b);
  if (top.bottleneckScore <= 0) return null;

  // Build human-readable reason
  const reasons: string[] = [];
  if (top.taskBlockingOthers > 0) {
    reasons.push(`blocking ${top.taskBlockingOthers} task${top.taskBlockingOthers > 1 ? "s" : ""}`);
  }
  if (top.isOverloaded) {
    reasons.push(`overloaded (${top.loadPercentage}% capacity)`);
  }
  if (top.avgCycleTimeMs > 0 && teamAvgCycleTimeMs > 0) {
    const agentMin = Math.round(top.avgCycleTimeMs / 60000);
    const teamMin = Math.round(teamAvgCycleTimeMs / 60000);
    if (agentMin > teamMin) {
      reasons.push(`${agentMin}min avg cycle (team: ${teamMin}min)`);
    }
  }
  if (top.isIdle && top.totalActiveTasks > 0) {
    reasons.push(`idle with ${top.totalActiveTasks} pending tasks`);
  }

  return {
    agentId: top.agentId,
    agentName: top.agentName,
    score: top.bottleneckScore,
    reason: reasons.length > 0 ? reasons.join(", ") : `bottleneck score: ${top.bottleneckScore}`,
  };
}

/**
 * Debounced task-metrics-updated event emitter.
 * At most one event per 5 seconds per session.
 */
export class TaskMetricsDebouncer {
  private timers = new Map<string, NodeJS.Timeout>();
  private readonly DEBOUNCE_MS = 5000;

  /**
   * Schedule a debounced emit for a session.
   * @param sessionId - Session to emit for
   * @param callback - Function to call (broadcasts the WS event)
   */
  schedule(sessionId: string, callback: () => void): void {
    const existing = this.timers.get(sessionId);
    if (existing) {
      clearTimeout(existing);
    }
    const timer = setTimeout(() => {
      this.timers.delete(sessionId);
      callback();
    }, this.DEBOUNCE_MS);
    this.timers.set(sessionId, timer);
  }

  /** Clear all pending timers (cleanup on shutdown) */
  clear(): void {
    for (const timer of this.timers.values()) {
      clearTimeout(timer);
    }
    this.timers.clear();
  }
}
