/**
 * Playwright test fixtures — auth injection, session lifecycle, agent setup.
 */
import { test as base, type Page, type BrowserContext } from "@playwright/test";
import { readToken, createTestSession, deleteSession, apiCall } from "./helpers";

/** Extended test fixtures for Kora E2E tests */
type KoraFixtures = {
  /** Authenticated page with token injected */
  authedPage: Page;
  /** Test session ID — created before test, deleted after */
  testSession: string;
  /** Auth token for direct API calls in tests */
  authToken: string;
};

export const test = base.extend<KoraFixtures>({
  // Inject auth token into browser context via localStorage
  authedPage: async ({ page, context }, use) => {
    const token = readToken();

    // Set token in localStorage before navigating
    await context.addInitScript((t) => {
      window.localStorage.setItem("kora_token", t);
    }, token);

    // Also add token cookie as fallback
    await context.addCookies([
      {
        name: "kora_token",
        value: token,
        domain: "localhost",
        path: "/",
      },
    ]);

    await use(page);
  },

  // Create a fresh test session before each test, tear down after
  testSession: async ({}, use) => {
    const sessionId = await createTestSession();
    await use(sessionId);
    await deleteSession(sessionId);
  },

  // Expose auth token for direct API calls
  authToken: async ({}, use) => {
    const token = readToken();
    await use(token);
  },
});

export { expect } from "@playwright/test";
