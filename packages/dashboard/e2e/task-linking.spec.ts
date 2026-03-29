/**
 * E2E: Task Linking — dependency creation via API.
 */
import { test, expect } from "./fixtures";
import { apiCall } from "./helpers";

test.describe("Task Linking (Dependencies)", () => {
  test("create task with dependency", async ({ testSession }) => {
    const taskA = await apiCall<{ id: string }>(`/sessions/${testSession}/tasks`, {
      method: "POST",
      body: { sessionId: testSession, title: "E2E Task A" },
    });

    const taskB = await apiCall<{ id: string; dependencies: string[] }>(`/sessions/${testSession}/tasks`, {
      method: "POST",
      body: { sessionId: testSession, title: "E2E Task B", dependencies: [taskA.id] },
    });

    const fetched = await apiCall<{ dependencies: string[] }>(`/sessions/${testSession}/tasks/${taskB.id}`);
    expect(fetched.dependencies).toContain(taskA.id);
  });

  test("task without dependencies has empty array", async ({ testSession }) => {
    const task = await apiCall<{ id: string }>(`/sessions/${testSession}/tasks`, {
      method: "POST",
      body: { sessionId: testSession, title: "E2E Independent" },
    });

    const fetched = await apiCall<{ dependencies: string[] }>(`/sessions/${testSession}/tasks/${task.id}`);
    expect(fetched.dependencies).toEqual([]);
  });

  test("knowledge edges via API", async ({ testSession }) => {
    // Save knowledge entries
    await apiCall(`/sessions/${testSession}/knowledge-db`, {
      method: "POST",
      body: { key: "e2e-v1", value: "Version 1", savedBy: "tester" },
    });
    await apiCall(`/sessions/${testSession}/knowledge-db`, {
      method: "POST",
      body: { key: "e2e-v2", value: "Version 2", savedBy: "tester" },
    });

    // Create edge
    const edge = await apiCall<{ success: boolean }>(`/sessions/${testSession}/knowledge-db/edges`, {
      method: "POST",
      body: { fromKey: "e2e-v2", toKey: "e2e-v1", edgeType: "supersedes" },
    });
    expect(edge.success).toBe(true);

    // Retrieve edges
    const edges = await apiCall<{ edges: any[]; count: number }>(`/sessions/${testSession}/knowledge-db/e2e-v2/edges`);
    expect(edges.count).toBeGreaterThanOrEqual(1);
  });
});
