import { randomUUID } from "crypto";
import path from "path";
import fsPromises from "fs/promises";
import type { RouteDeps, Router, Request, Response } from "./route-deps.js";
import type {
  SpawnAgentRequest,
  SendMessageRequest,
  ChangeModelRequest,
} from "@kora/shared";
import { DEFAULT_WORKFLOW_STATES } from "@kora/shared";
import { DEFAULT_MASTER_PERMISSIONS, DEFAULT_WORKER_PERMISSIONS } from "@kora/shared";
import { buildPersona } from "../../core/persona-builder.js";
import { analyzeTerminalOutput } from "../../core/terminal-analyzer.js";
import { logger } from "../../core/logger.js";

export function registerAgentRoutes(router: Router, deps: RouteDeps): void {
  const { sessionManager, orchestrators, providerRegistry, terminal, suggestionsDb, broadcastEvent, outputCache, stripAnsi } = deps;
  const tmux = terminal;

  function getDb(sid: string) {
    const orch = orchestrators.get(sid);
    return orch?.database || null;
  }

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
        supportsMcp: provider.supportsMcp,
        messagingMode: session.config.messagingMode || "mcp",
        worktreeMode: session.config.worktreeMode,
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

  /** Get tool usage summary for an agent (from Claude Code JSONL session data) */
  router.get("/sessions/:sid/agents/:aid/tool-usage", (req: Request, res: Response) => {
    try {
      const { sid, aid } = req.params;
      const orch = orchestrators.get(String(sid));
      if (!orch) { res.status(404).json({ error: "Session not found" }); return; }

      const agent = orch.agentManager.getAgent(String(aid));
      if (!agent) { res.status(404).json({ error: "Agent not found" }); return; }

      const toolUsage = orch.usageMonitor.getToolUsageSummary(String(aid));
      res.json({
        agentId: aid,
        toolUsage: toolUsage || {},
        totalCalls: toolUsage ? Object.values(toolUsage).reduce((sum, c) => sum + c, 0) : 0,
      });
    } catch (err) {
      res.status(500).json({ error: String(err) });
    }
  });

  /** Get files modified by an agent (from Claude Code JSONL session data) */
  router.get("/sessions/:sid/agents/:aid/files-modified", (req: Request, res: Response) => {
    try {
      const { sid, aid } = req.params;
      const orch = orchestrators.get(String(sid));
      if (!orch) { res.status(404).json({ error: "Session not found" }); return; }

      const agent = orch.agentManager.getAgent(String(aid));
      if (!agent) { res.status(404).json({ error: "Agent not found" }); return; }

      const files = orch.usageMonitor.getFilesModified(String(aid));
      res.json({ agentId: aid, filesModified: files || [], count: files?.length || 0 });
    } catch (err) {
      res.status(500).json({ error: String(err) });
    }
  });

  /** Get conversation metrics for an agent (turn count + messages/min) */
  router.get("/sessions/:sid/agents/:aid/conversation-metrics", (req: Request, res: Response) => {
    try {
      const { sid, aid } = req.params;
      const orch = orchestrators.get(String(sid));
      if (!orch) { res.status(404).json({ error: "Session not found" }); return; }

      const agent = orch.agentManager.getAgent(String(aid));
      if (!agent) { res.status(404).json({ error: "Agent not found" }); return; }

      const metrics = orch.usageMonitor.getConversationMetrics(String(aid));
      res.json({ agentId: aid, ...(metrics || { turnCount: 0, messagesPerMinute: 0 }) });
    } catch (err) {
      res.status(500).json({ error: String(err) });
    }
  });

  // Get agent's persona (system prompt) file contents
  router.get("/sessions/:sid/agents/:aid/persona", async (req: Request, res: Response) => {
    try {
      const sid = String(req.params.sid);
      const aid = String(req.params.aid);
      const session = sessionManager.getSession(sid);
      if (!session) { res.status(404).json({ error: "Session not found" }); return; }

      const orch = orchestrators.get(sid);
      if (!orch) { res.status(404).json({ error: "Session not running" }); return; }

      const agent = orch.agentManager.getAgent(aid);
      if (!agent) { res.status(404).json({ error: "Agent not found" }); return; }

      const personaPath = path.join(session.runtimeDir, "personas", `${aid}-prompt.md`);
      try {
        const content = await fsPromises.readFile(personaPath, "utf-8");
        res.json({ agentId: aid, persona: content });
      } catch {
        res.json({ agentId: aid, persona: null });
      }
    } catch (err) {
      res.status(500).json({ error: "Internal server error" });
    }
  });

  // Update individual agent's persona
  router.put("/sessions/:sid/agents/:aid/persona", async (req: Request, res: Response) => {
    try {
      const sid = String(req.params.sid);
      const aid = String(req.params.aid);
      const session = sessionManager.getSession(sid);
      if (!session) { res.status(404).json({ error: "Session not found" }); return; }

      const orch = orchestrators.get(sid);
      if (!orch) { res.status(404).json({ error: "Session not running" }); return; }

      const agent = orch.agentManager.getAgent(aid);
      if (!agent) { res.status(404).json({ error: "Agent not found" }); return; }

      // Path traversal guard
      if (aid.includes("/") || aid.includes("..") || aid.includes("\0")) {
        res.status(400).json({ error: "Invalid agent ID" }); return;
      }

      const { persona } = req.body;
      if (typeof persona !== "string") { res.status(400).json({ error: "persona field (string) is required" }); return; }

      // Write updated persona to file
      const personaPath = path.join(session.runtimeDir, "personas", `${aid}-prompt.md`);
      await fsPromises.mkdir(path.dirname(personaPath), { recursive: true });
      await fsPromises.writeFile(personaPath, persona, "utf-8");

      // Notify agent that their context has been updated
      try {
        await orch.messageBus.deliverToInbox(aid, {
          id: randomUUID(),
          from: "system",
          to: aid,
          type: "status",
          content: `\x1b[1;33m[System]\x1b[0m Your persona has been updated. ${session.config.messagingMode === "cli" ? "Run \`kora-cli context persona\` to refresh." : 'Run get_context("persona") to refresh.'}`,
          timestamp: new Date().toISOString(),
        });
      } catch { /* non-fatal */ }

      broadcastEvent({ event: "agent-persona-updated", sessionId: sid, agentId: aid });
      res.json({ success: true, agentId: aid });
    } catch (err) {
      res.status(500).json({ error: "Internal server error" });
    }
  });

  // Update session-wide instructions for all agents
  router.put("/sessions/:sid/instructions", async (req: Request, res: Response) => {
    try {
      const sid = String(req.params.sid);
      const session = sessionManager.getSession(sid);
      if (!session) { res.status(404).json({ error: "Session not found" }); return; }

      const orch = orchestrators.get(sid);
      if (!orch) { res.status(404).json({ error: "Session not running" }); return; }

      const { instructions } = req.body;
      if (typeof instructions !== "string") { res.status(400).json({ error: "instructions field (string) is required" }); return; }

      // Write session instructions file
      const instructionsPath = path.join(session.runtimeDir, "session-instructions.md");
      await fsPromises.writeFile(instructionsPath, instructions, "utf-8");

      // Notify all running agents
      const agents = orch.agentManager.listAgents().filter(a => a.status === "running");
      for (const agent of agents) {
        try {
          await orch.messageBus.deliverToInbox(agent.id, {
            id: randomUUID(),
            from: "system",
            to: agent.id,
            type: "status",
            content: `\x1b[1;33m[System]\x1b[0m Session instructions updated. ${session.config.messagingMode === "cli" ? "Run \`kora-cli context all\` to refresh." : 'Run get_context("all") to refresh.'}`,
            timestamp: new Date().toISOString(),
          });
        } catch { /* non-fatal */ }
      }

      broadcastEvent({ event: "session-instructions-updated", sessionId: sid });
      res.json({ success: true, agentsNotified: agents.length });
    } catch (err) {
      res.status(500).json({ error: "Internal server error" });
    }
  });

  /** Get all agent context sections — single endpoint for MCP resources + CLI */
  router.get("/sessions/:sid/agents/:aid/context", async (req: Request, res: Response) => {
    try {
      const sid = String(req.params.sid);
      const aid = String(req.params.aid);
      const session = sessionManager.getSession(sid);
      if (!session) { res.status(404).json({ error: "Session not found" }); return; }

      const orch = orchestrators.get(sid);
      if (!orch) { res.status(404).json({ error: "Session not running" }); return; }

      const agent = orch.agentManager.getAgent(aid);
      if (!agent) { res.status(404).json({ error: "Agent not found" }); return; }

      // 1. Persona — read from file
      let persona: string | null = null;
      try {
        const personaPath = path.join(session.runtimeDir, "personas", `${aid}-prompt.md`);
        persona = await fsPromises.readFile(personaPath, "utf-8");
      } catch { /* may not exist */ }

      // 2. Team — list all agents
      const allAgents = orch.agentManager.listAgents();
      const team = allAgents.map((a) => ({
        id: a.id,
        name: a.config.name,
        role: a.config.role,
        status: a.status,
        provider: a.config.cliProvider,
        model: a.config.model,
        isSelf: a.id === aid,
      }));

      // 3. Workflow states
      const workflowStates = session.config.workflowStates || [];

      // 4. Knowledge entries (from knowledge-db)
      let knowledge: Array<Record<string, unknown>> = [];
      try {
        const db = getDb(sid);
        if (db) {
          knowledge = db.listKnowledge(sid, 50);
        }
      } catch { /* ignore */ }

      // 5. Rules (from .kora.yml)
      let rules: string[] = [];
      try {
        const { loadProjectConfig } = await import("../../core/project-config.js");
        const config = await loadProjectConfig(session.config.projectPath);
        if (config?.rules) rules = config.rules;
      } catch { /* ignore */ }

      // 6. Communication mode — use provider registry for supportsMcp
      const provider = providerRegistry.get(agent.config.cliProvider);
      const communication = {
        messagingMode: session.config.messagingMode || "mcp",
        supportsMcp: provider?.supportsMcp ?? false,
      };

      res.json({
        agentId: aid,
        name: agent.config.name,
        role: agent.config.role,
        provider: agent.config.cliProvider,
        model: agent.config.model,
        sessionId: sid,
        projectPath: session.config.projectPath,
        persona,
        team,
        workflow: workflowStates,
        knowledge,
        rules,
        communication,
      });
    } catch (err) {
      logger.error({ err }, "Failed to get agent context");
      res.status(500).json({ error: "Internal server error" });
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
        // Direct custom message via sendTerminalNotification — bypass queue entirely
        try {
          const { sendTerminalNotification } = await import("../../core/terminal-utils.js");
          await sendTerminalNotification(tmux, agent.config.terminalSession, `[Nudge]: ${customMessage}`);
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
          const unread = await orch.messageQueue.nudgeAgent(String(aid), agent.config.terminalSession);
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

  router.get("/sessions/:sid/agents/:aid/terminal-url", (req: Request, res: Response) => {
    const { sid, aid } = req.params;
    // Return the WebSocket URL the dashboard should connect to
    res.json({ url: `/terminal/${sid}/${aid}` });
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
        rawOutput = await tmux.capturePane(agent.config.terminalSession, lines);
        outputLines = rawOutput.split("\n");
        outputCache.set(cacheKey, rawOutput, outputLines);
      }

      // Strip ANSI codes if requested
      const stripAnsiFunc = stripAnsi();
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
        const rawOutput = await tmux.capturePane(agent.config.terminalSession, lines);
        outputLines = rawOutput.split("\n");
        outputCache.set(cacheKey, rawOutput, outputLines);
      }

      // Strip ANSI codes for cleaner analysis
      const stripAnsiFunc = stripAnsi();
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

      // Assign task to agent — use session's second workflow state (e.g. "in-progress")
      // instead of hardcoded "assigned" which isn't a valid workflow state
      const session_rt = sessionManager.getSession(String(sid));
      const ws_rt = session_rt?.config.workflowStates || DEFAULT_WORKFLOW_STATES;
      const assignedStatus = ws_rt.length > 1 ? ws_rt[1].id : "in-progress";
      db.updateTask(bestTask.id, { assignedTo: String(aid), status: assignedStatus });

      // Fetch updated task
      const updatedTask = db.getTask(bestTask.id);

      // Update agent activity
      agent.activity = "working";
      agent.lastActivityAt = new Date().toISOString();
      agent.idleSince = undefined;

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
}
