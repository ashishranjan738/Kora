/**
 * Tests for pty-manager.ts — PTY grace period on client disconnect.
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

describe("PtyManager", () => {
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

  it("should attach a client and create a PTY session", () => {
    const ws = createMockWs();
    const result = manager.attach("test-session", ws);
    expect(result).toBe(true);
    expect(manager.hasActiveSession("test-session")).toBe(true);
  });

  it("should start grace period on last client disconnect instead of killing immediately", () => {
    const ws = createMockWs();
    manager.attach("test-session", ws);

    // Simulate client disconnect
    ws.emit("close");

    // Session should still exist during grace period
    expect(manager.hasActiveSession("test-session")).toBe(true);
  });

  it("should kill PTY after grace period expires with no reconnect", () => {
    const ws = createMockWs();
    manager.attach("test-session", ws);

    ws.emit("close");

    // Advance past grace period (60s)
    vi.advanceTimersByTime(61_000);

    expect(manager.hasActiveSession("test-session")).toBe(false);
  });

  it("should cancel grace period if client reconnects within window", () => {
    const ws1 = createMockWs();
    manager.attach("test-session", ws1);

    ws1.emit("close");

    // Advance 30s (within 60s grace)
    vi.advanceTimersByTime(30_000);

    // New client reconnects
    const ws2 = createMockWs();
    manager.attach("test-session", ws2);

    // Advance past original grace period
    vi.advanceTimersByTime(40_000);

    // Session should still exist (grace was cancelled)
    expect(manager.hasActiveSession("test-session")).toBe(true);
  });

  it("should not kill PTY if other clients are still connected", () => {
    const ws1 = createMockWs();
    const ws2 = createMockWs();
    manager.attach("test-session", ws1);
    manager.attach("test-session", ws2);

    // Only one client disconnects
    ws1.emit("close");

    vi.advanceTimersByTime(61_000);

    // Session still alive because ws2 is connected
    expect(manager.hasActiveSession("test-session")).toBe(true);
  });

  it("destroyAll should clear grace timers", () => {
    const ws = createMockWs();
    manager.attach("test-session", ws);
    ws.emit("close");

    // Grace timer is active
    expect(manager.hasActiveSession("test-session")).toBe(true);

    manager.destroyAll();
    expect(manager.hasActiveSession("test-session")).toBe(false);
  });
});
