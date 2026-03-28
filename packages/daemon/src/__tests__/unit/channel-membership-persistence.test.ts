/**
 * Tests for channel membership persistence (task d8427001).
 *
 * Verifies:
 * - channel_members table created (migration 17)
 * - joinChannel / leaveChannel / getChannelMembers / getAgentChannels CRUD
 * - Memberships survive DB close/reopen
 * - #all channel auto-creation with isDefault flag
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { AppDatabase } from "../../core/database.js";
import path from "path";
import fs from "fs";
import os from "os";

let db: AppDatabase;
let tmpDir: string;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "kora-channel-test-"));
  db = new AppDatabase(tmpDir);
});

afterEach(() => {
  try { db.close(); } catch {}
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

describe("channel_members table", () => {
  it("should be created by migration 17", () => {
    // If table doesn't exist, queries will throw
    const members = db.getChannelMembers("#test");
    expect(members).toEqual([]);
  });
});

describe("joinChannel", () => {
  it("should add an agent to a channel", () => {
    db.joinChannel("session-1", "#all", "agent-1");
    const members = db.getChannelMembers("#all");
    expect(members).toEqual(["agent-1"]);
  });

  it("should be idempotent (INSERT OR IGNORE)", () => {
    db.joinChannel("session-1", "#all", "agent-1");
    db.joinChannel("session-1", "#all", "agent-1");
    const members = db.getChannelMembers("#all");
    expect(members).toEqual(["agent-1"]);
  });

  it("should support multiple agents in one channel", () => {
    db.joinChannel("session-1", "#all", "agent-1");
    db.joinChannel("session-1", "#all", "agent-2");
    db.joinChannel("session-1", "#all", "agent-3");
    const members = db.getChannelMembers("#all");
    expect(members).toHaveLength(3);
    expect(members).toContain("agent-1");
    expect(members).toContain("agent-2");
    expect(members).toContain("agent-3");
  });

  it("should support one agent in multiple channels", () => {
    db.joinChannel("session-1", "#all", "agent-1");
    db.joinChannel("session-1", "#backend", "agent-1");
    db.joinChannel("session-1", "#frontend", "agent-1");
    const channels = db.getAgentChannels("agent-1");
    expect(channels).toHaveLength(3);
    expect(channels).toContain("#all");
    expect(channels).toContain("#backend");
    expect(channels).toContain("#frontend");
  });
});

describe("leaveChannel", () => {
  it("should remove an agent from a channel", () => {
    db.joinChannel("session-1", "#test", "agent-1");
    const removed = db.leaveChannel("#test", "agent-1");
    expect(removed).toBe(true);
    expect(db.getChannelMembers("#test")).toEqual([]);
  });

  it("should return false if agent was not a member", () => {
    const removed = db.leaveChannel("#test", "agent-1");
    expect(removed).toBe(false);
  });

  it("should not affect other members", () => {
    db.joinChannel("session-1", "#test", "agent-1");
    db.joinChannel("session-1", "#test", "agent-2");
    db.leaveChannel("#test", "agent-1");
    expect(db.getChannelMembers("#test")).toEqual(["agent-2"]);
  });
});

describe("getAgentChannels", () => {
  it("should return empty array for unknown agent", () => {
    expect(db.getAgentChannels("unknown")).toEqual([]);
  });

  it("should return all channels an agent belongs to", () => {
    db.joinChannel("session-1", "#all", "agent-1");
    db.joinChannel("session-1", "#dev", "agent-1");
    const channels = db.getAgentChannels("agent-1");
    expect(channels).toHaveLength(2);
  });
});

describe("persistence across DB reopen", () => {
  it("should survive close and reopen", () => {
    db.joinChannel("session-1", "#all", "agent-1");
    db.joinChannel("session-1", "#backend", "agent-1");
    db.close();

    // Reopen
    const db2 = new AppDatabase(tmpDir);
    const members = db2.getChannelMembers("#all");
    expect(members).toEqual(["agent-1"]);
    const channels = db2.getAgentChannels("agent-1");
    expect(channels).toHaveLength(2);
    db2.close();
  });
});

describe("default #all channel", () => {
  it("should be created with isDefault flag", () => {
    db.createChannel({
      id: "#all",
      sessionId: "session-1",
      name: "all",
      description: "Default channel for all agents",
      createdBy: "system",
      isDefault: true,
    });
    const channels = db.getChannels("session-1");
    expect(channels).toHaveLength(1);
    expect(channels[0].id).toBe("#all");
    expect(channels[0].isDefault).toBe(true);
  });

  it("should not be deletable (is_default = 1)", () => {
    db.createChannel({
      id: "#all",
      sessionId: "session-1",
      name: "all",
      createdBy: "system",
      isDefault: true,
    });
    const deleted = db.deleteChannel("#all");
    expect(deleted).toBe(false);
    expect(db.getChannels("session-1")).toHaveLength(1);
  });

  it("createChannel should be idempotent (INSERT OR IGNORE)", () => {
    db.createChannel({ id: "#all", sessionId: "s1", name: "all", isDefault: true });
    db.createChannel({ id: "#all", sessionId: "s1", name: "all", isDefault: true });
    expect(db.getChannels("s1")).toHaveLength(1);
  });
});
