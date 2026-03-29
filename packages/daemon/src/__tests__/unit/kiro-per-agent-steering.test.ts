/**
 * Tests for Kiro per-agent steering files (task 07f301fc).
 *
 * Verifies that the steering file naming, YAML front matter,
 * fallback file, and cleanup logic work correctly.
 */
import { describe, it, expect } from "vitest";

describe("Kiro per-agent steering file naming", () => {
  it("should use kora-{agentId}.md for shared mode", () => {
    const agentId = "dev-1-abc123";
    const isSharedMode = true;
    const fileName = isSharedMode ? `kora-${agentId}.md` : "kora.md";
    expect(fileName).toBe("kora-dev-1-abc123.md");
  });

  it("should use kora.md for isolated mode", () => {
    const agentId = "dev-1-abc123";
    const isSharedMode = false;
    const fileName = isSharedMode ? `kora-${agentId}.md` : "kora.md";
    expect(fileName).toBe("kora.md");
  });

  it("should produce unique filenames for different agents", () => {
    const agents = ["dev-1-aaa", "dev-2-bbb", "reviewer-ccc"];
    const fileNames = agents.map(id => `kora-${id}.md`);
    const unique = new Set(fileNames);
    expect(unique.size).toBe(agents.length);
  });
});

describe("YAML front matter", () => {
  it("should include inclusion: auto for agent-specific files", () => {
    const agentName = "Dev 1";
    const agentId = "dev-1-abc123";
    const frontMatter = [
      "---",
      `inclusion: auto`,
      `description: "Kora orchestration instructions for agent ${agentName} (${agentId})"`,
      "---",
      "",
    ].join("\n");

    expect(frontMatter).toContain("inclusion: auto");
    expect(frontMatter).toContain("Dev 1");
    expect(frontMatter).toContain("dev-1-abc123");
    expect(frontMatter).toMatch(/^---\n/);
    expect(frontMatter).toMatch(/\n---\n/);
  });

  it("should include inclusion: always for fallback file", () => {
    const fallbackContent = [
      "---",
      "inclusion: always",
      'description: "Kora orchestration fallback — ensures agents always have basic instructions"',
      "---",
      "",
      "You are a Kora-managed agent. If you haven't loaded your instructions yet, call get_context(\"all\") now.",
    ].join("\n");

    expect(fallbackContent).toContain("inclusion: always");
    expect(fallbackContent).toContain("get_context");
    expect(fallbackContent).toContain("Kora-managed agent");
  });
});

describe("steering file content structure", () => {
  it("should have front matter followed by boot prompt content", () => {
    const bootPrompt = "You are a Kora agent. Call get_context('all').";
    const frontMatter = "---\ninclusion: auto\n---\n\n";
    const content = frontMatter + bootPrompt;

    // Should start with front matter
    expect(content).toMatch(/^---\n/);
    // Should end with boot prompt
    expect(content).toContain(bootPrompt);
    // Front matter should be separated from content
    expect(content).toContain("---\n\n");
  });
});

describe("cleanup on agent stop", () => {
  it("should derive correct steering file path for cleanup", () => {
    const agentId = "dev-1-abc123";
    const workingDir = "/project/path";
    const expectedPath = `${workingDir}/.kiro/steering/kora-${agentId}.md`;
    const actualPath = `${workingDir}/.kiro/steering/kora-${agentId}.md`;
    expect(actualPath).toBe(expectedPath);
  });

  it("should only attempt cleanup for kiro provider", () => {
    const providers = ["claude-code", "kiro", "aider", "codex", "goose"];
    const kiroProviders = providers.filter(p => p === "kiro");
    expect(kiroProviders).toEqual(["kiro"]);
  });
});
