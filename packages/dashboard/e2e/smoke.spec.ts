/**
 * Smoke test — validates E2E infrastructure is working.
 * Loads the dashboard, verifies auth, creates/deletes a session.
 */
import { test, expect } from "./fixtures";

test.describe("E2E Infrastructure Smoke Test", () => {
  test("dashboard loads and shows session list", async ({ authedPage }) => {
    await authedPage.goto("/");
    // Wait for the main page to render
    await expect(authedPage.locator("body")).toBeVisible();
    // Should have "All Sessions" or similar heading
    await expect(authedPage.locator("text=Sessions").first()).toBeVisible({ timeout: 10_000 });
  });

  test("session detail page loads", async ({ authedPage, testSession }) => {
    await authedPage.goto(`/session/${testSession}`);
    // Should show session name or loading state
    await expect(authedPage.locator("body")).toBeVisible();
  });

  test("API health check via auth token", async ({ authToken }) => {
    const res = await fetch("http://localhost:7891/api/v1/sessions", {
      headers: { Authorization: `Bearer ${authToken}` },
    });
    expect(res.ok).toBe(true);
    const data = await res.json();
    expect(data).toHaveProperty("sessions");
  });
});
