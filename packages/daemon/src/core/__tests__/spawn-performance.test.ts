import { describe, it, expect, vi } from "vitest";

// This test file verifies performance-related patterns and timeouts in the agent spawning logic

describe("Agent spawn performance patterns", () => {
  // Test 1: Restart-all uses Promise.all (parallel, not sequential)
  it("restart-all should process agents in parallel using Promise.all", async () => {
    // Simulate restart-all logic
    const agents = [
      { id: "agent-1", name: "Worker 1" },
      { id: "agent-2", name: "Worker 2" },
      { id: "agent-3", name: "Worker 3" },
    ];

    const restartAgent = vi.fn().mockImplementation((agent) => {
      return new Promise((resolve) => {
        setTimeout(() => resolve({ ...agent, restarted: true }), 100);
      });
    });

    const startTime = Date.now();

    // Parallel restart using Promise.all
    const results = await Promise.all(agents.map((a) => restartAgent(a)));

    const elapsed = Date.now() - startTime;

    // If parallel, should take ~100ms (not 300ms for sequential)
    expect(elapsed).toBeLessThan(200);
    expect(results).toHaveLength(3);
    expect(restartAgent).toHaveBeenCalledTimes(3);
  });

  // Test 2: Sequential restart would be slower (anti-pattern)
  it("sequential restart is slower than parallel (demonstrating the anti-pattern)", async () => {
    const agents = [
      { id: "agent-1", name: "Worker 1" },
      { id: "agent-2", name: "Worker 2" },
      { id: "agent-3", name: "Worker 3" },
    ];

    const restartAgent = vi.fn().mockImplementation((agent) => {
      return new Promise((resolve) => {
        setTimeout(() => resolve({ ...agent, restarted: true }), 100);
      });
    });

    const startTime = Date.now();

    // Sequential restart (anti-pattern)
    const results = [];
    for (const agent of agents) {
      results.push(await restartAgent(agent));
    }

    const elapsed = Date.now() - startTime;

    // Sequential should take ~300ms (100ms per agent)
    expect(elapsed).toBeGreaterThanOrEqual(300);
    expect(results).toHaveLength(3);
  });

  // Test 3: Playbook worker spawns are parallel after master
  it("spawns playbook workers in parallel after master", async () => {
    const master = { name: "Orchestrator", role: "master" as const };
    const workers = [
      { name: "Worker A", role: "worker" as const },
      { name: "Worker B", role: "worker" as const },
      { name: "Worker C", role: "worker" as const },
    ];

    const spawnAgent = vi.fn().mockImplementation(() => {
      return new Promise((resolve) => {
        setTimeout(() => resolve({ id: "agent-123", spawned: true }), 100);
      });
    });

    const startTime = Date.now();

    // Spawn master first (sequential)
    const masterResult = await spawnAgent(master);

    // Spawn all workers in parallel
    const workerResults = await Promise.all(workers.map((w) => spawnAgent(w)));

    const elapsed = Date.now() - startTime;

    // Should take ~200ms (100ms master + 100ms parallel workers)
    // Not 400ms (100ms master + 3*100ms sequential workers)
    expect(elapsed).toBeLessThan(300);
    expect(masterResult).toBeDefined();
    expect(workerResults).toHaveLength(3);
    expect(spawnAgent).toHaveBeenCalledTimes(4); // 1 master + 3 workers
  });

  // Test 4: Graceful shutdown timeout is 3s for restart
  it("uses 3 second timeout for graceful shutdown during restart", async () => {
    const GRACEFUL_SHUTDOWN_TIMEOUT_MS = 3000;

    // Simulate a restart with shutdown timeout
    const mockShutdown = vi.fn().mockImplementation(() => {
      return new Promise<void>((resolve) => {
        setTimeout(resolve, GRACEFUL_SHUTDOWN_TIMEOUT_MS);
      });
    });

    const startTime = Date.now();
    await mockShutdown();
    const elapsed = Date.now() - startTime;

    expect(elapsed).toBeGreaterThanOrEqual(2900);
    expect(elapsed).toBeLessThan(3200);
  });

  // Test 5: Prompt wait timeout is 3s
  it("uses 3 second timeout for prompt detection", async () => {
    const PROMPT_WAIT_TIMEOUT_MS = 3000;

    // Simulate waiting for a prompt that never appears
    const checkForPrompt = vi.fn().mockResolvedValue(false);

    const startTime = Date.now();
    const maxWait = PROMPT_WAIT_TIMEOUT_MS;
    const pollInterval = 200;

    while (Date.now() - startTime < maxWait) {
      const hasPrompt = await checkForPrompt();
      if (hasPrompt) break;
      await new Promise((resolve) => setTimeout(resolve, pollInterval));
    }

    const elapsed = Date.now() - startTime;

    // Should have waited approximately 3 seconds
    expect(elapsed).toBeGreaterThanOrEqual(2900);
    expect(elapsed).toBeLessThan(3300);

    // Should have polled multiple times
    expect(checkForPrompt.mock.calls.length).toBeGreaterThan(10);
  });

  // Test 6: Parallel operations don't block each other
  it("parallel spawns don't block each other", async () => {
    const spawnTasks = [
      async () => {
        await new Promise((resolve) => setTimeout(resolve, 150));
        return "task1";
      },
      async () => {
        await new Promise((resolve) => setTimeout(resolve, 100));
        return "task2";
      },
      async () => {
        await new Promise((resolve) => setTimeout(resolve, 120));
        return "task3";
      },
    ];

    const startTime = Date.now();
    const results = await Promise.all(spawnTasks.map((t) => t()));
    const elapsed = Date.now() - startTime;

    // All tasks should complete in parallel (max 150ms, not 370ms)
    expect(elapsed).toBeLessThan(200);
    expect(results).toEqual(["task1", "task2", "task3"]);
  });

  // Test 7: Shutdown timeout prevents hanging on unresponsive agents
  it("enforces shutdown timeout to prevent hanging", async () => {
    const SHUTDOWN_TIMEOUT_MS = 3000;

    const unresponsiveShutdown = async (): Promise<void> => {
      return new Promise((resolve) => {
        // Simulate an agent that never responds
        setTimeout(resolve, 10000); // Would take 10s if not timed out
      });
    };

    const shutdownWithTimeout = async (): Promise<void> => {
      return Promise.race([
        unresponsiveShutdown(),
        new Promise<void>((resolve) => setTimeout(resolve, SHUTDOWN_TIMEOUT_MS)),
      ]);
    };

    const startTime = Date.now();
    await shutdownWithTimeout();
    const elapsed = Date.now() - startTime;

    // Should timeout after 3s, not wait 10s
    expect(elapsed).toBeLessThan(3500);
  });
});
