/**
 * Unit tests for terminal persistence
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import { verifySocketExists, restoreTerminalsWithHealthCheck } from "../../core/terminal-persistence.js";
import type { StandaloneTerminal } from "../../core/terminal-persistence.js";
import type { IPtyBackend } from "../../core/pty-backend.js";

vi.mock("fs/promises");
vi.mock("../../core/logger.js", () => ({
  logger: {
    debug: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    info: vi.fn(),
  },
}));

describe("Terminal Persistence", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe("verifySocketExists", () => {
    it("should always return true (socket verification removed)", async () => {
      const mockBackend: Partial<IPtyBackend> = {
        hasSession: vi.fn(),
      };

      const result = await verifySocketExists(mockBackend as IPtyBackend, "test-session");
      expect(result).toBe(true);
    });
  });

  describe("restoreTerminalsWithHealthCheck", () => {
    const mockTerminals: StandaloneTerminal[] = [
      {
        id: "term-1",
        terminalSession: "session-1",
        name: "Terminal 1",
        createdAt: "2026-03-19T00:00:00Z",
        projectPath: "/project",
      },
      {
        id: "term-2",
        terminalSession: "session-2",
        name: "Terminal 2",
        createdAt: "2026-03-19T00:00:00Z",
        projectPath: "/project",
      },
      {
        id: "term-3",
        terminalSession: "session-3",
        name: "Terminal 3",
        createdAt: "2026-03-19T00:00:00Z",
        projectPath: "/project",
      },
    ];

    it("should restore all terminals when sessions exist", async () => {
      const mockBackend: Partial<IPtyBackend> = {
        hasSession: vi.fn().mockResolvedValue(true),
      };

      const result = await restoreTerminalsWithHealthCheck(
        mockBackend as IPtyBackend,
        mockTerminals,
        "session-id",
      );

      expect(result.alive).toHaveLength(3);
      expect(result.dead).toHaveLength(0);
      expect(mockBackend.hasSession).toHaveBeenCalledTimes(3);
    });

    it("should mark terminals as dead when session does not exist", async () => {
      const mockBackend: Partial<IPtyBackend> = {
        hasSession: vi.fn()
          .mockResolvedValueOnce(true)   // session-1 exists
          .mockResolvedValueOnce(false)  // session-2 does not exist
          .mockResolvedValueOnce(true),  // session-3 exists
      };

      const result = await restoreTerminalsWithHealthCheck(
        mockBackend as IPtyBackend,
        mockTerminals,
        "session-id",
      );

      expect(result.alive).toHaveLength(2);
      expect(result.dead).toHaveLength(1);
      expect(result.dead[0].id).toBe("term-2");
    });

    it("should handle errors during health check gracefully", async () => {
      const mockBackend: Partial<IPtyBackend> = {
        hasSession: vi.fn()
          .mockResolvedValueOnce(true)
          .mockRejectedValueOnce(new Error("hasSession failed"))  // session-2 throws
          .mockResolvedValueOnce(true),
      };

      const result = await restoreTerminalsWithHealthCheck(
        mockBackend as IPtyBackend,
        mockTerminals,
        "session-id",
      );

      expect(result.alive).toHaveLength(2);
      expect(result.dead).toHaveLength(1);
      expect(result.dead[0].id).toBe("term-2");
    });

    it("should return empty arrays for empty input", async () => {
      const mockBackend: Partial<IPtyBackend> = {
        hasSession: vi.fn(),
      };

      const result = await restoreTerminalsWithHealthCheck(
        mockBackend as IPtyBackend,
        [],
        "session-id",
      );

      expect(result.alive).toHaveLength(0);
      expect(result.dead).toHaveLength(0);
      expect(mockBackend.hasSession).not.toHaveBeenCalled();
    });
  });
});
