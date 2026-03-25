/**
 * Integration test setup helper.
 * Creates test Express app with MockPtyBackend and in-memory dependencies.
 */

import { tmpdir } from "os";
import { join } from "path";
import { randomUUID } from "crypto";
import { mkdirSync, rmSync } from "fs";
import type { Application } from "express";
import { createApp } from "../../server/index.js";
import { SessionManager } from "../../core/session-manager.js";
import { registry } from "../../cli-providers/index.js";
import { MockPtyBackend } from "../../testing/mock-pty-backend.js";
import { SuggestionsDatabase } from "../../core/suggestions-db.js";
import { PlaybookDatabase } from "../../core/playbook-database.js";

export interface TestContext {
  app: Application;
  token: string;
  sessionManager: SessionManager;
  terminal: MockPtyBackend;
  testDir: string;
  orchestrators: Map<string, any>;
  cleanup: () => void;
}

/**
 * Set up a test app instance with mock dependencies.
 */
export function setupTestApp(): TestContext {
  const testId = randomUUID().slice(0, 8);
  const testDir = join(tmpdir(), `kora-test-${testId}`);
  mkdirSync(testDir, { recursive: true });

  const token = `test-token-${testId}`;
  const sessionManager = new SessionManager(testDir);
  const terminal = new MockPtyBackend();
  const orchestrators = new Map();

  const suggestionsDb = new SuggestionsDatabase(true);
  const playbookDb = new PlaybookDatabase(testDir);

  const app = createApp({
    token,
    deps: {
      sessionManager,
      orchestrators,
      providerRegistry: registry,
      terminal,
      startTime: Date.now(),
      globalConfigDir: testDir,
      suggestionsDb,
      playbookDb,
    },
    skipDashboard: true,
  });

  const cleanup = () => {
    try {
      suggestionsDb.close();
      rmSync(testDir, { recursive: true, force: true });
    } catch {
      // Ignore cleanup errors
    }
  };

  return {
    app,
    token,
    sessionManager,
    terminal,
    testDir,
    orchestrators,
    cleanup,
  };
}
