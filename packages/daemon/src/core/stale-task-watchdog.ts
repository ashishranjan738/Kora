/**
 * StaleTaskWatchdog — monitors tasks for stale statuses and sends nudges.
 *
 * Pure library pattern: call check() from an external scheduler (orchestrator).
 * The start() method wraps check() in setInterval for backward compatibility.
 *
 * Nudge delivery channels:
 * - Terminal sendKeys (for agents)
 * - Dashboard WebSocket (for user)
 * - Timeline event (for audit trail)
 */

import { EventEmitter } from "events";
import { randomUUID } from "crypto";
import type { AppDatabase } from "./database.js";
import type { AgentManager } from "./agent-manager.js";
import type { EventLog } from "./event-log.js";
import { logger } from "./logger.js";

export interface NudgePolicy {
  enabled: boolean;
  nudgeAfterMinutes: number;
  intervalMinutes: number;
  target: "assignee" | "orchestrator" | "user" | "all";
  escalateAfterCount: number;
  escalateTo: "orchestrator" | "user" | "all";
  maxNudges: number;
}

/** Default nudge policies per task status */
export const DEFAULT_NUDGE_POLICIES: Record<string, NudgePolicy> = {
  "pending": {
    enabled: false,
    nudgeAfterMinutes: 0,
    intervalMinutes: 0,
    target: "assignee",
    escalateAfterCount: 0,
    escalateTo: "user",
    maxNudges: 0,
  },
  "in-progress": {
    enabled: true,
    nudgeAfterMinutes: 60,
    intervalMinutes: 30,
    target: "assignee",
    escalateAfterCount: 3,
    escalateTo: "orchestrator",
    maxNudges: 8,
  },
  "review": {
    enabled: true,
    nudgeAfterMinutes: 30,   // Fix #4: adjusted from 15min to 30min
    intervalMinutes: 20,      // Fix #4: adjusted from 15min to 20min
    target: "orchestrator",
    escalateAfterCount: 3,
    escalateTo: "user",
    maxNudges: 8,
  },
  "e2e-testing": {            // Fix #5: new default policy for e2e-testing
    enabled: true,
    nudgeAfterMinutes: 30,
    intervalMinutes: 20,
    target: "assignee",
    escalateAfterCount: 3,
    escalateTo: "orchestrator",
    maxNudges: 8,
  },
  "blocked": {
    enabled: true,
    nudgeAfterMinutes: 10,
    intervalMinutes: 20,
    target: "assignee",
    escalateAfterCount: 2,
    escalateTo: "user",
    maxNudges: 6,
  },
  "done": {
    enabled: false,
    nudgeAfterMinutes: 0,
    intervalMinutes: 0,
    target: "assignee",
    escalateAfterCount: 0,
    escalateTo: "user",
    maxNudges: 0,
  },
};

const MAX_NUDGES_PER_AGENT_PER_HOUR = 10;
const BATCH_THRESHOLD = 5;
const REASSIGNMENT_GRACE_MINUTES = 5; // Fix #6
const NUDGE_TTL_DAYS = 7;             // Fix #7

export class StaleTaskWatchdog extends EventEmitter {
  private checkInterval?: NodeJS.Timeout;
  private nudgePolicies: Record<string, NudgePolicy>;
  private agentNudgeCounts = new Map<string, { count: number; windowStart: number }>();

  constructor(
    private sessionId: string,
    private database: AppDatabase,
    private agentManager: AgentManager,
    private eventLog: EventLog,
    policies?: Record<string, NudgePolicy>,
  ) {
    super();
    this.nudgePolicies = policies || { ...DEFAULT_NUDGE_POLICIES };
  }

  /** Start the watchdog — wraps check() in setInterval for backward compat. */
  start(): void {
    if (this.checkInterval) return;
    logger.info(`[StaleTaskWatchdog] Started for session ${this.sessionId}`);
    this.checkInterval = setInterval(() => this.check(), 60_000);
    setTimeout(() => this.check(), 5000);
  }

  /** Stop the watchdog */
  stop(): void {
    if (this.checkInterval) {
      clearInterval(this.checkInterval);
      this.checkInterval = undefined;
    }
  }

  updatePolicies(policies: Record<string, NudgePolicy>): void {
    this.nudgePolicies = { ...this.nudgePolicies, ...policies };
  }

  getPolicies(): Record<string, NudgePolicy> {
    return { ...this.nudgePolicies };
  }

  /**
   * Fix #3: Pure check function callable by external scheduler.
   * Finds stale tasks and sends nudges.
   */
  async check(): Promise<void> {
    try {
      const enabledStatuses = Object.entries(this.nudgePolicies)
        .filter(([, policy]) => policy.enabled)
        .map(([status]) => status);

      if (enabledStatuses.length === 0) return;

      const minThreshold = Math.min(
        ...enabledStatuses.map(s => this.nudgePolicies[s].nudgeAfterMinutes)
      );

      const staleTasks = this.database.getStaleTasks(
        this.sessionId,
        enabledStatuses,
        minThreshold,
      );

      if (staleTasks.length === 0) return;

      // Fix #1: Batch queries for nudge counts + last nudge times
      const taskIds = staleTasks.map((t: any) => t.id);
      const nudgeCounts = this.getBatchNudgeCounts(taskIds);
      const lastNudgeTimes = this.getBatchLastNudgeTimes(taskIds);

      const agentTasks = new Map<string, any[]>();

      for (const task of staleTasks) {
        const policy = this.nudgePolicies[task.status];
        if (!policy?.enabled) continue;

        const statusChangedAt = task.status_changed_at ? new Date(task.status_changed_at).getTime() : 0;
        const minutesInStatus = (Date.now() - statusChangedAt) / 60_000;

        if (minutesInStatus < policy.nudgeAfterMinutes) continue;

        // Fix #6: Skip if task was reassigned within grace period
        if (this.wasRecentlyReassigned(task)) continue;

        // Fix #1: Use batch-fetched nudge counts
        const nudgeCount = nudgeCounts.get(task.id) || 0;
        if (nudgeCount > 0 && policy.intervalMinutes > 0) {
          const lastNudgeTime = lastNudgeTimes.get(task.id);
          if (lastNudgeTime) {
            const minutesSinceNudge = (Date.now() - lastNudgeTime) / 60_000;
            if (minutesSinceNudge < policy.intervalMinutes) continue;
          }
        }

        if (policy.maxNudges > 0 && nudgeCount >= policy.maxNudges) continue;

        // Fix #2: Escalation with self-loop protection
        const isEscalation = nudgeCount >= policy.escalateAfterCount && policy.escalateAfterCount > 0;
        const targetType = isEscalation ? policy.escalateTo : policy.target;
        const targetAgentId = this.resolveTargetSafe(targetType, task);

        const targetKey = targetAgentId || targetType;
        if (!agentTasks.has(targetKey)) agentTasks.set(targetKey, []);
        agentTasks.get(targetKey)!.push({
          task,
          nudgeCount: nudgeCount + 1,
          isEscalation,
          targetType: targetAgentId ? targetType : "user",
          targetAgentId,
          minutesInStatus: Math.round(minutesInStatus),
          policy,
        });
      }

      for (const [targetKey, tasks] of agentTasks) {
        if (!this.isWithinRateLimit(targetKey)) continue;

        if (tasks.length >= BATCH_THRESHOLD) {
          await this.sendBatchNudge(targetKey, tasks);
        } else {
          for (const t of tasks) {
            await this.sendNudge(t);
          }
        }
      }
    } catch (err) {
      logger.warn({ err }, "[StaleTaskWatchdog] Error during check cycle");
    }
  }

  /** Backward-compat alias */
  async checkStaleTasks(): Promise<void> {
    return this.check();
  }

  /**
   * Fix #7: Cleanup old nudge records for closed tasks (>7 days).
   * @param closedStatuses - Closed/done status IDs from workflow states.
   *   Defaults to ["done"] for standard workflows but accepts custom closed states.
   */
  cleanupDoneTaskNudges(closedStatuses: string[] = ["done"]): number {
    try {
      const cutoff = new Date(Date.now() - NUDGE_TTL_DAYS * 24 * 60 * 60 * 1000).toISOString();
      const placeholders = closedStatuses.map(() => "?").join(", ");
      const result = this.database.db.prepare(
        `DELETE FROM task_nudges WHERE created_at < ? AND task_id IN (SELECT id FROM tasks WHERE status IN (${placeholders}))`
      ).run(cutoff, ...closedStatuses);
      if (result.changes > 0) {
        logger.info({ deleted: result.changes }, "[StaleTaskWatchdog] Cleaned up old closed-task nudges");
      }
      return result.changes;
    } catch (err) {
      logger.warn({ err }, "[StaleTaskWatchdog] Error cleaning up closed task nudges");
      return 0;
    }
  }

  // ─── Fix #1: Batch queries ────────────────────────────────────────

  private getBatchNudgeCounts(taskIds: string[]): Map<string, number> {
    const result = new Map<string, number>();
    if (taskIds.length === 0) return result;
    const placeholders = taskIds.map(() => "?").join(", ");
    const rows = this.database.db.prepare(
      `SELECT task_id, COUNT(*) as cnt FROM task_nudges WHERE task_id IN (${placeholders}) GROUP BY task_id`
    ).all(...taskIds) as Array<{ task_id: string; cnt: number }>;
    for (const row of rows) result.set(row.task_id, row.cnt);
    return result;
  }

  private getBatchLastNudgeTimes(taskIds: string[]): Map<string, number> {
    const result = new Map<string, number>();
    if (taskIds.length === 0) return result;
    const placeholders = taskIds.map(() => "?").join(", ");
    const rows = this.database.db.prepare(
      `SELECT task_id, MAX(created_at) as last_nudge FROM task_nudges WHERE task_id IN (${placeholders}) GROUP BY task_id`
    ).all(...taskIds) as Array<{ task_id: string; last_nudge: string }>;
    for (const row of rows) result.set(row.task_id, new Date(row.last_nudge).getTime());
    return result;
  }

  // ─── Fix #2: Escalation self-loop protection ──────────────────────

  /**
   * Resolve escalation target with self-loop protection.
   *
   * Self-loop scenario: task assigned to master agent, policy escalates to "architect",
   * architect resolves to the same master agent → infinite loop.
   *
   * Fallback chain: assignee → architect → user (dashboard notification).
   * If any level resolves to the same agent as the assignee, we skip it and
   * fall through to "user" (returns undefined = no agent target, emits as
   * dashboard notification instead).
   */
  private resolveTargetSafe(targetType: string, task: any): string | undefined {
    const resolved = this.resolveTarget(targetType, task);
    if (targetType !== "assignee" && resolved && resolved === task.assigned_to) {
      return undefined; // Self-loop detected → fallback to "user" notification
    }
    return resolved;
  }

  private resolveTarget(targetType: string, task: any): string | undefined {
    switch (targetType) {
      case "assignee":
        return task.assigned_to || undefined;
      case "orchestrator":
      case "architect": { // backward compat
        const agents = this.agentManager.listAgents();
        const master = agents.find(a =>
          a.config.sessionId === this.sessionId && a.config.role === "master" && a.status === "running"
        );
        return master?.id;
      }
      case "user":
        return undefined;
      case "all":
        return undefined;
      default:
        return undefined;
    }
  }

  // ─── Fix #6: Reassignment grace period ────────────────────────────

  /**
   * Check if task was recently updated (proxy for reassignment).
   * Note: Uses updated_at > status_changed_at as a heuristic. This may also
   * trigger on comment additions or label changes, not just reassignment.
   * Acceptable trade-off: a false positive just delays the nudge by 5 minutes.
   * TODO: Track assignedTo changes explicitly for precision.
   */
  private wasRecentlyReassigned(task: any): boolean {
    if (!task.updated_at) return false;
    const updatedAt = new Date(task.updated_at).getTime();
    const statusChangedAt = task.status_changed_at ? new Date(task.status_changed_at).getTime() : 0;
    if (updatedAt > statusChangedAt) {
      const minutesSinceUpdate = (Date.now() - updatedAt) / 60_000;
      if (minutesSinceUpdate < REASSIGNMENT_GRACE_MINUTES) return true;
    }
    return false;
  }

  // ─── Delivery ─────────────────────────────────────────────────────

  private isWithinRateLimit(targetKey: string): boolean {
    const now = Date.now();
    const record = this.agentNudgeCounts.get(targetKey);
    if (!record || now - record.windowStart > 3600_000) {
      this.agentNudgeCounts.set(targetKey, { count: 1, windowStart: now });
      return true;
    }
    if (record.count >= MAX_NUDGES_PER_AGENT_PER_HOUR) return false;
    record.count++;
    return true;
  }

  private async sendNudge(info: {
    task: any;
    nudgeCount: number;
    isEscalation: boolean;
    targetType: string;
    targetAgentId?: string;
    minutesInStatus: number;
    policy: NudgePolicy;
  }): Promise<void> {
    const { task, nudgeCount, isEscalation, targetType, targetAgentId, minutesInStatus, policy } = info;

    const prefix = isEscalation ? "[ESCALATION]" : "[Stale Task Alert]";
    const message = `${prefix} Task "${task.title}" has been in "${task.status}" for ${minutesInStatus}min. ` +
      `Nudge #${nudgeCount} of ${policy.maxNudges || "\u221e"}. ` +
      `Assigned to: ${task.assigned_to || "(unassigned)"}. ` +
      `Action needed: update status or reassign.`;

    this.database.insertNudge({
      id: randomUUID(),
      taskId: task.id,
      sessionId: this.sessionId,
      statusAtNudge: task.status,
      targetAgentId,
      targetType,
      nudgeCount,
      isEscalation,
      message,
    });

    if (targetAgentId) {
      try {
        const agent = this.agentManager.getAgent(targetAgentId);
        if (agent && agent.status === "running") {
          await this.agentManager.sendMessage(targetAgentId, `\x1b[1;33m${message}\x1b[0m`);
        }
      } catch { /* non-fatal */ }
    }

    if (targetType === "all") {
      const agents = this.agentManager.listAgents().filter(a =>
        a.config.sessionId === this.sessionId && a.status === "running"
      );
      for (const agent of agents) {
        try {
          await this.agentManager.sendMessage(agent.id, `\x1b[1;33m${message}\x1b[0m`);
        } catch { /* ignore */ }
      }
    }

    await this.eventLog.log({
      sessionId: this.sessionId,
      type: "task-nudge" as any,
      data: {
        taskId: task.id, taskTitle: task.title, status: task.status,
        nudgeCount, isEscalation, targetType, targetAgentId, minutesInStatus,
      },
    });

    this.emit("nudge", {
      taskId: task.id, taskTitle: task.title, status: task.status,
      nudgeCount, isEscalation, targetType, targetAgentId, minutesInStatus, message,
    });

    logger.info({
      taskId: task.id, status: task.status, nudgeCount, isEscalation, targetType, minutesInStatus,
    }, `[StaleTaskWatchdog] Sent nudge for "${task.title}"`);
  }

  private async sendBatchNudge(targetKey: string, tasks: any[]): Promise<void> {
    const taskSummaries = tasks.map(t =>
      `  - "${t.task.title}" (${t.task.status}, ${t.minutesInStatus}min, nudge #${t.nudgeCount})`
    ).join("\n");
    const message = `[Stale Task Summary] ${tasks.length} tasks need attention:\n${taskSummaries}`;

    for (const t of tasks) {
      this.database.insertNudge({
        id: randomUUID(),
        taskId: t.task.id,
        sessionId: this.sessionId,
        statusAtNudge: t.task.status,
        targetAgentId: t.targetAgentId,
        targetType: t.targetType,
        nudgeCount: t.nudgeCount,
        isEscalation: t.isEscalation,
        message: `[Batch] ${message.substring(0, 200)}`,
      });
    }

    const targetAgentId = tasks[0]?.targetAgentId;
    if (targetAgentId) {
      try {
        await this.agentManager.sendMessage(targetAgentId, `\x1b[1;33m${message}\x1b[0m`);
      } catch { /* ignore */ }
    }

    this.emit("batch-nudge", {
      targetKey,
      targetType: tasks[0]?.targetType,
      tasks: tasks.map(t => ({
        taskId: t.task.id, title: t.task.title, status: t.task.status, minutesInStatus: t.minutesInStatus,
      })),
      message,
    });
  }
}
