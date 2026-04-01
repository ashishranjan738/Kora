/**
 * Tests for PtyManager registerAgent/unregisterAgent (PR #525, task 3fe503ef).
 *
 * Verifies direct node-pty fan-out, catchup data, grace period skip,
 * and destroyAll behavior for registered sessions.
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
      _fireData: (data: string) => { listeners["data"]?.forEach(cb => cb(data)); },
      _fireExit: () => { listeners["exit"]?.forEach(cb => cb({ exitCode: 0, signal: 0 })); },
    };
  }),
}));

import { PtyManager } from "../../core/pty-manager.js";
import { EventEmitter } from "events";

function createMockPty(): any {
  const listeners: Record<string, Function[]> = {};
  return {
    onData: (cb: Function) => { (listeners["data"] ??= []).push(cb); },
    onExit: (cb: Function) => { (listeners["exit"] ??= []).push(cb); },
    write: vi.fn(),
    resize: vi.fn(),
    kill: vi.fn(),
    pid: 12345,
    _listeners: listeners,
    _fireData(data: string) { listeners["data"]?.forEach(cb => cb(data)); },
    _fireExit() { listeners["exit"]?.forEach(cb => cb({ exitCode: 0, signal: 0 })); },
  };
}

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

describe("PtyManager — registerAgent", () => {
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

  it("registers an agent PTY and makes session active", () => {
    const pty = createMockPty();
    manager.registerAgent("test-agent", pty);
    expect(manager.hasActiveSession("test-agent")).toBe(true);
  });

  it("fans out PTY data to connected WebSocket clients", () => {
    const pty = createMockPty();
    manager.registerAgent("test-agent", pty);

    const ws = createMockWs();
    manager.attach("test-agent", ws);

    // Simulate PTY output
    pty._fireData("Hello from PTY\r\n");

    expect(ws.send).toHaveBeenCalledWith("Hello from PTY\r\n");
  });

  it("fans out to multiple WebSocket clients", () => {
    const pty = createMockPty();
    manager.registerAgent("test-agent", pty);

    const ws1 = createMockWs();
    const ws2 = createMockWs();
    manager.attach("test-agent", ws1);
    manager.attach("test-agent", ws2);

    pty._fireData("broadcast\r\n");

    expect(ws1.send).toHaveBeenCalledWith("broadcast\r\n");
    expect(ws2.send).toHaveBeenCalledWith("broadcast\r\n");
  });

  it("sends catchup data to newly connecting clients", () => {
    const pty = createMockPty();
    const catchup = vi.fn(() => "previous output\r\nmore output\r\n");
    manager.registerAgent("test-agent", pty, catchup);

    const ws = createMockWs();
    manager.attach("test-agent", ws);

    // Catchup should have been called and sent to the new client
    expect(catchup).toHaveBeenCalled();
    expect(ws.send).toHaveBeenCalledWith("previous output\r\nmore output\r\n");
  });

  it("does not kill registered PTY on grace period expiry", () => {
    const pty = createMockPty();
    manager.registerAgent("test-agent", pty);

    const ws = createMockWs();
    manager.attach("test-agent", ws);

    // Disconnect client
    ws.emit("close");

    // Advance past grace period
    vi.advanceTimersByTime(61_000);

    // Session should still exist (registered = don't kill)
    expect(manager.hasActiveSession("test-agent")).toBe(true);
    expect(pty.kill).not.toHaveBeenCalled();
  });

  it("cleans up session on PTY exit", () => {
    const pty = createMockPty();
    manager.registerAgent("test-agent", pty);

    const ws = createMockWs();
    manager.attach("test-agent", ws);

    // Simulate PTY exit
    pty._fireExit();

    expect(manager.hasActiveSession("test-agent")).toBe(false);
    expect(ws.close).toHaveBeenCalled();
  });

  it("onExit guard prevents deleting re-registered session", () => {
    const pty1 = createMockPty();
    manager.registerAgent("test-agent", pty1);

    // Re-register with new PTY
    const pty2 = createMockPty();
    manager.registerAgent("test-agent", pty2);

    // Old PTY exits — should NOT delete the new session
    pty1._fireExit();

    expect(manager.hasActiveSession("test-agent")).toBe(true);
  });
});

describe("PtyManager — unregisterAgent", () => {
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

  it("removes registered session and closes clients", () => {
    const pty = createMockPty();
    manager.registerAgent("test-agent", pty);

    const ws = createMockWs();
    manager.attach("test-agent", ws);

    manager.unregisterAgent("test-agent");

    expect(manager.hasActiveSession("test-agent")).toBe(false);
    expect(ws.close).toHaveBeenCalled();
    expect(pty.kill).not.toHaveBeenCalled(); // Backend owns the PTY
  });

  it("is a no-op for non-registered sessions", () => {
    // Attach creates a non-registered session
    const ws = createMockWs();
    manager.attach("test-session", ws);

    manager.unregisterAgent("test-session");

    // Session should still exist (not registered, so unregister is a no-op)
    expect(manager.hasActiveSession("test-session")).toBe(true);
  });

  it("is a no-op for non-existent sessions", () => {
    // Should not throw
    manager.unregisterAgent("nonexistent");
  });
});

describe("PtyManager — destroyAll with registered sessions", () => {
  let manager: PtyManager;

  beforeEach(() => {
    vi.useFakeTimers();
    manager = new PtyManager();
    manager.setBackend(createMockBackend());
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("does not kill registered PTY processes on destroyAll", () => {
    const pty = createMockPty();
    manager.registerAgent("test-agent", pty);

    manager.destroyAll();

    expect(pty.kill).not.toHaveBeenCalled();
    expect(manager.hasActiveSession("test-agent")).toBe(false);
  });
});
