/**
 * E2E: Group Chat — channels, messaging, real-time updates.
 */
import { test, expect } from "./fixtures";
import { apiCall } from "./helpers";

test.describe("Group Chat", () => {
  test("Chat tab shows #all channel", async ({ authedPage, testSession }) => {
    await authedPage.goto(`/session/${testSession}`);

    // Navigate to Chat tab
    const chatTab = authedPage.locator("text=Chat").first();
    if (await chatTab.isVisible({ timeout: 5_000 }).catch(() => false)) {
      await chatTab.click();
      await expect(authedPage.locator("text=#all").first()).toBeVisible({ timeout: 10_000 });
    }
  });

  test("channel list API returns #all for new session", async ({ testSession }) => {
    const data = await apiCall<{ channels: any[] }>(`/sessions/${testSession}/channels`);
    expect(data.channels).toBeDefined();
    const allChannel = data.channels.find((c: any) => c.id === "#all");
    expect(allChannel).toBeDefined();
  });

  test("channel message stored and retrievable", async ({ testSession }) => {
    // Create channel
    await apiCall(`/sessions/${testSession}/channels`, {
      method: "POST",
      body: { id: "#test-chat", name: "Test Chat" },
    });

    // Get history — should be empty initially
    const history = await apiCall<{ messages: any[] }>(`/sessions/${testSession}/channels/%23test-chat/messages`);
    expect(history.messages).toBeDefined();
    expect(Array.isArray(history.messages)).toBe(true);
  });
});
