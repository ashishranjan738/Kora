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
}> = {}) {
  const task = {
    id: overrides.id || "task-1",
    sessionId: overrides.sessionId || "session-1",
    title: overrides.title || "Original title",
    description: overrides.description || "Original description",
    status: overrides.status || "pending",
    assignedTo: overrides.assignedTo || "Backend",
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
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "kora-test-"));
  db = new AppDatabase(tmpDir);
});

afterEach(() => {
  try { db.close(); } catch {}
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// Tests — Task update (edit) functionality
// ---------------------------------------------------------------------------

describe("Task update (edit)", () => {
  it("updates title while leaving other fields unchanged", () => {
    createTask();

    const updated = db.updateTask("task-1", { title: "Updated title" });

    expect(updated).not.toBeNull();
    expect(updated.title).toBe("Updated title");
    expect(updated.description).toBe("Original description");
    expect(updated.status).toBe("pending");
    expect(updated.assignedTo).toBe("Backend");
  });

  it("updates description while leaving other fields unchanged", () => {
    createTask();

    const updated = db.updateTask("task-1", { description: "New description" });

    expect(updated).not.toBeNull();
    expect(updated.description).toBe("New description");
    expect(updated.title).toBe("Original title");
    expect(updated.status).toBe("pending");
  });

  it("updates assignedTo while leaving other fields unchanged", () => {
    createTask();

    const updated = db.updateTask("task-1", { assignedTo: "Frontend" });

    expect(updated).not.toBeNull();
    expect(updated.assignedTo).toBe("Frontend");
    expect(updated.title).toBe("Original title");
    expect(updated.status).toBe("pending");
  });

  it("updates status to done", () => {
    createTask();

    const updated = db.updateTask("task-1", { status: "done" });

    expect(updated).not.toBeNull();
    expect(updated.status).toBe("done");
    expect(updated.title).toBe("Original title");
  });

  it("updates multiple fields at once", () => {
    createTask();

    const updated = db.updateTask("task-1", {
      title: "New title",
      description: "New desc",
      status: "in-progress",
      assignedTo: "Tests",
    });

    expect(updated).not.toBeNull();
    expect(updated.title).toBe("New title");
    expect(updated.description).toBe("New desc");
    expect(updated.status).toBe("in-progress");
    expect(updated.assignedTo).toBe("Tests");
  });

  it("updates the updatedAt timestamp", () => {
    const pastDate = "2020-01-01T00:00:00.000Z";
    db.insertTask({
      id: "task-ts",
      sessionId: "session-1",
      title: "Timestamp test",
      description: "",
      status: "pending",
      createdBy: "user",
      dependencies: [],
      createdAt: pastDate,
      updatedAt: pastDate,
    });

    const updated = db.updateTask("task-ts", { title: "Changed" });

    expect(updated).not.toBeNull();
    expect(updated.updatedAt).not.toBe(pastDate);
    expect(new Date(updated.updatedAt).getTime()).toBeGreaterThan(
      new Date(pastDate).getTime()
    );
  });

  it("returns null for non-existent task", () => {
    const result = db.updateTask("nonexistent-id", { title: "Nope" });

    expect(result).toBeNull();
  });

  it("preserves existing comments after update", () => {
    createTask();

    db.addTaskComment({
      id: "comment-1",
      taskId: "task-1",
      text: "A comment",
      author: "user",
      authorName: "User",
      createdAt: new Date().toISOString(),
    });

    const updated = db.updateTask("task-1", { title: "New title" });

    expect(updated).not.toBeNull();
    expect(updated.comments).toHaveLength(1);
    expect(updated.comments[0].text).toBe("A comment");
  });

  it("clears assignedTo when set to empty string", () => {
    createTask({ assignedTo: "Backend" });

    const updated = db.updateTask("task-1", { assignedTo: "" });

    expect(updated).not.toBeNull();
    expect(updated.assignedTo).toBeNull();
  });

  it("preserves dependencies after update", () => {
    createTask({ dependencies: ["dep-1", "dep-2"] });

    const updated = db.updateTask("task-1", { status: "in-progress" });

    expect(updated).not.toBeNull();
    expect(updated.dependencies).toEqual(["dep-1", "dep-2"]);
  });

  it("getTask returns updated values after updateTask", () => {
    createTask();

    db.updateTask("task-1", { title: "Fetched title", status: "review" });

    const fetched = db.getTask("task-1");
    expect(fetched).not.toBeNull();
    expect(fetched.title).toBe("Fetched title");
    expect(fetched.status).toBe("review");
  });
});
