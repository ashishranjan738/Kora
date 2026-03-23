/**
 * Transport-agnostic tool handlers.
 * Each handler takes a ToolContext + args and returns a result.
 * No MCP-specific logic (no JSON-RPC, no stdio, no unread notifications).
 */

import type { ToolContext, AgentsResponse } from "./tool-context.js";
import { findAgentByNameOrId } from "./tool-context.js";

// ── Simple Proxies ──────────────────────────────────────────

export async function handleListAgents(
  ctx: ToolContext,
  _args: Record<string, string>,
): Promise<unknown> {
  const agents = (await ctx.apiCall(
    "GET",
    `/api/v1/sessions/${ctx.sessionId}/agents`,
  )) as AgentsResponse;

  // Fetch tasks to compute currentTask and availableForWork
  let allTasks: Array<{ id: string; title: string; status: string; assignedTo?: string }> = [];
  try {
    const tasksResp = (await ctx.apiCall("GET", `/api/v1/sessions/${ctx.sessionId}/tasks?status=active&summary=true`)) as any;
    allTasks = tasksResp.tasks || [];
  } catch { /* non-fatal */ }

  return {
    agents: (agents.agents || []).map((a) => {
      const agentState = a as any;
      const inProgressTask = allTasks.find(t =>
        (t.assignedTo === a.id || t.assignedTo === a.config?.name) && t.status === "in-progress",
      );
      const activeTasks = allTasks.filter(t =>
        t.assignedTo === a.id || t.assignedTo === a.config?.name,
      );
      const idleSinceMs = agentState.idleSince ? new Date(agentState.idleSince).getTime() : 0;
      const idleDurationMs = idleSinceMs > 0 ? Date.now() - idleSinceMs : 0;

      return {
        name: a.config?.name,
        id: a.id,
        role: a.config?.role,
        status: a.status,
        activity: agentState.activity || a.status,
        provider: a.config?.cliProvider,
        model: a.config?.model,
        isMe: a.id === ctx.agentId,
        idleSince: agentState.idleSince || null,
        lastActivityAt: agentState.lastActivityAt || null,
        currentTask: inProgressTask ? inProgressTask.title : null,
        currentTaskId: inProgressTask ? inProgressTask.id : null,
        activeTasks: activeTasks.length,
        pendingMessages: agentState.unreadMessages || 0,
        skills: (a.config as any)?.skills || [],
        availableForWork: (
          agentState.activity === "idle" &&
          !inProgressTask &&
          a.config?.role !== "master" &&
          idleDurationMs > 0
        ),
      };
    }),
  };
}

export async function handleBroadcast(
  ctx: ToolContext,
  args: Record<string, string>,
): Promise<unknown> {
  // Rate limiting (if limiter provided by transport)
  if (ctx.sendRateLimiter?.isLimited()) {
    return {
      success: false,
      error: "Rate limited: you have sent too many messages. Focus on completing your task instead of messaging.",
    };
  }

  await ctx.apiCall("POST", `/api/v1/sessions/${ctx.sessionId}/broadcast`, {
    message: `[From ${ctx.agentId}]: ${args.message}`,
    from: ctx.agentId,
  });
  ctx.sendRateLimiter?.record();
  return { success: true, broadcast: true };
}

export async function handleGetTask(
  ctx: ToolContext,
  args: Record<string, string>,
): Promise<unknown> {
  if (!args.taskId) {
    return { error: "taskId is required" };
  }
  const taskResp = (await ctx.apiCall(
    "GET",
    `/api/v1/sessions/${ctx.sessionId}/tasks/${args.taskId}`,
  )) as any;

  if (taskResp.error) {
    return { error: taskResp.error };
  }
  return { task: taskResp };
}

export async function handleCreateTask(
  ctx: ToolContext,
  args: Record<string, string>,
): Promise<unknown> {
  const result = await ctx.apiCall("POST", `/api/v1/sessions/${ctx.sessionId}/tasks`, {
    title: args.title,
    description: args.description || "",
    assignedTo: args.assignedTo || undefined,
    priority: args.priority || undefined,
    labels: (args as any).labels || undefined,
    dueDate: args.dueDate || undefined,
  });
  return result;
}

export async function handleRemoveAgent(
  ctx: ToolContext,
  args: Record<string, string>,
): Promise<unknown> {
  return await ctx.apiCall(
    "DELETE",
    `/api/v1/sessions/${ctx.sessionId}/agents/${args.agentId}`,
  );
}

export async function handleReportIdle(
  ctx: ToolContext,
  args: Record<string, string>,
): Promise<unknown> {
  const reason = args.reason || "task completed";

  // Check for stale in-progress tasks before allowing idle
  let staleTasks: Array<{ id: string; title: string; status: string }> = [];
  try {
    const tasksResp = (await ctx.apiCall("GET",
      `/api/v1/sessions/${ctx.sessionId}/tasks?assignedTo=${ctx.agentId}&status=active&summary=true`,
    )) as any;
    staleTasks = (tasksResp.tasks || []).filter((t: any) =>
      t.status === "in-progress" || t.status === "review",
    );
  } catch { /* non-fatal */ }

  const result = await ctx.apiCall("POST", `/api/v1/sessions/${ctx.sessionId}/agents/${ctx.agentId}/report-idle`, {
    reason,
  }) as Record<string, unknown>;

  if (staleTasks.length > 0) {
    const taskList = staleTasks.map(t => `- "${t.title}" (${t.id}) — status: ${t.status}`).join("\n");
    return {
      success: true,
      activity: "idle",
      reason,
      ...result,
      warning: `You have ${staleTasks.length} task(s) still in-progress/review. Update their status before going idle:`,
      staleTasks: staleTasks.map(t => ({ id: t.id, title: t.title, status: t.status })),
    };
  }

  return { success: true, activity: "idle", reason, ...result };
}

export async function handleRequestTask(
  ctx: ToolContext,
  args: Record<string, string>,
): Promise<unknown> {
  const skills = (args as any).skills || [];
  const priority = args.priority;
  return await ctx.apiCall("POST", `/api/v1/sessions/${ctx.sessionId}/agents/${ctx.agentId}/request-task`, {
    skills,
    priority,
  });
}

export async function handleGetWorkflowStates(
  ctx: ToolContext,
  _args: Record<string, string>,
): Promise<unknown> {
  const session = (await ctx.apiCall("GET", `/api/v1/sessions/${ctx.sessionId}`)) as any;
  const workflowStates = session?.config?.workflowStates || session?.workflowStates;

  if (!workflowStates || !Array.isArray(workflowStates) || workflowStates.length === 0) {
    return {
      states: [
        { id: "pending", label: "Pending", transitions: ["in-progress"] },
        { id: "in-progress", label: "In Progress", transitions: ["review", "pending"] },
        { id: "review", label: "Review", transitions: ["done", "in-progress"] },
        { id: "done", label: "Done", transitions: [] },
      ],
      note: "Default workflow (session has no custom workflow configured)",
    };
  }

  return {
    states: workflowStates.map((s: any) => ({
      id: s.id,
      label: s.label,
      category: s.category,
      transitions: s.transitions || [],
      skippable: s.skippable || false,
      requiresApproval: s.requiresApproval || false,
      instructions: s.instructions || undefined,
    })),
    pipeline: workflowStates.map((s: any) => s.id).join(" → "),
  };
}

export async function handleListPersonas(
  ctx: ToolContext,
  args: Record<string, string>,
): Promise<unknown> {
  const includeFullText = args.includeFullText === "true";

  // Fetch custom personas from API
  let customPersonas: Array<{ id: string; name: string; description: string; fullText?: string }> = [];
  try {
    const resp = (await ctx.apiCall("GET", "/api/v1/personas")) as any;
    customPersonas = resp.personas || [];
  } catch { /* non-fatal */ }

  // Built-in personas
  const builtIn = [
    { id: "architect", name: "Architect", description: "Master coordinator and system architect", type: "builtin" },
    { id: "backend", name: "Backend Developer", description: "Node.js, APIs, databases, server-side logic", type: "builtin" },
    { id: "frontend", name: "Frontend Developer", description: "React, UI/UX, component development", type: "builtin" },
    { id: "tester", name: "QA Tester", description: "Testing, test plans, bug finding", type: "builtin" },
    { id: "reviewer", name: "Code Reviewer", description: "Code quality, architecture review", type: "builtin" },
    { id: "researcher", name: "Researcher", description: "Investigation, analysis, documentation", type: "builtin" },
  ];

  const allPersonas = [
    ...builtIn,
    ...customPersonas.map(p => ({
      id: p.id,
      name: p.name,
      description: p.description,
      type: "custom" as const,
      ...(includeFullText ? { fullText: p.fullText } : {}),
    })),
  ];

  return { personas: allPersonas, count: allPersonas.length };
}

export async function handleSavePersona(
  ctx: ToolContext,
  args: Record<string, string>,
): Promise<unknown> {
  if (!args.name?.trim() || !args.fullText?.trim()) {
    return { error: "name and fullText are required" };
  }
  return await ctx.apiCall("POST", "/api/v1/personas", {
    name: args.name,
    description: args.description || "",
    fullText: args.fullText,
  });
}

export async function handleSaveKnowledge(
  ctx: ToolContext,
  args: Record<string, string>,
): Promise<unknown> {
  if (!args.entry || !args.entry.trim()) {
    return { error: "entry is required (non-empty string)" };
  }

  // Get agent name for attribution
  const agents = (await ctx.apiCall(
    "GET",
    `/api/v1/sessions/${ctx.sessionId}/agents`,
  )) as AgentsResponse;
  const self = (agents.agents || []).find((a) => a.id === ctx.agentId);
  const agentName = self?.config?.name || ctx.agentId;

  // If key is provided, also save to SQLite knowledge DB
  if (args.key?.trim()) {
    try {
      await ctx.apiCall("POST", `/api/v1/sessions/${ctx.sessionId}/knowledge-db`, {
        key: args.key.trim(),
        value: args.entry.trim(),
        author: agentName,
      });
      return { success: true, key: args.key.trim(), storage: "sqlite" };
    } catch {
      // Fall through to file-based
    }
  }

  // File-based storage
  const result = await ctx.apiCall("POST", `/api/v1/sessions/${ctx.sessionId}/knowledge`, {
    entry: args.entry,
    author: agentName,
  });
  return result;
}

export async function handleGetKnowledge(
  ctx: ToolContext,
  args: Record<string, string>,
): Promise<unknown> {
  if (!args.key?.trim()) {
    return { error: "key is required" };
  }
  return await ctx.apiCall("GET", `/api/v1/sessions/${ctx.sessionId}/knowledge-db/${encodeURIComponent(args.key.trim())}`);
}

export async function handleSearchKnowledge(
  ctx: ToolContext,
  args: Record<string, string>,
): Promise<unknown> {
  if (!args.query?.trim()) {
    return { error: "query is required" };
  }
  const limit = args.limit || "20";
  return await ctx.apiCall("GET", `/api/v1/sessions/${ctx.sessionId}/knowledge-db?q=${encodeURIComponent(args.query.trim())}&limit=${limit}`);
}

// ── Medium Complexity ──────────────────────────────────────────

export async function handleSendMessage(
  ctx: ToolContext,
  args: Record<string, string>,
): Promise<unknown> {
  if (!args.to && !args.channel) {
    return { success: false, error: "Either 'to' or 'channel' must be provided" };
  }

  // Rate limiting (if limiter provided by transport)
  if (ctx.sendRateLimiter?.isLimited()) {
    return {
      success: false,
      error: "Rate limited: you have sent too many messages. Focus on completing your task instead of messaging.",
    };
  }

  const agents = (await ctx.apiCall(
    "GET",
    `/api/v1/sessions/${ctx.sessionId}/agents`,
  )) as AgentsResponse;

  // Channel-based routing
  if (args.channel) {
    const subscribers = (agents.agents || []).filter((a) => {
      const channels = (a.config as any)?.channels || [];
      return channels.includes(args.channel) && a.id !== ctx.agentId;
    });

    if (subscribers.length === 0) {
      return { success: false, error: `No agents subscribed to channel "${args.channel}"` };
    }

    for (const sub of subscribers) {
      await ctx.apiCall("POST", `/api/v1/sessions/${ctx.sessionId}/relay`, {
        from: ctx.agentId,
        to: sub.id,
        message: `[${args.channel}] ${args.message}`,
        messageType: args.messageType || "text",
      });
    }

    ctx.sendRateLimiter?.record();
    return { success: true, sentTo: subscribers.map(s => s.config?.name || s.id), channel: args.channel };
  }

  // Direct message routing
  const target = findAgentByNameOrId(agents.agents || [], args.to);
  if (!target) {
    const available = (agents.agents || [])
      .filter((a) => a.id !== ctx.agentId)
      .map((a) => `"${a.config?.name}" (${a.id})`);
    return {
      success: false,
      error: `Agent "${args.to}" not found. Available agents: ${available.join(", ")}`,
    };
  }

  // Detect task completion hints
  const messageType = args.messageType || "text";
  const completionPhrases = [
    "completed", "finished", "done", "ready for review",
    "pr created", "pr opened", "pull request",
  ];
  const isCompletion = messageType === "completion" ||
    completionPhrases.some(p => args.message.toLowerCase().includes(p));

  await ctx.apiCall("POST", `/api/v1/sessions/${ctx.sessionId}/relay`, {
    from: ctx.agentId,
    to: target.id,
    message: args.message,
    messageType: isCompletion ? "completion" : messageType,
  });
  ctx.sendRateLimiter?.record();

  // If this looks like a completion, check for stale in-progress tasks
  if (isCompletion) {
    try {
      const tasksResp = (await ctx.apiCall("GET",
        `/api/v1/sessions/${ctx.sessionId}/tasks?assignedTo=${ctx.agentId}&status=in-progress&summary=true`,
      )) as any;
      const staleTasks = (tasksResp.tasks || []);
      if (staleTasks.length > 0) {
        return {
          success: true,
          sentTo: target.config?.name || target.id,
          reminder: `You have ${staleTasks.length} task(s) still in-progress. Don't forget to update their status.`,
          staleTasks: staleTasks.map((t: any) => ({ id: t.id, title: t.title })),
        };
      }
    } catch { /* non-fatal */ }
  }

  return { success: true, sentTo: target.config?.name || target.id };
}

export async function handleListTasks(
  ctx: ToolContext,
  args: Record<string, string>,
): Promise<unknown> {
  const params = new URLSearchParams();

  // assignedTo: default "me" → resolve to agentId; "all" → no filter
  const assignedToArg = args.assignedTo || "me";
  if (assignedToArg === "me") {
    params.set("assignedTo", ctx.agentId);
  } else if (assignedToArg !== "all") {
    const agents = (await ctx.apiCall(
      "GET",
      `/api/v1/sessions/${ctx.sessionId}/agents`,
    )) as AgentsResponse;
    const target = findAgentByNameOrId(agents.agents || [], assignedToArg);
    if (target) {
      params.set("assignedTo", target.id);
    } else {
      params.set("assignedTo", assignedToArg);
    }
  }

  const statusArg = args.status || "active";
  if (statusArg !== "all") params.set("status", statusArg);
  if (args.label) params.set("label", args.label);
  if (args.due) params.set("due", args.due);
  if (args.sortBy) params.set("sortBy", args.sortBy);

  const summaryArg = args.summary === "false" ? "false" : "true";
  params.set("summary", summaryArg);

  const queryString = params.toString();
  const response = (await ctx.apiCall(
    "GET",
    `/api/v1/sessions/${ctx.sessionId}/tasks?${queryString}`,
  )) as { tasks?: Array<{ id: string; title: string; status: string; dependencies?: string[]; [key: string]: unknown }> };

  // Enhance tasks with dependency blocking info
  const tasks = response.tasks || [];
  const taskMap = new Map(tasks.map((t) => [t.id, t]));

  for (const task of tasks) {
    if (task.dependencies && task.dependencies.length > 0) {
      const incompleteDeps = task.dependencies
        .map((depId: string) => taskMap.get(depId))
        .filter((dep) => dep && dep.status !== "done");
      if (incompleteDeps.length > 0) {
        (task as any).blocked = true;
        (task as any).blockedReason = `Waiting for: ${incompleteDeps.map((d) => d!.title).join(", ")}`;
      }
    }
  }

  // Sort by priority (P0 first)
  const priorityOrder: Record<string, number> = { P0: 0, P1: 1, P2: 2, P3: 3 };
  tasks.sort((a, b) => {
    const pa = priorityOrder[(a as any).priority] ?? 2;
    const pb = priorityOrder[(b as any).priority] ?? 2;
    return pa - pb;
  });

  // Cap response size
  const maxTasksRaw = args.maxTasks != null ? Number(args.maxTasks) : (ctx.agentRole === "master" ? 25 : 10);
  const maxTasks = isNaN(maxTasksRaw) ? 10 : maxTasksRaw;
  const totalMatching = tasks.length;
  const truncated = maxTasks > 0 && tasks.length > maxTasks;
  const cappedTasks = maxTasks > 0 ? tasks.slice(0, maxTasks) : tasks;

  if (summaryArg === "true") {
    const result: any = {
      tasks: cappedTasks.map((t) => ({
        id: t.id,
        title: t.title,
        status: t.status,
        priority: (t as any).priority || "P2",
        ...(t.assignedTo ? { assignedTo: t.assignedTo } : {}),
        ...((t as any).blocked ? { blocked: true, blockedReason: (t as any).blockedReason } : {}),
      })),
    };
    if (truncated) {
      result.totalMatching = totalMatching;
      result.truncated = true;
      result.hint = `Showing ${cappedTasks.length} of ${totalMatching} tasks (sorted by priority). Use get_task(id) for details.`;
    }
    return result;
  }

  const fullResult: any = { tasks: cappedTasks };
  if (truncated) {
    fullResult.totalMatching = totalMatching;
    fullResult.truncated = true;
    fullResult.hint = `Showing ${cappedTasks.length} of ${totalMatching} tasks. Use get_task(id) for details.`;
  }
  return fullResult;
}

export async function handleUpdateTask(
  ctx: ToolContext,
  args: Record<string, string>,
): Promise<unknown> {
  const { taskId, status, comment, title, description, priority, assignedTo, dueDate, force } = args;
  const labels = (args as any).labels;
  const results: { statusUpdate?: unknown; commentAdded?: unknown } = {};

  // Dependency gating for in-progress
  if (status === "in-progress") {
    const allTasks = (await ctx.apiCall(
      "GET",
      `/api/v1/sessions/${ctx.sessionId}/tasks`,
    )) as { tasks?: Array<{ id: string; title: string; status: string; dependencies?: string[] }> };

    const tasks = allTasks.tasks || [];
    const taskMap = new Map(tasks.map((t) => [t.id, t]));
    const thisTask = taskMap.get(taskId);

    if (thisTask?.dependencies && thisTask.dependencies.length > 0) {
      const incompleteDeps = thisTask.dependencies
        .map((depId: string) => taskMap.get(depId))
        .filter((dep) => dep && dep.status !== "done");
      if (incompleteDeps.length > 0) {
        return {
          success: false,
          error: `Cannot start — blocked by incomplete dependencies: ${incompleteDeps.map((d) => d!.title).join(", ")}`,
        };
      }
    }
  }

  // Workflow transition enforcement
  if (status && !force) {
    try {
      const sessionRes = (await ctx.apiCall("GET", `/api/v1/sessions/${ctx.sessionId}`)) as any;
      const workflowStates = sessionRes?.config?.workflowStates || sessionRes?.workflowStates;
      if (workflowStates && Array.isArray(workflowStates)) {
        const currentTask = (await ctx.apiCall("GET", `/api/v1/sessions/${ctx.sessionId}/tasks/${taskId}`)) as any;
        const currentStatus = currentTask?.status;
        if (currentStatus && currentStatus !== status) {
          const currentState = workflowStates.find((s: any) => s.id === currentStatus);
          if (currentState?.transitions?.length) {
            const effectiveTransitions = new Set<string>(currentState.transitions);
            for (const t of currentState.transitions) {
              const ts = workflowStates.find((s: any) => s.id === t);
              if (ts?.skippable && ts.transitions?.length) {
                for (const skipTarget of ts.transitions) {
                  const skipTargetState = workflowStates.find((s: any) => s.id === skipTarget);
                  if (skipTargetState && skipTargetState.category !== "closed") {
                    effectiveTransitions.add(skipTarget);
                  }
                }
              }
            }
            for (const s of workflowStates) {
              if ((s as any).category === "closed") effectiveTransitions.add(s.id);
            }

            if (!effectiveTransitions.has(status)) {
              const validStates = [...effectiveTransitions].map((t: string) => {
                const s = workflowStates.find((ws: any) => ws.id === t);
                return s ? `"${s.label}" (${t})` : `"${t}"`;
              }).join(", ");
              return {
                success: false,
                error: `Invalid transition: "${currentStatus}" cannot move directly to "${status}". Valid next states: ${validStates}. Follow the pipeline: ${workflowStates.map((s: any) => s.id).join(" → ")}`,
              };
            }
          }
          const validIds = workflowStates.map((s: any) => s.id);
          if (!validIds.includes(status)) {
            return {
              success: false,
              error: `Unknown status "${status}". Available states: ${validIds.join(", ")}`,
            };
          }
        }
      }
    } catch {
      // Non-fatal: skip validation if session config unavailable
    }
  }

  // Build update payload
  const updatePayload: Record<string, unknown> = {};
  if (status) updatePayload.status = status;
  if (title) updatePayload.title = title;
  if (description !== undefined) updatePayload.description = description;
  if (priority) updatePayload.priority = priority;
  if (assignedTo !== undefined) updatePayload.assignedTo = assignedTo;
  if (labels !== undefined) updatePayload.labels = labels;
  if (dueDate !== undefined) updatePayload.dueDate = dueDate || null;
  if (force) updatePayload.force = true;

  if (Object.keys(updatePayload).length > 0) {
    results.statusUpdate = await ctx.apiCall(
      "PUT",
      `/api/v1/sessions/${ctx.sessionId}/tasks/${taskId}`,
      updatePayload,
    );
  }

  if (comment) {
    results.commentAdded = await ctx.apiCall(
      "POST",
      `/api/v1/sessions/${ctx.sessionId}/tasks/${taskId}/comments`,
      { text: comment, author: ctx.agentId, authorName: "agent" },
    );
  }

  return { success: true, ...results };
}

export async function handleSpawnAgent(
  ctx: ToolContext,
  args: Record<string, string>,
): Promise<unknown> {
  // Enforce per-agent sub-agent limit
  try {
    const agentsResp = (await ctx.apiCall("GET", `/api/v1/sessions/${ctx.sessionId}/agents`)) as any;
    const allAgents = agentsResp?.agents || [];
    const myChildren = allAgents.filter((a: any) => a.config?.spawnedBy === ctx.agentId);
    const myAgent = allAgents.find((a: any) => a.id === ctx.agentId);
    const maxSub = myAgent?.config?.permissions?.maxSubAgents ?? 5;
    if (myChildren.length >= maxSub) {
      return { success: false, error: `Max sub-agents (${maxSub}) reached. You have ${myChildren.length} active sub-agents.` };
    }
  } catch { /* non-fatal */ }

  // Resolve persona
  let persona = args.persona || "";
  if (!persona && args.personaId) {
    try {
      const resp = (await ctx.apiCall("GET", "/api/v1/personas")) as any;
      const personas = resp.personas || [];
      const found = personas.find((p: any) => p.id === args.personaId);
      if (found) {
        persona = found.fullText || found.full_text || "";
      }
    } catch { /* non-fatal */ }
  }

  const result = await ctx.apiCall("POST", `/api/v1/sessions/${ctx.sessionId}/agents`, {
    name: args.name,
    role: args.role || "worker",
    persona,
    personaId: args.personaId || undefined,
    model: args.model,
    spawnedBy: ctx.agentId,
    extraCliArgs: (args as any).extraCliArgs || undefined,
  });

  // Send initial task if provided
  const spawnResult = result as any;
  if (args.task && spawnResult?.id) {
    try {
      await ctx.apiCall("POST", `/api/v1/sessions/${ctx.sessionId}/relay`, {
        from: ctx.agentId,
        to: spawnResult.id,
        message: args.task,
        messageType: "task-assignment",
      });
    } catch { /* non-fatal */ }
  }

  return result;
}

export async function handlePeekAgent(
  ctx: ToolContext,
  args: Record<string, string>,
): Promise<unknown> {
  const agents = (await ctx.apiCall(
    "GET",
    `/api/v1/sessions/${ctx.sessionId}/agents`,
  )) as AgentsResponse;

  const target = findAgentByNameOrId(agents.agents || [], args.agentId);
  if (!target) {
    return { error: `Agent "${args.agentId}" not found` };
  }

  const lines = Math.min(Math.max(parseInt(args.lines) || 15, 1), 50);
  const output = (await ctx.apiCall(
    "GET",
    `/api/v1/sessions/${ctx.sessionId}/agents/${target.id}/output?lines=${lines}`,
  )) as any;

  return {
    agentId: target.id,
    agentName: target.config?.name || target.id,
    lines: output.lines || output.output || "",
  };
}

export async function handleNudgeAgent(
  ctx: ToolContext,
  args: Record<string, string>,
): Promise<unknown> {
  const agents = (await ctx.apiCall(
    "GET",
    `/api/v1/sessions/${ctx.sessionId}/agents`,
  )) as AgentsResponse;

  const target = findAgentByNameOrId(agents.agents || [], args.agentId);
  if (!target) {
    return { error: `Agent "${args.agentId}" not found` };
  }

  // Get self name for attribution
  const self = (agents.agents || []).find(a => a.id === ctx.agentId);
  const selfName = self?.config?.name || ctx.agentId;

  // Nudge rate limiting (if limiter provided by transport)
  if (ctx.nudgeRateLimiter?.isLimited(target.id)) {
    return {
      success: false,
      error: `Rate limited: too many nudges to ${target.config?.name || target.id}. Wait before nudging again.`,
    };
  }

  const nudgeMessage = args.message || "You have pending messages. Run check_messages now.";

  const result = await ctx.apiCall("POST", `/api/v1/sessions/${ctx.sessionId}/agents/${target.id}/nudge`, {
    message: nudgeMessage,
    from: selfName,
  });
  ctx.nudgeRateLimiter?.record(target.id);
  return result;
}

export async function handleShareImage(
  ctx: ToolContext,
  args: Record<string, string>,
): Promise<unknown> {
  if (!args.to) {
    return { error: "to is required" };
  }

  const agents = (await ctx.apiCall(
    "GET",
    `/api/v1/sessions/${ctx.sessionId}/agents`,
  )) as AgentsResponse;

  const target = findAgentByNameOrId(agents.agents || [], args.to);
  if (!target) {
    return { error: `Agent "${args.to}" not found` };
  }

  // Upload the image
  const attachmentResult = (await ctx.apiCall("POST", `/api/v1/sessions/${ctx.sessionId}/attachments`, {
    filePath: args.filePath || undefined,
    base64Data: args.base64Data || undefined,
    filename: args.filename || undefined,
  })) as any;

  if (attachmentResult.error) {
    return { error: attachmentResult.error };
  }

  // Send message with image URL
  const caption = args.caption ? ` — ${args.caption}` : "";
  await ctx.apiCall("POST", `/api/v1/sessions/${ctx.sessionId}/relay`, {
    from: ctx.agentId,
    to: target.id,
    message: `[Image shared: ${attachmentResult.filename || "image"}${caption}] ${attachmentResult.url || ""}`,
    messageType: "text",
  });

  return { success: true, sentTo: target.config?.name || target.id, url: attachmentResult.url };
}

export async function handleWhoami(
  ctx: ToolContext,
  args: Record<string, string>,
): Promise<unknown> {
  const full = args.full === "true" || args.full === true as unknown as string;
  const [agentsResp, wfResp, personaResp] = await Promise.all([
    ctx.apiCall("GET", `/api/v1/sessions/${ctx.sessionId}/agents`) as Promise<AgentsResponse>,
    ctx.apiCall("GET", `/api/v1/sessions/${ctx.sessionId}/workflow-states`) as Promise<Record<string, unknown>>,
    ctx.apiCall("GET", `/api/v1/sessions/${ctx.sessionId}/agents/${ctx.agentId}/persona`) as Promise<Record<string, unknown>>,
  ]);
  const agents = agentsResp.agents || [];
  const self = agents.find(a => a.id === ctx.agentId);
  const persona = (personaResp.persona || "") as string;
  const displayPersona = full ? persona : (persona.length > 500 ? persona.slice(0, 500) + "\n... (use full: true to see complete persona)" : persona);
  return {
    agentId: ctx.agentId, name: self?.config?.name || ctx.agentId, role: self?.config?.role || ctx.agentRole,
    provider: self?.config?.cliProvider, model: self?.config?.model, sessionId: ctx.sessionId,
    team: agents.map(a => ({ id: a.id, name: a.config?.name, role: a.config?.role, status: a.status, isMe: a.id === ctx.agentId })),
    workflow: wfResp.states || [],
    persona: displayPersona || null,
  };
}

// ── Dispatcher ──────────────────────────────────────────

/** Map of tool name → handler function for all extracted tools */
export const TOOL_HANDLER_MAP: Record<string, (ctx: ToolContext, args: Record<string, string>) => Promise<unknown>> = {
  list_agents: handleListAgents,
  broadcast: handleBroadcast,
  get_task: handleGetTask,
  create_task: handleCreateTask,
  remove_agent: handleRemoveAgent,
  report_idle: handleReportIdle,
  request_task: handleRequestTask,
  get_workflow_states: handleGetWorkflowStates,
  list_personas: handleListPersonas,
  save_persona: handleSavePersona,
  save_knowledge: handleSaveKnowledge,
  get_knowledge: handleGetKnowledge,
  search_knowledge: handleSearchKnowledge,
  send_message: handleSendMessage,
  list_tasks: handleListTasks,
  update_task: handleUpdateTask,
  spawn_agent: handleSpawnAgent,
  peek_agent: handlePeekAgent,
  nudge_agent: handleNudgeAgent,
  share_image: handleShareImage,
  whoami: handleWhoami,
};

/**
 * Dispatch a tool call to the appropriate handler.
 * Returns undefined if the tool is not in the shared handler map
 * (caller should handle MCP-specific tools like check_messages, prepare_pr, etc.)
 */
export function getToolHandler(
  toolName: string,
): ((ctx: ToolContext, args: Record<string, string>) => Promise<unknown>) | undefined {
  return TOOL_HANDLER_MAP[toolName];
}
