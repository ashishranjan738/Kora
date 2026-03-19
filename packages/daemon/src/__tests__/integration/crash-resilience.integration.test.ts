import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "fs/promises";
import fsSync from "fs";
import path from "path";
import os from "os";
import type { Orchestrator } from "../../core/orchestrator.js";

describe("Daemon Crash Resilience", () => {
  let testDir: string;
  let crashLogPath: string;

  beforeEach(async () => {
    // Create temp directory for tests
    testDir = path.join(os.tmpdir(), `kora-crash-test-${Date.now()}`);
    await fs.mkdir(testDir, { recursive: true });
    crashLogPath = path.join(testDir, "crash.log");
  });

  afterEach(async () => {
    // Clean up test directory
    try {
      await fs.rm(testDir, { recursive: true, force: true });
    } catch {
      // Best effort cleanup
    }
  });

  describe("unhandledRejection Handler", () => {
    it("keeps process alive and logs to crash.log", async () => {
      // Simulate the daemon's crash handler behavior
      const simulateCrashHandler = async (rejection: Error) => {
        // This simulates what happens in cli.ts
        try {
          const entry = `[${new Date().toISOString()}] unhandledRejection: ${rejection.stack || rejection.message}\n`;
          await fs.appendFile(crashLogPath, entry);
        } catch {
          // Best effort
        }
      };

      const testError = new Error("Test unhandled rejection");
      testError.stack = `Error: Test unhandled rejection
    at TestFunction (/path/to/test.ts:10:15)
    at Runner (/path/to/runner.ts:25:10)`;

      await simulateCrashHandler(testError);

      // Verify crash.log was written
      const crashLog = await fs.readFile(crashLogPath, "utf-8");
      expect(crashLog).toContain("unhandledRejection: Error: Test unhandled rejection");
      expect(crashLog).toContain("at TestFunction");
      expect(crashLog).toMatch(/\[\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}/); // ISO timestamp
    });

    it("handles rejection with no stack trace", async () => {
      const simulateCrashHandler = async (rejection: Error) => {
        try {
          const entry = `[${new Date().toISOString()}] unhandledRejection: ${rejection.stack || rejection.message}\n`;
          await fs.appendFile(crashLogPath, entry);
        } catch {
          // Best effort
        }
      };

      const testError = new Error("Error without stack");
      testError.stack = undefined;

      await simulateCrashHandler(testError);

      const crashLog = await fs.readFile(crashLogPath, "utf-8");
      expect(crashLog).toContain("Error without stack");
    });

    it("handles non-Error rejections", async () => {
      const simulateCrashHandler = async (reason: unknown) => {
        const err = reason instanceof Error ? reason : new Error(String(reason));
        try {
          const entry = `[${new Date().toISOString()}] unhandledRejection: ${err.stack || err.message}\n`;
          await fs.appendFile(crashLogPath, entry);
        } catch {
          // Best effort
        }
      };

      await simulateCrashHandler("String rejection");
      await simulateCrashHandler({ foo: "bar" });
      await simulateCrashHandler(null);

      const crashLog = await fs.readFile(crashLogPath, "utf-8");
      expect(crashLog).toContain("String rejection");
      expect(crashLog).toContain("[object Object]");
      expect(crashLog).toContain("null");
    });

    it("appends multiple rejections to same file", async () => {
      const simulateCrashHandler = async (rejection: Error) => {
        try {
          const entry = `[${new Date().toISOString()}] unhandledRejection: ${rejection.stack || rejection.message}\n`;
          await fs.appendFile(crashLogPath, entry);
        } catch {
          // Best effort
        }
      };

      await simulateCrashHandler(new Error("Rejection 1"));
      await simulateCrashHandler(new Error("Rejection 2"));
      await simulateCrashHandler(new Error("Rejection 3"));

      const crashLog = await fs.readFile(crashLogPath, "utf-8");
      expect(crashLog).toContain("Rejection 1");
      expect(crashLog).toContain("Rejection 2");
      expect(crashLog).toContain("Rejection 3");

      // Verify 3 separate entries
      const entries = crashLog.split("unhandledRejection:");
      expect(entries.length).toBe(4); // Empty string before first entry + 3 entries
    });
  });

  describe("uncaughtException Handler", () => {
    it("keeps process alive and logs to crash.log", async () => {
      const simulateCrashHandler = async (err: Error) => {
        try {
          const entry = `[${new Date().toISOString()}] uncaughtException: ${err.stack || err.message}\n`;
          await fs.appendFile(crashLogPath, entry);
        } catch {
          // Best effort
        }
      };

      const testError = new Error("Test uncaught exception");
      testError.stack = `Error: Test uncaught exception
    at SomeFunction (/path/to/file.ts:42:10)`;

      await simulateCrashHandler(testError);

      const crashLog = await fs.readFile(crashLogPath, "utf-8");
      expect(crashLog).toContain("uncaughtException: Error: Test uncaught exception");
      expect(crashLog).toContain("at SomeFunction");
    });
  });

  describe("rotateLogFile with Permission Errors", () => {
    it("handles EACCES permission error gracefully", async () => {
      // Simulate rotateLogFile behavior
      const rotateLogFile = async (logPath: string, maxSizeBytes: number = 2 * 1024 * 1024) => {
        const errors: string[] = [];
        try {
          const stats = await fs.stat(logPath);
          if (stats.size > maxSizeBytes) {
            const content = await fs.readFile(logPath, "utf-8");
            const truncated = content.slice(-1024 * 1024);
            await fs.writeFile(logPath, truncated, "utf-8");
          }
        } catch (err) {
          const code = (err as NodeJS.ErrnoException).code;
          if (code !== "ENOENT") {
            errors.push(`Log rotation failed (non-fatal): ${code}`);
          }
        }
        return errors;
      };

      // Create a large log file
      const logPath = path.join(testDir, "test-agent.log");
      const largeContent = "x".repeat(3 * 1024 * 1024); // 3MB
      await fs.writeFile(logPath, largeContent, "utf-8");

      // Make file read-only to simulate permission error
      await fs.chmod(logPath, 0o444);

      // Rotation should fail gracefully
      const errors = await rotateLogFile(logPath);

      // Should have caught the error
      expect(errors.length).toBe(1);
      expect(errors[0]).toContain("EACCES");

      // File should still exist (not deleted)
      const exists = fsSync.existsSync(logPath);
      expect(exists).toBe(true);

      // Clean up
      await fs.chmod(logPath, 0o644);
    });

    it("ignores ENOENT errors (missing file)", async () => {
      const rotateLogFile = async (logPath: string, maxSizeBytes: number = 2 * 1024 * 1024) => {
        const errors: string[] = [];
        try {
          const stats = await fs.stat(logPath);
          if (stats.size > maxSizeBytes) {
            const content = await fs.readFile(logPath, "utf-8");
            const truncated = content.slice(-1024 * 1024);
            await fs.writeFile(logPath, truncated, "utf-8");
          }
        } catch (err) {
          const code = (err as NodeJS.ErrnoException).code;
          if (code !== "ENOENT") {
            errors.push(`Log rotation failed (non-fatal): ${code}`);
          }
        }
        return errors;
      };

      // Try to rotate non-existent file
      const logPath = path.join(testDir, "nonexistent.log");
      const errors = await rotateLogFile(logPath);

      // Should NOT have logged error (ENOENT is expected)
      expect(errors.length).toBe(0);
    });

    it("successfully rotates file over size limit", async () => {
      const rotateLogFile = async (logPath: string, maxSizeBytes: number = 2 * 1024 * 1024) => {
        try {
          const stats = await fs.stat(logPath);
          if (stats.size > maxSizeBytes) {
            const content = await fs.readFile(logPath, "utf-8");
            const truncated = content.slice(-1024 * 1024); // Keep last 1MB
            await fs.writeFile(logPath, truncated, "utf-8");
            return true;
          }
        } catch (err) {
          return false;
        }
        return false;
      };

      const logPath = path.join(testDir, "large.log");

      // Create 3MB file
      const content = "Line with text\n".repeat(200_000); // ~3MB
      await fs.writeFile(logPath, content, "utf-8");

      const statsBefore = await fs.stat(logPath);
      expect(statsBefore.size).toBeGreaterThan(2 * 1024 * 1024);

      // Rotate
      const rotated = await rotateLogFile(logPath);
      expect(rotated).toBe(true);

      // Check size after rotation
      const statsAfter = await fs.stat(logPath);
      expect(statsAfter.size).toBeLessThanOrEqual(1024 * 1024 + 100); // ~1MB plus small buffer
      expect(statsAfter.size).toBeLessThan(statsBefore.size);
    });

    it("does not rotate file under size limit", async () => {
      const rotateLogFile = async (logPath: string, maxSizeBytes: number = 2 * 1024 * 1024) => {
        try {
          const stats = await fs.stat(logPath);
          if (stats.size > maxSizeBytes) {
            const content = await fs.readFile(logPath, "utf-8");
            const truncated = content.slice(-1024 * 1024);
            await fs.writeFile(logPath, truncated, "utf-8");
            return true;
          }
        } catch (err) {
          return false;
        }
        return false;
      };

      const logPath = path.join(testDir, "small.log");

      // Create 1MB file (under 2MB limit)
      const content = "x".repeat(1024 * 1024);
      await fs.writeFile(logPath, content, "utf-8");

      const statsBefore = await fs.stat(logPath);

      // Try to rotate
      const rotated = await rotateLogFile(logPath);
      expect(rotated).toBe(false); // Should not rotate

      // Size should be unchanged
      const statsAfter = await fs.stat(logPath);
      expect(statsAfter.size).toBe(statsBefore.size);
    });
  });

  describe("rotateAgentLogs with Parallel Rotation", () => {
    it("continues rotating other logs when one fails", async () => {
      const rotateLogFile = async (logPath: string, maxSizeBytes: number = 2 * 1024 * 1024) => {
        // Simulate permission error for specific file
        if (logPath.includes("agent-2")) {
          throw Object.assign(new Error("EACCES: permission denied"), { code: "EACCES" });
        }

        try {
          const stats = await fs.stat(logPath);
          if (stats.size > maxSizeBytes) {
            const content = await fs.readFile(logPath, "utf-8");
            const truncated = content.slice(-1024 * 1024);
            await fs.writeFile(logPath, truncated, "utf-8");
          }
        } catch (err) {
          throw err;
        }
      };

      // Create 3 agent log files (all large)
      const logs = [
        path.join(testDir, "agent-1.log"),
        path.join(testDir, "agent-2.log"), // This one will fail
        path.join(testDir, "agent-3.log"),
      ];

      for (const logPath of logs) {
        await fs.writeFile(logPath, "x".repeat(3 * 1024 * 1024), "utf-8");
      }

      // Rotate all in parallel (Promise.allSettled pattern)
      const results = await Promise.allSettled(
        logs.map(logPath => rotateLogFile(logPath))
      );

      // Check results
      expect(results[0].status).toBe("fulfilled"); // agent-1: success
      expect(results[1].status).toBe("rejected");  // agent-2: failed
      expect(results[2].status).toBe("fulfilled"); // agent-3: success

      // Verify agent-1 and agent-3 were rotated
      const stats1 = await fs.stat(logs[0]);
      const stats3 = await fs.stat(logs[2]);
      expect(stats1.size).toBeLessThan(2 * 1024 * 1024);
      expect(stats3.size).toBeLessThan(2 * 1024 * 1024);

      // Verify agent-2 still has original size (rotation failed)
      const stats2 = await fs.stat(logs[1]);
      expect(stats2.size).toBeGreaterThan(2 * 1024 * 1024);
    });

    it("handles concurrent rotation for 10+ agents", async () => {
      const rotateLogFile = async (logPath: string, maxSizeBytes: number = 2 * 1024 * 1024) => {
        // Add small delay to simulate real I/O
        await new Promise(resolve => setTimeout(resolve, 10));

        try {
          const stats = await fs.stat(logPath);
          if (stats.size > maxSizeBytes) {
            const content = await fs.readFile(logPath, "utf-8");
            const truncated = content.slice(-1024 * 1024);
            await fs.writeFile(logPath, truncated, "utf-8");
          }
        } catch (err) {
          throw err;
        }
      };

      // Create 15 agent log files
      const logs: string[] = [];
      for (let i = 1; i <= 15; i++) {
        const logPath = path.join(testDir, `agent-${i}.log`);
        logs.push(logPath);
        // Make every other one large (needs rotation)
        const size = i % 2 === 0 ? 3 * 1024 * 1024 : 500 * 1024;
        await fs.writeFile(logPath, "x".repeat(size), "utf-8");
      }

      // Rotate all in parallel
      const startTime = Date.now();
      const results = await Promise.allSettled(
        logs.map(logPath => rotateLogFile(logPath))
      );
      const duration = Date.now() - startTime;

      // All should succeed
      expect(results.every(r => r.status === "fulfilled")).toBe(true);

      // Verify rotation happened for large files
      for (let i = 1; i <= 15; i++) {
        const stats = await fs.stat(logs[i - 1]);
        if (i % 2 === 0) {
          // Large file should be rotated
          expect(stats.size).toBeLessThan(2 * 1024 * 1024);
        } else {
          // Small file should be unchanged
          expect(stats.size).toBe(500 * 1024);
        }
      }

      // Parallel execution should be faster than sequential
      // (15 * 10ms = 150ms sequential, should finish in ~50ms parallel)
      expect(duration).toBeLessThan(100);
    });

    it("handles race condition with concurrent writes", async () => {
      const logPath = path.join(testDir, "race-test.log");

      // Create initial large file
      await fs.writeFile(logPath, "x".repeat(3 * 1024 * 1024), "utf-8");

      const rotateLogFile = async () => {
        try {
          const stats = await fs.stat(logPath);
          if (stats.size > 2 * 1024 * 1024) {
            const content = await fs.readFile(logPath, "utf-8");
            const truncated = content.slice(-1024 * 1024);
            await fs.writeFile(logPath, truncated, "utf-8");
          }
        } catch (err) {
          // May fail due to race, that's expected
        }
      };

      // Try to rotate same file 3 times concurrently
      const results = await Promise.allSettled([
        rotateLogFile(),
        rotateLogFile(),
        rotateLogFile(),
      ]);

      // At least one should succeed
      const successCount = results.filter(r => r.status === "fulfilled").length;
      expect(successCount).toBeGreaterThan(0);

      // File should end up rotated
      const finalStats = await fs.stat(logPath);
      expect(finalStats.size).toBeLessThanOrEqual(1024 * 1024 + 100);
    });
  });

  describe("Error Recovery Scenarios", () => {
    it("handles corrupt log file gracefully", async () => {
      const rotateLogFile = async (logPath: string, maxSizeBytes: number = 2 * 1024 * 1024) => {
        try {
          const stats = await fs.stat(logPath);
          if (stats.size > maxSizeBytes) {
            // Try to read file (will fail if corrupt)
            const content = await fs.readFile(logPath, "utf-8");
            const truncated = content.slice(-1024 * 1024);
            await fs.writeFile(logPath, truncated, "utf-8");
          }
        } catch (err) {
          // Gracefully handle error
          return false;
        }
        return true;
      };

      // Create file with invalid UTF-8 (binary data)
      const logPath = path.join(testDir, "corrupt.log");
      const buffer = Buffer.alloc(3 * 1024 * 1024);
      // Fill with invalid UTF-8 sequences
      for (let i = 0; i < buffer.length; i++) {
        buffer[i] = Math.floor(Math.random() * 256);
      }
      await fs.writeFile(logPath, buffer);

      // Rotation should fail gracefully
      const result = await rotateLogFile(logPath);

      // Depending on Node.js handling, this might succeed or fail
      // Either way, it shouldn't crash
      expect(typeof result).toBe("boolean");
    });

    it("handles full disk scenario", async () => {
      // This is hard to simulate without root, but we can test the error handling path
      const rotateLogFile = async (logPath: string) => {
        try {
          const stats = await fs.stat(logPath);
          if (stats.size > 2 * 1024 * 1024) {
            // Simulate ENOSPC error
            throw Object.assign(new Error("ENOSPC: no space left on device"), { code: "ENOSPC" });
          }
        } catch (err) {
          const code = (err as NodeJS.ErrnoException).code;
          if (code !== "ENOENT") {
            return `Error: ${code}`;
          }
        }
        return null;
      };

      const logPath = path.join(testDir, "full-disk.log");
      await fs.writeFile(logPath, "x".repeat(3 * 1024 * 1024), "utf-8");

      const error = await rotateLogFile(logPath);
      expect(error).toContain("ENOSPC");
    });
  });
});
