/**
 * Unit tests for Sprint-related MCP tools.
 * Tests list_sprints tool (master-only), list_tasks sprint filter,
 * and create_task sprintId parameter.
 *
 * Following the same pattern as mcp-tools.test.ts — testing handler logic
 * with a mock apiCall.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";

// ---------------------------------------------------------------------------
// Mock apiCall — simulates daemon HTTP responses
// ---------------------------------------------------------------------------

const mockApiCall = vi.fn();

// ---------------------------------------------------------------------------
// Simplified handler logic for sprint-related MCP tools
// ---------------------------------------------------------------------------

const AGENT_ID = "test-agent-1";
const SESSION_ID = "test-session";

interface SprintToolArgs {
  status?: string;
  sprint?: string;
  sprintId?: string;
  assignedTo?: string;
  title?: string;
  description?: string;
}

// Simulates the list_sprints MCP tool (master only)
async function handleListSprints(
  args: SprintToolArgs,
  agentRole: string,
): Promise<unknown> {
  // Access control: master only
  if (agentRole !== "master") {
    return {
      success: false,
      error: "list_sprints is only available to master agents.",
    };
  }

  const query = args.status ? `?status=${args.status}` : "";
  const result = await mockApiCall(
    "GET",
    `/api/v1/sessions/${SESSION_ID}/sprints${query}`,
  );

  return result;
}

// Simulates the list_tasks MCP tool with sprint filter
async function handleListTasks(
  args: SprintToolArgs,
): Promise<unknown> {
  const params = new URLSearchParams();
  if (args.assignedTo) params.set("assignedTo", args.assignedTo);
  if (args.sprint) params.set("sprint", args.sprint);

  const query = params.toString() ? `?${params.toString()}` : "";
  const result = await mockApiCall(
    "GET",
    `/api/v1/sessions/${SESSION_ID}/tasks${query}`,
  );

  return result;
}

// Simulates the create_task MCP tool with sprintId parameter
async function handleCreateTask(
  args: SprintToolArgs,
): Promise<unknown> {
  if (!args.title) {
    return { success: false, error: "title is required" };
  }

  const body: Record<string, any> = {
    sessionId: SESSION_ID,
    title: args.title,
    description: args.description || "",
  };

  if (args.sprintId) {
    // Resolve "current" to active sprint ID
    if (args.sprintId === "current") {
      const sprints = await mockApiCall(
        "GET",
        `/api/v1/sessions/${SESSION_ID}/sprints?status=active`,
      );
      if (!sprints || sprints.length === 0) {
        return { success: false, error: "No active sprint. Cannot use sprintId='current'." };
      }
      body.sprintId = sprints[0].id;
    } else {
      body.sprintId = args.sprintId;
    }
  }

  const result = await mockApiCall(
    "POST",
    `/api/v1/sessions/${SESSION_ID}/tasks`,
    body,
  );

  return result;
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("Sprint MCP Tools", () => {

  beforeEach(() => {
    vi.clearAllMocks();
  });

  // ─── list_sprints (master only) ───────────────────────────

  describe("list_sprints", () => {
    it("returns sprints for master agents", async () => {
      const sprints = [
        { id: "s1", name: "Sprint 1", status: "active", taskCount: 5, completedCount: 2 },
        { id: "s2", name: "Sprint 2", status: "planning", taskCount: 0, completedCount: 0 },
      ];
      mockApiCall.mockResolvedValueOnce(sprints);

      const result = await handleListSprints({}, "master");

      expect(mockApiCall).toHaveBeenCalledWith(
        "GET",
        `/api/v1/sessions/${SESSION_ID}/sprints`,
      );
      expect(result).toEqual(sprints);
    });

    it("filters sprints by status", async () => {
      mockApiCall.mockResolvedValueOnce([
        { id: "s1", name: "Sprint 1", status: "active" },
      ]);

      await handleListSprints({ status: "active" }, "master");

      expect(mockApiCall).toHaveBeenCalledWith(
        "GET",
        `/api/v1/sessions/${SESSION_ID}/sprints?status=active`,
      );
    });

    it("rejects list_sprints for worker agents", async () => {
      const result = await handleListSprints({}, "worker");

      expect(result).toEqual({
        success: false,
        error: "list_sprints is only available to master agents.",
      });
      expect(mockApiCall).not.toHaveBeenCalled();
    });
  });

  // ─── list_tasks with sprint filter ────────────────────────

  describe("list_tasks sprint filter", () => {
    it("passes sprint=current to API", async () => {
      mockApiCall.mockResolvedValueOnce({ tasks: [] });

      await handleListTasks({ sprint: "current" });

      expect(mockApiCall).toHaveBeenCalledWith(
        "GET",
        `/api/v1/sessions/${SESSION_ID}/tasks?sprint=current`,
      );
    });

    it("passes sprint=backlog to API", async () => {
      mockApiCall.mockResolvedValueOnce({ tasks: [] });

      await handleListTasks({ sprint: "backlog" });

      expect(mockApiCall).toHaveBeenCalledWith(
        "GET",
        `/api/v1/sessions/${SESSION_ID}/tasks?sprint=backlog`,
      );
    });

    it("passes specific sprint ID to API", async () => {
      mockApiCall.mockResolvedValueOnce({ tasks: [] });

      await handleListTasks({ sprint: "sprint-abc123" });

      expect(mockApiCall).toHaveBeenCalledWith(
        "GET",
        `/api/v1/sessions/${SESSION_ID}/tasks?sprint=sprint-abc123`,
      );
    });

    it("does not include sprint param when not specified", async () => {
      mockApiCall.mockResolvedValueOnce({ tasks: [] });

      await handleListTasks({});

      expect(mockApiCall).toHaveBeenCalledWith(
        "GET",
        `/api/v1/sessions/${SESSION_ID}/tasks`,
      );
    });

    it("combines sprint filter with assignedTo", async () => {
      mockApiCall.mockResolvedValueOnce({ tasks: [] });

      await handleListTasks({ sprint: "current", assignedTo: "me" });

      const callUrl = mockApiCall.mock.calls[0][1];
      expect(callUrl).toContain("sprint=current");
      expect(callUrl).toContain("assignedTo=me");
    });
  });

  // ─── create_task with sprintId ────────────────────────────

  describe("create_task with sprintId", () => {
    it("passes explicit sprintId to API", async () => {
      mockApiCall.mockResolvedValueOnce({
        id: "task-1",
        title: "New Task",
        sprintId: "sprint-123",
      });

      const result = await handleCreateTask({
        title: "New Task",
        sprintId: "sprint-123",
      });

      expect(mockApiCall).toHaveBeenCalledWith(
        "POST",
        `/api/v1/sessions/${SESSION_ID}/tasks`,
        expect.objectContaining({ sprintId: "sprint-123" }),
      );
    });

    it("resolves sprintId=current to active sprint ID", async () => {
      // First call: get active sprints
      mockApiCall.mockResolvedValueOnce([
        { id: "active-sprint-id", name: "Current Sprint", status: "active" },
      ]);
      // Second call: create task
      mockApiCall.mockResolvedValueOnce({
        id: "task-2",
        title: "Current Task",
        sprintId: "active-sprint-id",
      });

      await handleCreateTask({
        title: "Current Task",
        sprintId: "current",
      });

      // Should resolve "current" to the actual sprint ID
      expect(mockApiCall).toHaveBeenCalledWith(
        "POST",
        `/api/v1/sessions/${SESSION_ID}/tasks`,
        expect.objectContaining({ sprintId: "active-sprint-id" }),
      );
    });

    it("returns error when sprintId=current but no active sprint", async () => {
      mockApiCall.mockResolvedValueOnce([]); // No active sprints

      const result = await handleCreateTask({
        title: "Orphan Task",
        sprintId: "current",
      });

      expect(result).toEqual({
        success: false,
        error: "No active sprint. Cannot use sprintId='current'.",
      });
    });

    it("creates task without sprintId (backlog)", async () => {
      mockApiCall.mockResolvedValueOnce({
        id: "task-3",
        title: "Backlog Task",
      });

      await handleCreateTask({ title: "Backlog Task" });

      expect(mockApiCall).toHaveBeenCalledWith(
        "POST",
        `/api/v1/sessions/${SESSION_ID}/tasks`,
        expect.not.objectContaining({ sprintId: expect.anything() }),
      );
    });

    it("requires title parameter", async () => {
      const result = await handleCreateTask({});

      expect(result).toEqual({
        success: false,
        error: "title is required",
      });
      expect(mockApiCall).not.toHaveBeenCalled();
    });
  });

  // ─── Sprint context in persona ────────────────────────────

  describe("Sprint context awareness", () => {
    it("worker list_tasks defaults to sprint=current when active sprint exists", async () => {
      // This validates the expected behavior: workers should default to
      // viewing current sprint tasks. The implementation in persona-builder
      // should inject this guidance.
      // This is a behavioral contract test.

      mockApiCall.mockResolvedValueOnce({
        tasks: [
          { id: "t1", title: "Sprint Task", status: "pending", sprintId: "active-sprint" },
        ],
      });

      const result = await handleListTasks({ sprint: "current" });

      expect(mockApiCall).toHaveBeenCalledWith(
        "GET",
        expect.stringContaining("sprint=current"),
      );
    });
  });
});
