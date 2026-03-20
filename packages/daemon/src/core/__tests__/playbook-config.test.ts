import { describe, it, expect, beforeEach, vi } from "vitest";
import { ensureBuiltinPlaybooks, loadPlaybook, savePlaybook } from "../playbook-loader.js";
import type { Playbook } from "../playbook-loader.js";
import fs from "fs/promises";
import path from "path";

// Mock fs/promises
vi.mock("fs/promises");

describe("Playbook configuration", () => {
  const testConfigDir = "/tmp/test-config";

  beforeEach(() => {
    vi.clearAllMocks();
    // Mock fs.mkdir to always succeed
    vi.mocked(fs.mkdir).mockResolvedValue(undefined);
    // Mock fs.writeFile to always succeed
    vi.mocked(fs.writeFile).mockResolvedValue(undefined);
  });

  // Test 1: Model field passes through from playbook to agent
  it("preserves model field in playbook agents", async () => {
    const playbook: Playbook = {
      name: "Test Playbook",
      description: "Test",
      agents: [
        { name: "Agent1", role: "master", model: "claude-3-5-sonnet-20241022" },
        { name: "Agent2", role: "worker", model: "default" },
      ],
    };

    await savePlaybook(testConfigDir, playbook);

    // Verify the saved content includes the model field
    const writeCall = vi.mocked(fs.writeFile).mock.calls[0];
    const savedData = JSON.parse(writeCall[1] as string);
    expect(savedData.agents[0].model).toBe("claude-3-5-sonnet-20241022");
    expect(savedData.agents[1].model).toBe("default");
  });

  // Test 2: extraCliArgs passes through from playbook to agent
  it("preserves extraCliArgs in playbook agents", async () => {
    const playbook: Playbook = {
      name: "Test Playbook",
      description: "Test",
      agents: [
        {
          name: "Agent1",
          role: "master",
          model: "default",
          extraCliArgs: ["--dangerously-skip-permissions", "--budget", "1000"],
        },
      ],
    };

    await savePlaybook(testConfigDir, playbook);

    const writeCall = vi.mocked(fs.writeFile).mock.calls[0];
    const savedData = JSON.parse(writeCall[1] as string);
    expect(savedData.agents[0].extraCliArgs).toEqual([
      "--dangerously-skip-permissions",
      "--budget",
      "1000",
    ]);
  });

  // Test 3: Built-in playbook agents do NOT hardcode --dangerously-skip-permissions
  it("ensures built-in playbook agents do not hardcode --dangerously-skip-permissions", async () => {
    await ensureBuiltinPlaybooks(testConfigDir);

    const writeCalls = vi.mocked(fs.writeFile).mock.calls;

    for (const call of writeCalls) {
      const playbookData = JSON.parse(call[1] as string);
      const playbook = playbookData as Playbook;

      for (const agent of playbook.agents) {
        // Agents should not have --dangerously-skip-permissions hardcoded;
        // users add it explicitly via CLI flags in the playbook launch dialog
        if (agent.extraCliArgs) {
          expect(agent.extraCliArgs).not.toContain("--dangerously-skip-permissions");
        }
      }
    }
  });

  // Test 4: No agent has provider: "codex"
  it("ensures no built-in playbook agents use codex provider", async () => {
    await ensureBuiltinPlaybooks(testConfigDir);

    const writeCalls = vi.mocked(fs.writeFile).mock.calls;

    for (const call of writeCalls) {
      const playbookData = JSON.parse(call[1] as string);
      const playbook = playbookData as Playbook;

      for (const agent of playbook.agents) {
        expect(agent.provider).not.toBe("codex");
      }
    }
  });

  // Test 5: ensureBuiltinPlaybooks overwrites stale on-disk files
  it("always overwrites built-in playbook files to pick up fixes", async () => {
    await ensureBuiltinPlaybooks(testConfigDir);

    // ensureBuiltinPlaybooks should write all built-in playbooks
    // Verify writeFile was called for each built-in
    const writeCalls = vi.mocked(fs.writeFile).mock.calls;

    // Should have written at least 3 built-in playbooks
    expect(writeCalls.length).toBeGreaterThanOrEqual(3);

    // Verify Solo Agent playbook
    const soloAgentCall = writeCalls.find((call) => {
      const data = JSON.parse(call[1] as string);
      return data.name === "Solo Agent";
    });
    expect(soloAgentCall).toBeDefined();

    // Verify Master + 2 Workers playbook
    const masterWorkersCall = writeCalls.find((call) => {
      const data = JSON.parse(call[1] as string);
      return data.name === "Master + 2 Workers";
    });
    expect(masterWorkersCall).toBeDefined();

    // Verify Full Stack Team playbook
    const fullStackCall = writeCalls.find((call) => {
      const data = JSON.parse(call[1] as string);
      return data.name === "Full Stack Team";
    });
    expect(fullStackCall).toBeDefined();
  });

  // Test 6: Provider defaults to session defaultProvider when omitted
  it("allows provider field to be omitted from agent config", async () => {
    const playbook: Playbook = {
      name: "Test Playbook",
      description: "Test",
      agents: [
        {
          name: "Agent1",
          role: "master",
          model: "default",
          // provider is optional and omitted
        },
      ],
    };

    await savePlaybook(testConfigDir, playbook);

    const writeCall = vi.mocked(fs.writeFile).mock.calls[0];
    const savedData = JSON.parse(writeCall[1] as string);

    // Provider should be undefined/null (not present) so it defaults to session provider
    expect(savedData.agents[0].provider).toBeUndefined();
  });

  // Test 7: Built-in playbooks use model: "default"
  it("ensures all built-in playbook agents use model: default", async () => {
    await ensureBuiltinPlaybooks(testConfigDir);

    const writeCalls = vi.mocked(fs.writeFile).mock.calls;

    for (const call of writeCalls) {
      const playbookData = JSON.parse(call[1] as string);
      const playbook = playbookData as Playbook;

      for (const agent of playbook.agents) {
        expect(agent.model).toBe("default");
      }
    }
  });
});
