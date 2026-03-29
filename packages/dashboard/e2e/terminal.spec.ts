/**
 * E2E: Terminal — page rendering, WebSocket connection attempt.
 * Note: Full terminal testing requires a running agent with tmux/holdpty.
 * These tests verify the infrastructure (page loads, no crashes).
 */
import { test, expect } from "./fixtures";

test.describe("Terminal", () => {
  test("session detail page loads without terminal crash", async ({ authedPage, testSession }) => {
    await authedPage.goto(`/session/${testSession}`);
    await expect(authedPage.locator("body")).toBeVisible();
    // Page should render even with no agents (empty command center)
    await authedPage.waitForTimeout(2000);
    // No unhandled errors = success
  });

  test("session page handles missing agents gracefully", async ({ authedPage, testSession }) => {
    await authedPage.goto(`/session/${testSession}`);

    // Should not show any error dialogs or crash
    const errorDialog = authedPage.locator("[role=alertdialog]");
    await expect(errorDialog).toHaveCount(0);
  });
});
