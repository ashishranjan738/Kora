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
import { AgentManager } from "./agent-manager.js";
import { MessageBus } from "./message-bus.js";
import { AgentControlPlane } from "./agent-control-plane.js";
import { EventLog } from "./event-log.js";
import { AppDatabase } from "./database.js";
import { CostTracker } from "./cost-tracker.js";
import { AgentHealthMonitor } from "./agent-health.js";
import { TmuxController } from "./tmux-controller.js";
import type { CLIProviderRegistry } from "../cli-providers/provider-registry.js";
import { UsageMonitor } from "./usage-monitor.js";
import { AutoRelay } from "./auto-relay.js";
import { MessageQueue } from "./message-queue.js";
import { notifications } from "./notifications.js";
import { saveAgentStates, loadAgentStates } from "./state-persistence.js";

export interface OrchestratorConfig {
  sessionId: string;
  projectPath: string;
  runtimeDir: string;
  defaultProvider: string;
  tmux: TmuxController;
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

  constructor(private config: OrchestratorConfig) {
    super();

    // Initialize SQLite database
    this.database = new AppDatabase(config.runtimeDir);

    const healthMonitor = new AgentHealthMonitor(config.tmux);
    this.agentManager = new AgentManager(config.tmux, healthMonitor);
    this.messageBus = new MessageBus(config.runtimeDir);
    this.controlPlane = new AgentControlPlane(config.runtimeDir);
    this.eventLog = new EventLog(config.runtimeDir);
    this.eventLog.setDatabase(this.database);
    this.costTracker = new CostTracker();
    this.usageMonitor = new UsageMonitor(
      config.tmux,
      this.costTracker,
      (agentId: string) => {
        const agent = this.agentManager.getAgent(agentId);
        if (!agent) return undefined;
        return config.providerRegistry.get(agent.config.cliProvider);
      },
    );
    this.autoRelay = new AutoRelay(config.tmux, this.agentManager, this.eventLog, config.sessionId, config.messagingMode);
    this.messageQueue = new MessageQueue(config.tmux, config.runtimeDir, config.messagingMode || "mcp");
    this.autoRelay.setMessageQueue(this.messageQueue);

    this.wireEvents();
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
      notifications.agentCrashed(agentId);
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
      console.error(`[orchestrator] Failed to persist state:`, err);
    }
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
      const alive = await this.config.tmux.hasSession(tmuxSession);

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
        // Tmux session is gone — mark as stopped
        agent.status = "stopped";
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
    options?: { contextLines?: number; extraContext?: string; freshStart?: boolean },
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
    await this.agentManager.stopAgent(agentId, freshStart ? "fresh restart by user" : "replaced by user");

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

    // Start periodic log rotation (every 60 seconds)
    this.logRotationInterval = setInterval(async () => {
      await this.rotateAgentLogs();
    }, 60 * 1000);
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
        console.error(`[orchestrator] Failed to kill tmux session for agent ${agent.id}:`, err);
      }
    }

    // Clean up worktrees after all agents are stopped
    await this.agentManager.cleanupWorktrees();

    this.database.close();
  }

  /**
   * Clean up orphaned tmux sessions that no longer have corresponding active agents.
   * This handles stale sessions from crashed agents or incomplete cleanup.
   */
  async cleanup(): Promise<void> {
    try {
      // Get all tmux sessions
      const allSessions = await this.config.tmux.listSessions();

      // Get active agents from this orchestrator's session
      const activeAgents = this.agentManager.listAgents();
      const activeSessionNames = new Set(activeAgents.map(a => a.config.tmuxSession));

      // Find orphaned sessions that belong to this orchestrator (start with sessionId-)
      const sessionPrefix = `${this.config.sessionId}-`;
      const orphanedSessions = allSessions.filter(
        session => session.startsWith(sessionPrefix) && !activeSessionNames.has(session)
      );

      // Kill each orphaned session
      for (const session of orphanedSessions) {
        try {
          await this.config.tmux.killSession(session);
          console.log(`[orchestrator] Cleaned up orphaned tmux session: ${session}`);
        } catch (err) {
          console.error(`[orchestrator] Failed to kill orphaned session ${session}:`, err);
        }
      }
    } catch (err) {
      console.error(`[orchestrator] Failed to run cleanup:`, err);
    }
  }

  /**
   * Rotate log file if it exceeds the maximum size.
   * Keeps only the last 1MB of the file to prevent unbounded growth.
   */
  private async rotateLogFile(logPath: string, maxSizeBytes: number = 5 * 1024 * 1024): Promise<void> {
    try {
      const fs = await import("fs/promises");
      const stats = await fs.stat(logPath);
      if (stats.size > maxSizeBytes) {
        // Keep only the last 1MB of the file
        const content = await fs.readFile(logPath, "utf-8");
        const truncated = content.slice(-1024 * 1024); // last 1MB
        await fs.writeFile(logPath, truncated, "utf-8");
        console.log(`[orchestrator] Rotated log file: ${logPath} (was ${Math.round(stats.size / 1024 / 1024)}MB)`);
      }
    } catch (err) {
      // File may not exist or be inaccessible — this is not a critical error
      if ((err as NodeJS.ErrnoException).code !== 'ENOENT') {
        console.error(`[orchestrator] Failed to rotate log file ${logPath}:`, err);
      }
    }
  }

  /**
   * Check all agent log files and rotate any that exceed 5MB.
   * Called periodically (every 60 seconds) by the log rotation interval.
   */
  private async rotateAgentLogs(): Promise<void> {
    const agents = this.agentManager.listAgents();
    const path = await import("path");

    for (const agent of agents) {
      const logPath = path.default.join(this.config.runtimeDir, `${agent.id}.log`);
      await this.rotateLogFile(logPath);
    }
  }
}
