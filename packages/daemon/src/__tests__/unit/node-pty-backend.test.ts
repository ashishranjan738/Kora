/**
 * Tests for NodePtyBackend — node-pty direct terminal backend.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

// Mock node-pty
const mockOnData = vi.fn();
const mockOnExit = vi.fn();
const mockWrite = vi.fn();
const mockKill = vi.fn();
const mockResize = vi.fn();

vi.mock("node-pty", () => ({
  spawn: vi.fn(() => ({
    pid: 12345,
    onData: (cb: Function) => {
      mockOnData(cb);
      return { dispose: vi.fn() };
    },
    onExit: mockOnExit,
    write: mockWrite,
    kill: mockKill,
    resize: mockResize,
  })),
}));

import { NodePtyBackend } from "../../core/node-pty-backend.js";

describe("NodePtyBackend", () => {
  let backend: NodePtyBackend;

  beforeEach(() => {
    vi.clearAllMocks();
    backend = new NodePtyBackend();
  });

  afterEach(async () => {
    await backend.destroyAll();
  });

  describe("newSession", () => {
    it("creates a new session", async () => {
      await backend.newSession("test-session");
      expect(await backend.hasSession("test-session")).toBe(true);
    });

    it("lists created sessions", async () => {
      await backend.newSession("s1");
      await backend.newSession("s2");
      const sessions = await backend.listSessions();
      expect(sessions).toContain("s1");
      expect(sessions).toContain("s2");
    });

    it("replaces existing session with same name", async () => {
      await backend.newSession("dup");
      await backend.newSession("dup");
      expect((await backend.listSessions()).filter(s => s === "dup")).toHaveLength(1);
    });
  });

  describe("sendKeys", () => {
    it("writes keys + Enter to PTY", async () => {
      await backend.newSession("s1");
      await backend.sendKeys("s1", "ls -la");
      expect(mockWrite).toHaveBeenCalledWith("ls -la\r");
    });

    it("throws for non-existent session", async () => {
      await expect(backend.sendKeys("nope", "test")).rejects.toThrow("not found");
    });
  });

  describe("sendRawInput", () => {
    it("writes raw data without Enter", async () => {
      await backend.newSession("s1");
      await backend.sendRawInput("s1", "\x03"); // Ctrl+C
      expect(mockWrite).toHaveBeenCalledWith("\x03");
    });
  });

  describe("capturePane", () => {
    it("returns empty for fresh session", async () => {
      await backend.newSession("s1");
      const output = await backend.capturePane("s1");
      expect(output).toBe("");
    });

    it("returns ring buffer content after data is written", async () => {
      await backend.newSession("s1");
      // Simulate PTY output by calling the onData callback
      const onDataCb = mockOnData.mock.calls[0][0];
      onDataCb("line1\nline2\nline3\n");
      const output = await backend.capturePane("s1", 2);
      expect(output).toBe("line2\nline3");
    });

    it("throws for non-existent session", async () => {
      await expect(backend.capturePane("nope")).rejects.toThrow("not found");
    });
  });

  describe("killSession", () => {
    it("removes session and kills PTY", async () => {
      await backend.newSession("s1");
      await backend.killSession("s1");
      expect(await backend.hasSession("s1")).toBe(false);
      expect(mockKill).toHaveBeenCalled();
    });

    it("is a no-op for non-existent session", async () => {
      await backend.killSession("nope"); // should not throw
    });
  });

  describe("getPanePID", () => {
    it("returns PID for active session", async () => {
      await backend.newSession("s1");
      expect(await backend.getPanePID("s1")).toBe(12345);
    });

    it("returns null for non-existent session", async () => {
      expect(await backend.getPanePID("nope")).toBeNull();
    });
  });

  describe("getBuffer", () => {
    it("returns ring buffer for session", async () => {
      await backend.newSession("s1");
      const buf = backend.getBuffer("s1");
      expect(buf).toBeDefined();
      expect(buf!.capacity).toBe(1000);
    });

    it("returns undefined for non-existent session", () => {
      expect(backend.getBuffer("nope")).toBeUndefined();
    });
  });

  describe("destroyAll", () => {
    it("kills all sessions", async () => {
      await backend.newSession("s1");
      await backend.newSession("s2");
      await backend.destroyAll();
      expect(await backend.listSessions()).toHaveLength(0);
    });
  });

  describe("getAttachCommand", () => {
    it("returns echo command for node-pty sessions", () => {
      const cmd = backend.getAttachCommand("test-session");
      expect(cmd.command).toBe("echo");
      expect(cmd.args[0]).toContain("node-pty-session:test-session");
    });
  });
});
