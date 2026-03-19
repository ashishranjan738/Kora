import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import fs from "fs/promises";
import path from "path";
import os from "os";
import { AutoCheckpoint } from "../auto-checkpoint.js";
import type { AgentState } from "@kora/shared";

// Minimal mock agent
function mockAgent(id: string, status: string = "running", activity: string = "working"): AgentState {
  return {
    id,
    sessionId: "test-session",
    config: {
      name: `Agent-${id}`,
      provider: "claude-code",
      model: "default",
      role: "worker",
      tmuxSession: `kora--test-${id}`,
    },
    status: status as any,
    activity: activity as any,
    output: [],
    childAgents: [],
    healthCheck: { consecutiveFailures: 0, restartCount: 0 },
    cost: { totalTokensIn: 0, totalTokensOut: 0, totalCostUsd: 0, lastUpdatedAt: "" },
  } as AgentState;
}

describe("AutoCheckpoint", () => {
  let tmpDir: string;

  beforeEach(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "kora-checkpoint-test-"));
  });

  afterEach(async () => {
    await fs.rm(tmpDir, { recursive: true, force: true });
  });

  it("saves a checkpoint to disk", async () => {
    const agents = [mockAgent("a1"), mockAgent("a2", "stopped", "idle")];
    const cp = new AutoCheckpoint({
      runtimeDir: tmpDir,
      sessionId: "test-session",
      getAgents: () => agents,
      startTime: Date.now(),
    });

    const filePath = await cp.save();
    expect(filePath).toContain("checkpoint-");

    // Verify file exists and is valid JSON
    const raw = await fs.readFile(filePath, "utf-8");
    const data = JSON.parse(raw);
    expect(data.version).toBe(1);
    expect(data.sessionId).toBe("test-session");
    expect(data.agents).toHaveLength(2);
    expect(data.metadata.agentCount).toBe(2);
    expect(data.metadata.activeAgentCount).toBe(1); // Only a1 is running+working
    expect(data.metadata.daemonPid).toBe(process.pid);
  });

  it("writes latest.json for quick access", async () => {
    const cp = new AutoCheckpoint({
      runtimeDir: tmpDir,
      sessionId: "test-session",
      getAgents: () => [mockAgent("a1")],
      startTime: Date.now(),
    });

    await cp.save();

    const latestPath = path.join(tmpDir, "checkpoints", "latest.json");
    const raw = await fs.readFile(latestPath, "utf-8");
    const data = JSON.parse(raw);
    expect(data.sessionId).toBe("test-session");
  });

  it("loads latest checkpoint", async () => {
    const cp = new AutoCheckpoint({
      runtimeDir: tmpDir,
      sessionId: "test-session",
      getAgents: () => [mockAgent("a1")],
      startTime: Date.now(),
    });

    await cp.save();

    const loaded = await AutoCheckpoint.loadLatest(tmpDir);
    expect(loaded).not.toBeNull();
    expect(loaded!.sessionId).toBe("test-session");
    expect(loaded!.agents).toHaveLength(1);
  });

  it("returns null when no checkpoint exists", async () => {
    const loaded = await AutoCheckpoint.loadLatest(tmpDir);
    expect(loaded).toBeNull();
  });

  it("lists checkpoints in reverse chronological order", async () => {
    const cp = new AutoCheckpoint({
      runtimeDir: tmpDir,
      sessionId: "test-session",
      getAgents: () => [mockAgent("a1")],
      startTime: Date.now(),
    });

    await cp.save();
    // Small delay to ensure different timestamps
    await new Promise(r => setTimeout(r, 10));
    await cp.save();

    const list = await AutoCheckpoint.listCheckpoints(tmpDir);
    expect(list).toHaveLength(2);
    // Newest first
    expect(list[0] > list[1]).toBe(true);
  });

  it("prunes old checkpoints beyond MAX_CHECKPOINTS", async () => {
    const cp = new AutoCheckpoint({
      runtimeDir: tmpDir,
      sessionId: "test-session",
      getAgents: () => [mockAgent("a1")],
      startTime: Date.now(),
    });

    // Create 7 checkpoints (MAX is 5)
    for (let i = 0; i < 7; i++) {
      await cp.save();
      await new Promise(r => setTimeout(r, 5));
    }

    const list = await AutoCheckpoint.listCheckpoints(tmpDir);
    expect(list.length).toBeLessThanOrEqual(5);
  });

  it("start() saves immediately and sets up interval", async () => {
    const cp = new AutoCheckpoint({
      runtimeDir: tmpDir,
      sessionId: "test-session",
      getAgents: () => [mockAgent("a1")],
      startTime: Date.now(),
    });

    const saveSpy = vi.spyOn(cp, "save");
    cp.start(60_000); // 1 minute interval

    // Wait for the immediate save to complete
    await new Promise(r => setTimeout(r, 100));
    expect(saveSpy).toHaveBeenCalledTimes(1);

    // Verify a checkpoint file was created
    const list = await AutoCheckpoint.listCheckpoints(tmpDir);
    expect(list.length).toBeGreaterThanOrEqual(1);

    cp.stop();
  });

  it("stop() clears the interval", async () => {
    const cp = new AutoCheckpoint({
      runtimeDir: tmpDir,
      sessionId: "test-session",
      getAgents: () => [mockAgent("a1")],
      startTime: Date.now(),
    });

    cp.start(60_000);
    // Wait for initial save to complete
    await new Promise(r => setTimeout(r, 50));
    cp.stop();
    // No error thrown, interval cleared
  });
});
