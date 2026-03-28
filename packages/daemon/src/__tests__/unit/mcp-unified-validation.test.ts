/**
 * Tests for unified MCP validation via validateTool() from mcp-cli-bridge.
 * Ensures the MCP server's schema validation is consistent with CLI validation.
 */
import { describe, it, expect } from "vitest";
import { validateTool, ToolValidationError } from "../../cli/mcp-cli-bridge.js";
import { TOOL_DEFINITIONS, getToolDefinition } from "../../tools/tool-registry.js";

// ---------------------------------------------------------------------------
// 1. Validation catches missing required params
// ---------------------------------------------------------------------------

describe("Unified validation: missing required params", () => {
  it("send_message: rejects empty args (message is required)", () => {
    const schema = getToolDefinition("send_message")!.inputSchema;
    const errors = validateTool("send_message", {}, schema);
    expect(errors.some(e => e.field === "message")).toBe(true);
  });

  it("get_task: rejects without taskId", () => {
    const schema = getToolDefinition("get_task")!.inputSchema;
    const errors = validateTool("get_task", {}, schema);
    expect(errors.some(e => e.field === "taskId")).toBe(true);
  });

  it("update_task: rejects without taskId", () => {
    const schema = getToolDefinition("update_task")!.inputSchema;
    const errors = validateTool("update_task", {}, schema);
    expect(errors.some(e => e.field === "taskId")).toBe(true);
  });

  it("create_task: rejects without title", () => {
    const schema = getToolDefinition("create_task")!.inputSchema;
    const errors = validateTool("create_task", {}, schema);
    expect(errors.some(e => e.field === "title")).toBe(true);
  });

  it("broadcast: rejects without message", () => {
    const schema = getToolDefinition("broadcast")!.inputSchema;
    const errors = validateTool("broadcast", {}, schema);
    expect(errors.some(e => e.field === "message")).toBe(true);
  });

  it("spawn_agent: rejects without name and model", () => {
    const schema = getToolDefinition("spawn_agent")!.inputSchema;
    const errors = validateTool("spawn_agent", {}, schema);
    expect(errors.some(e => e.field === "name")).toBe(true);
    expect(errors.some(e => e.field === "model")).toBe(true);
  });

  it("save_persona: rejects without name and fullText", () => {
    const schema = getToolDefinition("save_persona")!.inputSchema;
    const errors = validateTool("save_persona", {}, schema);
    expect(errors.some(e => e.field === "name")).toBe(true);
    expect(errors.some(e => e.field === "fullText")).toBe(true);
  });

  it("save_knowledge: rejects without entry", () => {
    const schema = getToolDefinition("save_knowledge")!.inputSchema;
    const errors = validateTool("save_knowledge", {}, schema);
    expect(errors.some(e => e.field === "entry")).toBe(true);
  });

  it("get_knowledge: rejects without key", () => {
    const schema = getToolDefinition("get_knowledge")!.inputSchema;
    const errors = validateTool("get_knowledge", {}, schema);
    expect(errors.some(e => e.field === "key")).toBe(true);
  });

  it("search_knowledge: rejects without query", () => {
    const schema = getToolDefinition("search_knowledge")!.inputSchema;
    const errors = validateTool("search_knowledge", {}, schema);
    expect(errors.some(e => e.field === "query")).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// 2. Validation catches wrong types
// ---------------------------------------------------------------------------

describe("Unified validation: wrong types", () => {
  it("update_task: rejects number for taskId (string expected)", () => {
    const schema = getToolDefinition("update_task")!.inputSchema;
    const errors = validateTool("update_task", { taskId: 123 }, schema);
    expect(errors.some(e => e.field === "taskId" && e.reason.includes("Expected string"))).toBe(true);
  });

  it("update_task: rejects string for force (boolean expected)", () => {
    const schema = getToolDefinition("update_task")!.inputSchema;
    const errors = validateTool("update_task", { taskId: "abc", force: "yes" }, schema);
    expect(errors.some(e => e.field === "force" && e.reason.includes("Expected boolean"))).toBe(true);
  });

  it("update_task: rejects string for labels (array expected)", () => {
    const schema = getToolDefinition("update_task")!.inputSchema;
    const errors = validateTool("update_task", { taskId: "abc", labels: "bug" }, schema);
    expect(errors.some(e => e.field === "labels" && e.reason.includes("Expected array"))).toBe(true);
  });

  it("list_tasks: rejects string for summary (boolean expected)", () => {
    const schema = getToolDefinition("list_tasks")!.inputSchema;
    const errors = validateTool("list_tasks", { summary: "true" }, schema);
    expect(errors.some(e => e.field === "summary" && e.reason.includes("Expected boolean"))).toBe(true);
  });

  it("list_tasks: rejects string for maxTasks (number expected)", () => {
    const schema = getToolDefinition("list_tasks")!.inputSchema;
    const errors = validateTool("list_tasks", { maxTasks: "ten" }, schema);
    expect(errors.some(e => e.field === "maxTasks" && e.reason.includes("Expected number"))).toBe(true);
  });

  it("peek_agent: rejects string for lines (number expected)", () => {
    const schema = getToolDefinition("peek_agent")!.inputSchema;
    const errors = validateTool("peek_agent", { agentId: "abc", lines: "many" }, schema);
    expect(errors.some(e => e.field === "lines" && e.reason.includes("Expected number"))).toBe(true);
  });

  it("update_task: validates array item types for labels", () => {
    const schema = getToolDefinition("update_task")!.inputSchema;
    const errors = validateTool("update_task", { taskId: "abc", labels: ["bug", 123] }, schema);
    expect(errors.some(e => e.field === "labels[1]")).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// 3. Error messages are consistent between MCP and CLI
// ---------------------------------------------------------------------------

describe("Unified validation: error message consistency", () => {
  it("all validation errors are ToolValidationError instances", () => {
    const schema = getToolDefinition("send_message")!.inputSchema;
    const errors = validateTool("send_message", {}, schema);
    for (const err of errors) {
      expect(err).toBeInstanceOf(ToolValidationError);
      expect(err.toolName).toBe("send_message");
      expect(err.field.length).toBeGreaterThan(0);
      expect(err.reason.length).toBeGreaterThan(0);
    }
  });

  it("error messages include the tool name", () => {
    const schema = getToolDefinition("create_task")!.inputSchema;
    const errors = validateTool("create_task", {}, schema);
    for (const err of errors) {
      expect(err.message).toContain("create_task");
    }
  });

  it("type mismatch errors include expected and actual types", () => {
    const schema = getToolDefinition("update_task")!.inputSchema;
    const errors = validateTool("update_task", { taskId: 42 }, schema);
    const typeError = errors.find(e => e.field === "taskId");
    expect(typeError).toBeDefined();
    expect(typeError!.reason).toContain("Expected string");
    expect(typeError!.reason).toContain("number");
  });
});

// ---------------------------------------------------------------------------
// 4. Valid inputs pass through correctly
// ---------------------------------------------------------------------------

describe("Unified validation: valid inputs pass", () => {
  it("send_message with all valid fields", () => {
    const schema = getToolDefinition("send_message")!.inputSchema;
    const errors = validateTool("send_message", {
      to: "worker-a",
      message: "hello",
      messageType: "text",
      channel: "#general",
    }, schema);
    expect(errors).toHaveLength(0);
  });

  it("update_task with mixed field types", () => {
    const schema = getToolDefinition("update_task")!.inputSchema;
    const errors = validateTool("update_task", {
      taskId: "abc123",
      status: "in-progress",
      force: true,
      labels: ["bug", "frontend"],
      comment: "Working on it",
    }, schema);
    expect(errors).toHaveLength(0);
  });

  it("list_tasks with boolean and number fields", () => {
    const schema = getToolDefinition("list_tasks")!.inputSchema;
    const errors = validateTool("list_tasks", {
      summary: false,
      maxTasks: 25,
      assignedTo: "all",
      status: "active",
    }, schema);
    expect(errors).toHaveLength(0);
  });

  it("check_messages with empty args (no required fields)", () => {
    const schema = getToolDefinition("check_messages")!.inputSchema;
    const errors = validateTool("check_messages", {}, schema);
    expect(errors).toHaveLength(0);
  });

  it("spawn_agent with required + optional fields", () => {
    const schema = getToolDefinition("spawn_agent")!.inputSchema;
    const errors = validateTool("spawn_agent", {
      name: "worker-b",
      model: "claude-sonnet-4-6",
      role: "worker",
      extraCliArgs: ["--dangerously-skip-permissions"],
    }, schema);
    expect(errors).toHaveLength(0);
  });

  it("every tool with no required fields passes with empty args", () => {
    const noRequiredTools = TOOL_DEFINITIONS.filter(
      t => !t.inputSchema.required || t.inputSchema.required.length === 0
    );
    expect(noRequiredTools.length).toBeGreaterThan(0);
    for (const tool of noRequiredTools) {
      const errors = validateTool(tool.name, {}, tool.inputSchema);
      expect(errors, `${tool.name} should pass with empty args`).toHaveLength(0);
    }
  });
});
