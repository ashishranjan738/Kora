/**
 * E2E: Sidebar Chat — visibility, channel creation, relay.
 */
import { test, expect } from "./fixtures";
import { apiCall } from "./helpers";

test.describe("Sidebar Chat", () => {
  test("session detail page loads without crash", async ({ authedPage, testSession }) => {
    await authedPage.goto(`/session/${testSession}`);
    await expect(authedPage.locator("body")).toBeVisible();
    await authedPage.waitForTimeout(2000);
    // No crash = sidebar infrastructure working
  });

  test("#sidebar channel can be created", async ({ testSession }) => {
    const res = await apiCall<{ id: string }>(`/sessions/${testSession}/channels`, {
      method: "POST",
      body: { id: "#sidebar", name: "Sidebar Chat" },
    });

    expect(res.id).toBe("#sidebar");
  });

  test("relay endpoint accepts sidebar channel", async ({ testSession }) => {
    await apiCall(`/sessions/${testSession}/channels`, {
      method: "POST",
      body: { id: "#sidebar", name: "Sidebar" },
    });

    // Relay may fail (no agents) but shouldn't error 500
    try {
      await apiCall(`/sessions/${testSession}/relay`, {
        method: "POST",
        body: { from: "user", to: "master", message: "Hello sidebar", channel: "#sidebar" },
      });
    } catch (err: any) {
      // 404 (no agent) is ok, 500 is not
      expect(err.message).not.toContain("500");
    }
  });
});
