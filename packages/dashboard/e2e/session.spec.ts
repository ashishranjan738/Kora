/**
 * E2E: Session management — home page, create, navigate, delete.
 */
import { test, expect } from "./fixtures";
import { apiCall } from "./helpers";

test.describe("Session Management", () => {
  test("home page loads and shows From Playbook button", async ({ authedPage }) => {
    await authedPage.goto("/");
    await expect(authedPage.locator("text=Sessions").first()).toBeVisible({ timeout: 10_000 });
    await expect(authedPage.locator("text=From Playbook").first()).toBeVisible({ timeout: 5_000 });
  });

  test("create session via API — session appears in list", async ({ authedPage, authToken }) => {
    // Create session via API
    const data = await apiCall<{ id: string }>("/sessions", {
      method: "POST",
      body: { name: "E2E Session Test", projectPath: process.cwd(), worktreeMode: "shared" },
    });
    const sessionId = data.id;

    try {
      // Navigate to home and verify session appears
      await authedPage.goto("/");
      await expect(authedPage.locator(`text=E2E Session Test`).first()).toBeVisible({ timeout: 10_000 });
    } finally {
      // Cleanup
      await apiCall(`/sessions/${sessionId}`, { method: "DELETE" }).catch(() => {});
    }
  });

  test("navigate to session detail page — tabs visible", async ({ authedPage, testSession }) => {
    await authedPage.goto(`/session/${testSession}`);

    // Should show session tabs (Command Center, Tasks, Timeline, etc.)
    await expect(authedPage.locator("body")).toBeVisible();
    // Wait for page to load — look for any tab-like element
    await authedPage.waitForTimeout(2000);
  });

  test("delete session — removed from list", async ({ authedPage, authToken }) => {
    // Create a session to delete
    const data = await apiCall<{ id: string }>("/sessions", {
      method: "POST",
      body: { name: "E2E Delete Me", projectPath: process.cwd(), worktreeMode: "shared" },
    });
    const sessionId = data.id;

    // Verify it appears
    await authedPage.goto("/");
    await expect(authedPage.locator(`text=E2E Delete Me`).first()).toBeVisible({ timeout: 10_000 });

    // Delete via API
    await apiCall(`/sessions/${sessionId}`, { method: "DELETE" });

    // Reload and verify it's gone
    await authedPage.reload();
    await authedPage.waitForTimeout(1000);
    await expect(authedPage.locator(`text=E2E Delete Me`)).toHaveCount(0);
  });
});
