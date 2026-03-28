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
  CRASH_LOG_MAX_BYTES,
  CRASH_LOG_KEEP_BYTES,
  AGENT_LOG_MAX_BYTES,
  AGENT_LOG_KEEP_BYTES,
  KNOWLEDGE_MAX_BYTES,
  KNOWLEDGE_KEEP_BYTES,
  JSONL_MAX_AGE_DAYS,
  PM2_LOG_MAX_SIZE,
} from "../../core/log-rotation.js";

let tmpDir: string;

beforeEach(async () => {
  tmpDir = await fsPromises.mkdtemp(path.join(os.tmpdir(), "kora-log-rotation-"));
});

afterEach(async () => {
  await fsPromises.rm(tmpDir, { recursive: true, force: true });
});

// ─── Constants ──────────────────────────────────────────────

describe("log-rotation constants", () => {
  it("exports sensible default limits", () => {
    expect(CRASH_LOG_MAX_BYTES).toBe(10 * 1024 * 1024); // 10 MB
    expect(CRASH_LOG_KEEP_BYTES).toBe(1 * 1024 * 1024);  // 1 MB
    expect(AGENT_LOG_MAX_BYTES).toBe(2 * 1024 * 1024);   // 2 MB
    expect(AGENT_LOG_KEEP_BYTES).toBe(1 * 1024 * 1024);  // 1 MB
    expect(KNOWLEDGE_MAX_BYTES).toBe(5 * 1024 * 1024);   // 5 MB
    expect(KNOWLEDGE_KEEP_BYTES).toBe(500 * 1024);        // 500 KB
    expect(JSONL_MAX_AGE_DAYS).toBe(30);
    expect(PM2_LOG_MAX_SIZE).toBe("50M");
  });
});

// ─── rotateFileBySize (async) ───────────────────────────────

describe("rotateFileBySize", () => {
  it("does nothing when file is under the limit", async () => {
    const filePath = path.join(tmpDir, "small.log");
    const content = "A".repeat(100);
    await fsPromises.writeFile(filePath, content);

    const rotated = await rotateFileBySize(filePath, 1024, 512);
    expect(rotated).toBe(false);

    const after = await fsPromises.readFile(filePath, "utf-8");
    expect(after).toBe(content);
  });

  it("truncates file to keepBytes when it exceeds maxBytes", async () => {
    const filePath = path.join(tmpDir, "big.log");
    // Create a 3KB file
    const content = "A".repeat(1024) + "B".repeat(1024) + "C".repeat(1024);
    await fsPromises.writeFile(filePath, content);

    // Rotate at 2KB, keep last 1KB
    const rotated = await rotateFileBySize(filePath, 2048, 1024);
    expect(rotated).toBe(true);

    const after = await fsPromises.readFile(filePath, "utf-8");
    expect(after.length).toBe(1024);
    // Should keep the tail (all C's)
    expect(after).toBe("C".repeat(1024));
  });

  it("returns false for non-existent file (no error)", async () => {
    const rotated = await rotateFileBySize(path.join(tmpDir, "missing.log"), 1024, 512);
    expect(rotated).toBe(false);
  });

  it("handles exact boundary (file size === maxBytes)", async () => {
    const filePath = path.join(tmpDir, "exact.log");
    const content = "X".repeat(2048);
    await fsPromises.writeFile(filePath, content);

    // File is exactly at limit — should NOT rotate
    const rotated = await rotateFileBySize(filePath, 2048, 1024);
    expect(rotated).toBe(false);
  });

  it("handles file just over the limit", async () => {
    const filePath = path.join(tmpDir, "justover.log");
    const content = "X".repeat(2049);
    await fsPromises.writeFile(filePath, content);

    const rotated = await rotateFileBySize(filePath, 2048, 1024);
    expect(rotated).toBe(true);

    const after = await fsPromises.readFile(filePath, "utf-8");
    expect(after.length).toBe(1024);
  });
});

// ─── rotateFileBySizeSync ───────────────────────────────────

describe("rotateFileBySizeSync", () => {
  it("does nothing when file is under the limit", () => {
    const filePath = path.join(tmpDir, "small-sync.log");
    fs.writeFileSync(filePath, "A".repeat(100));

    const rotated = rotateFileBySizeSync(filePath, 1024, 512);
    expect(rotated).toBe(false);

    const after = fs.readFileSync(filePath, "utf-8");
    expect(after.length).toBe(100);
  });

  it("truncates oversized file synchronously", () => {
    const filePath = path.join(tmpDir, "big-sync.log");
    fs.writeFileSync(filePath, "A".repeat(1024) + "B".repeat(1024) + "C".repeat(1024));

    const rotated = rotateFileBySizeSync(filePath, 2048, 1024);
    expect(rotated).toBe(true);

    const after = fs.readFileSync(filePath, "utf-8");
    expect(after.length).toBe(1024);
    expect(after).toBe("C".repeat(1024));
  });

  it("returns false for non-existent file", () => {
    const rotated = rotateFileBySizeSync(path.join(tmpDir, "missing-sync.log"), 1024, 512);
    expect(rotated).toBe(false);
  });
});

// ─── pruneOldJsonlFiles ─────────────────────────────────────

describe("pruneOldJsonlFiles", () => {
  it("deletes JSONL files older than maxAgeDays", async () => {
    const eventsDir = path.join(tmpDir, "events");
    await fsPromises.mkdir(eventsDir, { recursive: true });

    // Create old file (60 days ago)
    const oldDate = new Date();
    oldDate.setDate(oldDate.getDate() - 60);
    const oldFileName = `${oldDate.getFullYear()}-${String(oldDate.getMonth() + 1).padStart(2, "0")}-${String(oldDate.getDate()).padStart(2, "0")}.jsonl`;
    await fsPromises.writeFile(path.join(eventsDir, oldFileName), '{"test":1}\n');

    // Create recent file (today)
    const now = new Date();
    const recentFileName = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}-${String(now.getDate()).padStart(2, "0")}.jsonl`;
    await fsPromises.writeFile(path.join(eventsDir, recentFileName), '{"test":2}\n');

    const deleted = await pruneOldJsonlFiles(eventsDir, 30);
    expect(deleted).toBe(1);

    // Old file should be gone
    const files = await fsPromises.readdir(eventsDir);
    expect(files).toContain(recentFileName);
    expect(files).not.toContain(oldFileName);
  });

  it("returns 0 for non-existent directory", async () => {
    const deleted = await pruneOldJsonlFiles(path.join(tmpDir, "nonexistent"), 30);
    expect(deleted).toBe(0);
  });

  it("skips malformed filenames", async () => {
    const eventsDir = path.join(tmpDir, "events2");
    await fsPromises.mkdir(eventsDir, { recursive: true });

    await fsPromises.writeFile(path.join(eventsDir, "garbage.jsonl"), "data\n");
    await fsPromises.writeFile(path.join(eventsDir, "not-a-date.jsonl"), "data\n");

    const deleted = await pruneOldJsonlFiles(eventsDir, 30);
    expect(deleted).toBe(0);

    // Both files should still exist
    const files = await fsPromises.readdir(eventsDir);
    expect(files.length).toBe(2);
  });

  it("keeps files within maxAgeDays", async () => {
    const eventsDir = path.join(tmpDir, "events3");
    await fsPromises.mkdir(eventsDir, { recursive: true });

    // Create file from 5 days ago
    const recent = new Date();
    recent.setDate(recent.getDate() - 5);
    const fileName = `${recent.getFullYear()}-${String(recent.getMonth() + 1).padStart(2, "0")}-${String(recent.getDate()).padStart(2, "0")}.jsonl`;
    await fsPromises.writeFile(path.join(eventsDir, fileName), '{"test":1}\n');

    const deleted = await pruneOldJsonlFiles(eventsDir, 30);
    expect(deleted).toBe(0);
  });
});

// ─── pruneLogsOnStartup ─────────────────────────────────────

describe("pruneLogsOnStartup", () => {
  it("rotates oversized crash.log", async () => {
    const crashLog = path.join(tmpDir, "crash.log");
    // Create a 12 MB crash log
    const bigContent = "X".repeat(12 * 1024 * 1024);
    await fsPromises.writeFile(crashLog, bigContent);

    await pruneLogsOnStartup(tmpDir);

    const stats = await fsPromises.stat(crashLog);
    // Should be rotated to CRASH_LOG_KEEP_BYTES (1 MB)
    expect(stats.size).toBe(CRASH_LOG_KEEP_BYTES);
  });

  it("rotates oversized PM2 logs", async () => {
    for (const logName of ["pm2-out.log", "pm2-error.log"]) {
      const logPath = path.join(tmpDir, logName);
      // Create a 60 MB PM2 log
      await fsPromises.writeFile(logPath, "Y".repeat(60 * 1024 * 1024));
    }

    await pruneLogsOnStartup(tmpDir);

    for (const logName of ["pm2-out.log", "pm2-error.log"]) {
      const stats = await fsPromises.stat(path.join(tmpDir, logName));
      // Should be rotated to 5 MB (keepBytes for PM2)
      expect(stats.size).toBe(5 * 1024 * 1024);
    }
  });

  it("prunes old JSONL event files in session directories", async () => {
    // Create a fake session with an old event file
    const sessionDir = path.join(tmpDir, "daemon-sessions", "test-session", "events");
    await fsPromises.mkdir(sessionDir, { recursive: true });

    const oldDate = new Date();
    oldDate.setDate(oldDate.getDate() - 60);
    const oldFileName = `${oldDate.getFullYear()}-${String(oldDate.getMonth() + 1).padStart(2, "0")}-${String(oldDate.getDate()).padStart(2, "0")}.jsonl`;
    await fsPromises.writeFile(path.join(sessionDir, oldFileName), '{"event":"old"}\n');

    await pruneLogsOnStartup(tmpDir);

    const files = await fsPromises.readdir(sessionDir);
    expect(files).not.toContain(oldFileName);
  });

  it("rotates oversized knowledge.md in session directories", async () => {
    const sessionDir = path.join(tmpDir, "daemon-sessions", "test-session");
    await fsPromises.mkdir(sessionDir, { recursive: true });

    const knowledgePath = path.join(sessionDir, "knowledge.md");
    await fsPromises.writeFile(knowledgePath, "K".repeat(6 * 1024 * 1024)); // 6 MB

    await pruneLogsOnStartup(tmpDir);

    const stats = await fsPromises.stat(knowledgePath);
    expect(stats.size).toBe(KNOWLEDGE_KEEP_BYTES); // 500 KB
  });

  it("handles missing directories gracefully", async () => {
    // Should not throw even when daemon-sessions doesn't exist
    await expect(pruneLogsOnStartup(path.join(tmpDir, "nonexistent-dir"))).resolves.not.toThrow();
  });

  it("does not touch small files", async () => {
    const crashLog = path.join(tmpDir, "crash.log");
    const content = "Small crash log entry\n";
    await fsPromises.writeFile(crashLog, content);

    await pruneLogsOnStartup(tmpDir);

    const after = await fsPromises.readFile(crashLog, "utf-8");
    expect(after).toBe(content);
  });
});

// ─── Integration: crash loop simulation ─────────────────────

describe("crash loop simulation", () => {
  it("crash.log stays bounded under rapid append + rotate", () => {
    const crashLog = path.join(tmpDir, "crash-loop.log");

    // Simulate 50,000 crash entries (each ~200 bytes)
    const entry = `[${new Date().toISOString()}] uncaughtException: Error: something went wrong\n    at Object.<anonymous> (/app/server.js:42:15)\n`;

    for (let i = 0; i < 50000; i++) {
      // Check and rotate every 100 entries (simulating periodic rotation)
      if (i % 100 === 0) {
        rotateFileBySizeSync(crashLog, CRASH_LOG_MAX_BYTES, CRASH_LOG_KEEP_BYTES);
      }
      fs.appendFileSync(crashLog, entry);
    }

    const stats = fs.statSync(crashLog);
    // File should be well under 2x the max (some growth between rotations)
    expect(stats.size).toBeLessThan(CRASH_LOG_MAX_BYTES * 2);
  });
});
