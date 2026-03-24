import { EventEmitter } from "events";
import crypto from "crypto";
import type {
  AgentState,
  ControlCommand,
  SpawnAgentCommand,
  RemoveAgentCommand,
  GetAgentStatusCommand,
  MessagingMode,
  WorktreeMode,
} from "@kora/shared";
import { getRuntimeTmuxPrefix } from "@kora/shared";
import { AgentManager } from "./agent-manager.js";
import { MessageBus } from "./message-bus.js";
import { AgentControlPlane } from "./agent-control-plane.js";
import { EventLog } from "./event-log.js";
import { AppDatabase } from "./database.js";
import { CostTracker } from "./cost-tracker.js";
import { AgentHealthMonitor } from "./agent-health.js";
import type { IPtyBackend } from "./pty-backend.js";
import type { CLIProviderRegistry } from "../cli-providers/provider-registry.js";
import { UsageMonitor } from "./usage-monitor.js";
import { AutoRelay } from "./auto-relay.js";
import { MessageQueue } from "./message-queue.js";
import { notifications } from "./notifications.js";
import { notificationService } from "./notification-service.js";
import { saveAgentStates, loadAgentStates } from "./state-persistence.js";
import fs from "fs";
import { HoldptyController } from "./holdpty-controller.js";
import { logger } from "./logger.js";
import { StaleTaskWatchdog } from "./stale-task-watchdog.js";
import { WatchdogDeliveryManager } from "./watchdog-delivery.js";
import { AutoAssigner } from "./auto-assign.js";
import { PatternDetector } from "./orchestrator-blocking/detection/pattern-detector.js";
import { OrchestratorStateMachine } from "./orchestrator-blocking/state-machine.js";
import { OrchestratorState } from "./orchestrator-blocking/types.js";
import type { BlockingDecision } from "./orchestrator-blocking/types.js";

export interface OrchestratorConfig {
  sessionId: string;
  projectPath: string;
  runtimeDir: string;
  defaultProvider: string;
  tmux: IPtyBackend;
  providerRegistry: CLIProviderRegistry;
  messagingMode?: MessagingMode;
  worktreeMode?: WorktreeMode;
}

export class Orchestrator extends EventEmitter {
  public agentManager: AgentManager;
  public healthMonitor: AgentHealthMonitor;
  public messageBus: MessageBus;
  public controlPlane: AgentControlPlane;
  public eventLog: EventLog;
  public costTracker: CostTracker;
  public database: AppDatabase;
  public usageMonitor: UsageMonitor;
  private autoRelay: AutoRelay;
  public messageQueue: MessageQueue;
  private logRotationInterval?: NodeJS.Timeout;
  private deliveryCleanupInterval?: NodeJS.Timeout;
  private lastIdleNotification = new Map<string, number>();
  private idleCheckInterval?: NodeJS.Timeout;

  // Orchestrator blocking system
  private blockingDetector = new PatternDetector();
  private blockingStateMachines = new Map<string, OrchestratorStateMachine>();
  private blockingBuffers = new Map<string, Array<{ from: string; to: string; message: string; messageType?: string; timestamp: string }>>();
  private blockingTimestamps = new Map<string, number>(); // When each agent entered blocked state
  private _replayingBuffer = false; // Skip blocking checks during buffer replay
  private _budgetPaused = false; // Prevent repeated auto-pause

  // Stale task watchdog
  public staleTaskWatchdog: StaleTaskWatchdog;

  // Unified watchdog delivery manager
  public watchdogDelivery: WatchdogDeliveryManager;

  // Auto-assigner (Phase 0 autonomous orchestrator)
  public autoAssigner: AutoAssigner;

  constructor(private config: OrchestratorConfig) {
    super();

    // Initialize SQLite database
    this.database = new AppDatabase(config.runtimeDir);

    this.healthMonitor = new AgentHealthMonitor(config.tmux);
    this.agentManager = new AgentManager(config.tmux, this.healthMonitor);

    // Pass agents map to health monitor for idle detection
    this.healthMonitor.setAgentsMap(this.agentManager.getAgentsMap());
    this.messageBus = new MessageBus(config.runtimeDir);
    this.messageBus.setDatabase(this.database, config.sessionId);
    this.controlPlane = new AgentControlPlane(config.runtimeDir);
    this.eventLog = new EventLog(config.runtimeDir);
    this.eventLog.setDatabase(this.database);
    this.costTracker = new CostTracker();
    this.usageMonitor = new UsageMonitor(
      config.tmux,
      this.costTracker,
      config.providerRegistry,
    );
    // Wire idle checker so usage monitor can poll /cost on idle agents
    this.usageMonitor.setIdleChecker((agentId: string) => {
      const agent = this.agentManager.getAgent(agentId);
      return agent?.activity === "idle" && agent?.status === "running";
    });
    this.watchdogDelivery = new WatchdogDeliveryManager(this.messageBus, config.messagingMode || "mcp");
    this.autoRelay = new AutoRelay(config.tmux, this.agentManager, this.eventLog, config.sessionId, config.messagingMode);
    this.messageQueue = new MessageQueue(config.tmux, config.runtimeDir, config.messagingMode || "mcp");
    this.autoRelay.setMessageQueue(this.messageQueue);

    // Wire agent alive check — skip terminal delivery for crashed/stopped agents
    this.messageQueue.setAgentAliveCheck((agentId: string) => {
      const agent = this.agentManager.getAgent(agentId);
      return agent?.status === "running";
    });

    // Wire re-notification callbacks so MessageQueue can check unread counts
    this.messageQueue.setRenotifyCallbacks(
      (agentId: string) => this.messageBus.getUnreadCount(agentId),
      (agentId: string) => {
        const agent = this.agentManager.getAgent(agentId);
        return agent?.config.tmuxSession || null;
      },
      // Escalation callback: log event when agent ignores messages for >120s
      (agentId: string, unreadCount: number, elapsedMs: number) => {
        const agent = this.agentManager.getAgent(agentId);
        const agentName = agent?.config.name || agentId;
        logger.warn(
          { agentId, agentName, unreadCount, elapsedMs },
          `[Orchestrator] Agent ${agentName} has ${unreadCount} unread message(s) for ${Math.round(elapsedMs / 1000)}s — escalating`,
        );
        this.eventLog.log({
          sessionId: config.sessionId,
          type: "message-escalation" as any,
          data: {
            agentId,
            agentName,
            unreadCount,
            elapsedMs,
            message: `Agent ${agentName} has ${unreadCount} unread message(s) for ${Math.round(elapsedMs / 1000)}s`,
          },
        }).catch(() => {});
      },
    );

    // Wire MCP activity checker for recovery detection
    this.messageQueue.setMcpActivityChecker(
      (agentId: string) => this.healthMonitor.hasRecentMcpActivity(agentId),
    );

    // Wire delivery tracking (Tier 3 event routing)
    this.messageQueue.setDeliveryTracking(this.database, config.sessionId);

    this.staleTaskWatchdog = new StaleTaskWatchdog(
      config.sessionId,
      this.database,
      this.agentManager,
      this.eventLog,
    );
    // Forward watchdog events to orchestrator for WebSocket broadcast
    this.staleTaskWatchdog.on("nudge", (data) => this.emit("task-nudge", data));
    this.staleTaskWatchdog.on("batch-nudge", (data) => this.emit("task-batch-nudge", data));

    // Auto-assigner (Phase 0 autonomous orchestrator)
    this.autoAssigner = new AutoAssigner({
      sessionId: config.sessionId,
      database: this.database,
      agentManager: this.agentManager,
      messageQueue: this.messageQueue,
      eventLog: this.eventLog,
    });

    this.wireEvents();
    this.startIdleMonitoring();
  }

  private startIdleMonitoring(): void {
    // Check for idle agents every minute
    this.idleCheckInterval = setInterval(() => {
      const agents = this.agentManager.listAgents();
      const now = Date.now();
      const IDLE_NOTIFICATION_THRESHOLD_MS = 5 * 60 * 1000; // 5 minutes
      const MIN_NOTIFICATION_INTERVAL_MS = 15 * 60 * 1000; // 15 minutes

      for (const agent of agents) {
        if (agent.activity === "idle" && agent.idleSince) {
          const idleSince = new Date(agent.idleSince).getTime();
          const idleDuration = now - idleSince;

          // Notify if idle for >5min and haven't notified in last 15min
          if (idleDuration > IDLE_NOTIFICATION_THRESHOLD_MS) {
            const lastSent = this.lastIdleNotification.get(agent.id) || 0;
            if (now - lastSent >= MIN_NOTIFICATION_INTERVAL_MS) {
              notificationService.agentIdle(this.config.sessionId, agent.id, agent.config.name, idleDuration);
              this.lastIdleNotification.set(agent.id, now);
            }
          }
        }

        // Process custom reminders for this agent
        this.processReminders(agent, now).catch(() => {});
      }
    }, 60_000); // Check every minute
  }

  /** Process custom per-agent reminders */
  private async processReminders(agent: AgentState, now: number): Promise<void> {
    if (agent.status !== "running") return;
    if (this.isAgentBlocked(agent.id)) return;

    const reminders = this.database.getRemindersForAgent(this.config.sessionId, agent.id);
    for (const r of reminders) {
      // Check interval
      const lastFired = r.last_fired_at ? new Date(r.last_fired_at).getTime() : 0;
      if (now - lastFired < r.interval_minutes * 60_000) continue;

      // Check condition
      let shouldFire = false;
      switch (r.condition) {
        case "always":
          shouldFire = true;
          break;
        case "when-idle":
          shouldFire = agent.activity === "idle";
          break;
        case "when-has-unread": {
          try {
            const unread = await this.messageBus.getUnreadCount(agent.id);
            shouldFire = unread > 0;
          } catch { shouldFire = false; }
          break;
        }
        case "when-no-task": {
          const tasks = this.database.getFilteredTasks(this.config.sessionId, {
            assignedTo: agent.id,
            status: "active",
          });
          shouldFire = tasks.length === 0;
          break;
        }
      }

      if (!shouldFire) continue;

      // Fire reminder
      try {
        this.messageQueue.enqueue(
          agent.id,
          agent.config.tmuxSession,
          `\x1b[1;33m[Reminder] ${r.message}\x1b[0m`,
        );
        this.database.updateReminderFiredAt(r.id);
      } catch { /* non-fatal */ }
    }
  }

  /** Check session-level budget and auto-pause all agents if exceeded */
  private async checkSessionBudget(): Promise<void> {
    if (this._budgetPaused) return; // Already paused

    const maxBudget = (this.config as any).maxBudget as number | undefined;
    if (!maxBudget) return; // No budget set

    const totalCost = this.costTracker.getTotalCost();
    if (totalCost < maxBudget) return;

    this._budgetPaused = true;
    logger.warn({ totalCost, maxBudget, sessionId: this.config.sessionId },
      "[orchestrator] Session budget exceeded — auto-pausing all agents");

    // Stop all running agents
    const agents = this.agentManager.listAgents();
    for (const agent of agents) {
      if (agent.status === "running") {
        try {
          await this.agentManager.stopAgent(agent.id, "session budget exceeded");
        } catch { /* best effort */ }
      }
    }

    // Log event
    await this.eventLog.log({
      sessionId: this.config.sessionId,
      type: "cost-threshold-reached" as any,
      data: {
        level: "session",
        totalCostUsd: totalCost,
        maxBudget,
        action: "auto-paused all agents",
      },
    });

    // Emit for WebSocket broadcast
    this.emit("budget-exceeded", {
      sessionId: this.config.sessionId,
      totalCostUsd: totalCost,
      maxBudget,
      message: `Budget exceeded ($${totalCost.toFixed(2)} / $${maxBudget.toFixed(2)}) — agents paused`,
    });
  }

  private wireEvents(): void {
    // When an agent is spawned, set up message bus + control plane for it
    this.agentManager.on("agent-spawned", async (agent: AgentState) => {
      await this.messageBus.setupAgent(agent.id);
      await this.controlPlane.setupAgent(agent.id);
      this.controlPlane.watchAgent(agent.id);
      this.costTracker.initAgent(agent.id);
      this.usageMonitor.startMonitoring(agent);
      this.autoRelay.startMonitoring(agent);

      // Register MCP-capable agents for mcp-pending delivery
      if (agent.config.cliProvider) {
        const provider = this.config.providerRegistry.get(agent.config.cliProvider);
        if (provider?.supportsMcp) {
          this.messageQueue.registerMcpAgent(agent.id);
        }
      }
      // Register agent role for role-based rate limits (master: 25/min, worker: 10/min)
      this.messageQueue.registerAgentRole(agent.id, agent.config.role);

      await this.eventLog.log({
        sessionId: this.config.sessionId,
        type: "agent-spawned",
        data: {
          agentId: agent.id,
          name: agent.config.name,
          provider: agent.config.cliProvider,
          model: agent.config.model,
        },
      });

      // Notify all existing agents about the new peer
      const existingAgents = this.agentManager.listAgents().filter(a => a.id !== agent.id && a.status === 'running');
      for (const existing of existingAgents) {
        const refreshHint = this.config.messagingMode === "terminal" ? "" : this.config.messagingMode === "cli" ? " Run kora-cli context team to update your team roster." : " Call get_context(\"team\") to update your team roster.";
        const msg = `\x1b[1;32m[System]\x1b[0m New agent joined the team: "${agent.config.name}" (${agent.id}), role: ${agent.config.role}${refreshHint}`;
        await this.messageBus.deliverToInbox(existing.id, {
          id: crypto.randomUUID(),
          from: 'system',
          to: existing.id,
          type: 'status',
          content: msg,
          timestamp: new Date().toISOString(),
        });
        // Also send terminal notification so agent sees it immediately
        try {
          const mode = this.config.messagingMode || "mcp";
          const cmd = mode === "cli" ? "kora-cli messages" : "check_messages";
          await this.agentManager.sendMessage(existing.id, mode === "terminal" ? `[New message from system.]` : `[New message from system. Use ${cmd} tool to read it.]`);
        } catch { /* non-fatal — agent may not be ready */ }
      }

      // Send welcome notification to the newly spawned agent itself
      const welcomeMsg = this.buildStartupNotification(agent);
      setTimeout(async () => {
        try {
          await this.messageBus.deliverToInbox(agent.id, {
            id: crypto.randomUUID(),
            from: 'system',
            to: agent.id,
            type: 'status',
            content: welcomeMsg,
            timestamp: new Date().toISOString(),
          });
        } catch { /* non-fatal */ }
      }, 500); // Small delay to ensure agent's CLI/MCP has initialized

      this.emit("agent-update", agent);
      await this.persistState();
    });

    // When an agent is removed
    this.agentManager.on("agent-removed", async (agentId: string, reason: string) => {
      this.usageMonitor.stopMonitoring(agentId);
      this.autoRelay.stopMonitoring(agentId);
      this.messageQueue.removeAgent(agentId);
      this.watchdogDelivery.removeAgent(agentId);
      await this.messageBus.teardownAgent(agentId);
      this.costTracker.removeAgent(agentId);

      await this.eventLog.log({
        sessionId: this.config.sessionId,
        type: "agent-removed",
        data: { agentId, reason },
      });

      // Notify remaining agents about the departure
      const remainingAgents = this.agentManager.listAgents().filter(a => a.id !== agentId && a.status === 'running');
      for (const remaining of remainingAgents) {
        const leaveHint = this.config.messagingMode === "terminal" ? "" : this.config.messagingMode === "cli" ? " Run kora-cli context team to update your team roster." : " Call get_context(\"team\") to update your team roster.";
        const msg = `\x1b[1;32m[System]\x1b[0m Agent "${agentId}" has been removed from the team. Reason: ${reason}${leaveHint}`;
        await this.messageBus.deliverToInbox(remaining.id, {
          id: crypto.randomUUID(),
          from: 'system',
          to: remaining.id,
          type: 'status',
          content: msg,
          timestamp: new Date().toISOString(),
        });
        // Also send terminal notification so agent sees it immediately
        try {
          const leaveMode = this.config.messagingMode || "mcp";
          const leaveCmd = leaveMode === "cli" ? "kora-cli messages" : "check_messages";
          await this.agentManager.sendMessage(remaining.id, leaveMode === "terminal" ? `[New message from system.]` : `[New message from system. Use ${leaveCmd} tool to read it.]`);
        } catch { /* non-fatal */ }
      }

      this.emit("agent-removed", agentId, reason);
      await this.persistState();
    });

    // When an agent crashes
    this.agentManager.on("agent-crashed", async (agentId: string) => {
      await this.eventLog.log({
        sessionId: this.config.sessionId,
        type: "agent-crashed",
        data: { agentId },
      });
      const agent = this.agentManager.getAgent(agentId);
      if (agent) {
        notifications.agentCrashed(agent.config.name);
        notificationService.agentCrashed(this.config.sessionId, agentId, agent.config.name);
      }
      this.emit("agent-crashed", agentId);
      await this.persistState();
    });

    // When an agent's activity status changes (idle/working)
    this.agentManager.on("agent-idle", async (agentId: string) => {
      const agent = this.agentManager.getAgent(agentId);
      if (!agent) return;
      await this.eventLog.log({
        sessionId: this.config.sessionId,
        type: "agent-status-changed",
        data: {
          agentId,
          agentName: agent.config.name,
          status: "idle",
          previousStatus: "working",
        },
      });

      // Phase 0: Auto-assign unassigned task to idle agent
      try {
        const assigned = await this.autoAssigner.tryAutoAssign(agentId);
        if (assigned) {
          this.emit("auto-assign", { sessionId: this.config.sessionId, agentId, ...assigned });
        }
      } catch (err) {
        logger.warn({ err, agentId }, "[orchestrator] Auto-assign failed");
      }
    });

    this.agentManager.on("agent-working", async (agentId: string) => {
      const agent = this.agentManager.getAgent(agentId);
      if (!agent) return;
      await this.eventLog.log({
        sessionId: this.config.sessionId,
        type: "agent-status-changed",
        data: {
          agentId,
          agentName: agent.config.name,
          status: "working",
          previousStatus: "idle",
        },
      });
    });

    // Debounced WebSocket push for activity changes (max 1 per agent per 5s)
    const activityDebounceTimers = new Map<string, NodeJS.Timeout>();
    const ACTIVITY_DEBOUNCE_MS = 5000;

    const emitActivityChange = (agentId: string, activity: string, previousActivity: string) => {
      // Clear existing debounce timer for this agent
      const existing = activityDebounceTimers.get(agentId);
      if (existing) clearTimeout(existing);

      activityDebounceTimers.set(agentId, setTimeout(() => {
        activityDebounceTimers.delete(agentId);
        const agent = this.agentManager.getAgent(agentId);
        if (!agent) return;
        this.emit("agent-activity-changed", {
          sessionId: this.config.sessionId,
          agentId,
          agentName: agent.config.name,
          activity,
          previousActivity,
          idleSince: agent.idleSince || null,
        });
      }, ACTIVITY_DEBOUNCE_MS));
    };

    this.agentManager.on("agent-idle", (agentId: string) => {
      emitActivityChange(agentId, "idle", "working");
      this.watchdogDelivery.onAgentIdle(agentId).catch(() => {}); // flush queued notifications
    });
    this.agentManager.on("agent-working", (agentId: string) => {
      emitActivityChange(agentId, "working", "idle");
      this.watchdogDelivery.onAgentBusy(agentId); // hold new notifications
    });

    // When a message is detected in an agent's outbox, route it
    this.messageBus.on("message", async (message, _fromAgentId, _filename) => {
      await this.messageBus.routeMessage(message);

      await this.eventLog.log({
        sessionId: this.config.sessionId,
        type: "message-sent",
        data: { from: message.from, to: message.to, type: message.type },
      });

      this.emit("message", message);
    });

    // When a control command is received from an agent
    this.controlPlane.on("command", async (fromAgentId: string, command: ControlCommand) => {
      await this.handleControlCommand(fromAgentId, command);
    });

    // Sync cost tracker data back to the agent's state object
    this.costTracker.on("cost-updated", (agentId: string, cost: import("@kora/shared").AgentCost) => {
      const agent = this.agentManager.getAgent(agentId);
      if (agent) {
        agent.cost = cost;
      }

      // Session-level budget enforcement
      this.checkSessionBudget().catch(() => {});
    });

    // Budget exceeded → emit cost-threshold-reached event
    this.costTracker.on("budget-exceeded", async (agentId: string) => {
      const cost = this.costTracker.getCost(agentId)?.totalCostUsd ?? 0;
      notifications.budgetExceeded(agentId, cost);

      const agent = this.agentManager.getAgent(agentId);
      await this.eventLog.log({
        sessionId: this.config.sessionId,
        type: "cost-threshold-reached",
        data: {
          agentId,
          agentName: agent?.config.name || agentId,
          totalCostUsd: cost,
        },
      });
    });

    // Task completed — notify + check dependency unblocks
    this.database.on("task-completed", async (data: { taskId: string; title: string; assignedTo?: string }) => {
      let agentName: string | undefined;
      if (data.assignedTo) {
        const agent = this.agentManager.getAgent(data.assignedTo);
        agentName = agent?.config.name;
      }
      notificationService.taskCompleted(this.config.sessionId, data.title, agentName);

      // Phase 0: Check if completing this task unblocks other tasks
      try {
        const unblockedCount = await this.autoAssigner.checkDependencyUnblocks(data.taskId);
        if (unblockedCount > 0) {
          logger.info({ taskId: data.taskId, unblockedCount }, "[orchestrator] Tasks unblocked by completion");
        }
      } catch (err) {
        logger.warn({ err, taskId: data.taskId }, "[orchestrator] Dependency unblock check failed");
      }
    });
  }

  /** Handle a control plane command from an agent */
  private async handleControlCommand(fromAgentId: string, command: ControlCommand): Promise<void> {
    const agent = this.agentManager.getAgent(fromAgentId);
    if (!agent) return;

    switch (command.action) {
      case "spawn-agent": {
        const cmd = command as SpawnAgentCommand;
        // Check permissions
        if (!agent.config.permissions.canSpawnAgents) {
          await this.controlPlane.writeResponse(fromAgentId, {
            commandId: command.id,
            status: "error",
            error: "Agent does not have permission to spawn agents",
          });
          return;
        }
        // Check maxSubAgents
        if (agent.childAgents.length >= agent.config.permissions.maxSubAgents) {
          await this.controlPlane.writeResponse(fromAgentId, {
            commandId: command.id,
            status: "error",
            error: `Max sub-agents (${agent.config.permissions.maxSubAgents}) reached`,
          });
          return;
        }

        // Resolve provider
        const providerId = cmd.cliProvider || this.config.defaultProvider;
        const provider = this.config.providerRegistry.get(providerId);
        if (!provider) {
          await this.controlPlane.writeResponse(fromAgentId, {
            commandId: command.id, status: "error", error: `Unknown provider: ${providerId}`,
          });
          return;
        }

        // Spawn the agent
        try {
          const newAgent = await this.agentManager.spawnAgent({
            sessionId: this.config.sessionId,
            name: cmd.name,
            role: "worker",
            provider,
            model: cmd.model,
            persona: cmd.persona,
            workingDirectory: this.config.projectPath,
            runtimeDir: this.config.runtimeDir,
            spawnedBy: fromAgentId,
            initialTask: cmd.task,
            messagingMode: this.config.messagingMode,
            worktreeMode: this.config.worktreeMode,
          });

          agent.childAgents.push(newAgent.id);

          await this.controlPlane.writeResponse(fromAgentId, {
            commandId: command.id, status: "ok", data: { agentId: newAgent.id },
          });
        } catch (err) {
          await this.controlPlane.writeResponse(fromAgentId, {
            commandId: command.id, status: "error", error: String(err),
          });
        }
        break;
      }

      case "remove-agent": {
        const cmd = command as RemoveAgentCommand;
        if (!agent.config.permissions.canRemoveAgents) {
          await this.controlPlane.writeResponse(fromAgentId, {
            commandId: command.id, status: "error", error: "No permission to remove agents",
          });
          return;
        }

        try {
          await this.agentManager.stopAgent(cmd.targetAgentId, cmd.reason);
          agent.childAgents = agent.childAgents.filter(id => id !== cmd.targetAgentId);
          await this.controlPlane.writeResponse(fromAgentId, {
            commandId: command.id, status: "ok",
          });
        } catch (err) {
          await this.controlPlane.writeResponse(fromAgentId, {
            commandId: command.id, status: "error", error: String(err),
          });
        }
        break;
      }

      case "list-agents": {
        const agents = this.agentManager.listAgents().map(a => ({
          id: a.id, name: a.config.name, status: a.status,
          model: a.config.model, provider: a.config.cliProvider,
        }));
        await this.controlPlane.writeResponse(fromAgentId, {
          commandId: command.id, status: "ok", data: { agents },
        });
        break;
      }

      case "get-agent-status": {
        const cmd = command as GetAgentStatusCommand;
        const target = this.agentManager.getAgent(cmd.targetAgentId);
        await this.controlPlane.writeResponse(fromAgentId, {
          commandId: command.id,
          status: target ? "ok" : "error",
          data: target ? { id: target.id, status: target.status, model: target.config.model } : undefined,
          error: target ? undefined : "Agent not found",
        });
        break;
      }
    }
  }

  /**
   * Relay a message from one agent to another by sending it directly to the target's tmux terminal.
   * This is the reliable path -- agents don't need to check file inboxes.
   */
  async relayMessage(fromAgentId: string, toAgentId: string, message: string, messageType?: string, channel?: string): Promise<boolean> {
    const fromAgent = this.agentManager.getAgent(fromAgentId);
    const toAgent = this.agentManager.getAgent(toAgentId);
    if (!toAgent || toAgent.status !== 'running') return false;

    const relayMsg = channel
      ? `\x1b[1;36m[${channel}] ${fromAgent?.config.name || fromAgentId}\x1b[0m: ${message}`
      : fromAgent
        ? `\x1b[1;36m[Message from ${fromAgent.config.name}]\x1b[0m: ${message}`
        : `\x1b[1;32m[System message]\x1b[0m: ${message}`;

    // Check if the SENDER (master agent) is producing a blocking message
    if (fromAgent?.config.role === "master") {
      await this.checkForBlocking(fromAgentId, message);
    }

    // Persist message to SQLite BEFORE buffer/queue decision.
    // This ensures check_messages() always finds the message, even if
    // terminal delivery is delayed by blocking or prompt detection.
    try {
      this.database.insertMessage({
        id: crypto.randomUUID(),
        sessionId: this.config.sessionId,
        fromAgentId,
        toAgentId,
        messageType: messageType || "text",
        content: message,
        priority: "normal",
        createdAt: Date.now(),
        expiresAt: Date.now() + 7 * 24 * 60 * 60 * 1000, // 7 day TTL
        channel: channel || undefined,
      });
    } catch (err) {
      logger.warn({ err, from: fromAgentId, to: toAgentId }, "[orchestrator] Failed to persist message to SQLite");
    }

    // If the TARGET agent is blocked, buffer the FULL message for later replay,
    // but ALWAYS send a short notification so agent knows they have messages.
    if (this.isAgentBlocked(toAgentId)) {
      this.bufferMessage(toAgentId, fromAgentId, toAgentId, message, messageType);
      logger.debug({ from: fromAgentId, to: toAgentId }, "[orchestrator] Message buffered (target agent is blocked)");

      // Always send short notification via direct sendKeys — even for blocked agents.
      // This ensures the agent sees "you have a message" even when full content is buffered.
      const senderName = fromAgent?.config.name || fromAgentId;
      const relayMode = this.config.messagingMode || "mcp";
      const relayCmd = relayMode === "cli" ? "kora-cli messages" : "check_messages";
      const shortNotification = relayMode === "terminal" ? `[New message from ${senderName}.]` : `[New message from ${senderName}. Use ${relayCmd} tool to read it.]`;
      try {
        await this.config.tmux.sendKeys(toAgent.config.tmuxSession, shortNotification, { literal: true });
      } catch { /* non-fatal — agent terminal may be busy */ }
    } else {
      // Queue the message — delivers to terminal when agent is at a prompt
      // sqlitePersisted: true — message was already written to SQLite above, skip duplicate write in delivery
      this.messageQueue.enqueue(toAgentId, toAgent.config.tmuxSession, relayMsg, fromAgentId, undefined, { sqlitePersisted: true });
    }

    await this.eventLog.log({
      sessionId: this.config.sessionId,
      type: 'message-sent' as any,
      data: { from: fromAgentId, to: toAgentId, content: message.substring(0, 200), messageType: messageType || "text" },
    });

    // Log message-received for the target agent (for timeline filtering by agent)
    await this.eventLog.log({
      sessionId: this.config.sessionId,
      type: 'message-received',
      data: {
        agentId: toAgentId,
        from: fromAgentId,
        fromName: fromAgent?.config.name || fromAgentId,
        to: toAgentId,
        toName: toAgent.config.name,
        content: message.substring(0, 200),
        messageType: messageType || "text",
      },
    });

    return true;
  }

  // ── Orchestrator Blocking System ─────────────────────────

  /**
   * Get or create a blocking state machine for a master agent.
   */
  private getBlockingStateMachine(agentId: string): OrchestratorStateMachine {
    let sm = this.blockingStateMachines.get(agentId);
    if (!sm) {
      sm = new OrchestratorStateMachine();
      sm.on("state:blocked", (event) => {
        logger.info({ agentId, reason: event.reason }, "[orchestrator] Agent entered BLOCKED state");
        this.emit("agent-blocked", agentId, event);
      });
      sm.on("state:planning", (event) => {
        if (event.from === OrchestratorState.BLOCKED) {
          logger.info({ agentId }, "[orchestrator] Agent resumed from BLOCKED state");
          this.emit("agent-unblocked", agentId, event);
        }
      });
      this.blockingStateMachines.set(agentId, sm);
    }
    return sm;
  }

  /**
   * Scan an outgoing message from a master agent for blocking patterns.
   * If blocking is detected, transitions the agent to BLOCKED state and
   * emits events for the dashboard.
   */
  async checkForBlocking(fromAgentId: string, message: string): Promise<BlockingDecision | null> {
    if (this._replayingBuffer) return null; // Skip during buffer replay
    const agent = this.agentManager.getAgent(fromAgentId);
    if (!agent || agent.config.role !== "master") return null;

    const result = this.blockingDetector.detect(message);
    if (!result.matched) return null;

    const sm = this.getBlockingStateMachine(fromAgentId);

    // Only transition if not already blocked
    if (!sm.isBlocked()) {
      try {
        // Transition to BLOCKED (via force if needed, since we may be in any state)
        if (sm.canTransition(sm.getState(), OrchestratorState.BLOCKED)) {
          sm.transition(OrchestratorState.BLOCKED, result.reasoning.join("; "), "system");
        } else {
          sm.forceBlock(result.reasoning.join("; "));
        }
      } catch (err) {
        logger.warn({ err, agentId: fromAgentId }, "[orchestrator] Failed to transition to BLOCKED");
        return null;
      }

      // Track when blocking started (for auto-expire)
      this.blockingTimestamps.set(fromAgentId, Date.now());

      // Log blocking event
      await this.eventLog.log({
        sessionId: this.config.sessionId,
        type: "orchestrator-blocked" as any,
        data: {
          agentId: fromAgentId,
          agentName: agent.config.name,
          category: result.category,
          confidence: result.confidence,
          reason: result.reasoning.join("; "),
          method: result.method,
        },
      });

      // Notify via WebSocket
      this.emit("orchestrator-blocked", {
        agentId: fromAgentId,
        agentName: agent.config.name,
        category: result.category,
        confidence: result.confidence,
        reason: result.reasoning.join("; "),
      });
    }

    return {
      blocked: true,
      confidence: result.confidence,
      category: result.category,
      reason: result.reasoning.join("; "),
      method: result.method,
    };
  }

  /**
   * Resume a blocked orchestrator agent. Processes any buffered messages.
   */
  async resumeBlocked(agentId: string, userInput?: string): Promise<boolean> {
    const sm = this.blockingStateMachines.get(agentId);
    if (!sm || !sm.isBlocked()) return false;

    try {
      sm.transition(OrchestratorState.PLANNING, userInput || "User resumed", "user");
    } catch {
      sm.reset();
    }

    // Process buffered messages (skip blocking checks during replay)
    const buffer = this.blockingBuffers.get(agentId) || [];
    if (buffer.length > 0) {
      logger.info({ agentId, buffered: buffer.length }, "[orchestrator] Processing buffered messages after resume");
      this._replayingBuffer = true;
      try {
        for (const msg of buffer) {
          await this.relayMessage(msg.from, msg.to, msg.message, msg.messageType);
        }
      } finally {
        this._replayingBuffer = false;
      }
      this.blockingBuffers.delete(agentId);
    }

    // If user provided input, send it to the agent
    if (userInput) {
      const agent = this.agentManager.getAgent(agentId);
      if (agent) {
        await this.agentManager.sendMessage(agentId, userInput);
      }
    }

    await this.eventLog.log({
      sessionId: this.config.sessionId,
      type: "orchestrator-resumed" as any,
      data: { agentId, userInput: userInput?.substring(0, 200) },
    });

    this.emit("orchestrator-unblocked", { agentId });
    return true;
  }

  /**
   * Get blocking state for an agent.
   */
  getBlockingState(agentId: string): {
    blocked: boolean;
    state: string;
    reason?: string;
    since?: string;
    bufferedMessages: number;
  } {
    const sm = this.blockingStateMachines.get(agentId);
    if (!sm) {
      return { blocked: false, state: "idle", bufferedMessages: 0 };
    }
    const history = sm.getHistory(1);
    const lastEvent = history[history.length - 1];
    return {
      blocked: sm.isBlocked(),
      state: sm.getState(),
      reason: sm.isBlocked() && lastEvent ? lastEvent.reason : undefined,
      since: sm.isBlocked() && lastEvent ? lastEvent.timestamp : undefined,
      bufferedMessages: (this.blockingBuffers.get(agentId) || []).length,
    };
  }

  /**
   * Check if a message to a blocked orchestrator should be buffered.
   */
  isAgentBlocked(agentId: string): boolean {
    const sm = this.blockingStateMachines.get(agentId);
    if (!sm?.isBlocked()) return false;

    // Auto-expire blocking state after 5 minutes to prevent permanent blocks
    const blockedSince = this.blockingTimestamps.get(agentId);
    if (blockedSince) {
      const blockedDuration = Date.now() - blockedSince;
      if (blockedDuration > 5 * 60 * 1000) {
        logger.info({ agentId, blockedDurationMs: blockedDuration }, "[orchestrator] Auto-expiring stale blocking state (>5min)");
        this.resumeBlocked(agentId).catch(() => {});
        this.blockingTimestamps.delete(agentId);
        return false;
      }
    }

    return true;
  }

  /**
   * Buffer a message for a blocked agent.
   */
  bufferMessage(agentId: string, from: string, to: string, message: string, messageType?: string): void {
    if (!this.blockingBuffers.has(agentId)) {
      this.blockingBuffers.set(agentId, []);
    }
    const buffer = this.blockingBuffers.get(agentId)!;
    // Cap buffer at 100 messages
    if (buffer.length < 100) {
      buffer.push({ from, to, message, messageType, timestamp: new Date().toISOString() });
    }
  }

  /** Build mode-appropriate welcome notification for a newly spawned agent */
  private buildStartupNotification(agent: AgentState): string {
    const mode = this.config.messagingMode || "mcp";
    const name = agent.config.name;
    const role = agent.config.role;
    const sid = this.config.sessionId;

    const header = `\x1b[1;32m[System]\x1b[0m Welcome, ${name}. You are a ${role} agent in session "${sid}".
Your persona and instructions are loaded via system prompt.`;

    let body: string;
    if (mode === "cli") {
      body = `Use kora-cli to communicate and stay current:
  • kora-cli whoami — see your role and instructions
  • kora-cli context all — full context (team, tasks, workflow)
  • kora-cli messages — check for messages from teammates
  • kora-cli tasks — see your task assignments
Run \`kora-cli tasks\` to see if you have any assigned tasks.`;
    } else if (mode === "terminal") {
      body = `Communicate with teammates using @mentions:
  • @AgentName: your message — send to a specific agent
  • @all: your message — broadcast to everyone
Check your system prompt for your full role and team details.`;
    } else if (mode === "manual") {
      body = `Messaging is in manual mode. Check .kora/messages/inbox-${agent.id}/ for messages.`;
    } else {
      // MCP mode (default)
      body = `Use these MCP tools to stay current:
  • get_context("team") — live teammate roster
  • get_context("tasks") — your task assignments
  • get_context("all") — full context refresh
  • check_messages() — read messages from teammates
Run list_tasks() to see if you have any assigned tasks.`;
    }

    let msg = `${header}\n${body}`;

    if (this.config.worktreeMode === "shared") {
      msg += `\n\n⚠️ SHARED WORKSPACE: All agents share the same directory. Only edit files assigned to you.`;
    }

    return msg;
  }

  /** Persist current agent state to disk */
  async persistState(): Promise<void> {
    try {
      await saveAgentStates(this.config.runtimeDir, this.agentManager.listAgents());
    } catch (err) {
      logger.error({ err: err }, `[orchestrator] Failed to persist state:`);
    }
  }

  /** Force an immediate poll of all agents' usage metrics */
  async pollUsageNow(): Promise<void> {
    await this.usageMonitor.pollNow();
  }

  /**
   * Get all known agents (for cleanup/diagnostics).
   * Returns ALL agents including stopped, crashed, and running agents.
   */
  getAgents(): AgentState[] {
    return this.agentManager.listAgents();
  }

  /**
   * Restore agents from persisted state after daemon restart.
   * Checks which tmux sessions are still alive and reconnects to them.
   * Dead agents are marked as "stopped".
   */
  async restore(): Promise<{ restored: number; dead: number }> {
    const savedAgents = await loadAgentStates(this.config.runtimeDir);
    if (savedAgents.length === 0) return { restored: 0, dead: 0 };

    let restored = 0;
    let dead = 0;

    for (const agent of savedAgents) {
      const tmuxSession = agent.config.tmuxSession;
      let alive = false;

      try {
        // Check if session exists (metadata + process alive)
        alive = await this.config.tmux.hasSession(tmuxSession);

        // For holdpty: also verify the socket file exists on disk
        if (alive && this.config.tmux instanceof HoldptyController) {
          try {
            const socketPath = await this.config.tmux.getSocketPathForSession(tmuxSession);
            if (!fs.existsSync(socketPath)) {
              alive = false;
              logger.info(`[restore] Agent ${agent.config.name} (${agent.id}): socket file missing — marking as crashed`);
            }
          } catch {
            alive = false;
          }
        }

        // Double-check: verify the pane/socket is actually accessible
        if (alive) {
          await this.config.tmux.capturePane(tmuxSession, 1, false);
        }
      } catch {
        // capturePane failed — session metadata exists but socket/pane is dead
        alive = false;
        logger.info(`[restore] Agent ${agent.config.name} (${agent.id}): session exists but pane/socket is dead — marking as crashed`);
      }

      if (alive) {
        // Tmux session still running — restore the agent
        agent.status = "running";
        agent.healthCheck.consecutiveFailures = 0;

        // Re-register in agent manager (direct injection — no new tmux session)
        this.agentManager.restoreAgent(agent);

        // Re-setup message bus + control plane watchers
        await this.messageBus.setupAgent(agent.id);
        await this.controlPlane.setupAgent(agent.id);
        this.controlPlane.watchAgent(agent.id);
        this.costTracker.initAgent(agent.id);
        this.usageMonitor.startMonitoring(agent);
        this.autoRelay.startMonitoring(agent);

        // Re-register MCP agent + role for correct delivery channel and rate limits
        if (agent.config.cliProvider) {
          const provider = this.config.providerRegistry.get(agent.config.cliProvider);
          if (provider?.supportsMcp) {
            this.messageQueue.registerMcpAgent(agent.id);
          }
        }
        this.messageQueue.registerAgentRole(agent.id, agent.config.role);

        restored++;
      } else {
        // Tmux session is gone — mark as crashed so dashboard shows restart button
        agent.status = "crashed";
        // Still register so it appears in the dashboard
        this.agentManager.restoreAgent(agent);
        dead++;
      }
    }

    // Save updated state (with dead agents marked)
    await this.persistState();

    if (restored > 0 || dead > 0) {
      await this.eventLog.log({
        sessionId: this.config.sessionId,
        type: "session-resumed" as any,
        data: { restored, dead, total: savedAgents.length },
      });
    }

    return { restored, dead };
  }

  /**
   * Restart an agent — kills the old process but preserves agent ID, worktree,
   * message inbox, and task assignments. Optionally carries terminal context.
   */
  async restartAgent(
    agentId: string,
    options?: {
      contextLines?: number;
      extraContext?: string;
      carryContext?: boolean;
      summaryMode?: boolean;
      shutdownTimeoutMs?: number;
    },
  ): Promise<AgentState | null> {
    const oldAgent = this.agentManager.getAgent(agentId);
    if (!oldAgent) return null;

    const carryContext = options?.carryContext ?? true;
    const summaryMode = options?.summaryMode ?? false;
    let initialTask: string | undefined;

    if (summaryMode) {
      // Summary mode: capture extensive terminal output and build a structured summary
      let fullOutput = "";
      try {
        fullOutput = await this.config.tmux.capturePane(
          oldAgent.config.tmuxSession, 500, false,
        );
      } catch { /* agent may be dead */ }

      // Get tasks assigned to this agent
      let agentTasks: any[] = [];
      try {
        const allTasks = this.database.getTasks(this.config.sessionId);
        agentTasks = allTasks.filter((t: any) => t.assignedTo === agentId);
      } catch { /* ignore */ }
      const doneTasks = agentTasks.filter((t: any) => t.status === "done");
      const activeTasks = agentTasks.filter((t: any) => t.status !== "done");

      // Build structured summary
      const terminalLines = fullOutput.trim().split("\n").slice(-200).join("\n");
      initialTask = [
        "## Session Summary (auto-generated before restart)",
        "",
        `**Agent:** ${oldAgent.config.name} (${oldAgent.config.role})`,
        `**Provider:** ${oldAgent.config.cliProvider}`,
        oldAgent.currentTask ? `**Last task:** ${oldAgent.currentTask}` : "",
        "",
        "### Completed Tasks",
        doneTasks.length > 0
          ? doneTasks.map((t: any) => `- [DONE] ${t.title}${t.description ? `: ${t.description.slice(0, 100)}` : ""}`).join("\n")
          : "- None",
        "",
        "### Active Tasks",
        activeTasks.length > 0
          ? activeTasks.map((t: any) => `- [${t.status.toUpperCase()}] ${t.title}${t.description ? `: ${t.description.slice(0, 100)}` : ""}`).join("\n")
          : "- None",
        "",
        terminalLines ? "### Terminal Activity (last 200 lines)" : "",
        terminalLines ? "```" : "",
        terminalLines || "",
        terminalLines ? "```" : "",
        "",
        options?.extraContext ? `### Additional context:\n${options.extraContext}\n` : "",
        "You have been restarted with a fresh session. Your worktree, tasks, and messages are preserved.",
        "Review the summary above and continue from where you left off. Check your messages for any updates.",
      ].filter(Boolean).join("\n");
    } else if (carryContext) {
      const contextLines = options?.contextLines ?? 50;
      let terminalContext = "";
      try {
        terminalContext = await this.config.tmux.capturePane(
          oldAgent.config.tmuxSession, contextLines, false,
        );
      } catch {
        // Agent may already be dead
      }

      initialTask = [
        "## Recovery Context",
        "",
        "You are being restarted. Your agent ID, worktree, and message inbox are preserved.",
        oldAgent.currentTask ? `You were working on: ${oldAgent.currentTask}` : "",
        "",
        terminalContext.trim() ? "### Last terminal output before restart:" : "",
        terminalContext.trim() ? "```" : "",
        terminalContext.trim() || "",
        terminalContext.trim() ? "```" : "",
        "",
        options?.extraContext ? `### Additional context:\n${options.extraContext}\n` : "",
        "Please continue from where you left off.",
      ].filter(Boolean).join("\n");
    }

    // Save old agent config and working directory BEFORE stopping
    const oldConfig = { ...oldAgent.config };
    const oldWorkingDirectory = oldAgent.config.workingDirectory;

    // Kill old agent process but preserve worktree (restart mode)
    await this.agentManager.stopAgent(agentId, "restarted by user", options?.shutdownTimeoutMs, { skipWorktreeRemoval: true });

    const provider = this.config.providerRegistry.get(oldConfig.cliProvider);
    if (!provider) return null;

    // Spawn with same agent ID and same worktree
    const newAgent = await this.agentManager.spawnAgent({
      sessionId: this.config.sessionId,
      name: oldConfig.name,
      role: oldConfig.role,
      provider,
      model: oldConfig.model,
      persona: oldConfig.persona,
      workingDirectory: oldWorkingDirectory,
      runtimeDir: this.config.runtimeDir,
      autonomyLevel: oldConfig.autonomyLevel,
      spawnedBy: oldConfig.spawnedBy,
      extraCliArgs: oldConfig.extraCliArgs,
      envVars: oldConfig.envVars,
      initialTask,
      messagingMode: this.config.messagingMode,
      worktreeMode: "shared", // Reuse existing worktree
      forceAgentId: agentId,  // Preserve same agent ID
    });

    await this.eventLog.log({
      sessionId: this.config.sessionId,
      type: "agent-restarted" as any,
      data: { agentId: newAgent.id, reason: "restarted", preservedId: true },
    });

    await this.persistState();
    return newAgent;
  }

  /**
   * Replace an agent — kills the old one and spawns a completely fresh one.
   * New agent ID, new worktree, no context carried over.
   */
  async replaceAgent(
    agentId: string,
    options?: {
      shutdownTimeoutMs?: number;
      name?: string;
      model?: string;
      cliProvider?: string;
      persona?: string;
    },
  ): Promise<AgentState | null> {
    const oldAgent = this.agentManager.getAgent(agentId);
    if (!oldAgent) return null;

    const oldConfig = { ...oldAgent.config };

    // Kill old agent and delete worktree
    await this.agentManager.stopAgent(agentId, "replaced by user", options?.shutdownTimeoutMs);

    const providerName = options?.cliProvider || oldConfig.cliProvider;
    const provider = this.config.providerRegistry.get(providerName);
    if (!provider) return null;

    // Spawn completely fresh agent (new ID, new worktree)
    const newAgent = await this.agentManager.spawnAgent({
      sessionId: this.config.sessionId,
      name: options?.name || oldConfig.name,
      role: oldConfig.role,
      provider,
      model: options?.model || oldConfig.model,
      persona: options?.persona ?? oldConfig.persona,
      workingDirectory: oldConfig.workingDirectory,
      runtimeDir: this.config.runtimeDir,
      autonomyLevel: oldConfig.autonomyLevel,
      spawnedBy: oldConfig.spawnedBy,
      extraCliArgs: oldConfig.extraCliArgs,
      envVars: oldConfig.envVars,
      messagingMode: this.config.messagingMode,
      worktreeMode: this.config.worktreeMode,
    });

    await this.eventLog.log({
      sessionId: this.config.sessionId,
      type: "agent-restarted" as any,
      data: { oldAgentId: agentId, newAgentId: newAgent.id, reason: "replaced" },
    });

    await this.persistState();
    return newAgent;
  }

  /** Start the orchestrator (begin watching files) */
  async start(): Promise<void> {
    await this.controlPlane.loadProcessedIds();

    // Migrate existing file-based messages to SQLite (idempotent)
    await this.messageBus.migrateFilesToSqlite();

    this.messageBus.startWatching();
    this.controlPlane.startWatching();
    this.messageQueue.start();
    this.staleTaskWatchdog.start();

    // Start periodic log rotation (every 20 seconds — agents can produce
    // massive output during npm install / builds that exceeds 5MB between checks)
    this.logRotationInterval = setInterval(async () => {
      await this.rotateAgentLogs();
    }, 20 * 1000);

    // Start daily cleanup of old delivery records (prevent unbounded database growth)
    this.deliveryCleanupInterval = setInterval(() => {
      const deleted = this.database.cleanupOldDeliveries(7);
      if (deleted > 0) {
        logger.info(`[database] Cleaned up ${deleted} old delivery records (>7 days)`);
      }
    }, 24 * 60 * 60 * 1000); // 24 hours
  }

  /** Stop the orchestrator — persists state before stopping */
  async stop(): Promise<void> {
    this.usageMonitor.stopAll();
    this.staleTaskWatchdog.stop();
    this.autoRelay.stopAll();
    this.messageQueue.stop();

    // Stop log rotation interval
    if (this.logRotationInterval) {
      clearInterval(this.logRotationInterval);
      this.logRotationInterval = undefined;
    }

    // Stop delivery cleanup interval
    if (this.deliveryCleanupInterval) {
      clearInterval(this.deliveryCleanupInterval);
      this.deliveryCleanupInterval = undefined;
    }

    // Stop idle check interval
    if (this.idleCheckInterval) {
      clearInterval(this.idleCheckInterval);
      this.idleCheckInterval = undefined;
    }

    await this.persistState();
    this.messageBus.stopWatching();
    this.controlPlane.stopWatching();

    // Detach event log from database before stopping agents
    // (agent stop events would fail if DB closes first)
    this.eventLog.setDatabase(null as any);

    await this.agentManager.stopAll();

    // Kill all tmux sessions that belong to this orchestrator's session
    const agents = this.agentManager.listAgents();
    for (const agent of agents) {
      try {
        const tmuxSession = agent.config.tmuxSession;
        if (await this.config.tmux.hasSession(tmuxSession)) {
          await this.config.tmux.killSession(tmuxSession);
        }
      } catch (err) {
        logger.error({ err: err }, `[orchestrator] Failed to kill tmux session for agent ${agent.id}:`);
      }
    }

    // Clean up worktrees after all agents are stopped
    await this.agentManager.cleanupWorktrees();

    this.database.close();
  }

  /**
   * Clean up orphaned sessions that no longer have corresponding active agents.
   * This handles stale sessions from crashed agents or incomplete cleanup.
   * Works with both tmux and holdpty backends (uses listSessions + killSession interface).
   */
  async cleanup(): Promise<void> {
    try {
      // Get all sessions from the backend (tmux or holdpty)
      const allSessions = await this.config.tmux.listSessions();

      // Get active agents from this orchestrator's session
      const activeAgents = this.agentManager.listAgents();
      const activeSessionNames = new Set(activeAgents.map(a => a.config.tmuxSession));

      // Find orphaned sessions that belong to this orchestrator
      const sessionPrefix = `${getRuntimeTmuxPrefix(process.env.KORA_DEV === "1")}${this.config.sessionId}-`;
      const orphanedSessions = allSessions.filter(
        session => session.startsWith(sessionPrefix) && !activeSessionNames.has(session)
      );

      if (orphanedSessions.length > 0) {
        logger.info(`[orchestrator] Found ${orphanedSessions.length} orphaned session(s) for cleanup`);
      }

      // Kill each orphaned session
      for (const session of orphanedSessions) {
        try {
          await this.config.tmux.killSession(session);
          logger.info(`[orchestrator] Cleaned up orphaned session: ${session}`);
        } catch (err) {
          logger.error({ err: err }, `[orchestrator] Failed to kill orphaned session ${session}:`);
        }
      }
    } catch (err) {
      logger.error({ err: err }, `[orchestrator] Failed to run cleanup:`);
    }
  }

  /**
   * Rotate log file if it exceeds the maximum size.
   * Keeps only the last 1MB of the file to prevent unbounded growth.
   */
  private async rotateLogFile(logPath: string, maxSizeBytes: number = 2 * 1024 * 1024): Promise<void> {
    try {
      const fs = await import("fs/promises");
      const stats = await fs.stat(logPath);
      if (stats.size > maxSizeBytes) {
        // Keep only the last 1MB — read from offset instead of loading entire file
        const keepBytes = 1024 * 1024;
        const readOffset = stats.size - keepBytes;
        const fh = await fs.open(logPath, "r");
        try {
          const buf = Buffer.alloc(keepBytes);
          await fh.read(buf, 0, keepBytes, readOffset);
          await fh.close();
          await fs.writeFile(logPath, buf);
          logger.info(`[orchestrator] Rotated log file: ${logPath} (was ${Math.round(stats.size / 1024 / 1024)}MB)`);
        } catch (readErr) {
          await fh.close().catch(() => {});
          throw readErr;
        }
      }
    } catch (err) {
      // Catch ALL errors — never let log rotation crash the daemon
      const code = (err as NodeJS.ErrnoException).code;
      if (code !== "ENOENT") {
        logger.warn({ err, logPath }, "[orchestrator] Log rotation failed (non-fatal)");
      }
    }
  }

  /**
   * Check all agent log files and rotate any that exceed 2MB.
   * Called periodically (every 20 seconds) by the log rotation interval.
   * Uses Promise.allSettled for parallel rotation — one failure doesn't block others.
   */
  private async rotateAgentLogs(): Promise<void> {
    try {
      const agents = this.agentManager.listAgents();
      const path = await import("path");

      const results = await Promise.allSettled(
        agents.map(agent => {
          const logPath = path.default.join(this.config.runtimeDir, `${agent.id}.log`);
          return this.rotateLogFile(logPath);
        })
      );

      // Log any unexpected failures (individual rotateLogFile already catches, but belt+suspenders)
      for (const r of results) {
        if (r.status === "rejected") {
          logger.warn({ err: r.reason }, "[orchestrator] Unexpected log rotation failure (non-fatal)");
        }
      }
    } catch (err) {
      // Catch-all — log rotation must NEVER crash the daemon
      logger.warn({ err }, "[orchestrator] rotateAgentLogs failed (non-fatal)");
    }
  }
}
