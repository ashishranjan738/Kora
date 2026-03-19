import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { readKnowledgeEntries, appendKnowledgeEntry } from "../context-discovery.js";
import fs from "fs";
import path from "path";
import os from "os";

let tmpDir: string;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "kora-knowledge-"));
});

afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

describe("appendKnowledgeEntry", () => {
  it("creates knowledge.md and appends entry", () => {
    const runtimeDir = path.join(tmpDir, ".kora-dev");
    appendKnowledgeEntry(runtimeDir, "Backend", "Express 5 uses path-to-regexp v8");

    const content = fs.readFileSync(path.join(runtimeDir, "knowledge.md"), "utf-8");
    expect(content).toContain("[Backend]");
    expect(content).toContain("Express 5 uses path-to-regexp v8");
    expect(content).toMatch(/^\- \[\d{4}-\d{2}-\d{2}T/);
  });

  it("appends multiple entries", () => {
    const runtimeDir = path.join(tmpDir, ".kora-dev");
    appendKnowledgeEntry(runtimeDir, "Backend", "Entry 1");
    appendKnowledgeEntry(runtimeDir, "Frontend", "Entry 2");
    appendKnowledgeEntry(runtimeDir, "Tester", "Entry 3");

    const content = fs.readFileSync(path.join(runtimeDir, "knowledge.md"), "utf-8");
    const lines = content.trim().split("\n");
    expect(lines).toHaveLength(3);
    expect(lines[0]).toContain("[Backend] Entry 1");
    expect(lines[1]).toContain("[Frontend] Entry 2");
    expect(lines[2]).toContain("[Tester] Entry 3");
  });

  it("creates runtime directory if it does not exist", () => {
    const runtimeDir = path.join(tmpDir, "nested", "dir", ".kora-dev");
    appendKnowledgeEntry(runtimeDir, "Agent", "Test entry");

    expect(fs.existsSync(path.join(runtimeDir, "knowledge.md"))).toBe(true);
  });
});

describe("readKnowledgeEntries", () => {
  it("returns empty array when no knowledge file exists", () => {
    const entries = readKnowledgeEntries(tmpDir);
    expect(entries).toEqual([]);
  });

  it("reads entries from .kora-dev/knowledge.md", () => {
    const runtimeDir = path.join(tmpDir, ".kora-dev");
    fs.mkdirSync(runtimeDir, { recursive: true });
    fs.writeFileSync(path.join(runtimeDir, "knowledge.md"), [
      "- [2026-03-19T10:00:00Z] [Backend] Entry 1",
      "- [2026-03-19T10:01:00Z] [Frontend] Entry 2",
      "- [2026-03-19T10:02:00Z] [Tester] Entry 3",
    ].join("\n"));

    const entries = readKnowledgeEntries(tmpDir);
    expect(entries).toHaveLength(3);
    expect(entries[0]).toContain("Entry 1");
    expect(entries[2]).toContain("Entry 3");
  });

  it("returns last N entries (default 20)", () => {
    const runtimeDir = path.join(tmpDir, ".kora-dev");
    fs.mkdirSync(runtimeDir, { recursive: true });

    const lines = Array.from({ length: 30 }, (_, i) =>
      `- [2026-03-19T10:${String(i).padStart(2, "0")}:00Z] [Agent] Entry ${i}`
    );
    fs.writeFileSync(path.join(runtimeDir, "knowledge.md"), lines.join("\n"));

    const entries = readKnowledgeEntries(tmpDir, 20);
    expect(entries).toHaveLength(20);
    expect(entries[0]).toContain("Entry 10"); // last 20 of 30
    expect(entries[19]).toContain("Entry 29");
  });

  it("ignores non-entry lines", () => {
    const runtimeDir = path.join(tmpDir, ".kora-dev");
    fs.mkdirSync(runtimeDir, { recursive: true });
    fs.writeFileSync(path.join(runtimeDir, "knowledge.md"), [
      "# Knowledge Base",
      "",
      "- [2026-03-19T10:00:00Z] [Backend] Valid entry",
      "This is not an entry",
      "- [2026-03-19T10:01:00Z] [Frontend] Another valid entry",
    ].join("\n"));

    const entries = readKnowledgeEntries(tmpDir);
    expect(entries).toHaveLength(2);
  });

  it("falls back to .kora/ if .kora-dev/ doesn't exist", () => {
    const runtimeDir = path.join(tmpDir, ".kora");
    fs.mkdirSync(runtimeDir, { recursive: true });
    fs.writeFileSync(path.join(runtimeDir, "knowledge.md"),
      "- [2026-03-19T10:00:00Z] [Agent] Prod entry\n"
    );

    const entries = readKnowledgeEntries(tmpDir);
    expect(entries).toHaveLength(1);
    expect(entries[0]).toContain("Prod entry");
  });
});
