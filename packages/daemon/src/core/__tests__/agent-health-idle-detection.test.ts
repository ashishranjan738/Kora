import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { AgentHealthMonitor } from "../agent-health.js";
import type { AgentState } from "@kora/shared";
import type { IPtyBackend } from "../pty-backend.js";

describe("AgentHealthMonitor — idle detection", () => {
  let monitor: AgentHealthMonitor;
  let mockTmux: IPtyBackend;
  let agents: Map<string, AgentState>;

  beforeEach(() => {
    // Use fake timers
    vi.useFakeTimers();

    // Mock tmux backend
    mockTmux = {
      hasSession: vi.fn().mockResolvedValue(true),
      getPanePID: vi.fn().mockResolvedValue(12345),
      capturePane: vi.fn(),
    } as any;

    // Create agents map
    agents = new Map();
    agents.set("agent-1", {
      id: "agent-1",
      config: { name: "Worker", tmuxSession: "test-session" } as any,
      status: "running",
      activity: "working",
      lastActivityAt: new Date().toISOString(),
      lastOutputAt: new Date().toISOString(),
    } as any);

    monitor = new AgentHealthMonitor(mockTmux, agents);
  });

  afterEach(() => {
    vi.useRealTimers();
    monitor.stopAll();
  });

  it("should mark as idle when agent sits at prompt for >30 seconds", async () => {
    const agentId = "agent-1";
    const agent = agents.get(agentId)!;

    // Agent is working, then gets to prompt
    (mockTmux.capturePane as any)
      .mockResolvedValueOnce("npm run build\nBuilding...")
      .mockResolvedValueOnce("npm run build\nBuilding...\n❯ ") // Now at prompt
      .mockResolvedValue("❯ "); // Stays at prompt

    // Start monitoring
    monitor.startMonitoring(agentId, "test-session");

    // First check: agent is working
    await vi.advanceTimersByTimeAsync(5100);
    expect(agent.activity).toBe("working");

    // Second check: agent now at prompt, but hasn't been there 30s yet
    await vi.advanceTimersByTimeAsync(5100);
    // Still marked as working because < 30s

    // Advance 25 more seconds (total 35s since hitting prompt)
    await vi.advanceTimersByTimeAsync(25000);

    // Should now be idle
    expect(agent.activity).toBe("idle");
    expect(agent.idleSince).toBeDefined();

    monitor.stopMonitoring(agentId);
  });

  it("should mark as working when output changes and NOT at prompt", async () => {
    const agentId = "agent-1";
    const agent = agents.get(agentId)!;
    agent.activity = "idle";

    // Output shows work in progress (not a prompt)
    (mockTmux.capturePane as any).mockResolvedValue("Running tests...\nTest 1 passed\n");

    // Start monitoring
    monitor.startMonitoring(agentId, "test-session");

    // Trigger health check
    await vi.advanceTimersByTimeAsync(5100);

    // Should be marked as working (output changed, not at prompt)
    expect(agent.activity).toBe("working");
    expect(agent.idleSince).toBeUndefined();

    monitor.stopMonitoring(agentId);
  });

  it("should detect bash/zsh/fish shell prompt patterns", () => {
    const prompts = [
      "❯ ",      // fish/zsh
      "$ ",      // bash
      "% ",      // zsh
      "> ",      // powershell
      "user@host $ ",    // bash with user@host
      "  $ ",    // bash with leading spaces
      "  % ",    // zsh with leading spaces
      "[user@host] $ ",  // bracketed
    ];

    // These patterns match agent-health.ts
    const patterns = [
      /[$%>#]\s*$/,
      /\s+[$%>]\s*$/,
      /\w+@\w+\s+[$%>]\s*$/,
      /^\s*\[.*?\]\s*[$%>]\s*$/,
    ];

    // Test each prompt pattern
    for (const prompt of prompts) {
      const isPrompt = patterns.some(pattern => pattern.test(prompt));
      if (!isPrompt) {
        console.log(`Failed to match prompt: "${prompt}"`);
      }
      expect(isPrompt).toBe(true);
    }
  });

  it("should NOT detect work output as prompt", () => {
    const workOutputs = [
      "npm run build",
      "Building application...",
      "Done in 2.5s",
      "Error: Module not found",
      "✓ All tests passed",
      "  src/index.ts",
      "  function main() {",
    ];

    const patterns = [
      /[$%>#]\s*$/,
      /\s+[$%>]\s*$/,
      /\w+@\w+\s+[$%>]\s*$/,
      /^\s*\[.*?\]\s*[$%>]\s*$/,
    ];

    for (const output of workOutputs) {
      const isPrompt = patterns.some(pattern => pattern.test(output));
      expect(isPrompt).toBe(false);
    }
  });

  it("should emit agent-idle event when transitioning to idle", async () => {
    const agentId = "agent-1";
    const agent = agents.get(agentId)!;
    const idleHandler = vi.fn();

    monitor.on("agent-idle", idleHandler);

    // Agent at prompt
    (mockTmux.capturePane as any).mockResolvedValue("❯ ");

    // Start monitoring
    monitor.startMonitoring(agentId, "test-session");

    // Advance time past idle timeout (30s + health check intervals)
    await vi.advanceTimersByTimeAsync(35100);

    // Verify agent transitioned to idle (main indicator)
    expect(agent.activity).toBe("idle");

    // Event should have been emitted
    expect(idleHandler).toHaveBeenCalled();

    monitor.stopMonitoring(agentId);
  });

  it("should emit agent-working event when real work starts", async () => {
    const agentId = "agent-1";
    const agent = agents.get(agentId)!;
    agent.activity = "idle";

    const workingHandler = vi.fn();
    monitor.on("agent-working", workingHandler);

    // Output shows work (not a prompt)
    (mockTmux.capturePane as any).mockResolvedValue("❯ npm run build\nBuilding...\n");

    // Start monitoring
    monitor.startMonitoring(agentId, "test-session");

    // Trigger health check
    await vi.advanceTimersByTimeAsync(5100);

    // Verify agent transitioned to working (main indicator)
    expect(agent.activity).toBe("working");

    // Event should have been emitted
    expect(workingHandler).toHaveBeenCalled();

    monitor.stopMonitoring(agentId);
  });

  it("should eventually mark as idle when sitting at prompt", async () => {
    const agentId = "agent-1";
    const agent = agents.get(agentId)!;

    // Agent working, then transitions to prompt
    (mockTmux.capturePane as any)
      .mockResolvedValueOnce("Working...\n")
      .mockResolvedValue("❯ "); // Now at prompt, stays there

    // Start monitoring
    monitor.startMonitoring(agentId, "test-session");

    // First check: working
    await vi.advanceTimersByTimeAsync(5100);
    expect(agent.activity).toBe("working");

    // Second check: now at prompt, but hasn't been idle long enough
    await vi.advanceTimersByTimeAsync(5100);

    // Wait 30+ seconds total at prompt
    await vi.advanceTimersByTimeAsync(30100);

    // Should transition to idle
    expect(agent.activity).toBe("idle");
    expect(agent.idleSince).toBeDefined();

    monitor.stopMonitoring(agentId);
  });
});
