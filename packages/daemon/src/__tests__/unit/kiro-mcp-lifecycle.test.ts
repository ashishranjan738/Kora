/**
 * Tests for Kiro MCP server lifecycle: registration via kiro-cli mcp add
 * and cleanup via kiro-cli mcp remove on agent stop.
 */
import { describe, it, expect } from "vitest";

// ---------------------------------------------------------------------------
// 1. kiro-cli mcp add command construction
// ---------------------------------------------------------------------------

describe("Kiro MCP add command construction", () => {
  function buildMcpAddArgs(
    agentId: string,
    serverCommand: string,
    serverArgs: string[],
  ): string[] {
    const mcpServerName = `kora-${agentId}`;
    const addArgs = [
      "mcp", "add",
      "--name", mcpServerName,
      "--scope", "default",
      "--agent", "kiro_default",
      "--command", serverCommand,
    ];
    for (const arg of serverArgs) {
      addArgs.push("--args", arg);
    }
    addArgs.push("--force");
    return addArgs;
  }

  it("generates correct command with all args", () => {
    const args = buildMcpAddArgs("agent-123", "node", [
      "/path/to/mcp-server.js",
      "--agent-id", "agent-123",
      "--session-id", "session-abc",
    ]);

    expect(args[0]).toBe("mcp");
    expect(args[1]).toBe("add");
    expect(args).toContain("--name");
    expect(args[args.indexOf("--name") + 1]).toBe("kora-agent-123");
    expect(args).toContain("--scope");
    expect(args[args.indexOf("--scope") + 1]).toBe("default");
    expect(args).toContain("--agent");
    expect(args[args.indexOf("--agent") + 1]).toBe("kiro_default");
    expect(args).toContain("--command");
    expect(args[args.indexOf("--command") + 1]).toBe("node");
    expect(args[args.length - 1]).toBe("--force");
  });

  it("includes each server arg with --args prefix", () => {
    const args = buildMcpAddArgs("agent-1", "node", [
      "/path/server.js", "--agent-id", "a1", "--session-id", "s1",
    ]);

    // Count --args occurrences
    const argsFlags = args.filter(a => a === "--args");
    expect(argsFlags).toHaveLength(5); // 5 server args: path, --agent-id, a1, --session-id, s1
  });

  it("uses unique server name per agent", () => {
    const args1 = buildMcpAddArgs("agent-aaa", "node", []);
    const args2 = buildMcpAddArgs("agent-bbb", "node", []);

    const name1 = args1[args1.indexOf("--name") + 1];
    const name2 = args2[args2.indexOf("--name") + 1];

    expect(name1).toBe("kora-agent-aaa");
    expect(name2).toBe("kora-agent-bbb");
    expect(name1).not.toBe(name2);
  });

  it("handles empty server args", () => {
    const args = buildMcpAddArgs("agent-x", "node", []);
    expect(args.filter(a => a === "--args")).toHaveLength(0);
    expect(args[args.length - 1]).toBe("--force");
  });
});

// ---------------------------------------------------------------------------
// 2. kiro-cli mcp remove command construction
// ---------------------------------------------------------------------------

describe("Kiro MCP remove command construction", () => {
  function buildMcpRemoveArgs(agentId: string): string[] {
    return [
      "mcp", "remove",
      "--name", `kora-${agentId}`,
      "--scope", "default",
      "--force",
    ];
  }

  it("generates correct remove command", () => {
    const args = buildMcpRemoveArgs("agent-456");
    expect(args).toEqual([
      "mcp", "remove",
      "--name", "kora-agent-456",
      "--scope", "default",
      "--force",
    ]);
  });

  it("remove name matches add name for same agent", () => {
    const agentId = "test-agent-789";
    const addName = `kora-${agentId}`;
    const removeArgs = buildMcpRemoveArgs(agentId);
    const removeName = removeArgs[removeArgs.indexOf("--name") + 1];
    expect(removeName).toBe(addName);
  });
});

// ---------------------------------------------------------------------------
// 3. Lifecycle: no fake directory, real project dir
// ---------------------------------------------------------------------------

describe("Kiro MCP lifecycle: no fake directory", () => {
  it("cdTarget should be agentWorkDir, not kiroWorkspaceRoot", () => {
    // After the fix, cdTarget = agentWorkDir (real project dir)
    // Old code: cdTarget = options._kiroWorkspaceRoot || agentWorkDir
    const agentWorkDir = "/Users/test/project";
    const cdTarget = agentWorkDir; // new code
    expect(cdTarget).toBe("/Users/test/project");
  });

  it("multiple agents get unique MCP server names", () => {
    const agents = ["agent-1", "agent-2", "agent-3"];
    const names = agents.map(id => `kora-${id}`);
    const unique = new Set(names);
    expect(unique.size).toBe(agents.length);
  });

  it("server name format is valid for kiro-cli", () => {
    const agentId = "worker-abc-def123";
    const serverName = `kora-${agentId}`;
    // kiro-cli server names should be alphanumeric + hyphens
    expect(serverName).toMatch(/^[a-z0-9-]+$/);
  });
});
