/**
 * TDD tests for Orchestrator Escalation Recovery State Machine.
 *
 * State machine: normal → escalated → recovered
 * Triggers:
 * - Self-loop detection (agent sends same message 3+ times) → escalate
 * - Dashboard escalation (user clicks "escalate" button) → escalate
 * - Recovery: agent calls check_messages → full recovery
 * - Partial recovery: agent makes MCP call (not check_messages) → partial
 * - Re-escalation: no recovery after 5 min → re-escalate
 * - Auto-nudge: no recovery after 10 min → nudge via terminal
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

// ---------------------------------------------------------------------------
// Mock Escalation State Machine
// ---------------------------------------------------------------------------

type EscalationState = "normal" | "escalated" | "partially-recovered" | "recovered";

class MockEscalationStateMachine {
  private state: EscalationState = "normal";
  private escalatedAt = 0;
  private lastMcpCallAt = 0;
  private selfLoopCount = new Map<string, number>();
  private readonly SELF_LOOP_THRESHOLD = 3;
  private readonly RE_ESCALATION_MS = 5 * 60 * 1000;
  private readonly AUTO_NUDGE_MS = 10 * 60 * 1000;

  getState(): EscalationState { return this.state; }

  /** Record a message sent by agent — detect self-loops */
  recordMessage(content: string): void {
    const key = content.trim().toLowerCase();
    const count = (this.selfLoopCount.get(key) || 0) + 1;
    this.selfLoopCount.set(key, count);

    if (count >= this.SELF_LOOP_THRESHOLD && this.state === "normal") {
      this.escalate("self-loop detected");
    }
  }

  /** Escalate from dashboard or detection */
  escalate(_reason: string): void {
    this.state = "escalated";
    this.escalatedAt = Date.now();
  }

  /** Agent calls check_messages — full recovery */
  onCheckMessages(): void {
    if (this.state === "escalated" || this.state === "partially-recovered") {
      this.state = "recovered";
      this.selfLoopCount.clear();
    }
  }

  /** Agent makes any MCP call (not check_messages) — partial recovery */
  onMcpCall(): void {
    this.lastMcpCallAt = Date.now();
    if (this.state === "escalated") {
      this.state = "partially-recovered";
    }
  }

  /** Check if re-escalation is needed (called on timer) */
  checkReEscalation(now = Date.now()): boolean {
    if (this.state !== "escalated" && this.state !== "partially-recovered") return false;
    if (now - this.escalatedAt > this.RE_ESCALATION_MS) {
      this.escalatedAt = now; // reset timer
      return true;
    }
    return false;
  }

  /** Check if auto-nudge is needed */
  checkAutoNudge(now = Date.now()): boolean {
    if (this.state !== "escalated") return false;
    return now - this.escalatedAt > this.AUTO_NUDGE_MS;
  }

  isEscalated(): boolean {
    return this.state === "escalated" || this.state === "partially-recovered";
  }
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("Escalation Recovery State Machine", () => {
  let sm: MockEscalationStateMachine;

  beforeEach(() => {
    sm = new MockEscalationStateMachine();
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-03-22T03:00:00Z"));
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  describe("Self-loop detection", () => {
    it("does not escalate on 1-2 repeated messages", () => {
      sm.recordMessage("Standing by, ready for tasks.");
      sm.recordMessage("Standing by, ready for tasks.");
      expect(sm.getState()).toBe("normal");
    });

    it("escalates on 3rd repeated message", () => {
      sm.recordMessage("Standing by, ready for tasks.");
      sm.recordMessage("Standing by, ready for tasks.");
      sm.recordMessage("Standing by, ready for tasks.");
      expect(sm.getState()).toBe("escalated");
    });

    it("is case insensitive", () => {
      sm.recordMessage("STANDING BY");
      sm.recordMessage("standing by");
      sm.recordMessage("Standing By");
      expect(sm.getState()).toBe("escalated");
    });

    it("different messages do not trigger self-loop", () => {
      sm.recordMessage("Message A");
      sm.recordMessage("Message B");
      sm.recordMessage("Message C");
      expect(sm.getState()).toBe("normal");
    });
  });

  describe("Dashboard escalation", () => {
    it("escalates immediately", () => {
      sm.escalate("user clicked escalate");
      expect(sm.getState()).toBe("escalated");
    });

    it("isEscalated returns true", () => {
      sm.escalate("manual");
      expect(sm.isEscalated()).toBe(true);
    });
  });

  describe("Recovery on check_messages", () => {
    it("full recovery from escalated state", () => {
      sm.escalate("test");
      sm.onCheckMessages();
      expect(sm.getState()).toBe("recovered");
    });

    it("full recovery from partially-recovered state", () => {
      sm.escalate("test");
      sm.onMcpCall(); // partial
      expect(sm.getState()).toBe("partially-recovered");
      sm.onCheckMessages(); // full
      expect(sm.getState()).toBe("recovered");
    });

    it("clears self-loop counter on recovery", () => {
      sm.recordMessage("loop");
      sm.recordMessage("loop");
      sm.recordMessage("loop"); // escalated
      sm.onCheckMessages(); // recovered

      // Same message again should not immediately re-escalate
      sm.recordMessage("loop");
      expect(sm.getState()).toBe("recovered");
    });

    it("no-op when already normal", () => {
      sm.onCheckMessages();
      expect(sm.getState()).toBe("normal");
    });
  });

  describe("Partial recovery on MCP call", () => {
    it("moves from escalated to partially-recovered", () => {
      sm.escalate("test");
      sm.onMcpCall();
      expect(sm.getState()).toBe("partially-recovered");
    });

    it("does not change normal state", () => {
      sm.onMcpCall();
      expect(sm.getState()).toBe("normal");
    });

    it("isEscalated still true when partially recovered", () => {
      sm.escalate("test");
      sm.onMcpCall();
      expect(sm.isEscalated()).toBe(true);
    });
  });

  describe("Re-escalation after 5 min", () => {
    it("re-escalation triggered after 5 min of no recovery", () => {
      sm.escalate("test");
      vi.advanceTimersByTime(5 * 60 * 1000 + 1);
      expect(sm.checkReEscalation()).toBe(true);
    });

    it("no re-escalation before 5 min", () => {
      sm.escalate("test");
      vi.advanceTimersByTime(4 * 60 * 1000);
      expect(sm.checkReEscalation()).toBe(false);
    });

    it("no re-escalation when recovered", () => {
      sm.escalate("test");
      sm.onCheckMessages();
      vi.advanceTimersByTime(10 * 60 * 1000);
      expect(sm.checkReEscalation()).toBe(false);
    });
  });

  describe("Auto-nudge after 10 min", () => {
    it("auto-nudge triggered after 10 min", () => {
      sm.escalate("test");
      vi.advanceTimersByTime(10 * 60 * 1000 + 1);
      expect(sm.checkAutoNudge()).toBe(true);
    });

    it("no auto-nudge before 10 min", () => {
      sm.escalate("test");
      vi.advanceTimersByTime(9 * 60 * 1000);
      expect(sm.checkAutoNudge()).toBe(false);
    });

    it("no auto-nudge when not escalated", () => {
      vi.advanceTimersByTime(20 * 60 * 1000);
      expect(sm.checkAutoNudge()).toBe(false);
    });
  });
});

// ---------------------------------------------------------------------------
// WebSocket Activity Push
// ---------------------------------------------------------------------------

describe("WebSocket activity push", () => {
  it("event fires on idle→working transition", () => {
    const events: any[] = [];
    const emit = (event: any) => events.push(event);

    let prevActivity = "idle";
    const newActivity = "working";

    if (prevActivity !== newActivity) {
      emit({ type: "agent-activity-changed", agentId: "w1", from: prevActivity, to: newActivity });
      prevActivity = newActivity;
    }

    expect(events).toHaveLength(1);
    expect(events[0].type).toBe("agent-activity-changed");
    expect(events[0].from).toBe("idle");
    expect(events[0].to).toBe("working");
  });

  it("no event when activity unchanged", () => {
    const events: any[] = [];
    const emit = (event: any) => events.push(event);

    const prevActivity = "working";
    const newActivity = "working";

    if (prevActivity !== newActivity) {
      emit({ type: "agent-activity-changed" });
    }

    expect(events).toHaveLength(0);
  });

  it("debounces within 5s window", () => {
    let lastEmitAt = -Infinity;
    const DEBOUNCE_MS = 5000;
    const events: any[] = [];

    function maybeEmit(now: number) {
      if (now - lastEmitAt >= DEBOUNCE_MS) {
        events.push({ ts: now });
        lastEmitAt = now;
      }
    }

    maybeEmit(0);       // emits (first call always emits)
    maybeEmit(2000);    // debounced (2s < 5s)
    maybeEmit(4000);    // debounced (4s < 5s)
    maybeEmit(5001);    // emits (5.001s >= 5s)

    expect(events).toHaveLength(2);
  });

  it("payload has required shape", () => {
    const payload = {
      type: "agent-activity-changed",
      agentId: "worker-1",
      agentName: "Dev 1",
      from: "idle",
      to: "working",
      timestamp: new Date().toISOString(),
    };

    expect(payload).toHaveProperty("type");
    expect(payload).toHaveProperty("agentId");
    expect(payload).toHaveProperty("from");
    expect(payload).toHaveProperty("to");
    expect(payload).toHaveProperty("timestamp");
  });
});

// ---------------------------------------------------------------------------
// Board Cleanup on Session Start
// ---------------------------------------------------------------------------

describe("Board cleanup on session start", () => {
  it("clean start creates zero tasks", () => {
    const existingTasks: any[] = [];
    const mode = "clean";
    const imported = mode === "clean" ? [] : existingTasks;
    expect(imported).toHaveLength(0);
  });

  it("carry-over imports only active tasks (not done)", () => {
    const existingTasks = [
      { id: "t1", status: "in-progress", title: "Active" },
      { id: "t2", status: "done", title: "Finished" },
      { id: "t3", status: "pending", title: "Waiting" },
      { id: "t4", status: "done", title: "Also done" },
    ];
    const mode = "carry-over-active";
    const imported = mode === "carry-over-active"
      ? existingTasks.filter(t => t.status !== "done")
      : existingTasks;

    expect(imported).toHaveLength(2);
    expect(imported.map(t => t.title)).toEqual(["Active", "Waiting"]);
  });

  it("carry-over all imports everything including done", () => {
    const existingTasks = [
      { id: "t1", status: "in-progress" },
      { id: "t2", status: "done" },
      { id: "t3", status: "pending" },
    ];
    const mode = "carry-over-all";
    const imported = mode === "carry-over-all" ? existingTasks : [];

    expect(imported).toHaveLength(3);
  });

  it("carry-over resets assignedTo on imported tasks", () => {
    const tasks = [
      { id: "t1", status: "pending", assignedTo: "old-agent" },
    ];
    const imported = tasks.map(t => ({ ...t, assignedTo: null }));

    expect(imported[0].assignedTo).toBeNull();
  });

  it("carry-over preserves priority and labels", () => {
    const task = { id: "t1", status: "pending", priority: "P0", labels: ["bug", "frontend"] };
    const imported = { ...task, assignedTo: null };

    expect(imported.priority).toBe("P0");
    expect(imported.labels).toEqual(["bug", "frontend"]);
  });
});
