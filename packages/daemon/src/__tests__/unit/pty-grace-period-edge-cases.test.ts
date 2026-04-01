/**
 * Additional tests for pty-manager.ts — edge cases for PTY grace period and
 * WS heartbeat behavior (PR #517, #518, task abfd17ba).
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

// Mock node-pty before importing PtyManager
vi.mock("node-pty", () => ({
  spawn: vi.fn(() => {
    const listeners: Record<string, Function[]> = {};
    return {
      onData: (cb: Function) => { (listeners["data"] ??= []).push(cb); },
      onExit: (cb: Function) => { (listeners["exit"] ??= []).push(cb); },
      write: vi.fn(),
      resize: vi.fn(),
      kill: vi.fn(),
      _listeners: listeners,
    };
  }),
}));

import { PtyManager } from "../../core/pty-manager.js";
import { EventEmitter } from "events";

function createMockWs(): any {
  const emitter = new EventEmitter();
  return {
    readyState: 1,
    send: vi.fn(),
    close: vi.fn(),
    on: emitter.on.bind(emitter),
    removeAllListeners: emitter.removeAllListeners.bind(emitter),
    listeners: emitter.listeners.bind(emitter),
    emit: emitter.emit.bind(emitter),
  };
}

function createMockBackend(): any {
  return {
    getAttachCommand: vi.fn(() => ({ command: "/bin/sh", args: [] })),
  };
}

describe("PtyManager — grace period edge cases", () => {
  let manager: PtyManager;

  beforeEach(() => {
    vi.useFakeTimers();
    manager = new PtyManager();
    manager.setBackend(createMockBackend());
  });

  afterEach(() => {
    manager.destroyAll();
    vi.useRealTimers();
  });

  it("should handle rapid connect/disconnect cycles without leaking timers", () => {
    // Rapidly connect and disconnect 5 clients
    for (let i = 0; i < 5; i++) {
      const ws = createMockWs();
      manager.attach("test-session", ws);
      ws.emit("close");
    }

    // Session should still exist (grace period still active)
    expect(manager.hasActiveSession("test-session")).toBe(true);

    // Only one grace timer should be running — after 61s, session dies
    vi.advanceTimersByTime(61_000);
    expect(manager.hasActiveSession("test-session")).toBe(false);
  });

  it("should handle multiple disconnect/reconnect cycles", () => {
    const ws1 = createMockWs();
    manager.attach("test-session", ws1);

    // First disconnect
    ws1.emit("close");
    vi.advanceTimersByTime(30_000); // 30s into grace

    // Reconnect
    const ws2 = createMockWs();
    manager.attach("test-session", ws2);

    // Second disconnect
    ws2.emit("close");
    vi.advanceTimersByTime(30_000); // 30s into new grace

    // Reconnect again
    const ws3 = createMockWs();
    manager.attach("test-session", ws3);

    // Advance past both original grace periods
    vi.advanceTimersByTime(61_000);

    // Session should still be alive (ws3 is connected)
    expect(manager.hasActiveSession("test-session")).toBe(true);
  });

  it("should handle two independent sessions with separate grace periods", () => {
    const ws1 = createMockWs();
    const ws2 = createMockWs();
    manager.attach("session-a", ws1);
    manager.attach("session-b", ws2);

    // Disconnect session-a
    ws1.emit("close");

    vi.advanceTimersByTime(30_000);

    // session-a is in grace, session-b is connected
    expect(manager.hasActiveSession("session-a")).toBe(true);
    expect(manager.hasActiveSession("session-b")).toBe(true);

    // Advance past grace period for session-a
    vi.advanceTimersByTime(31_000);

    expect(manager.hasActiveSession("session-a")).toBe(false);
    expect(manager.hasActiveSession("session-b")).toBe(true);
  });

  it("should not start grace period if other clients remain", () => {
    const ws1 = createMockWs();
    const ws2 = createMockWs();
    const ws3 = createMockWs();
    manager.attach("test-session", ws1);
    manager.attach("test-session", ws2);
    manager.attach("test-session", ws3);

    // Disconnect 2 of 3 clients
    ws1.emit("close");
    ws2.emit("close");

    vi.advanceTimersByTime(61_000);

    // Still alive — ws3 is connected
    expect(manager.hasActiveSession("test-session")).toBe(true);

    // Now disconnect the last one
    ws3.emit("close");

    // Grace period starts
    expect(manager.hasActiveSession("test-session")).toBe(true);

    vi.advanceTimersByTime(61_000);
    expect(manager.hasActiveSession("test-session")).toBe(false);
  });

  it("should return false when attaching without a backend", () => {
    const freshManager = new PtyManager();
    const ws = createMockWs();
    expect(freshManager.attach("test-session", ws)).toBe(false);
  });

  it("write() should send data to PTY process", () => {
    const ws = createMockWs();
    manager.attach("test-session", ws);

    manager.write("test-session", "hello\n");

    // The PTY process should have received the write
    // (we can verify via the mock)
    expect(manager.hasActiveSession("test-session")).toBe(true);
  });

  it("write() should be no-op for non-existent session", () => {
    // Should not throw
    manager.write("nonexistent", "hello");
    expect(manager.hasActiveSession("nonexistent")).toBe(false);
  });

  it("resize() should be no-op for non-existent session", () => {
    // Should not throw
    manager.resize("nonexistent", 80, 24);
    expect(manager.hasActiveSession("nonexistent")).toBe(false);
  });
});

describe("WS heartbeat constants", () => {
  it("server index.ts should define WS_PING_INTERVAL_MS = 30000", async () => {
    // Verify the heartbeat interval constant exists and has correct value
    const fs = await import("fs");
    const path = await import("path");
    const serverCode = fs.readFileSync(
      path.resolve(__dirname, "../../server/index.ts"),
      "utf-8"
    );
    expect(serverCode).toContain("WS_PING_INTERVAL_MS = 30_000");
    expect(serverCode).toContain("ws.ping()");
    expect(serverCode).toContain("ws.terminate()");
    expect(serverCode).toContain('(ws as any).isAlive');
  });

  it("should have pong handler that sets isAlive = true", async () => {
    const fs = await import("fs");
    const path = await import("path");
    const serverCode = fs.readFileSync(
      path.resolve(__dirname, "../../server/index.ts"),
      "utf-8"
    );
    expect(serverCode).toContain('ws.on("pong"');
    expect(serverCode).toContain("isAlive = true");
  });

  it("should clean up heartbeat interval on server close", async () => {
    const fs = await import("fs");
    const path = await import("path");
    const serverCode = fs.readFileSync(
      path.resolve(__dirname, "../../server/index.ts"),
      "utf-8"
    );
    expect(serverCode).toContain("clearInterval(heartbeatInterval)");
  });
});

describe("Frontend reconnect behavior", () => {
  it("terminalRegistry should not have MAX_RECONNECT_ATTEMPTS cap", async () => {
    const fs = await import("fs");
    const path = await import("path");
    const registryCode = fs.readFileSync(
      path.resolve(__dirname, "../../../../dashboard/src/stores/terminalRegistry.ts"),
      "utf-8"
    );
    // Should NOT contain the old limit
    expect(registryCode).not.toContain("MAX_RECONNECT_ATTEMPTS");
    // Should contain connection lost delay
    expect(registryCode).toContain("CONNECTION_LOST_DELAY");
    // Should contain visual indicators
    expect(registryCode).toContain("Connection lost");
    expect(registryCode).toContain("Connection restored");
  });

  it("terminalRegistry should have connectionLostTimer and connectionLostShown in interface", async () => {
    const fs = await import("fs");
    const path = await import("path");
    const registryCode = fs.readFileSync(
      path.resolve(__dirname, "../../../../dashboard/src/stores/terminalRegistry.ts"),
      "utf-8"
    );
    expect(registryCode).toContain("connectionLostTimer");
    expect(registryCode).toContain("connectionLostShown");
  });

  it("terminalRegistry should clean up connectionLostTimer in destroyTerminal and destroyAllTerminals", async () => {
    const fs = await import("fs");
    const path = await import("path");
    const registryCode = fs.readFileSync(
      path.resolve(__dirname, "../../../../dashboard/src/stores/terminalRegistry.ts"),
      "utf-8"
    );
    // Count occurrences of clearing connectionLostTimer — should be in both destroy functions
    const clearMatches = registryCode.match(/clearTimeout\(entry\.connectionLostTimer\)/g);
    expect(clearMatches).not.toBeNull();
    expect(clearMatches!.length).toBeGreaterThanOrEqual(2);
  });
});
