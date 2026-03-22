/**
 * Auto-assign: automatically assigns unassigned pending tasks to idle agents.
 * Phase 0 of Autonomous Orchestrator — event-driven, no reconciliation loop.
 *
 * Triggered by:
 * - agent-idle event (from health monitor)
 * - report_idle MCP tool
 *
 * Reuses request_task scoring: priority (P0=1000..P3=1) + skill match (+50) + overdue (+500).
 */

import { logger } from "./logger.js";
import type { AppDatabase } from "./database.js";
import type { AgentManager } from "./agent-manager.js";
import type { MessageQueue } from "./message-queue.js";
import type { EventLog } from "./event-log.js";
import type { AgentState } from "@kora/shared";
import crypto from "crypto";

const MAX_AUTO_ASSIGNS_PER_WINDOW = 3;
const RATE_LIMIT_WINDOW_MS = 5 * 60 * 1000; // 5 minutes

export interface AutoAssignConfig {
  sessionId: string;
  database: AppDatabase;
  agentManager: AgentManager;
  messageQueue: MessageQueue;
  eventLog: EventLog;
  enabled?: boolean; // default true
}

export class AutoAssigner {
  private rateLimits = new Map<string, { count: number; windowStart: number }>();
  private enabled: boolean;

  constructor(private config: AutoAssignConfig) {
    this.enabled = config.enabled !== false;
  }

  /** Enable/disable auto-assign */
  setEnabled(enabled: boolean): void {
    this.enabled = enabled;
  }

  isEnabled(): boolean {
    return this.enabled;
  }

  /**
   * Try to auto-assign a task to an idle agent.
   * Returns the assigned task or null if no match.
   */
  async tryAutoAssign(agentId: string): Promise<{ taskId: string; title: string; priority: string } | null> {
    if (!this.enabled) return null;

    const agent = this.config.agentManager.getAgent(agentId);
    if (!agent) return null;

    // Skip master agents
    if (agent.config.role === "master") {
      logger.debug({ agentId }, "[auto-assign] Skipping master agent");
      return null;
    }

    // Rate limit: max 3 per 5 minutes per agent
    if (!this.isWithinRateLimit(agentId)) {
      logger.debug({ agentId }, "[auto-assign] Rate limited");
      return null;
    }

    // Find best unassigned task
    const task = this.findBestUnassignedTask(agent);
    if (!task) return null;

    // Assign task
    const firstWorkflowState = this.getFirstWorkflowState();
    this.config.database.updateTask(task.id, {
      assignedTo: agent.config.name,
    });

    // Notify agent via terminal + SQLite
    const notifyMsg = `[Auto-assigned] Task "${task.title}" (${task.priority}). Use get_task("${task.id}") for details.`;
    try {
      this.config.messageQueue.enqueue(
        agentId,
        agent.config.tmuxSession,
        `\x1b[1;35m${notifyMsg}\x1b[0m`,
        undefined, // fromAgentId = system
      );
      // Persist to SQLite for check_messages
      this.config.database.insertMessage({
        id: crypto.randomUUID(),
        sessionId: this.config.sessionId,
        fromAgentId: "system",
        toAgentId: agentId,
        messageType: "task-assignment",
        content: notifyMsg,
        priority: "high",
        createdAt: Date.now(),
        expiresAt: Date.now() + 7 * 24 * 60 * 60 * 1000,
      });
    } catch (err) {
      logger.warn({ err, agentId }, "[auto-assign] Failed to notify agent");
    }

    // Log event
    await this.config.eventLog.log({
      sessionId: this.config.sessionId,
      type: "auto-assign" as any,
      data: {
        agentId,
        agentName: agent.config.name,
        taskId: task.id,
        taskTitle: task.title,
        taskPriority: task.priority,
      },
    });

    logger.info({
      agentId,
      agentName: agent.config.name,
      taskId: task.id,
      taskTitle: task.title,
    }, "[auto-assign] Task auto-assigned to idle agent");

    return { taskId: task.id, title: task.title, priority: task.priority };
  }

  /**
   * Check for tasks unblocked by a completed task and notify assignees.
   */
  async checkDependencyUnblocks(completedTaskId: string): Promise<number> {
    const allTasks = this.config.database.getTasks(this.config.sessionId);
    let unblockedCount = 0;

    for (const task of allTasks) {
      if (!task.dependencies || task.dependencies.length === 0) continue;
      if (task.status === "done") continue;

      // Check if this task depends on the completed task
      if (!task.dependencies.includes(completedTaskId)) continue;

      // Check if ALL dependencies are now done
      const allDepsDone = task.dependencies.every((depId: string) => {
        const dep = allTasks.find((t: any) => t.id === depId);
        return dep && dep.status === "done";
      });

      if (!allDepsDone) continue;

      unblockedCount++;

      // Notify assignee if task has one
      if (task.assignedTo) {
        const agentId = this.resolveAgentId(task.assignedTo);
        if (agentId) {
          const agent = this.config.agentManager.getAgent(agentId);
          if (agent && agent.status === "running") {
            const notifyMsg = `[Unblocked] Task "${task.title}" — all dependencies done. You can start working on it.`;
            try {
              this.config.messageQueue.enqueue(
                agentId,
                agent.config.tmuxSession,
                `\x1b[1;32m${notifyMsg}\x1b[0m`,
              );
              this.config.database.insertMessage({
                id: crypto.randomUUID(),
                sessionId: this.config.sessionId,
                fromAgentId: "system",
                toAgentId: agentId,
                messageType: "task-assignment",
                content: notifyMsg,
                priority: "high",
                createdAt: Date.now(),
                expiresAt: Date.now() + 7 * 24 * 60 * 60 * 1000,
              });
            } catch { /* non-fatal */ }
          }
        }
      }

      // Log event
      await this.config.eventLog.log({
        sessionId: this.config.sessionId,
        type: "task-unblocked" as any,
        data: {
          taskId: task.id,
          taskTitle: task.title,
          unblockedBy: completedTaskId,
          assignedTo: task.assignedTo,
        },
      });
    }

    return unblockedCount;
  }

  // ─── Internals ─────────────────────────────────────────────────

  /** Find best unassigned pending task for an agent, using priority scoring */
  findBestUnassignedTask(agent: AgentState): { id: string; title: string; priority: string } | null {
    const allTasks = this.config.database.getTasks(this.config.sessionId);

    // Get first workflow state ID (the "pending"/"backlog" state)
    const firstState = this.getFirstWorkflowState();

    const available = allTasks.filter((t: any) =>
      (t.status === firstState || t.status === "pending") &&
      (!t.assignedTo || t.assignedTo === "")
    );

    if (available.length === 0) return null;

    // Filter out tasks with unmet dependencies
    const taskMap = new Map(allTasks.map((t: any) => [t.id, t]));
    const unblocked = available.filter((t: any) => {
      if (!t.dependencies || t.dependencies.length === 0) return true;
      return t.dependencies.every((depId: string) => {
        const dep = taskMap.get(depId);
        return dep && dep.status === "done";
      });
    });

    if (unblocked.length === 0) return null;

    // Score by priority
    const priorityScore = (p: string) => {
      switch (p) { case "P0": return 1000; case "P1": return 100; case "P2": return 10; case "P3": return 1; default: return 10; }
    };

    // Skill match from agent's persona keywords
    const agentLabels = (agent.config.persona || "").toLowerCase();
    const hasSkillMatch = (task: any) => {
      const labels = task.labels || [];
      return labels.some((l: string) => agentLabels.includes(l.toLowerCase()));
    };

    let best: any = null;
    let bestScore = -1;

    for (const task of unblocked) {
      let score = priorityScore(task.priority || "P2");
      if (hasSkillMatch(task)) score += 50;
      if (task.dueDate && new Date(task.dueDate).getTime() < Date.now()) score += 500;
      if (score > bestScore) {
        bestScore = score;
        best = task;
      }
    }

    return best ? { id: best.id, title: best.title, priority: best.priority || "P2" } : null;
  }

  private getFirstWorkflowState(): string {
    // Try to read from session config (not available directly, so default)
    return "pending"; // Default — callers can override if needed
  }

  private resolveAgentId(nameOrId: string): string | undefined {
    // Check by ID first
    const byId = this.config.agentManager.getAgent(nameOrId);
    if (byId) return nameOrId;
    // Check by name
    const agents = this.config.agentManager.listAgents();
    const byName = agents.find(a => a.config.name === nameOrId || a.config.name.toLowerCase() === nameOrId.toLowerCase());
    return byName?.id;
  }

  private isWithinRateLimit(agentId: string): boolean {
    const now = Date.now();
    const record = this.rateLimits.get(agentId);
    if (!record || now - record.windowStart > RATE_LIMIT_WINDOW_MS) {
      this.rateLimits.set(agentId, { count: 1, windowStart: now });
      return true;
    }
    if (record.count >= MAX_AUTO_ASSIGNS_PER_WINDOW) return false;
    record.count++;
    return true;
  }
}
