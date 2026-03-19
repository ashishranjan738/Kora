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
  public messageBus: MessageBus;
  public controlPlane: AgentControlPlane;
  public eventLog: EventLog;
  public costTracker: CostTracker;
  public database: AppDatabase;
  private usageMonitor: UsageMonitor;
  private autoRelay: AutoRelay;
  public messageQueue: MessageQueue;
  private logRotationInterval?: NodeJS.Timeout;
  private lastIdleNotification = new Map<string, number>();
  private idleCheckInterval?: NodeJS.Timeout;

  constructor(private config: OrchestratorConfig) {
    super();

    // Initialize SQLite database
    this.database = new AppDatabase(config.runtimeDir);

    const healthMonitor = new AgentHealthMonitor(config.tmux);
    this.agentManager = new AgentManager(config.tmux, healthMonitor);

    // Pass agents map to health monitor for idle detection
    healthMonitor.setAgentsMap(this.agentManager.getAgentsMap());
    this.messageBus = new MessageBus(config.runtimeDir);
    this.controlPlane = new AgentControlPlane(config.runtimeDir);
    this.eventLog = new EventLog(config.runtimeDir);
    this.eventLog.setDatabase(this.database);
    this.costTracker = new CostTracker();
    this.usageMonitor = new UsageMonitor(
      config.tmux,
      this.costTracker,
    );
    this.autoRelay = new AutoRelay(config.tmux, this.agentManager, this.eventLog, config.sessionId, config.messagingMode);
    this.messageQueue = new MessageQueue(config.tmux, config.runtimeDir, config.messagingMode || "mcp");
    this.autoRelay.setMessageQueue(this.messageQueue);

    // Wire re-notification callbacks so MessageQueue can check unread counts
    this.messageQueue.setRenotifyCallbacks(
      (agentId: string) => this.messageBus.getUnreadCount(agentId),
      (agentId: string) => {
        const agent = this.agentManager.getAgent(agentId);
        return agent?.config.tmuxSession || null;
      },
    );

    // Wire delivery tracking (Tier 3 event routing)
    this.messageQueue.setDeliveryTracking(this.database, config.sessionId);

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
      }
    }, 60_000); // Check every minute
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
        const msg = `\x1b[1;32m[System]\x1b[0m New agent joined the team: "${agent.config.name}" (${agent.id}), role: ${agent.config.role}`;
        await this.messageBus.deliverToInbox(existing.id, {
          id: crypto.randomUUID(),
          from: 'system',
          to: existing.id,
          type: 'status',
          content: msg,
          timestamp: new Date().toISOString(),
        });
      }

      this.emit("agent-update", agent);
      await this.persistState();
    });

    // When an agent is removed
    this.agentManager.on("agent-removed", async (agentId: string, reason: string) => {
      this.usageMonitor.stopMonitoring(agentId);
      this.autoRelay.stopMonitoring(agentId);
      this.messageQueue.removeAgent(agentId);
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
        const msg = `\x1b[1;32m[System]\x1b[0m Agent "${agentId}" has been removed from the team. Reason: ${reason}`;
        await this.messageBus.deliverToInbox(remaining.id, {
          id: crypto.randomUUID(),
          from: 'system',
          to: remaining.id,
          type: 'status',
          content: msg,
          timestamp: new Date().toISOString(),
        });
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
    });

    // Budget exceeded
    this.costTracker.on("budget-exceeded", (agentId: string) => {
      notifications.budgetExceeded(agentId, this.costTracker.getCost(agentId)?.totalCostUsd ?? 0);
    });

    // Task completed
    this.database.on("task-completed", (data: { taskId: string; title: string; assignedTo?: string }) => {
      let agentName: string | undefined;
      if (data.assignedTo) {
        const agent = this.agentManager.getAgent(data.assignedTo);
        agentName = agent?.config.name;
      }
      notificationService.taskCompleted(this.config.sessionId, data.title, agentName);
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
  async relayMessage(fromAgentId: string, toAgentId: string, message: string, messageType?: string): Promise<boolean> {
    const fromAgent = this.agentManager.getAgent(fromAgentId);
    const toAgent = this.agentManager.getAgent(toAgentId);
    if (!toAgent || toAgent.status !== 'running') return false;

    const relayMsg = fromAgent
      ? `\x1b[1;36m[Message from ${fromAgent.config.name}]\x1b[0m: ${message}`
      : `\x1b[1;32m[System message]\x1b[0m: ${message}`;

    // Queue the message instead of sending immediately — delivers when agent is at a prompt
    this.messageQueue.enqueue(toAgentId, toAgent.config.tmuxSession, relayMsg, fromAgentId);

    await this.eventLog.log({
      sessionId: this.config.sessionId,
      type: 'message-sent' as any,
      data: { from: fromAgentId, to: toAgentId, content: message.substring(0, 200), messageType: messageType || "text" },
    });

    return true;
  }

  /** Persist current agent state to disk */
  async persistState(): Promise<void> {
    try {
      await saveAgentStates(this.config.runtimeDir, this.agentManager.listAgents());
    } catch (err) {
      logger.error({ err: err }, `[orchestrator] Failed to persist state:`);
    }
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
   * Replace an agent — kills the old one and spawns a fresh one with the same
   * config. Captures the last N lines of terminal output as context for the new agent.
   * Useful when agents hallucinate or get stuck.
   */
  async replaceAgent(
    agentId: string,
    options?: { contextLines?: number; extraContext?: string; freshStart?: boolean; shutdownTimeoutMs?: number },
  ): Promise<AgentState | null> {
    const oldAgent = this.agentManager.getAgent(agentId);
    if (!oldAgent) return null;

    const freshStart = options?.freshStart ?? false;
    let initialTask: string | undefined;

    if (!freshStart) {
      // Capture terminal context from the old agent for continuity
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
        "You are replacing a previous agent that was working on this task.",
        oldAgent.currentTask ? `The previous agent was working on: ${oldAgent.currentTask}` : "",
        "",
        terminalContext.trim() ? "### Last terminal output from the previous agent:" : "",
        terminalContext.trim() ? "```" : "",
        terminalContext.trim() || "",
        terminalContext.trim() ? "```" : "",
        "",
        options?.extraContext ? `### Additional context:\n${options.extraContext}\n` : "",
        "Please continue from where the previous agent left off. If the previous agent was stuck or making mistakes, take a different approach.",
      ].filter(Boolean).join("\n");
    }

    // Save old agent config
    const oldConfig = { ...oldAgent.config };

    // Kill old agent
    await this.agentManager.stopAgent(agentId, freshStart ? "fresh restart by user" : "replaced by user", options?.shutdownTimeoutMs);

    // Resolve provider
    const provider = this.config.providerRegistry.get(oldConfig.cliProvider);
    if (!provider) return null;

    // Spawn fresh agent with same config
    const newAgent = await this.agentManager.spawnAgent({
      sessionId: this.config.sessionId,
      name: oldConfig.name,
      role: oldConfig.role,
      provider,
      model: oldConfig.model,
      persona: oldConfig.persona,
      workingDirectory: oldConfig.workingDirectory,
      runtimeDir: this.config.runtimeDir,
      autonomyLevel: oldConfig.autonomyLevel,
      spawnedBy: oldConfig.spawnedBy,
      extraCliArgs: oldConfig.extraCliArgs,
      envVars: oldConfig.envVars,
      initialTask,
      messagingMode: this.config.messagingMode,
      worktreeMode: this.config.worktreeMode,
    });

    await this.eventLog.log({
      sessionId: this.config.sessionId,
      type: "agent-restarted" as any,
      data: { oldAgentId: agentId, newAgentId: newAgent.id, reason: "replaced" },
    });

    return newAgent;
  }

  /** Start the orchestrator (begin watching files) */
  async start(): Promise<void> {
    await this.controlPlane.loadProcessedIds();
    this.messageBus.startWatching();
    this.controlPlane.startWatching();
    this.messageQueue.start();

    // Start periodic log rotation (every 20 seconds — agents can produce
    // massive output during npm install / builds that exceeds 5MB between checks)
    this.logRotationInterval = setInterval(async () => {
      await this.rotateAgentLogs();
    }, 20 * 1000);
  }

  /** Stop the orchestrator — persists state before stopping */
  async stop(): Promise<void> {
    this.usageMonitor.stopAll();
    this.autoRelay.stopAll();
    this.messageQueue.stop();

    // Stop log rotation interval
    if (this.logRotationInterval) {
      clearInterval(this.logRotationInterval);
      this.logRotationInterval = undefined;
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
        // Keep only the last 1MB of the file
        const content = await fs.readFile(logPath, "utf-8");
        const truncated = content.slice(-1024 * 1024); // last 1MB
        await fs.writeFile(logPath, truncated, "utf-8");
        logger.info(`[orchestrator] Rotated log file: ${logPath} (was ${Math.round(stats.size / 1024 / 1024)}MB)`);
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
