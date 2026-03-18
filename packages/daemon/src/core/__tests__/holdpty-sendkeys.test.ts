import { describe, it, expect, vi, beforeEach } from "vitest";

// ---------------------------------------------------------------------------
// Mocks
// ---------------------------------------------------------------------------

// Mock holdpty modules
const mockHolderInstance = {
  ptyProcess: {
    write: vi.fn(),
  },
  kill: vi.fn(),
};

const mockHolder = {
  start: vi.fn().mockResolvedValue(mockHolderInstance),
};

const mockSession = {
  isSessionActive: vi.fn().mockResolvedValue(true),
  listSessions: vi.fn().mockResolvedValue([]),
  readMetadata: vi.fn().mockReturnValue({ childPid: 12345 }),
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
    decode() { return []; }
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

// Mock child_process for CLI commands
vi.mock("child_process", () => ({
  execFile: vi.fn(),
  spawn: vi.fn(),
}));

// ---------------------------------------------------------------------------
// Import after mocks
// ---------------------------------------------------------------------------

import { HoldptyController } from "../holdpty-controller.js";

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("HoldptyController sendKeys literal mode", () => {
  let controller: HoldptyController;

  beforeEach(() => {
    vi.clearAllMocks();
    controller = new HoldptyController();
  });

  // Test 1: literal: false appends \r (carriage return, NOT \n)
  it("appends \\r when literal is false", async () => {
    await controller.newSession("test-session");
    await controller.sendKeys("test-session", "echo hello", { literal: false });

    expect(mockHolderInstance.ptyProcess.write).toHaveBeenCalledWith("echo hello\r");
  });

  // Test 2: literal: true does NOT append \r
  it("does not append \\r when literal is true", async () => {
    await controller.newSession("test-session");
    await controller.sendKeys("test-session", "echo hello", { literal: true });

    expect(mockHolderInstance.ptyProcess.write).toHaveBeenCalledWith("echo hello");
  });

  // Test 3: Direct PTY write path uses \r (for in-process sessions)
  it("uses \\r for in-process holder sessions (direct PTY write)", async () => {
    await controller.newSession("test-session");

    // Reset mock to clear the newSession call
    mockHolderInstance.ptyProcess.write.mockClear();

    await controller.sendKeys("test-session", "ls -la");

    // Default behavior (no literal option) should append \r
    expect(mockHolderInstance.ptyProcess.write).toHaveBeenCalledWith("ls -la\r");
  });

  // Test 4: sendRawInput uses literal: true (no Enter)
  it("sendRawInput sends literal keys without Enter", async () => {
    await controller.newSession("test-session");
    mockHolderInstance.ptyProcess.write.mockClear();

    await controller.sendRawInput("test-session", "partial command");

    expect(mockHolderInstance.ptyProcess.write).toHaveBeenCalledWith("partial command");
  });

  // Test 5: Multiple sendKeys calls preserve literal mode correctly
  it("handles multiple sendKeys with different literal modes", async () => {
    await controller.newSession("test-session");
    mockHolderInstance.ptyProcess.write.mockClear();

    await controller.sendKeys("test-session", "first", { literal: false });
    await controller.sendKeys("test-session", "second", { literal: true });
    await controller.sendKeys("test-session", "third", { literal: false });

    const calls = mockHolderInstance.ptyProcess.write.mock.calls;
    expect(calls[0][0]).toBe("first\r");
    expect(calls[1][0]).toBe("second");
    expect(calls[2][0]).toBe("third\r");
  });
});
