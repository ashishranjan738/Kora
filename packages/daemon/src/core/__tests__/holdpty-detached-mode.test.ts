import { describe, it, expect, vi, beforeEach } from "vitest";

// ---------------------------------------------------------------------------
// Mocks
// ---------------------------------------------------------------------------

vi.mock("child_process", () => ({
  execFile: vi.fn((cmd: string, args: string[], callback: any) => {
    callback(null, { stdout: "holdpty 0.1.0\n", stderr: "" });
  }),
  spawn: vi.fn().mockReturnValue({ unref: vi.fn() }),
}));

vi.mock("fs", () => ({
  promises: {
    access: vi.fn(),
  },
  openSync: vi.fn().mockReturnValue(3),
  existsSync: vi.fn().mockReturnValue(false),
  unlinkSync: vi.fn(),
}));

vi.mock("net", () => {
  const EventEmitter = require("events");
  return {
    createConnection: vi.fn().mockImplementation((path: string, onConnect: () => void) => {
      const socket = new EventEmitter();
      (socket as any).write = vi.fn();
      (socket as any).destroy = vi.fn();
      // Auto-trigger connection and HELLO_ACK response
      setImmediate(() => {
        if (onConnect) onConnect();
        // Send HELLO_ACK frame after connection
        setTimeout(() => {
          const helloAckFrame = Buffer.from([1, 0, 0, 0, 0]); // MSG.HELLO_ACK
          socket.emit("data", helloAckFrame);
        }, 10);
      });
      return socket;
    }),
  };
});

const mockSession = {
  isSessionActive: vi.fn().mockResolvedValue(true),
  listSessions: vi.fn().mockResolvedValue([{ name: "test-session" }]),
  readMetadata: vi.fn().mockReturnValue({ childPid: 12345 }),
};

const mockProtocol = {
  MSG: {
    HELLO_ACK: 1,
    DATA_OUT: 2,
    REPLAY_END: 3,
    ERROR: 5,
  },
  encodeHello: vi.fn().mockReturnValue(Buffer.from([1, 0, 0, 0, 0])),
  encodeDataIn: vi.fn((buf: Buffer) => Buffer.concat([Buffer.from([4, 0, 0, 0, buf.length]), buf])),
  encodeResize: vi.fn((cols: number, rows: number) =>
    Buffer.from([5, 0, 0, 0, 8, cols >> 8, cols & 0xff, rows >> 8, rows & 0xff])
  ),
  FrameDecoder: class {
    decode() { return []; }
  },
};

const mockPlatform = {
  getSessionDir: vi.fn().mockReturnValue("/tmp/holdpty-test"),
  socketPath: vi.fn((_dir: string, name: string) => `/tmp/holdpty-test/${name}.sock`),
};

vi.mock("holdpty/dist/session.js", () => mockSession);
vi.mock("holdpty/dist/protocol.js", () => mockProtocol);
vi.mock("holdpty/dist/platform.js", () => mockPlatform);

// ---------------------------------------------------------------------------
// Import after mocks
// ---------------------------------------------------------------------------

import { HoldptyController } from "../holdpty-controller.js";
import * as childProcess from "child_process";
import * as fs from "fs";
import * as net from "net";

// Mock PtyManager
class MockPtyManager {
  private activeSessions = new Set<string>();

  addSession(name: string) {
    this.activeSessions.add(name);
  }

  removeSession(name: string) {
    this.activeSessions.delete(name);
  }

  hasActiveSession(sessionName: string): boolean {
    return this.activeSessions.has(sessionName);
  }

  write = vi.fn();
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("HoldptyController detached mode", () => {
  let controller: HoldptyController;
  let mockExecFile: any;
  let mockAccess: any;

  beforeEach(() => {
    vi.clearAllMocks();
    controller = new HoldptyController();

    // Get mock references
    mockExecFile = vi.mocked(childProcess.execFile);
    mockAccess = vi.mocked(fs.promises.access);

    // Mock socket to exist after first access check
    mockAccess
      .mockRejectedValueOnce(new Error("ENOENT"))
      .mockResolvedValue(undefined);
  });

  // Test 1: newSession spawns detached with --bg flag
  it("spawns detached session with holdpty launch --bg", async () => {
    await controller.newSession("my-session");

    // Verify holdpty launch --bg was called
    expect(mockExecFile).toHaveBeenCalledWith(
      "npx",
      expect.arrayContaining(["holdpty", "launch", "--bg", "--name", "my-session"]),
      expect.any(Function)
    );
  });

  // Test 2: newSession waits for socket creation
  it("waits for socket file to be created before returning", async () => {
    // Socket appears after 2 failed checks
    mockAccess
      .mockRejectedValueOnce(new Error("ENOENT"))
      .mockRejectedValueOnce(new Error("ENOENT"))
      .mockResolvedValue(undefined);

    const startTime = Date.now();
    await controller.newSession("my-session");
    const elapsed = Date.now() - startTime;

    // Should have polled multiple times (at least 100ms with 50ms intervals)
    expect(elapsed).toBeGreaterThanOrEqual(100);
    expect(mockAccess).toHaveBeenCalledWith("/tmp/holdpty-test/my-session.sock");
  });

  // Test 3: resize sends RESIZE protocol frame via socket
  it("sends RESIZE frame via socket protocol", async () => {
    await controller.newSession("my-session");

    // Clear previous calls from newSession
    vi.clearAllMocks();

    await controller.resize("my-session", 120, 40);

    // Verify RESIZE frame was encoded
    expect(mockProtocol.encodeResize).toHaveBeenCalledWith(120, 40);

    // Verify socket connection was made
    expect(net.createConnection).toHaveBeenCalledWith(
      "/tmp/holdpty-test/my-session.sock",
      expect.any(Function)
    );
  });

  // Test 4: killSession uses CLI stop command
  it("kills session via CLI stop command (not direct process kill)", async () => {
    await controller.killSession("my-session");

    // Verify holdpty stop was called
    expect(mockExecFile).toHaveBeenCalledWith(
      "npx",
      ["holdpty", "stop", "my-session"],
      expect.any(Function)
    );
  });

  // Test 5: sendKeys routes through PtyManager when dashboard is connected
  it("routes sendKeys through PtyManager when dashboard terminal is active", async () => {
    const ptyManager = new MockPtyManager();
    ptyManager.addSession("my-session");
    controller.setPtyManager(ptyManager as any);

    await controller.sendKeys("my-session", "echo hello");

    // Verify write was called via PtyManager, not socket
    expect(ptyManager.write).toHaveBeenCalledWith("my-session", "echo hello\r");

    // Socket connection should NOT have been attempted
    const netCalls = vi.mocked(net.createConnection).mock.calls;
    const sendKeyCalls = netCalls.filter((call: any) =>
      call[0] === "/tmp/holdpty-test/my-session.sock"
    );
    expect(sendKeyCalls.length).toBe(0);
  });

  // Test 6: sendKeys falls back to socket when no dashboard connection
  it("uses socket attach for sendKeys when no dashboard terminal", async () => {
    const ptyManager = new MockPtyManager();
    // Don't add my-session, so hasActiveSession returns false
    controller.setPtyManager(ptyManager as any);

    await controller.sendKeys("my-session", "echo test");

    // PtyManager write should NOT be called
    expect(ptyManager.write).not.toHaveBeenCalled();

    // Socket connection SHOULD be used
    expect(net.createConnection).toHaveBeenCalledWith(
      "/tmp/holdpty-test/my-session.sock",
      expect.any(Function)
    );

    // DATA_IN frame should be encoded
    expect(mockProtocol.encodeDataIn).toHaveBeenCalledWith(
      Buffer.from("echo test\r", "utf-8")
    );
  });

  // Test 7: setEnvironment sends export command for existing sessions
  it("injects env vars via export command for already-running sessions", async () => {
    // Mock session as already existing
    mockSession.isSessionActive.mockResolvedValueOnce(true);

    // Track sendKeys calls
    const sendKeysSpy = vi.spyOn(controller, "sendKeys");

    await controller.setEnvironment("my-session", "API_KEY", "secret123");

    // Verify export command was sent
    expect(sendKeysSpy).toHaveBeenCalledWith(
      "my-session",
      'export API_KEY="secret123"',
      { literal: false }
    );
  });

  // Test 8: Session survives process exit (detached mode)
  it("verifies session remains active after spawning (detached --bg)", async () => {
    mockSession.isSessionActive.mockResolvedValueOnce(true);

    await controller.newSession("my-session");

    // Simulate process restart by creating new controller instance
    const newController = new HoldptyController();

    // Check if session is still active
    const isActive = await newController.hasSession("my-session");

    expect(isActive).toBe(true);
    expect(mockSession.isSessionActive).toHaveBeenCalledWith("my-session");
  });

  // Test 9: sendKeys with literal:true still appends Enter (fixes MCP notification bug)
  it("appends Enter (\\r) even when literal:true — fixes MCP notification delivery", async () => {
    const ptyManager = new MockPtyManager();
    ptyManager.addSession("my-session");
    controller.setPtyManager(ptyManager as any);

    const notification = "[New message from Architect. Use check_messages tool to read it.]";
    await controller.sendKeys("my-session", notification, { literal: true });

    // Must include \r so Claude Code processes the notification
    expect(ptyManager.write).toHaveBeenCalledWith("my-session", notification + "\r");
  });

  // Test 10: sendRawInput does NOT append Enter (for interactive terminal input)
  it("sendRawInput does not append Enter — for xterm.js keystroke forwarding", async () => {
    const ptyManager = new MockPtyManager();
    ptyManager.addSession("my-session");
    controller.setPtyManager(ptyManager as any);

    await controller.sendRawInput("my-session", "a");

    // Raw input should NOT have \r appended
    expect(ptyManager.write).toHaveBeenCalledWith("my-session", "a");
  });

  // Test 11: sendRawInput falls back to socket without Enter
  it("sendRawInput uses socket without appending Enter when no dashboard", async () => {
    const ptyManager = new MockPtyManager();
    controller.setPtyManager(ptyManager as any);

    await controller.sendRawInput("my-session", "partial text");

    // PtyManager write should NOT be called (no active session)
    expect(ptyManager.write).not.toHaveBeenCalled();

    // Socket connection SHOULD be used
    expect(net.createConnection).toHaveBeenCalledWith(
      "/tmp/holdpty-test/my-session.sock",
      expect.any(Function)
    );

    // DATA_IN frame should contain raw text WITHOUT \r
    expect(mockProtocol.encodeDataIn).toHaveBeenCalledWith(
      Buffer.from("partial text", "utf-8")
    );
  });

  // Bonus test: verify env vars are applied during launch
  it("applies stored env vars during newSession via env command", async () => {
    await controller.setEnvironment("my-session", "FOO", "bar");
    await controller.setEnvironment("my-session", "BAZ", "qux");

    // Mock session as not existing yet
    mockSession.isSessionActive.mockResolvedValue(false);

    await controller.newSession("my-session");

    // Verify env command was used
    expect(mockExecFile).toHaveBeenCalledWith(
      "npx",
      expect.arrayContaining([
        "holdpty", "launch", "--bg", "--name", "my-session", "--",
        "env", "FOO=bar", "BAZ=qux"
      ]),
      expect.any(Function)
    );
  });
});
