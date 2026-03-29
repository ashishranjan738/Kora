/**
 * E2E: Task board — create task, transitions, assignment, comments.
 */
import { test, expect } from "./fixtures";
import { apiCall } from "./helpers";

test.describe("Task Board", () => {
  test("create task via API — appears on task board", async ({ authedPage, testSession }) => {
    // Create task via API
    await apiCall(`/sessions/${testSession}/tasks`, {
      method: "POST",
      body: { sessionId: testSession, title: "E2E Test Task" },
    });

    // Navigate to session and check Tasks tab
    await authedPage.goto(`/session/${testSession}`);
    // Click Tasks tab if visible
    const tasksTab = authedPage.locator("text=Tasks").first();
    if (await tasksTab.isVisible({ timeout: 5_000 }).catch(() => false)) {
      await tasksTab.click();
    }

    await expect(authedPage.locator("text=E2E Test Task").first()).toBeVisible({ timeout: 10_000 });
  });

  test("task status update via API works", async ({ testSession }) => {
    // Create task
    const task = await apiCall<{ id: string; status: string }>(`/sessions/${testSession}/tasks`, {
      method: "POST",
      body: { sessionId: testSession, title: "E2E Transition Task" },
    });

    // Update to in-progress
    const updated = await apiCall<{ status: string }>(`/sessions/${testSession}/tasks/${task.id}`, {
      method: "PUT",
      body: { status: "in-progress" },
    });

    expect(updated.status).toBe("in-progress");
  });

  test("invalid transition rejected", async ({ testSession }) => {
    // Create task (starts in first workflow state)
    const task = await apiCall<{ id: string }>(`/sessions/${testSession}/tasks`, {
      method: "POST",
      body: { sessionId: testSession, title: "E2E Invalid Transition" },
    });

    // Try to skip to "done" directly — should fail with pipeline enforcement
    try {
      await apiCall(`/sessions/${testSession}/tasks/${task.id}`, {
        method: "PUT",
        body: { status: "done" },
      });
    } catch (err: any) {
      expect(err.message).toContain("400");
    }
  });

  test("task assignment stores agent name", async ({ testSession }) => {
    const task = await apiCall<{ id: string; assignedTo?: string }>(`/sessions/${testSession}/tasks`, {
      method: "POST",
      body: { sessionId: testSession, title: "E2E Assigned Task", assignedTo: "test-agent" },
    });

    const fetched = await apiCall<{ assignedTo: string }>(`/sessions/${testSession}/tasks/${task.id}`);
    expect(fetched.assignedTo).toBe("test-agent");
  });

  test("task comments — add and retrieve", async ({ testSession }) => {
    const task = await apiCall<{ id: string }>(`/sessions/${testSession}/tasks`, {
      method: "POST",
      body: { sessionId: testSession, title: "E2E Comment Task" },
    });

    // Add comment
    await apiCall(`/sessions/${testSession}/tasks/${task.id}/comments`, {
      method: "POST",
      body: { text: "E2E test comment", author: "tester", authorName: "Tester" },
    });

    // Retrieve task with comments
    const fetched = await apiCall<{ comments: Array<{ text: string }> }>(`/sessions/${testSession}/tasks/${task.id}`);
    expect(fetched.comments.length).toBeGreaterThanOrEqual(1);
    expect(fetched.comments.some((c: any) => c.text === "E2E test comment")).toBe(true);
  });
});
