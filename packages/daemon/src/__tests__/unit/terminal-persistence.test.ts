/**
 * Unit tests for terminal persistence with socket verification
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import { verifySocketExists, restoreTerminalsWithHealthCheck } from "../../core/terminal-persistence.js";
import type { StandaloneTerminal } from "../../core/terminal-persistence.js";
import type { IPtyBackend } from "../../core/pty-backend.js";
import * as fs from "fs/promises";

vi.mock("fs/promises");
vi.mock("../../core/logger.js", () => ({
  logger: {
    debug: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    info: vi.fn(),
  },
}));

describe("Terminal Persistence with Socket Verification", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe("verifySocketExists", () => {
    it("should return true when socket file exists", async () => {
      const mockBackend: Partial<IPtyBackend> = {
        getSocketPathForSession: vi.fn().mockResolvedValue("/tmp/dt-1000/test-session.sock"),
      };

      vi.mocked(fs.access).mockResolvedValue(undefined);

      const result = await verifySocketExists(mockBackend as IPtyBackend, "test-session");

      expect(result).toBe(true);
      expect(mockBackend.getSocketPathForSession).toHaveBeenCalledWith("test-session");
      expect(fs.access).toHaveBeenCalledWith("/tmp/dt-1000/test-session.sock");
    });

    it("should return false when socket file does not exist", async () => {
      const mockBackend: Partial<IPtyBackend> = {
        getSocketPathForSession: vi.fn().mockResolvedValue("/tmp/dt-1000/test-session.sock"),
      };

      vi.mocked(fs.access).mockRejectedValue(new Error("ENOENT: no such file or directory"));

      const result = await verifySocketExists(mockBackend as IPtyBackend, "test-session");

      expect(result).toBe(false);
      expect(mockBackend.getSocketPathForSession).toHaveBeenCalledWith("test-session");
    });

    it("should return true for non-holdpty backends (no getSocketPathForSession)", async () => {
      const mockBackend: Partial<IPtyBackend> = {
        hasSession: vi.fn(),
        // No getSocketPathForSession method
      };

      const result = await verifySocketExists(mockBackend as IPtyBackend, "test-session");

      expect(result).toBe(true);
    });

    it("should return false when getSocketPathForSession throws", async () => {
      const mockBackend: Partial<IPtyBackend> = {
        getSocketPathForSession: vi.fn().mockRejectedValue(new Error("Socket dir not found")),
      };

      const result = await verifySocketExists(mockBackend as IPtyBackend, "test-session");

      expect(result).toBe(false);
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

    it("should restore all terminals when sessions exist and sockets are valid", async () => {
      const mockBackend: Partial<IPtyBackend> = {
        hasSession: vi.fn().mockResolvedValue(true),
        getSocketPathForSession: vi.fn().mockImplementation((name) =>
          Promise.resolve(`/tmp/dt-1000/${name}.sock`)
        ),
      };

      vi.mocked(fs.access).mockResolvedValue(undefined);

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
        getSocketPathForSession: vi.fn().mockImplementation((name) =>
          Promise.resolve(`/tmp/dt-1000/${name}.sock`)
        ),
      };

      vi.mocked(fs.access).mockResolvedValue(undefined);

      const result = await restoreTerminalsWithHealthCheck(
        mockBackend as IPtyBackend,
        mockTerminals,
        "session-id",
      );

      expect(result.alive).toHaveLength(2);
      expect(result.dead).toHaveLength(1);
      expect(result.dead[0].id).toBe("term-2");
    });

    it("should mark terminals as dead when socket file is missing", async () => {
      const mockBackend: Partial<IPtyBackend> = {
        hasSession: vi.fn().mockResolvedValue(true),
        getSocketPathForSession: vi.fn().mockImplementation((name) =>
          Promise.resolve(`/tmp/dt-1000/${name}.sock`)
        ),
      };

      // session-1: socket exists
      // session-2: socket missing (ENOENT)
      // session-3: socket exists
      vi.mocked(fs.access)
        .mockResolvedValueOnce(undefined)
        .mockRejectedValueOnce(new Error("ENOENT"))
        .mockResolvedValueOnce(undefined);

      const result = await restoreTerminalsWithHealthCheck(
        mockBackend as IPtyBackend,
        mockTerminals,
        "session-id",
      );

      expect(result.alive).toHaveLength(2);
      expect(result.dead).toHaveLength(1);
      expect(result.dead[0].id).toBe("term-2");
    });

    it("should mark terminals as dead when socket verification fails", async () => {
      const mockBackend: Partial<IPtyBackend> = {
        hasSession: vi.fn().mockResolvedValue(true),
        getSocketPathForSession: vi.fn()
          .mockResolvedValueOnce("/tmp/dt-1000/session-1.sock")
          .mockRejectedValueOnce(new Error("Socket dir not found"))  // session-2 throws
          .mockResolvedValueOnce("/tmp/dt-1000/session-3.sock"),
      };

      vi.mocked(fs.access)
        .mockResolvedValueOnce(undefined)
        .mockResolvedValueOnce(undefined);

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
        getSocketPathForSession: vi.fn().mockImplementation((name) =>
          Promise.resolve(`/tmp/dt-1000/${name}.sock`)
        ),
      };

      vi.mocked(fs.access).mockResolvedValue(undefined);

      const result = await restoreTerminalsWithHealthCheck(
        mockBackend as IPtyBackend,
        mockTerminals,
        "session-id",
      );

      expect(result.alive).toHaveLength(2);
      expect(result.dead).toHaveLength(1);
      expect(result.dead[0].id).toBe("term-2");
    });

    it("should work with non-holdpty backends (no socket verification)", async () => {
      const mockBackend: Partial<IPtyBackend> = {
        hasSession: vi.fn().mockResolvedValue(true),
        // No getSocketPathForSession method
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
