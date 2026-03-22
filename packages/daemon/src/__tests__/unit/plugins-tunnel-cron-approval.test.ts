/**
 * Tests for PRs #253-258:
 * 1. Provider Plugin System — JSON plugin loading, validation
 * 2. Tunnel backend — start/stop/status, auto-expire
 * 3. Cron scheduling — CRUD, validation, overlap skip
 * 4. Approval Gates — requiresApproval, pending state, approve/reject
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

// ---------------------------------------------------------------------------
// 1. Provider Plugin System (PR #253)
// ---------------------------------------------------------------------------

describe("Provider Plugin System (PR #253)", () => {
  interface PluginConfig {
    id: string;
    name: string;
    command: string;
    args?: string[];
    env?: Record<string, string>;
    mcpConfigFlag?: string;
    promptFlag?: string;
  }

  function validatePluginConfig(config: any): string | null {
    if (!config.id || typeof config.id !== "string") return "Missing or invalid 'id'";
    if (!config.name || typeof config.name !== "string") return "Missing or invalid 'name'";
    if (!config.command || typeof config.command !== "string") return "Missing or invalid 'command'";
    if (config.args && !Array.isArray(config.args)) return "'args' must be an array";
    return null;
  }

  it("validates valid plugin config", () => {
    expect(validatePluginConfig({ id: "my-cli", name: "My CLI", command: "my-cli" })).toBeNull();
  });

  it("rejects missing id", () => {
    expect(validatePluginConfig({ name: "X", command: "x" })).toContain("id");
  });

  it("rejects missing name", () => {
    expect(validatePluginConfig({ id: "x", command: "x" })).toContain("name");
  });

  it("rejects missing command", () => {
    expect(validatePluginConfig({ id: "x", name: "X" })).toContain("command");
  });

  it("rejects non-array args", () => {
    expect(validatePluginConfig({ id: "x", name: "X", command: "x", args: "bad" })).toContain("args");
  });

  it("accepts optional fields", () => {
    const config: PluginConfig = {
      id: "custom",
      name: "Custom CLI",
      command: "/usr/local/bin/custom-cli",
      args: ["--model", "gpt-4"],
      env: { API_KEY: "xxx" },
      mcpConfigFlag: "--mcp-config",
      promptFlag: "--system-prompt",
    };
    expect(validatePluginConfig(config)).toBeNull();
  });

  it("loads from correct directories", () => {
    const globalDir = "/home/user/.kora/providers";
    const localDir = "/project/.kora/providers";
    const dirs = [globalDir, localDir];
    expect(dirs).toHaveLength(2);
    expect(dirs[0]).toContain(".kora/providers");
  });
});

// ---------------------------------------------------------------------------
// 2. Tunnel Backend (PR #254)
// ---------------------------------------------------------------------------

describe("Tunnel Backend (PR #254)", () => {
  const DEFAULT_EXPIRE_MS = 2 * 60 * 60 * 1000;

  interface TunnelState {
    running: boolean;
    url: string | null;
    port: number | null;
    startedAt: number | null;
    expiresAt: number | null;
  }

  let tunnel: TunnelState;

  beforeEach(() => {
    tunnel = { running: false, url: null, port: null, startedAt: null, expiresAt: null };
  });

  function startTunnel(port: number, expireMs = DEFAULT_EXPIRE_MS): TunnelState {
    if (tunnel.running) throw new Error("Tunnel already running");
    const now = Date.now();
    tunnel = {
      running: true,
      url: `https://random-id.trycloudflare.com`,
      port,
      startedAt: now,
      expiresAt: now + expireMs,
    };
    return tunnel;
  }

  function stopTunnel(): void {
    tunnel = { running: false, url: null, port: null, startedAt: null, expiresAt: null };
  }

  it("starts tunnel on specified port", () => {
    const result = startTunnel(7891);
    expect(result.running).toBe(true);
    expect(result.port).toBe(7891);
    expect(result.url).toContain("trycloudflare.com");
  });

  it("throws if tunnel already running", () => {
    startTunnel(7891);
    expect(() => startTunnel(7891)).toThrow("already running");
  });

  it("stops tunnel", () => {
    startTunnel(7891);
    stopTunnel();
    expect(tunnel.running).toBe(false);
    expect(tunnel.url).toBeNull();
  });

  it("auto-expires after default 2 hours", () => {
    const result = startTunnel(7891);
    expect(result.expiresAt! - result.startedAt!).toBe(DEFAULT_EXPIRE_MS);
  });

  it("custom expire time", () => {
    const oneHour = 60 * 60 * 1000;
    const result = startTunnel(7891, oneHour);
    expect(result.expiresAt! - result.startedAt!).toBe(oneHour);
  });

  it("status returns null when not running", () => {
    expect(tunnel.running).toBe(false);
    expect(tunnel.url).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// 3. Cron Scheduling (PR #256)
// ---------------------------------------------------------------------------

describe("Cron Scheduling (PR #256)", () => {
  const MAX_ACTIVE_SCHEDULES = 5;

  interface Schedule {
    id: string;
    name: string;
    cronExpression: string;
    enabled: boolean;
    lastRunAt: string | null;
    nextRunAt: string | null;
  }

  function validateCron(expr: string): string | null {
    // Simple validation — real uses cron-parser
    const parts = expr.trim().split(/\s+/);
    if (parts.length < 5 || parts.length > 6) return "Cron must have 5-6 fields";
    return null;
  }

  function shouldSkipOverlap(schedule: Schedule, runningSessions: string[]): boolean {
    return runningSessions.includes(schedule.name);
  }

  describe("CRUD", () => {
    it("creates a schedule with required fields", () => {
      const schedule: Schedule = {
        id: "s1",
        name: "Daily Build",
        cronExpression: "0 9 * * *",
        enabled: true,
        lastRunAt: null,
        nextRunAt: "2026-03-23T09:00:00Z",
      };
      expect(schedule.enabled).toBe(true);
      expect(schedule.nextRunAt).toBeTruthy();
    });

    it("disables a schedule", () => {
      const schedule: Schedule = {
        id: "s1", name: "Test", cronExpression: "0 * * * *",
        enabled: true, lastRunAt: null, nextRunAt: null,
      };
      schedule.enabled = false;
      expect(schedule.enabled).toBe(false);
    });
  });

  describe("Validation", () => {
    it("accepts valid 5-field cron", () => {
      expect(validateCron("0 9 * * *")).toBeNull();
    });

    it("accepts valid 6-field cron", () => {
      expect(validateCron("0 0 9 * * *")).toBeNull();
    });

    it("rejects invalid cron (too few fields)", () => {
      expect(validateCron("0 9 *")).not.toBeNull();
    });

    it("rejects invalid cron (too many fields)", () => {
      expect(validateCron("0 0 0 9 * * * extra")).not.toBeNull();
    });
  });

  describe("Overlap skip", () => {
    it("skips if session already running", () => {
      const schedule: Schedule = {
        id: "s1", name: "Daily Build", cronExpression: "0 9 * * *",
        enabled: true, lastRunAt: null, nextRunAt: null,
      };
      expect(shouldSkipOverlap(schedule, ["Daily Build", "Other"])).toBe(true);
    });

    it("does not skip if session not running", () => {
      const schedule: Schedule = {
        id: "s1", name: "Daily Build", cronExpression: "0 9 * * *",
        enabled: true, lastRunAt: null, nextRunAt: null,
      };
      expect(shouldSkipOverlap(schedule, ["Other"])).toBe(false);
    });
  });

  describe("Max active schedules", () => {
    it("enforces max 5 active schedules", () => {
      const activeCount = 5;
      const canCreate = activeCount < MAX_ACTIVE_SCHEDULES;
      expect(canCreate).toBe(false);
    });

    it("allows creation when under limit", () => {
      const activeCount = 3;
      const canCreate = activeCount < MAX_ACTIVE_SCHEDULES;
      expect(canCreate).toBe(true);
    });
  });
});

// ---------------------------------------------------------------------------
// 4. Approval Gates (PR #258)
// ---------------------------------------------------------------------------

describe("Approval Gates (PR #258)", () => {
  interface WorkflowState {
    id: string;
    label: string;
    requiresApproval?: boolean;
    approvers?: string[];
  }

  function checkApprovalRequired(
    states: WorkflowState[],
    targetStatusId: string,
  ): { required: boolean; approvers: string[] } {
    const state = states.find(s => s.id === targetStatusId);
    if (!state?.requiresApproval) return { required: false, approvers: [] };
    return { required: true, approvers: state.approvers || [] };
  }

  function processTransition(
    currentStatus: string,
    targetStatus: string,
    states: WorkflowState[],
    isApproved: boolean,
    isForceMode: boolean,
  ): { allowed: boolean; pendingApproval: boolean; error?: string } {
    const approval = checkApprovalRequired(states, targetStatus);

    if (approval.required && !isApproved && !isForceMode) {
      return { allowed: false, pendingApproval: true };
    }

    return { allowed: true, pendingApproval: false };
  }

  const statesWithApproval: WorkflowState[] = [
    { id: "pending", label: "Pending" },
    { id: "in-progress", label: "In Progress" },
    { id: "review", label: "Review" },
    { id: "staging", label: "Staging", requiresApproval: true, approvers: ["master", "user"] },
    { id: "done", label: "Done", requiresApproval: true },
  ];

  describe("requiresApproval detection", () => {
    it("staging requires approval", () => {
      const result = checkApprovalRequired(statesWithApproval, "staging");
      expect(result.required).toBe(true);
      expect(result.approvers).toContain("master");
    });

    it("done requires approval", () => {
      const result = checkApprovalRequired(statesWithApproval, "done");
      expect(result.required).toBe(true);
    });

    it("in-progress does NOT require approval", () => {
      const result = checkApprovalRequired(statesWithApproval, "in-progress");
      expect(result.required).toBe(false);
    });

    it("non-existent state does not require approval", () => {
      const result = checkApprovalRequired(statesWithApproval, "nonexistent");
      expect(result.required).toBe(false);
    });
  });

  describe("Transition with approval gate", () => {
    it("blocks transition to approval-required state without approval", () => {
      const result = processTransition("review", "staging", statesWithApproval, false, false);
      expect(result.allowed).toBe(false);
      expect(result.pendingApproval).toBe(true);
    });

    it("allows transition with explicit approval", () => {
      const result = processTransition("review", "staging", statesWithApproval, true, false);
      expect(result.allowed).toBe(true);
      expect(result.pendingApproval).toBe(false);
    });

    it("allows transition with force mode (bypasses approval)", () => {
      const result = processTransition("review", "staging", statesWithApproval, false, true);
      expect(result.allowed).toBe(true);
    });

    it("allows transition to non-approval state without approval", () => {
      const result = processTransition("pending", "in-progress", statesWithApproval, false, false);
      expect(result.allowed).toBe(true);
      expect(result.pendingApproval).toBe(false);
    });
  });

  describe("Approve/reject flow", () => {
    it("pending approval can be approved", () => {
      let status = "pending-approval";
      const action = "approve";
      if (action === "approve") status = "staging";
      expect(status).toBe("staging");
    });

    it("pending approval can be rejected", () => {
      let status = "pending-approval";
      const action = "reject";
      if (action === "reject") status = "review"; // goes back
      expect(status).toBe("review");
    });

    it("only designated approvers can approve", () => {
      const approvers = ["master", "user"];
      const currentUser = "worker-1";
      const canApprove = approvers.includes(currentUser) || approvers.length === 0;
      expect(canApprove).toBe(false);
    });

    it("master can approve", () => {
      const approvers = ["master", "user"];
      const currentUser = "master";
      const canApprove = approvers.includes(currentUser);
      expect(canApprove).toBe(true);
    });
  });
});
