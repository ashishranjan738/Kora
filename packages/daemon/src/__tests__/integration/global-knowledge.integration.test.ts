/**
 * Integration tests for cross-session global knowledge store.
 * Tests promote, retrieve, list, and delete operations.
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { join } from "path";
import { mkdirSync } from "fs";

describe("Global knowledge store (cross-session)", () => {
  let globalDb: any;
  let tmpDir: string;

  beforeEach(async () => {
    tmpDir = join("/tmp", `kora-global-test-${Date.now()}`);
    mkdirSync(tmpDir, { recursive: true });
    const { GlobalKnowledgeDB } = await import("../../core/global-knowledge.js");
    globalDb = new GlobalKnowledgeDB(tmpDir);
  });

  afterEach(() => {
    try { globalDb.db.close(); } catch {}
  });

  it("promotes knowledge entry to global store", () => {
    globalDb.promote({ key: "global-arch", value: "Microservices architecture", sourceSession: "test", promotedBy: "master-1" });
    const entry = globalDb.get("global-arch");
    expect(entry).not.toBeNull();
    expect(entry.value).toBe("Microservices architecture");
    expect(entry.promotedBy).toBe("master-1");
  });

  it("retrieves promoted global knowledge entry", () => {
    globalDb.promote({ key: "global-api", value: "REST API design guide", sourceSession: "test", promotedBy: "master-1" });
    const entry = globalDb.get("global-api");
    expect(entry).not.toBeNull();
    expect(entry.value).toContain("REST API");
    expect(entry.sourceSession).toBe("test");
  });

  it("lists all global knowledge entries", () => {
    globalDb.promote({ key: "g1", value: "Entry 1", sourceSession: "s1", promotedBy: "master" });
    globalDb.promote({ key: "g2", value: "Entry 2", sourceSession: "s1", promotedBy: "master" });

    const entries = globalDb.list(50);
    expect(entries.length).toBeGreaterThanOrEqual(2);
    expect(entries.some((e: any) => e.key === "g1")).toBe(true);
    expect(entries.some((e: any) => e.key === "g2")).toBe(true);
  });

  it("removes global knowledge entry", () => {
    globalDb.promote({ key: "delete-me", value: "Temporary", sourceSession: "test", promotedBy: "master" });
    expect(globalDb.get("delete-me")).not.toBeNull();

    const deleted = globalDb.remove("delete-me");
    expect(deleted).toBe(true);
    expect(globalDb.get("delete-me")).toBeNull();
  });
});
