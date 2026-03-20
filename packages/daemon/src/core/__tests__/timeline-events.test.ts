import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { AppDatabase } from "../database.js";
import os from "os";
import fs from "fs";
import path from "path";

let db: AppDatabase;
let tmpDir: string;

function insertEvent(overrides: Partial<{
  id: string; sessionId: string; type: string;
  data: Record<string, unknown>; timestamp: string; agentId: string;
}> = {}) {
  const event = {
    id: overrides.id || `evt-${Math.random().toString(36).slice(2, 10)}`,
    sessionId: overrides.sessionId || "session-1",
    type: overrides.type || "agent-spawned",
    data: overrides.data || {},
    timestamp: overrides.timestamp || new Date().toISOString(),
    agentId: overrides.agentId || undefined,
  };
  db.insertEvent(event);
  return event;
}

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "kora-timeline-"));
  db = new AppDatabase(tmpDir);
});

afterEach(() => {
  try { db.close(); } catch {}
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

describe("DB migration — events agent_id column", () => {
  it("schema version is 7", () => {
    const version = db.db.pragma("user_version", { simple: true }) as number;
    expect(version).toBe(7);
  });

  it("agent_id column exists on events table", () => {
    const columns = db.db.prepare("PRAGMA table_info(events)").all() as any[];
    const agentIdCol = columns.find((c: any) => c.name === "agent_id");
    expect(agentIdCol).toBeDefined();
  });
});

describe("insertEvent with agentId", () => {
  it("inserts event with agentId", () => {
    insertEvent({ id: "e1", agentId: "agent-a" });
    const events = db.queryEvents({ sessionId: "session-1" });
    expect(events).toHaveLength(1);
    expect(events[0].agentId).toBe("agent-a");
  });

  it("inserts event without agentId (null)", () => {
    insertEvent({ id: "e2" });
    const events = db.queryEvents({ sessionId: "session-1" });
    expect(events).toHaveLength(1);
    expect(events[0].agentId).toBeUndefined();
  });
});

describe("queryEvents filtering", () => {
  beforeEach(() => {
    insertEvent({ id: "e1", type: "agent-spawned", agentId: "agent-a", timestamp: "2026-03-19T10:00:00Z", data: { agentId: "agent-a", name: "Worker-A" } });
    insertEvent({ id: "e2", type: "message-sent", agentId: "agent-a", timestamp: "2026-03-19T10:01:00Z", data: { from: "agent-a", content: "hello world" } });
    insertEvent({ id: "e3", type: "agent-spawned", agentId: "agent-b", timestamp: "2026-03-19T10:02:00Z", data: { agentId: "agent-b", name: "Worker-B" } });
    insertEvent({ id: "e4", type: "task-created", timestamp: "2026-03-19T10:03:00Z", data: { title: "Setup DB" } });
    insertEvent({ id: "e5", type: "agent-crashed", agentId: "agent-a", timestamp: "2026-03-19T10:04:00Z", data: { agentId: "agent-a", reason: "OOM" } });
  });

  it("filters by type", () => {
    const events = db.queryEvents({ sessionId: "session-1", type: "agent-spawned" });
    expect(events).toHaveLength(2);
  });

  it("filters by multiple types (types array)", () => {
    const events = db.queryEvents({ sessionId: "session-1", types: ["agent-spawned", "agent-crashed"] });
    expect(events).toHaveLength(3);
  });

  it("filters by agentId", () => {
    const events = db.queryEvents({ sessionId: "session-1", agentId: "agent-a" });
    expect(events).toHaveLength(3);
  });

  it("filters by since", () => {
    const events = db.queryEvents({ sessionId: "session-1", since: "2026-03-19T10:02:00Z" });
    expect(events).toHaveLength(3);
  });

  it("filters by until", () => {
    const events = db.queryEvents({ sessionId: "session-1", until: "2026-03-19T10:01:00Z" });
    expect(events).toHaveLength(2);
  });

  it("filters by before (cursor pagination)", () => {
    const events = db.queryEvents({ sessionId: "session-1", before: "2026-03-19T10:03:00Z" });
    expect(events).toHaveLength(3); // e1, e2, e3 (before 10:03)
  });

  it("filters by search (text in data)", () => {
    const events = db.queryEvents({ sessionId: "session-1", search: "hello" });
    expect(events).toHaveLength(1);
    expect(events[0].id).toBe("e2");
  });

  it("combines type + agentId filters", () => {
    const events = db.queryEvents({ sessionId: "session-1", type: "agent-spawned", agentId: "agent-b" });
    expect(events).toHaveLength(1);
    expect(events[0].id).toBe("e3");
  });
});

describe("queryEvents pagination", () => {
  beforeEach(() => {
    for (let i = 0; i < 10; i++) {
      insertEvent({ id: `e${i}`, type: "agent-spawned", timestamp: `2026-03-19T10:${String(i).padStart(2, "0")}:00Z` });
    }
  });

  it("limits results", () => {
    const events = db.queryEvents({ sessionId: "session-1", limit: 3 });
    expect(events).toHaveLength(3);
  });

  it("orders ascending", () => {
    const events = db.queryEvents({ sessionId: "session-1", limit: 3, order: "asc" });
    expect(events[0].id).toBe("e0");
    expect(events[2].id).toBe("e2");
  });

  it("orders descending (default)", () => {
    const events = db.queryEvents({ sessionId: "session-1", limit: 3 });
    expect(events[0].id).toBe("e9");
    expect(events[2].id).toBe("e7");
  });

  it("cursor pagination with before", () => {
    // Get first page (newest 3)
    const page1 = db.queryEvents({ sessionId: "session-1", limit: 3 });
    expect(page1).toHaveLength(3);
    expect(page1[0].id).toBe("e9");

    // Get second page using last event's timestamp as cursor
    const cursor = page1[page1.length - 1].timestamp;
    const page2 = db.queryEvents({ sessionId: "session-1", limit: 3, before: cursor });
    expect(page2).toHaveLength(3);
    expect(page2[0].id).toBe("e6");
  });
});

describe("countEvents", () => {
  beforeEach(() => {
    insertEvent({ id: "e1", type: "agent-spawned", agentId: "agent-a" });
    insertEvent({ id: "e2", type: "message-sent", agentId: "agent-a" });
    insertEvent({ id: "e3", type: "agent-spawned", agentId: "agent-b" });
    insertEvent({ id: "e4", type: "task-created" });
  });

  it("counts all events in session", () => {
    expect(db.countEvents({ sessionId: "session-1" })).toBe(4);
  });

  it("counts by type", () => {
    expect(db.countEvents({ sessionId: "session-1", type: "agent-spawned" })).toBe(2);
  });

  it("counts by multiple types", () => {
    expect(db.countEvents({ sessionId: "session-1", types: ["agent-spawned", "task-created"] })).toBe(3);
  });

  it("counts by agentId", () => {
    expect(db.countEvents({ sessionId: "session-1", agentId: "agent-a" })).toBe(2);
  });

  it("returns 0 for no matches", () => {
    expect(db.countEvents({ sessionId: "session-1", type: "cost-threshold-reached" })).toBe(0);
  });
});
