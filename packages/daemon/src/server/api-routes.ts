import { randomUUID } from "crypto";
import path from "path";
import { Router } from "express";
import type { Request, Response } from "express";
import type { WebSocketServer } from "ws";
import {
  APP_VERSION,
  API_VERSION,
  getRuntimeTmuxPrefix,
  getRuntimeDaemonDir,
  SESSIONS_SUBDIR,
  DEFAULT_WORKFLOW_STATES,
} from "@kora/shared";
import type {
  DaemonStatusResponse,
  SessionResponse,
  CreateSessionRequest,
  UpdateSessionRequest,
  SpawnAgentRequest,
  SendMessageRequest,
  ChangeModelRequest,
  CreateTaskRequest,
  UpdateTaskRequest,
  EventsQueryParams,
  ProviderResponse,
} from "@kora/shared";
import type { EventType } from "@kora/shared";
import type { SessionManager } from "../core/session-manager.js";
import { Orchestrator } from "../core/orchestrator.js";
import type { CLIProviderRegistry } from "../cli-providers/provider-registry.js";
import type { IPtyBackend } from "../core/pty-backend.js";
import type { SuggestionsDatabase } from "../core/suggestions-db.js";
import type { PlaybookDatabase } from "../core/playbook-database.js";
import { EventLog } from "../core/event-log.js";
import { listPlaybooks, loadPlaybook, savePlaybook } from "../core/playbook-loader.js";
import { validateYAMLPlaybook } from "../core/playbook-validator.js";
import * as yaml from "js-yaml";
import { buildPersona } from "../core/persona-builder.js";
import { discoverModels } from "../core/model-discovery.js";
import { DEFAULT_MASTER_PERMISSIONS, DEFAULT_WORKER_PERMISSIONS } from "@kora/shared";
import { logger } from "../core/logger.js";
import { saveTerminalStates, loadTerminalStates, restoreTerminalsWithHealthCheck } from "../core/terminal-persistence.js";
import type { StandaloneTerminal } from "../core/terminal-persistence.js";
import { WebhookNotifier } from "../core/webhook-notifier.js";
import type { WebhookConfig } from "@kora/shared";
import { analyzeTerminalOutput } from "../core/terminal-analyzer.js";
import { computeTaskMetrics, TaskMetricsDebouncer } from "../core/task-metrics.js";

// Cache strip-ansi import (ESM module loaded once at startup)
let stripAnsiFunc: ((text: string) => string) | null = null;
(async () => {
  const stripAnsiModule = await import("strip-ansi");
  stripAnsiFunc = stripAnsiModule.default;
})();

// Output cache to avoid repeated capturePane calls
interface CachedOutput {
  raw: string;
  timestamp: number;
  lines: string[];
}

class AgentOutputCache {
  private cache = new Map<string, CachedOutput>();
  private readonly TTL = 2000; // 2 seconds

  get(agentId: string): CachedOutput | null {
    const cached = this.cache.get(agentId);
    if (!cached) return null;

    // Check if cache is still valid
    if (Date.now() - cached.timestamp > this.TTL) {
      this.cache.delete(agentId);
      return null;
    }

    return cached;
  }

  set(agentId: string, raw: string, lines: string[]): void {
    this.cache.set(agentId, {
      raw,
      timestamp: Date.now(),
      lines,
    });
  }

  clear(agentId: string): void {
    this.cache.delete(agentId);
  }
}

const outputCache = new AgentOutputCache();

export function createApiRouter(deps: {
  sessionManager: SessionManager;
  orchestrators: Map<string, Orchestrator>;  // sessionId -> Orchestrator
  providerRegistry: CLIProviderRegistry;
  tmux: IPtyBackend;
  startTime: number;  // Date.now() at daemon start
  globalConfigDir: string;
  suggestionsDb: SuggestionsDatabase;
  playbookDb: PlaybookDatabase;
}, wss: WebSocketServer): Router {
  const { sessionManager, orchestrators, providerRegistry, tmux, startTime, globalConfigDir, suggestionsDb, playbookDb } = deps;
  const router = Router();

  // Track standalone terminal sessions per session (id → terminal info)
  const standaloneTerminals = new Map<string, Map<string, StandaloneTerminal>>();

  // Restore standalone terminals from disk on daemon startup
  (async () => {
    const sessions = sessionManager.listSessions();
    for (const sessionConfig of sessions) {
      if (sessionConfig.status === "stopped") continue;

      try {
        const runtimeDir = path.join(sessionConfig.projectPath, getRuntimeDaemonDir(process.env.KORA_DEV === "1"), SESSIONS_SUBDIR, sessionConfig.id);
        const persisted = await loadTerminalStates(runtimeDir);
        if (persisted.length === 0) continue;

        // Verify each terminal's session exists AND socket file is accessible (for holdpty)
        const { alive, dead } = await restoreTerminalsWithHealthCheck(tmux, persisted, sessionConfig.id);

        // Populate in-memory Map with alive terminals
        if (alive.length > 0) {
          const termMap = new Map<string, StandaloneTerminal>();
          alive.forEach(t => termMap.set(t.id, t));
          standaloneTerminals.set(sessionConfig.id, termMap);

          logger.info({ sessionId: sessionConfig.id, restored: alive.length, dead: dead.length }, "Restored standalone terminals");
        }

        // Re-persist if any terminals died (clean up stale entries)
        if (dead.length > 0) {
          await saveTerminalStates(runtimeDir, alive);
        }
      } catch (err) {
        logger.error({ err: err, sessionId: sessionConfig.id }, "Failed to restore standalone terminals");
      }
    }
  })();

  // Helper function to persist standalone terminals for a session to disk
  const persistTerminalsForSession = async (sessionId: string): Promise<void> => {
    const session = sessionManager.getSession(sessionId);
    if (!session) return;

    const terminals = standaloneTerminals.get(sessionId);
    const terminalArray = terminals ? Array.from(terminals.values()) : [];

    try {
      const runtimeDir = session.runtimeDir;
      await saveTerminalStates(runtimeDir, terminalArray);
    } catch (err) {
      logger.error({ err: err, sessionId }, "Failed to persist terminal states");
    }
  };

  // Helper function to broadcast events to dashboard WebSocket clients only.
  // Terminal connections (wsType === 'terminal') are excluded to prevent
  // raw JSON from appearing in agent terminal output.
  // Respects Tier 1 (session) and Tier 2 (event-type) filters.
  // Also sends webhook notifications if configured (fire-and-forget).
  const broadcastEvent = (event: any) => {
    const message = JSON.stringify(event);
    wss.clients.forEach((client) => {
      if (client.readyState !== 1 || (client as any).wsType === 'terminal') {
        return; // Skip terminal connections and non-ready clients
      }

      // Check session filter (Tier 1)
      const subscribedSessionId = (client as any).subscribedSessionId as string | undefined;
      if (subscribedSessionId && event.sessionId && event.sessionId !== subscribedSessionId) {
        return; // Client only wants events from a specific session
      }

      // Check event type filter (Tier 2)
      const subscribedEventTypes = (client as any).subscribedEventTypes as Set<string> | undefined;
      if (subscribedEventTypes && !subscribedEventTypes.has('*')) {
        if (!event.event || !subscribedEventTypes.has(event.event)) {
          return; // Client is not subscribed to this event type
        }
      }

      client.send(message);
    });

    // Send webhook notifications if configured (fire-and-forget)
    if (event.sessionId) {
      const session = sessionManager.getSession(event.sessionId);
      if (session?.config.webhooks && session.config.webhooks.length > 0) {
        const notifier = new WebhookNotifier(session.config.webhooks);
        notifier.notify({
          ...event,
          timestamp: Date.now(),
        }).catch(err => {
          logger.warn({ err, sessionId: event.sessionId, eventType: event.event }, "Failed to send webhook notification");
        });
      }
    }
  };

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

      const config = await sessionManager.createSession({
        name: body.name,
        projectPath: body.projectPath,
        defaultProvider: body.defaultProvider,
        messagingMode: body.messagingMode,
        worktreeMode: body.worktreeMode,
        workflowStates: body.workflowStates,
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
        tmux,
        providerRegistry,
        messagingMode: config.messagingMode || "mcp",
        worktreeMode: config.worktreeMode,
      });
      await orch.start();
      // Wire WebSocket broadcast for message queue events (buffered/expired)
      orch.messageQueue.setBroadcastCallback((event) => {
        broadcastEvent({ ...event, sessionId: config.id });
      });
      orchestrators.set(config.id, orch);

      const agents = orch.agentManager.listAgents();

      const response: SessionResponse = {
        ...config,
        agentCount: agents.length,
        activeAgentCount: 0,
        crashedAgentCount: 0,
        stoppedAgentCount: 0,
        totalCostUsd: 0,
        agentSummaries: [],
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

      // Stop orchestrator (stops agents, message bus, control plane, kills tmux sessions)
      const orch = orchestrators.get(sid);
      if (orch) {
        // Run orphan cleanup first (catches stale sessions from crashes)
        await orch.cleanup();
        await orch.stop();
        orchestrators.delete(sid);
      }

      // Kill any plain terminal tmux sessions (term-*) for this session
      try {
        const allTmuxSessions = await tmux.listSessions();
        const termPrefix = `${getRuntimeTmuxPrefix(process.env.KORA_DEV === "1")}${sid}-term-`;
        for (const s of allTmuxSessions) {
          if (s.startsWith(termPrefix)) {
            try { await tmux.killSession(s); } catch {}
          }
        }
      } catch {}

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

      // Log to SQLite for timeline
      const orch_ss = orchestrators.get(sid);
      if (orch_ss) {
        orch_ss.eventLog.log({ sessionId: sid, type: "session-stopped" as any, data: {} });
      }

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

  // ─── Agents CRUD ─────────────────────────────────────────────────────

  router.get("/sessions/:sid/agents", async (req: Request, res: Response) => {
    try {
      const sid = String(req.params.sid);
      const session = sessionManager.getSession(sid);
      if (!session) {
        res.status(404).json({ error: `Session "${sid}" not found` });
        return;
      }

      const am = orchestrators.get(sid)?.agentManager;
      const agents = am ? am.listAgents() : [];

      const orch = orchestrators.get(sid);

      // Enrich agents with unread message count (activity is now tracked in agent state)
      const enrichedAgents = await Promise.all(agents.map(async (agent) => {
        // Get unread message count
        let unreadMessages = 0;
        if (orch) {
          try {
            unreadMessages = await orch.messageBus.getUnreadCount(agent.id);
          } catch { /* ignore */ }
        }

        return { ...agent, unreadMessages };
      }));

      res.json({ agents: enrichedAgents });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      res.status(500).json({ error: message });
    }
  });

  router.post("/sessions/:sid/agents", async (req: Request, res: Response) => {
    try {
      const sid = String(req.params.sid);
      const body = req.body as SpawnAgentRequest;

      if (!body.name || !body.role) {
        res.status(400).json({ error: "name and role are required" });
        return;
      }
      // model is optional — empty/"default" means use CLI's configured default

      const session = sessionManager.getSession(sid);
      if (!session) {
        res.status(404).json({ error: `Session "${sid}" not found` });
        return;
      }

      const am = orchestrators.get(sid)?.agentManager;
      if (!am) {
        res.status(500).json({ error: `No Orchestrator found for session "${sid}"` });
        return;
      }

      // Resolve the CLI provider
      // Accept both "cliProvider" (SpawnAgentRequest type) and "provider" (dashboard sends this)
      const providerId = body.cliProvider ?? (body as any).provider ?? session.config.defaultProvider;
      const provider = providerRegistry.get(providerId);
      if (!provider) {
        res.status(400).json({ error: `Provider "${providerId}" not found` });
        return;
      }

      // Model IDs are passed through to the CLI as-is.
      // We don't reject unknown models — users may use custom/fine-tuned model names
      // that aren't in our built-in list. The CLI will validate them.

      // Build full persona with communication protocol + control plane instructions
      const permissions = body.role === "master"
        ? { ...DEFAULT_MASTER_PERMISSIONS }
        : { ...DEFAULT_WORKER_PERMISSIONS };

      // Get current running agents as peers for the new agent
      const existingAgents = am.listAgents().filter(a => a.status === 'running');
      const peers = existingAgents.map(a => ({
        id: a.id,
        name: a.config.name,
        role: a.config.role,
        provider: a.config.cliProvider,
        model: a.config.model,
      }));

      const fullPersona = buildPersona({
        agentId: `pending`, // will be replaced with actual ID inside spawnAgent
        role: body.role,
        userPersona: body.persona,
        permissions,
        sessionId: sid,
        runtimeDir: session.runtimeDir,
        peers,
        projectPath: session.config.projectPath,
        workflowStates: session.config.workflowStates,
      });

      const agentState = await am.spawnAgent({
        sessionId: sid,
        name: body.name,
        role: body.role,
        provider,
        model: body.model,
        persona: fullPersona,
        workingDirectory: body.workingDirectory ?? session.config.projectPath,
        runtimeDir: session.runtimeDir,
        autonomyLevel: body.autonomyLevel,
        extraCliArgs: body.extraCliArgs,
        skipArgValidation: body.skipArgValidation,
        envVars: body.envVars,
        initialTask: body.initialTask,
        messagingMode: session.config.messagingMode || "mcp",
        worktreeMode: session.config.worktreeMode,
      });

      // Record CLI flags and provider/model for autocomplete suggestions
      if (body.extraCliArgs && body.extraCliArgs.length > 0) {
        suggestionsDb.recordFlags(body.extraCliArgs.join(" "));
      }
      suggestionsDb.recordAgentConfig(providerId, body.model || "default");

      // Broadcast agent-spawned event via WebSocket
      broadcastEvent({ event: "agent-spawned", sessionId: sid, agentId: agentState.id });

      res.status(201).json(agentState);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      res.status(500).json({ error: message });
    }
  });

  router.get("/sessions/:sid/agents/:aid", (req: Request, res: Response) => {
    try {
      const { sid, aid } = req.params;

      const session = sessionManager.getSession(String(sid));
      if (!session) {
        res.status(404).json({ error: `Session "${sid}" not found` });
        return;
      }

      const am = orchestrators.get(String(sid))?.agentManager;
      const agent = am?.getAgent(String(aid));
      if (!agent) {
        res.status(404).json({ error: `Agent "${aid}" not found in session "${sid}"` });
        return;
      }

      res.json(agent);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      res.status(500).json({ error: message });
    }
  });

  router.delete("/sessions/:sid/agents/:aid", async (req: Request, res: Response) => {
    try {
      const { sid, aid } = req.params;

      const am = orchestrators.get(String(sid))?.agentManager;
      if (!am) {
        res.status(404).json({ error: `Session "${sid}" not found` });
        return;
      }

      const agent = am.getAgent(String(aid));
      if (!agent) {
        res.status(404).json({ error: `Agent "${aid}" not found in session "${sid}"` });
        return;
      }

      await am.stopAgent(String(aid), "user removed");

      // Clear output cache for this agent
      const cacheKey = `${sid}-${aid}`;
      outputCache.clear(cacheKey);

      // Broadcast agent-removed event via WebSocket
      broadcastEvent({ event: "agent-removed", sessionId: String(sid), agentId: String(aid) });

      res.status(204).send();
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      res.status(500).json({ error: message });
    }
  });

  // Restart all agents — preserves agent IDs and worktrees (restart semantics)
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

  // Restart agent — same agent ID, preserves worktree, message inbox, and task assignments
  router.post("/sessions/:sid/agents/:aid/restart", async (req: Request, res: Response) => {
    try {
      const sid = String(req.params.sid);
      const aid = String(req.params.aid);
      const body = req.body as { contextLines?: number; extraContext?: string; carryContext?: boolean; summaryMode?: boolean } | undefined;

      const orch = orchestrators.get(sid);
      if (!orch) {
        res.status(404).json({ error: `Session "${sid}" not found` });
        return;
      }

      const newAgent = await orch.restartAgent(aid, {
        contextLines: body?.contextLines ?? 50,
        extraContext: body?.extraContext,
        carryContext: body?.carryContext ?? true,
        summaryMode: body?.summaryMode ?? false,
      });
      if (!newAgent) {
        res.status(404).json({ error: `Agent "${aid}" not found or provider unavailable` });
        return;
      }

      res.status(201).json(newAgent);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      res.status(500).json({ error: message });
    }
  });

  // Replace agent — new agent ID, new worktree, no context carried over
  router.post("/sessions/:sid/agents/:aid/replace", async (req: Request, res: Response) => {
    try {
      const sid = String(req.params.sid);
      const aid = String(req.params.aid);

      const orch = orchestrators.get(sid);
      if (!orch) {
        res.status(404).json({ error: `Session "${sid}" not found` });
        return;
      }

      const body = req.body || {};
      const newAgent = await orch.replaceAgent(aid, {
        name: body.name,
        model: body.model,
        cliProvider: body.cliProvider || body.provider,
        persona: body.persona,
      });

      if (!newAgent) {
        res.status(404).json({ error: `Agent "${aid}" not found or provider unavailable` });
        return;
      }

      res.status(201).json(newAgent);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      res.status(500).json({ error: message });
    }
  });

  router.post("/sessions/:sid/agents/:aid/message", async (req: Request, res: Response) => {
    try {
      const { sid, aid } = req.params;
      const body = req.body as SendMessageRequest;

      if (!body.message) {
        res.status(400).json({ error: "message is required" });
        return;
      }

      const am = orchestrators.get(String(sid))?.agentManager;
      if (!am) {
        res.status(404).json({ error: `Session "${sid}" not found` });
        return;
      }

      const agent = am.getAgent(String(aid));
      if (!agent) {
        res.status(404).json({ error: `Agent "${aid}" not found in session "${sid}"` });
        return;
      }

      await am.sendMessage(String(aid), body.message);

      // Clear MCP idle protection — user is interacting with the agent,
      // so terminal polling should be free to detect new activity
      am.clearIdleProtection(String(aid));

      // Log user-interaction event for timeline
      const orch = orchestrators.get(String(sid));
      if (orch) {
        const agentIdStr = String(aid);
        orch.eventLog.log({
          sessionId: String(sid),
          type: "user-interaction",
          data: {
            agentId: agentIdStr,
            agentName: agent.config.name,
            action: "send-message",
            content: body.message.substring(0, 200),
          },
        }).catch(() => {}); // Non-fatal
      }

      res.json({ sent: true, message: body.message });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      res.status(500).json({ error: message });
    }
  });

  // Broadcast message to all running agents in a session
  router.post("/sessions/:sid/broadcast", async (req: Request, res: Response) => {
    try {
      const sid = String(req.params.sid);
      const body = req.body as SendMessageRequest;

      if (!body.message) {
        res.status(400).json({ error: "message is required" });
        return;
      }

      const orch = orchestrators.get(sid);
      if (!orch) {
        res.status(404).json({ error: `Session "${sid}" not found` });
        return;
      }

      const agents = orch.agentManager.listAgents().filter((a) => a.status === "running");
      const results: Array<{ agentId: string; name: string; sent: boolean; error?: string }> = [];

      // Batch enqueue all messages, then flush once (avoids N redundant processQueues calls)
      const broadcastMsg = `\x1b[1;33m[Broadcast]\x1b[0m: ${body.message}`;
      for (const agent of agents) {
        try {
          orch.messageQueue.enqueueBatch(agent.id, agent.config.tmuxSession, broadcastMsg);
          results.push({ agentId: agent.id, name: agent.config.name, sent: true });
        } catch (err) {
          results.push({ agentId: agent.id, name: agent.config.name, sent: false, error: String(err) });
        }
      }
      orch.messageQueue.flushQueues(); // Single delivery pass for all agents

      // Log broadcast event to timeline
      const broadcastSession = sessionManager.getSession(sid);
      if (broadcastSession) {
        const { EventLog } = await import("../core/event-log.js");
        const eventLog = new EventLog(broadcastSession.runtimeDir);
        await eventLog.log({
          sessionId: sid,
          type: "message-sent" as any,
          data: {
            from: (body as any).from || "user",
            fromName: (body as any).from ? undefined : "User",
            to: "all",
            toName: "All Agents",
            content: body.message.substring(0, 200),
            broadcast: true,
          },
        });
      }

      res.json({ broadcast: true, message: body.message, sentTo: results.length, results });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      res.status(500).json({ error: message });
    }
  });

  // Relay a message from one agent to another via tmux (reliable inter-agent communication)
  router.post("/sessions/:sid/relay", async (req: Request, res: Response) => {
    try {
      const sid = String(req.params.sid);
      const body = req.body as { from: string; to: string; message: string; messageType?: string };

      if (!body.to || !body.message) {
        res.status(400).json({ error: "to and message are required" });
        return;
      }

      const orch = orchestrators.get(sid);
      if (!orch) {
        res.status(404).json({ error: `Session "${sid}" not found` });
        return;
      }

      const success = await orch.relayMessage(body.from || "user", body.to, body.message, body.messageType);
      if (!success) {
        res.status(404).json({ error: `Target agent "${body.to}" not found or not running` });
        return;
      }

      // Layer 1 idle detection: check if sender's message indicates they're idle/done.
      // Keywords like "Standing by", "Task complete" in the message content
      // trigger an immediate idle status for the SENDER.
      // BUT: skip idle marking if the agent has in-progress tasks — broadcast acks
      // like "Standing by" should NOT make agents forget their active work.
      if (body.from && body.from !== "user") {
        const { AgentHealthMonitor } = await import("../core/agent-health.js");
        if (AgentHealthMonitor.isMessageIdle(body.message)) {
          // Check if agent has active (non-closed) tasks before marking idle
          const db = getDb(sid);
          const session_relay = sessionManager.getSession(sid);
          const activeStateIds = (session_relay?.config.workflowStates || DEFAULT_WORKFLOW_STATES)
            .filter((s: any) => s.category !== "closed")
            .map((s: any) => s.id);
          const activeTasks = db ? db.getFilteredTasks(sid, {
            assignedTo: body.from,
            status: "active",
            activeStatuses: activeStateIds,
          }) : [];
          if (activeTasks.length === 0) {
            orch.agentManager.markIdleFromMcp(body.from, "completion message detected");
          } else {
            logger.debug({ agentId: body.from, activeTasks: activeTasks.length },
              "[relay] Skipping idle detection — agent has active tasks");
          }
        }
      }

      res.json({ relayed: true, from: body.from || "user", to: body.to });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      res.status(500).json({ error: message });
    }
  });

  router.get("/sessions/:sid/agents/:aid/terminal-url", (req: Request, res: Response) => {
    const { sid, aid } = req.params;
    // Return the WebSocket URL the dashboard should connect to
    res.json({ url: `/terminal/${sid}/${aid}` });
  });

  // Open the session's project path in VS Code
  router.post("/sessions/:sid/open-vscode", async (req: Request, res: Response) => {
    try {
      const sid = String(req.params.sid);
      const session = sessionManager.getSession(sid);
      if (!session) {
        res.status(404).json({ error: `Session "${sid}" not found` });
        return;
      }
      const { execFile } = await import("child_process");
      const { promisify } = await import("util");
      await promisify(execFile)("code", [session.config.projectPath]);
      res.json({ opened: true, path: session.config.projectPath });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      res.status(500).json({ error: message });
    }
  });

  // Open the agent's working directory in VS Code
  router.post("/sessions/:sid/agents/:aid/open-vscode", async (req: Request, res: Response) => {
    try {
      const { sid, aid } = req.params;
      const orch = orchestrators.get(String(sid));
      const agent = orch?.agentManager.getAgent(String(aid));
      if (!agent) {
        res.status(404).json({ error: "Agent not found" });
        return;
      }
      const { execFile } = await import("child_process");
      const { promisify } = await import("util");
      const exec = promisify(execFile);
      await exec("code", [agent.config.workingDirectory]);
      res.json({ opened: true, path: agent.config.workingDirectory });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      res.status(500).json({ error: message });
    }
  });

  router.get("/sessions/:sid/agents/:aid/output", async (req: Request, res: Response) => {
    try {
      const { sid, aid } = req.params;
      const lines = parseInt(req.query.lines as string) || 100;
      const format = req.query.format as string || "raw";
      const stripAnsiCodes = req.query.stripAnsi === "true";
      // TODO: Implement ?since=timestamp for incremental polling (requires timestamp extraction from output)

      const am = orchestrators.get(String(sid))?.agentManager;
      if (!am) {
        res.status(404).json({ error: `Session "${sid}" not found` });
        return;
      }

      const agent = am.getAgent(String(aid));
      if (!agent) {
        res.status(404).json({ error: `Agent "${aid}" not found in session "${sid}"` });
        return;
      }

      // Try cache first
      const cacheKey = `${sid}-${aid}`;
      let rawOutput: string;
      let outputLines: string[];
      const cached = outputCache.get(cacheKey);

      if (cached) {
        rawOutput = cached.raw;
        outputLines = cached.lines;
      } else {
        // Cache miss - fetch from terminal
        rawOutput = await tmux.capturePane(agent.config.tmuxSession, lines);
        outputLines = rawOutput.split("\n");
        outputCache.set(cacheKey, rawOutput, outputLines);
      }

      // Strip ANSI codes if requested
      if (stripAnsiCodes && stripAnsiFunc !== null) {
        const stripFn = stripAnsiFunc; // TypeScript type narrowing
        outputLines = outputLines.map(line => stripFn(line));
      }

      // Format response based on requested format
      if (format === "structured") {
        // Parse output into structured format with commands and responses
        const structured = parseStructuredOutput(outputLines);
        res.json({
          format: "structured",
          timestamp: Date.now(),
          entries: structured,
        });
      } else {
        // Raw format (default)
        res.json({
          format: "raw",
          timestamp: Date.now(),
          output: outputLines,
        });
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      res.status(500).json({ error: message });
    }
  });

  // ─── Terminal Status (inferred from output) ──────────────────────────

  router.get("/sessions/:sid/agents/:aid/terminal-status", async (req: Request, res: Response) => {
    try {
      const { sid, aid } = req.params;
      const lines = parseInt(req.query.lines as string) || 15;

      const orchestrator = orchestrators.get(String(sid));
      if (!orchestrator) {
        res.status(404).json({ error: `Session "${sid}" not found` });
        return;
      }

      const am = orchestrator.agentManager;
      const agent = am.getAgent(String(aid));
      if (!agent) {
        res.status(404).json({ error: `Agent "${aid}" not found in session "${sid}"` });
        return;
      }

      // Fetch terminal output (use cache if available)
      const cacheKey = `${sid}-${aid}`;
      let outputLines: string[];
      const cached = outputCache.get(cacheKey);

      if (cached) {
        outputLines = cached.lines;
      } else {
        const rawOutput = await tmux.capturePane(agent.config.tmuxSession, lines);
        outputLines = rawOutput.split("\n");
        outputCache.set(cacheKey, rawOutput, outputLines);
      }

      // Strip ANSI codes for cleaner analysis
      if (stripAnsiFunc !== null) {
        const stripFn = stripAnsiFunc;
        outputLines = outputLines.map(line => stripFn(line));
      }

      // Take last N lines for analysis
      const analysisLines = outputLines.slice(-lines);

      // Determine last activity timestamp
      const lastActivity = agent.lastOutputAt
        || agent.lastActivityAt
        || agent.startedAt
        || new Date().toISOString();

      const result = analyzeTerminalOutput(
        String(aid),
        analysisLines,
        lastActivity,
      );

      res.json(result);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      res.status(500).json({ error: message });
    }
  });

  // ─── Tier 3: Delivery Metrics ──────────────────────────────────────

  router.get("/sessions/:sid/agents/:aid/delivery-metrics", async (req: Request, res: Response) => {
    try {
      const { sid, aid } = req.params;
      const since = req.query.since ? parseInt(req.query.since as string) : undefined;

      const orchestrator = orchestrators.get(String(sid));
      if (!orchestrator) {
        res.status(404).json({ error: `Session "${sid}" not found` });
        return;
      }

      const agent = orchestrator.agentManager.getAgent(String(aid));
      if (!agent) {
        res.status(404).json({ error: `Agent "${aid}" not found in session "${sid}"` });
        return;
      }

      const metrics = orchestrator.messageQueue.getDeliveryMetrics(String(aid), since);

      if (!metrics) {
        res.status(503).json({ error: "Delivery tracking not available" });
        return;
      }

      res.json({
        agentId: String(aid),
        metrics,
        timestamp: Date.now(),
      });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      res.status(500).json({ error: message });
    }
  });

  /**
   * Parse terminal output into structured format
   * Identifies command inputs, tool calls, and responses
   */
  function parseStructuredOutput(lines: string[]): Array<{
    type: "command" | "response" | "system";
    content: string;
  }> {
    const entries: Array<{
      type: "command" | "response" | "system";
      content: string;
    }> = [];

    let currentEntry: string[] = [];
    let currentType: "command" | "response" | "system" = "response";

    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed) continue;

      // Detect command prompts ($ > ❯ etc)
      if (trimmed.match(/^[$%>#❯]\s+/)) {
        // Save previous entry
        if (currentEntry.length > 0) {
          entries.push({
            type: currentType,
            content: currentEntry.join('\n'),
          });
          currentEntry = [];
        }
        currentType = "command";
        currentEntry.push(trimmed);
      }
      // Detect tool calls or system messages with specific patterns
      else if (
        trimmed.match(/^\[Tool:\s/) ||           // [Tool: Read]
        trimmed.match(/^\[Message\s/) ||         // [Message from ...]
        trimmed.match(/^\[System/i) ||           // [System ...]
        trimmed.match(/^ERROR:/i) ||             // ERROR: ...
        trimmed.match(/^WARNING:/i) ||           // WARNING: ...
        trimmed.match(/^FATAL:/i)                // FATAL: ...
      ) {
        if (currentEntry.length > 0) {
          entries.push({
            type: currentType,
            content: currentEntry.join('\n'),
          });
          currentEntry = [];
        }
        currentType = "system";
        currentEntry.push(trimmed);
      }
      // Regular response output
      else {
        if (currentType === "command" && currentEntry.length > 0) {
          // Command has been entered, now we're seeing response
          entries.push({
            type: "command",
            content: currentEntry.join('\n'),
          });
          currentEntry = [];
          currentType = "response";
        }
        currentEntry.push(trimmed);
      }
    }

    // Save final entry
    if (currentEntry.length > 0) {
      entries.push({
        type: currentType,
        content: currentEntry.join('\n'),
      });
    }

    return entries;
  }

  router.post("/sessions/:sid/agents/:aid/model", async (req: Request, res: Response) => {
    try {
      const { sid, aid } = req.params;
      const body = req.body as ChangeModelRequest;

      if (!body.model) {
        res.status(400).json({ error: "model is required" });
        return;
      }

      const am = orchestrators.get(String(sid))?.agentManager;
      if (!am) {
        res.status(404).json({ error: `Session "${sid}" not found` });
        return;
      }

      const agent = am.getAgent(String(aid));
      if (!agent) {
        res.status(404).json({ error: `Agent "${aid}" not found in session "${sid}"` });
        return;
      }

      // Resolve the provider for the model change
      const provider = providerRegistry.get(agent.config.cliProvider);
      if (!provider) {
        res.status(500).json({ error: `Provider "${agent.config.cliProvider}" not found` });
        return;
      }

      await am.changeModel(String(aid), body.model, provider);
      res.json({ model: body.model });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      res.status(500).json({ error: message });
    }
  });

  router.post("/sessions/:sid/agents/:aid/pause", (req: Request, res: Response) => {
    try {
      const { sid, aid } = req.params;

      const am = orchestrators.get(String(sid))?.agentManager;
      if (!am) {
        res.status(404).json({ error: `Session "${sid}" not found` });
        return;
      }

      const agent = am.getAgent(String(aid));
      if (!agent) {
        res.status(404).json({ error: `Agent "${aid}" not found in session "${sid}"` });
        return;
      }

      // Mark the agent as waiting (paused)
      agent.status = "waiting";
      res.json({ status: "waiting" });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      res.status(500).json({ error: message });
    }
  });

  router.post("/sessions/:sid/agents/:aid/resume", (req: Request, res: Response) => {
    try {
      const { sid, aid } = req.params;

      const am = orchestrators.get(String(sid))?.agentManager;
      if (!am) {
        res.status(404).json({ error: `Session "${sid}" not found` });
        return;
      }

      const agent = am.getAgent(String(aid));
      if (!agent) {
        res.status(404).json({ error: `Agent "${aid}" not found in session "${sid}"` });
        return;
      }

      // Mark the agent as running (resumed)
      agent.status = "running";
      res.json({ status: "running" });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      res.status(500).json({ error: message });
    }
  });

  // ─── Nudge + Ack-Read ──────────────────────────────────────────────

  /** Send an immediate nudge notification to an agent. Supports custom message or defaults to unread count. */
  router.post("/sessions/:sid/agents/:aid/nudge", async (req: Request, res: Response) => {
    try {
      const { sid, aid } = req.params;
      const customMessage = req.body?.message as string | undefined;
      const orch = orchestrators.get(String(sid));
      if (!orch) {
        res.status(404).json({ error: `Session "${sid}" not found` });
        return;
      }

      const agent = orch.agentManager.getAgent(String(aid));
      if (!agent) {
        res.status(404).json({ error: `Agent "${aid}" not found in session "${sid}"` });
        return;
      }

      if (customMessage) {
        // Direct custom message via tmux — bypass queue entirely
        try {
          await tmux.sendKeys(agent.config.tmuxSession, `\n[Nudge]: ${customMessage}\n`, { literal: true });
          logger.info({ agentId: aid, customMessage, sessionId: sid }, "[API] Custom nudge sent successfully");

          // Track nudge-sent event
          orch.database.insertEvent({
            id: randomUUID(),
            sessionId: String(sid),
            type: 'nudge-sent',
            data: { agentId: String(aid), messageType: 'custom', customMessage },
            agentId: String(aid),
            timestamp: new Date().toISOString(),
          });

          res.json({ nudged: true, customMessage: true });
        } catch (err) {
          logger.error({ err, agentId: aid, customMessage, sessionId: sid }, "[API] Failed to send custom nudge");

          // Track nudge-failed event
          orch.database.insertEvent({
            id: randomUUID(),
            sessionId: String(sid),
            type: 'nudge-failed',
            data: { agentId: String(aid), messageType: 'custom', error: String(err) },
            agentId: String(aid),
            timestamp: new Date().toISOString(),
          });

          res.status(500).json({ error: "Failed to send nudge", details: String(err) });
        }
      } else {
        // Default: nudge with unread count
        try {
          const unread = await orch.messageQueue.nudgeAgent(String(aid), agent.config.tmuxSession);
          logger.info({ agentId: aid, unreadCount: unread, sessionId: sid }, "[API] Default nudge sent successfully");

          // Track nudge-sent event
          orch.database.insertEvent({
            id: randomUUID(),
            sessionId: String(sid),
            type: 'nudge-sent',
            data: { agentId: String(aid), messageType: 'default', unreadCount: unread },
            agentId: String(aid),
            timestamp: new Date().toISOString(),
          });

          res.json({ nudged: true, unreadCount: unread });
        } catch (err) {
          logger.error({ err, agentId: aid, sessionId: sid }, "[API] Failed to send default nudge");

          // Track nudge-failed event
          orch.database.insertEvent({
            id: randomUUID(),
            sessionId: String(sid),
            type: 'nudge-failed',
            data: { agentId: String(aid), messageType: 'default', error: String(err) },
            agentId: String(aid),
            timestamp: new Date().toISOString(),
          });

          res.status(500).json({ error: "Failed to send nudge", details: String(err) });
        }
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      res.status(500).json({ error: message });
    }
  });

  /** Called by MCP server when agent reads messages — reset re-notification attempts */
  router.post("/sessions/:sid/agents/:aid/ack-read", (req: Request, res: Response) => {
    try {
      const { sid, aid } = req.params;
      const orch = orchestrators.get(String(sid));
      if (!orch) {
        res.status(404).json({ error: `Session "${sid}" not found` });
        return;
      }

      orch.messageQueue.resetNotificationAttempts(String(aid));
      res.json({ success: true });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      res.status(500).json({ error: message });
    }
  });

  // ─── SQLite Messages ─────────────────────────────────────────────────────

  /** Get messages for an agent (SQLite-based) */
  router.get("/sessions/:sid/agents/:aid/messages", (req: Request, res: Response) => {
    try {
      const { sid, aid } = req.params;
      const orch = orchestrators.get(String(sid));
      if (!orch) {
        res.status(404).json({ error: `Session "${sid}" not found` });
        return;
      }

      const status = req.query.status as string | string[] | undefined;
      const since = req.query.since ? parseInt(req.query.since as string, 10) : undefined;
      const limit = req.query.limit ? parseInt(req.query.limit as string, 10) : 50;

      // Handle multiple status values (e.g. ?status=pending&status=delivered)
      const statusValues = Array.isArray(status) ? status : status ? [status] : undefined;

      // Query messages with single database call (handles array via IN clause)
      const allMessages = orch.database.getMessages({
        toAgentId: String(aid),
        sessionId: String(sid),
        status: statusValues as any,
        since,
        limit,
      });

      res.json({ messages: allMessages, count: allMessages.length });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      res.status(500).json({ error: message });
    }
  });

  /** Mark messages as read */
  router.post("/sessions/:sid/agents/:aid/messages/mark-read", (req: Request, res: Response) => {
    try {
      const { sid, aid } = req.params;
      const { messageIds } = req.body as { messageIds: string[] };

      const orch = orchestrators.get(String(sid));
      if (!orch) {
        res.status(404).json({ error: `Session "${sid}" not found` });
        return;
      }

      if (!Array.isArray(messageIds) || messageIds.length === 0) {
        res.status(400).json({ error: "messageIds array required" });
        return;
      }

      orch.database.markMessagesRead(messageIds);
      res.json({ success: true, markedRead: messageIds.length });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      res.status(500).json({ error: message });
    }
  });

  /** Get unread message count */
  router.get("/sessions/:sid/agents/:aid/messages/unread-count", (req: Request, res: Response) => {
    try {
      const { sid, aid } = req.params;
      const orch = orchestrators.get(String(sid));
      if (!orch) {
        res.status(404).json({ error: `Session "${sid}" not found` });
        return;
      }

      const count = orch.database.getUnreadMessageCount(String(aid));
      res.json({ count });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      res.status(500).json({ error: message });
    }
  });

  // ─── Autonomy Enforcement (Stubs) ───────────────────────────────────────

  /** Approve an agent action request. Stub endpoint — full implementation in Sprint 5. */
  router.post("/sessions/:sid/agents/:aid/approve", (req: Request, res: Response) => {
    res.status(501).json({
      error: "Not implemented",
      message: "Autonomy enforcement coming in Sprint 5. This is a UI scaffold endpoint.",
    });
  });

  /** Reject an agent action request. Stub endpoint — full implementation in Sprint 5. */
  router.post("/sessions/:sid/agents/:aid/reject", (req: Request, res: Response) => {
    res.status(501).json({
      error: "Not implemented",
      message: "Autonomy enforcement coming in Sprint 5. This is a UI scaffold endpoint.",
    });
  });

  // ─── Knowledge Persistence ─────────────────────────────────────────────

  router.post("/sessions/:sid/knowledge", (req: Request, res: Response) => {
    try {
      const sid = String(req.params.sid);
      const { entry, agentName } = req.body as { entry: string; agentName?: string };

      if (!entry || typeof entry !== "string" || !entry.trim()) {
        res.status(400).json({ error: "entry is required (non-empty string)" });
        return;
      }

      const session = sessionManager.getSession(sid);
      if (!session) {
        res.status(404).json({ error: `Session "${sid}" not found` });
        return;
      }

      const { appendKnowledgeEntry } = require("../core/context-discovery.js");
      appendKnowledgeEntry(session.runtimeDir, agentName || "unknown", entry.trim());

      res.status(201).json({ success: true });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      res.status(500).json({ error: message });
    }
  });

  // ─── Idle Detection & Task Assignment ──────────────────────────────────

  /** Agent reports it is idle and available for work */
  router.post("/sessions/:sid/agents/:aid/report-idle", (req: Request, res: Response) => {
    try {
      const { sid, aid } = req.params;
      const reason = req.body?.reason || "task completed";
      const orch = orchestrators.get(String(sid));
      if (!orch) {
        res.status(404).json({ error: `Session "${sid}" not found` });
        return;
      }

      const agent = orch.agentManager.getAgent(String(aid));
      if (!agent) {
        res.status(404).json({ error: `Agent "${aid}" not found in session "${sid}"` });
        return;
      }

      // Layer 1 (MCP signal): Mark agent as idle with protection from terminal override.
      // This sets activity to "idle" AND protects it from being flapped back to "working"
      // by terminal polling for 2 minutes.
      // BUT: if agent has active tasks, warn instead of marking idle — prevents
      // broadcast acks from making agents forget their assigned work.
      const db = getDb(String(sid));
      const session_idle = sessionManager.getSession(String(sid));
      const activeStateIds_idle = (session_idle?.config.workflowStates || DEFAULT_WORKFLOW_STATES)
        .filter((s: any) => s.category !== "closed")
        .map((s: any) => s.id);
      const activeTasks = db ? db.getFilteredTasks(String(sid), {
        assignedTo: String(aid),
        status: "active",
        activeStatuses: activeStateIds_idle,
      }) : [];

      if (activeTasks.length > 0) {
        // Agent has active tasks — don't mark idle, return a warning
        res.json({
          success: true,
          activity: agent.activity,
          reason,
          warning: `Not marked idle — you have ${activeTasks.length} active task(s). Use update_task to mark them done first.`,
          activeTasks: activeTasks.map((t: any) => ({ id: t.id, title: t.title, status: t.status })),
        });
      } else {
        orch.agentManager.markIdleFromMcp(String(aid), reason);
        res.json({ success: true, activity: "idle", reason });
      }
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

  // ── Stale Task Watchdog ──────────────────────────────────

  router.get("/sessions/:sid/tasks/:tid/nudges", (req: Request, res: Response) => {
    try {
      const { sid, tid } = req.params;
      const orch = orchestrators.get(String(sid));
      if (!orch) { res.status(404).json({ error: `Session "${sid}" not found` }); return; }
      const nudges = orch.database.getNudgeHistory(String(tid));
      res.json({ nudges });
    } catch (err) { res.status(500).json({ error: String(err) }); }
  });

  router.get("/sessions/:sid/nudges", (req: Request, res: Response) => {
    try {
      const sid = String(req.params.sid);
      const limit = parseInt(req.query.limit as string) || 50;
      const orch = orchestrators.get(sid);
      if (!orch) { res.status(404).json({ error: `Session "${sid}" not found` }); return; }
      const nudges = orch.database.getSessionNudgeHistory(sid, limit);
      res.json({ nudges });
    } catch (err) { res.status(500).json({ error: String(err) }); }
  });

  router.get("/sessions/:sid/nudge-policies", (req: Request, res: Response) => {
    try {
      const orch = orchestrators.get(String(req.params.sid));
      if (!orch) { res.status(404).json({ error: "Session not found" }); return; }
      res.json({ policies: orch.staleTaskWatchdog.getPolicies() });
    } catch (err) { res.status(500).json({ error: String(err) }); }
  });

  router.put("/sessions/:sid/nudge-policies", (req: Request, res: Response) => {
    try {
      const orch = orchestrators.get(String(req.params.sid));
      if (!orch) { res.status(404).json({ error: "Session not found" }); return; }
      orch.staleTaskWatchdog.updatePolicies(req.body.policies || {});
      res.json({ updated: true, policies: orch.staleTaskWatchdog.getPolicies() });
    } catch (err) { res.status(500).json({ error: String(err) }); }
  });

  router.post("/sessions/:sid/tasks/:tid/nudge", async (req: Request, res: Response) => {
    try {
      const { sid, tid } = req.params;
      const orch = orchestrators.get(String(sid));
      if (!orch) { res.status(404).json({ error: "Session not found" }); return; }
      const task = orch.database.getTask(String(tid));
      if (!task) { res.status(404).json({ error: "Task not found" }); return; }
      if (task.assigned_to) {
        const agent = orch.agentManager.getAgent(task.assigned_to);
        if (agent && agent.status === "running") {
          await orch.agentManager.sendMessage(task.assigned_to,
            `\x1b[1;33m[Manual Nudge] Task "${task.title}" (${task.status}) needs your attention.\x1b[0m`);
        }
      }
      const { randomUUID } = await import("crypto");
      orch.database.insertNudge({
        id: randomUUID(), taskId: String(tid), sessionId: String(sid),
        statusAtNudge: task.status, targetAgentId: task.assigned_to,
        targetType: "manual", nudgeCount: orch.database.getNudgeCount(String(tid), task.status) + 1,
        isEscalation: false, message: "Manual nudge from dashboard",
      });
      res.json({ success: true, nudgedAgent: task.assigned_to });
    } catch (err) { res.status(500).json({ error: String(err) }); }
  });

  // ── Orchestrator Blocking ──────────────────────────────────

  // GET blocking state for an agent
  router.get("/sessions/:sid/agents/:aid/blocking", (req: Request, res: Response) => {
    try {
      const { sid, aid } = req.params;
      const orch = orchestrators.get(String(sid));
      if (!orch) {
        res.status(404).json({ error: `Session "${sid}" not found` });
        return;
      }
      const state = orch.getBlockingState(String(aid));
      res.json(state);
    } catch (err) {
      res.status(500).json({ error: String(err) });
    }
  });

  // POST resume a blocked orchestrator agent
  router.post("/sessions/:sid/agents/:aid/unblock", async (req: Request, res: Response) => {
    try {
      const { sid, aid } = req.params;
      const { input } = req.body as { input?: string };
      const orch = orchestrators.get(String(sid));
      if (!orch) {
        res.status(404).json({ error: `Session "${sid}" not found` });
        return;
      }
      const resumed = await orch.resumeBlocked(String(aid), input);
      if (!resumed) {
        res.status(400).json({ error: `Agent "${aid}" is not in BLOCKED state` });
        return;
      }
      res.json({ success: true, resumed: true });
    } catch (err) {
      res.status(500).json({ error: String(err) });
    }
  });

  /** Agent requests a task from the task board */
  router.post("/sessions/:sid/agents/:aid/request-task", (req: Request, res: Response) => {
    try {
      const { sid, aid } = req.params;
      const skills = req.body?.skills || [];
      const preferredPriority = req.body?.priority as "P0" | "P1" | "P2" | "P3" | undefined;

      const orch = orchestrators.get(String(sid));
      if (!orch) {
        res.status(404).json({ error: `Session "${sid}" not found` });
        return;
      }

      const agent = orch.agentManager.getAgent(String(aid));
      if (!agent) {
        res.status(404).json({ error: `Agent "${aid}" not found in session "${sid}"` });
        return;
      }

      const db = getDb(String(sid));
      if (!db) {
        res.status(404).json({ error: "Database not found" });
        return;
      }

      // Get all pending/unassigned tasks
      const allTasks = db.getTasks(String(sid));
      const availableTasks = allTasks.filter(t =>
        t.status === "pending" &&
        (!t.assignedTo || t.assignedTo === "")
      );

      if (availableTasks.length === 0) {
        res.json({ success: false, message: "No available tasks" });
        return;
      }

      // Task matching algorithm:
      // Score tasks by priority, skills, overdue status

      const priorityScore = (p: string) => {
        switch (p) {
          case "P0": return 1000;
          case "P1": return 100;
          case "P2": return 10;
          case "P3": return 1;
          default: return 10;
        }
      };

      const hasSkillMatch = (task: any) => {
        if (skills.length === 0) return false;
        const taskLabels = task.labels || [];
        return skills.some((skill: string) =>
          taskLabels.some((label: string) =>
            label.toLowerCase().includes(skill.toLowerCase()) ||
            skill.toLowerCase().includes(label.toLowerCase())
          )
        );
      };

      let bestTask = availableTasks[0];
      let bestScore = 0;

      for (const task of availableTasks) {
        let score = priorityScore(task.priority);

        // Bonus if matches preferred priority (highest priority)
        if (preferredPriority && task.priority === preferredPriority) {
          score += 10000;
        }

        // Bonus for skill match (but less than priority gap)
        if (hasSkillMatch(task)) {
          score += 50;
        }

        // Bonus for overdue tasks
        if (task.dueDate) {
          const dueTime = new Date(task.dueDate).getTime();
          if (dueTime < Date.now()) {
            score += 500;
          }
        }

        if (score > bestScore) {
          bestScore = score;
          bestTask = task;
        }
      }

      // Assign task to agent
      db.updateTask(bestTask.id, { assignedTo: String(aid), status: "assigned" });

      // Fetch updated task
      const updatedTask = db.getTask(bestTask.id);

      // Update agent activity
      agent.activity = "working";
      agent.lastActivityAt = new Date().toISOString();
      delete agent.idleSince;

      res.json({
        success: true,
        task: updatedTask,
        message: `Task "${bestTask.title}" assigned to you`
      });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      res.status(500).json({ error: message });
    }
  });

  // ─── Tasks (SQLite) ──────────────────────────────────────────────────

  function getDb(sid: string) {
    const orch = orchestrators.get(sid);
    return orch?.database || null;
  }

  router.get("/sessions/:sid/tasks", (req: Request, res: Response) => {
    try {
      const sid = String(req.params.sid);
      const db = getDb(sid);
      if (!db) { res.status(404).json({ error: "Session not found" }); return; }

      // Support query param filters: ?assignedTo=X&status=active&priority=P0&label=bug&due=overdue&sortBy=due&summary=true
      const assignedTo = req.query.assignedTo as string | undefined;
      const status = req.query.status as string | undefined;
      const priority = req.query.priority as string | undefined;
      const label = req.query.label as string | undefined;
      const due = req.query.due as string | undefined;
      const sortBy = (req.query.sortBy || req.query.sort) as string | undefined;
      const summary = req.query.summary as string | undefined;

      if (assignedTo || status || priority || label || due || sortBy || summary !== undefined) {
        const tasks = db.getFilteredTasks(sid, {
          assignedTo: assignedTo || null,
          status: status || null,
          priority: priority || null,
          label: label || null,
          due: due || null,
          sortBy: sortBy || null,
          summary: summary !== "false",  // default true when query params used
        });
        res.json({ tasks });
      } else {
        // No filters — return full tasks (backward compatible)
        const includeArchived = req.query.includeArchived === "true";
        res.json({ tasks: db.getTasks(sid, includeArchived), archivedCount: db.getArchivedCount(sid) });
      }
    } catch (err) {
      res.status(500).json({ error: String(err) });
    }
  });

  // GET single task by ID (full details)
  router.get("/sessions/:sid/tasks/:tid", (req: Request, res: Response) => {
    try {
      const sid = String(req.params.sid);
      const tid = String(req.params.tid);
      const db = getDb(sid);
      if (!db) { res.status(404).json({ error: "Session not found" }); return; }

      const task = db.getTask(tid);
      if (!task) { res.status(404).json({ error: "Task not found" }); return; }

      res.json(task);
    } catch (err) {
      res.status(500).json({ error: String(err) });
    }
  });

  router.post("/sessions/:sid/tasks", (req: Request, res: Response) => {
    try {
      const sid = String(req.params.sid);
      const db = getDb(sid);
      if (!db) { res.status(404).json({ error: "Session not found" }); return; }
      const body = req.body as CreateTaskRequest;
      if (!body.title) { res.status(400).json({ error: "title is required" }); return; }

      const { randomUUID } = require("crypto");
      const now = new Date().toISOString();
      // Validate priority if provided
      const validPriorities = ["P0", "P1", "P2", "P3"];
      if (body.priority && !validPriorities.includes(body.priority)) {
        res.status(400).json({ error: `priority must be one of: ${validPriorities.join(", ")}` });
        return;
      }

      // Validate labels if provided
      if (body.labels !== undefined && !Array.isArray(body.labels)) {
        res.status(400).json({ error: "labels must be an array of strings" });
        return;
      }

      // Validate dueDate format if provided
      if (body.dueDate !== undefined && body.dueDate !== null) {
        if (!/^\d{4}-\d{2}-\d{2}$/.test(body.dueDate)) {
          res.status(400).json({ error: "dueDate must be in YYYY-MM-DD format" });
          return;
        }
      }

      // Use the session's first workflow state as default status (e.g. "backlog" for Full Pipeline).
      // Falls back to "pending" for sessions without custom workflow states.
      const session = sessionManager.getSession(sid);
      const firstState = session?.config.workflowStates?.[0]?.id;
      const defaultStatus = firstState || "pending";

      const task = {
        id: randomUUID().slice(0, 8),
        sessionId: sid,
        title: body.title,
        description: body.description || "",
        status: (body as any).status || defaultStatus,
        assignedTo: body.assignedTo || undefined,
        createdBy: "user",
        dependencies: body.dependencies || [],
        priority: body.priority || "P2",
        labels: body.labels || [],
        dueDate: body.dueDate || undefined,
        createdAt: now,
        updatedAt: now,
      };
      db.insertTask(task);

      // Notify assigned agent via terminal + SQLite (so check_messages finds it)
      if (task.assignedTo) {
        const orch = orchestrators.get(sid);
        if (orch) {
          try {
            const agent = orch.agentManager.getAgent(task.assignedTo);
            const notifyMsg = `[Task assigned] "${task.title}" (${task.priority}). Use get_task("${task.id}") for details.`;
            if (agent) {
              orch.messageQueue.enqueue(task.assignedTo, agent.config.tmuxSession,
                `\x1b[1;36m${notifyMsg}\x1b[0m`);
            }
            // Also persist to SQLite so check_messages picks it up
            orch.database.insertMessage({
              id: randomUUID(),
              sessionId: sid,
              fromAgentId: "system",
              toAgentId: task.assignedTo,
              messageType: "task-assignment",
              content: notifyMsg,
              priority: "normal",
              createdAt: Date.now(),
              expiresAt: Date.now() + 7 * 24 * 60 * 60 * 1000,
            });
          } catch {}
        }
      }

      // Broadcast task-created event via WebSocket
      broadcastEvent({ event: "task-created", sessionId: sid, taskId: task.id });
      taskMetricsDebouncer.schedule(sid, () => broadcastEvent({ event: "task-metrics-updated", sessionId: sid }));

      // Log to SQLite for timeline
      const orch_tc = orchestrators.get(sid);
      if (orch_tc) {
        orch_tc.eventLog.log({ sessionId: sid, type: "task-created" as any, data: { taskId: task.id, title: task.title, description: task.description, priority: task.priority, labels: task.labels, assignedTo: task.assignedTo || null } });
      }

      res.status(201).json(db.getTask(task.id));
    } catch (err) {
      res.status(500).json({ error: String(err) });
    }
  });

  router.put("/sessions/:sid/tasks/:tid", (req: Request, res: Response) => {
    try {
      const sid = String(req.params.sid);
      const tid = String(req.params.tid);
      const db = getDb(sid);
      if (!db) { res.status(404).json({ error: "Session not found" }); return; }

      const oldTask = db.getTask(tid);
      if (!oldTask) { res.status(404).json({ error: "Task not found" }); return; }

      const body = req.body as UpdateTaskRequest;

      // Validate inputs
      if (body.title !== undefined && (typeof body.title !== "string" || body.title.trim() === "")) {
        res.status(400).json({ error: "title must be a non-empty string" });
        return;
      }
      // Validate status against session's workflow states (or defaults)
      const sessionForValidation = sessionManager.getSession(sid);
      const workflowStates = sessionForValidation?.config.workflowStates;
      const validStatuses = workflowStates?.map((s: any) => s.id) || ["pending", "in-progress", "review", "done"];
      if (body.status !== undefined && !validStatuses.includes(body.status)) {
        res.status(400).json({ error: `status must be one of: ${validStatuses.join(", ")}` });
        return;
      }
      // Enforce pipeline transitions if workflow states have transitions defined
      if (body.status !== undefined && workflowStates) {
        const orch = orchestrators.get(sid);
        const currentTask = orch?.database.getTask(String(tid));
        if (currentTask && currentTask.status !== body.status) {
          const currentState = workflowStates.find((s: any) => s.id === currentTask.status);
          if (currentState?.transitions?.length) {
            // Build effective transitions including skippable state targets
            const effective = new Set<string>(currentState.transitions);
            for (const t of currentState.transitions) {
              const ts = workflowStates.find((s: any) => s.id === t);
              if (ts?.skippable && ts.transitions?.length) {
                for (const st of ts.transitions) effective.add(st);
              }
            }
            if (!effective.has(body.status)) {
              const validNext = [...effective].join(", ");
              res.status(400).json({
                error: `Invalid transition: "${currentTask.status}" → "${body.status}". Valid next states: ${validNext}`,
              });
              return;
            }
          }
        }
      }

      const validPriorities = ["P0", "P1", "P2", "P3"];
      if (body.priority !== undefined && !validPriorities.includes(body.priority)) {
        res.status(400).json({ error: `priority must be one of: ${validPriorities.join(", ")}` });
        return;
      }

      if (body.labels !== undefined && !Array.isArray(body.labels)) {
        res.status(400).json({ error: "labels must be an array of strings" });
        return;
      }

      if (body.dueDate !== undefined && body.dueDate !== null) {
        if (typeof body.dueDate === "string" && !/^\d{4}-\d{2}-\d{2}$/.test(body.dueDate)) {
          res.status(400).json({ error: "dueDate must be in YYYY-MM-DD format" });
          return;
        }
      }

      const task = db.updateTask(tid, {
        title: body.title,
        description: body.description,
        status: body.status,
        assignedTo: body.assignedTo,
        priority: body.priority,
        labels: body.labels,
        dueDate: body.dueDate,
      });

      // Notify if assignedTo changed — terminal + SQLite (so check_messages finds it)
      if (body.assignedTo && task.assignedTo !== oldTask.assignedTo) {
        const orch = orchestrators.get(sid);
        if (orch) {
          try {
            const agent = orch.agentManager.getAgent(task.assignedTo);
            const notifyMsg = `[Task assigned] "${task.title}" (${task.priority || "P2"}). Use get_task("${tid}") for details.`;
            if (agent) {
              orch.messageQueue.enqueue(task.assignedTo, agent.config.tmuxSession,
                `\x1b[1;36m${notifyMsg}\x1b[0m`);
            }
            // Persist to SQLite for check_messages
            orch.database.insertMessage({
              id: randomUUID(),
              sessionId: sid,
              fromAgentId: "system",
              toAgentId: task.assignedTo,
              messageType: "task-assignment",
              content: notifyMsg,
              priority: "normal",
              createdAt: Date.now(),
              expiresAt: Date.now() + 7 * 24 * 60 * 60 * 1000,
            });
          } catch {}
        }
      }

      // Broadcast task-updated event via WebSocket
      broadcastEvent({ event: "task-updated", sessionId: sid, taskId: tid });
      taskMetricsDebouncer.schedule(sid, () => broadcastEvent({ event: "task-metrics-updated", sessionId: sid }));

      // Log to SQLite for timeline
      const orch_tu = orchestrators.get(sid);
      if (orch_tu) {
        orch_tu.eventLog.log({ sessionId: sid, type: "task-updated" as any, data: { taskId: tid, title: task.title, status: task.status } });
      }

      res.json(task);
    } catch (err) {
      res.status(500).json({ error: String(err) });
    }
  });

  router.delete("/sessions/:sid/tasks/:tid", (req: Request, res: Response) => {
    try {
      const sid = String(req.params.sid);
      const tid = String(req.params.tid);
      const db = getDb(sid);
      if (!db) { res.status(404).json({ error: "Session not found" }); return; }

      const deleted = db.deleteTask(tid);
      if (!deleted) { res.status(404).json({ error: "Task not found" }); return; }

      // Broadcast task-deleted event via WebSocket
      broadcastEvent({ event: "task-deleted", sessionId: sid, taskId: tid });
      taskMetricsDebouncer.schedule(sid, () => broadcastEvent({ event: "task-metrics-updated", sessionId: sid }));

      // Log to SQLite for timeline
      const orch_td = orchestrators.get(sid);
      if (orch_td) {
        orch_td.eventLog.log({ sessionId: sid, type: "task-deleted" as any, data: { taskId: tid } });
      }

      res.json({ deleted: true, id: tid });
    } catch (err) {
      res.status(500).json({ error: String(err) });
    }
  });

  // Archive done tasks older than X days
  router.patch("/sessions/:sid/tasks/archive", (req: Request, res: Response) => {
    try {
      const sid = String(req.params.sid);
      const db = getDb(sid);
      if (!db) { res.status(404).json({ error: "Session not found" }); return; }

      const daysOld = Number(req.body?.daysOld) || 7;
      const archived = db.archiveDoneTasks(sid, daysOld);
      const totalArchived = db.getArchivedCount(sid);

      broadcastEvent({ event: "task-updated", sessionId: sid });
      res.json({ archived, totalArchived });
    } catch (err) {
      res.status(500).json({ error: String(err) });
    }
  });

  // Get archived task count
  router.get("/sessions/:sid/tasks/archived-count", (req: Request, res: Response) => {
    try {
      const sid = String(req.params.sid);
      const db = getDb(sid);
      if (!db) { res.status(404).json({ error: "Session not found" }); return; }
      res.json({ count: db.getArchivedCount(sid) });
    } catch (err) {
      res.status(500).json({ error: String(err) });
    }
  });

  router.post("/sessions/:sid/tasks/:tid/comments", (req: Request, res: Response) => {
    try {
      const sid = String(req.params.sid);
      const tid = String(req.params.tid);
      const db = getDb(sid);
      if (!db) { res.status(404).json({ error: "Session not found" }); return; }

      const { text, author, authorName } = req.body;
      if (!text) { res.status(400).json({ error: "text is required" }); return; }

      const task = db.getTask(tid);
      if (!task) { res.status(404).json({ error: "Task not found" }); return; }

      const { randomUUID } = require("crypto");
      db.addTaskComment({
        id: randomUUID().slice(0, 8),
        taskId: tid,
        text,
        author,
        authorName,
        createdAt: new Date().toISOString(),
      });

      res.status(201).json(db.getTask(tid));
    } catch (err) {
      res.status(500).json({ error: String(err) });
    }
  });

  router.get("/sessions/:sid/tasks/:tid/comments", (req: Request, res: Response) => {
    try {
      const sid = String(req.params.sid);
      const tid = String(req.params.tid);
      const db = getDb(sid);
      if (!db) { res.status(404).json({ error: "Session not found" }); return; }

      res.json({ comments: db.getTaskComments(tid) });
    } catch (err) {
      res.status(500).json({ error: String(err) });
    }
  });

  // ─── Task State Transitions ──────────────────────────────────────

  router.get("/sessions/:sid/tasks/:tid/transitions", (req: Request, res: Response) => {
    try {
      const sid = String(req.params.sid);
      const tid = String(req.params.tid);
      const db = getDb(sid);
      if (!db) { res.status(404).json({ error: "Session not found" }); return; }

      const limit = parseInt(req.query.limit as string) || 50;
      const rawTransitions = db.getTransitions(tid, limit);
      const durations = db.getStatusDurations(tid);

      // Enhance transitions with durationMs (time until next transition)
      const transitions = rawTransitions.map((t, i) => {
        const nextTime = i + 1 < rawTransitions.length
          ? new Date(rawTransitions[i + 1].changedAt).getTime()
          : Date.now();
        const durationMs = nextTime - new Date(t.changedAt).getTime();
        return { ...t, durationMs };
      });

      // Compute summary analytics
      const totalCycleTimeMs = Object.values(durations).reduce((a, b) => a + b, 0);
      const statusCounts: Record<string, number> = {};
      for (const t of rawTransitions) {
        statusCounts[t.toStatus] = (statusCounts[t.toStatus] || 0) + 1;
      }
      const avgTimePerStatus: Record<string, number> = {};
      for (const [status, totalMs] of Object.entries(durations)) {
        const visits = statusCounts[status] || 1;
        avgTimePerStatus[status] = Math.round(totalMs / visits);
      }
      // Rework count: number of times a task moved backward (re-entered a prior status)
      const seen = new Set<string>();
      let reworkCount = 0;
      for (const t of rawTransitions) {
        if (seen.has(t.toStatus)) reworkCount++;
        seen.add(t.toStatus);
      }

      res.json({
        transitions,
        summary: { totalCycleTimeMs, avgTimePerStatus, reworkCount },
      });
    } catch (err) {
      res.status(500).json({ error: String(err) });
    }
  });

  // ─── Task Metrics ──────────────────────────────────────────────────

  const taskMetricsDebouncer = new TaskMetricsDebouncer();

  router.get("/sessions/:sid/task-metrics", (req: Request, res: Response) => {
    try {
      const sid = String(req.params.sid);
      const session = sessionManager.getSession(sid);
      if (!session) { res.status(404).json({ error: "Session not found" }); return; }

      const db = getDb(sid);
      if (!db) { res.status(404).json({ error: "Session database not found" }); return; }

      const orch = orchestrators.get(sid);
      const agentList = orch ? orch.agentManager.listAgents() : [];

      // Map agents to the info shape needed by computeTaskMetrics
      const agents = agentList.map(a => ({
        id: a.id,
        name: a.config.name,
        role: a.config.role,
        activity: a.activity,
      }));

      const workflowStates = session.config.workflowStates || DEFAULT_WORKFLOW_STATES;

      const metrics = computeTaskMetrics(db, sid, agents, workflowStates);
      res.json(metrics);
    } catch (err) {
      res.status(500).json({ error: String(err) });
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

  // ─── Providers ───────────────────────────────────────────────────────

  router.get("/providers", (_req: Request, res: Response) => {
    try {
      const providers = providerRegistry.list();
      const response: ProviderResponse[] = providers.map((p) => ({
        id: p.id,
        displayName: p.displayName,
        models: p.getModels(),
        supportsHotModelSwap: p.supportsHotModelSwap,
      }));
      res.json({ providers: response });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      res.status(500).json({ error: message });
    }
  });

  router.get("/providers/:pid/models", (req: Request, res: Response) => {
    try {
      const pid = String(req.params.pid);
      const provider = providerRegistry.get(pid);
      if (!provider) {
        res.status(404).json({ error: `Provider "${pid}" not found` });
        return;
      }

      const builtInModels = provider.getModels();

      // If sessionId query param is provided, merge custom models from that session
      const sessionId = req.query.sessionId ? String(req.query.sessionId) : undefined;
      if (sessionId) {
        const session = sessionManager.getSession(sessionId);
        if (session) {
          const customModels = (session.config.customModels?.[pid] ?? []).map((m) => ({
            id: m.id,
            label: m.label,
            tier: "balanced" as const,
            custom: true as const,
          }));
          res.json({ models: [...builtInModels.map((m) => ({ ...m, custom: false })), ...customModels] });
          return;
        }
      }

      res.json({ models: builtInModels });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      res.status(500).json({ error: message });
    }
  });

  router.get("/providers/:pid/discover", async (req: Request, res: Response) => {
    try {
      const pid = String(req.params.pid);
      const provider = providerRegistry.get(pid);
      if (!provider) {
        res.status(404).json({ error: `Provider "${pid}" not found` });
        return;
      }

      const builtInModels = provider.getModels();
      const discoveredModels = await discoverModels(pid);

      res.json({ discoveredModels, builtInModels });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      res.status(500).json({ error: message });
    }
  });

  // ─── Playbooks ──────────────────────────────────────────────────────

  // GET /playbooks - list all playbook names
  router.get("/playbooks", async (req: Request, res: Response) => {
    try {
      const limit = req.query.limit ? Number(req.query.limit) : 100;
      const offset = req.query.offset ? Number(req.query.offset) : 0;

      const playbooks = playbookDb.listPlaybooks({ limit, offset });

      // Return just the names (frontend expects { playbooks: string[] })
      const names = playbooks.map(pb => pb.name);

      res.json({
        playbooks: names,
      });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      res.status(500).json({ error: message });
    }
  });

  // GET /playbooks/:id - get single playbook (supports ID or name)
  router.get("/playbooks/:id", async (req: Request, res: Response) => {
    try {
      const id = String(req.params.id);

      // Try to find by ID first, then by name
      let playbook = playbookDb.getPlaybook(id);
      if (!playbook) {
        playbook = playbookDb.getPlaybookByName(id);
      }

      if (!playbook) {
        res.status(404).json({ error: `Playbook "${id}" not found` });
        return;
      }

      // Parse the YAML content and return the parsed object
      const validation = validateYAMLPlaybook(playbook.yamlContent);
      if (!validation.valid || !validation.parsed) {
        res.status(500).json({
          error: "Failed to parse playbook YAML",
          details: validation.errors,
        });
        return;
      }

      // Return parsed playbook with metadata
      res.json({
        ...validation.parsed,
        id: playbook.id,
        source: "global",
      });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      res.status(500).json({ error: message });
    }
  });

  // POST /playbooks - upload/import YAML playbook
  router.post("/playbooks", async (req: Request, res: Response) => {
    try {
      const yamlContent = typeof req.body === "string" ? req.body : req.body.yaml;

      if (!yamlContent || typeof yamlContent !== "string") {
        res.status(400).json({ error: "YAML content is required (send as string or { yaml: '...' })" });
        return;
      }

      // Validate YAML
      const validation = validateYAMLPlaybook(yamlContent);
      if (!validation.valid) {
        res.status(400).json({
          error: "Playbook validation failed",
          errors: validation.errors,
          warnings: validation.warnings,
        });
        return;
      }

      // Check for duplicate name (advisory check - UNIQUE constraint is the source of truth)
      const existing = playbookDb.getPlaybookByName(validation.parsed.name);
      if (existing) {
        res.status(409).json({ error: `Playbook with name "${validation.parsed.name}" already exists` });
        return;
      }

      // Save to database with UNIQUE constraint protection
      const id = randomUUID();
      const now = new Date().toISOString();
      try {
        playbookDb.insertPlaybook({
          id,
          name: validation.parsed.name,
          description: validation.parsed.description || "",
          yamlContent,
          createdAt: now,
          updatedAt: now,
        });
      } catch (insertErr) {
        // Handle SQLite UNIQUE constraint violation (race condition)
        const errMsg = insertErr instanceof Error ? insertErr.message : String(insertErr);
        if (errMsg.includes("UNIQUE") || errMsg.includes("unique")) {
          res.status(409).json({ error: `Playbook with name "${validation.parsed.name}" already exists` });
          return;
        }
        throw insertErr; // Re-throw other errors
      }

      const saved = playbookDb.getPlaybook(id);
      res.status(201).json({
        ...saved,
        warnings: validation.warnings,
      });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      res.status(500).json({ error: message });
    }
  });

  // DELETE /playbooks/:id - delete playbook
  router.delete("/playbooks/:id", async (req: Request, res: Response) => {
    try {
      const id = String(req.params.id);
      const deleted = playbookDb.deletePlaybook(id);
      if (!deleted) {
        res.status(404).json({ error: `Playbook "${id}" not found` });
        return;
      }
      res.json({ success: true });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      res.status(500).json({ error: message });
    }
  });

  // POST /playbooks/:id/run - execute playbook (spawn agents)
  router.post("/playbooks/:id/run", async (req: Request, res: Response) => {
    try {
      const playbookId = String(req.params.id);
      const { sessionId, task, variables = {}, dryRun } = req.body as {
        sessionId: string;
        task?: string;
        variables?: Record<string, string>;
        dryRun?: boolean;
      };

      if (!sessionId) {
        res.status(400).json({ error: "sessionId is required" });
        return;
      }

      const session = sessionManager.getSession(sessionId);
      if (!session) {
        res.status(404).json({ error: `Session "${sessionId}" not found` });
        return;
      }

      const orch = orchestrators.get(sessionId);
      if (!orch) {
        res.status(500).json({ error: `No orchestrator for session "${sessionId}"` });
        return;
      }

      const playbook = await loadPlaybook(globalConfigDir, playbookId);
      if (!playbook) {
        res.status(404).json({ error: `Playbook "${playbookId}" not found` });
        return;
      }

      const { PlaybookExecutor } = await import("../core/playbook-executor.js");
      const executor = new PlaybookExecutor(orch, providerRegistry, session.config, playbook, variables, session.runtimeDir);

      // Phase 1: SETUP (sync — validate, interpolate)
      try {
        const execution = executor.setup();
        if (dryRun) {
          res.json({ dryRun: true, valid: true, plan: execution });
          return;
        }
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        res.status(400).json({ error: msg });
        return;
      }

      // Wire WebSocket events
      executor.on("playbook-progress", (data: any) => broadcastEvent({ event: "playbook-progress", ...data }));
      executor.on("playbook-complete", (data: any) => broadcastEvent({ event: "playbook-complete", ...data }));
      executor.on("playbook-failed", (data: any) => broadcastEvent({ event: "playbook-failed", ...data }));

      // Phase 2+3: EXECUTE + FINALIZE (async, fire-and-forget)
      executor.run(task).catch((err) => {
        logger.error({ err }, "[playbook-run] Execution failed");
      });

      // Return 202 immediately
      res.status(202).json({
        executionId: executor.execution.id,
        status: "running",
        agents: executor.execution.agents,
      });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      res.status(500).json({ error: message });
    }
  });

  // ─── Launch Playbook into Existing Session ─────────────────────────

  router.post("/sessions/:sid/playbook", async (req: Request, res: Response) => {
    try {
      const sid = String(req.params.sid);
      const { playbook: playbookName, task } = req.body as { playbook?: string; task?: string };

      if (!playbookName) {
        res.status(400).json({ error: "playbook name is required" });
        return;
      }

      const session = sessionManager.getSession(sid);
      if (!session) {
        res.status(404).json({ error: `Session "${sid}" not found` });
        return;
      }

      const orch = orchestrators.get(sid);
      const am = orch?.agentManager;
      if (!am) {
        res.status(500).json({ error: `No Orchestrator found for session "${sid}"` });
        return;
      }

      const playbook = await loadPlaybook(globalConfigDir, playbookName);
      if (!playbook) {
        res.status(404).json({ error: `Playbook "${playbookName}" not found` });
        return;
      }

      // Check for name conflicts with existing agents
      const existingNames = new Set(am.listAgents().map(a => a.config.name.toLowerCase()));
      for (const pa of playbook.agents) {
        if (existingNames.has(pa.name.toLowerCase())) {
          res.status(409).json({ error: `Agent name "${pa.name}" conflicts with an existing agent in this session` });
          return;
        }
      }

      // Sort: masters first, then workers
      const sorted = [...playbook.agents].sort((a, b) => {
        if (a.role === "master" && b.role !== "master") return -1;
        if (a.role !== "master" && b.role === "master") return 1;
        return 0;
      });

      const spawned: Array<{ id: string; name: string; role: string; status: string }> = [];
      const executionId = `exec-${Date.now()}`;
      const agentStatuses = sorted.map(pa => ({ name: pa.name, role: pa.role, status: "pending" as string, agentId: undefined as string | undefined, error: undefined as string | undefined }));

      // Emit execution start event
      await orch.eventLog.log({ sessionId: sid, type: "playbook-progress" as any, data: {
        executionId, sessionId: sid, playbookName, phase: "execute",
        agents: agentStatuses, status: "running",
      }});
      broadcastEvent({ event: "playbook-progress", sessionId: sid, executionId, playbookName, phase: "execute", agents: agentStatuses });

      for (const pa of sorted) {
        const providerId = pa.provider ?? session.config.defaultProvider;
        const provider = providerRegistry.get(providerId);
        if (!provider) {
          // Skip agents with unknown providers, but continue spawning others
          continue;
        }

        const permissions = pa.role === "master"
          ? { ...DEFAULT_MASTER_PERMISSIONS }
          : { ...DEFAULT_WORKER_PERMISSIONS };

        const currentAgents = am.listAgents().filter(a => a.status === "running");
        const peers = currentAgents.map(a => ({
          id: a.id,
          name: a.config.name,
          role: a.config.role,
          provider: a.config.cliProvider,
          model: a.config.model,
        }));

        const fullPersona = buildPersona({
          agentId: "pending",
          role: pa.role,
          userPersona: pa.persona,
          permissions,
          sessionId: sid,
          runtimeDir: session.runtimeDir,
          peers,
          projectPath: session.config.projectPath,
          workflowStates: session.config.workflowStates,
        });

        // Use the task param as initialTask for the master agent only
        const initialTask = pa.role === "master" && task ? task : pa.initialTask;

        const agentState = await am.spawnAgent({
          sessionId: sid,
          name: pa.name,
          role: pa.role,
          provider,
          model: pa.model,
          persona: fullPersona,
          workingDirectory: session.config.projectPath,
          runtimeDir: session.runtimeDir,
          extraCliArgs: pa.extraCliArgs,
          initialTask,
          messagingMode: session.config.messagingMode || "mcp",
          worktreeMode: session.config.worktreeMode,
        });

        broadcastEvent({ event: "agent-spawned", sessionId: sid, agentId: agentState.id });
        spawned.push({ id: agentState.id, name: pa.name, role: pa.role, status: agentState.status });

        // Update execution progress
        const agentIdx = agentStatuses.findIndex(a => a.name === pa.name);
        if (agentIdx >= 0) {
          agentStatuses[agentIdx].status = "spawned";
          agentStatuses[agentIdx].agentId = agentState.id;
        }
        await orch.eventLog.log({ sessionId: sid, type: "playbook-progress" as any, data: {
          executionId, sessionId: sid, playbookName, phase: "execute",
          agents: agentStatuses, status: "running",
        }});
        broadcastEvent({ event: "playbook-progress", sessionId: sid, executionId, playbookName, agents: agentStatuses });
      }

      // Emit execution complete
      const allSpawned = agentStatuses.every(a => a.status === "spawned");
      const finalStatus = allSpawned ? "complete" : agentStatuses.some(a => a.status === "spawned") ? "partial" : "failed";
      await orch.eventLog.log({ sessionId: sid, type: "playbook-complete" as any, data: {
        executionId, sessionId: sid, playbookName, phase: "finalize",
        agents: agentStatuses, status: finalStatus,
      }});
      broadcastEvent({ event: "playbook-complete", sessionId: sid, executionId, playbookName, agents: agentStatuses, status: finalStatus });

      res.status(201).json({ spawned, total: spawned.length, executionId });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      res.status(500).json({ error: message });
    }
  });

  // ─── Plain Terminal (bare shell, no agent) ─────────────────────────

  router.post("/sessions/:sid/terminal", async (req: Request, res: Response) => {
    try {
      const sid = String(req.params.sid);
      const session = sessionManager.getSession(sid);
      if (!session) {
        res.status(404).json({ error: `Session "${sid}" not found` });
        return;
      }

      const termId = `term-${randomUUID().slice(0, 8)}`;
      const tmuxSessionName = `${getRuntimeTmuxPrefix(process.env.KORA_DEV === "1")}${sid}-${termId}`;

      await tmux.newSession(tmuxSessionName);

      // Wait for shell prompt before sending cd (shell may not be ready yet)
      const maxWait = 3000;
      const pollInterval = 200;
      let waited = 0;
      while (waited < maxWait) {
        try {
          const output = await tmux.capturePane(tmuxSessionName, 5);
          const lastLine = output.trim().split('\n').pop() || '';
          if (lastLine.match(/[$%>❯]\s*$/)) break;
        } catch { /* pane may not be ready */ }
        await new Promise(r => setTimeout(r, pollInterval));
        waited += pollInterval;
      }

      // cd to the project directory
      await tmux.sendKeys(tmuxSessionName, `cd ${session.config.projectPath}`, { literal: false });

      // Track this standalone terminal
      if (!standaloneTerminals.has(sid)) {
        standaloneTerminals.set(sid, new Map());
      }
      standaloneTerminals.get(sid)!.set(termId, {
        id: termId,
        tmuxSession: tmuxSessionName,
        name: `Terminal ${(standaloneTerminals.get(sid)?.size || 0) + 1}`,
        createdAt: new Date().toISOString(),
        projectPath: session.config.projectPath,
      });

      // Persist terminal state to disk (survives daemon restart)
      await persistTerminalsForSession(sid);

      res.status(201).json({ id: termId, tmuxSession: tmuxSessionName, projectPath: session.config.projectPath });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      res.status(500).json({ error: message });
    }
  });

  // List all terminals (agent + standalone) for a session
  router.get("/sessions/:sid/terminals", async (req: Request, res: Response) => {
    try {
      const sid = String(req.params.sid);
      const session = sessionManager.getSession(sid);
      if (!session) {
        res.status(404).json({ error: `Session "${sid}" not found` });
        return;
      }

      const terminals: any[] = [];

      // Add standalone terminals
      const sessionTerminals = standaloneTerminals.get(sid);
      if (sessionTerminals) {
        sessionTerminals.forEach((term) => {
          terminals.push({
            id: term.id,
            tmuxSession: term.tmuxSession,
            name: term.name,
            type: "standalone",
            createdAt: term.createdAt,
          });
        });
      }

      // Add agent terminals
      const am = orchestrators.get(sid)?.agentManager;
      if (am) {
        const agents = am.listAgents();
        agents.forEach((agent: any) => {
          terminals.push({
            id: agent.id,
            tmuxSession: agent.config.tmuxSession,
            name: agent.config.name,
            type: "agent",
            agentName: agent.config.name,
            createdAt: agent.startedAt || new Date().toISOString(),
          });
        });
      }

      res.status(200).json({ terminals });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      res.status(500).json({ error: message });
    }
  });

  // DELETE /sessions/:sid/terminals/:tid — close a standalone terminal
  router.delete("/sessions/:sid/terminals/:tid", async (req: Request, res: Response) => {
    try {
      const sid = String(req.params.sid);
      const tid = String(req.params.tid);

      const terminals = standaloneTerminals.get(sid);
      const termInfo = terminals?.get(tid);
      if (!termInfo) {
        res.status(404).json({ error: `Terminal "${tid}" not found` });
        return;
      }

      // Kill the holdpty session + clean up socket
      try { await tmux.killSession(termInfo.tmuxSession); } catch { /* may already be dead */ }

      // Remove from tracking
      terminals!.delete(tid);

      // Persist updated state
      await persistTerminalsForSession(sid);

      res.json({ deleted: true, id: tid });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      res.status(500).json({ error: message });
    }
  });

  // ─── Git (Changes) ──────────────────────────────────────────────

  // Get git status (changed files + branch) — supports nested git repos
  router.get("/sessions/:sid/git/status", async (req: Request, res: Response) => {
    try {
      const sid = String(req.params.sid);
      const session = sessionManager.getSession(sid);
      if (!session) { res.status(404).json({ error: "Session not found" }); return; }

      const { execFile } = await import("child_process");
      const { promisify } = await import("util");
      const nodePath = await import("path");
      const nodeFs = await import("fs/promises");
      const exec = promisify(execFile);
      const projectRoot = session.config.projectPath;

      const statusMap: Record<string, string> = { M: "Modified", A: "Added", D: "Deleted", "??": "Untracked", R: "Renamed" };

      // Discover all git repos: root + nested (max 3 levels deep)
      const gitRepos: Array<{ repoPath: string; repoName: string }> = [];

      async function findGitRepos(dir: string, depth: number) {
        if (depth > 3) return;
        try {
          await nodeFs.access(nodePath.join(dir, ".git"));
          const relPath = nodePath.relative(projectRoot, dir);
          gitRepos.push({
            repoPath: dir,
            repoName: relPath || ".",
          });
        } catch {
          // Not a git repo at this level
        }

        // Scan subdirectories for nested repos (skip known non-repo dirs)
        if (depth < 3) {
          try {
            const entries = await nodeFs.readdir(dir, { withFileTypes: true });
            const skipDirs = new Set(["node_modules", ".git", "dist", "build", ".next", "target", "__pycache__", ".venv", "vendor"]);
            for (const entry of entries) {
              if (entry.isDirectory() && !skipDirs.has(entry.name) && !entry.name.startsWith(".")) {
                await findGitRepos(nodePath.join(dir, entry.name), depth + 1);
              }
            }
          } catch {}
        }
      }

      await findGitRepos(projectRoot, 0);

      // If no git repos found, try root anyway
      if (gitRepos.length === 0) {
        gitRepos.push({ repoPath: projectRoot, repoName: "." });
      }

      // Gather status from all repos
      const repos: Array<{
        name: string;
        branch: string;
        changes: Array<{ status: string; file: string; statusLabel: string; repo: string }>;
      }> = [];
      let allChanges: Array<{ status: string; file: string; statusLabel: string; repo: string }> = [];
      let primaryBranch = "";

      for (const { repoPath, repoName } of gitRepos) {
        let branch = "";
        let changes: Array<{ status: string; file: string; statusLabel: string; repo: string }> = [];

        try {
          const branchResult = await exec("git", ["branch", "--show-current"], { cwd: repoPath });
          branch = branchResult.stdout.trim();
        } catch {}

        try {
          const statusResult = await exec("git", ["status", "--porcelain"], { cwd: repoPath });
          changes = statusResult.stdout.trim().split("\n").filter(Boolean).map(line => {
            const status = line.substring(0, 2).trim();
            const file = line.substring(3);
            // Prefix file path with repo name for nested repos
            const displayFile = repoName === "." ? file : `${repoName}/${file}`;
            return { status, file: displayFile, statusLabel: statusMap[status] || status, repo: repoName };
          });
        } catch {}

        if (repoName === ".") primaryBranch = branch;

        if (changes.length > 0 || repoName === ".") {
          repos.push({ name: repoName, branch, changes });
          allChanges = allChanges.concat(changes);
        }
      }

      res.json({
        branch: primaryBranch,
        changes: allChanges,
        repos,
      });
    } catch (err) {
      res.status(500).json({ error: String(err) });
    }
  });

  // Get git diff for a specific file — handles nested repos
  router.get("/sessions/:sid/git/diff", async (req: Request, res: Response) => {
    try {
      const sid = String(req.params.sid);
      const filePath = String(req.query.path || "");
      const repo = String(req.query.repo || ".");
      const session = sessionManager.getSession(sid);
      if (!session) { res.status(404).json({ error: "Session not found" }); return; }

      const { execFile } = await import("child_process");
      const { promisify } = await import("util");
      const nodePath = await import("path");
      const exec = promisify(execFile);

      // Resolve the repo directory
      const repoDir = repo === "." ? session.config.projectPath : nodePath.resolve(session.config.projectPath, repo);

      // Security: ensure resolved path is within project
      if (!repoDir.startsWith(nodePath.resolve(session.config.projectPath))) {
        res.status(400).json({ error: "Invalid repo path" });
        return;
      }

      // Strip repo prefix from file path to get the path relative to the repo
      const repoFile = repo === "." ? filePath : filePath.replace(`${repo}/`, "");

      try {
        // Get original content (from HEAD)
        let original = "";
        try {
          const { stdout } = await exec("git", ["show", `HEAD:${repoFile}`], { cwd: repoDir });
          original = stdout;
        } catch {
          // File doesn't exist in HEAD (new file)
          original = "";
        }

        // Get current content (modified version)
        let modified = "";
        try {
          const fullPath = nodePath.resolve(repoDir, repoFile);
          const fs = await import("fs/promises");
          modified = await fs.readFile(fullPath, "utf-8");
        } catch {
          // File may be deleted
          modified = "";
        }

        // Also keep the raw diff for fallback
        let diff = "";
        try {
          const { stdout } = await exec("git", ["diff", "HEAD", "--", repoFile], { cwd: repoDir });
          diff = stdout;
          if (!diff.trim() && modified) {
            // For untracked files, create a synthetic diff
            const { stdout: syntacticDiff } = await exec("git", ["diff", "--no-index", "/dev/null", repoFile], { cwd: repoDir }).catch(() => ({ stdout: "" }));
            diff = syntacticDiff;
          }
        } catch {
          diff = "";
        }

        res.json({ original, modified, diff, path: filePath, repo });
      } catch {
        res.json({ original: "", modified: "", diff: "", path: filePath, repo, error: "Could not get diff" });
      }
    } catch (err) {
      res.status(500).json({ error: String(err) });
    }
  });

  // ─── File System (Editor) ─────────────────────────────────────────

  // List files/directories in a path
  router.get("/sessions/:sid/files", async (req: Request, res: Response) => {
    try {
      const sid = String(req.params.sid);
      const session = sessionManager.getSession(sid);
      if (!session) { res.status(404).json({ error: "Session not found" }); return; }

      const subpath = String(req.query.path || "");
      const fullPath = path.join(session.config.projectPath, subpath);

      // Security: ensure path is within project directory
      const resolved = path.resolve(fullPath);
      if (!resolved.startsWith(path.resolve(session.config.projectPath))) {
        res.status(403).json({ error: "Access denied: path outside project" });
        return;
      }

      const fs = await import("fs/promises");
      const entries = await fs.readdir(resolved, { withFileTypes: true });
      const items = entries
        .filter(e => e.name !== 'node_modules' && e.name !== '.git') // hide node_modules and .git
        .map(e => ({
          name: e.name,
          type: e.isDirectory() ? "directory" : "file",
          path: path.join(subpath, e.name),
        }))
        .sort((a, b) => {
          if (a.type !== b.type) return a.type === "directory" ? -1 : 1;
          return a.name.localeCompare(b.name);
        });

      res.json({ items, currentPath: subpath });
    } catch (err) {
      res.status(500).json({ error: String(err) });
    }
  });

  // Read a file
  router.get("/sessions/:sid/files/read", async (req: Request, res: Response) => {
    try {
      const sid = String(req.params.sid);
      const session = sessionManager.getSession(sid);
      if (!session) { res.status(404).json({ error: "Session not found" }); return; }

      const filePath = String(req.query.path || "");
      const fullPath = path.resolve(session.config.projectPath, filePath);

      if (!fullPath.startsWith(path.resolve(session.config.projectPath))) {
        res.status(403).json({ error: "Access denied" }); return;
      }

      const fs = await import("fs/promises");
      const content = await fs.readFile(fullPath, "utf-8");
      const ext = path.extname(filePath).slice(1);

      res.json({ content, path: filePath, language: extToLanguage(ext) });
    } catch (err) {
      res.status(500).json({ error: String(err) });
    }
  });

  // Write a file
  router.put("/sessions/:sid/files/write", async (req: Request, res: Response) => {
    try {
      const sid = String(req.params.sid);
      const session = sessionManager.getSession(sid);
      if (!session) { res.status(404).json({ error: "Session not found" }); return; }

      const { path: filePath, content } = req.body;
      const fullPath = path.resolve(session.config.projectPath, filePath);

      if (!fullPath.startsWith(path.resolve(session.config.projectPath))) {
        res.status(403).json({ error: "Access denied" }); return;
      }

      const fs = await import("fs/promises");
      await fs.writeFile(fullPath, content, "utf-8");
      res.json({ saved: true, path: filePath });
    } catch (err) {
      res.status(500).json({ error: String(err) });
    }
  });

  // ─── Suggestions (Recent Paths & CLI Flags) ──────────────────────────

  router.get("/suggestions/paths", (req: Request, res: Response) => {
    try {
      const limit = parseInt(req.query.limit as string) || 10;
      const paths = suggestionsDb.getRecentPaths(limit);
      res.json({ paths });
    } catch (err) {
      logger.error({ err: err }, "[api] GET /suggestions/paths error");
      res.status(500).json({ error: String(err) });
    }
  });

  router.get("/suggestions/flags", (req: Request, res: Response) => {
    try {
      const limit = parseInt(req.query.limit as string) || 10;
      const flags = suggestionsDb.getRecentFlags(limit);
      res.json({ flags });
    } catch (err) {
      logger.error({ err: err }, "[api] GET /suggestions/flags error");
      res.status(500).json({ error: String(err) });
    }
  });

  router.get("/suggestions/agent-configs", (req: Request, res: Response) => {
    try {
      const limit = parseInt(req.query.limit as string) || 10;
      const configs = suggestionsDb.getRecentAgentConfigs(limit);
      res.json({ configs });
    } catch (err) {
      logger.error({ err: err }, "[api] GET /suggestions/agent-configs error");
      res.status(500).json({ error: String(err) });
    }
  });

  // ── Custom Personas CRUD ──────────────────────────────────

  router.get("/personas", (_req: Request, res: Response) => {
    try {
      const personas = suggestionsDb.getPersonas();
      res.json({ personas });
    } catch (err) {
      res.status(500).json({ error: String(err) });
    }
  });

  router.post("/personas", (req: Request, res: Response) => {
    try {
      const { name, description, fullText } = req.body;
      if (!name?.trim() || !fullText?.trim()) {
        res.status(400).json({ error: "name and fullText are required" });
        return;
      }
      const id = `custom-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;
      suggestionsDb.createPersona({ id, name: name.trim(), description: (description || name).trim(), fullText: fullText.trim() });
      res.status(201).json({ id, name: name.trim(), description: (description || name).trim(), fullText: fullText.trim() });
    } catch (err) {
      res.status(500).json({ error: String(err) });
    }
  });

  router.put("/personas/:id", (req: Request, res: Response) => {
    try {
      const id = String(req.params.id);
      const existing = suggestionsDb.getPersona(id);
      if (!existing) {
        res.status(404).json({ error: `Persona "${id}" not found` });
        return;
      }
      const { name, description, fullText } = req.body;
      if (name !== undefined && !name.trim()) {
        res.status(400).json({ error: "name cannot be empty" });
        return;
      }
      if (fullText !== undefined && !fullText.trim()) {
        res.status(400).json({ error: "fullText cannot be empty" });
        return;
      }
      suggestionsDb.updatePersona(id, { name, description, fullText });
      res.json({ updated: true });
    } catch (err) {
      res.status(500).json({ error: String(err) });
    }
  });

  router.delete("/personas/:id", (req: Request, res: Response) => {
    try {
      suggestionsDb.deletePersona(String(req.params.id));
      res.json({ deleted: true });
    } catch (err) {
      res.status(500).json({ error: String(err) });
    }
  });

  // ── Post-Merge Rebase Broadcast ──────────────────────────
  // Broadcasts a rebase reminder to all running agents in a session.
  // Can be triggered manually by the Architect or via webhook after PR merge.
  router.post("/sessions/:sid/broadcast-rebase", async (req: Request, res: Response) => {
    try {
      const sid = String(req.params.sid);
      const body = req.body as { prNumber?: number | string; prTitle?: string; message?: string };

      const orch = orchestrators.get(sid);
      if (!orch) {
        res.status(404).json({ error: `Session "${sid}" not found` });
        return;
      }

      const prInfo = body.prNumber ? `PR #${body.prNumber}${body.prTitle ? ` (${body.prTitle})` : ""}` : "A PR";
      const rebaseMsg = body.message ||
        `${prInfo} merged into main. Please rebase your branch NOW:\n` +
        `git fetch origin main && git rebase origin/main`;

      const broadcastMsg = `\x1b[1;33m[System]\x1b[0m: ${rebaseMsg}`;
      const agents = orch.agentManager.listAgents().filter((a) => a.status === "running");
      const results: Array<{ agentId: string; name: string; sent: boolean }> = [];

      // Batch enqueue all, then flush once
      for (const agent of agents) {
        try {
          orch.messageQueue.enqueueBatch(agent.id, agent.config.tmuxSession, broadcastMsg);
          results.push({ agentId: agent.id, name: agent.config.name, sent: true });
        } catch {
          results.push({ agentId: agent.id, name: agent.config.name, sent: false });
        }
      }
      orch.messageQueue.flushQueues();

      // Log event
      const session = sessionManager.getSession(sid);
      if (session) {
        const { EventLog } = await import("../core/event-log.js");
        const eventLog = new EventLog(session.runtimeDir);
        await eventLog.log({
          sessionId: sid,
          type: "message-sent" as any,
          data: {
            from: "system",
            fromName: "System",
            to: "all",
            toName: "All Agents",
            content: rebaseMsg.substring(0, 200),
            broadcast: true,
            messageType: "rebase-reminder",
            prNumber: body.prNumber,
            prTitle: body.prTitle,
          },
        });
      }

      logger.info({ sid, prNumber: body.prNumber, agentCount: results.length }, "[api] POST broadcast-rebase");
      res.json({ broadcast: true, prNumber: body.prNumber, sentTo: results.length, results });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      logger.error({ err }, "[api] POST broadcast-rebase error");
      res.status(500).json({ error: message });
    }
  });

  // ── Knowledge Entries ────────────────────────────────────
  // Read knowledge entries from .kora.yml and knowledge.md (reuses readKnowledgeEntries)
  router.get("/sessions/:sid/knowledge", async (req: Request, res: Response) => {
    try {
      const sid = String(req.params.sid);
      const session = sessionManager.getSession(sid);
      if (!session) { res.status(404).json({ error: "Session not found" }); return; }

      const entries: Array<{ text: string; source: string; timestamp?: string }> = [];

      // 1. Read from .kora.yml knowledge array
      try {
        const { loadProjectConfig } = await import("../core/project-config.js");
        const config = await loadProjectConfig(session.config.projectPath);
        if (config?.knowledge) {
          for (const k of config.knowledge) {
            entries.push({ text: k, source: ".kora.yml" });
          }
        }
      } catch { /* ignore */ }

      // 2. Read from knowledge.md using readKnowledgeEntries (reuse existing parser)
      try {
        const { readKnowledgeEntries } = await import("../core/context-discovery.js");
        const rawEntries = readKnowledgeEntries(session.config.projectPath, 200);
        for (const line of rawEntries) {
          // Format: "- [ISO_TIMESTAMP] [agent-name] entry text"
          const match = line.match(/^-?\s*\[([^\]]+)\]\s*\[([^\]]+)\]\s*(.+)$/);
          if (match) {
            entries.push({ text: match[3].trim(), source: match[2], timestamp: match[1] });
          } else {
            // Plain entry without timestamp/source
            const text = line.startsWith("- ") ? line.slice(2).trim() : line.trim();
            if (text) entries.push({ text, source: "knowledge.md" });
          }
        }
      } catch { /* ignore */ }

      res.json({ entries });
    } catch (err) {
      logger.error({ err }, "[api] GET knowledge error");
      res.status(500).json({ error: String(err) });
    }
  });

  // Delete all knowledge entries (clear knowledge.md)
  router.delete("/sessions/:sid/knowledge", async (req: Request, res: Response) => {
    try {
      const sid = String(req.params.sid);
      const session = sessionManager.getSession(sid);
      if (!session) { res.status(404).json({ error: "Session not found" }); return; }

      const fs = await import("fs/promises");
      const path = await import("path");
      const knowledgeMdPath = path.join(session.runtimeDir, "knowledge.md");
      try {
        await fs.writeFile(knowledgeMdPath, "# Session Knowledge\n\n", "utf-8");
      } catch { /* ignore */ }

      res.json({ cleared: true });
    } catch (err) {
      logger.error({ err }, "[api] DELETE knowledge error");
      res.status(500).json({ error: String(err) });
    }
  });

  return router;
}

// Helper: map file extension to Monaco language
function extToLanguage(ext: string): string {
  const map: Record<string, string> = {
    ts: "typescript", tsx: "typescriptreact", js: "javascript", jsx: "javascriptreact",
    py: "python", rs: "rust", go: "go", rb: "ruby", java: "java",
    c: "c", cpp: "cpp", h: "c", hpp: "cpp", cs: "csharp",
    html: "html", css: "css", scss: "scss", less: "less",
    json: "json", yaml: "yaml", yml: "yaml", toml: "toml",
    md: "markdown", txt: "plaintext", sh: "shell", bash: "shell",
    sql: "sql", graphql: "graphql", xml: "xml", svg: "xml",
    dockerfile: "dockerfile", makefile: "makefile",
  };
  return map[ext.toLowerCase()] || "plaintext";
}
