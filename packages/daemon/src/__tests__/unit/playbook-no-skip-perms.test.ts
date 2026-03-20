/**
 * Tests that built-in playbooks do NOT hardcode --dangerously-skip-permissions.
 * Users should add this flag explicitly via the CLI flags field.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { ensureBuiltinPlaybooks, loadPlaybook, listPlaybooks } from "../../core/playbook-loader.js";
import fs from "fs/promises";
import path from "path";

vi.mock("fs/promises");

describe("Built-in playbooks security", () => {
  const testDir = "/tmp/test-playbook-security";

  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(fs.mkdir).mockResolvedValue(undefined);
    vi.mocked(fs.writeFile).mockResolvedValue(undefined);
  });

  it("no built-in playbook has --dangerously-skip-permissions", async () => {
    await ensureBuiltinPlaybooks(testDir);

    const writeCalls = vi.mocked(fs.writeFile).mock.calls;
    expect(writeCalls.length).toBeGreaterThan(0);

    for (const call of writeCalls) {
      const data = JSON.parse(call[1] as string);
      for (const agent of data.agents || []) {
        const args = agent.extraCliArgs || [];
        expect(args).not.toContain("--dangerously-skip-permissions");
      }
    }
  });

  it("Two-Pizza Team playbook has 8 agents", async () => {
    await ensureBuiltinPlaybooks(testDir);

    const writeCalls = vi.mocked(fs.writeFile).mock.calls;
    const pizzaCall = writeCalls.find(call => {
      const data = JSON.parse(call[1] as string);
      return data.name === "Two-Pizza Team";
    });

    expect(pizzaCall).toBeDefined();
    const data = JSON.parse(pizzaCall![1] as string);
    expect(data.agents).toHaveLength(8);

    // Check roles
    const roles = data.agents.map((a: any) => a.role);
    expect(roles.filter((r: string) => r === "master")).toHaveLength(1);
    expect(roles.filter((r: string) => r === "worker")).toHaveLength(7);

    // Check key agent names
    const names = data.agents.map((a: any) => a.name);
    expect(names).toContain("Engineering Manager");
    expect(names).toContain("Product Manager");
    expect(names).toContain("Researcher");
    expect(names).toContain("Tester");
    expect(names).toContain("Reviewer");
  });

  it("all built-in playbooks have at least one master agent", async () => {
    await ensureBuiltinPlaybooks(testDir);

    const writeCalls = vi.mocked(fs.writeFile).mock.calls;
    for (const call of writeCalls) {
      const data = JSON.parse(call[1] as string);
      const hasMaster = data.agents.some((a: any) => a.role === "master");
      expect(hasMaster).toBe(true);
    }
  });
});
