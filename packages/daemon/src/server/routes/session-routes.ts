import type { RouteDeps, Router, Request, Response } from "./route-deps.js";
import {
  APP_VERSION,
  API_VERSION,
  getRuntimeTmuxPrefix as getSessionPrefix,
  getRuntimeDaemonDir,
  SESSIONS_SUBDIR,
  DEFAULT_WORKFLOW_STATES,
} from "@kora/shared";
import type {
  DaemonStatusResponse,
  SessionResponse,
  CreateSessionRequest,
  UpdateSessionRequest,
  EventsQueryParams,
} from "@kora/shared";
import type { EventType } from "@kora/shared";
import type { WebhookConfig } from "@kora/shared";
import path from "path";
import { Orchestrator } from "../../core/orchestrator.js";
import { AutoAssigner } from "../../core/auto-assign.js";
import { EventLog } from "../../core/event-log.js";
import { WebhookNotifier } from "../../core/webhook-notifier.js";
import { saveTerminalStates } from "../../core/terminal-persistence.js";
import { validateProjectPath } from "../../core/path-validation.js";
import { logger } from "../../core/logger.js";

export function registerSessionRoutes(router: Router, deps: RouteDeps): void {
  const { sessionManager, orchestrators, providerRegistry, terminal, startTime, suggestionsDb, broadcastEvent, standaloneTerminals } = deps;
  const backend = terminal;

  // ─── Status ──────────────────────────────────────────────────────────

  router.get("/status", async (_req: Request, res: Response) => {
    try {
      const sessions = sessionManager.listSessions();
      const activeSessions = sessions.filter((s) => s.status === "active").length;

      let activeAgents = 0;
      for (const orch of orchestrators.values()) {
        activeAgents += orch.agentManager.listAgents().filter((a) => a.status === "running").length;
      }

      const uptimeSeconds = Math.floor((Date.now() - startTime) / 1000);

      // Read port from file
      let port = "N/A";
      try {
        const fs = await import("fs/promises");
        const os = await import("os");
        const nodePath = await import("path");
        const isDev = process.env.KORA_DEV === "1";
        const configDir = process.env.KORA_CONFIG_DIR || nodePath.join(os.default.homedir(), isDev ? ".kora-dev" : ".kora");
        port = (await fs.readFile(nodePath.join(configDir, "daemon.port"), "utf-8")).trim();
      } catch {}

      const response: DaemonStatusResponse = {
        alive: true,
        version: APP_VERSION,
        apiVersion: API_VERSION,
        uptime: uptimeSeconds,
        activeSessions,
        activeAgents,
        port: Number(port) || undefined,
        status: "running",
      } as any;
      res.json(response);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      res.status(500).json({ error: message });
    }
  });

  // ─── Sessions CRUD ───────────────────────────────────────────────────

  router.get("/sessions", (_req: Request, res: Response) => {
    try {
      const configs = sessionManager.listSessions();
      const sessions: SessionResponse[] = configs.map((config) => {
        const orch = orchestrators.get(config.id);
        const agents = orch ? orch.agentManager.listAgents() : [];
        const activeAgentCount = agents.filter((a) => a.status === "running").length;
        const crashedAgentCount = agents.filter((a) => a.status === "crashed").length;
        const stoppedAgentCount = agents.filter((a) => a.status === "stopped").length;
        const totalCostUsd = agents.reduce((sum, a) => sum + a.cost.totalCostUsd, 0);
        const agentSummaries = agents.map((a) => ({
          id: a.id,
          name: a.config.name,
          role: a.config.role,
          status: a.status,
          provider: a.config.cliProvider,
          model: a.config.model,
        }));
        return {
          ...config,
          agentCount: agents.length,
          activeAgentCount,
          crashedAgentCount,
          stoppedAgentCount,
          totalCostUsd,
          agentSummaries,
        };
      });
      res.json({ sessions });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      res.status(500).json({ error: message });
    }
  });

  router.post("/sessions", async (req: Request, res: Response) => {
    try {
      const body = req.body as CreateSessionRequest;
      if (!body.name || !body.projectPath) {
        res.status(400).json({ error: "name and projectPath are required" });
        return;
      }

      // Validate project path — resolve, check existence, confirm directory
      const pathValidation = validateProjectPath(body.projectPath);
      if (!pathValidation.valid) {
        res.status(400).json({ error: `Invalid projectPath: ${pathValidation.error}` });
        return;
      }

      const config = await sessionManager.createSession({
        name: body.name,
        projectPath: pathValidation.resolved,
        defaultProvider: body.defaultProvider,
        messagingMode: body.messagingMode,
        worktreeMode: body.worktreeMode,
        workflowStates: body.workflowStates,
        allowMasterForceTransition: body.allowMasterForceTransition,
      });

      // Record the working directory for autocomplete suggestions
      suggestionsDb.recordPath(body.projectPath);

      // Create an Orchestrator for this session so agents can be spawned
      const session = sessionManager.getSession(config.id);
      const orch = new Orchestrator({
        sessionId: config.id,
        projectPath: config.projectPath,
        runtimeDir: session!.runtimeDir,
        defaultProvider: config.defaultProvider,
        terminal,
        providerRegistry,
        messagingMode: config.messagingMode || "mcp",
        worktreeMode: config.worktreeMode,
      });
      await orch.start();

      // Auto-create default #all channel
      orch.database.createChannel({
        id: "#all",
        sessionId: config.id,
        name: "all",
        description: "Default channel for all agents",
        createdBy: "system",
        isDefault: true,
      });

      // Configure workflow-aware status sets for task-completed events and stale task detection
      if (config.workflowStates && config.workflowStates.length > 0) {
        orch.database.setWorkflowStatuses(config.workflowStates);
        orch.staleTaskWatchdog.setWorkflowStates(config.workflowStates);
        const firstState = config.workflowStates[0];
        const secondState = config.workflowStates.length > 1 ? config.workflowStates[1] : undefined;
        if (firstState) orch.autoAssigner = new AutoAssigner({
          sessionId: config.id,
          database: orch.database,
          agentManager: orch.agentManager,
          messageQueue: orch.messageQueue,
          eventLog: orch.eventLog,
          firstStateId: firstState.id,
          secondStateId: secondState?.id,
        });
      }
      // Wire WebSocket broadcast for message queue events (buffered/expired)
      orch.messageQueue.setBroadcastCallback((event) => {
        broadcastEvent({ ...event, sessionId: config.id });
      });
      // Wire debounced activity-changed events to WebSocket
      orch.on("agent-activity-changed", (data) => {
        broadcastEvent({ event: "agent-activity-changed", ...data });
      });
      orchestrators.set(config.id, orch);

      const agents = orch.agentManager.listAgents();

      const response: SessionResponse & { isGitRepo?: boolean } = {
        ...config,
        agentCount: agents.length,
        activeAgentCount: 0,
        crashedAgentCount: 0,
        stoppedAgentCount: 0,
        totalCostUsd: 0,
        agentSummaries: [],
        isGitRepo: pathValidation.isGitRepo,
      };
      res.status(201).json(response);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      // Client errors (invalid input) return 400
      if (message.includes("already exists") ||
          message.includes("ENOENT") ||
          message.includes("does not exist") ||
          message.includes("not found")) {
        res.status(400).json({ error: message });
      } else {
        res.status(500).json({ error: message });
      }
    }
  });

  router.get("/sessions/:sid", (req: Request, res: Response) => {
    try {
      const sid = String(req.params.sid);
      const session = sessionManager.getSession(sid);
      if (!session) {
        res.status(404).json({ error: `Session "${sid}" not found` });
        return;
      }

      const am = orchestrators.get(sid)?.agentManager;
      const agents = am ? am.listAgents() : [];
      const activeAgentCount = agents.filter((a) => a.status === "running").length;
      const crashedAgentCount = agents.filter((a) => a.status === "crashed").length;
      const stoppedAgentCount = agents.filter((a) => a.status === "stopped").length;
      const totalCostUsd = agents.reduce((sum, a) => sum + a.cost.totalCostUsd, 0);
      const agentSummaries = agents.map((a) => ({
        id: a.id,
        name: a.config.name,
        role: a.config.role,
        status: a.status,
        provider: a.config.cliProvider,
        model: a.config.model,
      }));

      const response: SessionResponse = {
        ...session.config,
        agentCount: agents.length,
        activeAgentCount,
        crashedAgentCount,
        stoppedAgentCount,
        totalCostUsd,
        agentSummaries,
      };
      res.json(response);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      res.status(500).json({ error: message });
    }
  });

  router.put("/sessions/:sid", async (req: Request, res: Response) => {
    try {
      const sid = String(req.params.sid);
      const body = req.body as UpdateSessionRequest;

      const updatedConfig = await sessionManager.updateSession(sid, body);

      const am = orchestrators.get(sid)?.agentManager;
      const agents = am ? am.listAgents() : [];
      const activeAgentCount = agents.filter((a) => a.status === "running").length;
      const crashedAgentCount = agents.filter((a) => a.status === "crashed").length;
      const stoppedAgentCount = agents.filter((a) => a.status === "stopped").length;
      const totalCostUsd = agents.reduce((sum, a) => sum + a.cost.totalCostUsd, 0);
      const agentSummaries = agents.map((a) => ({
        id: a.id, name: a.config.name, role: a.config.role,
        status: a.status, provider: a.config.cliProvider, model: a.config.model,
      }));

      const response: SessionResponse = {
        ...updatedConfig,
        agentCount: agents.length,
        activeAgentCount,
        crashedAgentCount,
        stoppedAgentCount,
        totalCostUsd,
        agentSummaries,
      };
      res.json(response);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      if (message.includes("not found")) {
        res.status(404).json({ error: message });
      } else {
        res.status(500).json({ error: message });
      }
    }
  });

  router.delete("/sessions/:sid", async (req: Request, res: Response) => {
    try {
      const sid = String(req.params.sid);

      // Stop orchestrator (stops agents, message bus, control plane, kills terminal sessions)
      const orch = orchestrators.get(sid);
      if (orch) {
        // Log to SQLite BEFORE stopping (DB closes on stop)
        try {
          orch.eventLog.log({ sessionId: sid, type: "session-stopped" as any, data: {} });
        } catch { /* non-fatal */ }

        // Run orphan cleanup first (catches stale sessions from crashes)
        await orch.cleanup();
        await orch.stop();
        orchestrators.delete(sid);
      }

      // Kill any plain terminal sessions (term-*) for this session
      try {
        const allSessions = await backend.listSessions();
        const termPrefix = `${getSessionPrefix(process.env.KORA_DEV === "1")}${sid}-term-`;
        for (const s of allSessions) {
          if (s.startsWith(termPrefix)) {
            try { await backend.killSession(s); } catch {}
          }
        }
      } catch {}

      // Clean up git worktrees and stale branches for this session
      const sessionForCleanup = sessionManager.getSession(sid);
      if (sessionForCleanup) {
        try {
          const { worktreeManager } = await import("../../core/worktree.js");
          const emptySet = new Set<string>(); // No active agents after session deletion
          const pruneResult = await worktreeManager.pruneAll(
            sessionForCleanup.config.projectPath,
            sessionForCleanup.runtimeDir,
            emptySet,
          );
          if (pruneResult.removedWorktrees.length > 0 || pruneResult.removedBranches.length > 0) {
            logger.info({
              sessionId: sid,
              removedWorktrees: pruneResult.removedWorktrees.length,
              removedBranches: pruneResult.removedBranches.length,
              skippedDirty: pruneResult.skippedDirty.length,
            }, "[api] Pruned stale worktrees on session delete");
          }
        } catch (err) {
          logger.warn({ err, sessionId: sid }, "[api] Failed to prune worktrees on session delete");
        }
      }

      // Clean up standalone terminal tracking
      standaloneTerminals.delete(sid);

      // Clean up persisted terminal state
      const session = sessionManager.getSession(sid);
      if (session) {
        try {
          await saveTerminalStates(session.runtimeDir, []); // Empty array clears the state
        } catch (err) {
          logger.debug({ err: err, sessionId: sid }, "Failed to clear terminal persistence file");
        }
      }

      // Broadcast session-stopped event
      broadcastEvent({ event: "session-stopped", sessionId: sid });

      await sessionManager.stopSession(sid);
      res.status(204).send();
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      if (message.includes("not found")) {
        res.status(404).json({ error: message });
      } else {
        res.status(500).json({ error: message });
      }
    }
  });

  router.post("/sessions/:sid/pause", async (req: Request, res: Response) => {
    try {
      const sid = String(req.params.sid);
      await sessionManager.pauseSession(sid);
      res.json({ status: "paused" });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      if (message.includes("not found")) {
        res.status(404).json({ error: message });
      } else if (message.includes("Cannot pause")) {
        res.status(400).json({ error: message });
      } else {
        res.status(500).json({ error: message });
      }
    }
  });

  router.post("/sessions/:sid/resume", async (req: Request, res: Response) => {
    try {
      const sid = String(req.params.sid);
      await sessionManager.resumeSession(sid);
      res.json({ status: "active" });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      if (message.includes("not found")) {
        res.status(404).json({ error: message });
      } else if (message.includes("Cannot resume")) {
        res.status(400).json({ error: message });
      } else {
        res.status(500).json({ error: message });
      }
    }
  });

  // ─── Webhooks CRUD ───────────────────────────────────────────────────

  router.get("/sessions/:sid/webhooks", async (req: Request, res: Response) => {
    try {
      const sid = String(req.params.sid);
      const session = sessionManager.getSession(sid);
      if (!session) {
        res.status(404).json({ error: `Session "${sid}" not found` });
        return;
      }

      const webhooks = session.config.webhooks || [];
      res.json({ webhooks });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      res.status(500).json({ error: message });
    }
  });

  router.post("/sessions/:sid/webhooks", async (req: Request, res: Response) => {
    try {
      const sid = String(req.params.sid);
      const session = sessionManager.getSession(sid);
      if (!session) {
        res.status(404).json({ error: `Session "${sid}" not found` });
        return;
      }

      const body = req.body as { url: string; events: string[]; enabled?: boolean };

      // Validate request body
      if (!body.url || typeof body.url !== "string" || !body.url.startsWith("http")) {
        res.status(400).json({ error: "Invalid webhook URL" });
        return;
      }
      if (!Array.isArray(body.events) || body.events.length === 0) {
        res.status(400).json({ error: "Webhook must have at least one event" });
        return;
      }

      const webhooks = session.config.webhooks || [];

      // Check if webhook URL already exists
      if (webhooks.some(wh => wh.url === body.url)) {
        res.status(400).json({ error: "Webhook URL already exists" });
        return;
      }

      const newWebhook: WebhookConfig = {
        url: body.url,
        events: body.events,
        enabled: body.enabled !== false, // Default to true
      };

      webhooks.push(newWebhook);
      await sessionManager.updateSession(sid, { webhooks });
      await sessionManager.save();

      res.status(201).json({ webhook: newWebhook });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      res.status(500).json({ error: message });
    }
  });

  router.put("/sessions/:sid/webhooks/:url", async (req: Request, res: Response) => {
    try {
      const sid = String(req.params.sid);
      const webhookUrl = decodeURIComponent(String(req.params.url));
      const session = sessionManager.getSession(sid);
      if (!session) {
        res.status(404).json({ error: `Session "${sid}" not found` });
        return;
      }

      const body = req.body as { events?: string[]; enabled?: boolean };
      const webhooks = session.config.webhooks || [];
      const index = webhooks.findIndex(wh => wh.url === webhookUrl);

      if (index === -1) {
        res.status(404).json({ error: "Webhook not found" });
        return;
      }

      // Update webhook
      if (body.events !== undefined) {
        if (!Array.isArray(body.events) || body.events.length === 0) {
          res.status(400).json({ error: "Webhook must have at least one event" });
          return;
        }
        webhooks[index].events = body.events;
      }
      if (body.enabled !== undefined) {
        webhooks[index].enabled = body.enabled;
      }

      await sessionManager.updateSession(sid, { webhooks });
      await sessionManager.save();

      res.json({ webhook: webhooks[index] });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      res.status(500).json({ error: message });
    }
  });

  router.delete("/sessions/:sid/webhooks/:url", async (req: Request, res: Response) => {
    try {
      const sid = String(req.params.sid);
      const webhookUrl = decodeURIComponent(String(req.params.url));
      const session = sessionManager.getSession(sid);
      if (!session) {
        res.status(404).json({ error: `Session "${sid}" not found` });
        return;
      }

      const webhooks = session.config.webhooks || [];
      const index = webhooks.findIndex(wh => wh.url === webhookUrl);

      if (index === -1) {
        res.status(404).json({ error: "Webhook not found" });
        return;
      }

      webhooks.splice(index, 1);
      await sessionManager.updateSession(sid, { webhooks });
      await sessionManager.save();

      res.status(204).send();
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      res.status(500).json({ error: message });
    }
  });

  // ── Workflow States ──────────────────────────────────────

  router.get("/sessions/:sid/workflow-states", (req: Request, res: Response) => {
    try {
      const session = sessionManager.getSession(String(req.params.sid));
      if (!session) { res.status(404).json({ error: "Session not found" }); return; }
      const states = session.config.workflowStates || DEFAULT_WORKFLOW_STATES;
      res.json({ states, frozen: true });
    } catch (err) { res.status(500).json({ error: String(err) }); }
  });

  // Update per-state instructions (instructions only — does not change states/transitions)
  router.put("/sessions/:sid/workflow-instructions", async (req: Request, res: Response) => {
    try {
      const sid = String(req.params.sid);
      const session = sessionManager.getSession(sid);
      if (!session) { res.status(404).json({ error: "Session not found" }); return; }

      const { instructions } = req.body as { instructions: Array<{ stateId: string; instructions: string }> };
      if (!Array.isArray(instructions)) {
        res.status(400).json({ error: "instructions must be an array of { stateId, instructions }" });
        return;
      }

      const MAX_INSTRUCTION_LENGTH = 5000;
      const states = session.config.workflowStates || DEFAULT_WORKFLOW_STATES;
      let updated = 0;
      for (const entry of instructions) {
        if (typeof entry.stateId !== "string" || typeof entry.instructions !== "string") continue;
        if (entry.instructions.length > MAX_INSTRUCTION_LENGTH) {
          res.status(400).json({ error: `Instructions for state "${entry.stateId}" exceed ${MAX_INSTRUCTION_LENGTH} character limit` });
          return;
        }
        const state = states.find(s => s.id === entry.stateId);
        if (state) {
          state.instructions = entry.instructions || undefined;
          updated++;
        }
      }

      session.config.workflowStates = states;
      await sessionManager.updateSession(sid, { workflowStates: states } as Partial<import("@kora/shared").SessionConfig>);

      // Notify running agents
      const orch = orchestrators.get(sid);
      if (orch) {
        const agents = orch.agentManager.listAgents().filter(a => a.status === "running");
        for (const agent of agents) {
          try {
            orch.messageQueue.enqueue(agent.id, agent.config.terminalSession, JSON.stringify({
              from: "system",
              to: agent.id,
              type: "status",
              content: `\x1b[1;33m[System]\x1b[0m Workflow state instructions updated. Run get_context("workflow") to refresh.`,
              timestamp: new Date().toISOString(),
            }));
          } catch { /* non-fatal */ }
        }
      }

      res.json({ updated, total: states.length });
    } catch (err) {
      res.status(500).json({ error: String(err) });
    }
  });

  // ─── Session Custom Models ──────────────────────────────────────────

  router.post("/sessions/:sid/models", async (req: Request, res: Response) => {
    try {
      const sid = String(req.params.sid);
      const body = req.body as { id: string; label: string; provider: string };

      if (!body.id || !body.label || !body.provider) {
        res.status(400).json({ error: "id, label, and provider are required" });
        return;
      }

      const provider = providerRegistry.get(body.provider);
      if (!provider) {
        res.status(400).json({ error: `Provider "${body.provider}" not found in registry` });
        return;
      }

      const session = sessionManager.getSession(sid);
      if (!session) {
        res.status(404).json({ error: `Session "${sid}" not found` });
        return;
      }

      // Initialize customModels map if needed
      if (!session.config.customModels) {
        session.config.customModels = {};
      }
      if (!session.config.customModels[body.provider]) {
        session.config.customModels[body.provider] = [];
      }

      // Avoid duplicates
      const existing = session.config.customModels[body.provider].find((m) => m.id === body.id);
      if (existing) {
        res.status(409).json({ error: `Custom model "${body.id}" already exists for provider "${body.provider}"` });
        return;
      }

      session.config.customModels[body.provider].push({
        id: body.id,
        label: body.label,
        provider: body.provider,
      });

      await sessionManager.updateSession(sid, {
        customModels: session.config.customModels,
      });

      res.status(201).json({ customModels: session.config.customModels });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      res.status(500).json({ error: message });
    }
  });

  router.get("/sessions/:sid/models", (req: Request, res: Response) => {
    try {
      const sid = String(req.params.sid);
      const providerParam = String(req.query.provider ?? "");

      if (!providerParam) {
        res.status(400).json({ error: "provider query parameter is required" });
        return;
      }

      const session = sessionManager.getSession(sid);
      if (!session) {
        res.status(404).json({ error: `Session "${sid}" not found` });
        return;
      }

      const provider = providerRegistry.get(providerParam);
      if (!provider) {
        res.status(404).json({ error: `Provider "${providerParam}" not found` });
        return;
      }

      const builtInModels = provider.getModels().map((m) => ({ ...m, custom: false }));
      const customModels = (session.config.customModels?.[providerParam] ?? []).map((m) => ({
        id: m.id,
        label: m.label,
        provider: m.provider,
        custom: true as const,
      }));

      res.json({ models: [...builtInModels, ...customModels] });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      res.status(500).json({ error: message });
    }
  });

  router.delete("/sessions/:sid/models/:modelId", async (req: Request, res: Response) => {
    try {
      const sid = String(req.params.sid);
      const modelId = String(req.params.modelId);
      const providerParam = String(req.query.provider ?? "");

      if (!providerParam) {
        res.status(400).json({ error: "provider query parameter is required" });
        return;
      }

      const session = sessionManager.getSession(sid);
      if (!session) {
        res.status(404).json({ error: `Session "${sid}" not found` });
        return;
      }

      const models = session.config.customModels?.[providerParam];
      if (!models) {
        res.status(404).json({ error: `No custom models found for provider "${providerParam}"` });
        return;
      }

      const index = models.findIndex((m) => m.id === modelId);
      if (index === -1) {
        res.status(404).json({ error: `Custom model "${modelId}" not found for provider "${providerParam}"` });
        return;
      }

      models.splice(index, 1);

      await sessionManager.updateSession(sid, {
        customModels: session.config.customModels,
      });

      res.status(204).send();
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      res.status(500).json({ error: message });
    }
  });

  // ─── Events (historical) ────────────────────────────────────────────

  router.get("/sessions/:sid/events", async (req: Request, res: Response) => {
    try {
      const sid = String(req.params.sid);

      const session = sessionManager.getSession(sid);
      if (!session) {
        res.status(404).json({ error: `Session "${sid}" not found` });
        return;
      }

      // Parse all query params for timeline filtering
      const since = req.query.since ? String(req.query.since) : undefined;
      const until = req.query.until ? String(req.query.until) : undefined;
      const before = req.query.before ? String(req.query.before) : undefined;
      const limit = req.query.limit ? Math.min(parseInt(req.query.limit as string), 1000) : 50;
      const type = req.query.type ? String(req.query.type) : undefined;
      const types = req.query.types ? String(req.query.types).split(",").map(t => t.trim()) : undefined;
      const agentId = req.query.agentId ? String(req.query.agentId) : undefined;
      const search = req.query.search ? String(req.query.search) : undefined;
      const order = req.query.order === "asc" ? "asc" as const : "desc" as const;

      // Use orchestrator's event log (has database attached) or create standalone
      const orch = orchestrators.get(sid);
      const eventLog = orch ? orch.eventLog : new EventLog(session.runtimeDir);

      const [events, total] = await Promise.all([
        eventLog.query({
          sessionId: sid,
          since,
          until,
          before,
          limit,
          type: type as EventType | undefined,
          types,
          agentId,
          search,
          order,
        }),
        eventLog.count({
          sessionId: sid,
          since,
          until,
          before,
          type: type as EventType | undefined,
          types,
          agentId,
          search,
        }),
      ]);

      res.json({
        events,
        pagination: {
          total,
          limit,
          hasMore: events.length === limit,
          nextBefore: events.length > 0 ? events[events.length - 1].timestamp : undefined,
        },
      });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      res.status(500).json({ error: message });
    }
  });

  // Force-refresh usage metrics for all agents in a session (non-invasive terminal poll)
  router.post("/sessions/:sid/poll-usage", async (req: Request, res: Response) => {
    try {
      const sid = String(req.params.sid);
      const orch = orchestrators.get(sid);
      if (!orch) { res.status(404).json({ error: "Session not found" }); return; }
      await orch.pollUsageNow();
      res.json({ polled: true });
    } catch (err) {
      res.status(500).json({ error: String(err) });
    }
  });

  router.post("/sessions/:sid/restart-all", async (req: Request, res: Response) => {
    try {
      const sid = String(req.params.sid);
      const body = req.body as { carryContext?: boolean } | undefined;
      const orch = orchestrators.get(sid);
      if (!orch) { res.status(404).json({ error: "Session not found" }); return; }

      const agents = orch.agentManager.listAgents().filter(a => a.status === "running");
      const results = await Promise.all(agents.map(async (agent) => {
        try {
          const newAgent = await orch.restartAgent(agent.id, {
            carryContext: body?.carryContext ?? false,
            shutdownTimeoutMs: 3000,
          });
          return { oldId: agent.id, newId: newAgent?.id, name: agent.config.name, success: true };
        } catch (err) {
          return { oldId: agent.id, name: agent.config.name, success: false, error: String(err) };
        }
      }));
      res.json({ restarted: results.length, results });
    } catch (err) {
      res.status(500).json({ error: String(err) });
    }
  });
}
