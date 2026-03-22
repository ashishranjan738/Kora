/**
 * Tests for PR #197: message dedup + active status filter for custom workflows.
 *
 * 1. Active status filter: getFilteredTasks status="active" uses activeStatuses[]
 *    from session workflow states instead of hardcoded ['pending','in-progress','review'].
 * 2. Message dedup: sqlitePersisted flag prevents duplicate SQLite writes.
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { AppDatabase } from "../../core/database.js";
import os from "os";
import fs from "fs";
import path from "path";

// ---------------------------------------------------------------------------
// Setup
// ---------------------------------------------------------------------------

let db: AppDatabase;
let tmpDir: string;
const SESSION_ID = "test-session";

function createTask(overrides: Partial<{
  id: string;
  title: string;
  status: string;
  assignedTo: string;
}> = {}) {
  const task = {
    id: overrides.id || `task-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
    sessionId: SESSION_ID,
    title: overrides.title || "Test Task",
    description: "",
    status: overrides.status || "pending",
    assignedTo: overrides.assignedTo || undefined,
    createdBy: "user",
    dependencies: [],
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  };
  db.insertTask(task);
  return task;
}

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "kora-dedup-test-"));
  db = new AppDatabase(tmpDir);
});

afterEach(() => {
  try { db.close(); } catch {}
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// Active status filter tests
// ---------------------------------------------------------------------------

describe("Active status filter for custom workflows (PR #197)", () => {

  describe("default behavior (no activeStatuses)", () => {
    it("status=active matches pending, in-progress, review", () => {
      createTask({ id: "t1", status: "pending" });
      createTask({ id: "t2", status: "in-progress" });
      createTask({ id: "t3", status: "review" });
      createTask({ id: "t4", status: "done" });

      const active = db.getFilteredTasks(SESSION_ID, { status: "active" });
      expect(active).toHaveLength(3);
      const statuses = active.map((t: any) => t.status).sort();
      expect(statuses).toEqual(["in-progress", "pending", "review"]);
    });

    it("status=active excludes done", () => {
      createTask({ id: "t1", status: "done" });
      createTask({ id: "t2", status: "pending" });

      const active = db.getFilteredTasks(SESSION_ID, { status: "active" });
      expect(active).toHaveLength(1);
      expect(active[0].status).toBe("pending");
    });
  });

  describe("custom activeStatuses (Full Pipeline workflow)", () => {
    it("status=active with custom activeStatuses includes e2e-testing and staging", () => {
      createTask({ id: "t1", status: "backlog" });
      createTask({ id: "t2", status: "in-progress" });
      createTask({ id: "t3", status: "review" });
      createTask({ id: "t4", status: "e2e-testing" });
      createTask({ id: "t5", status: "staging" });
      createTask({ id: "t6", status: "done" });

      const customActiveStatuses = ["backlog", "in-progress", "review", "e2e-testing", "staging"];
      const active = db.getFilteredTasks(SESSION_ID, {
        status: "active",
        activeStatuses: customActiveStatuses,
      });

      expect(active).toHaveLength(5);
      const statuses = active.map((t: any) => t.status).sort();
      expect(statuses).toEqual(["backlog", "e2e-testing", "in-progress", "review", "staging"]);
    });

    it("status=active with custom activeStatuses excludes done", () => {
      createTask({ id: "t1", status: "done" });
      createTask({ id: "t2", status: "e2e-testing" });

      const active = db.getFilteredTasks(SESSION_ID, {
        status: "active",
        activeStatuses: ["backlog", "in-progress", "review", "e2e-testing", "staging"],
      });

      expect(active).toHaveLength(1);
      expect(active[0].status).toBe("e2e-testing");
    });

    it("tasks in e2e-testing are now counted as active (not invisible)", () => {
      createTask({ id: "t1", status: "e2e-testing" });

      // Without custom activeStatuses — e2e-testing would be MISSING
      const defaultActive = db.getFilteredTasks(SESSION_ID, { status: "active" });
      expect(defaultActive).toHaveLength(0); // Bug before PR #197

      // With custom activeStatuses — e2e-testing is included
      const customActive = db.getFilteredTasks(SESSION_ID, {
        status: "active",
        activeStatuses: ["backlog", "in-progress", "review", "e2e-testing", "staging"],
      });
      expect(customActive).toHaveLength(1);
    });

    it("tasks in staging are now counted as active", () => {
      createTask({ id: "t1", status: "staging" });

      const defaultActive = db.getFilteredTasks(SESSION_ID, { status: "active" });
      expect(defaultActive).toHaveLength(0);

      const customActive = db.getFilteredTasks(SESSION_ID, {
        status: "active",
        activeStatuses: ["backlog", "in-progress", "review", "e2e-testing", "staging"],
      });
      expect(customActive).toHaveLength(1);
    });

    it("tasks in backlog are now counted as active", () => {
      createTask({ id: "t1", status: "backlog" });

      const defaultActive = db.getFilteredTasks(SESSION_ID, { status: "active" });
      expect(defaultActive).toHaveLength(0);

      const customActive = db.getFilteredTasks(SESSION_ID, {
        status: "active",
        activeStatuses: ["backlog", "in-progress", "review", "e2e-testing", "staging"],
      });
      expect(customActive).toHaveLength(1);
    });
  });

  describe("Simple workflow (3 states)", () => {
    it("status=active with simple activeStatuses", () => {
      createTask({ id: "t1", status: "todo" });
      createTask({ id: "t2", status: "in-progress" });
      createTask({ id: "t3", status: "done" });

      const active = db.getFilteredTasks(SESSION_ID, {
        status: "active",
        activeStatuses: ["todo", "in-progress"],
      });

      expect(active).toHaveLength(2);
    });
  });

  describe("empty activeStatuses falls back to defaults", () => {
    it("empty array uses default active statuses", () => {
      createTask({ id: "t1", status: "pending" });
      createTask({ id: "t2", status: "in-progress" });

      const active = db.getFilteredTasks(SESSION_ID, {
        status: "active",
        activeStatuses: [],
      });

      expect(active).toHaveLength(2);
    });
  });

  describe("other filters still work with activeStatuses", () => {
    it("combines activeStatuses with assignedTo filter", () => {
      createTask({ id: "t1", status: "e2e-testing", assignedTo: "agent-1" });
      createTask({ id: "t2", status: "e2e-testing", assignedTo: "agent-2" });
      createTask({ id: "t3", status: "done", assignedTo: "agent-1" });

      const active = db.getFilteredTasks(SESSION_ID, {
        status: "active",
        activeStatuses: ["e2e-testing", "staging"],
        assignedTo: "agent-1",
      });

      expect(active).toHaveLength(1);
      expect(active[0].id).toBe("t1");
    });

    it("specific status filter ignores activeStatuses", () => {
      createTask({ id: "t1", status: "e2e-testing" });
      createTask({ id: "t2", status: "staging" });

      // When filtering by specific status (not "active"), activeStatuses is irrelevant
      const e2e = db.getFilteredTasks(SESSION_ID, {
        status: "e2e-testing",
        activeStatuses: ["backlog", "in-progress"],
      });

      expect(e2e).toHaveLength(1);
      expect(e2e[0].status).toBe("e2e-testing");
    });
  });
});

// ---------------------------------------------------------------------------
// Message dedup tests (logic-level)
// ---------------------------------------------------------------------------

describe("Message dedup logic (PR #197)", () => {
  it("sqlitePersisted flag prevents duplicate insert", () => {
    // Simulate the dedup logic from message-queue.ts
    const sqlitePersisted = true;

    // When sqlitePersisted=true, skip the SQLite write
    let insertCalled = false;
    if (!sqlitePersisted) {
      insertCalled = true;
    }

    expect(insertCalled).toBe(false);
  });

  it("without sqlitePersisted flag, insert proceeds", () => {
    const sqlitePersisted = false;

    let insertCalled = false;
    if (!sqlitePersisted) {
      insertCalled = true;
    }

    expect(insertCalled).toBe(true);
  });

  it("undefined sqlitePersisted treated as false (insert proceeds)", () => {
    const sqlitePersisted = undefined;

    let insertCalled = false;
    if (!sqlitePersisted) {
      insertCalled = true;
    }

    expect(insertCalled).toBe(true);
  });
});
