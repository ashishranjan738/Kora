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
import { EventLog } from "../core/event-log.js";
import { listPlaybooks, loadPlaybook, savePlaybook } from "../core/playbook-loader.js";
import { buildPersona } from "../core/persona-builder.js";
import { discoverModels } from "../core/model-discovery.js";
import { DEFAULT_MASTER_PERMISSIONS, DEFAULT_WORKER_PERMISSIONS } from "@kora/shared";
import { logger } from "../core/logger.js";
import { saveTerminalStates, loadTerminalStates } from "../core/terminal-persistence.js";
import type { StandaloneTerminal } from "../core/terminal-persistence.js";

export function createApiRouter(deps: {
  sessionManager: SessionManager;
  orchestrators: Map<string, Orchestrator>;  // sessionId -> Orchestrator
  providerRegistry: CLIProviderRegistry;
  tmux: IPtyBackend;
  startTime: number;  // Date.now() at daemon start
  globalConfigDir: string;
  suggestionsDb: SuggestionsDatabase;
}, wss: WebSocketServer): Router {
  const { sessionManager, orchestrators, providerRegistry, tmux, startTime, globalConfigDir, suggestionsDb } = deps;
  const router = Router();

  // Track standalone terminal sessions per session (id → terminal info)
  const standaloneTerminals = new Map<string, Map<string, StandaloneTerminal>>();

  // Restore standalone terminals from disk on daemon startup
  (async () => {
    const sessions = sessionManager.listSessions();
    for (const sessionConfig of sessions) {
      if (sessionConfig.status === "stopped") continue;

      try {
        const runtimeDir = path.join(sessionConfig.projectPath, getRuntimeDaemonDir(process.env.KORA_DEV === "1"));
        const persisted = await loadTerminalStates(runtimeDir);
        if (persisted.length === 0) continue;

        // Verify each terminal's holdpty session still exists
        const alive: StandaloneTerminal[] = [];
        for (const term of persisted) {
          const exists = await tmux.hasSession(term.tmuxSession);
          if (exists) {
            alive.push(term);
          } else {
            logger.debug({ sessionId: sessionConfig.id, terminalId: term.id }, "Standalone terminal died during daemon downtime");
          }
        }

        // Populate in-memory Map with alive terminals
        if (alive.length > 0) {
          const termMap = new Map<string, StandaloneTerminal>();
          alive.forEach(t => termMap.set(t.id, t));
          standaloneTerminals.set(sessionConfig.id, termMap);

          logger.info({ sessionId: sessionConfig.id, restored: alive.length, dead: persisted.length - alive.length }, "Restored standalone terminals");
        }

        // Re-persist if any terminals died
        if (alive.length !== persisted.length) {
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

      // Enrich each running agent with activity detection from terminal output
      const enrichedAgents = await Promise.all(agents.map(async (agent) => {
        // Get unread message count
        let unreadMessages = 0;
        if (orch) {
          try {
            unreadMessages = await orch.messageBus.getUnreadCount(agent.id);
          } catch { /* ignore */ }
        }

        if (agent.status !== "running") {
          return { ...agent, activity: agent.status, unreadMessages };
        }
        try {
          const output = await tmux.capturePane(agent.config.tmuxSession, 5, false);
          const lines = output.trim().split("\n").filter((l: string) => l.trim());
          const lastLine = lines[lines.length - 1] || "";

          let activity = "working";
          if (lastLine.includes("\u276F") || lastLine.includes("> ") || lastLine.match(/[$%#]\s*$/)) {
            activity = "idle";
          } else if (lastLine.includes("Thinking") || lastLine.includes("oking")) {
            activity = "thinking";
          } else if (lastLine.includes("Reading") || lastLine.includes("Searching")) {
            activity = "reading";
          } else if (lastLine.includes("Writing") || lastLine.includes("Editing")) {
            activity = "writing";
          } else if (lastLine.includes("Running") || lastLine.includes("Bash")) {
            activity = "running-command";
          }

          return { ...agent, activity, unreadMessages };
        } catch {
          return { ...agent, activity: "unknown", unreadMessages };
        }
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
      const providerId = body.cliProvider ?? session.config.defaultProvider;
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

      // Record CLI flags for autocomplete suggestions
      if (body.extraCliArgs && body.extraCliArgs.length > 0) {
        suggestionsDb.recordFlags(body.extraCliArgs.join(" "));
      }

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

      // Broadcast agent-removed event via WebSocket
      broadcastEvent({ event: "agent-removed", sessionId: String(sid), agentId: String(aid) });

      res.status(204).send();
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      res.status(500).json({ error: message });
    }
  });

  // Restart all agents in a session (fresh start — picks up latest MCP server code)
  router.post("/sessions/:sid/restart-all", async (req: Request, res: Response) => {
    try {
      const sid = String(req.params.sid);
      const orch = orchestrators.get(sid);
      if (!orch) { res.status(404).json({ error: "Session not found" }); return; }

      const agents = orch.agentManager.listAgents().filter(a => a.status === "running");
      const results = await Promise.all(agents.map(async (agent) => {
        try {
          const newAgent = await orch.replaceAgent(agent.id, { freshStart: true, shutdownTimeoutMs: 3000 });
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

  // Restart a crashed/stopped agent — re-spawns with same config (fresh start)
  router.post("/sessions/:sid/agents/:aid/restart", async (req: Request, res: Response) => {
    try {
      const sid = String(req.params.sid);
      const aid = String(req.params.aid);

      const orch = orchestrators.get(sid);
      if (!orch) {
        res.status(404).json({ error: `Session "${sid}" not found` });
        return;
      }

      const newAgent = await orch.replaceAgent(aid, { freshStart: true });
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

  // Replace agent — kills old, spawns fresh with terminal context for recovery
  router.post("/sessions/:sid/agents/:aid/replace", async (req: Request, res: Response) => {
    try {
      const sid = String(req.params.sid);
      const aid = String(req.params.aid);
      const body = req.body as { contextLines?: number; extraContext?: string; freshStart?: boolean };

      const orch = orchestrators.get(sid);
      if (!orch) {
        res.status(404).json({ error: `Session "${sid}" not found` });
        return;
      }

      const newAgent = await orch.replaceAgent(aid, {
        contextLines: body.contextLines ?? 50,
        extraContext: body.extraContext,
        freshStart: body.freshStart ?? false,
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

      for (const agent of agents) {
        try {
          // Use messageQueue-backed relayMessage so broadcast is delivered when agents are ready
          const broadcastMsg = `\x1b[1;33m[Broadcast]\x1b[0m: ${body.message}`;
          orch.messageQueue.enqueue(agent.id, agent.config.tmuxSession, broadcastMsg);
          results.push({ agentId: agent.id, name: agent.config.name, sent: true });
        } catch (err) {
          results.push({ agentId: agent.id, name: agent.config.name, sent: false, error: String(err) });
        }
      }

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

      const rawOutput = await tmux.capturePane(agent.config.tmuxSession, lines);
      const outputLines = rawOutput.split("\n");
      res.json({ output: outputLines });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      res.status(500).json({ error: message });
    }
  });

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
        await tmux.sendKeys(agent.config.tmuxSession, `\n[Nudge]: ${customMessage}\n`, { literal: true });
        res.json({ nudged: true, customMessage: true });
      } else {
        // Default: nudge with unread count
        const unread = await orch.messageQueue.nudgeAgent(String(aid), agent.config.tmuxSession);
        res.json({ nudged: true, unreadCount: unread });
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
        res.json({ tasks: db.getTasks(sid) });
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

      const task = {
        id: randomUUID().slice(0, 8),
        sessionId: sid,
        title: body.title,
        description: body.description || "",
        status: "pending",
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

      // Notify assigned agent
      if (task.assignedTo) {
        const orch = orchestrators.get(sid);
        if (orch) {
          try {
            const agent = orch.agentManager.getAgent(task.assignedTo);
            if (agent) {
              orch.messageQueue.enqueue(task.assignedTo, agent.config.tmuxSession,
                `\x1b[1;36m[Task assigned]\x1b[0m "${task.title}" — ${task.description}. Use list_tasks and update_task tools to manage it.`);
            }
          } catch {}
        }
      }

      // Broadcast task-created event via WebSocket
      broadcastEvent({ event: "task-created", sessionId: sid, taskId: task.id });

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
      const validStatuses = ["pending", "in-progress", "review", "done"];
      if (body.status !== undefined && !validStatuses.includes(body.status)) {
        res.status(400).json({ error: `status must be one of: ${validStatuses.join(", ")}` });
        return;
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

      // Notify if assignedTo changed
      if (body.assignedTo && task.assignedTo !== oldTask.assignedTo) {
        const orch = orchestrators.get(sid);
        if (orch) {
          try {
            const agent = orch.agentManager.getAgent(task.assignedTo);
            if (agent) {
              orch.messageQueue.enqueue(task.assignedTo, agent.config.tmuxSession,
                `\x1b[1;36m[Task assigned]\x1b[0m "${task.title}" — ${task.description}. Use list_tasks and update_task tools to manage it.`);
            }
          } catch {}
        }
      }

      // Broadcast task-updated event via WebSocket
      broadcastEvent({ event: "task-updated", sessionId: sid, taskId: tid });

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

  router.get("/playbooks", async (_req: Request, res: Response) => {
    try {
      const names = await listPlaybooks(globalConfigDir);
      res.json({ playbooks: names });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      res.status(500).json({ error: message });
    }
  });

  router.get("/playbooks/:name", async (req: Request, res: Response) => {
    try {
      const name = String(req.params.name);
      const playbook = await loadPlaybook(globalConfigDir, name);
      if (!playbook) {
        res.status(404).json({ error: `Playbook "${name}" not found` });
        return;
      }
      res.json(playbook);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      res.status(500).json({ error: message });
    }
  });

  router.post("/playbooks", async (req: Request, res: Response) => {
    try {
      const body = req.body;
      if (!body.name || !body.agents || !Array.isArray(body.agents)) {
        res.status(400).json({ error: "name and agents array are required" });
        return;
      }
      await savePlaybook(globalConfigDir, body);
      res.status(201).json(body);
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
      }

      res.status(201).json({ spawned, total: spawned.length });
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
        .filter(e => !e.name.startsWith('.') && e.name !== 'node_modules') // hide dotfiles and node_modules
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
