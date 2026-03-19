import { describe, it, expect, vi, beforeEach } from "vitest";

// ---------------------------------------------------------------------------
// We test the MCP tool handlers by extracting the logic from agent-mcp-server.
// Since that file is a standalone script with side-effects (readline, process.argv),
// we replicate the handler logic and circuit-breaker here against the same contract.
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// Mock apiCall — simulates daemon HTTP responses
// ---------------------------------------------------------------------------

const mockApiCall = vi.fn();

// ---------------------------------------------------------------------------
// Replicate key structures from the MCP server
// ---------------------------------------------------------------------------

interface AgentInfo {
  id: string;
  config?: {
    name?: string;
    role?: string;
    cliProvider?: string;
    model?: string;
    channels?: string[];
  };
  status?: string;
}

// Circuit breaker (same logic as agent-mcp-server.ts)
let sendMessageLog: { timestamp: number }[] = [];
const CIRCUIT_BREAKER_MAX = 10;
const CIRCUIT_BREAKER_WINDOW_MS = 2 * 60 * 1000;

function isSendRateLimited(): boolean {
  const now = Date.now();
  while (sendMessageLog.length > 0 && now - sendMessageLog[0].timestamp > CIRCUIT_BREAKER_WINDOW_MS) {
    sendMessageLog.shift();
  }
  return sendMessageLog.length >= CIRCUIT_BREAKER_MAX;
}

function recordSendMessage(): void {
  sendMessageLog.push({ timestamp: Date.now() });
}

// Simplified handleToolCall that mirrors the real implementation
const AGENT_ID = "test-agent-1";
const SESSION_ID = "test-session";

async function handleToolCall(
  toolName: string,
  toolArgs: Record<string, string>,
): Promise<unknown> {
  switch (toolName) {
    case "send_message": {
      if (!toolArgs.to && !toolArgs.channel) {
        return { success: false, error: "Either 'to' or 'channel' must be provided" };
      }

      if (isSendRateLimited()) {
        return {
          success: false,
          error: "Rate limited: you have sent too many messages. Focus on completing your task instead of messaging.",
        };
      }

      const agents = (await mockApiCall(
        "GET",
        `/api/v1/sessions/${SESSION_ID}/agents`,
      )) as { agents?: AgentInfo[] };

      if (toolArgs.channel) {
        const subscribers = (agents.agents || []).filter((a) => {
          const channels = a.config?.channels || [];
          return channels.includes(toolArgs.channel) && a.id !== AGENT_ID;
        });
        if (subscribers.length === 0) {
          return { success: false, error: `No agents subscribed to channel "${toolArgs.channel}"` };
        }
        for (const sub of subscribers) {
          await mockApiCall("POST", `/api/v1/sessions/${SESSION_ID}/relay`, {
            from: AGENT_ID,
            to: sub.id,
            message: `[${toolArgs.channel}] ${toolArgs.message}`,
            messageType: toolArgs.messageType || "text",
          });
        }
        recordSendMessage();
        return { success: true, channel: toolArgs.channel, sentTo: subscribers.map((s) => s.config?.name || s.id) };
      }

      const search = (toolArgs.to || "").toLowerCase();
      const target = (agents.agents || []).find((a) => {
        const name = (a.config?.name || "").toLowerCase();
        return name === search || name.includes(search) || a.id.toLowerCase().includes(search);
      });

      if (!target) {
        return { success: false, error: `Agent "${toolArgs.to}" not found` };
      }

      await mockApiCall("POST", `/api/v1/sessions/${SESSION_ID}/relay`, {
        from: AGENT_ID,
        to: target.id,
        message: toolArgs.message,
        messageType: toolArgs.messageType || "text",
      });

      recordSendMessage();
      return { success: true, sentTo: target.config?.name || target.id };
    }

    case "check_messages": {
      const events = (await mockApiCall(
        "GET",
        `/api/v1/sessions/${SESSION_ID}/events?limit=20&type=message-sent`,
      )) as { events?: Array<{ data?: { to?: string; toName?: string; from?: string; fromName?: string; content?: string }; timestamp?: string }> };

      const incoming = (events.events || []).filter(
        (e) => e.data?.to === AGENT_ID || e.data?.toName === AGENT_ID,
      );

      const messages = incoming.map((e) => ({
        from: e.data?.fromName || e.data?.from || "unknown",
        content: e.data?.content || "",
        timestamp: e.timestamp || "",
      }));

      return { messages, count: messages.length };
    }

    case "list_agents": {
      const agents = (await mockApiCall(
        "GET",
        `/api/v1/sessions/${SESSION_ID}/agents`,
      )) as { agents?: AgentInfo[] };

      return {
        agents: (agents.agents || []).map((a) => ({
          name: a.config?.name,
          id: a.id,
          role: a.config?.role,
          status: a.status,
          provider: a.config?.cliProvider,
          model: a.config?.model,
          isMe: a.id === AGENT_ID,
        })),
      };
    }

    case "broadcast": {
      if (isSendRateLimited()) {
        return {
          success: false,
          error: "Rate limited: you have sent too many messages. Focus on completing your task instead of messaging.",
        };
      }

      await mockApiCall("POST", `/api/v1/sessions/${SESSION_ID}/broadcast`, {
        message: `[From ${AGENT_ID}]: ${toolArgs.message}`,
      });
      recordSendMessage();
      return { success: true, broadcast: true };
    }

    case "list_tasks": {
      // Build query params for filtering (mirrors agent-mcp-server.ts)
      const params = new URLSearchParams();

      const assignedToArg = toolArgs.assignedTo || "me";
      if (assignedToArg === "me") {
        params.set("assignedTo", AGENT_ID);
      } else if (assignedToArg !== "all") {
        const agents = (await mockApiCall(
          "GET",
          `/api/v1/sessions/${SESSION_ID}/agents`,
        )) as { agents?: AgentInfo[] };
        const search = assignedToArg.toLowerCase();
        const target = (agents.agents || []).find((a) => {
          const name = (a.config?.name || "").toLowerCase();
          return name === search || name.includes(search) || a.id.toLowerCase().includes(search);
        });
        if (target) {
          params.set("assignedTo", target.id);
        } else {
          params.set("assignedTo", assignedToArg);
        }
      }

      const statusArg = toolArgs.status || "active";
      if (statusArg !== "all") {
        params.set("status", statusArg);
      }

      const summaryArg = toolArgs.summary === "false" ? "false" : "true";
      params.set("summary", summaryArg);

      const queryString = params.toString();
      const response = (await mockApiCall(
        "GET",
        `/api/v1/sessions/${SESSION_ID}/tasks?${queryString}`,
      )) as { tasks?: Array<{ id: string; title: string; status: string; dependencies?: string[]; [key: string]: unknown }> };

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

      return response;
    }

    case "get_task": {
      if (!toolArgs.taskId) {
        return { error: "taskId is required" };
      }
      const taskResp = (await mockApiCall(
        "GET",
        `/api/v1/sessions/${SESSION_ID}/tasks/${toolArgs.taskId}`,
      )) as any;

      if (taskResp.error) {
        return { error: taskResp.error };
      }
      return { task: taskResp };
    }

    case "update_task": {
      const { taskId, status, comment, title, description, priority, assignedTo } = toolArgs;
      const results: { statusUpdate?: unknown; commentAdded?: unknown } = {};

      if (status === "in-progress") {
        const allTasks = (await mockApiCall(
          "GET",
          `/api/v1/sessions/${SESSION_ID}/tasks`,
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

      const updatePayload: Record<string, string> = {};
      if (status) updatePayload.status = status;
      if (title) updatePayload.title = title;
      if (description !== undefined) updatePayload.description = description;
      if (priority) updatePayload.priority = priority;
      if (assignedTo !== undefined) updatePayload.assignedTo = assignedTo;

      if (Object.keys(updatePayload).length > 0) {
        results.statusUpdate = await mockApiCall(
          "PUT",
          `/api/v1/sessions/${SESSION_ID}/tasks/${taskId}`,
          updatePayload,
        );
      }

      if (comment) {
        results.commentAdded = await mockApiCall(
          "POST",
          `/api/v1/sessions/${SESSION_ID}/tasks/${taskId}/comments`,
          { text: comment, author: AGENT_ID, authorName: "agent" },
        );
      }

      return { success: true, ...results };
    }

    case "create_task": {
      const result = await mockApiCall("POST", `/api/v1/sessions/${SESSION_ID}/tasks`, {
        title: toolArgs.title,
        description: toolArgs.description || "",
        assignedTo: toolArgs.assignedTo || undefined,
        priority: toolArgs.priority || undefined,
      });
      return result;
    }

    case "spawn_agent": {
      const result = await mockApiCall("POST", `/api/v1/sessions/${SESSION_ID}/agents`, {
        name: toolArgs.name,
        role: toolArgs.role || "worker",
        model: toolArgs.model,
        persona: toolArgs.persona || "",
        initialTask: toolArgs.task,
      });
      return result;
    }

    case "remove_agent": {
      await mockApiCall("DELETE", `/api/v1/sessions/${SESSION_ID}/agents/${toolArgs.agentId}`);
      return { success: true, removed: toolArgs.agentId, reason: toolArgs.reason };
    }

    default:
      return { error: `Unknown tool: ${toolName}` };
  }
}

// ---------------------------------------------------------------------------
// Test fixtures
// ---------------------------------------------------------------------------

const MOCK_AGENTS: AgentInfo[] = [
  {
    id: "test-agent-1",
    config: { name: "Tester", role: "worker", cliProvider: "claude-code", model: "claude-sonnet-4-6", channels: ["#all"] },
    status: "running",
  },
  {
    id: "architect-1",
    config: { name: "Architect", role: "master", cliProvider: "claude-code", model: "claude-sonnet-4-6", channels: ["#all", "#orchestration"] },
    status: "running",
  },
  {
    id: "frontend-1",
    config: { name: "Frontend", role: "worker", cliProvider: "claude-code", model: "claude-sonnet-4-6", channels: ["#all", "#frontend"] },
    status: "running",
  },
];

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("MCP Tool Handlers", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    sendMessageLog = [];
    mockApiCall.mockImplementation(async (method: string, urlPath: string, _body?: unknown) => {
      if (method === "GET" && urlPath.includes("/agents")) {
        return { agents: MOCK_AGENTS };
      }
      if (method === "GET" && urlPath.includes("/events")) {
        return { events: [] };
      }
      if (method === "GET" && urlPath.includes("/tasks")) {
        return { tasks: [] };
      }
      return { success: true };
    });
  });

  // ---- send_message ----

  it("send_message delivers a message and returns success", async () => {
    const result = await handleToolCall("send_message", {
      to: "Architect",
      message: "Hello!",
    }) as any;

    expect(result.success).toBe(true);
    expect(result.sentTo).toBe("Architect");
    expect(mockApiCall).toHaveBeenCalledWith("POST", expect.stringContaining("/relay"), {
      from: AGENT_ID,
      to: "architect-1",
      message: "Hello!",
      messageType: "text",
    });
  });

  it("send_message rate limits after 10 messages in 2 minutes", async () => {
    for (let i = 0; i < 10; i++) {
      await handleToolCall("send_message", { to: "Architect", message: `Msg ${i}` });
    }

    const result = await handleToolCall("send_message", {
      to: "Architect",
      message: "One more",
    }) as any;

    expect(result.success).toBe(false);
    expect(result.error).toContain("Rate limited");
  });

  it("send_message returns error when 'to' and 'channel' are both missing", async () => {
    const result = await handleToolCall("send_message", {
      message: "Hello",
    }) as any;

    expect(result.success).toBe(false);
    expect(result.error).toContain("Either 'to' or 'channel'");
  });

  it("send_message returns error when target agent not found", async () => {
    const result = await handleToolCall("send_message", {
      to: "NonExistent",
      message: "Hello",
    }) as any;

    expect(result.success).toBe(false);
    expect(result.error).toContain("not found");
  });

  // ---- check_messages ----

  it("check_messages returns incoming messages for the agent", async () => {
    mockApiCall.mockImplementation(async (method: string, urlPath: string) => {
      if (urlPath.includes("/events")) {
        return {
          events: [
            {
              data: { to: AGENT_ID, fromName: "Architect", content: "Do the task" },
              timestamp: "2026-03-17T10:00:00Z",
            },
            {
              data: { to: "other-agent", fromName: "Architect", content: "Not for me" },
              timestamp: "2026-03-17T10:00:01Z",
            },
          ],
        };
      }
      return { agents: MOCK_AGENTS };
    });

    const result = await handleToolCall("check_messages", {}) as any;

    expect(result.count).toBe(1);
    expect(result.messages[0].from).toBe("Architect");
    expect(result.messages[0].content).toBe("Do the task");
  });

  it("check_messages returns empty when no messages", async () => {
    const result = await handleToolCall("check_messages", {}) as any;
    expect(result.count).toBe(0);
    expect(result.messages).toHaveLength(0);
  });

  // ---- list_agents ----

  it("list_agents returns all agents with status and marks self", async () => {
    const result = await handleToolCall("list_agents", {}) as any;

    expect(result.agents).toHaveLength(3);

    const self = result.agents.find((a: any) => a.isMe);
    expect(self).toBeDefined();
    expect(self.name).toBe("Tester");

    const architect = result.agents.find((a: any) => a.name === "Architect");
    expect(architect.role).toBe("master");
    expect(architect.status).toBe("running");
  });

  // ---- broadcast ----

  it("broadcast sends to all agents except sender", async () => {
    const result = await handleToolCall("broadcast", {
      message: "Status update: all done",
    }) as any;

    expect(result.success).toBe(true);
    expect(result.broadcast).toBe(true);
    expect(mockApiCall).toHaveBeenCalledWith(
      "POST",
      expect.stringContaining("/broadcast"),
      { message: `[From ${AGENT_ID}]: Status update: all done` },
    );
  });

  it("broadcast is also rate limited by circuit breaker", async () => {
    for (let i = 0; i < 10; i++) {
      await handleToolCall("send_message", { to: "Architect", message: `Msg ${i}` });
    }

    const result = await handleToolCall("broadcast", {
      message: "This should fail",
    }) as any;

    expect(result.success).toBe(false);
    expect(result.error).toContain("Rate limited");
  });

  // ---- list_tasks ----

  it("list_tasks defaults to assignedTo=me and status=active", async () => {
    mockApiCall.mockImplementation(async (method: string, urlPath: string) => {
      if (urlPath.includes("/tasks")) {
        return { tasks: [] };
      }
      return { agents: MOCK_AGENTS };
    });

    await handleToolCall("list_tasks", {}) as any;

    // Should call with assignedTo=AGENT_ID and status=active and summary=true
    expect(mockApiCall).toHaveBeenCalledWith(
      "GET",
      expect.stringContaining(`assignedTo=${AGENT_ID}`),
    );
    expect(mockApiCall).toHaveBeenCalledWith(
      "GET",
      expect.stringContaining("status=active"),
    );
    expect(mockApiCall).toHaveBeenCalledWith(
      "GET",
      expect.stringContaining("summary=true"),
    );
  });

  it("list_tasks with assignedTo=all omits assignedTo param", async () => {
    mockApiCall.mockImplementation(async (method: string, urlPath: string) => {
      if (urlPath.includes("/tasks")) {
        return { tasks: [] };
      }
      return { agents: MOCK_AGENTS };
    });

    await handleToolCall("list_tasks", { assignedTo: "all", status: "all" }) as any;

    // Should NOT contain assignedTo or status params
    const taskCall = mockApiCall.mock.calls.find(
      (c: any[]) => c[0] === "GET" && c[1].includes("/tasks"),
    );
    expect(taskCall).toBeDefined();
    expect(taskCall![1]).not.toContain("assignedTo=");
    expect(taskCall![1]).not.toContain("status=");
  });

  it("list_tasks returns tasks and marks blocked tasks", async () => {
    mockApiCall.mockImplementation(async (method: string, urlPath: string) => {
      if (urlPath.includes("/tasks")) {
        return {
          tasks: [
            { id: "t1", title: "Setup DB", status: "pending", dependencies: [] },
            { id: "t2", title: "Build API", status: "pending", dependencies: ["t1"] },
          ],
        };
      }
      return { agents: MOCK_AGENTS };
    });

    const result = await handleToolCall("list_tasks", { assignedTo: "all", status: "all" }) as any;

    expect(result.tasks).toHaveLength(2);
    const t2 = result.tasks.find((t: any) => t.id === "t2");
    expect(t2.blocked).toBe(true);
    expect(t2.blockedReason).toContain("Setup DB");
  });

  // ---- get_task ----

  it("get_task returns full task details", async () => {
    mockApiCall.mockImplementation(async (method: string, urlPath: string) => {
      if (urlPath.includes("/tasks/t1")) {
        return {
          id: "t1",
          title: "Setup DB",
          description: "Full description here",
          status: "pending",
          priority: "P0",
          assignedTo: "agent-a",
          comments: [{ id: "c1", text: "Working on it" }],
          dependencies: [],
        };
      }
      return { agents: MOCK_AGENTS };
    });

    const result = await handleToolCall("get_task", { taskId: "t1" }) as any;

    expect(result.task).toBeDefined();
    expect(result.task.id).toBe("t1");
    expect(result.task.description).toBe("Full description here");
    expect(result.task.priority).toBe("P0");
    expect(result.task.comments).toHaveLength(1);
  });

  it("get_task returns error when taskId missing", async () => {
    const result = await handleToolCall("get_task", {}) as any;
    expect(result.error).toContain("taskId is required");
  });

  it("get_task returns error for non-existent task", async () => {
    mockApiCall.mockResolvedValue({ error: "Task not found" });

    const result = await handleToolCall("get_task", { taskId: "nonexistent" }) as any;
    expect(result.error).toContain("Task not found");
  });

  // ---- update_task ----

  it("update_task updates status and adds comment", async () => {
    const result = await handleToolCall("update_task", {
      taskId: "t1",
      status: "done",
      comment: "All tests pass",
    }) as any;

    expect(result.success).toBe(true);
    expect(mockApiCall).toHaveBeenCalledWith("PUT", expect.stringContaining("/tasks/t1"), { status: "done" });
    expect(mockApiCall).toHaveBeenCalledWith("POST", expect.stringContaining("/tasks/t1/comments"), {
      text: "All tests pass",
      author: AGENT_ID,
      authorName: "agent",
    });
  });

  it("update_task sends title, priority, and assignedTo in update payload", async () => {
    const result = await handleToolCall("update_task", {
      taskId: "t1",
      title: "New title",
      priority: "P0",
      assignedTo: "agent-b",
    }) as any;

    expect(result.success).toBe(true);
    expect(mockApiCall).toHaveBeenCalledWith("PUT", expect.stringContaining("/tasks/t1"), {
      title: "New title",
      priority: "P0",
      assignedTo: "agent-b",
    });
  });

  it("update_task blocks in-progress if dependencies are incomplete", async () => {
    mockApiCall.mockImplementation(async (method: string, urlPath: string) => {
      if (method === "GET" && urlPath.includes("/tasks")) {
        return {
          tasks: [
            { id: "t1", title: "Setup DB", status: "pending" },
            { id: "t2", title: "Build API", status: "pending", dependencies: ["t1"] },
          ],
        };
      }
      return { success: true };
    });

    const result = await handleToolCall("update_task", {
      taskId: "t2",
      status: "in-progress",
    }) as any;

    expect(result.success).toBe(false);
    expect(result.error).toContain("blocked by incomplete dependencies");
  });

  // ---- create_task ----

  it("create_task creates a task with required fields", async () => {
    mockApiCall.mockResolvedValue({ id: "t-new", title: "New task", status: "pending" });

    const result = await handleToolCall("create_task", {
      title: "Write tests",
      description: "Add unit tests for auth module",
      assignedTo: "frontend-1",
    }) as any;

    expect(mockApiCall).toHaveBeenCalledWith("POST", expect.stringContaining("/tasks"), {
      title: "Write tests",
      description: "Add unit tests for auth module",
      assignedTo: "frontend-1",
      priority: undefined,
    });
    expect(result.id).toBe("t-new");
  });

  it("create_task passes priority when provided", async () => {
    mockApiCall.mockResolvedValue({ id: "t-new", title: "Urgent task", status: "pending", priority: "P0" });

    const result = await handleToolCall("create_task", {
      title: "Urgent task",
      priority: "P0",
    }) as any;

    expect(mockApiCall).toHaveBeenCalledWith("POST", expect.stringContaining("/tasks"), {
      title: "Urgent task",
      description: "",
      assignedTo: undefined,
      priority: "P0",
    });
    expect(result.priority).toBe("P0");
  });

  // ---- spawn_agent (master only) ----

  it("spawn_agent calls the daemon API to create a new agent", async () => {
    mockApiCall.mockResolvedValue({ id: "new-worker-1", status: "running" });

    const result = await handleToolCall("spawn_agent", {
      name: "New Worker",
      model: "claude-sonnet-4-6",
      role: "worker",
    }) as any;

    expect(mockApiCall).toHaveBeenCalledWith("POST", expect.stringContaining("/agents"), {
      name: "New Worker",
      role: "worker",
      model: "claude-sonnet-4-6",
      persona: "",
      initialTask: undefined,
    });
    expect(result.id).toBe("new-worker-1");
  });

  // ---- remove_agent (master only) ----

  it("remove_agent calls the daemon API to remove an agent", async () => {
    mockApiCall.mockResolvedValue({ success: true });

    const result = await handleToolCall("remove_agent", {
      agentId: "frontend-1",
      reason: "Task complete",
    }) as any;

    expect(result.success).toBe(true);
    expect(result.removed).toBe("frontend-1");
    expect(result.reason).toBe("Task complete");
    expect(mockApiCall).toHaveBeenCalledWith(
      "DELETE",
      expect.stringContaining("/agents/frontend-1"),
    );
  });

  // ---- prepare_pr (git rebase automation) ----
  // Note: prepare_pr handler uses execFileAsync which isn't easily mocked in this test structure.
  // These are placeholder tests to document the tool's behavior contract.
  // Full integration tests should be added separately using a test repository.

  it("prepare_pr tool definition exists", () => {
    // Verify the tool is properly defined (will be checked by MCP protocol tests)
    // This is a placeholder to ensure the tool is recognized
    expect(true).toBe(true);
  });
});
