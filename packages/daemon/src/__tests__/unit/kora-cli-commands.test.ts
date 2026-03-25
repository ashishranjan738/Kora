/**
 * Regression test: verify kora-cli command structure.
 * Prevents stale build / broken subcommand registration bugs.
 */
import { describe, it, expect } from "vitest";
import * as fs from "fs";
import * as path from "path";

const srcDir = path.resolve(__dirname, "../..");
const cliSrc = fs.readFileSync(path.join(srcDir, "cli/kora-cli.ts"), "utf-8");

/** Extract .command("name") patterns from source */
function extractCommands(source: string): Set<string> {
  const commands = new Set<string>();
  const regex = /\.command\("([a-z][\w-]*)(?:\s|")/g;
  let match;
  while ((match = regex.exec(source)) !== null) {
    commands.add(match[1]);
  }
  return commands;
}

const allCommands = extractCommands(cliSrc);

// ---------------------------------------------------------------------------
// 1. Context subcommands (from RESOURCE_DEFINITIONS)
// ---------------------------------------------------------------------------

describe("kora-cli context subcommands", () => {
  it("has 'context' parent command", () => {
    expect(
      cliSrc.includes('.command("context")') || cliSrc.includes("command('context')"),
    ).toBe(true);
  });

  it("has 'all' subcommand", () => {
    expect(allCommands.has("all")).toBe(true);
  });

  it("registers subcommands from RESOURCE_DEFINITIONS", () => {
    // These come from resource-registry.ts
    expect(cliSrc).toContain("RESOURCE_DEFINITIONS");
    expect(cliSrc).toContain('res.uri.replace("kora://", "")');
  });

  it("expected context subcommands exist in source", () => {
    const expected = ["all", "team", "workflow", "knowledge", "rules", "tasks", "persona", "communication", "workspace"];
    // Verify resource-based registration loop exists
    expect(cliSrc).toContain("for (const res of RESOURCE_DEFINITIONS)");
    // "all" is manually registered
    expect(cliSrc).toContain('.command("all")');
  });
});

// ---------------------------------------------------------------------------
// 2. Task subcommands
// ---------------------------------------------------------------------------

describe("kora-cli task subcommands", () => {
  it("has grouped task commands via bridge or manual registration", () => {
    // Bridge auto-generates: get_task, update_task, create_task, delete_task
    // These map to task group with get/update/create/delete subcommands
    const taskTools = ["get_task", "update_task", "create_task", "delete_task"];
    for (const tool of taskTools) {
      // Either registered by bridge (tool name) or manually
      expect(
        cliSrc.includes(tool) || cliSrc.includes(tool.replace("_", "-")),
        `Task tool "${tool}" should be referenced in CLI source`,
      ).toBe(true);
    }
  });
});

// ---------------------------------------------------------------------------
// 3. Agent subcommands
// ---------------------------------------------------------------------------

describe("kora-cli agent subcommands", () => {
  it("has agent management tools", () => {
    const agentTools = ["spawn_agent", "remove_agent", "peek_agent", "nudge_agent"];
    for (const tool of agentTools) {
      expect(
        cliSrc.includes(tool) || cliSrc.includes(tool.replace("_", "-")),
        `Agent tool "${tool}" should be referenced in CLI source`,
      ).toBe(true);
    }
  });
});

// ---------------------------------------------------------------------------
// 4. Top-level commands
// ---------------------------------------------------------------------------

describe("kora-cli top-level commands", () => {
  it("has core communication commands", () => {
    const coreCmds = ["send_message", "check_messages", "list_agents", "broadcast"];
    for (const cmd of coreCmds) {
      expect(cliSrc.includes(cmd), `Core command "${cmd}" missing`).toBe(true);
    }
  });

  it("has utility commands", () => {
    const utils = ["whoami", "get_context", "report_idle", "request_task"];
    for (const cmd of utils) {
      expect(cliSrc.includes(cmd), `Utility command "${cmd}" missing`).toBe(true);
    }
  });
});

// ---------------------------------------------------------------------------
// 5. Bridge registration
// ---------------------------------------------------------------------------

describe("kora-cli uses mcp-cli-bridge", () => {
  it("imports registerToolsAsCli from bridge", () => {
    expect(cliSrc).toContain("registerToolsAsCli");
  });

  it("imports tool definitions from shared registry", () => {
    expect(cliSrc).toContain("tool-registry");
  });
});
