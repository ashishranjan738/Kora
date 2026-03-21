/**
 * Unit tests for Sprint Management database operations.
 * Tests sprint CRUD, task-sprint relationships, sprint lifecycle,
 * and invariant enforcement at the database layer.
 *
 * These tests are written TDD-style ahead of implementation.
 * They define the expected behavior based on the design doc:
 * - Sprint table: id, session_id, name, goal, status, started_at, completed_at, created_at, updated_at
 * - Task-sprint relationship: sprint_id column on tasks table
 * - Sprint statuses: planning -> active -> completed (no backward transitions)
 * - Max 1 active sprint per session
 * - Max 20 sprints per session
 * - ON DELETE SET NULL: deleting sprint reverts tasks to backlog
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { AppDatabase } from "../database.js";
import os from "os";
import fs from "fs";
import path from "path";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

let db: AppDatabase;
let tmpDir: string;

const SESSION_ID = "session-1";

function createSprint(overrides: Partial<{
  id: string;
  sessionId: string;
  name: string;
  goal: string;
  status: string;
  startedAt: string | null;
  completedAt: string | null;
  createdAt: string;
  updatedAt: string;
}> = {}) {
  return {
    id: overrides.id || `sprint-${Date.now()}`,
    sessionId: overrides.sessionId || SESSION_ID,
    name: overrides.name || "Sprint 1",
    goal: overrides.goal || "Test goal",
    status: overrides.status || "planning",
    startedAt: overrides.startedAt || null,
    completedAt: overrides.completedAt || null,
    createdAt: overrides.createdAt || new Date().toISOString(),
    updatedAt: overrides.updatedAt || new Date().toISOString(),
  };
}

function createTask(overrides: Partial<{
  id: string;
  sessionId: string;
  title: string;
  description: string;
  status: string;
  assignedTo: string;
  createdBy: string;
  dependencies: string[];
  sprintId: string | null;
}> = {}) {
  const task = {
    id: overrides.id || `task-${Date.now()}`,
    sessionId: overrides.sessionId || SESSION_ID,
    title: overrides.title || "Test Task",
    description: overrides.description || "",
    status: overrides.status || "pending",
    assignedTo: overrides.assignedTo || undefined,
    createdBy: overrides.createdBy || "user",
    dependencies: overrides.dependencies || [],
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  };
  db.insertTask(task);
  return task;
}

// ---------------------------------------------------------------------------
// Setup / Teardown
// ---------------------------------------------------------------------------

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "kora-sprint-test-"));
  db = new AppDatabase(tmpDir);
});

afterEach(() => {
  try { db.close(); } catch {}
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// Tests — Sprint CRUD
// ---------------------------------------------------------------------------

describe("Sprint Management — Database Layer", () => {

  describe("Sprint table migration", () => {
    it("creates sprints table with correct schema", () => {
      // Verify the sprints table exists after migration
      const tables = db.db.prepare(
        "SELECT name FROM sqlite_master WHERE type='table' AND name='sprints'"
      ).all();
      expect(tables).toHaveLength(1);
    });

    it("adds sprint_id column to tasks table", () => {
      // Verify sprint_id column exists on tasks
      const columns = db.db.prepare("PRAGMA table_info(tasks)").all() as any[];
      const sprintCol = columns.find((c: any) => c.name === "sprint_id");
      expect(sprintCol).toBeDefined();
    });

    it("creates indexes for sprint queries", () => {
      const indexes = db.db.prepare(
        "SELECT name FROM sqlite_master WHERE type='index' AND name LIKE 'idx_sprint%'"
      ).all() as any[];
      const indexNames = indexes.map((i: any) => i.name);
      expect(indexNames).toContain("idx_sprints_session");
      expect(indexNames).toContain("idx_sprints_status");
      expect(indexNames).toContain("idx_tasks_sprint");
    });
  });

  describe("insertSprint", () => {
    it("inserts a sprint with all fields", () => {
      const sprint = createSprint({ id: "sprint-1", name: "Auth Sprint", goal: "Ship auth" });
      db.insertSprint(sprint);

      const result = db.getSprint("sprint-1");
      expect(result).not.toBeNull();
      expect(result.id).toBe("sprint-1");
      expect(result.name).toBe("Auth Sprint");
      expect(result.goal).toBe("Ship auth");
      expect(result.status).toBe("planning");
      expect(result.startedAt).toBeNull();
      expect(result.completedAt).toBeNull();
    });

    it("inserts a sprint with default goal (empty string)", () => {
      const sprint = createSprint({ id: "sprint-2", goal: "" });
      db.insertSprint(sprint);

      const result = db.getSprint("sprint-2");
      expect(result.goal).toBe("");
    });

    it("inserts a sprint with default status (planning)", () => {
      const sprint = createSprint({ id: "sprint-3" });
      db.insertSprint(sprint);

      const result = db.getSprint("sprint-3");
      expect(result.status).toBe("planning");
    });

    it("rejects duplicate sprint IDs", () => {
      const sprint = createSprint({ id: "sprint-dup" });
      db.insertSprint(sprint);

      expect(() => db.insertSprint(sprint)).toThrow();
    });
  });

  describe("getSprint", () => {
    it("returns sprint by ID", () => {
      const sprint = createSprint({ id: "sprint-get" });
      db.insertSprint(sprint);

      const result = db.getSprint("sprint-get");
      expect(result).not.toBeNull();
      expect(result.id).toBe("sprint-get");
    });

    it("returns null for non-existent sprint", () => {
      const result = db.getSprint("nonexistent");
      expect(result).toBeNull();
    });
  });

  describe("getSprints (list)", () => {
    beforeEach(() => {
      db.insertSprint(createSprint({ id: "s1", name: "Sprint 1", status: "completed", sessionId: SESSION_ID }));
      db.insertSprint(createSprint({ id: "s2", name: "Sprint 2", status: "active", sessionId: SESSION_ID }));
      db.insertSprint(createSprint({ id: "s3", name: "Sprint 3", status: "planning", sessionId: SESSION_ID }));
      db.insertSprint(createSprint({ id: "s4", name: "Other Session Sprint", sessionId: "session-2" }));
    });

    it("lists all sprints for a session", () => {
      const sprints = db.getSprints(SESSION_ID);
      expect(sprints).toHaveLength(3);
    });

    it("does not include sprints from other sessions", () => {
      const sprints = db.getSprints(SESSION_ID);
      const names = sprints.map((s: any) => s.name);
      expect(names).not.toContain("Other Session Sprint");
    });

    it("filters sprints by status", () => {
      const active = db.getSprints(SESSION_ID, { status: "active" });
      expect(active).toHaveLength(1);
      expect(active[0].name).toBe("Sprint 2");
    });

    it("returns all statuses when status filter is 'all'", () => {
      const all = db.getSprints(SESSION_ID, { status: "all" });
      expect(all).toHaveLength(3);
    });

    it("returns empty array for session with no sprints", () => {
      const sprints = db.getSprints("empty-session");
      expect(sprints).toEqual([]);
    });
  });

  describe("updateSprint", () => {
    it("updates sprint name", () => {
      db.insertSprint(createSprint({ id: "sprint-upd" }));

      const result = db.updateSprint("sprint-upd", { name: "Renamed Sprint" });
      expect(result).not.toBeNull();
      expect(result.name).toBe("Renamed Sprint");
    });

    it("updates sprint goal", () => {
      db.insertSprint(createSprint({ id: "sprint-goal" }));

      const result = db.updateSprint("sprint-goal", { goal: "New goal" });
      expect(result.goal).toBe("New goal");
    });

    it("updates updatedAt timestamp on any change", () => {
      const oldDate = "2020-01-01T00:00:00.000Z";
      db.insertSprint(createSprint({ id: "sprint-ts", updatedAt: oldDate }));

      const result = db.updateSprint("sprint-ts", { name: "Changed" });
      expect(result.updatedAt).not.toBe(oldDate);
    });

    it("returns null for non-existent sprint", () => {
      const result = db.updateSprint("nonexistent", { name: "Nope" });
      expect(result).toBeNull();
    });
  });

  describe("deleteSprint", () => {
    it("deletes a sprint", () => {
      db.insertSprint(createSprint({ id: "sprint-del" }));

      const deleted = db.deleteSprint("sprint-del");
      expect(deleted).toBe(true);

      const result = db.getSprint("sprint-del");
      expect(result).toBeNull();
    });

    it("returns false for non-existent sprint", () => {
      const deleted = db.deleteSprint("nonexistent");
      expect(deleted).toBe(false);
    });

    it("sets sprint_id to NULL on tasks when sprint is deleted (ON DELETE SET NULL)", () => {
      db.insertSprint(createSprint({ id: "sprint-cascade" }));
      const task = createTask({ id: "task-cascade" });

      // Assign task to sprint
      db.assignTaskToSprint("task-cascade", "sprint-cascade");

      // Verify task is in sprint
      let taskResult = db.getTask("task-cascade");
      expect(taskResult.sprintId).toBe("sprint-cascade");

      // Delete the sprint
      db.deleteSprint("sprint-cascade");

      // Task should revert to backlog (sprint_id = null)
      taskResult = db.getTask("task-cascade");
      expect(taskResult.sprintId).toBeNull();
    });
  });

  // ---------------------------------------------------------------------------
  // Sprint Lifecycle (Status Transitions)
  // ---------------------------------------------------------------------------

  describe("Sprint lifecycle transitions", () => {
    it("transitions from planning to active", () => {
      db.insertSprint(createSprint({ id: "sprint-start", status: "planning" }));

      const result = db.updateSprint("sprint-start", { status: "active" });
      expect(result.status).toBe("active");
      expect(result.startedAt).toBeTruthy();
    });

    it("sets startedAt when activating a sprint", () => {
      db.insertSprint(createSprint({ id: "sprint-activate" }));

      const before = new Date().toISOString();
      const result = db.updateSprint("sprint-activate", { status: "active" });
      const after = new Date().toISOString();

      expect(result.startedAt).toBeTruthy();
      expect(result.startedAt! >= before).toBe(true);
      expect(result.startedAt! <= after).toBe(true);
    });

    it("transitions from active to completed", () => {
      db.insertSprint(createSprint({ id: "sprint-complete", status: "active", startedAt: new Date().toISOString() }));

      const result = db.updateSprint("sprint-complete", { status: "completed" });
      expect(result.status).toBe("completed");
      expect(result.completedAt).toBeTruthy();
    });

    it("sets completedAt when completing a sprint", () => {
      db.insertSprint(createSprint({ id: "sprint-done", status: "active", startedAt: new Date().toISOString() }));

      const before = new Date().toISOString();
      const result = db.updateSprint("sprint-done", { status: "completed" });
      const after = new Date().toISOString();

      expect(result.completedAt).toBeTruthy();
      expect(result.completedAt! >= before).toBe(true);
      expect(result.completedAt! <= after).toBe(true);
    });

    it("rejects backward transition: completed -> active", () => {
      db.insertSprint(createSprint({
        id: "sprint-back",
        status: "completed",
        startedAt: new Date().toISOString(),
        completedAt: new Date().toISOString(),
      }));

      expect(() => db.updateSprint("sprint-back", { status: "active" })).toThrow();
    });

    it("rejects backward transition: completed -> planning", () => {
      db.insertSprint(createSprint({
        id: "sprint-back2",
        status: "completed",
        startedAt: new Date().toISOString(),
        completedAt: new Date().toISOString(),
      }));

      expect(() => db.updateSprint("sprint-back2", { status: "planning" })).toThrow();
    });

    it("rejects backward transition: active -> planning", () => {
      db.insertSprint(createSprint({
        id: "sprint-back3",
        status: "active",
        startedAt: new Date().toISOString(),
      }));

      expect(() => db.updateSprint("sprint-back3", { status: "planning" })).toThrow();
    });

    it("rejects invalid status values", () => {
      db.insertSprint(createSprint({ id: "sprint-invalid" }));

      expect(() => db.updateSprint("sprint-invalid", { status: "paused" })).toThrow();
    });
  });

  // ---------------------------------------------------------------------------
  // Sprint Invariants
  // ---------------------------------------------------------------------------

  describe("Sprint invariants", () => {
    it("enforces max 1 active sprint per session", () => {
      db.insertSprint(createSprint({ id: "sprint-active1", status: "active", startedAt: new Date().toISOString() }));
      db.insertSprint(createSprint({ id: "sprint-plan", status: "planning" }));

      // Trying to activate a second sprint should fail
      expect(() => db.updateSprint("sprint-plan", { status: "active" })).toThrow(/already.*active/i);
    });

    it("allows activating a sprint after the previous one is completed", () => {
      db.insertSprint(createSprint({
        id: "sprint-completed-prev",
        status: "completed",
        startedAt: new Date().toISOString(),
        completedAt: new Date().toISOString(),
      }));
      db.insertSprint(createSprint({ id: "sprint-new-active", status: "planning" }));

      // Should succeed since no active sprint exists
      const result = db.updateSprint("sprint-new-active", { status: "active" });
      expect(result.status).toBe("active");
    });

    it("allows multiple planning sprints in same session", () => {
      db.insertSprint(createSprint({ id: "plan-1", name: "Plan A" }));
      db.insertSprint(createSprint({ id: "plan-2", name: "Plan B" }));
      db.insertSprint(createSprint({ id: "plan-3", name: "Plan C" }));

      const sprints = db.getSprints(SESSION_ID);
      const planning = sprints.filter((s: any) => s.status === "planning");
      expect(planning).toHaveLength(3);
    });

    it("allows active sprints in different sessions", () => {
      db.insertSprint(createSprint({
        id: "active-s1",
        sessionId: "session-a",
        status: "active",
        startedAt: new Date().toISOString(),
      }));
      db.insertSprint(createSprint({
        id: "active-s2",
        sessionId: "session-b",
        status: "planning",
      }));

      // Activating in different session should succeed
      const result = db.updateSprint("active-s2", { status: "active" });
      expect(result.status).toBe("active");
    });

    it("enforces max 20 sprints per session", () => {
      // Create 20 sprints
      for (let i = 0; i < 20; i++) {
        db.insertSprint(createSprint({ id: `sprint-${i}`, name: `Sprint ${i}` }));
      }

      // 21st should fail
      expect(() => {
        db.insertSprint(createSprint({ id: "sprint-21", name: "Sprint 21" }));
      }).toThrow(/max.*20/i);
    });

    it("does not count sprints from other sessions toward the limit", () => {
      // Create 20 sprints in session-other
      for (let i = 0; i < 20; i++) {
        db.insertSprint(createSprint({ id: `other-${i}`, name: `Other ${i}`, sessionId: "session-other" }));
      }

      // Should still be able to create in the default session
      expect(() => {
        db.insertSprint(createSprint({ id: "mine-1" }));
      }).not.toThrow();
    });
  });

  // ---------------------------------------------------------------------------
  // Task-Sprint Relationships
  // ---------------------------------------------------------------------------

  describe("Task-Sprint relationships", () => {
    it("assigns a task to a sprint", () => {
      db.insertSprint(createSprint({ id: "sprint-assign" }));
      createTask({ id: "task-assign" });

      db.assignTaskToSprint("task-assign", "sprint-assign");

      const task = db.getTask("task-assign");
      expect(task.sprintId).toBe("sprint-assign");
    });

    it("removes a task from a sprint (back to backlog)", () => {
      db.insertSprint(createSprint({ id: "sprint-remove" }));
      createTask({ id: "task-remove" });
      db.assignTaskToSprint("task-remove", "sprint-remove");

      db.assignTaskToSprint("task-remove", null);

      const task = db.getTask("task-remove");
      expect(task.sprintId).toBeNull();
    });

    it("moves a task from one sprint to another", () => {
      db.insertSprint(createSprint({ id: "sprint-from" }));
      db.insertSprint(createSprint({ id: "sprint-to" }));
      createTask({ id: "task-move" });

      db.assignTaskToSprint("task-move", "sprint-from");
      expect(db.getTask("task-move").sprintId).toBe("sprint-from");

      db.assignTaskToSprint("task-move", "sprint-to");
      expect(db.getTask("task-move").sprintId).toBe("sprint-to");
    });

    it("bulk assigns tasks to a sprint", () => {
      db.insertSprint(createSprint({ id: "sprint-bulk" }));
      createTask({ id: "task-b1" });
      createTask({ id: "task-b2" });
      createTask({ id: "task-b3" });

      const count = db.assignTasksToSprint(["task-b1", "task-b2", "task-b3"], "sprint-bulk");
      expect(count).toBe(3);

      expect(db.getTask("task-b1").sprintId).toBe("sprint-bulk");
      expect(db.getTask("task-b2").sprintId).toBe("sprint-bulk");
      expect(db.getTask("task-b3").sprintId).toBe("sprint-bulk");
    });

    it("bulk removes tasks from a sprint", () => {
      db.insertSprint(createSprint({ id: "sprint-bulkrm" }));
      createTask({ id: "task-br1" });
      createTask({ id: "task-br2" });
      db.assignTasksToSprint(["task-br1", "task-br2"], "sprint-bulkrm");

      const count = db.removeTasksFromSprint(["task-br1", "task-br2"]);
      expect(count).toBe(2);

      expect(db.getTask("task-br1").sprintId).toBeNull();
      expect(db.getTask("task-br2").sprintId).toBeNull();
    });

    it("newly created tasks have null sprintId (backlog)", () => {
      const task = createTask({ id: "task-backlog" });
      const result = db.getTask("task-backlog");
      expect(result.sprintId).toBeNull();
    });

    it("getFilteredTasks supports sprint filter for current sprint", () => {
      db.insertSprint(createSprint({ id: "sprint-filter", status: "active", startedAt: new Date().toISOString() }));
      createTask({ id: "task-in-sprint" });
      createTask({ id: "task-in-backlog" });
      db.assignTaskToSprint("task-in-sprint", "sprint-filter");

      const sprintTasks = db.getFilteredTasks(SESSION_ID, { sprint: "current" });
      expect(sprintTasks).toHaveLength(1);
      expect(sprintTasks[0].id).toBe("task-in-sprint");
    });

    it("getFilteredTasks supports sprint filter for backlog", () => {
      db.insertSprint(createSprint({ id: "sprint-backlog-filter" }));
      createTask({ id: "task-in-sprint2" });
      createTask({ id: "task-backlog2" });
      db.assignTaskToSprint("task-in-sprint2", "sprint-backlog-filter");

      const backlogTasks = db.getFilteredTasks(SESSION_ID, { sprint: "backlog" });
      expect(backlogTasks).toHaveLength(1);
      expect(backlogTasks[0].id).toBe("task-backlog2");
    });

    it("getFilteredTasks supports sprint filter by ID", () => {
      db.insertSprint(createSprint({ id: "sprint-id-filter" }));
      db.insertSprint(createSprint({ id: "sprint-id-other" }));
      createTask({ id: "task-specific" });
      createTask({ id: "task-other-sprint" });
      db.assignTaskToSprint("task-specific", "sprint-id-filter");
      db.assignTaskToSprint("task-other-sprint", "sprint-id-other");

      const tasks = db.getFilteredTasks(SESSION_ID, { sprint: "sprint-id-filter" });
      expect(tasks).toHaveLength(1);
      expect(tasks[0].id).toBe("task-specific");
    });

    it("getFilteredTasks returns all tasks when no sprint filter", () => {
      db.insertSprint(createSprint({ id: "sprint-no-filter" }));
      createTask({ id: "task-nf1" });
      createTask({ id: "task-nf2" });
      db.assignTaskToSprint("task-nf1", "sprint-no-filter");

      const allTasks = db.getFilteredTasks(SESSION_ID);
      expect(allTasks).toHaveLength(2);
    });
  });

  // ---------------------------------------------------------------------------
  // Sprint Completion with Task Rollover
  // ---------------------------------------------------------------------------

  describe("Sprint completion with task handling", () => {
    it("completeSprint moves unfinished tasks to backlog", () => {
      db.insertSprint(createSprint({
        id: "sprint-complete-bl",
        status: "active",
        startedAt: new Date().toISOString(),
      }));
      createTask({ id: "task-done", status: "done" });
      createTask({ id: "task-pending", status: "pending" });
      createTask({ id: "task-inprog", status: "in-progress" });
      db.assignTasksToSprint(["task-done", "task-pending", "task-inprog"], "sprint-complete-bl");

      const result = db.completeSprint("sprint-complete-bl", {
        unfinishedAction: "backlog",
      });

      expect(result.completed).toBe(1);
      expect(result.movedToBacklog).toBe(2);
      expect(result.rolledOver).toBe(0);

      // Done task stays in sprint, unfinished go to backlog
      expect(db.getTask("task-done").sprintId).toBe("sprint-complete-bl");
      expect(db.getTask("task-pending").sprintId).toBeNull();
      expect(db.getTask("task-inprog").sprintId).toBeNull();

      // Sprint is now completed
      const sprint = db.getSprint("sprint-complete-bl");
      expect(sprint.status).toBe("completed");
      expect(sprint.completedAt).toBeTruthy();
    });

    it("completeSprint rolls over unfinished tasks to next sprint", () => {
      db.insertSprint(createSprint({
        id: "sprint-rollover-from",
        status: "active",
        startedAt: new Date().toISOString(),
      }));
      db.insertSprint(createSprint({
        id: "sprint-rollover-to",
        status: "planning",
      }));
      createTask({ id: "task-r-done", status: "done" });
      createTask({ id: "task-r-pending", status: "pending" });
      db.assignTasksToSprint(["task-r-done", "task-r-pending"], "sprint-rollover-from");

      const result = db.completeSprint("sprint-rollover-from", {
        unfinishedAction: "rollover",
        nextSprintId: "sprint-rollover-to",
      });

      expect(result.completed).toBe(1);
      expect(result.rolledOver).toBe(1);
      expect(result.movedToBacklog).toBe(0);

      // Unfinished task moved to next sprint
      expect(db.getTask("task-r-pending").sprintId).toBe("sprint-rollover-to");
      // Done task stays in original sprint
      expect(db.getTask("task-r-done").sprintId).toBe("sprint-rollover-from");
    });

    it("completeSprint throws when rolling over without nextSprintId", () => {
      db.insertSprint(createSprint({
        id: "sprint-no-next",
        status: "active",
        startedAt: new Date().toISOString(),
      }));
      createTask({ id: "task-no-next" });
      db.assignTaskToSprint("task-no-next", "sprint-no-next");

      expect(() => db.completeSprint("sprint-no-next", {
        unfinishedAction: "rollover",
      })).toThrow(/nextSprintId/i);
    });

    it("completeSprint on sprint with no tasks succeeds", () => {
      db.insertSprint(createSprint({
        id: "sprint-empty",
        status: "active",
        startedAt: new Date().toISOString(),
      }));

      const result = db.completeSprint("sprint-empty", {
        unfinishedAction: "backlog",
      });

      expect(result.completed).toBe(0);
      expect(result.movedToBacklog).toBe(0);
      expect(result.rolledOver).toBe(0);

      const sprint = db.getSprint("sprint-empty");
      expect(sprint.status).toBe("completed");
    });

    it("completeSprint on all-done tasks reports correct count", () => {
      db.insertSprint(createSprint({
        id: "sprint-all-done",
        status: "active",
        startedAt: new Date().toISOString(),
      }));
      createTask({ id: "task-d1", status: "done" });
      createTask({ id: "task-d2", status: "done" });
      db.assignTasksToSprint(["task-d1", "task-d2"], "sprint-all-done");

      const result = db.completeSprint("sprint-all-done", {
        unfinishedAction: "backlog",
      });

      expect(result.completed).toBe(2);
      expect(result.movedToBacklog).toBe(0);
    });

    it("completeSprint throws on non-active sprint", () => {
      db.insertSprint(createSprint({ id: "sprint-plan-complete", status: "planning" }));

      expect(() => db.completeSprint("sprint-plan-complete", {
        unfinishedAction: "backlog",
      })).toThrow();
    });
  });

  // ---------------------------------------------------------------------------
  // Sprint with Task Counts (Computed Fields)
  // ---------------------------------------------------------------------------

  describe("Sprint with task counts", () => {
    it("getSprint includes task counts", () => {
      db.insertSprint(createSprint({ id: "sprint-counts" }));
      createTask({ id: "tc-1", status: "pending" });
      createTask({ id: "tc-2", status: "in-progress" });
      createTask({ id: "tc-3", status: "done" });
      db.assignTasksToSprint(["tc-1", "tc-2", "tc-3"], "sprint-counts");

      const sprint = db.getSprintWithCounts("sprint-counts");
      expect(sprint.taskCount).toBe(3);
      expect(sprint.completedCount).toBe(1);
      expect(sprint.activeCount).toBe(1); // in-progress
    });

    it("getSprints includes task counts per sprint", () => {
      db.insertSprint(createSprint({ id: "s-c1", name: "Sprint A" }));
      db.insertSprint(createSprint({ id: "s-c2", name: "Sprint B" }));
      createTask({ id: "tc-a1", status: "done" });
      createTask({ id: "tc-b1", status: "pending" });
      createTask({ id: "tc-b2", status: "pending" });
      db.assignTaskToSprint("tc-a1", "s-c1");
      db.assignTasksToSprint(["tc-b1", "tc-b2"], "s-c2");

      const sprints = db.getSprintsWithCounts(SESSION_ID);
      const sprintA = sprints.find((s: any) => s.name === "Sprint A");
      const sprintB = sprints.find((s: any) => s.name === "Sprint B");

      expect(sprintA.taskCount).toBe(1);
      expect(sprintA.completedCount).toBe(1);
      expect(sprintB.taskCount).toBe(2);
      expect(sprintB.completedCount).toBe(0);
    });
  });

  // ---------------------------------------------------------------------------
  // Backward Compatibility
  // ---------------------------------------------------------------------------

  describe("Backward compatibility", () => {
    it("existing tasks work without sprint_id", () => {
      // Tasks created before sprint migration should still work
      createTask({ id: "old-task" });

      const task = db.getTask("old-task");
      expect(task).not.toBeNull();
      expect(task.sprintId).toBeNull();
    });

    it("getFilteredTasks returns all tasks when sprint filter absent", () => {
      createTask({ id: "compat-1" });
      createTask({ id: "compat-2" });

      // No sprint filter = all tasks (backward compatible)
      const tasks = db.getFilteredTasks(SESSION_ID);
      expect(tasks.length).toBeGreaterThanOrEqual(2);
    });

    it("updateTask preserves sprint_id when not explicitly changed", () => {
      db.insertSprint(createSprint({ id: "sprint-preserve" }));
      createTask({ id: "task-preserve" });
      db.assignTaskToSprint("task-preserve", "sprint-preserve");

      // Update the task's title (not sprint)
      db.updateTask("task-preserve", { title: "Updated" });

      const task = db.getTask("task-preserve");
      expect(task.sprintId).toBe("sprint-preserve");
      expect(task.title).toBe("Updated");
    });

    it("task sprintName is populated when sprint exists", () => {
      db.insertSprint(createSprint({ id: "sprint-name-check", name: "Auth Sprint" }));
      createTask({ id: "task-with-name" });
      db.assignTaskToSprint("task-with-name", "sprint-name-check");

      const task = db.getTask("task-with-name");
      expect(task.sprintName).toBe("Auth Sprint");
    });

    it("task sprintName is null when no sprint assigned", () => {
      createTask({ id: "task-no-sprint-name" });

      const task = db.getTask("task-no-sprint-name");
      expect(task.sprintName).toBeUndefined();
    });
  });

  // ---------------------------------------------------------------------------
  // Active Sprint Helper
  // ---------------------------------------------------------------------------

  describe("getActiveSprint", () => {
    it("returns the active sprint for a session", () => {
      db.insertSprint(createSprint({ id: "s-active", status: "active", startedAt: new Date().toISOString() }));
      db.insertSprint(createSprint({ id: "s-plan", status: "planning" }));

      const active = db.getActiveSprint(SESSION_ID);
      expect(active).not.toBeNull();
      expect(active.id).toBe("s-active");
    });

    it("returns null when no active sprint exists", () => {
      db.insertSprint(createSprint({ id: "s-plan-only", status: "planning" }));

      const active = db.getActiveSprint(SESSION_ID);
      expect(active).toBeNull();
    });

    it("returns null for session with no sprints", () => {
      const active = db.getActiveSprint("no-sprints");
      expect(active).toBeNull();
    });
  });
});
