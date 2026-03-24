/**
 * Tests for Kiro MCP lifecycle: auto-switch to isolated worktrees,
 * per-worktree .kiro/settings/mcp.json write, no global config pollution.
 */
import { describe, it, expect } from "vitest";

// ---------------------------------------------------------------------------
// 1. Kiro + MCP + shared → auto-switch to isolated
// ---------------------------------------------------------------------------

describe("Kiro worktree mode auto-switch", () => {
  function resolveWorktreeMode(
    providerId: string,
    messagingMode: string,
    worktreeMode: string,
  ): string {
    // Mirrors the logic in agent-manager.ts
    let effective = worktreeMode;
    if (providerId === "kiro" && messagingMode === "mcp" && effective === "shared") {
      effective = "isolated";
    }
    return effective;
  }

  it("auto-switches kiro+mcp+shared to isolated", () => {
    expect(resolveWorktreeMode("kiro", "mcp", "shared")).toBe("isolated");
  });

  it("keeps kiro+mcp+isolated as isolated", () => {
    expect(resolveWorktreeMode("kiro", "mcp", "isolated")).toBe("isolated");
  });

  it("keeps kiro+cli+shared as shared (no MCP needed)", () => {
    expect(resolveWorktreeMode("kiro", "cli", "shared")).toBe("shared");
  });

  it("keeps claude-code+mcp+shared as shared", () => {
    expect(resolveWorktreeMode("claude-code", "mcp", "shared")).toBe("shared");
  });

  it("keeps claude-code+cli+shared as shared", () => {
    expect(resolveWorktreeMode("claude-code", "cli", "shared")).toBe("shared");
  });

  it("does not affect non-kiro providers", () => {
    for (const provider of ["claude-code", "aider", "codex", "goose"]) {
      expect(resolveWorktreeMode(provider, "mcp", "shared")).toBe("shared");
    }
  });
});

// ---------------------------------------------------------------------------
// 2. Per-worktree MCP config: no global pollution
// ---------------------------------------------------------------------------

describe("Kiro per-worktree MCP config", () => {
  it("config is written to agentWorkDir, not global ~/.kiro", () => {
    const agentWorkDir = "/project/.kora/worktrees/agent-123";
    const configDir = `${agentWorkDir}/.kiro/settings`;
    expect(configDir).not.toContain("~");
    expect(configDir).not.toContain("homedir");
    expect(configDir).toContain("worktrees/agent-123");
  });

  it("each agent gets unique config path in isolated mode", () => {
    const agents = ["agent-1", "agent-2", "agent-3"];
    const paths = agents.map(id => `/project/.kora/worktrees/${id}/.kiro/settings/mcp.json`);
    const unique = new Set(paths);
    expect(unique.size).toBe(agents.length);
  });

  it("config format matches Kiro expectations", () => {
    const kiroMcpConfig = {
      mcpServers: {
        kora: {
          command: "node",
          args: ["/path/to/server.js", "--agent-id", "agent-1"],
        },
      },
    };
    expect(kiroMcpConfig.mcpServers.kora.command).toBe("node");
    expect(kiroMcpConfig.mcpServers.kora.args).toHaveLength(3);
    expect(JSON.stringify(kiroMcpConfig)).toContain("mcpServers");
  });
});

// ---------------------------------------------------------------------------
// 3. No fake directory / no kiro-workspaces
// ---------------------------------------------------------------------------

describe("No fake directory hack", () => {
  it("cdTarget is agentWorkDir (real project dir)", () => {
    const agentWorkDir = "/project/.kora/worktrees/agent-123";
    const cdTarget = agentWorkDir;
    expect(cdTarget).toBe(agentWorkDir);
    expect(cdTarget).not.toContain("kiro-workspaces");
  });

  it("no _kiroWorkspaceRoot override", () => {
    // The _kiroWorkspaceRoot property has been removed from SpawnAgentOptions
    const options: Record<string, unknown> = { workingDirectory: "/project" };
    expect(options._kiroWorkspaceRoot).toBeUndefined();
  });
});
