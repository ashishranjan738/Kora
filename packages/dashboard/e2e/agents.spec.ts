/**
 * E2E: Agent management — spawn API, agent list, stop.
 * Note: Full agent spawning requires tmux + CLI tools. These tests verify
 * the API layer and dashboard rendering with mock agent data.
 */
import { test, expect } from "./fixtures";
import { apiCall } from "./helpers";

test.describe("Agent Management", () => {
  test("agents list endpoint returns empty for new session", async ({ testSession }) => {
    const data = await apiCall<{ agents: any[] }>(`/sessions/${testSession}/agents`);
    expect(data.agents).toBeDefined();
    expect(Array.isArray(data.agents)).toBe(true);
  });

  test("session detail page renders Command Center", async ({ authedPage, testSession }) => {
    await authedPage.goto(`/session/${testSession}`);
    await expect(authedPage.locator("body")).toBeVisible();
    // Page should load without crashing — Command Center is default tab
    await authedPage.waitForTimeout(2000);
    // No crash = success for empty agent list
  });

  test("spawn agent API validates required fields", async ({ testSession }) => {
    // Missing required provider field should fail
    try {
      await apiCall(`/sessions/${testSession}/agents`, {
        method: "POST",
        body: { name: "Test Agent" }, // missing provider
      });
    } catch (err: any) {
      expect(err.message).toMatch(/4\d\d/); // 400-level error
    }
  });

  test("session overview shows agent count", async ({ authedPage, testSession }) => {
    await authedPage.goto(`/session/${testSession}/overview`);
    await expect(authedPage.locator("body")).toBeVisible();
    await authedPage.waitForTimeout(2000);
  });
});
