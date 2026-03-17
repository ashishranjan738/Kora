import { randomUUID } from "crypto";
import path from "path";
import { Router } from "express";
import type { Request, Response } from "express";
import type { WebSocketServer } from "ws";
import {
  APP_VERSION,
  API_VERSION,
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
import type { TmuxController } from "../core/tmux-controller.js";
import { EventLog } from "../core/event-log.js";
import { listPlaybooks, loadPlaybook, savePlaybook } from "../core/playbook-loader.js";
import { buildPersona } from "../core/persona-builder.js";
import { discoverModels } from "../core/model-discovery.js";
import { DEFAULT_MASTER_PERMISSIONS, DEFAULT_WORKER_PERMISSIONS } from "@kora/shared";

export function createApiRouter(deps: {
  sessionManager: SessionManager;
  orchestrators: Map<string, Orchestrator>;  // sessionId -> Orchestrator
  providerRegistry: CLIProviderRegistry;
  tmux: TmuxController;
  startTime: number;  // Date.now() at daemon start
  globalConfigDir: string;
}, wss: WebSocketServer): Router {
  const { sessionManager, orchestrators, providerRegistry, tmux, startTime, globalConfigDir } = deps;
  const router = Router();

  // Helper function to broadcast events to all WebSocket clients
  const broadcastEvent = (event: any) => {
    const message = JSON.stringify(event);
    wss.clients.forEach((client) => {
      if (client.readyState === 1) { // 1 = OPEN
        client.send(message);
      }
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
        port = (await fs.readFile(nodePath.join(os.default.homedir(), ".kora", "daemon.port"), "utf-8")).trim();
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
      });

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
      if (message.includes("already exists")) {
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
        const termPrefix = `${sid}-term-`;
        for (const s of allTmuxSessions) {
          if (s.startsWith(termPrefix)) {
            try { await tmux.killSession(s); } catch {}
          }
        }
      } catch {}

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

  // ─── Agents CRUD ─────────────────────────────────────────────────────

  router.get("/sessions/:sid/agents", (req: Request, res: Response) => {
    try {
      const sid = String(req.params.sid);
      const session = sessionManager.getSession(sid);
      if (!session) {
        res.status(404).json({ error: `Session "${sid}" not found` });
        return;
      }

      const am = orchestrators.get(sid)?.agentManager;
      const agents = am ? am.listAgents() : [];
      res.json({ agents });
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
        envVars: body.envVars,
        initialTask: body.initialTask,
        messagingMode: session.config.messagingMode || "mcp",
      });

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
      const results = [];
      for (const agent of agents) {
        try {
          const newAgent = await orch.replaceAgent(agent.id, { freshStart: true });
          results.push({ oldId: agent.id, newId: newAgent?.id, name: agent.config.name, success: true });
        } catch (err) {
          results.push({ oldId: agent.id, name: agent.config.name, success: false, error: String(err) });
        }
      }
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
      const body = req.body as { from: string; to: string; message: string };

      if (!body.to || !body.message) {
        res.status(400).json({ error: "to and message are required" });
        return;
      }

      const orch = orchestrators.get(sid);
      if (!orch) {
        res.status(404).json({ error: `Session "${sid}" not found` });
        return;
      }

      const success = await orch.relayMessage(body.from || "user", body.to, body.message);
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
      res.json({ tasks: db.getTasks(sid) });
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
      const task = {
        id: randomUUID().slice(0, 8),
        sessionId: sid,
        title: body.title,
        description: body.description || "",
        status: "pending",
        assignedTo: body.assignedTo || undefined,
        createdBy: "user",
        dependencies: body.dependencies || [],
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
      const task = db.updateTask(tid, {
        title: body.title,
        description: body.description,
        status: body.status,
        assignedTo: body.assignedTo,
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

      const query: EventsQueryParams = {
        since: req.query.since ? String(req.query.since) : undefined,
        limit: req.query.limit ? parseInt(req.query.limit as string) : 100,
        type: req.query.type ? String(req.query.type) : undefined,
      };

      // Use orchestrator's event log (has database attached) or create standalone
      const orch = orchestrators.get(sid);
      const eventLog = orch ? orch.eventLog : new EventLog(session.runtimeDir);
      const events = await eventLog.query({
        sessionId: sid,
        since: query.since,
        limit: query.limit,
        type: query.type as EventType | undefined,
      });

      res.json({ events });
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
      const tmuxSessionName = `${sid}-${termId}`;

      await tmux.newSession(tmuxSessionName);
      // cd to the project directory
      await tmux.sendKeys(tmuxSessionName, `cd ${session.config.projectPath}`, { literal: false });

      res.status(201).json({ id: termId, tmuxSession: tmuxSessionName, projectPath: session.config.projectPath });
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
