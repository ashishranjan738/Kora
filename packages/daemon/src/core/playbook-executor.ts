// ============================================================
// Playbook Execution Engine
// 3 phases: SETUP (sync) → EXECUTE (async) → FINALIZE (async)
// Per-execution instance, not singleton.
// ============================================================

import { EventEmitter } from "events";
import { randomUUID } from "crypto";

import type { Orchestrator } from "./orchestrator.js";
import type { CLIProviderRegistry } from "../cli-providers/provider-registry.js";
import type { SessionConfig, AgentRole } from "@kora/shared";
import { DEFAULT_MASTER_PERMISSIONS, DEFAULT_WORKER_PERMISSIONS } from "@kora/shared";
import { buildPersona } from "./persona-builder.js";
import { logger } from "./logger.js";

// ─── Types ───────────────────────────────────────────────────

export type ExecutionStatus = "pending" | "running" | "complete" | "partial" | "failed";

export interface PlaybookAgent {
  name: string;
  role: AgentRole;
  model: string;
  persona?: string;
  cliProvider?: string;
  extraCliArgs?: string[];
  initialTask?: string;
  envVars?: Record<string, string>;
}

export interface Playbook {
  name: string;
  description?: string;
  agents: PlaybookAgent[];
  variables?: Record<string, { description?: string; default?: string; required?: boolean }>;
  tasks?: Array<{ title: string; description?: string; assignedTo?: string; dependencies?: string[] }>;
}

export interface AgentExecutionStatus {
  name: string;
  role: AgentRole;
  status: "pending" | "spawning" | "spawned" | "failed";
  agentId?: string;
  error?: string;
}

export interface PlaybookExecution {
  id: string;
  sessionId: string;
  playbookName: string;
  status: ExecutionStatus;
  agents: AgentExecutionStatus[];
  startedAt: string;
  completedAt?: string;
  error?: string;
  taskIds?: string[];
}

// ─── PlaybookExecutor ────────────────────────────────────────

export class PlaybookExecutor extends EventEmitter {
  public execution: PlaybookExecution;
  
  private interpolatedPlaybook: Playbook;

  constructor(
    private orchestrator: Orchestrator,
    private providerRegistry: CLIProviderRegistry,
    private session: SessionConfig,
    private playbook: Playbook,
    private variables: Record<string, string> = {},
    private runtimeDir: string = "",
    concurrency: number = 5,
  ) {
    super();
    this.interpolatedPlaybook = { ...playbook };

    this.execution = {
      id: randomUUID().slice(0, 12),
      sessionId: session.id,
      playbookName: playbook.name,
      status: "pending",
      agents: playbook.agents.map(a => ({
        name: a.name,
        role: a.role as AgentRole,
        status: "pending" as const,
      })),
      startedAt: new Date().toISOString(),
    };
  }

  // ─── Phase 1: SETUP (sync — throws on error) ──────────────

  setup(): PlaybookExecution {
    this.validateVariables();
    this.interpolate();
    return this.execution;
  }

  /** Validate that all required variables are provided */
  private validateVariables(): void {
    const schema = this.playbook.variables || {};
    for (const [name, def] of Object.entries(schema)) {
      if (def.required && !this.variables[name] && !def.default) {
        throw new Error(`Missing required variable: {{${name}}}`);
      }
    }
  }

  /** Interpolate {{varName}} in persona and initialTask fields */
  private interpolate(): void {
    const schema = this.playbook.variables || {};
    const resolved: Record<string, string> = {};

    // Merge defaults with provided values
    for (const [name, def] of Object.entries(schema)) {
      resolved[name] = this.variables[name] || def.default || "";
    }
    // Also include any extra variables not in schema
    for (const [name, value] of Object.entries(this.variables)) {
      if (!(name in resolved)) resolved[name] = value;
    }

    // Interpolate all agent fields
    this.interpolatedPlaybook = {
      ...this.playbook,
      agents: this.playbook.agents.map(a => ({
        ...a,
        persona: this.interpolateString(a.persona || "", resolved),
        initialTask: this.interpolateString(a.initialTask || "", resolved),
      })),
      tasks: this.playbook.tasks?.map(t => ({
        ...t,
        title: this.interpolateString(t.title, resolved),
        description: this.interpolateString(t.description || "", resolved),
      })),
    };
  }

  private interpolateString(str: string, vars: Record<string, string>): string {
    return str.replace(/\{\{(\w+)\}\}/g, (match, name) => {
      return vars[name] !== undefined ? vars[name] : match;
    });
  }

  // ─── Phase 2+3: EXECUTE + FINALIZE (async) ────────────────

  async run(task?: string): Promise<void> {
    this.execution.status = "running";
    this.emitProgress("execution-started");

    try {
      const agents = this.interpolatedPlaybook.agents;
      const masters = agents.filter(a => a.role === "master");
      const workers = agents.filter(a => a.role !== "master");

      // Phase 2a: Spawn all masters in parallel
      if (masters.length > 0) {
        const masterResults = await Promise.allSettled(
          masters.map(a => this.spawnAndTrack(a, task))
        );

        // If ANY master failed → abort
        const masterFailed = masterResults.some(r =>
          r.status === "rejected" ||
          (r.status === "fulfilled" && !r.value)
        );

        if (masterFailed) {
          this.execution.status = "failed";
          this.execution.error = "Master agent spawn failed — aborting";
          this.execution.completedAt = new Date().toISOString();
          this.emit("playbook-failed", this.execution);
          this.emitProgress("execution-failed");
          return;
        }
      }

      // Phase 2b: Spawn all workers in parallel
      if (workers.length > 0) {
        await Promise.allSettled(
          workers.map(a => this.spawnAndTrack(a))
        );
      }

      // Phase 3: FINALIZE — create tasks from playbook
      await this.createPlaybookTasks();

      // Determine final status
      const hasFailures = this.execution.agents.some(a => a.status === "failed");
      this.execution.status = hasFailures ? "partial" : "complete";
      this.execution.completedAt = new Date().toISOString();

      this.emit("playbook-complete", this.execution);
      this.emitProgress("execution-complete");

    } catch (err) {
      this.execution.status = "failed";
      this.execution.error = err instanceof Error ? err.message : String(err);
      this.execution.completedAt = new Date().toISOString();
      this.emit("playbook-failed", this.execution);
      this.emitProgress("execution-failed");
    }
  }

  /** Spawn a single agent and track its status */
  private async spawnAndTrack(agent: PlaybookAgent, initialTask?: string): Promise<boolean> {
    const agentStatus = this.execution.agents.find(a => a.name === agent.name);
    if (!agentStatus) return false;

    agentStatus.status = "spawning";
    this.emitProgress("agent-spawning", { agentName: agent.name });

    try {
      const am = this.orchestrator.agentManager;

      // Resolve provider
      const providerName = agent.cliProvider || this.session.defaultProvider || "claude-code";
      const provider = this.providerRegistry.get(providerName);
      if (!provider) throw new Error(`Provider "${providerName}" not found`);

      // Resolve model
      const model = agent.model === "default"
        ? (this.session.defaultModel || "claude-sonnet-4-6")
        : agent.model;

      // Build persona
      const peers = am.listAgents().map((a: any) => ({
        id: a.id,
        name: a.config.name,
        role: a.config.role,
        provider: a.config.cliProvider,
        model: a.config.model,
      }));

      const persona = buildPersona({
        agentId: "pending",
        role: agent.role as AgentRole,
        userPersona: agent.persona,
        permissions: agent.role === "master" ? DEFAULT_MASTER_PERMISSIONS : DEFAULT_WORKER_PERMISSIONS,
        sessionId: this.session.id,
        runtimeDir: this.runtimeDir,
        peers,
      });

      // Use the task param as initialTask for the master agent only
      const agentInitialTask = agent.role === "master" && initialTask ? initialTask : agent.initialTask;

      // Spawn
      const agentState = await am.spawnAgent({
        sessionId: this.session.id,
        name: agent.name,
        role: agent.role as AgentRole,
        provider,
        model,
        persona,
        workingDirectory: this.session.projectPath,
        runtimeDir: this.runtimeDir,
        extraCliArgs: agent.extraCliArgs,
        envVars: agent.envVars,
        initialTask: agentInitialTask,
        messagingMode: this.session.messagingMode || "mcp",
        worktreeMode: this.session.worktreeMode,
      });

      agentStatus.status = "spawned";
      agentStatus.agentId = agentState.id;
      this.emitProgress("agent-spawned", { agentName: agent.name, agentId: agentState.id });

      // Register MCP agent
      this.orchestrator.messageQueue.registerMcpAgent(agentState.id);
      this.orchestrator.messageQueue.registerAgentRole(agentState.id, agent.role);

      return true;
    } catch (err) {
      const errorMsg = err instanceof Error ? err.message : String(err);
      agentStatus.status = "failed";
      agentStatus.error = errorMsg;
      this.emitProgress("agent-failed", { agentName: agent.name, error: errorMsg });
      logger.error({ err, agentName: agent.name }, "[PlaybookExecutor] Failed to spawn agent");
      return false;
    }
  }

  /** Phase 3: Create tasks from playbook definition */
  private async createPlaybookTasks(): Promise<void> {
    const tasks = this.interpolatedPlaybook.tasks;
    if (!tasks || tasks.length === 0) return;

    const db = this.orchestrator.database;
    if (!db) return;

    const taskIds: string[] = [];
    const titleToId = new Map<string, string>();

    for (const taskDef of tasks) {
      const id = randomUUID().slice(0, 8);
      const now = new Date().toISOString();

      // Resolve assignedTo by agent name → agent ID
      let assignedTo: string | undefined;
      if (taskDef.assignedTo) {
        const agentStatus = this.execution.agents.find(a => a.name === taskDef.assignedTo);
        assignedTo = agentStatus?.agentId;
      }

      // Resolve dependency titles to IDs
      const dependencies = (taskDef.dependencies || [])
        .map(dep => titleToId.get(dep))
        .filter((id): id is string => !!id);

      db.insertTask({
        id,
        sessionId: this.session.id,
        title: taskDef.title,
        description: taskDef.description || "",
        status: "pending",
        assignedTo,
        createdBy: "playbook",
        dependencies,
        createdAt: now,
        updatedAt: now,
      });

      taskIds.push(id);
      titleToId.set(taskDef.title, id);
    }

    this.execution.taskIds = taskIds;
  }

  /** Emit a progress event */
  private emitProgress(phase: string, data?: Record<string, unknown>): void {
    this.emit("playbook-progress", {
      executionId: this.execution.id,
      sessionId: this.session.id,
      phase,
      agents: this.execution.agents,
      ...data,
    });
  }
}
