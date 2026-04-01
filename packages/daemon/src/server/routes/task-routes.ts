import { randomUUID } from "crypto";
import type { RouteDeps, Router, Request, Response } from "./route-deps.js";
import type {
  CreateTaskRequest,
  UpdateTaskRequest,
} from "@kora/shared";
import {
  DEFAULT_WORKFLOW_STATES,
  getEffectiveTransitions,
} from "@kora/shared";
import { computeTaskMetrics, TaskMetricsDebouncer } from "../../core/task-metrics.js";
import { logger } from "../../core/logger.js";
import { buildTransitionNotification, buildBackwardNotification, buildCancellationNotification, buildReassignmentNotification } from "../../core/variable-resolver.js";
import type { WorkflowState } from "@kora/shared";

export function registerTaskRoutes(router: Router, deps: RouteDeps): void {
  const { sessionManager, orchestrators, broadcastEvent } = deps;

  function getDb(sid: string) {
    const orch = orchestrators.get(sid);
    return orch?.database || null;
  }

  const taskMetricsDebouncer = new TaskMetricsDebouncer();

  // ─── Tasks (SQLite) ──────────────────────────────────────────────────

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

      // Auto-transition: if task is in first workflow state (backlog/pending), move to second state on assignment
      if (task.assignedTo) {
        const session_create = sessionManager.getSession(sid);
        const ws = session_create?.config.workflowStates || DEFAULT_WORKFLOW_STATES;
        const firstState = ws[0]?.id;
        const secondState = ws.length > 1 ? ws[1]?.id : undefined;
        if (task.status === firstState && secondState) {
          db.updateTask(task.id, { status: secondState });
          task.status = secondState;
        }
      }

      // Notify assigned agent via terminal + SQLite (so check_messages finds it)
      if (task.assignedTo) {
        const orch = orchestrators.get(sid);
        if (orch) {
          try {
            const agent = orch.agentManager.getAgent(task.assignedTo);
            const notifyMsg = `[Task assigned — START NOW] "${task.title}" (${task.priority}). You have been assigned this task. Begin implementation immediately. Use get_task("${task.id}") for details.`;
            if (agent) {
              orch.messageQueue.enqueue(task.assignedTo, agent.config.terminalSession,
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

  router.put("/sessions/:sid/tasks/:tid", async (req: Request, res: Response) => {
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
      // Force mode: by default only humans (no X-Agent-Id header) can force-transition.
      // If session has allowMasterForceTransition: true, master agents can also force.
      // Workers can NEVER force regardless of session config.
      const forceMode = (body as any).force === true;
      if (forceMode) {
        const callerAgentId = req.headers["x-agent-id"] as string | undefined;
        if (callerAgentId) {
          const orch = orchestrators.get(sid);
          const callerAgent = orch?.agentManager.getAgent(callerAgentId);
          // Unknown or non-master agents can never force
          if (!callerAgent || callerAgent.config.role !== "master") {
            res.status(403).json({ error: "Force transitions are restricted to humans. Enable 'Allow master force transitions' in session settings to permit master agents." });
            return;
          }
          // Master agents can only force if session flag is enabled
          const sessionForForce = sessionManager.getSession(sid);
          if (!sessionForForce?.config.allowMasterForceTransition) {
            res.status(403).json({ error: "Force transitions are restricted to humans. Enable 'Allow master force transitions' in session settings to permit master agents." });
            return;
          }
        }
        // No X-Agent-Id header = dashboard/user request → always allowed
      }
      if (forceMode && body.status) {
        // Add auto-comment documenting the force transition
        const commentText = `Force-transitioned to "${body.status}" (pipeline bypass)`;
        try {
          const { randomUUID } = require("crypto");
          db.addTaskComment({ id: randomUUID().slice(0, 8), taskId: tid, text: commentText, author: "system", authorName: "system", createdAt: new Date().toISOString() });
        } catch {}
      }

      // Always allow transition to closed-category states (e.g. "done") — no validation needed
      const targetState = workflowStates?.find((s: any) => s.id === body.status);
      const isClosedTarget = targetState?.category === "closed";

      // Enforce pipeline transitions if workflow states have transitions defined
      // Skip if: force mode, or target is a closed state (always allowed)
      if (body.status !== undefined && workflowStates && !forceMode && !isClosedTarget) {
        const orch = orchestrators.get(sid);
        const currentTask = orch?.database.getTask(String(tid));
        if (currentTask && currentTask.status !== body.status) {
          const currentState = workflowStates.find((s: any) => s.id === currentTask.status);
          if (currentState?.transitions?.length) {
            // Use shared helper: skippable expansion is non-recursive to prevent pipeline bypass
            const effective = getEffectiveTransitions(currentTask.status, workflowStates);
            if (effective && !effective.has(body.status)) {
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

      // Approval gate: if target state requires approval and not force mode, pause the task
      if (body.status && targetState?.requiresApproval && !forceMode && !(body as any).approved) {
        // Don't update status — instead mark as pending approval
        const { randomUUID } = require("crypto");
        const now = new Date().toISOString();
        try {
          db.addTaskComment({ id: randomUUID().slice(0, 8), taskId: tid, text: `Approval required to move to "${targetState.label}". Waiting for human sign-off.`, author: "system", authorName: "system", createdAt: now });
        } catch {}
        // Store pending target status in a comment for verification on /approve
        try {
          db.addTaskComment({ id: randomUUID().slice(0, 8), taskId: tid, text: `__pending_approval__:${body.status}`, author: "system", authorName: "system", createdAt: now });
        } catch {}
        // Broadcast approval-needed event
        broadcastEvent({ event: "approval-needed", sessionId: sid, taskId: tid, taskTitle: oldTask.title, targetStatus: body.status, targetLabel: targetState.label, requestedBy: oldTask.assigned_to });
        res.json({ pendingApproval: true, taskId: tid, targetStatus: body.status, message: `Task paused — approval required for "${targetState.label}". Waiting for human sign-off via dashboard.` });
        return;
      }

      let task = db.updateTask(tid, {
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
        // Auto-transition: if task is in first workflow state, move to second on assignment
        const session_update = sessionManager.getSession(sid);
        const ws_update = session_update?.config.workflowStates || DEFAULT_WORKFLOW_STATES;
        const firstState_u = ws_update[0]?.id;
        const secondState_u = ws_update.length > 1 ? ws_update[1]?.id : undefined;
        if (task.status === firstState_u && secondState_u) {
          db.updateTask(String(tid), { status: secondState_u });
        }

        const orch = orchestrators.get(sid);
        if (orch) {
          try {
            const agent = orch.agentManager.getAgent(task.assignedTo);
            const notifyMsg = `[Task assigned — START NOW] "${task.title}" (${task.priority || "P2"}). You have been assigned this task. Begin implementation immediately. Use get_task("${tid}") for details.`;
            if (agent) {
              orch.messageQueue.enqueue(task.assignedTo, agent.config.terminalSession,
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

      // Clear stale task nudges when status changes (auto-dismiss alerts)
      if (body.status && body.status !== oldTask.status) {
        const orch_clear = orchestrators.get(sid);
        if (orch_clear) {
          try { orch_clear.staleTaskWatchdog.clearNudgesForTask(tid); } catch { /* non-fatal */ }
        }
      }

      // State transition notification — send runbook + context to assigned agent
      if (body.status && body.status !== oldTask.status && task.assignedTo) {
        const orch_notify = orchestrators.get(sid);
        if (orch_notify) {
          try {
            const session_notify = sessionManager.getSession(sid);
            const ws_notify = session_notify?.config.workflowStates || DEFAULT_WORKFLOW_STATES;
            const newState = ws_notify.find((s: WorkflowState) => s.id === body.status);
            const oldState_ws = ws_notify.find((s: WorkflowState) => s.id === oldTask.status);
            const agent_notify = orch_notify.agentManager.getAgent(task.assignedTo);

            const resolverCtx = {
              task: { id: String(tid), title: task.title, priority: task.priority || "P2", status: task.status, assignedTo: task.assignedTo },
              newState: newState ? { id: newState.id, label: newState.label } : { id: body.status, label: body.status },
              oldState: oldState_ws ? { id: oldState_ws.id, label: oldState_ws.label } : { id: oldTask.status, label: oldTask.status },
              agent: agent_notify ? { id: agent_notify.id, name: agent_notify.config.name } : { id: task.assignedTo, name: task.assignedTo },
              baseBranch: "main",
              sessionId: sid,
            };

            let notifyMsg: string;
            // Determine notification type
            const isClosed = newState?.category === "closed";
            const oldIdx = ws_notify.indexOf(oldState_ws as WorkflowState);
            const newIdx = ws_notify.indexOf(newState as WorkflowState);
            const isBackward = oldIdx >= 0 && newIdx >= 0 && oldIdx > newIdx && !isClosed;

            if (isClosed) {
              notifyMsg = buildCancellationNotification(resolverCtx);
            } else if (isBackward) {
              notifyMsg = buildBackwardNotification(resolverCtx, undefined, newState?.instructions);
            } else {
              notifyMsg = buildTransitionNotification(resolverCtx, newState?.instructions);
            }

            // Auto-surface relevant knowledge entries
            try {
              const searchQuery = `${task.title} ${task.description || ""}`.trim();
              if (searchQuery) {
                const { embed, deserializeEmbedding, cosineSimilarity } = await import("../../core/embeddings.js");
                const queryVec = await embed(searchQuery);
                let knowledgeEntries: Array<{ key: string; value: string; similarity?: number }> = [];

                if (queryVec) {
                  // Semantic search
                  const withEmbeddings = db.getKnowledgeWithEmbeddings(sid);
                  knowledgeEntries = withEmbeddings
                    .map(e => ({ key: e.key, value: e.value, similarity: cosineSimilarity(queryVec, deserializeEmbedding(e.embedding)) }))
                    .filter(e => e.similarity! > 0.35)
                    .sort((a, b) => b.similarity! - a.similarity!)
                    .slice(0, 5);
                } else {
                  // Fallback to FTS
                  knowledgeEntries = db.searchKnowledge(sid, searchQuery, 5);
                }

                if (knowledgeEntries.length > 0) {
                  const knowledgeSection = knowledgeEntries
                    .map(e => `- **${e.key}**: ${e.value.slice(0, 200)}${e.value.length > 200 ? "..." : ""}`)
                    .join("\n");
                  notifyMsg += `\n\n**Related knowledge:**\n${knowledgeSection}`;
                }
              }
            } catch { /* non-fatal — notification still goes out without knowledge */ }

            // Deliver notification via message queue
            if (agent_notify) {
              orch_notify.messageQueue.enqueue(task.assignedTo, agent_notify.config.terminalSession,
                `\x1b[1;36m${notifyMsg}\x1b[0m`);
            }
            // Persist to SQLite for check_messages
            orch_notify.database.insertMessage({
              id: randomUUID(),
              sessionId: sid,
              fromAgentId: "system",
              toAgentId: task.assignedTo,
              messageType: "text",
              content: notifyMsg,
              priority: "normal",
              createdAt: Date.now(),
              expiresAt: Date.now() + 7 * 24 * 60 * 60 * 1000,
            });

            // routeTo: auto-reassign to matching role agent if specified
            if (newState?.routeTo && !isClosed) {
              const agents = orch_notify.agentManager.listAgents();
              const candidate = agents.find(a =>
                a.config.role === newState.routeTo &&
                a.activity === "idle" &&
                a.status === "running" &&
                a.id !== task.assignedTo
              );
              if (candidate) {
                db.updateTask(String(tid), { assignedTo: candidate.id });
                const reassignMsg = buildReassignmentNotification({
                  ...resolverCtx,
                  agent: { id: candidate.id, name: candidate.config.name },
                }, agent_notify?.config.name || task.assignedTo);
                orch_notify.messageQueue.enqueue(candidate.id, candidate.config.terminalSession,
                  `\x1b[1;36m${reassignMsg}\x1b[0m`);
                orch_notify.database.insertMessage({
                  id: randomUUID(),
                  sessionId: sid,
                  fromAgentId: "system",
                  toAgentId: candidate.id,
                  messageType: "task-assignment",
                  content: reassignMsg,
                  priority: "normal",
                  createdAt: Date.now(),
                  expiresAt: Date.now() + 7 * 24 * 60 * 60 * 1000,
                });
              }
            }
            // Re-read task after routeTo reassignment so response reflects current state
            const refreshed = db.getTask(String(tid));
            if (refreshed) task = refreshed;
          } catch (err) {
            logger.warn({ err }, "Failed to send state transition notification");
          }
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
      // Master-only: agents must be master role to delete tasks
      // Dashboard users (no X-Agent-Role header) are allowed
      const agentRole = req.headers["x-agent-role"] as string | undefined;
      if (agentRole && agentRole !== "master") {
        res.status(403).json({ error: "Task deletion requires master role" });
        return;
      }

      const sid = String(req.params.sid);
      const tid = String(req.params.tid);
      const db = getDb(sid);
      if (!db) { res.status(404).json({ error: "Session not found" }); return; }

      // Get task before deleting to notify assigned agent
      const taskBeforeDelete = db.getTask(tid);

      const deleted = db.deleteTask(tid);
      if (!deleted) { res.status(404).json({ error: "Task not found" }); return; }

      // Notify assigned agent that their task was deleted
      if (taskBeforeDelete?.assignedTo) {
        const orch_notify = orchestrators.get(sid);
        if (orch_notify) {
          try {
            const agent = orch_notify.agentManager.getAgent(taskBeforeDelete.assignedTo);
            const notifyMsg = `[Task deleted] "${taskBeforeDelete.title}" (${tid}) has been removed. Stop working on it if in progress.`;
            if (agent && agent.status === "running") {
              orch_notify.messageQueue.enqueue(taskBeforeDelete.assignedTo, agent.config.terminalSession,
                `\x1b[1;31m${notifyMsg}\x1b[0m`);
            }
            // Persist to SQLite for check_messages
            orch_notify.database.insertMessage({
              id: randomUUID(),
              sessionId: sid,
              fromAgentId: "system",
              toAgentId: taskBeforeDelete.assignedTo,
              messageType: "task-deleted",
              content: notifyMsg,
              priority: "high",
              createdAt: Date.now(),
              expiresAt: Date.now() + 24 * 60 * 60 * 1000,
            });
          } catch { /* non-fatal */ }
        }
      }

      // Broadcast task-deleted event via WebSocket
      broadcastEvent({ event: "task-deleted", sessionId: sid, taskId: tid });
      taskMetricsDebouncer.schedule(sid, () => broadcastEvent({ event: "task-metrics-updated", sessionId: sid }));

      // Log to SQLite for timeline
      const orch_td = orchestrators.get(sid);
      if (orch_td) {
        orch_td.eventLog.log({ sessionId: sid, type: "task-deleted" as any, data: { taskId: tid, title: taskBeforeDelete?.title } });
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

  // Import tasks from another session
  router.post("/sessions/:sid/import-tasks", (req: Request, res: Response) => {
    try {
      const sid = String(req.params.sid);
      const targetDb = getDb(sid);
      if (!targetDb) { res.status(404).json({ error: "Target session not found" }); return; }

      const { sourceSessionId, mode } = req.body as { sourceSessionId?: string; mode?: "active" | "all" };
      if (!sourceSessionId) { res.status(400).json({ error: "sourceSessionId is required" }); return; }
      if (mode && mode !== "active" && mode !== "all") { res.status(400).json({ error: "mode must be 'active' or 'all'" }); return; }

      const sourceDb = getDb(sourceSessionId);
      if (!sourceDb) { res.status(404).json({ error: "Source session not found" }); return; }

      const imported = targetDb.importTasks(sid, sourceDb, sourceSessionId, mode || "active");
      broadcastEvent({ event: "task-created", sessionId: sid });
      res.json({ imported, mode: mode || "active", sourceSessionId });
    } catch (err) {
      res.status(500).json({ error: String(err) });
    }
  });

  // Approve a pending approval gate transition
  router.post("/sessions/:sid/tasks/:tid/approve", (req: Request, res: Response) => {
    try {
      const sid = String(req.params.sid);
      const tid = String(req.params.tid);
      const db = getDb(sid);
      if (!db) { res.status(404).json({ error: "Session not found" }); return; }

      const { status } = req.body as { status: string };
      if (!status) { res.status(400).json({ error: "status is required" }); return; }

      // Validate the target status exists in workflow states
      const session_approve = sessionManager.getSession(sid);
      const workflowStates_approve = session_approve?.config.workflowStates || DEFAULT_WORKFLOW_STATES;
      const validStatuses_approve = workflowStates_approve.map((s: any) => s.id);
      if (!validStatuses_approve.includes(status)) {
        res.status(400).json({ error: `status must be one of: ${validStatuses_approve.join(", ")}` });
        return;
      }

      // Verify there's a pending approval for this status
      const currentTask = db.getTask(tid);
      if (currentTask) {
        const pendingComment = currentTask.comments?.find((c: any) => c.text?.startsWith("__pending_approval__:"));
        if (pendingComment) {
          const pendingStatus = pendingComment.text.split(":")[1];
          if (pendingStatus && pendingStatus !== status) {
            res.status(400).json({ error: `Approval mismatch: task is pending approval for "${pendingStatus}", not "${status}"` });
            return;
          }
        }
      }

      // Validate transition is valid (approve bypasses requiresApproval gate, NOT pipeline order)
      if (currentTask) {
        const currentState = workflowStates_approve.find((s: any) => s.id === currentTask.status);
        if (currentState?.transitions?.length) {
          const effective = getEffectiveTransitions(currentTask.status, workflowStates_approve);
          if (effective && !effective.has(status)) {
            res.status(400).json({ error: `Invalid transition: "${currentTask.status}" → "${status}". Valid: ${[...effective].join(", ")}` });
            return;
          }
        }
      }

      // Update with approved flag to bypass the requiresApproval gate
      const task = db.updateTask(tid, { status });
      const { randomUUID } = require("crypto");
      db.addTaskComment({ id: randomUUID().slice(0, 8), taskId: tid, text: `Approved: moved to "${status}" by human reviewer.`, author: "user", authorName: "user", createdAt: new Date().toISOString() });

      // Notify assigned agent
      const orch = orchestrators.get(sid);
      if (orch && task.assignedTo) {
        try {
          const agent = orch.agentManager.getAgent(task.assignedTo);
          if (agent) {
            orch.messageQueue.enqueue(task.assignedTo, agent.config.terminalSession,
              `\x1b[1;32m[Approved] Task "${task.title}" moved to "${status}". Continue working.\x1b[0m`);
          }
        } catch {}
      }

      broadcastEvent({ event: "task-updated", sessionId: sid, taskId: tid });
      broadcastEvent({ event: "approval-resolved", sessionId: sid, taskId: tid, status, action: "approved" });
      res.json({ approved: true, task });
    } catch (err) {
      res.status(500).json({ error: String(err) });
    }
  });

  // Reject a pending approval gate transition
  router.post("/sessions/:sid/tasks/:tid/reject", (req: Request, res: Response) => {
    try {
      const sid = String(req.params.sid);
      const tid = String(req.params.tid);
      const db = getDb(sid);
      if (!db) { res.status(404).json({ error: "Session not found" }); return; }

      const { reason } = req.body as { reason?: string };
      const { randomUUID } = require("crypto");
      db.addTaskComment({ id: randomUUID().slice(0, 8), taskId: tid, text: `Rejected: ${reason || "approval denied"}. Task stays in current state.`, author: "user", authorName: "user", createdAt: new Date().toISOString() });

      // Notify assigned agent
      const task = db.getTask(tid);
      const orch = orchestrators.get(sid);
      if (orch && task?.assignedTo) {
        try {
          const agent = orch.agentManager.getAgent(task.assignedTo);
          if (agent) {
            orch.messageQueue.enqueue(task.assignedTo, agent.config.terminalSession,
              `\x1b[1;31m[Rejected] Approval denied for task "${task.title}": ${reason || "no reason given"}. Address feedback and try again.\x1b[0m`);
          }
        } catch {}
      }

      broadcastEvent({ event: "approval-resolved", sessionId: sid, taskId: tid, action: "rejected", reason });
      res.json({ rejected: true, taskId: tid });
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

      // Auto-assign metrics from events table (Phase 0 evaluation)
      let autoAssignMetrics = {
        totalAutoAssigns: 0,
        successRate: 100,
        avgIdleGapMs: 0,
        masterOverrideCount: 0,
        skillMismatchCount: 0,
      };
      try {
        // Count auto-assign events
        const autoAssignEvents = db.db.prepare(
          `SELECT data FROM events WHERE session_id = ? AND type = 'auto-assign'`
        ).all(sid) as Array<{ data: string }>;
        autoAssignMetrics.totalAutoAssigns = autoAssignEvents.length;

        if (autoAssignEvents.length > 0) {
          const TEN_MIN_MS = 10 * 60 * 1000;
          const FIVE_MIN_MS = 5 * 60 * 1000;
          let reassignedCount = 0;
          let mismatchCount = 0;
          let totalIdleGap = 0;
          let idleGapCount = 0;

          for (const evt of autoAssignEvents) {
            const data = JSON.parse(evt.data || "{}");
            const taskId = data.taskId;
            if (!taskId) continue;

            // Check if task was reassigned within 10 min (master override)
            const transitions = db.getTransitions(taskId, 100);
            const autoAssignTime = transitions.find(
              (t: any) => t.changedBy === data.agentName || t.changedBy === data.agentId
            );

            // Check if assignee changed within 10 min
            const task = db.getTask(taskId);
            if (task && task.assignedTo !== data.agentName && task.assignedTo !== data.agentId) {
              const timeSinceAssign = task.updatedAt
                ? Date.now() - new Date(task.updatedAt).getTime()
                : Infinity;
              // If reassigned recently, count as override
              if (timeSinceAssign < TEN_MIN_MS) {
                reassignedCount++;
              }
              // If reassigned within 5 min, likely skill mismatch
              if (timeSinceAssign < FIVE_MIN_MS) {
                mismatchCount++;
              }
            }
          }

          // Compute avgIdleGapMs: time between auto-assign events per agent
          // (approximation — time between successive auto-assign events for same agent)
          const eventsByAgent = new Map<string, number[]>();
          const autoEvents = db.db.prepare(
            `SELECT data, timestamp FROM events WHERE session_id = ? AND type = 'auto-assign' ORDER BY timestamp ASC`
          ).all(sid) as Array<{ data: string; timestamp: string }>;
          for (const ae of autoEvents) {
            const d = JSON.parse(ae.data || "{}");
            const agentId = d.agentId || "unknown";
            if (!eventsByAgent.has(agentId)) eventsByAgent.set(agentId, []);
            eventsByAgent.get(agentId)!.push(new Date(ae.timestamp).getTime());
          }
          for (const times of eventsByAgent.values()) {
            for (let i = 1; i < times.length; i++) {
              totalIdleGap += times[i] - times[i - 1];
              idleGapCount++;
            }
          }

          autoAssignMetrics.successRate = autoAssignEvents.length > 0
            ? Math.round(((autoAssignEvents.length - reassignedCount) / autoAssignEvents.length) * 100)
            : 100;
          autoAssignMetrics.avgIdleGapMs = idleGapCount > 0 ? Math.round(totalIdleGap / idleGapCount) : 0;
          autoAssignMetrics.masterOverrideCount = reassignedCount;
          autoAssignMetrics.skillMismatchCount = mismatchCount;
        }
      } catch { /* non-fatal */ }

      res.json({ ...metrics, autoAssignMetrics });
    } catch (err) {
      res.status(500).json({ error: String(err) });
    }
  });

  // ─── Trend + CFD APIs ────────────────────────────────────────────

  /** Rolling average cycle time for trend chart */
  router.get("/sessions/:sid/task-metrics/trend", (req: Request, res: Response) => {
    try {
      const sid = String(req.params.sid);
      const db = getDb(sid);
      if (!db) { res.status(404).json({ error: "Session not found" }); return; }

      const window = parseInt(req.query.window as string) || 5;

      // Get all done tasks ordered by completion time
      const allTasks = db.getTasks(sid, true) as any[];
      const doneTasks = allTasks
        .filter((t: any) => t.status === "done")
        .sort((a: any, b: any) => new Date(a.updatedAt).getTime() - new Date(b.updatedAt).getTime());

      const trend = doneTasks.map((t: any, i: number) => {
        const cycleTimeMs = new Date(t.updatedAt).getTime() - new Date(t.createdAt).getTime();
        // Rolling average over last `window` tasks
        const windowStart = Math.max(0, i - window + 1);
        const windowTasks = doneTasks.slice(windowStart, i + 1);
        const rollingAvgMs = windowTasks.reduce((sum: number, wt: any) => {
          return sum + (new Date(wt.updatedAt).getTime() - new Date(wt.createdAt).getTime());
        }, 0) / windowTasks.length;

        return {
          taskSequence: i + 1,
          taskId: t.id,
          taskTitle: t.title,
          cycleTimeMs: Math.max(0, cycleTimeMs),
          rollingAvgMs: Math.round(Math.max(0, rollingAvgMs)),
          completedAt: t.updatedAt,
        };
      });

      res.json({ trend, window, totalCompleted: doneTasks.length });
    } catch (err) {
      res.status(500).json({ error: String(err) });
    }
  });

  /** Cumulative flow diagram data — task counts per state over time */
  router.get("/sessions/:sid/task-metrics/cfd", (req: Request, res: Response) => {
    try {
      const sid = String(req.params.sid);
      const db = getDb(sid);
      if (!db) { res.status(404).json({ error: "Session not found" }); return; }

      const session = sessionManager.getSession(sid);
      const states = (session?.config.workflowStates || DEFAULT_WORKFLOW_STATES).map((s: any) => s.id);

      // Get all transitions for all tasks in this session
      const allTransitions = db.db.prepare(
        `SELECT task_id, to_status, changed_at FROM task_state_transitions WHERE session_id = ? ORDER BY changed_at ASC`
      ).all(sid) as Array<{ task_id: string; to_status: string; changed_at: string }>;

      // Also get task creation times (for initial state)
      const allTasks = db.getTasks(sid, true) as any[];

      if (allTasks.length === 0) {
        res.json({ cfd: [], states });
        return;
      }

      // Determine time range and bucket size
      const createdTimes = allTasks.map((t: any) => new Date(t.createdAt).getTime());
      const minTime = Math.min(...createdTimes);
      const maxTime = Date.now();
      const durationMs = maxTime - minTime;

      // Auto-scale buckets: 5min for <2h, 15min for <8h, 30min for <24h, 1h otherwise
      let bucketMs: number;
      if (durationMs < 2 * 60 * 60 * 1000) bucketMs = 5 * 60 * 1000;
      else if (durationMs < 8 * 60 * 60 * 1000) bucketMs = 15 * 60 * 1000;
      else if (durationMs < 24 * 60 * 60 * 1000) bucketMs = 30 * 60 * 1000;
      else bucketMs = 60 * 60 * 1000;

      // Build state for each task over time
      const taskStates = new Map<string, string>();
      const events: Array<{ time: number; taskId: string; state: string }> = [];

      // Task creation = enters first state
      for (const t of allTasks) {
        const time = new Date(t.createdAt).getTime();
        const firstState = states[0] || "pending";
        events.push({ time, taskId: t.id, state: firstState });
      }

      // Transitions
      for (const tr of allTransitions) {
        events.push({ time: new Date(tr.changed_at).getTime(), taskId: tr.task_id, state: tr.to_status });
      }

      events.sort((a, b) => a.time - b.time);

      // Generate time buckets
      const cfd: Array<{ timestamp: string; counts: Record<string, number> }> = [];

      for (let t = minTime; t <= maxTime; t += bucketMs) {
        // Replay events up to this point
        for (const e of events) {
          if (e.time <= t) taskStates.set(e.taskId, e.state);
        }

        const counts: Record<string, number> = {};
        for (const s of states) counts[s] = 0;
        for (const state of taskStates.values()) {
          if (counts[state] !== undefined) counts[state]++;
          else counts[state] = (counts[state] || 0) + 1;
        }

        cfd.push({ timestamp: new Date(t).toISOString(), counts });
      }

      res.json({ cfd, states, bucketMs });
    } catch (err) {
      res.status(500).json({ error: String(err) });
    }
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

      const { appendKnowledgeEntry } = require("../../core/context-discovery.js");
      appendKnowledgeEntry(session.runtimeDir, agentName || "unknown", entry.trim());

      res.status(201).json({ success: true });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      res.status(500).json({ error: message });
    }
  });

  // ─── Knowledge Base (SQLite-backed key-value) ────────────────────────

  router.post("/sessions/:sid/knowledge-db", (req: Request, res: Response) => {
    try {
      const sid = String(req.params.sid);
      const db = getDb(sid);
      if (!db) { res.status(404).json({ error: "Session not found" }); return; }
      const { key, value, savedBy } = req.body;
      if (!key || !value) { res.status(400).json({ error: "key and value are required" }); return; }
      const { randomUUID } = require("crypto");
      db.saveKnowledge({ id: randomUUID().slice(0, 8), sessionId: sid, key, value, savedBy });
      broadcastEvent({ event: "knowledge-saved", sessionId: sid, key });
      res.status(201).json({ success: true, key });
      // Generate embedding in background (fire-and-forget)
      import("../../core/embeddings.js").then(({ embed, serializeEmbedding }) =>
        embed(`${key}: ${value}`).then(vec => {
          if (vec) db.saveEmbedding(sid, key, serializeEmbedding(vec));
        })
      ).catch(() => { /* non-fatal — semantic search just won't work for this entry */ });
    } catch (err) { res.status(500).json({ error: String(err) }); }
  });

  router.get("/sessions/:sid/knowledge-db/:key", (req: Request, res: Response) => {
    try {
      const sid = String(req.params.sid);
      const key = String(req.params.key);
      const db = getDb(sid);
      if (!db) { res.status(404).json({ error: "Session not found" }); return; }
      const entry = db.getKnowledge(sid, key);
      if (!entry) { res.status(404).json({ error: `Knowledge key "${key}" not found` }); return; }
      res.json(entry);
    } catch (err) { res.status(500).json({ error: String(err) }); }
  });

  router.put("/sessions/:sid/knowledge-db/:key", (req: Request, res: Response) => {
    try {
      const sid = String(req.params.sid);
      const key = decodeURIComponent(String(req.params.key));
      const db = getDb(sid);
      if (!db) { res.status(404).json({ error: "Session not found" }); return; }
      const existing = db.getKnowledge(sid, key);
      if (!existing) { res.status(404).json({ error: `Knowledge key "${key}" not found` }); return; }
      const { value, savedBy } = req.body;
      if (!value) { res.status(400).json({ error: "value is required" }); return; }
      db.saveKnowledge({ id: key, sessionId: sid, key, value, savedBy });
      broadcastEvent({ event: "knowledge-updated", sessionId: sid, key });
      res.json({ success: true, key });
      // Re-generate embedding on update
      import("../../core/embeddings.js").then(({ embed, serializeEmbedding }) =>
        embed(`${key}: ${value}`).then(vec => {
          if (vec) db.saveEmbedding(sid, key, serializeEmbedding(vec));
        })
      ).catch(() => {});
    } catch (err) { res.status(500).json({ error: String(err) }); }
  });

  router.delete("/sessions/:sid/knowledge-db/:key", (req: Request, res: Response) => {
    try {
      const sid = String(req.params.sid);
      const key = decodeURIComponent(String(req.params.key));
      const db = getDb(sid);
      if (!db) { res.status(404).json({ error: "Session not found" }); return; }
      const deleted = db.deleteKnowledge(sid, key);
      if (!deleted) { res.status(404).json({ error: `Knowledge key "${key}" not found` }); return; }
      broadcastEvent({ event: "knowledge-deleted", sessionId: sid, key });
      res.json({ success: true, key });
    } catch (err) { res.status(500).json({ error: String(err) }); }
  });

  router.get("/sessions/:sid/knowledge-db", async (req: Request, res: Response) => {
    try {
      const sid = String(req.params.sid);
      const db = getDb(sid);
      if (!db) { res.status(404).json({ error: "Session not found" }); return; }
      const query = req.query.q as string | undefined;
      const limit = parseInt(req.query.limit as string) || 20;
      const semantic = req.query.semantic === "true";

      if (!query) {
        const entries = db.listKnowledge(sid, limit);
        res.json({ entries, count: entries.length });
        return;
      }

      // FTS/LIKE search (always)
      const ftsResults = db.searchKnowledge(sid, query, limit);

      // Semantic search (if requested and embeddings available)
      if (semantic) {
        try {
          const { embed, deserializeEmbedding, cosineSimilarity } = await import("../../core/embeddings.js");
          const queryVec = await embed(query);
          if (queryVec) {
            const withEmbeddings = db.getKnowledgeWithEmbeddings(sid);
            const scored = withEmbeddings.map(entry => ({
              ...entry,
              similarity: cosineSimilarity(queryVec, deserializeEmbedding(entry.embedding)),
            })).filter(e => e.similarity > 0.3) // threshold
              .sort((a, b) => b.similarity - a.similarity)
              .slice(0, limit);

            // Hybrid merge: combine FTS + semantic, dedup by key, score by rank
            const seen = new Set<string>();
            const merged: Array<{ key: string; value: string; savedBy: string | null; updatedAt: string; similarity?: number }> = [];
            // Interleave: semantic first (relevance), then FTS
            for (const e of scored) {
              if (!seen.has(e.key)) { seen.add(e.key); merged.push({ key: e.key, value: e.value, savedBy: e.savedBy, updatedAt: e.updatedAt, similarity: e.similarity }); }
            }
            for (const e of ftsResults) {
              if (!seen.has(e.key)) { seen.add(e.key); merged.push(e); }
            }
            res.json({ entries: merged.slice(0, limit), count: merged.length, searchMode: "hybrid" });
            return;
          }
        } catch { /* semantic search failed — fall through to FTS-only */ }
      }

      res.json({ entries: ftsResults, count: ftsResults.length, searchMode: "fts" });
    } catch (err) { res.status(500).json({ error: String(err) }); }
  });

  // ── Knowledge Edges ────────────────────────────────────

  router.post("/sessions/:sid/knowledge-db/edges", (req: Request, res: Response) => {
    try {
      const sid = String(req.params.sid);
      const db = getDb(sid);
      if (!db) { res.status(404).json({ error: "Session not found" }); return; }
      const { fromKey, toKey, edgeType } = req.body;
      if (!fromKey || !toKey || !edgeType) { res.status(400).json({ error: "fromKey, toKey, and edgeType required" }); return; }
      const validTypes = ["references", "supersedes", "contradicts", "extends", "related"];
      if (!validTypes.includes(edgeType)) { res.status(400).json({ error: `Invalid edgeType. Valid: ${validTypes.join(", ")}` }); return; }
      db.addKnowledgeEdge({ id: randomUUID().slice(0, 8), sessionId: sid, fromKey, toKey, edgeType });
      res.json({ success: true, fromKey, toKey, edgeType });
    } catch (err) { res.status(500).json({ error: String(err) }); }
  });

  router.delete("/sessions/:sid/knowledge-db/edges/:fromKey/:toKey", (req: Request, res: Response) => {
    try {
      const sid = String(req.params.sid);
      const db = getDb(sid);
      if (!db) { res.status(404).json({ error: "Session not found" }); return; }
      const fromKey = decodeURIComponent(String(req.params.fromKey));
      const toKey = decodeURIComponent(String(req.params.toKey));
      const removed = db.removeKnowledgeEdge(sid, fromKey, toKey);
      if (!removed) { res.status(404).json({ error: "Edge not found" }); return; }
      res.json({ success: true, removed: true });
    } catch (err) { res.status(500).json({ error: String(err) }); }
  });

  router.get("/sessions/:sid/knowledge-db/:key/edges", (req: Request, res: Response) => {
    try {
      const sid = String(req.params.sid);
      const db = getDb(sid);
      if (!db) { res.status(404).json({ error: "Session not found" }); return; }
      const key = decodeURIComponent(String(req.params.key));
      const edges = db.getKnowledgeEdges(sid, key);
      res.json({ edges, count: edges.length });
    } catch (err) { res.status(500).json({ error: String(err) }); }
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
        const { loadProjectConfig } = await import("../../core/project-config.js");
        const config = await loadProjectConfig(session.config.projectPath);
        if (config?.knowledge) {
          for (const k of config.knowledge) {
            entries.push({ text: k, source: ".kora.yml" });
          }
        }
      } catch { /* ignore */ }

      // 2. Read from knowledge.md directly at {runtimeDir}/knowledge.md
      // (readKnowledgeEntries constructs its own path which mismatches the write path)
      try {
        const fsKb = await import("fs/promises");
        const pathKb = await import("path");
        const knowledgePath = pathKb.join(session.runtimeDir, "knowledge.md");
        const content = await fsKb.readFile(knowledgePath, "utf-8");
        // Group lines by entry markers: "- [timestamp] [agent] ..." starts a new entry
        const rawLines = content.split("\n");
        const entryMarker = /^-?\s*\[[\d\-T:.Z]+\]\s*\[/;
        const grouped: string[] = [];
        let currentEntry = "";
        for (const line of rawLines) {
          if (entryMarker.test(line)) {
            if (currentEntry.trim()) grouped.push(currentEntry.trim());
            currentEntry = line;
          } else if (line.trim() && !line.startsWith("#")) {
            currentEntry += "\n" + line;
          }
        }
        if (currentEntry.trim()) grouped.push(currentEntry.trim());

        for (const entry of grouped) {
          // Parse header line: "- [ISO_TIMESTAMP] [agent-name] first line of entry"
          const firstLine = entry.split("\n")[0];
          const match = firstLine.match(/^-?\s*\[([^\]]+)\]\s*\[([^\]]+)\]\s*(.*)$/);
          if (match) {
            // Combine first line content with continuation lines
            const rest = entry.split("\n").slice(1).join("\n").trim();
            const text = rest ? `${match[3].trim()}\n${rest}` : match[3].trim();
            entries.push({ text, source: match[2], timestamp: match[1] });
          } else {
            const text = entry.startsWith("- ") ? entry.slice(2).trim() : entry.trim();
            if (text) entries.push({ text, source: "knowledge.md" });
          }
        }
      } catch { /* file may not exist */ }

      // 3. Read from SQLite knowledge-db (entries saved via kora-cli save --key or MCP save_knowledge with key)
      try {
        const db = getDb(sid);
        if (db) {
          const dbEntries = db.listKnowledge(sid, 100);
          const existingTexts = new Set(entries.map(e => e.text));
          for (const e of dbEntries) {
            const text = (e as Record<string, unknown>).value as string || (e as Record<string, unknown>).entry as string || "";
            if (text && !existingTexts.has(text)) {
              entries.push({
                text: (e as Record<string, unknown>).key ? `[${(e as Record<string, unknown>).key}] ${text}` : text,
                source: "knowledge-db",
                timestamp: (e as Record<string, unknown>).createdAt ? new Date((e as Record<string, unknown>).createdAt as number).toISOString() : undefined,
              });
            }
          }
        }
      } catch { /* knowledge-db may not exist */ }

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

  // ─── Agent Reminders ──────────────────────────────────────────

  router.get("/sessions/:sid/reminders", (req: Request, res: Response) => {
    try {
      const sid = String(req.params.sid);
      const db = getDb(sid);
      if (!db) { res.status(404).json({ error: "Session not found" }); return; }
      res.json({ reminders: db.getReminders(sid) });
    } catch (err) { res.status(500).json({ error: String(err) }); }
  });

  router.post("/sessions/:sid/reminders", (req: Request, res: Response) => {
    try {
      const sid = String(req.params.sid);
      const db = getDb(sid);
      if (!db) { res.status(404).json({ error: "Session not found" }); return; }

      const { targetAgentId, targetAgentName, message, condition, intervalMinutes } = req.body;
      if (!message || !condition) {
        res.status(400).json({ error: "message and condition are required" });
        return;
      }

      // Resolve agent name to ID if needed
      let resolvedAgentId = targetAgentId;
      if (!resolvedAgentId && targetAgentName) {
        const orch = orchestrators.get(sid);
        const agents = orch ? orch.agentManager.listAgents() : [];
        const match = agents.find(a =>
          a.config.name.toLowerCase() === targetAgentName.toLowerCase()
        );
        resolvedAgentId = match?.id || targetAgentName;
      }

      if (!resolvedAgentId) {
        res.status(400).json({ error: "targetAgentId or targetAgentName required" });
        return;
      }

      const { randomUUID } = require("crypto");
      const id = randomUUID().slice(0, 8);
      db.insertReminder({
        id,
        sessionId: sid,
        targetAgentId: resolvedAgentId,
        message,
        condition,
        intervalMinutes: intervalMinutes || 5,
      });

      res.status(201).json({ id, created: true });
    } catch (err) { res.status(500).json({ error: String(err) }); }
  });

  router.put("/sessions/:sid/reminders/:rid", (req: Request, res: Response) => {
    try {
      const { sid, rid } = req.params;
      const db = getDb(String(sid));
      if (!db) { res.status(404).json({ error: "Session not found" }); return; }

      const updated = db.updateReminder(String(rid), req.body);
      if (!updated) { res.status(404).json({ error: "Reminder not found" }); return; }
      res.json({ updated: true });
    } catch (err) { res.status(500).json({ error: String(err) }); }
  });

  router.delete("/sessions/:sid/reminders/:rid", (req: Request, res: Response) => {
    try {
      const { sid, rid } = req.params;
      const db = getDb(String(sid));
      if (!db) { res.status(404).json({ error: "Session not found" }); return; }

      const deleted = db.deleteReminder(String(rid));
      if (!deleted) { res.status(404).json({ error: "Reminder not found" }); return; }
      res.json({ deleted: true });
    } catch (err) { res.status(500).json({ error: String(err) }); }
  });
}
