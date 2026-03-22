/**
 * Tests for task state transition history.
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { AppDatabase } from "../database.js";
import fs from "fs";
import path from "path";
import os from "os";

describe("Task State Transitions", () => {
  let db: AppDatabase;
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "kora-test-"));
    db = new AppDatabase(tmpDir);
  });

  afterEach(() => {
    db.close();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it("records a transition on task status change", () => {
    const now = new Date().toISOString();
    db.insertTask({
      id: "t1", sessionId: "s1", title: "Test Task", description: "",
      status: "pending", createdBy: "user", createdAt: now, updatedAt: now,
    });

    db.updateTask("t1", { status: "in-progress" });

    const transitions = db.getTransitions("t1");
    expect(transitions).toHaveLength(1);
    expect(transitions[0].fromStatus).toBe("pending");
    expect(transitions[0].toStatus).toBe("in-progress");
  });

  it("records multiple transitions", () => {
    const now = new Date().toISOString();
    db.insertTask({
      id: "t2", sessionId: "s1", title: "Multi", description: "",
      status: "pending", createdBy: "user", createdAt: now, updatedAt: now,
    });

    db.updateTask("t2", { status: "in-progress" });
    db.updateTask("t2", { status: "review" });
    db.updateTask("t2", { status: "done" });

    const transitions = db.getTransitions("t2");
    expect(transitions).toHaveLength(3);
    expect(transitions[0].toStatus).toBe("in-progress");
    expect(transitions[1].toStatus).toBe("review");
    expect(transitions[2].toStatus).toBe("done");
  });

  it("does not record transition when status unchanged", () => {
    const now = new Date().toISOString();
    db.insertTask({
      id: "t3", sessionId: "s1", title: "No Change", description: "",
      status: "pending", createdBy: "user", createdAt: now, updatedAt: now,
    });

    db.updateTask("t3", { title: "Updated Title" }); // No status change

    const transitions = db.getTransitions("t3");
    expect(transitions).toHaveLength(0);
  });

  it("getStatusDurations computes time in each status", () => {
    const now = new Date().toISOString();
    db.insertTask({
      id: "t4", sessionId: "s1", title: "Duration", description: "",
      status: "pending", createdBy: "user", createdAt: now, updatedAt: now,
    });
    db.insertTransition({
      id: "tr1", taskId: "t4", sessionId: "s1",
      fromStatus: null, toStatus: "pending",
      changedAt: new Date(Date.now() - 60000).toISOString(), // 1 min ago
    });
    db.insertTransition({
      id: "tr2", taskId: "t4", sessionId: "s1",
      fromStatus: "pending", toStatus: "in-progress",
      changedAt: new Date(Date.now() - 30000).toISOString(), // 30s ago
    });

    const durations = db.getStatusDurations("t4");
    expect(durations["pending"]).toBeGreaterThan(25000);
    expect(durations["pending"]).toBeLessThan(35000);
    expect(durations["in-progress"]).toBeGreaterThan(25000);
  });

  it("cascade deletes transitions when task is deleted", () => {
    const now = new Date().toISOString();
    db.insertTask({
      id: "t5", sessionId: "s1", title: "Delete Me", description: "",
      status: "pending", createdBy: "user", createdAt: now, updatedAt: now,
    });
    db.updateTask("t5", { status: "in-progress" });

    expect(db.getTransitions("t5")).toHaveLength(1);

    db.deleteTask("t5");
    expect(db.getTransitions("t5")).toHaveLength(0);
  });
});
