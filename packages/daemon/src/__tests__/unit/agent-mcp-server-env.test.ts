/**
 * Tests for MCP server env var fallback — agent identity resolution.
 * Verifies CLI args > env vars > defaults priority chain.
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";

// ---------------------------------------------------------------------------
// Helper: simulates the MCP server's identity resolution logic
// ---------------------------------------------------------------------------

function getArg(args: string[], name: string): string {
  const idx = args.indexOf(`--${name}`);
  return idx >= 0 && idx + 1 < args.length ? args[idx + 1] : "";
}

function resolveIdentity(
  cliArgs: string[],
  env: Record<string, string | undefined>,
) {
  return {
    agentId: getArg(cliArgs, "agent-id") || env.KORA_AGENT_ID || "",
    sessionId: getArg(cliArgs, "session-id") || env.KORA_SESSION_ID || "",
    projectPath: getArg(cliArgs, "project-path") || env.KORA_PROJECT_PATH || "",
    agentRole: getArg(cliArgs, "agent-role") || env.KORA_AGENT_ROLE || "worker",
    daemonUrl: getArg(cliArgs, "daemon-url") || env.KORA_DAEMON_URL || "",
    token: getArg(cliArgs, "token") || env.KORA_TOKEN || "",
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("MCP server env var fallback", () => {
  it("resolves identity from CLI args only (backward compat)", () => {
    const id = resolveIdentity(
      ["--agent-id", "agent-1", "--session-id", "sess-1", "--token", "tok-1", "--daemon-url", "http://localhost:7890"],
      {},
    );
    expect(id.agentId).toBe("agent-1");
    expect(id.sessionId).toBe("sess-1");
    expect(id.token).toBe("tok-1");
    expect(id.daemonUrl).toBe("http://localhost:7890");
    expect(id.agentRole).toBe("worker"); // default
  });

  it("resolves identity from env vars only (zero CLI args)", () => {
    const id = resolveIdentity([], {
      KORA_AGENT_ID: "env-agent",
      KORA_SESSION_ID: "env-session",
      KORA_TOKEN: "env-token",
      KORA_DAEMON_URL: "http://localhost:7891",
      KORA_AGENT_ROLE: "master",
      KORA_PROJECT_PATH: "/tmp/project",
    });
    expect(id.agentId).toBe("env-agent");
    expect(id.sessionId).toBe("env-session");
    expect(id.token).toBe("env-token");
    expect(id.daemonUrl).toBe("http://localhost:7891");
    expect(id.agentRole).toBe("master");
    expect(id.projectPath).toBe("/tmp/project");
  });

  it("CLI args take precedence over env vars", () => {
    const id = resolveIdentity(
      ["--agent-id", "cli-agent", "--session-id", "cli-session"],
      { KORA_AGENT_ID: "env-agent", KORA_SESSION_ID: "env-session" },
    );
    expect(id.agentId).toBe("cli-agent");
    expect(id.sessionId).toBe("cli-session");
  });

  it("mixed: some from CLI, some from env", () => {
    const id = resolveIdentity(
      ["--agent-id", "cli-agent"],
      { KORA_SESSION_ID: "env-session", KORA_TOKEN: "env-token", KORA_AGENT_ROLE: "master" },
    );
    expect(id.agentId).toBe("cli-agent");      // from CLI
    expect(id.sessionId).toBe("env-session");   // from env
    expect(id.token).toBe("env-token");         // from env
    expect(id.agentRole).toBe("master");        // from env
  });

  it("returns empty strings when neither CLI nor env provided", () => {
    const id = resolveIdentity([], {});
    expect(id.agentId).toBe("");
    expect(id.sessionId).toBe("");
    expect(id.token).toBe("");
    expect(id.daemonUrl).toBe("");
    expect(id.projectPath).toBe("");
  });

  it("agent role defaults to 'worker' when not specified", () => {
    const id = resolveIdentity([], {});
    expect(id.agentRole).toBe("worker");
  });

  it("each env var works individually", () => {
    const vars = [
      { env: { KORA_AGENT_ID: "a1" }, field: "agentId", expected: "a1" },
      { env: { KORA_SESSION_ID: "s1" }, field: "sessionId", expected: "s1" },
      { env: { KORA_TOKEN: "t1" }, field: "token", expected: "t1" },
      { env: { KORA_DAEMON_URL: "http://x" }, field: "daemonUrl", expected: "http://x" },
      { env: { KORA_AGENT_ROLE: "master" }, field: "agentRole", expected: "master" },
      { env: { KORA_PROJECT_PATH: "/p" }, field: "projectPath", expected: "/p" },
    ];

    for (const { env, field, expected } of vars) {
      const id = resolveIdentity([], env);
      expect((id as any)[field], `${field} from env`).toBe(expected);
    }
  });

  it("empty CLI arg does not override env var", () => {
    // getArg returns "" for missing args, which is falsy → env var kicks in
    const id = resolveIdentity(
      ["--agent-id"], // missing value after flag
      { KORA_AGENT_ID: "env-agent" },
    );
    // --agent-id with no value: getArg returns "" (idx+1 is "--agent-id" itself? no, it's out of bounds)
    // Actually --agent-id at end of array: idx=0, idx+1=1, args[1] is undefined → returns ""
    expect(id.agentId).toBe("env-agent");
  });
});
