import { randomUUID } from "crypto";
import type { RouteDeps, Router, Request, Response } from "./route-deps.js";
import type { SendMessageRequest } from "@kora/shared";
import { DEFAULT_WORKFLOW_STATES } from "@kora/shared";
import { logger } from "../../core/logger.js";

export function registerMessageRoutes(router: Router, deps: RouteDeps): void {
  const { sessionManager, orchestrators, broadcastEvent } = deps;

  function getDb(sid: string) {
    const orch = orchestrators.get(sid);
    return orch?.database || null;
  }

  // ─── Direct Message ─────────────────────────────────────────────────

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

      // Determine sender to exclude from broadcast recipients (prevent self-delivery)
      const senderId = (body as any).from as string | undefined;

      // Batch enqueue all messages, then flush once (avoids N redundant processQueues calls)
      const broadcastMsg = `\x1b[1;33m[Broadcast]\x1b[0m: ${body.message}`;
      for (const agent of agents) {
        // Skip the sender — they already know what they broadcast
        // Check agent ID, agent name, and message content for sender identification
        if (senderId && (
          agent.id === senderId ||
          agent.config.name === senderId ||
          agent.config.name.toLowerCase() === senderId.toLowerCase()
        )) {
          continue;
        }
        // Also skip if the message itself contains "[From <agentId>]" matching this agent
        if (senderId && body.message?.includes(`[From ${agent.id}]`)) {
          continue;
        }
        try {
          orch.messageQueue.enqueueBatch(agent.id, agent.config.terminalSession, broadcastMsg);
          results.push({ agentId: agent.id, name: agent.config.name, sent: true });
        } catch (err) {
          results.push({ agentId: agent.id, name: agent.config.name, sent: false, error: String(err) });
        }
      }
      orch.messageQueue.flushQueues(); // Single delivery pass for all agents

      // Log broadcast event to timeline (reuse orchestrator's event log to avoid duplicate DB connections)
      if (orch) {
        await orch.eventLog.log({
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

      // Emit as channel-message on #all for Chat tab
      broadcastEvent({
        event: "channel-message",
        sessionId: sid,
        channel: "#all",
        message: {
          from: (body as any).from || "user",
          content: body.message,
          timestamp: new Date().toISOString(),
          channel: "#all",
        },
      });

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
      const body = req.body as { from: string; to: string; message: string; messageType?: string; channel?: string };

      if (!body.to || !body.message) {
        res.status(400).json({ error: "to and message are required" });
        return;
      }

      const orch = orchestrators.get(sid);
      if (!orch) {
        res.status(404).json({ error: `Session "${sid}" not found` });
        return;
      }

      // Record MCP activity for the sender (prevents premature idle detection)
      // Pass toolName so PASSIVE_TOOLS filtering works in agent-health.ts
      if (body.from && body.from !== "user") {
        try { orch.agentManager.recordMcpCall(body.from, "send_message"); } catch { /* non-fatal */ }
      }

      // Resolve agent name to ID (case-insensitive) — kora-cli sends names, not IDs
      let targetId = body.to;
      if (!orch.agentManager.getAgent(targetId)) {
        const agents = orch.agentManager.listAgents();
        const match = agents.find(a =>
          a.config.name.toLowerCase() === targetId.toLowerCase() ||
          a.id.toLowerCase() === targetId.toLowerCase() ||
          a.config.name.toLowerCase().includes(targetId.toLowerCase())
        );
        if (match) targetId = match.id;
      }

      const success = await orch.relayMessage(body.from || "user", targetId, body.message, body.messageType, body.channel);
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
        const { AgentHealthMonitor } = await import("../../core/agent-health.js");
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

      // Emit WebSocket event for channel messages (enables real-time Chat tab)
      if (body.channel) {
        broadcastEvent({
          event: "channel-message",
          sessionId: sid,
          channel: body.channel,
          message: {
            from: body.from || "user",
            content: body.message,
            timestamp: new Date().toISOString(),
            channel: body.channel,
          },
        });
      }

      res.json({ relayed: true, from: body.from || "user", to: body.to });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      res.status(500).json({ error: message });
    }
  });

  // ─── SQLite Messages ─────────────────────────────────────────────────────

  /** Get messages for an agent (SQLite-based) */
  // Agent tool call traces (replay/debug)
  router.get("/sessions/:sid/agents/:aid/traces", (req: Request, res: Response) => {
    try {
      const { sid, aid } = req.params;
      const db = getDb(String(sid));
      if (!db) { res.status(404).json({ error: "Session not found" }); return; }
      const toolName = req.query.tool as string | undefined;
      const success = req.query.success !== undefined ? req.query.success === "true" : undefined;
      const limit = req.query.limit ? parseInt(req.query.limit as string, 10) : 100;
      const before = req.query.before as string | undefined;
      const traces = db.getTraces(String(sid), String(aid), { toolName, success, limit, before });
      res.json({ traces });
    } catch (err) { res.status(500).json({ error: String(err) }); }
  });

  // Log a tool call trace (called by MCP server)
  router.post("/sessions/:sid/agents/:aid/traces", (req: Request, res: Response) => {
    try {
      const { sid, aid } = req.params;
      const db = getDb(String(sid));
      if (!db) { res.status(404).json({ error: "Session not found" }); return; }
      const { randomUUID } = require("crypto");
      const { toolName, inputArgs, outputResult, durationMs, success } = req.body;

      // Record MCP activity with toolName so PASSIVE_TOOLS filtering works.
      // This is the primary call site — every MCP tool call flows through traces.
      const orch = orchestrators.get(String(sid));
      if (orch && toolName) {
        try { orch.agentManager.recordMcpCall(String(aid), toolName); } catch { /* non-fatal */ }
      }

      db.insertTrace({
        id: randomUUID().slice(0, 12),
        sessionId: String(sid), agentId: String(aid),
        toolName: toolName || "unknown",
        inputArgs: typeof inputArgs === "string" ? inputArgs : JSON.stringify(inputArgs),
        outputResult: typeof outputResult === "string" ? outputResult : JSON.stringify(outputResult),
        durationMs, success: success !== false,
        timestamp: new Date().toISOString(),
      });
      // Periodic cleanup (every ~100 inserts, cleanup old traces)
      if (Math.random() < 0.01) { try { db.cleanupOldTraces(24); } catch {} }
      res.json({ logged: true });
    } catch (err) { res.status(500).json({ error: String(err) }); }
  });

  router.get("/sessions/:sid/agents/:aid/messages", (req: Request, res: Response) => {
    try {
      const { sid, aid } = req.params;
      const orch = orchestrators.get(String(sid));
      if (!orch) {
        res.status(404).json({ error: `Session "${sid}" not found` });
        return;
      }

      // Don't record check_messages as MCP activity — it's passive/polling
      // (was causing agents to never go idle)

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
      // Also reset re-notification escalation — agent has actively read messages
      orch.messageQueue.resetNotificationAttempts(String(aid));
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

  // ── Channels (Group Chat) ──────────────────────────────────

  router.get("/sessions/:sid/channels", (req: Request, res: Response) => {
    try {
      const sid = String(req.params.sid);
      const db = getDb(sid);
      if (!db) { res.status(404).json({ error: "Session not found" }); return; }
      const orch = orchestrators.get(sid);
      const agents = orch ? orch.agentManager.listAgents() : [];
      const channels = db.getChannels(sid).map(ch => ({
        ...ch,
        memberCount: agents.filter(a => (a.config.channels || []).includes(ch.id)).length,
      }));
      res.json({ channels });
    } catch (err) { res.status(500).json({ error: "Internal server error" }); }
  });

  router.post("/sessions/:sid/channels", (req: Request, res: Response) => {
    try {
      const sid = String(req.params.sid);
      const db = getDb(sid);
      if (!db) { res.status(404).json({ error: "Session not found" }); return; }
      const { id, name, description } = req.body;
      if (!id || !name) { res.status(400).json({ error: "id and name required" }); return; }
      if (!id.startsWith("#") || /\s/.test(id)) { res.status(400).json({ error: "Channel id must start with # and contain no spaces" }); return; }
      db.createChannel({ id, sessionId: sid, name, description, createdBy: req.headers["x-agent-id"] as string || "user" });
      broadcastEvent({ event: "channel-created", sessionId: sid, channelId: id, name });
      res.status(201).json({ id, name, description, isDefault: false });
    } catch (err) { res.status(500).json({ error: "Internal server error" }); }
  });

  router.delete("/sessions/:sid/channels/:channelId", (req: Request, res: Response) => {
    try {
      const sid = String(req.params.sid);
      const channelId = String(req.params.channelId);
      const db = getDb(sid);
      if (!db) { res.status(404).json({ error: "Session not found" }); return; }
      const deleted = db.deleteChannel(channelId);
      if (!deleted) { res.status(400).json({ error: "Cannot delete default channel or channel not found" }); return; }
      broadcastEvent({ event: "channel-deleted", sessionId: sid, channelId });
      res.json({ success: true, deleted: channelId });
    } catch (err) { res.status(500).json({ error: "Internal server error" }); }
  });

  router.get("/sessions/:sid/channels/:channelId/messages", (req: Request, res: Response) => {
    try {
      const sid = String(req.params.sid);
      const channelId = String(req.params.channelId);
      const db = getDb(sid);
      if (!db) { res.status(404).json({ error: "Session not found" }); return; }
      const limit = parseInt(req.query.limit as string) || 50;
      const before = req.query.before as string | undefined;
      const messages = db.getChannelMessages(channelId, limit, before);
      res.json({ messages, channel: channelId });
    } catch (err) { res.status(500).json({ error: "Internal server error" }); }
  });

  // NOTE: join/leave modify in-memory agent config only. Channel memberships
  // are not persisted to DB — they reset on daemon restart. Agents are re-assigned
  // default channels (#all, #orchestration) on spawn/restore.
  router.post("/sessions/:sid/channels/:channelId/join", (req: Request, res: Response) => {
    try {
      const sid = String(req.params.sid);
      const channelId = String(req.params.channelId);
      if (!channelId.startsWith("#") || /\s/.test(channelId)) { res.status(400).json({ error: "Invalid channel ID" }); return; }
      const orch = orchestrators.get(sid);
      if (!orch) { res.status(404).json({ error: "Session not running" }); return; }
      const agentId = req.body.agentId || req.headers["x-agent-id"] as string;
      if (!agentId) { res.status(400).json({ error: "agentId required" }); return; }
      const agent = orch.agentManager.getAgent(agentId);
      if (!agent) { res.status(404).json({ error: "Agent not found" }); return; }
      const channels = new Set(agent.config.channels || []);
      channels.add(channelId);
      agent.config.channels = [...channels];
      res.json({ success: true, agentId, channel: channelId, channels: agent.config.channels });
    } catch (err) { res.status(500).json({ error: "Internal server error" }); }
  });

  router.post("/sessions/:sid/channels/:channelId/leave", (req: Request, res: Response) => {
    try {
      const sid = String(req.params.sid);
      const channelId = String(req.params.channelId);
      if (!channelId.startsWith("#") || /\s/.test(channelId)) { res.status(400).json({ error: "Invalid channel ID" }); return; }
      if (channelId === "#all") { res.status(400).json({ error: "Cannot leave #all channel" }); return; }
      const orch = orchestrators.get(sid);
      if (!orch) { res.status(404).json({ error: "Session not running" }); return; }
      const agentId = req.body.agentId || req.headers["x-agent-id"] as string;
      if (!agentId) { res.status(400).json({ error: "agentId required" }); return; }
      const agent = orch.agentManager.getAgent(agentId);
      if (!agent) { res.status(404).json({ error: "Agent not found" }); return; }
      agent.config.channels = (agent.config.channels || []).filter(c => c !== channelId);
      res.json({ success: true, agentId, channel: channelId, channels: agent.config.channels });
    } catch (err) { res.status(500).json({ error: "Internal server error" }); }
  });
}
