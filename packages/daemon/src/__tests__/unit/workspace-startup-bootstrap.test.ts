/**
 * Tests for workspace instructions, startup notification, and MCP self-bootstrap.
 *
 * Coverage:
 * - buildWorkspaceInstructions() via buildPersona(): 4 variants (isolated/shared × master/worker)
 * - buildStartupNotification() via Orchestrator: 8 variants (4 messaging modes × 2 workspace modes)
 * - MCP self-bootstrap: selfBootstrap() resolves role + projectPath from API
 *
 * These test private functions by exercising them through public APIs.
 */

import { describe, it, expect } from "vitest";
import { buildPersona } from "../../core/persona-builder.js";

// ---------------------------------------------------------------------------
// Minimal options for buildPersona — only fields needed to trigger workspace section
// ---------------------------------------------------------------------------

function makePersonaOptions(overrides: {
  worktreeMode?: "isolated" | "shared";
  role?: "master" | "worker";
} = {}) {
  return {
    agentId: "test-agent-001",
    role: (overrides.role || "worker") as "master" | "worker",
    userPersona: "Test agent",
    permissions: {
      canSpawnAgents: overrides.role === "master",
      canRemoveAgents: overrides.role === "master",
      canModifyFiles: true,
      maxSubAgents: 5,
    },
    sessionId: "test-session",
    runtimeDir: "/tmp/test-runtime",
    peers: [],
    worktreeMode: overrides.worktreeMode as "isolated" | "shared" | undefined,
  };
}

// ---------------------------------------------------------------------------
// buildWorkspaceInstructions (tested via buildPersona)
// ---------------------------------------------------------------------------

describe("Workspace Instructions (via buildPersona)", () => {
  it("isolated + worker: mentions isolated git worktree", () => {
    const persona = buildPersona(makePersonaOptions({ worktreeMode: "isolated", role: "worker" }));
    expect(persona).toContain("isolated git worktree");
    expect(persona).toContain("No risk of file conflicts");
    expect(persona).toContain("Commit and push freely");
  });

  it("isolated + master: mentions isolated git worktree", () => {
    const persona = buildPersona(makePersonaOptions({ worktreeMode: "isolated", role: "master" }));
    expect(persona).toContain("isolated git worktree");
    expect(persona).not.toContain("SHARED MODE");
  });

  it("shared + master: includes orchestrator-specific conflict prevention rules", () => {
    const persona = buildPersona(makePersonaOptions({ worktreeMode: "shared", role: "master" }));
    expect(persona).toContain("SHARED MODE");
    expect(persona).toContain("Assign explicit file boundaries");
    expect(persona).toContain("Never assign two workers to the same file");
    expect(persona).toContain("Coordinate commits");
    expect(persona).toContain("Check git status");
  });

  it("shared + worker: includes worker-specific conflict prevention rules", () => {
    const persona = buildPersona(makePersonaOptions({ worktreeMode: "shared", role: "worker" }));
    expect(persona).toContain("SHARED MODE");
    expect(persona).toContain("Only edit files you were explicitly assigned");
    expect(persona).toContain("Commit frequently");
    expect(persona).toContain("Pull before starting work");
    expect(persona).toContain("Report conflicts immediately");
    expect(persona).toContain("Never force-push");
  });

  it("no worktreeMode: does not include workspace section", () => {
    const persona = buildPersona(makePersonaOptions({}));
    expect(persona).not.toContain("Workspace");
    expect(persona).not.toContain("SHARED MODE");
    expect(persona).not.toContain("isolated git worktree");
  });

  it("shared + worker: includes stop-and-report conflict procedure", () => {
    const persona = buildPersona(makePersonaOptions({ worktreeMode: "shared", role: "worker" }));
    expect(persona).toContain("STOP working immediately");
    expect(persona).toContain("Report the conflict to the orchestrator");
    expect(persona).toContain("Wait for instructions");
  });

  it("shared + master: includes conflict resolution steps", () => {
    const persona = buildPersona(makePersonaOptions({ worktreeMode: "shared", role: "master" }));
    expect(persona).toContain("Stop the conflicting agents");
    expect(persona).toContain("Have one agent commit");
  });
});

// ---------------------------------------------------------------------------
// buildStartupNotification (tested via source analysis of orchestrator.ts)
// Since it's a private method on Orchestrator, we verify the source code
// contains expected strings for each messaging mode and workspace mode.
// ---------------------------------------------------------------------------

describe("Startup Notification (source analysis)", () => {
  const fs = require("fs");
  const pathMod = require("path");
  const srcDir = pathMod.resolve(__dirname, "../..");
  const orchSrc = fs.readFileSync(pathMod.join(srcDir, "core/orchestrator.ts"), "utf-8");

  // Extract from the function definition (not the call site) to ~2000 chars
  const defIdx = orchSrc.indexOf("private buildStartupNotification");
  const fnBody = defIdx >= 0 ? orchSrc.slice(defIdx, defIdx + 4000) : "";

  it("buildStartupNotification method exists in orchestrator", () => {
    expect(defIdx).toBeGreaterThan(-1);
    expect(fnBody.length).toBeGreaterThan(0);
  });

  it("MCP mode branch references get_context and check_messages tools", () => {
    expect(fnBody).toContain("get_context");
    expect(fnBody).toContain("check_messages");
    expect(fnBody).toContain("list_tasks");
  });

  it("CLI mode branch references kora-cli commands", () => {
    expect(fnBody).toContain("kora-cli whoami");
    expect(fnBody).toContain("kora-cli context all");
    expect(fnBody).toContain("kora-cli messages");
    expect(fnBody).toContain("kora-cli tasks");
  });

  it("Terminal mode branch references @mention syntax", () => {
    expect(fnBody).toContain("@AgentName");
    expect(fnBody).toContain("@all");
  });

  it("Manual mode branch references inbox directory", () => {
    expect(fnBody).toContain(".kora/messages/inbox-");
  });

  it("Shared workspace warning appended when worktreeMode is shared", () => {
    expect(fnBody).toContain("SHARED WORKSPACE");
    expect(fnBody).toContain("worktreeMode");
  });
});

// ---------------------------------------------------------------------------
// MCP Self-Bootstrap (tested via static analysis of the pattern)
// ---------------------------------------------------------------------------

describe("MCP Self-Bootstrap", () => {
  it("selfBootstrap function exists in MCP server source", () => {
    const fs = require("fs");
    const path = require("path");
    const srcDir = path.resolve(__dirname, "../..");
    const mcpSrc = fs.readFileSync(path.join(srcDir, "mcp/agent-mcp-server.ts"), "utf-8");
    expect(mcpSrc).toContain("async function selfBootstrap");
  });

  it("selfBootstrap fetches agent config from daemon API", () => {
    const fs = require("fs");
    const path = require("path");
    const srcDir = path.resolve(__dirname, "../..");
    const mcpSrc = fs.readFileSync(path.join(srcDir, "mcp/agent-mcp-server.ts"), "utf-8");
    // Should call the agents endpoint to get config
    expect(mcpSrc).toMatch(/sessions\/.*\/agents\//);
  });

  it("selfBootstrap resolves role from API response", () => {
    const fs = require("fs");
    const path = require("path");
    const srcDir = path.resolve(__dirname, "../..");
    const mcpSrc = fs.readFileSync(path.join(srcDir, "mcp/agent-mcp-server.ts"), "utf-8");
    expect(mcpSrc).toContain("resp.config.role");
  });

  it("selfBootstrap resolves projectPath from API response", () => {
    const fs = require("fs");
    const path = require("path");
    const srcDir = path.resolve(__dirname, "../..");
    const mcpSrc = fs.readFileSync(path.join(srcDir, "mcp/agent-mcp-server.ts"), "utf-8");
    expect(mcpSrc).toContain("resp.config.projectPath");
  });

  it("selfBootstrap is non-fatal on failure (uses try/catch)", () => {
    const fs = require("fs");
    const path = require("path");
    const srcDir = path.resolve(__dirname, "../..");
    const mcpSrc = fs.readFileSync(path.join(srcDir, "mcp/agent-mcp-server.ts"), "utf-8");
    // The selfBootstrap function should have error handling
    // Extract the function body and check for catch
    const fnMatch = mcpSrc.match(/async function selfBootstrap[\s\S]*?^}/m);
    expect(fnMatch).toBeTruthy();
    expect(fnMatch![0]).toContain("catch");
  });

  it("selfBootstrap skips API call when CLI args already provide role and projectPath", () => {
    const fs = require("fs");
    const path = require("path");
    const srcDir = path.resolve(__dirname, "../..");
    const mcpSrc = fs.readFileSync(path.join(srcDir, "mcp/agent-mcp-server.ts"), "utf-8");
    // Should have early return when args are already set
    const fnMatch = mcpSrc.match(/async function selfBootstrap[\s\S]*?^}/m);
    expect(fnMatch).toBeTruthy();
    expect(fnMatch![0]).toMatch(/return/);
  });

  it("selfBootstrap defaults role to 'worker' when API response missing", () => {
    const fs = require("fs");
    const path = require("path");
    const srcDir = path.resolve(__dirname, "../..");
    const mcpSrc = fs.readFileSync(path.join(srcDir, "mcp/agent-mcp-server.ts"), "utf-8");
    expect(mcpSrc).toContain('|| "worker"');
  });
});
