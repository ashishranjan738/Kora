/**
 * Integration tests for crash.log periodic rotation.
 * Tests file truncation behavior and threshold respect.
 */

import { describe, it, expect } from "vitest";
import { join } from "path";
import { mkdirSync, writeFileSync, statSync } from "fs";

describe("Log rotation", () => {
  it("rotateFileBySize truncates file exceeding max size", async () => {
    const { rotateFileBySize } = await import("../../core/log-rotation.js");
    const tmpDir = join("/tmp", `kora-rotation-test-${Date.now()}`);
    mkdirSync(tmpDir, { recursive: true });

    const logFile = join(tmpDir, "test.log");
    writeFileSync(logFile, "x".repeat(100 * 1024));

    await rotateFileBySize(logFile, 50 * 1024, 10 * 1024);

    const stat = statSync(logFile);
    expect(stat.size).toBeLessThanOrEqual(15 * 1024);
    expect(stat.size).toBeGreaterThan(0);
  });

  it("rotateFileBySize does not touch file under max size", async () => {
    const { rotateFileBySize } = await import("../../core/log-rotation.js");
    const tmpDir = join("/tmp", `kora-rotation-test-${Date.now()}`);
    mkdirSync(tmpDir, { recursive: true });

    const logFile = join(tmpDir, "small.log");
    const content = "small file content\n";
    writeFileSync(logFile, content);

    await rotateFileBySize(logFile, 1024 * 1024, 100 * 1024);

    const stat = statSync(logFile);
    expect(stat.size).toBe(content.length);
  });
});
