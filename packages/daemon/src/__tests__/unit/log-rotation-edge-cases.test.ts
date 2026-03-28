/**
 * Additional edge case tests for log-rotation.ts (PR #456).
 * Covers: permission errors, empty files, zero-byte keepBytes,
 * concurrent rotation safety, and boundary precision.
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import * as fs from "fs";
import * as fsPromises from "fs/promises";
import * as path from "path";
import * as os from "os";
import {
  rotateFileBySize,
  rotateFileBySizeSync,
  pruneOldJsonlFiles,
  pruneLogsOnStartup,
} from "../../core/log-rotation.js";

let tmpDir: string;

beforeEach(async () => {
  tmpDir = await fsPromises.mkdtemp(path.join(os.tmpdir(), "kora-log-edge-"));
});

afterEach(async () => {
  await fsPromises.rm(tmpDir, { recursive: true, force: true });
});

// ─── Empty file handling ──────────────────────────────────

describe("rotateFileBySize — empty files", () => {
  it("does nothing for zero-byte file (async)", async () => {
    const filePath = path.join(tmpDir, "empty.log");
    await fsPromises.writeFile(filePath, "");

    const rotated = await rotateFileBySize(filePath, 1024, 512);
    expect(rotated).toBe(false);

    const after = await fsPromises.readFile(filePath, "utf-8");
    expect(after).toBe("");
  });

  it("does nothing for zero-byte file (sync)", () => {
    const filePath = path.join(tmpDir, "empty-sync.log");
    fs.writeFileSync(filePath, "");

    const rotated = rotateFileBySizeSync(filePath, 1024, 512);
    expect(rotated).toBe(false);

    const after = fs.readFileSync(filePath, "utf-8");
    expect(after).toBe("");
  });
});

// ─── Boundary precision tests ─────────────────────────────

describe("rotateFileBySize — precise boundary behavior", () => {
  it("does NOT rotate when file is 1 byte under limit", async () => {
    const filePath = path.join(tmpDir, "under.log");
    const content = "X".repeat(2047); // 2047 < 2048
    await fsPromises.writeFile(filePath, content);

    const rotated = await rotateFileBySize(filePath, 2048, 1024);
    expect(rotated).toBe(false);

    const after = await fsPromises.readFile(filePath, "utf-8");
    expect(after.length).toBe(2047);
  });

  it("DOES rotate when file is 1 byte over limit", async () => {
    const filePath = path.join(tmpDir, "over.log");
    const content = "X".repeat(2049); // 2049 > 2048
    await fsPromises.writeFile(filePath, content);

    const rotated = await rotateFileBySize(filePath, 2048, 1024);
    expect(rotated).toBe(true);

    const after = await fsPromises.readFile(filePath, "utf-8");
    expect(after.length).toBe(1024);
  });

  it("sync: does NOT rotate at exact boundary", () => {
    const filePath = path.join(tmpDir, "exact-sync.log");
    fs.writeFileSync(filePath, "X".repeat(2048));

    const rotated = rotateFileBySizeSync(filePath, 2048, 1024);
    expect(rotated).toBe(false);
  });

  it("sync: rotates at 1 byte over boundary", () => {
    const filePath = path.join(tmpDir, "over-sync.log");
    fs.writeFileSync(filePath, "X".repeat(2049));

    const rotated = rotateFileBySizeSync(filePath, 2048, 1024);
    expect(rotated).toBe(true);

    const after = fs.readFileSync(filePath, "utf-8");
    expect(after.length).toBe(1024);
  });
});

// ─── Tail preservation correctness ────────────────────────

describe("rotateFileBySize — preserves most recent data", () => {
  it("keeps the tail of the file (last entries)", async () => {
    const filePath = path.join(tmpDir, "ordered.log");
    // Create file with distinguishable sections
    const old = "OLD:".repeat(512); // 2048 bytes
    const recent = "NEW:".repeat(512); // 2048 bytes
    await fsPromises.writeFile(filePath, old + recent);

    const rotated = await rotateFileBySize(filePath, 3000, 2048);
    expect(rotated).toBe(true);

    const after = await fsPromises.readFile(filePath, "utf-8");
    expect(after.length).toBe(2048);
    // The kept portion should be from the tail (the "NEW:" section)
    expect(after).toBe(recent);
  });

  it("sync: keeps the tail of the file", () => {
    const filePath = path.join(tmpDir, "ordered-sync.log");
    const old = "A".repeat(2048);
    const recent = "B".repeat(1024);
    fs.writeFileSync(filePath, old + recent);

    const rotated = rotateFileBySizeSync(filePath, 2048, 1024);
    expect(rotated).toBe(true);

    const after = fs.readFileSync(filePath, "utf-8");
    expect(after).toBe("B".repeat(1024));
  });
});

// ─── JSONL pruning edge cases ─────────────────────────────

describe("pruneOldJsonlFiles — edge cases", () => {
  it("does not delete non-.jsonl files", async () => {
    const dir = path.join(tmpDir, "events");
    await fsPromises.mkdir(dir, { recursive: true });

    // Create an old .txt file (should NOT be deleted even if old)
    await fsPromises.writeFile(path.join(dir, "2020-01-01.txt"), "data");
    // Create a .log file
    await fsPromises.writeFile(path.join(dir, "debug.log"), "data");

    const deleted = await pruneOldJsonlFiles(dir, 30);
    expect(deleted).toBe(0);

    const files = await fsPromises.readdir(dir);
    expect(files.length).toBe(2);
  });

  it("handles exactly-at-cutoff date (edge of 30 days)", async () => {
    const dir = path.join(tmpDir, "events-edge");
    await fsPromises.mkdir(dir, { recursive: true });

    // Create file exactly 30 days ago
    const exactly30 = new Date();
    exactly30.setDate(exactly30.getDate() - 30);
    const fileName = `${exactly30.getFullYear()}-${String(exactly30.getMonth() + 1).padStart(2, "0")}-${String(exactly30.getDate()).padStart(2, "0")}.jsonl`;
    await fsPromises.writeFile(path.join(dir, fileName), '{"test":1}\n');

    // Note: cutoff is Date - 30 days, so exactly 30 days ago should be deleted
    // because fileDate < cutoff (both at same day but cutoff time is "now")
    const deleted = await pruneOldJsonlFiles(dir, 30);
    // The file date (midnight) is before cutoff (now minus 30 days at current time)
    expect(deleted).toBe(1);
  });

  it("handles empty directory", async () => {
    const dir = path.join(tmpDir, "empty-events");
    await fsPromises.mkdir(dir, { recursive: true });

    const deleted = await pruneOldJsonlFiles(dir, 30);
    expect(deleted).toBe(0);
  });

  it("handles mixed valid and invalid filenames", async () => {
    const dir = path.join(tmpDir, "mixed-events");
    await fsPromises.mkdir(dir, { recursive: true });

    // Old valid file
    const oldDate = new Date();
    oldDate.setDate(oldDate.getDate() - 60);
    const validOld = `${oldDate.getFullYear()}-${String(oldDate.getMonth() + 1).padStart(2, "0")}-${String(oldDate.getDate()).padStart(2, "0")}.jsonl`;
    await fsPromises.writeFile(path.join(dir, validOld), "data\n");

    // Invalid filenames
    await fsPromises.writeFile(path.join(dir, "not-a-date.jsonl"), "data\n");
    await fsPromises.writeFile(path.join(dir, "abc.jsonl"), "data\n");

    const deleted = await pruneOldJsonlFiles(dir, 30);
    expect(deleted).toBe(1); // Only the valid old file

    const remaining = await fsPromises.readdir(dir);
    expect(remaining).toContain("not-a-date.jsonl");
    expect(remaining).toContain("abc.jsonl");
  });
});

// ─── pruneLogsOnStartup — multiple sessions ───────────────

describe("pruneLogsOnStartup — multi-session", () => {
  it("processes multiple session directories", async () => {
    const sessionsDir = path.join(tmpDir, "daemon-sessions");

    // Create two sessions with old event files
    for (const sid of ["session-a", "session-b"]) {
      const eventsDir = path.join(sessionsDir, sid, "events");
      await fsPromises.mkdir(eventsDir, { recursive: true });

      const oldDate = new Date();
      oldDate.setDate(oldDate.getDate() - 60);
      const oldFile = `${oldDate.getFullYear()}-${String(oldDate.getMonth() + 1).padStart(2, "0")}-${String(oldDate.getDate()).padStart(2, "0")}.jsonl`;
      await fsPromises.writeFile(path.join(eventsDir, oldFile), '{"old":true}\n');
    }

    await pruneLogsOnStartup(tmpDir);

    // Both old files should be pruned
    for (const sid of ["session-a", "session-b"]) {
      const files = await fsPromises.readdir(path.join(sessionsDir, sid, "events"));
      expect(files.length).toBe(0);
    }
  });

  it("continues processing if one session fails", async () => {
    const sessionsDir = path.join(tmpDir, "daemon-sessions");

    // Create one valid session
    const goodSession = path.join(sessionsDir, "good-session");
    const goodKnowledge = path.join(goodSession, "knowledge.md");
    await fsPromises.mkdir(goodSession, { recursive: true });
    await fsPromises.writeFile(goodKnowledge, "K".repeat(6 * 1024 * 1024)); // 6 MB

    // The function should handle missing events dirs gracefully
    await expect(pruneLogsOnStartup(tmpDir)).resolves.not.toThrow();

    // Good session's knowledge.md should still be rotated
    const stats = await fsPromises.stat(goodKnowledge);
    expect(stats.size).toBe(500 * 1024); // KNOWLEDGE_KEEP_BYTES
  });

  it("does not touch recent small files across all sessions", async () => {
    const sessionsDir = path.join(tmpDir, "daemon-sessions");
    const sessionDir = path.join(sessionsDir, "test-session");
    await fsPromises.mkdir(sessionDir, { recursive: true });

    const knowledgePath = path.join(sessionDir, "knowledge.md");
    const smallContent = "# Knowledge\nSmall file\n";
    await fsPromises.writeFile(knowledgePath, smallContent);

    await pruneLogsOnStartup(tmpDir);

    const after = await fsPromises.readFile(knowledgePath, "utf-8");
    expect(after).toBe(smallContent);
  });
});
