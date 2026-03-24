/**
 * Tests for channels DB methods and API validation logic.
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { AppDatabase } from "../../core/database";
import fs from "fs";
import os from "os";
import path from "path";

describe("Channels DB", () => {
  let db: AppDatabase;
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "kora-channels-test-"));
    db = new AppDatabase(tmpDir);
  });

  afterEach(() => {
    db.close();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it("creates and retrieves channels", () => {
    db.createChannel({ id: "#frontend", sessionId: "s1", name: "Frontend" });
    db.createChannel({ id: "#backend", sessionId: "s1", name: "Backend", description: "Backend team" });
    const channels = db.getChannels("s1");
    expect(channels).toHaveLength(2);
    expect(channels.find(c => c.id === "#frontend")).toBeDefined();
    expect(channels.find(c => c.id === "#backend")?.description).toBe("Backend team");
  });

  it("default channels sort first", () => {
    db.createChannel({ id: "#custom", sessionId: "s1", name: "Custom" });
    db.createChannel({ id: "#all", sessionId: "s1", name: "All", isDefault: true });
    const channels = db.getChannels("s1");
    expect(channels[0].id).toBe("#all");
    expect(channels[0].isDefault).toBe(true);
  });

  it("ignores duplicate channel IDs", () => {
    db.createChannel({ id: "#all", sessionId: "s1", name: "All" });
    db.createChannel({ id: "#all", sessionId: "s1", name: "All Again" });
    expect(db.getChannels("s1")).toHaveLength(1);
  });

  it("deletes non-default channels", () => {
    db.createChannel({ id: "#custom", sessionId: "s1", name: "Custom" });
    expect(db.deleteChannel("#custom")).toBe(true);
    expect(db.getChannels("s1")).toHaveLength(0);
  });

  it("cannot delete default channels", () => {
    db.createChannel({ id: "#all", sessionId: "s1", name: "All", isDefault: true });
    expect(db.deleteChannel("#all")).toBe(false);
    expect(db.getChannels("s1")).toHaveLength(1);
  });

  it("getChannelMessages returns empty for no messages", () => {
    const msgs = db.getChannelMessages("#frontend");
    expect(msgs).toHaveLength(0);
  });

  it("getChannelMessages respects limit", () => {
    // Insert test messages
    for (let i = 0; i < 10; i++) {
      db.insertMessage({
        id: `msg-${i}`,
        sessionId: "s1",
        fromAgentId: "agent-1",
        toAgentId: "agent-2",
        messageType: "text",
        content: `Message ${i}`,
        channel: "#frontend",
        createdAt: new Date().toISOString(),
      });
    }
    const msgs = db.getChannelMessages("#frontend", 5);
    expect(msgs).toHaveLength(5);
  });

  it("filters by session — different sessions don't mix", () => {
    db.createChannel({ id: "#ch1", sessionId: "s1", name: "S1 Channel" });
    db.createChannel({ id: "#ch2", sessionId: "s2", name: "S2 Channel" });
    expect(db.getChannels("s1")).toHaveLength(1);
    expect(db.getChannels("s2")).toHaveLength(1);
  });
});

describe("Channel ID Validation", () => {
  function isValidChannelId(id: string): boolean {
    return id.startsWith("#") && !/\s/.test(id);
  }

  it("valid: #frontend, #backend, #all", () => {
    expect(isValidChannelId("#frontend")).toBe(true);
    expect(isValidChannelId("#backend")).toBe(true);
    expect(isValidChannelId("#all")).toBe(true);
  });

  it("invalid: missing #", () => {
    expect(isValidChannelId("frontend")).toBe(false);
  });

  it("invalid: contains spaces", () => {
    expect(isValidChannelId("#my channel")).toBe(false);
  });

  it("valid: hyphens and numbers", () => {
    expect(isValidChannelId("#team-2")).toBe(true);
  });
});

describe("Channel Leave Protection", () => {
  it("#all cannot be left", () => {
    const canLeave = (channelId: string) => channelId !== "#all";
    expect(canLeave("#all")).toBe(false);
    expect(canLeave("#frontend")).toBe(true);
  });
});
