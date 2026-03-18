import { describe, it, expect, vi, beforeEach } from "vitest";

// ---------------------------------------------------------------------------
// Mocks
// ---------------------------------------------------------------------------

const OPEN = 1;

vi.mock("ws", () => {
  class MockWebSocket {
    static OPEN = 1;
    readyState = 1;
    send = vi.fn();
    close = vi.fn();
    on = vi.fn();
  }
  return { WebSocket: MockWebSocket };
});

vi.mock("fs", () => ({
  default: {
    promises: {
      unlink: vi.fn().mockResolvedValue(undefined),
    },
    FSWatcher: class {},
  },
}));

// ---------------------------------------------------------------------------
// Import after mocks
// ---------------------------------------------------------------------------

import { WebSocket } from "ws";
import { TerminalStream, TerminalStreamManager } from "../terminal-stream.js";
import {
  TERMINAL_RING_BUFFER_LINES,
  MAX_TERMINAL_CONNECTIONS_PER_AGENT,
} from "@kora/shared";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function createMockWs(): WebSocket {
  return new WebSocket(null as any) as any;
}

// ---------------------------------------------------------------------------
// Tests — Shared constants
// ---------------------------------------------------------------------------

describe("Terminal scrollback constants", () => {
  it("TERMINAL_RING_BUFFER_LINES equals 100000", () => {
    expect(TERMINAL_RING_BUFFER_LINES).toBe(100_000);
  });

  it("MAX_TERMINAL_CONNECTIONS_PER_AGENT equals 3", () => {
    expect(MAX_TERMINAL_CONNECTIONS_PER_AGENT).toBe(3);
  });

  it("terminal-stream.ts imports TERMINAL_RING_BUFFER_LINES from @kora/shared (not hardcoded)", async () => {
    // Read the source file and verify it imports the constant
    const fs = await import("node:fs/promises");
    const path = await import("node:path");
    const sourceFile = path.resolve(
      __dirname,
      "..",
      "terminal-stream.ts",
    );
    let source: string;
    try {
      source = await fs.readFile(sourceFile, "utf-8");
    } catch {
      // Fallback: check .js dist file
      const distFile = path.resolve(
        __dirname,
        "..",
        "terminal-stream.js",
      );
      source = await fs.readFile(distFile, "utf-8");
    }
    expect(source).toContain("TERMINAL_RING_BUFFER_LINES");
    expect(source).toContain("@kora/shared");
  });
});

// ---------------------------------------------------------------------------
// Tests — TerminalStream
// ---------------------------------------------------------------------------

describe("TerminalStream", () => {
  let stream: TerminalStream;

  beforeEach(() => {
    vi.clearAllMocks();
    stream = new TerminalStream("agent-1", "/tmp/pipes");
  });

  it("starts with zero connected clients", () => {
    expect(stream.clientCount).toBe(0);
  });

  it("addClient sends catchup buffer and increments client count", () => {
    const ws = createMockWs();
    const result = stream.addClient(ws);

    expect(result).toBe(true);
    expect(stream.clientCount).toBe(1);
    expect(ws.send).toHaveBeenCalledWith(
      expect.stringContaining('"type":"catchup"'),
    );
  });

  it("addClient registers close handler to remove client", () => {
    const ws = createMockWs();
    stream.addClient(ws);

    expect(ws.on).toHaveBeenCalledWith("close", expect.any(Function));
  });

  it("rejects clients beyond MAX_TERMINAL_CONNECTIONS_PER_AGENT", () => {
    // Add max number of clients
    for (let i = 0; i < MAX_TERMINAL_CONNECTIONS_PER_AGENT; i++) {
      const ws = createMockWs();
      expect(stream.addClient(ws)).toBe(true);
    }

    // Next one should be rejected
    const extraWs = createMockWs();
    expect(stream.addClient(extraWs)).toBe(false);
    expect(stream.clientCount).toBe(MAX_TERMINAL_CONNECTIONS_PER_AGENT);
  });

  it("destroy closes all clients and resets count", async () => {
    const ws1 = createMockWs();
    const ws2 = createMockWs();
    stream.addClient(ws1);
    stream.addClient(ws2);

    await stream.destroy();

    expect(ws1.close).toHaveBeenCalled();
    expect(ws2.close).toHaveBeenCalled();
    expect(stream.clientCount).toBe(0);
  });

  it("stopReading is safe to call when no watcher exists", () => {
    expect(() => stream.stopReading()).not.toThrow();
  });
});

// ---------------------------------------------------------------------------
// Tests — TerminalStreamManager
// ---------------------------------------------------------------------------

describe("TerminalStreamManager", () => {
  let manager: TerminalStreamManager;

  beforeEach(() => {
    vi.clearAllMocks();
    manager = new TerminalStreamManager("/tmp/pipes");
  });

  it("createStream returns a TerminalStream and stores it", async () => {
    const stream = await manager.createStream("agent-1");
    expect(stream).toBeInstanceOf(TerminalStream);
    expect(manager.getStream("agent-1")).toBe(stream);
  });

  it("getStream returns undefined for unknown agent", () => {
    expect(manager.getStream("nonexistent")).toBeUndefined();
  });

  it("removeStream destroys and deletes the stream", async () => {
    const stream = await manager.createStream("agent-1");
    const ws = createMockWs();
    stream.addClient(ws);

    await manager.removeStream("agent-1");

    expect(ws.close).toHaveBeenCalled();
    expect(manager.getStream("agent-1")).toBeUndefined();
  });

  it("removeStream is safe for unknown agent", async () => {
    await expect(manager.removeStream("nonexistent")).resolves.not.toThrow();
  });

  it("destroyAll removes all streams", async () => {
    await manager.createStream("agent-1");
    await manager.createStream("agent-2");

    await manager.destroyAll();

    expect(manager.getStream("agent-1")).toBeUndefined();
    expect(manager.getStream("agent-2")).toBeUndefined();
  });
});
