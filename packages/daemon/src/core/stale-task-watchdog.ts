/**
 * StaleTaskWatchdog — monitors tasks for stale statuses and sends nudges.
 *
 * Runs a check loop every 60 seconds. For each active task stuck in a status
 * longer than the configured threshold, sends a nudge to the responsible party.
 * Escalates after configurable nudge count.
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
  target: "assignee" | "architect" | "user" | "all";
  escalateAfterCount: number;
  escalateTo: "architect" | "user" | "all";
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
    escalateTo: "architect",
    maxNudges: 8,
  },
  "review": {
    enabled: true,
    nudgeAfterMinutes: 15,
    intervalMinutes: 15,
    target: "architect",
    escalateAfterCount: 3,
    escalateTo: "user",
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

const CHECK_INTERVAL_MS = 60_000; // 1 minute
const MAX_NUDGES_PER_AGENT_PER_HOUR = 10;
const BATCH_THRESHOLD = 5; // Send summary if agent has 5+ stale tasks

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

  /** Start the watchdog check loop */
  start(): void {
    if (this.checkInterval) return;
    logger.info(`[StaleTaskWatchdog] Started for session ${this.sessionId}`);
    this.checkInterval = setInterval(() => this.checkStaleTasks(), CHECK_INTERVAL_MS);
    // Run immediately on start
    setTimeout(() => this.checkStaleTasks(), 5000);
  }

  /** Stop the watchdog */
  stop(): void {
    if (this.checkInterval) {
      clearInterval(this.checkInterval);
      this.checkInterval = undefined;
    }
  }

  /** Update nudge policies (e.g. from session settings) */
  updatePolicies(policies: Record<string, NudgePolicy>): void {
    this.nudgePolicies = { ...this.nudgePolicies, ...policies };
  }

  /** Get current policies */
  getPolicies(): Record<string, NudgePolicy> {
    return { ...this.nudgePolicies };
  }

  /** Main check loop — find stale tasks and send nudges */
  async checkStaleTasks(): Promise<void> {
    try {
      const enabledStatuses = Object.entries(this.nudgePolicies)
        .filter(([, policy]) => policy.enabled)
        .map(([status]) => status);

      if (enabledStatuses.length === 0) return;

      // Find the minimum threshold to query broadly
      const minThreshold = Math.min(
        ...enabledStatuses.map(s => this.nudgePolicies[s].nudgeAfterMinutes)
      );

      const staleTasks = this.database.getStaleTasks(
        this.sessionId,
        enabledStatuses,
        minThreshold,
      );

      if (staleTasks.length === 0) return;

      // Group by target agent for batch nudging
      const agentTasks = new Map<string, any[]>();

      for (const task of staleTasks) {
        const policy = this.nudgePolicies[task.status];
        if (!policy?.enabled) continue;

        // Check if this specific task has been in this status long enough
        const statusChangedAt = task.status_changed_at ? new Date(task.status_changed_at).getTime() : 0;
        const minutesInStatus = (Date.now() - statusChangedAt) / 60_000;

        if (minutesInStatus < policy.nudgeAfterMinutes) continue;

        // Check nudge interval — don't nudge again too soon
        const nudgeCount = this.database.getNudgeCount(task.id, task.status);
        if (nudgeCount > 0 && policy.intervalMinutes > 0) {
          const lastNudge = this.database.getNudgeHistory(task.id, 1)[0];
          if (lastNudge) {
            const lastNudgeTime = new Date(lastNudge.created_at).getTime();
            const minutesSinceNudge = (Date.now() - lastNudgeTime) / 60_000;
            if (minutesSinceNudge < policy.intervalMinutes) continue;
          }
        }

        // Check max nudges
        if (policy.maxNudges > 0 && nudgeCount >= policy.maxNudges) continue;

        // Determine target
        const isEscalation = nudgeCount >= policy.escalateAfterCount && policy.escalateAfterCount > 0;
        const targetType = isEscalation ? policy.escalateTo : policy.target;
        const targetAgentId = this.resolveTarget(targetType, task);

        // Group by target for batching
        const targetKey = targetAgentId || targetType;
        if (!agentTasks.has(targetKey)) agentTasks.set(targetKey, []);
        agentTasks.get(targetKey)!.push({
          task,
          nudgeCount: nudgeCount + 1,
          isEscalation,
          targetType,
          targetAgentId,
          minutesInStatus: Math.round(minutesInStatus),
          policy,
        });
      }

      // Send nudges (batch if needed)
      for (const [targetKey, tasks] of agentTasks) {
        // Rate limit per agent
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

  /** Resolve target to a specific agent ID */
  private resolveTarget(targetType: string, task: any): string | undefined {
    switch (targetType) {
      case "assignee":
        return task.assigned_to || undefined;
      case "architect": {
        // Find master agent in the session
        const agents = this.agentManager.listAgents();
        const master = agents.find(a =>
          a.config.sessionId === this.sessionId && a.config.role === "master" && a.status === "running"
        );
        return master?.id;
      }
      case "user":
        return undefined; // No agent — user notification only
      case "all":
        return undefined; // Broadcast
      default:
        return undefined;
    }
  }

  /** Check rate limit for a target */
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

  /** Send a single nudge */
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
      `Nudge #${nudgeCount} of ${policy.maxNudges || "∞"}. ` +
      `Assigned to: ${task.assigned_to || "(unassigned)"}. ` +
      `Action needed: update status or reassign.`;

    // Record nudge in database
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

    // Deliver to agent terminal
    if (targetAgentId) {
      try {
        const agent = this.agentManager.getAgent(targetAgentId);
        if (agent && agent.status === "running") {
          const coloredMsg = `\x1b[1;33m${message}\x1b[0m`;
          await this.agentManager.sendMessage(targetAgentId, coloredMsg);
        }
      } catch {
        // Non-fatal
      }
    }

    // Broadcast to all agents if target is "all"
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

    // Log timeline event
    await this.eventLog.log({
      sessionId: this.sessionId,
      type: "task-nudge" as any,
      data: {
        taskId: task.id,
        taskTitle: task.title,
        status: task.status,
        nudgeCount,
        isEscalation,
        targetType,
        targetAgentId,
        minutesInStatus,
      },
    });

    // Emit for dashboard WebSocket
    this.emit("nudge", {
      taskId: task.id,
      taskTitle: task.title,
      status: task.status,
      nudgeCount,
      isEscalation,
      targetType,
      targetAgentId,
      minutesInStatus,
      message,
    });

    logger.info({
      taskId: task.id,
      status: task.status,
      nudgeCount,
      isEscalation,
      targetType,
      minutesInStatus,
    }, `[StaleTaskWatchdog] Sent nudge for "${task.title}"`);
  }

  /** Send a batch summary nudge (5+ stale tasks for same target) */
  private async sendBatchNudge(targetKey: string, tasks: any[]): Promise<void> {
    const taskSummaries = tasks.map(t =>
      `  - "${t.task.title}" (${t.task.status}, ${t.minutesInStatus}min, nudge #${t.nudgeCount})`
    ).join("\n");

    const message = `[Stale Task Summary] ${tasks.length} tasks need attention:\n${taskSummaries}`;

    // Record each nudge individually
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

    // Deliver to target
    const targetAgentId = tasks[0]?.targetAgentId;
    if (targetAgentId) {
      try {
        await this.agentManager.sendMessage(targetAgentId, `\x1b[1;33m${message}\x1b[0m`);
      } catch { /* ignore */ }
    }

    // Emit for dashboard
    this.emit("batch-nudge", {
      targetKey,
      targetType: tasks[0]?.targetType,
      tasks: tasks.map(t => ({
        taskId: t.task.id,
        title: t.task.title,
        status: t.task.status,
        minutesInStatus: t.minutesInStatus,
      })),
      message,
    });
  }
}
