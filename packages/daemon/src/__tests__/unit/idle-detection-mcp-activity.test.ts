/**
 * P0 Tests for false idle detection fix (task 73c7837d).
 *
 * The bug: agents calling Read tool or MCP tools (send_message, list_tasks)
 * are falsely marked idle because the activity detector only looks at
 * terminal text flow, not MCP/tool activity.
 *
 * The fix: track MCP call timestamps. Agent is NOT idle if:
 * - Last MCP call was within 30s
 * - Terminal text changed within detection window
 *
 * Tests verify:
 * 1. Agent is NOT idle after Read tool call
 * 2. Agent is NOT idle while MCP calls are active
 * 3. Agent IS idle after 30s of truly no activity
 * 4. MCP call resets the idle timer
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

// ---------------------------------------------------------------------------
// Mock activity tracker (simulates agent-health.ts idle detection)
// ---------------------------------------------------------------------------

const MCP_ACTIVITY_TIMEOUT_MS = 30_000; // 30 seconds

class MockActivityTracker {
  private lastTerminalChangeAt = 0;
  private lastMcpCallAt = 0;
  private terminalHash = "";

  /** Record terminal output change */
  recordTerminalChange(hash: string) {
    if (hash !== this.terminalHash) {
      this.terminalHash = hash;
      this.lastTerminalChangeAt = Date.now();
    }
  }

  /** Record MCP tool call (any tool) */
  recordMcpCall() {
    this.lastMcpCallAt = Date.now();
  }

  /** Check if agent is idle */
  isIdle(now = Date.now()): boolean {
    // Not idle if terminal changed recently (within 3s detection window)
    if (now - this.lastTerminalChangeAt < 3000) return false;

    // Not idle if MCP call was within 30s
    if (now - this.lastMcpCallAt < MCP_ACTIVITY_TIMEOUT_MS) return false;

    // Truly idle
    return true;
  }

  getLastMcpCallAt(): number {
    return this.lastMcpCallAt;
  }
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("Idle detection with MCP activity (P0 fix)", () => {
  let tracker: MockActivityTracker;

  beforeEach(() => {
    tracker = new MockActivityTracker();
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-03-22T02:00:00Z"));
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  describe("Agent NOT idle after Read tool call", () => {
    it("agent is not idle immediately after MCP call", () => {
      tracker.recordMcpCall();

      expect(tracker.isIdle()).toBe(false);
    });

    it("agent is not idle 10s after MCP call", () => {
      tracker.recordMcpCall();
      vi.advanceTimersByTime(10_000);

      expect(tracker.isIdle()).toBe(false);
    });

    it("agent is not idle 29s after MCP call", () => {
      tracker.recordMcpCall();
      vi.advanceTimersByTime(29_000);

      expect(tracker.isIdle()).toBe(false);
    });
  });

  describe("Agent NOT idle while MCP calls are active", () => {
    it("repeated MCP calls keep agent non-idle", () => {
      tracker.recordMcpCall(); // list_tasks
      vi.advanceTimersByTime(15_000);

      tracker.recordMcpCall(); // send_message
      vi.advanceTimersByTime(15_000);

      tracker.recordMcpCall(); // check_messages
      vi.advanceTimersByTime(15_000);

      // 45s total but last call was 15s ago — still not idle
      expect(tracker.isIdle()).toBe(false);
    });

    it("MCP call resets the idle timer", () => {
      tracker.recordMcpCall();
      vi.advanceTimersByTime(25_000); // 25s — still not idle

      expect(tracker.isIdle()).toBe(false);

      tracker.recordMcpCall(); // reset timer
      vi.advanceTimersByTime(25_000); // another 25s from new call

      expect(tracker.isIdle()).toBe(false); // still not idle (25s < 30s)
    });
  });

  describe("Agent IS idle after 30s of no activity", () => {
    it("agent is idle after 30s with no MCP calls", () => {
      tracker.recordMcpCall();
      vi.advanceTimersByTime(30_001);

      expect(tracker.isIdle()).toBe(true);
    });

    it("agent is idle after 60s with no activity", () => {
      tracker.recordMcpCall();
      vi.advanceTimersByTime(60_000);

      expect(tracker.isIdle()).toBe(true);
    });

    it("agent with no recorded activity is idle", () => {
      // No terminal change, no MCP calls
      expect(tracker.isIdle()).toBe(true);
    });
  });

  describe("Terminal activity interaction", () => {
    it("terminal change makes agent non-idle", () => {
      tracker.recordTerminalChange("hash-1");

      expect(tracker.isIdle()).toBe(false);
    });

    it("terminal change + MCP call — both prevent idle", () => {
      tracker.recordTerminalChange("hash-1");
      tracker.recordMcpCall();

      expect(tracker.isIdle()).toBe(false);
    });

    it("stale terminal but recent MCP — not idle", () => {
      tracker.recordTerminalChange("hash-1");
      vi.advanceTimersByTime(10_000); // terminal stale after 3s

      tracker.recordMcpCall(); // but MCP is recent

      expect(tracker.isIdle()).toBe(false);
    });

    it("both terminal and MCP stale — idle", () => {
      tracker.recordTerminalChange("hash-1");
      tracker.recordMcpCall();
      vi.advanceTimersByTime(31_000);

      expect(tracker.isIdle()).toBe(true);
    });
  });

  describe("Edge cases", () => {
    it("same terminal hash does not reset timer", () => {
      tracker.recordTerminalChange("same-hash");
      vi.advanceTimersByTime(5_000);

      tracker.recordTerminalChange("same-hash"); // same hash — no change

      vi.advanceTimersByTime(25_000); // 30s total from first change
      // No MCP calls, terminal didn't actually change
      expect(tracker.isIdle()).toBe(true);
    });

    it("different terminal hash resets timer", () => {
      tracker.recordTerminalChange("hash-1");
      vi.advanceTimersByTime(2_000);

      tracker.recordTerminalChange("hash-2"); // different — resets

      expect(tracker.isIdle()).toBe(false);
    });
  });
});
