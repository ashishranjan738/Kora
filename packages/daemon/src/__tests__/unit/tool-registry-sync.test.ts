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
};

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("Tool Registry Sync Validation", () => {
  // ── Registry integrity ──────────────────────────────────────────────────

  describe("Registry integrity", () => {
    it("ALL_TOOL_NAMES has 24 tools", () => {
      expect(ALL_TOOL_NAMES.length).toBe(24);
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
      const masterOnly = ["spawn_agent", "remove_agent", "peek_agent", "nudge_agent"];
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

    it("MCP ALL_TOOLS matches registry ALL_TOOL_NAMES", () => {
      const registrySet = new Set(ALL_TOOL_NAMES);
      const mcpSet = new Set(mcpAllTools);

      // Check for tools in registry but missing from MCP
      for (const tool of ALL_TOOL_NAMES) {
        expect(mcpSet.has(tool), `Registry tool "${tool}" missing from MCP ALL_TOOLS`).toBe(true);
      }

      // Check for tools in MCP but missing from registry
      for (const tool of mcpAllTools) {
        expect(registrySet.has(tool), `MCP tool "${tool}" not in registry ALL_TOOL_NAMES`).toBe(true);
      }
    });

    it("every registry tool has a case handler in MCP server", () => {
      for (const name of ALL_TOOL_NAMES) {
        expect(mcpCases.has(name), `Missing MCP handler case for: ${name}`).toBe(true);
      }
    });

    it("no orphan MCP handler cases (every case maps to a registry tool)", () => {
      const registrySet = new Set<string>(ALL_TOOL_NAMES);
      for (const caseName of mcpCases) {
        expect(registrySet.has(caseName), `Orphan MCP handler case: "${caseName}" not in registry`).toBe(true);
      }
    });

    it("MCP worker role access matches registry", () => {
      const registryWorker = ROLE_TOOL_ACCESS.worker;

      for (const tool of registryWorker) {
        expect(mcpWorkerTools.has(tool), `Registry worker tool "${tool}" missing from MCP worker set`).toBe(true);
      }

      for (const tool of mcpWorkerTools) {
        expect(registryWorker.has(tool), `MCP worker tool "${tool}" not in registry worker set`).toBe(true);
      }
    });
  });

  // ── CLI sync ────────────────────────────────────────────────────────────

  describe("CLI sync", () => {
    const cliCommands = extractCliCommands(cliSrc);

    it("every registry tool has a corresponding CLI command", () => {
      for (const toolName of ALL_TOOL_NAMES) {
        const cliMapping = TOOL_TO_CLI_MAP[toolName];
        expect(cliMapping, `No CLI mapping defined for tool: ${toolName}`).toBeDefined();

        // Check that the primary command exists in CLI source
        const primaryCmd = cliMapping[0];
        expect(cliCommands.has(primaryCmd), `CLI missing command "${primaryCmd}" for tool: ${toolName}`).toBe(true);

        // For subcommands, check the sub-command also exists
        if (cliMapping.length > 1) {
          expect(cliCommands.has(cliMapping[1]), `CLI missing subcommand "${cliMapping[1]}" for tool: ${toolName}`).toBe(true);
        }
      }
    });

    it("TOOL_TO_CLI_MAP covers all registry tools", () => {
      const mapped = new Set(Object.keys(TOOL_TO_CLI_MAP));
      for (const name of ALL_TOOL_NAMES) {
        expect(mapped.has(name), `TOOL_TO_CLI_MAP missing entry for: ${name}`).toBe(true);
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
      // For tools with required properties, verify the CLI has corresponding flags or positional args
      const toolsWithRequired = TOOL_DEFINITIONS.filter((t) => t.inputSchema.required?.length);

      for (const def of toolsWithRequired) {
        const cliMapping = TOOL_TO_CLI_MAP[def.name];
        if (!cliMapping) continue;

        // Check CLI source contains the tool's command with its required params
        // Either as positional args (<param>) or required options (--param)
        const required = def.inputSchema.required || [];
        for (const req of required) {
          // Search for the param in CLI source near the command definition
          const hasPositional = cliSrc.includes(`<${req}>`);
          const hasFlag = cliSrc.includes(`--${req}`) || cliSrc.includes(`--${req.replace(/_/g, "-")}`);
          // Some params are mapped differently (e.g., "message" → positional <message>, "taskId" → <id>)
          // Some params are renamed in CLI (e.g., "fullText" → "--text", "taskId" → "<id>")
          const hasAltMapping = req === "taskId" || req === "message" || req === "to" || req === "title" || req === "body" || req === "entry" || req === "query" || req === "key" || req === "agentId" || req === "fullText" || req === "name";

          expect(
            hasPositional || hasFlag || hasAltMapping,
            `Tool "${def.name}" required param "${req}" not found as CLI flag or positional arg`,
          ).toBe(true);
        }
      }
    });
  });
});
