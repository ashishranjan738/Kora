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

function createTask(overrides: Partial<{
  id: string;
  sessionId: string;
  title: string;
  description: string;
  status: string;
  assignedTo: string;
  createdBy: string;
  dependencies: string[];
  priority: string;
}> = {}) {
  const task = {
    id: overrides.id || "task-1",
    sessionId: overrides.sessionId || "session-1",
    title: overrides.title || "Test task",
    description: overrides.description || "Test description",
    status: overrides.status || "pending",
    assignedTo: overrides.assignedTo || undefined,
    createdBy: overrides.createdBy || "user",
    dependencies: overrides.dependencies || [],
    priority: overrides.priority || "P2",
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
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "kora-task-improvements-"));
  db = new AppDatabase(tmpDir);
});

afterEach(() => {
  try { db.close(); } catch {}
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// Tests — Priority column
// ---------------------------------------------------------------------------

describe("Task priority", () => {
  it("inserts task with default priority P2", () => {
    createTask({ id: "t1" });
    const task = db.getTask("t1");
    expect(task).not.toBeNull();
    expect(task.priority).toBe("P2");
  });

  it("inserts task with explicit priority P0", () => {
    createTask({ id: "t2", priority: "P0" });
    const task = db.getTask("t2");
    expect(task.priority).toBe("P0");
  });

  it("inserts task with explicit priority P3", () => {
    createTask({ id: "t3", priority: "P3" });
    const task = db.getTask("t3");
    expect(task.priority).toBe("P3");
  });

  it("updates priority via updateTask", () => {
    createTask({ id: "t4", priority: "P2" });
    const updated = db.updateTask("t4", { priority: "P0" });
    expect(updated).not.toBeNull();
    expect(updated.priority).toBe("P0");
  });

  it("preserves priority when updating other fields", () => {
    createTask({ id: "t5", priority: "P1" });
    const updated = db.updateTask("t5", { title: "New title" });
    expect(updated.priority).toBe("P1");
  });

  it("getTasks includes priority in response", () => {
    createTask({ id: "t6", priority: "P0" });
    createTask({ id: "t7", priority: "P3" });
    const tasks = db.getTasks("session-1");
    expect(tasks).toHaveLength(2);
    const priorities = tasks.map((t: any) => t.priority).sort();
    expect(priorities).toEqual(["P0", "P3"]);
  });
});

// ---------------------------------------------------------------------------
// Tests — getFilteredTasks
// ---------------------------------------------------------------------------

describe("getFilteredTasks", () => {
  beforeEach(() => {
    createTask({ id: "t1", assignedTo: "agent-a", status: "pending", priority: "P0" });
    createTask({ id: "t2", assignedTo: "agent-a", status: "in-progress", priority: "P1" });
    createTask({ id: "t3", assignedTo: "agent-b", status: "pending", priority: "P2" });
    createTask({ id: "t4", assignedTo: "agent-b", status: "done", priority: "P2" });
    createTask({ id: "t5", status: "review", priority: "P3" }); // unassigned
  });

  it("filters by assignedTo", () => {
    const tasks = db.getFilteredTasks("session-1", { assignedTo: "agent-a" });
    expect(tasks).toHaveLength(2);
    expect(tasks.every((t: any) => t.assignedTo === "agent-a")).toBe(true);
  });

  it("filters by status", () => {
    const tasks = db.getFilteredTasks("session-1", { status: "pending" });
    expect(tasks).toHaveLength(2);
    expect(tasks.every((t: any) => t.status === "pending")).toBe(true);
  });

  it("filters by status=active (pending+in-progress+review)", () => {
    const tasks = db.getFilteredTasks("session-1", { status: "active" });
    expect(tasks).toHaveLength(4); // t1, t2, t3, t5 (not t4 which is done)
    expect(tasks.every((t: any) => ["pending", "in-progress", "review"].includes(t.status))).toBe(true);
  });

  it("filters by priority", () => {
    const tasks = db.getFilteredTasks("session-1", { priority: "P0" });
    expect(tasks).toHaveLength(1);
    expect(tasks[0].id).toBe("t1");
  });

  it("combines assignedTo and status filters", () => {
    const tasks = db.getFilteredTasks("session-1", { assignedTo: "agent-b", status: "done" });
    expect(tasks).toHaveLength(1);
    expect(tasks[0].id).toBe("t4");
  });

  it("returns summary mode by default (no description, comments, dependencies)", () => {
    const tasks = db.getFilteredTasks("session-1", { summary: true });
    expect(tasks.length).toBeGreaterThan(0);
    const task = tasks[0];
    expect(task.id).toBeDefined();
    expect(task.title).toBeDefined();
    expect(task.status).toBeDefined();
    expect(task.assignedTo).toBeDefined();
    expect(task.priority).toBeDefined();
    expect(task.labels).toBeDefined();
    // dueDate is present but may be null
    expect("dueDate" in task).toBe(true);
    // Summary mode should NOT include these
    expect(task.description).toBeUndefined();
    expect(task.comments).toBeUndefined();
    expect(task.dependencies).toBeUndefined();
    expect(task.createdBy).toBeUndefined();
  });

  it("returns full details when summary=false", () => {
    const tasks = db.getFilteredTasks("session-1", { summary: false });
    expect(tasks.length).toBeGreaterThan(0);
    const task = tasks[0];
    expect(task.description).toBeDefined();
    expect(task.comments).toBeDefined();
    expect(task.dependencies).toBeDefined();
    expect(task.createdBy).toBeDefined();
  });

  it("returns all tasks when no filters", () => {
    const tasks = db.getFilteredTasks("session-1", {});
    // default summary=true, no assignedTo/status/priority filters
    expect(tasks).toHaveLength(5);
  });

  it("returns empty array when no tasks match filter", () => {
    const tasks = db.getFilteredTasks("session-1", { assignedTo: "nonexistent" });
    expect(tasks).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// Tests — update_task editing (extended fields)
// ---------------------------------------------------------------------------

describe("updateTask with priority", () => {
  it("updates priority alone", () => {
    createTask({ id: "t1", priority: "P2" });
    const updated = db.updateTask("t1", { priority: "P0" });
    expect(updated.priority).toBe("P0");
    expect(updated.title).toBe("Test task"); // unchanged
  });

  it("updates priority alongside status", () => {
    createTask({ id: "t1", priority: "P2", status: "pending" });
    const updated = db.updateTask("t1", { priority: "P1", status: "in-progress" });
    expect(updated.priority).toBe("P1");
    expect(updated.status).toBe("in-progress");
  });

  it("updates all editable fields at once", () => {
    createTask({ id: "t1" });
    const updated = db.updateTask("t1", {
      title: "New title",
      description: "New desc",
      status: "review",
      assignedTo: "agent-c",
      priority: "P0",
    });
    expect(updated.title).toBe("New title");
    expect(updated.description).toBe("New desc");
    expect(updated.status).toBe("review");
    expect(updated.assignedTo).toBe("agent-c");
    expect(updated.priority).toBe("P0");
  });

  it("preserves immutable fields (id, sessionId, createdBy, createdAt)", () => {
    const original = createTask({ id: "t1", sessionId: "session-1" });
    const updated = db.updateTask("t1", { title: "Changed" });
    expect(updated.id).toBe("t1");
    expect(updated.sessionId).toBe("session-1");
    expect(updated.createdBy).toBe("user");
    expect(updated.createdAt).toBe(original.createdAt);
  });
});

// ---------------------------------------------------------------------------
// Tests — Labels
// ---------------------------------------------------------------------------

describe("Task labels", () => {
  it("inserts task with empty labels by default", () => {
    createTask({ id: "t1" });
    const task = db.getTask("t1");
    expect(task.labels).toEqual([]);
  });

  it("inserts task with custom labels", () => {
    db.insertTask({
      id: "t-labels",
      sessionId: "session-1",
      title: "Labeled task",
      description: "",
      status: "pending",
      createdBy: "user",
      labels: ["bug", "frontend"],
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    });
    const task = db.getTask("t-labels");
    expect(task.labels).toEqual(["bug", "frontend"]);
  });

  it("updates labels via updateTask", () => {
    createTask({ id: "t1" });
    const updated = db.updateTask("t1", { labels: ["urgent", "backend"] });
    expect(updated.labels).toEqual(["urgent", "backend"]);
  });

  it("clears labels by setting to empty array", () => {
    db.insertTask({
      id: "t-clear",
      sessionId: "session-1",
      title: "Clear labels",
      description: "",
      status: "pending",
      createdBy: "user",
      labels: ["old-label"],
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    });
    const updated = db.updateTask("t-clear", { labels: [] });
    expect(updated.labels).toEqual([]);
  });

  it("filters tasks by label", () => {
    db.insertTask({
      id: "t-bug", sessionId: "session-1", title: "Bug fix", description: "",
      status: "pending", createdBy: "user", labels: ["bug", "frontend"],
      createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(),
    });
    db.insertTask({
      id: "t-feat", sessionId: "session-1", title: "New feature", description: "",
      status: "pending", createdBy: "user", labels: ["feature"],
      createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(),
    });
    db.insertTask({
      id: "t-both", sessionId: "session-1", title: "Bug feature", description: "",
      status: "pending", createdBy: "user", labels: ["bug", "feature"],
      createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(),
    });

    const bugTasks = db.getFilteredTasks("session-1", { label: "bug" });
    expect(bugTasks).toHaveLength(2);
    expect(bugTasks.map((t: any) => t.id).sort()).toEqual(["t-both", "t-bug"]);

    const featureTasks = db.getFilteredTasks("session-1", { label: "feature" });
    expect(featureTasks).toHaveLength(2);
  });
});

// ---------------------------------------------------------------------------
// Tests — Due Date
// ---------------------------------------------------------------------------

describe("Task due date", () => {
  it("inserts task with no due date by default", () => {
    createTask({ id: "t1" });
    const task = db.getTask("t1");
    expect(task.dueDate).toBeNull();
  });

  it("inserts task with due date", () => {
    db.insertTask({
      id: "t-due", sessionId: "session-1", title: "Due task", description: "",
      status: "pending", createdBy: "user", dueDate: "2026-04-01",
      createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(),
    });
    const task = db.getTask("t-due");
    expect(task.dueDate).toBe("2026-04-01");
  });

  it("updates due date via updateTask", () => {
    createTask({ id: "t1" });
    const updated = db.updateTask("t1", { dueDate: "2026-05-15" });
    expect(updated.dueDate).toBe("2026-05-15");
  });

  it("clears due date by setting to null", () => {
    db.insertTask({
      id: "t-clear-due", sessionId: "session-1", title: "Clear due", description: "",
      status: "pending", createdBy: "user", dueDate: "2026-04-01",
      createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(),
    });
    const updated = db.updateTask("t-clear-due", { dueDate: null });
    expect(updated.dueDate).toBeNull();
  });

  it("filters by due=today", () => {
    const today = new Date().toISOString().split("T")[0];
    const tomorrow = new Date(Date.now() + 86400000).toISOString().split("T")[0];

    db.insertTask({
      id: "t-today", sessionId: "session-1", title: "Due today", description: "",
      status: "pending", createdBy: "user", dueDate: today,
      createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(),
    });
    db.insertTask({
      id: "t-tomorrow", sessionId: "session-1", title: "Due tomorrow", description: "",
      status: "pending", createdBy: "user", dueDate: tomorrow,
      createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(),
    });

    const todayTasks = db.getFilteredTasks("session-1", { due: "today" });
    expect(todayTasks).toHaveLength(1);
    expect(todayTasks[0].id).toBe("t-today");
  });

  it("filters by due=overdue", () => {
    const yesterday = new Date(Date.now() - 86400000).toISOString().split("T")[0];
    const tomorrow = new Date(Date.now() + 86400000).toISOString().split("T")[0];

    db.insertTask({
      id: "t-overdue", sessionId: "session-1", title: "Overdue", description: "",
      status: "pending", createdBy: "user", dueDate: yesterday,
      createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(),
    });
    db.insertTask({
      id: "t-future", sessionId: "session-1", title: "Future", description: "",
      status: "pending", createdBy: "user", dueDate: tomorrow,
      createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(),
    });

    const overdue = db.getFilteredTasks("session-1", { due: "overdue" });
    expect(overdue).toHaveLength(1);
    expect(overdue[0].id).toBe("t-overdue");
  });

  it("sorts by due date (nulls last)", () => {
    db.insertTask({
      id: "t-no-due", sessionId: "session-1", title: "No due", description: "",
      status: "pending", createdBy: "user",
      createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(),
    });
    db.insertTask({
      id: "t-later", sessionId: "session-1", title: "Later", description: "",
      status: "pending", createdBy: "user", dueDate: "2026-06-01",
      createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(),
    });
    db.insertTask({
      id: "t-sooner", sessionId: "session-1", title: "Sooner", description: "",
      status: "pending", createdBy: "user", dueDate: "2026-04-01",
      createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(),
    });

    const tasks = db.getFilteredTasks("session-1", { sortBy: "due" });
    expect(tasks[0].id).toBe("t-sooner");
    expect(tasks[1].id).toBe("t-later");
    expect(tasks[2].id).toBe("t-no-due"); // null last
  });

  it("sorts by priority (P0 first)", () => {
    createTask({ id: "t-p2", priority: "P2" });
    createTask({ id: "t-p0", priority: "P0" });
    createTask({ id: "t-p3", priority: "P3" });

    const tasks = db.getFilteredTasks("session-1", { sortBy: "priority" });
    expect(tasks[0].id).toBe("t-p0");
    expect(tasks[1].id).toBe("t-p2");
    expect(tasks[2].id).toBe("t-p3");
  });
});

// ---------------------------------------------------------------------------
// Tests — DB Migration (all columns)
// ---------------------------------------------------------------------------

describe("DB migration — schema version", () => {
  it("schema version is 6", () => {
    const version = db.db.pragma("user_version", { simple: true }) as number;
    expect(version).toBe(6);
  });

  it("priority column exists with default P2", () => {
    db.db.prepare(
      `INSERT INTO tasks (id, session_id, title, description, status, created_by, dependencies, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
    ).run("raw-1", "session-1", "Raw task", "", "pending", "user", "[]", new Date().toISOString(), new Date().toISOString());

    const task = db.getTask("raw-1");
    expect(task).not.toBeNull();
    expect(task.priority).toBe("P2");
  });

  it("labels column exists with default empty array", () => {
    db.db.prepare(
      `INSERT INTO tasks (id, session_id, title, description, status, created_by, dependencies, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
    ).run("raw-2", "session-1", "Raw task 2", "", "pending", "user", "[]", new Date().toISOString(), new Date().toISOString());

    const task = db.getTask("raw-2");
    expect(task.labels).toEqual([]);
  });

  it("due_date column exists and defaults to null", () => {
    db.db.prepare(
      `INSERT INTO tasks (id, session_id, title, description, status, created_by, dependencies, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
    ).run("raw-3", "session-1", "Raw task 3", "", "pending", "user", "[]", new Date().toISOString(), new Date().toISOString());

    const task = db.getTask("raw-3");
    expect(task.dueDate).toBeNull();
  });
});
