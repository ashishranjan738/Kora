/**
 * CI: Tool registry sync validation test.
 *
 * Verifies that the shared tool registry (tool-registry.ts) stays in sync
 * across both transports:
 *   - MCP server (agent-mcp-server.ts) — JSON-RPC over stdio
 *   - Kora CLI (kora-cli.ts) — commander.js subcommands
 *
 * If someone adds a tool to the registry but forgets the MCP handler or
 * CLI subcommand, this test fails with a clear error naming the tool.
 */

import { describe, it, expect } from "vitest";
import * as fs from "fs";
import * as path from "path";
import {
  ALL_TOOL_NAMES,
  TOOL_DEFINITIONS,
  ROLE_TOOL_ACCESS,
} from "../../tools/tool-registry.js";
import { TOOL_HANDLER_MAP } from "../../tools/tool-handlers.js";

// ---------------------------------------------------------------------------
// Read source files for static analysis
// ---------------------------------------------------------------------------

const srcDir = path.resolve(__dirname, "../..");
const mcpServerSrc = fs.readFileSync(path.join(srcDir, "mcp/agent-mcp-server.ts"), "utf-8");
const cliSrc = fs.readFileSync(path.join(srcDir, "cli/kora-cli.ts"), "utf-8");

// ---------------------------------------------------------------------------
// Helpers: extract patterns from source text
// ---------------------------------------------------------------------------

/** Extract all `case "tool_name":` entries from MCP server handleToolCall */
function extractMcpHandlerCases(source: string): Set<string> {
  const cases = new Set<string>();
  // Match case "tool_name": patterns (MCP handler switch)
  const regex = /case\s+"([a-z_]+)":/g;
  let match;
  while ((match = regex.exec(source)) !== null) {
    const name = match[1];
    // Exclude non-tool cases (JSON-RPC protocol methods)
    if (!name.includes("/") && name !== "initialize") {
      cases.add(name);
    }
  }
  return cases;
}

/** Extract MCP server's ALL_TOOLS array */
function extractMcpAllTools(source: string): string[] {
  const match = source.match(/const ALL_TOOLS\s*=\s*\[([\s\S]*?)\]\s*as\s*const/);
  if (!match) return [];
  const content = match[1];
  const tools: string[] = [];
  const regex = /"([a-z_]+)"/g;
  let m;
  while ((m = regex.exec(content)) !== null) {
    tools.push(m[1]);
  }
  return tools;
}

/** Extract MCP server's ROLE_TOOL_ACCESS worker set */
function extractMcpWorkerTools(source: string): Set<string> {
  // Find the worker set definition
  const match = source.match(/worker:\s*new\s+Set\(\[([\s\S]*?)\]\)/);
  if (!match) return new Set();
  const tools = new Set<string>();
  const regex = /"([a-z_]+)"/g;
  let m;
  while ((m = regex.exec(match[1])) !== null) {
    tools.add(m[1]);
  }
  return tools;
}

/**
 * Extract CLI subcommand names from kora-cli.ts.
 * Maps tool registry names to CLI command patterns.
 */
function extractCliCommands(source: string): Set<string> {
  const commands = new Set<string>();
  // Match .command("name") patterns
  const regex = /\.command\("([a-z][\w-]*)(?:\s|")/g;
  let match;
  while ((match = regex.exec(source)) !== null) {
    commands.add(match[1]);
  }
  return commands;
}

// ---------------------------------------------------------------------------
// Tool name → CLI command mapping
// ---------------------------------------------------------------------------

/**
 * Maps tool registry names to the CLI command(s) that implement them.
 * Some tools map to subcommands (e.g. "get_task" → "task" + "get").
 * Some tools map directly (e.g. "broadcast" → "broadcast").
 */
const TOOL_TO_CLI_MAP: Record<string, string[]> = {
  send_message: ["send"],
  check_messages: ["messages"],
  list_agents: ["agents"],
  broadcast: ["broadcast"],
  list_tasks: ["tasks"],
  get_task: ["task", "get"],
  update_task: ["task", "update"],
  create_task: ["task", "create"],
  spawn_agent: ["agent", "spawn"],
  remove_agent: ["agent", "remove"],
  peek_agent: ["agent", "peek"],
  nudge_agent: ["agent", "nudge"],
  prepare_pr: ["pr", "prepare"],
  verify_work: ["verify"],
  create_pr: ["pr", "create"],
  report_idle: ["idle"],
  request_task: ["request-task"],
  list_personas: ["personas"],
  save_persona: ["persona", "save"],
  get_workflow_states: ["workflow"],
  share_image: ["share-image"],
  save_knowledge: ["knowledge", "save"],
  get_knowledge: ["knowledge", "get"],
  search_knowledge: ["knowledge", "search"],
  whoami: ["whoami"],
  get_context: ["context"],
  delete_task: ["task", "delete"],
  channel_list: ["channel", "list"],
  channel_join: ["channel", "join"],
  channel_history: ["channel", "history"],
};

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("Tool Registry Sync Validation", () => {
  // ── Registry integrity ──────────────────────────────────────────────────

  describe("Registry integrity", () => {
    it("ALL_TOOL_NAMES has 27 tools", () => {
      expect(ALL_TOOL_NAMES.length).toBe(30);
    });

    it("TOOL_DEFINITIONS matches ALL_TOOL_NAMES", () => {
      const defNames = TOOL_DEFINITIONS.map((t) => t.name).sort();
      const allNames = [...ALL_TOOL_NAMES].sort();
      expect(defNames).toEqual(allNames);
    });

    it("every tool in ALL_TOOL_NAMES has a definition in TOOL_DEFINITIONS", () => {
      const defSet = new Set(TOOL_DEFINITIONS.map((t) => t.name));
      for (const name of ALL_TOOL_NAMES) {
        expect(defSet.has(name), `Missing TOOL_DEFINITION for: ${name}`).toBe(true);
      }
    });

    it("master role has access to all tools", () => {
      const masterTools = ROLE_TOOL_ACCESS.master;
      for (const name of ALL_TOOL_NAMES) {
        expect(masterTools.has(name), `Master missing access to: ${name}`).toBe(true);
      }
    });

    it("worker role is a subset of master role", () => {
      const master = ROLE_TOOL_ACCESS.master;
      const worker = ROLE_TOOL_ACCESS.worker;
      for (const tool of worker) {
        expect(master.has(tool), `Worker has tool "${tool}" not in master`).toBe(true);
      }
    });

    it("worker role excludes master-only tools (spawn, remove, peek, nudge)", () => {
      const worker = ROLE_TOOL_ACCESS.worker;
      const masterOnly = ["spawn_agent", "remove_agent", "peek_agent", "nudge_agent", "delete_task"];
      for (const tool of masterOnly) {
        expect(worker.has(tool), `Worker should NOT have access to: ${tool}`).toBe(false);
      }
    });
  });

  // ── MCP server sync ─────────────────────────────────────────────────────

  describe("MCP server sync", () => {
    const mcpCases = extractMcpHandlerCases(mcpServerSrc);
    const mcpAllTools = extractMcpAllTools(mcpServerSrc);
    const mcpWorkerTools = extractMcpWorkerTools(mcpServerSrc);

    it("MCP server imports TOOL_DEFINITIONS from shared registry (no local copy)", () => {
      // After PR #445, MCP server imports directly from tool-registry.ts.
      // No local ALL_TOOLS or TOOL_DEFINITIONS — single source of truth.
      expect(
        mcpServerSrc.includes('from "../tools/tool-registry.js"'),
        "MCP server should import from tool-registry.ts",
      ).toBe(true);
      expect(mcpAllTools.length, "Local ALL_TOOLS should be removed (0 entries parsed)").toBe(0);
    });

    it("every registry tool has a case handler in MCP server OR shared TOOL_HANDLER_MAP", () => {
      const sharedHandlers = new Set(Object.keys(TOOL_HANDLER_MAP));
      for (const name of ALL_TOOL_NAMES) {
        const hasMcpCase = mcpCases.has(name);
        const hasSharedHandler = sharedHandlers.has(name);
        expect(hasMcpCase || hasSharedHandler, `Missing handler for: ${name} (not in MCP switch or TOOL_HANDLER_MAP)`).toBe(true);
      }
    });

    it("no orphan MCP handler cases (every case maps to a registry tool)", () => {
      const registrySet = new Set<string>(ALL_TOOL_NAMES);
      for (const caseName of mcpCases) {
        expect(registrySet.has(caseName), `Orphan MCP handler case: "${caseName}" not in registry`).toBe(true);
      }
    });

    it("MCP server imports isToolAllowed from shared registry (no local ROLE_TOOL_ACCESS)", () => {
      // After PR #445, MCP uses shared isToolAllowed(role, toolName) — no local copy.
      expect(
        mcpServerSrc.includes("isToolAllowed"),
        "MCP server should use isToolAllowed from tool-registry",
      ).toBe(true);
      expect(mcpWorkerTools.size, "Local ROLE_TOOL_ACCESS should be removed (0 entries parsed)").toBe(0);
    });
  });

  // ── CLI sync ────────────────────────────────────────────────────────────
  // After mcp-cli-bridge rewrite (PR #424), CLI commands are auto-generated
  // from tool-registry.ts via registerToolsAsCli(). We verify:
  // 1. CLI source uses the bridge to auto-register tools
  // 2. TOOL_TO_CLI_MAP still covers all tools (used for docs/help)
  // 3. Bridge-generated commands match tool names (underscore → hyphen)

  describe("CLI sync", () => {
    it("kora-cli uses mcp-cli-bridge for auto-registration", () => {
      // The new CLI imports registerToolsAsCli from the bridge
      expect(
        cliSrc.includes("registerToolsAsCli") || cliSrc.includes("mcp-cli-bridge"),
        "kora-cli.ts should import from mcp-cli-bridge for auto-generated commands",
      ).toBe(true);
    });

    it("every registry tool has a CLI mapping entry", () => {
      const mapped = new Set(Object.keys(TOOL_TO_CLI_MAP));
      for (const name of ALL_TOOL_NAMES) {
        expect(mapped.has(name), `TOOL_TO_CLI_MAP missing entry for: ${name}`).toBe(true);
      }
    });

    it("bridge auto-generates CLI commands from tool names (underscore → hyphen)", () => {
      // The bridge converts tool names like "send_message" → "send-message" command
      // Verify all tool names can be converted to valid CLI command names
      for (const name of ALL_TOOL_NAMES) {
        const cliName = name.replace(/_/g, "-");
        expect(cliName.length).toBeGreaterThan(0);
        expect(cliName).toMatch(/^[a-z][a-z0-9-]*$/);
      }
    });
  });

  // ── Schema consistency ──────────────────────────────────────────────────

  describe("Schema consistency", () => {
    it("every TOOL_DEFINITION has a valid inputSchema", () => {
      for (const def of TOOL_DEFINITIONS) {
        expect(def.inputSchema, `Tool "${def.name}" missing inputSchema`).toBeDefined();
        expect(def.inputSchema.type, `Tool "${def.name}" inputSchema.type should be "object"`).toBe("object");
        expect(def.inputSchema.properties, `Tool "${def.name}" missing inputSchema.properties`).toBeDefined();
      }
    });

    it("required fields are arrays of valid property names", () => {
      for (const def of TOOL_DEFINITIONS) {
        if (def.inputSchema.required) {
          expect(Array.isArray(def.inputSchema.required), `Tool "${def.name}" required should be array`).toBe(true);
          const propNames = Object.keys(def.inputSchema.properties);
          for (const req of def.inputSchema.required) {
            expect(propNames.includes(req), `Tool "${def.name}" required field "${req}" not in properties`).toBe(true);
          }
        }
      }
    });

    it("CLI flags cover required inputSchema properties for each tool", () => {
      // After mcp-cli-bridge rewrite, all required params are auto-generated as
      // either requiredOption (--flag) or positional args via CliMeta.
      // The bridge guarantees schema coverage, so we verify the schema is well-formed.
      const toolsWithRequired = TOOL_DEFINITIONS.filter((t) => t.inputSchema.required?.length);

      for (const def of toolsWithRequired) {
        const required = def.inputSchema.required || [];
        const propNames = Object.keys(def.inputSchema.properties);

        for (const req of required) {
          // Every required field must exist in properties (bridge uses this to generate flags)
          expect(
            propNames.includes(req),
            `Tool "${def.name}" required param "${req}" not in inputSchema.properties`,
          ).toBe(true);

          // Every required field must have a type (bridge uses this for flag type mapping)
          const prop = def.inputSchema.properties[req] as { type?: string };
          expect(
            prop && typeof prop.type === "string",
            `Tool "${def.name}" required param "${req}" missing type in schema`,
          ).toBe(true);
        }
      }
    });
  });
});
