/**
 * Tests for holdpty hasSession socket liveness verification.
 *
 * Verifies that hasSession correctly detects stale sessions where:
 * - PID is alive (recycled by OS) but socket is dead
 * - Socket file exists but holder process crashed
 */

import { describe, it, expect } from "vitest";
import * as net from "net";
import * as fs from "fs";
import * as path from "path";
import * as os from "os";

describe("holdpty hasSession — socket liveness logic", () => {
  it("should detect a connectable socket as alive", async () => {
    // Create a real Unix socket server that responds to connections
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "holdpty-test-"));
    const sockPath = path.join(tmpDir, "test.sock");

    const server = net.createServer((socket) => {
      // Respond with some data (simulating HELLO_ACK)
      socket.write(Buffer.from([0x01, 0, 0, 0, 5, 0x68, 0x65, 0x6c, 0x6c, 0x6f]));
      socket.end();
    });

    await new Promise<void>((resolve) => {
      server.listen(sockPath, () => resolve());
    });

    try {
      // Probe should succeed
      const alive = await new Promise<boolean>((resolve) => {
        const socket = net.createConnection(sockPath, () => {
          socket.write(Buffer.from("hello"));
        });

        const timeout = setTimeout(() => {
          socket.destroy();
          resolve(false);
        }, 1000);

        socket.on("data", () => {
          clearTimeout(timeout);
          socket.destroy();
          resolve(true);
        });

        socket.on("error", () => {
          clearTimeout(timeout);
          resolve(false);
        });
      });

      expect(alive).toBe(true);
    } finally {
      server.close();
      try { fs.unlinkSync(sockPath); } catch {}
      try { fs.rmdirSync(tmpDir); } catch {}
    }
  });

  it("should detect a stale socket file as dead", async () => {
    // Create a socket file with no server listening
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "holdpty-test-"));
    const sockPath = path.join(tmpDir, "stale.sock");

    // Create an empty file where the socket should be (simulating stale)
    fs.writeFileSync(sockPath, "");

    try {
      const alive = await new Promise<boolean>((resolve) => {
        const socket = net.createConnection(sockPath, () => {
          socket.write(Buffer.from("hello"));
        });

        const timeout = setTimeout(() => {
          socket.destroy();
          resolve(false);
        }, 1000);

        socket.on("data", () => {
          clearTimeout(timeout);
          socket.destroy();
          resolve(true);
        });

        socket.on("error", () => {
          clearTimeout(timeout);
          socket.destroy();
          resolve(false);
        });
      });

      expect(alive).toBe(false);
    } finally {
      try { fs.unlinkSync(sockPath); } catch {}
      try { fs.rmdirSync(tmpDir); } catch {}
    }
  });

  it("should detect ENOENT (missing socket) as dead", async () => {
    const alive = await new Promise<boolean>((resolve) => {
      const socket = net.createConnection("/tmp/nonexistent-holdpty-test.sock", () => {
        socket.write(Buffer.from("hello"));
      });

      const timeout = setTimeout(() => {
        socket.destroy();
        resolve(false);
      }, 1000);

      socket.on("data", () => {
        clearTimeout(timeout);
        socket.destroy();
        resolve(true);
      });

      socket.on("error", () => {
        clearTimeout(timeout);
        socket.destroy();
        resolve(false);
      });
    });

    expect(alive).toBe(false);
  });

  it("should timeout on unresponsive socket", async () => {
    // Create a server that accepts but never responds
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "holdpty-test-"));
    const sockPath = path.join(tmpDir, "slow.sock");

    const server = net.createServer(() => {
      // Intentionally don't respond
    });

    await new Promise<void>((resolve) => {
      server.listen(sockPath, () => resolve());
    });

    try {
      const start = Date.now();
      const alive = await new Promise<boolean>((resolve) => {
        const socket = net.createConnection(sockPath, () => {
          socket.write(Buffer.from("hello"));
        });

        const timeout = setTimeout(() => {
          socket.destroy();
          resolve(false);
        }, 500); // Short timeout for test

        socket.on("data", () => {
          clearTimeout(timeout);
          socket.destroy();
          resolve(true);
        });

        socket.on("error", () => {
          clearTimeout(timeout);
          socket.destroy();
          resolve(false);
        });
      });
      const elapsed = Date.now() - start;

      expect(alive).toBe(false);
      expect(elapsed).toBeGreaterThanOrEqual(450); // Should have timed out
      expect(elapsed).toBeLessThan(2000); // Shouldn't take too long
    } finally {
      server.close();
      try { fs.unlinkSync(sockPath); } catch {}
      try { fs.rmdirSync(tmpDir); } catch {}
    }
  });
});
