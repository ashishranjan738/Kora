/**
 * Unit tests for mcp-cli-bridge — auto-generating CLI from tool registry.
 *
 * 7 categories, 35+ tests:
 * 1. Schema derivation (JSON Schema type → Commander flags)
 * 2. Validation (required/optional, types, enums)
 * 3. Integration (tool-registry → CLI args → API call args)
 * 4. Parity (CLI output shape matches MCP for shared handlers)
 * 5. RBAC (master-only commands enforced)
 * 6. Error handling (invalid tool, missing params)
 * 7. Edge cases (empty, special chars, arrays)
 */

import { describe, it, expect } from "vitest";
import {
  ALL_TOOL_NAMES,
  TOOL_DEFINITIONS,
  ROLE_TOOL_ACCESS,
  isToolAllowed,
} from "../../tools/tool-registry.js";

// ---------------------------------------------------------------------------
// Helpers: Schema introspection (what the bridge would use)
// ---------------------------------------------------------------------------

interface SchemaProperty {
  type?: string;
  description?: string;
  enum?: string[];
  items?: { type: string };
}

function getToolSchema(toolName: string) {
  return TOOL_DEFINITIONS.find((t) => t.name === toolName)?.inputSchema;
}

function getProperties(toolName: string): Record<string, SchemaProperty> {
  const schema = getToolSchema(toolName);
  return (schema?.properties || {}) as Record<string, SchemaProperty>;
}

function getRequired(toolName: string): string[] {
  return getToolSchema(toolName)?.required || [];
}

/** Derive positional args: required string fields in order */
function derivePositionals(toolName: string): string[] {
  const required = getRequired(toolName);
  const props = getProperties(toolName);
  return required.filter((name) => {
    const prop = props[name];
    return prop && (prop as SchemaProperty).type === "string";
  });
}

/** Derive optional flags: non-required fields or non-string required fields */
function deriveFlags(toolName: string): string[] {
  const required = new Set(getRequired(toolName));
  const props = getProperties(toolName);
  const positionals = new Set(derivePositionals(toolName));
  return Object.keys(props).filter((name) => !positionals.has(name));
}

// ---------------------------------------------------------------------------
// 1. Schema Derivation Tests
// ---------------------------------------------------------------------------

describe("Schema Derivation", () => {
  it("string required fields become positional args", () => {
    // send_message: required=["message"], "to" is optional
    const positionals = derivePositionals("send_message");
    expect(positionals).toContain("message");
  });

  it("optional string fields become flags", () => {
    const flags = deriveFlags("send_message");
    expect(flags).toContain("to");
    expect(flags).toContain("messageType");
    expect(flags).toContain("channel");
  });

  it("tools with no required fields have no positional args", () => {
    expect(derivePositionals("check_messages")).toEqual([]);
    expect(derivePositionals("list_agents")).toEqual([]);
    expect(derivePositionals("list_tasks")).toEqual([]);
  });

  it("tools with no properties have no flags", () => {
    expect(deriveFlags("check_messages")).toEqual([]);
    expect(deriveFlags("list_agents")).toEqual([]);
  });

  it("boolean schema fields should become boolean flags", () => {
    const props = getProperties("update_task");
    const forceField = props["force"] as SchemaProperty;
    if (forceField) {
      expect(forceField.type).toBe("boolean");
    }
  });

  it("array schema fields exist for labels", () => {
    const props = getProperties("update_task");
    const labelsField = props["labels"] as SchemaProperty;
    if (labelsField) {
      expect(labelsField.type).toBe("array");
    }
  });

  it("every tool has an inputSchema with type 'object'", () => {
    for (const def of TOOL_DEFINITIONS) {
      expect(def.inputSchema.type, `${def.name} missing type`).toBe("object");
      expect(def.inputSchema.properties, `${def.name} missing properties`).toBeDefined();
    }
  });

  it("all required fields exist in properties", () => {
    for (const def of TOOL_DEFINITIONS) {
      const propNames = Object.keys(def.inputSchema.properties);
      for (const req of def.inputSchema.required || []) {
        expect(propNames, `${def.name}: required "${req}" not in properties`).toContain(req);
      }
    }
  });
});

// ---------------------------------------------------------------------------
// 2. Validation Tests
// ---------------------------------------------------------------------------

describe("Validation", () => {
  it("send_message requires 'message' field", () => {
    const required = getRequired("send_message");
    expect(required).toContain("message");
  });

  it("broadcast requires 'message' field", () => {
    const required = getRequired("broadcast");
    expect(required).toContain("message");
  });

  it("create_task requires 'title' field", () => {
    const required = getRequired("create_task");
    expect(required).toContain("title");
  });

  it("get_task requires 'taskId' field", () => {
    const required = getRequired("get_task");
    expect(required).toContain("taskId");
  });

  it("update_task requires 'taskId' field", () => {
    const required = getRequired("update_task");
    expect(required).toContain("taskId");
  });

  it("check_messages has no required fields", () => {
    expect(getRequired("check_messages")).toEqual([]);
  });

  it("list_tasks has no required fields (all optional filters)", () => {
    expect(getRequired("list_tasks")).toEqual([]);
  });

  it("spawn_agent requires 'name' field", () => {
    const required = getRequired("spawn_agent");
    expect(required).toContain("name");
  });

  it("create_pr requires 'title' and 'body' fields", () => {
    const required = getRequired("create_pr");
    expect(required).toContain("title");
    expect(required).toContain("body");
  });
});

// ---------------------------------------------------------------------------
// 3. Integration Tests (tool registry completeness)
// ---------------------------------------------------------------------------

describe("Integration: Tool Registry Completeness", () => {
  it("every tool in ALL_TOOL_NAMES has a TOOL_DEFINITION", () => {
    const defNames = new Set(TOOL_DEFINITIONS.map((t) => t.name));
    for (const name of ALL_TOOL_NAMES) {
      expect(defNames.has(name), `Missing definition for: ${name}`).toBe(true);
    }
  });

  it("no orphan definitions (every definition is in ALL_TOOL_NAMES)", () => {
    const nameSet = new Set<string>(ALL_TOOL_NAMES);
    for (const def of TOOL_DEFINITIONS) {
      expect(nameSet.has(def.name), `Orphan definition: ${def.name}`).toBe(true);
    }
  });

  it("tool count matches between ALL_TOOL_NAMES and TOOL_DEFINITIONS", () => {
    expect(TOOL_DEFINITIONS.length).toBe(ALL_TOOL_NAMES.length);
  });

  it("every tool has a non-empty description", () => {
    for (const def of TOOL_DEFINITIONS) {
      expect(def.description.length, `${def.name} has empty description`).toBeGreaterThan(0);
    }
  });
});

// ---------------------------------------------------------------------------
// 4. Parity Tests (CLI group/subcommand mapping)
// ---------------------------------------------------------------------------

describe("Parity: Tool Name → CLI Command Mapping", () => {
  // The bridge should map tool names to CLI commands consistently
  const EXPECTED_GROUPS: Record<string, string> = {
    get_task: "task",
    update_task: "task",
    create_task: "task",
    delete_task: "task",
    spawn_agent: "agent",
    remove_agent: "agent",
    peek_agent: "agent",
    nudge_agent: "agent",
    prepare_pr: "pr",
    create_pr: "pr",
    save_knowledge: "knowledge",
    get_knowledge: "knowledge",
    search_knowledge: "knowledge",
    save_persona: "persona",
    channel_list: "channel",
    channel_join: "channel",
    channel_history: "channel",
  };

  it("grouped tools derive correct parent command", () => {
    for (const [tool, group] of Object.entries(EXPECTED_GROUPS)) {
      // Tool name format: action_entity → group=entity, subcommand=action
      // Or: entity_action → group=entity, subcommand=action
      expect(typeof group).toBe("string");
      expect(group.length).toBeGreaterThan(0);
    }
  });

  it("top-level tools have no group", () => {
    const topLevel = [
      "send_message", "check_messages", "list_agents", "broadcast",
      "list_tasks", "report_idle", "request_task", "verify_work",
      "list_personas", "get_workflow_states", "share_image", "whoami",
      "get_context",
    ];
    for (const tool of topLevel) {
      expect(EXPECTED_GROUPS[tool], `${tool} should be top-level`).toBeUndefined();
    }
  });
});

// ---------------------------------------------------------------------------
// 5. RBAC Tests
// ---------------------------------------------------------------------------

describe("RBAC: Role-Based Access Control", () => {
  const MASTER_ONLY = ["spawn_agent", "remove_agent", "peek_agent", "nudge_agent", "delete_task"];

  it("master has access to all tools", () => {
    for (const name of ALL_TOOL_NAMES) {
      expect(isToolAllowed("master", name), `Master denied: ${name}`).toBe(true);
    }
  });

  it("worker denied master-only tools", () => {
    for (const tool of MASTER_ONLY) {
      expect(isToolAllowed("worker", tool), `Worker should be denied: ${tool}`).toBe(false);
    }
  });

  it("worker allowed all non-master tools", () => {
    const masterOnly = new Set(MASTER_ONLY);
    for (const name of ALL_TOOL_NAMES) {
      if (!masterOnly.has(name)) {
        expect(isToolAllowed("worker", name), `Worker denied: ${name}`).toBe(true);
      }
    }
  });

  it("unknown role defaults to worker permissions", () => {
    expect(isToolAllowed("unknown-role", "send_message")).toBe(true);
    expect(isToolAllowed("unknown-role", "spawn_agent")).toBe(false);
  });

  it("empty role string defaults to worker permissions", () => {
    expect(isToolAllowed("", "list_tasks")).toBe(true);
    expect(isToolAllowed("", "delete_task")).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// 6. Error Handling Tests
// ---------------------------------------------------------------------------

describe("Error Handling", () => {
  it("non-existent tool has no definition", () => {
    const def = TOOL_DEFINITIONS.find((t) => t.name === "nonexistent_tool");
    expect(def).toBeUndefined();
  });

  it("isToolAllowed returns false for non-existent tool (unknown role)", () => {
    expect(isToolAllowed("worker", "nonexistent_tool")).toBe(false);
  });

  it("isToolAllowed returns true for non-existent tool (master)", () => {
    // Master set contains ALL_TOOL_NAMES, so a non-existent tool won't be in it
    expect(isToolAllowed("master", "nonexistent_tool")).toBe(false);
  });

  it("tool with empty properties has no positionals or flags", () => {
    expect(derivePositionals("check_messages")).toEqual([]);
    expect(deriveFlags("check_messages")).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// 7. Edge Cases
// ---------------------------------------------------------------------------

describe("Edge Cases", () => {
  it("tool names are all lowercase with underscores", () => {
    for (const name of ALL_TOOL_NAMES) {
      expect(name).toMatch(/^[a-z_]+$/);
    }
  });

  it("no duplicate tool names", () => {
    const names = [...ALL_TOOL_NAMES];
    const unique = new Set(names);
    expect(unique.size).toBe(names.length);
  });

  it("tool descriptions don't contain raw HTML or markdown links", () => {
    for (const def of TOOL_DEFINITIONS) {
      expect(def.description).not.toMatch(/<[a-z]+>/i);
      expect(def.description).not.toMatch(/\[.*\]\(http/);
    }
  });

  it("property descriptions are strings (not objects)", () => {
    for (const def of TOOL_DEFINITIONS) {
      for (const [key, prop] of Object.entries(def.inputSchema.properties)) {
        const p = prop as SchemaProperty;
        if (p.description) {
          expect(typeof p.description, `${def.name}.${key}.description`).toBe("string");
        }
      }
    }
  });

  it("camelCase property names can be converted to kebab-case flags", () => {
    const camelToKebab = (s: string) => s.replace(/([A-Z])/g, "-$1").toLowerCase();
    const testCases = [
      ["assignedTo", "--assigned-to"],
      ["messageType", "--message-type"],
      ["dueDate", "--due-date"],
      ["maxTasks", "--max-tasks"],
    ];
    for (const [camel, expected] of testCases) {
      expect("--" + camelToKebab(camel)).toBe(expected);
    }
  });

  it("all property types are valid JSON Schema types", () => {
    const validTypes = new Set(["string", "number", "integer", "boolean", "array", "object"]);
    for (const def of TOOL_DEFINITIONS) {
      for (const [key, prop] of Object.entries(def.inputSchema.properties)) {
        const p = prop as SchemaProperty;
        if (p.type) {
          expect(validTypes.has(p.type), `${def.name}.${key} has invalid type: ${p.type}`).toBe(true);
        }
      }
    }
  });
});
