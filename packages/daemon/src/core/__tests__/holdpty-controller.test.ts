import { describe, it, expect, vi, beforeEach } from "vitest";

// ---------------------------------------------------------------------------
// Mocks
// ---------------------------------------------------------------------------

const mockHolderInstance = {
  ptyProcess: {
    write: vi.fn(),
  },
  kill: vi.fn(),
};

const mockHolderStart = vi.fn().mockResolvedValue(mockHolderInstance);

const mockHolder = {
  start: mockHolderStart,
};

const mockSession = {
  isSessionActive: vi.fn().mockResolvedValue(true),
  listSessions: vi.fn().mockResolvedValue([{ name: "test-session" }]),
  readMetadata: vi.fn().mockReturnValue({ childPid: 12345, pid: 12340 }),
};

const mockProtocol = {
  MSG: {
    HELLO_ACK: 1,
    DATA_OUT: 2,
    REPLAY_END: 3,
  },
  encodeHello: vi.fn().mockReturnValue(Buffer.from([1, 0, 0, 0, 0])),
  encodeDataIn: vi.fn((buf: Buffer) => Buffer.concat([Buffer.from([4, 0, 0, 0, buf.length]), buf])),
  FrameDecoder: class {
    decode() {
      return [];
    }
  },
};

const mockPlatform = {
  getSessionDir: vi.fn().mockReturnValue("/tmp/holdpty-test"),
  socketPath: vi.fn((_dir: string, name: string) => `/tmp/holdpty-test/${name}.sock`),
};

vi.mock("holdpty/dist/holder.js", () => ({ Holder: mockHolder }));
vi.mock("holdpty/dist/session.js", () => mockSession);
vi.mock("holdpty/dist/protocol.js", () => mockProtocol);
vi.mock("holdpty/dist/platform.js", () => mockPlatform);

vi.mock("child_process", () => ({
  execFile: vi.fn(),
  spawn: vi.fn().mockReturnValue({
    unref: vi.fn(),
  }),
}));

// ---------------------------------------------------------------------------
// Import after mocks
// ---------------------------------------------------------------------------

import { HoldptyController } from "../holdpty-controller.js";

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("HoldptyController", () => {
  let controller: HoldptyController;

  beforeEach(() => {
    vi.clearAllMocks();
    controller = new HoldptyController();
  });

  // Test 1: newSession passes cols/rows to Holder
  it("passes cols and rows to Holder.start when creating a session", async () => {
    await controller.newSession("my-session", 120, 40);

    expect(mockHolderStart).toHaveBeenCalledWith(
      expect.objectContaining({
        name: "my-session",
        cols: 120,
        rows: 40,
      })
    );
  });

  // Test 2: setEnvironment env vars passed to Holder.start
  it("passes environment variables to Holder.start", async () => {
    await controller.setEnvironment("my-session", "FOO", "bar");
    await controller.setEnvironment("my-session", "BAZ", "qux");

    await controller.newSession("my-session");

    expect(mockHolderStart).toHaveBeenCalledWith(
      expect.objectContaining({
        env: expect.objectContaining({
          FOO: "bar",
          BAZ: "qux",
        }),
      })
    );
  });

  // Test 3: sendKeys uses direct PTY write for in-process sessions
  it("uses direct PTY write for sessions spawned by this controller", async () => {
    await controller.newSession("test-session");

    mockHolderInstance.ptyProcess.write.mockClear();

    await controller.sendKeys("test-session", "echo test");

    // Should use the in-process holder's ptyProcess.write
    expect(mockHolderInstance.ptyProcess.write).toHaveBeenCalledWith("echo test\r");
  });

  // Test 4: Environment vars are stored and retrievable
  it("stores and retrieves environment variables via getEnvironmentVars", async () => {
    await controller.setEnvironment("my-session", "API_KEY", "secret123");
    await controller.setEnvironment("my-session", "NODE_ENV", "production");

    const vars = controller.getEnvironmentVars("my-session");

    expect(vars).toEqual({
      API_KEY: "secret123",
      NODE_ENV: "production",
    });
  });

  // Test 5: killSession removes holder from internal map
  it("removes holder from internal map when killing a session", async () => {
    await controller.newSession("test-session");

    // Kill the session
    await controller.killSession("test-session");

    expect(mockHolderInstance.kill).toHaveBeenCalled();

    // After kill, if we try to send keys, it should not use the in-process holder
    // (it would fall back to socket-based communication)
    mockHolderInstance.ptyProcess.write.mockClear();

    await controller.sendKeys("test-session", "test");

    // Should NOT have called the in-process holder's write (since it's been removed)
    expect(mockHolderInstance.ptyProcess.write).not.toHaveBeenCalled();
  });

  // Test 6: hasSession checks if session is active
  it("checks session active status via session module", async () => {
    mockSession.isSessionActive.mockResolvedValueOnce(true);

    const exists = await controller.hasSession("active-session");

    expect(exists).toBe(true);
    expect(mockSession.isSessionActive).toHaveBeenCalledWith("active-session");
  });

  // Test 7: getPanePID returns process ID from metadata
  it("returns child PID from session metadata", async () => {
    mockSession.readMetadata.mockReturnValueOnce({ childPid: 9999, pid: 9990 });

    const pid = await controller.getPanePID("test-session");

    expect(pid).toBe(9999);
  });

  // Test 8: Default dimensions (200x50) when not specified
  it("uses default dimensions (200x50) when not specified", async () => {
    await controller.newSession("default-session");

    expect(mockHolderStart).toHaveBeenCalledWith(
      expect.objectContaining({
        cols: 200,
        rows: 50,
      })
    );
  });
});
