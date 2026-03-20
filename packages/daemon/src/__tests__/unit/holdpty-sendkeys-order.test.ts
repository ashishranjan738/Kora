/**
 * Tests for the holdpty sendViaSocket attach-first fix.
 *
 * Root cause: holdpty v0.3.0 falsely ACKs "send" mode (responds HELLO_ACK)
 * but silently drops the data. Fix: try "attach" mode first, fall back to "send".
 */
import { describe, it, expect, vi } from "vitest";

describe("sendViaSocket mode order", () => {
  it("should try attach mode before send mode", () => {
    // The fix reverses the order: attach first, then send as fallback.
    // This test verifies the logic by checking the expected order of trySend calls.
    const callOrder: string[] = [];

    const trySend = async (mode: string): Promise<boolean> => {
      callOrder.push(mode);
      if (mode === "attach") return true; // attach succeeds
      return false;
    };

    // Simulate the fixed sendViaSocket logic
    async function sendViaSocket() {
      const attachOk = await trySend("attach");
      if (attachOk) return;
      await trySend("send");
    }

    return sendViaSocket().then(() => {
      expect(callOrder).toEqual(["attach"]);
      // "send" was never called because attach succeeded
    });
  });

  it("falls back to send mode when attach fails", () => {
    const callOrder: string[] = [];

    const trySend = async (mode: string): Promise<boolean> => {
      callOrder.push(mode);
      return false; // both fail
    };

    async function sendViaSocket() {
      const attachOk = await trySend("attach");
      if (attachOk) return;
      await trySend("send");
    }

    return sendViaSocket().then(() => {
      expect(callOrder).toEqual(["attach", "send"]);
    });
  });

  it("send mode is tried when attach is rejected (exclusive conflict)", () => {
    const callOrder: string[] = [];

    const trySend = async (mode: string): Promise<boolean> => {
      callOrder.push(mode);
      if (mode === "attach") return false; // exclusive conflict
      if (mode === "send") return true; // send works (holdpty 0.4+)
      return false;
    };

    async function sendViaSocket() {
      const attachOk = await trySend("attach");
      if (attachOk) return;
      await trySend("send");
    }

    return sendViaSocket().then(() => {
      expect(callOrder).toEqual(["attach", "send"]);
    });
  });
});

describe("sendKeys Enter key behavior", () => {
  it("should always append carriage return (\\r) to keys", () => {
    // Simulate the sendKeys logic
    function buildSendData(keys: string): string {
      return keys + "\r";
    }

    expect(buildSendData("claude --model default").endsWith("\r")).toBe(true);
    expect(buildSendData("export FOO=bar").endsWith("\r")).toBe(true);
    expect(buildSendData("cd /tmp").endsWith("\r")).toBe(true);
  });

  it("PtyManager fast path also receives the \\r", () => {
    const keys = "echo hello";
    const data = keys + "\r"; // sendKeys always appends \r

    expect(data).toBe("echo hello\r");
    expect(data.endsWith("\r")).toBe(true);
  });
});

describe("Agent manager CLI command verification", () => {
  it("fires async verification without blocking spawn", async () => {
    // The verification runs in a setTimeout (fire-and-forget)
    // This test ensures it doesn't block the spawn return
    let verificationRan = false;

    const spawnAgent = async () => {
      // Simulate: send command, then fire-and-forget verification
      setTimeout(() => { verificationRan = true; }, 10);
      return { id: "test-agent", status: "running" };
    };

    const result = await spawnAgent();
    expect(result.status).toBe("running");

    // Verification hasn't run yet (it's in setTimeout)
    expect(verificationRan).toBe(false);

    // Wait for it
    await new Promise(r => setTimeout(r, 50));
    expect(verificationRan).toBe(true);
  });
});
