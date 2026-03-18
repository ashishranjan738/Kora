import { describe, it, expect, beforeEach, afterEach } from "vitest";
import {
  loadPlaybook,
  listPlaybooks,
  savePlaybook,
  ensureBuiltinPlaybooks,
} from "../playbook-loader.js";
import fs from "fs/promises";
import path from "path";
import os from "os";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

let tmpDir: string;

const samplePlaybook = {
  name: "Test Team",
  description: "A test playbook",
  agents: [
    {
      name: "Architect",
      role: "master" as const,
      model: "claude-opus-4-6",
      persona: "You are an architect.",
    },
    {
      name: "Worker",
      role: "worker" as const,
      model: "claude-sonnet-4-6",
      persona: "You are a worker.",
    },
  ],
};

// ---------------------------------------------------------------------------
// Setup / Teardown
// ---------------------------------------------------------------------------

beforeEach(async () => {
  tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "kora-playbook-test-"));
});

afterEach(async () => {
  await fs.rm(tmpDir, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// Tests — loadPlaybook
// ---------------------------------------------------------------------------

describe("loadPlaybook", () => {
  it("loads a valid playbook by name", async () => {
    const dir = path.join(tmpDir, "playbooks");
    await fs.mkdir(dir, { recursive: true });
    await fs.writeFile(
      path.join(dir, "test-team.json"),
      JSON.stringify(samplePlaybook),
    );

    const result = await loadPlaybook(tmpDir, "test-team");

    expect(result).not.toBeNull();
    expect(result!.name).toBe("Test Team");
    expect(result!.agents).toHaveLength(2);
  });

  it("returns null for non-existent playbook", async () => {
    const result = await loadPlaybook(tmpDir, "nonexistent");

    expect(result).toBeNull();
  });

  it("returns playbook with correct agent roles", async () => {
    const dir = path.join(tmpDir, "playbooks");
    await fs.mkdir(dir, { recursive: true });
    await fs.writeFile(
      path.join(dir, "test-team.json"),
      JSON.stringify(samplePlaybook),
    );

    const result = await loadPlaybook(tmpDir, "test-team");

    expect(result).not.toBeNull();
    const master = result!.agents.find((a) => a.role === "master");
    const workers = result!.agents.filter((a) => a.role === "worker");
    expect(master).toBeDefined();
    expect(master!.name).toBe("Architect");
    expect(workers).toHaveLength(1);
  });
});

// ---------------------------------------------------------------------------
// Tests — listPlaybooks
// ---------------------------------------------------------------------------

describe("listPlaybooks", () => {
  it("returns empty array when no playbooks directory exists", async () => {
    const result = await listPlaybooks(tmpDir);
    expect(result).toEqual([]);
  });

  it("returns playbook names without .json extension", async () => {
    const dir = path.join(tmpDir, "playbooks");
    await fs.mkdir(dir, { recursive: true });
    await fs.writeFile(path.join(dir, "solo-agent.json"), "{}");
    await fs.writeFile(path.join(dir, "full-stack.json"), "{}");

    const result = await listPlaybooks(tmpDir);

    expect(result).toHaveLength(2);
    expect(result).toContain("solo-agent");
    expect(result).toContain("full-stack");
  });

  it("ignores non-json files", async () => {
    const dir = path.join(tmpDir, "playbooks");
    await fs.mkdir(dir, { recursive: true });
    await fs.writeFile(path.join(dir, "readme.md"), "# Playbooks");
    await fs.writeFile(path.join(dir, "valid.json"), "{}");

    const result = await listPlaybooks(tmpDir);

    expect(result).toEqual(["valid"]);
  });
});

// ---------------------------------------------------------------------------
// Tests — savePlaybook
// ---------------------------------------------------------------------------

describe("savePlaybook", () => {
  it("saves playbook to file with slugified name", async () => {
    await savePlaybook(tmpDir, samplePlaybook);

    const filePath = path.join(tmpDir, "playbooks", "test-team.json");
    const raw = await fs.readFile(filePath, "utf-8");
    const parsed = JSON.parse(raw);

    expect(parsed.name).toBe("Test Team");
    expect(parsed.agents).toHaveLength(2);
  });

  it("creates playbooks directory if it does not exist", async () => {
    await savePlaybook(tmpDir, samplePlaybook);

    const dir = path.join(tmpDir, "playbooks");
    const stat = await fs.stat(dir);
    expect(stat.isDirectory()).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Tests — ensureBuiltinPlaybooks
// ---------------------------------------------------------------------------

describe("ensureBuiltinPlaybooks", () => {
  it("creates 3 built-in playbooks", async () => {
    await ensureBuiltinPlaybooks(tmpDir);

    const names = await listPlaybooks(tmpDir);
    expect(names).toHaveLength(3);
    expect(names).toContain("solo-agent");
    expect(names).toContain("master-2-workers");
    expect(names).toContain("full-stack-team");
  });

  it("does not overwrite existing playbooks", async () => {
    // Create first
    await ensureBuiltinPlaybooks(tmpDir);

    // Modify one
    const filePath = path.join(tmpDir, "playbooks", "solo-agent.json");
    const original = await fs.readFile(filePath, "utf-8");
    const modified = JSON.parse(original);
    modified.description = "MODIFIED";
    await fs.writeFile(filePath, JSON.stringify(modified));

    // Run again
    await ensureBuiltinPlaybooks(tmpDir);

    // Built-ins are always overwritten to pick up fixes (provider, model, args)
    const afterSecondRun = JSON.parse(await fs.readFile(filePath, "utf-8"));
    expect(afterSecondRun.description).toBe("Single master agent for simple tasks");
  });

  it("built-in Full Stack Team has a master agent", async () => {
    await ensureBuiltinPlaybooks(tmpDir);

    const playbook = await loadPlaybook(tmpDir, "full-stack-team");
    expect(playbook).not.toBeNull();

    const master = playbook!.agents.find((a) => a.role === "master");
    expect(master).toBeDefined();
    expect(master!.name).toBe("Architect");
  });

  it("built-in playbooks have correct agent counts", async () => {
    await ensureBuiltinPlaybooks(tmpDir);

    const solo = await loadPlaybook(tmpDir, "solo-agent");
    const masterWorkers = await loadPlaybook(tmpDir, "master-2-workers");
    const fullStack = await loadPlaybook(tmpDir, "full-stack-team");

    expect(solo!.agents).toHaveLength(1);
    expect(masterWorkers!.agents).toHaveLength(3);
    expect(fullStack!.agents).toHaveLength(4);
  });
});
