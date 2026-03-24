/**
 * Tests for mcp-cli-bridge — auto-generates CLI commands from MCP tool definitions.
 * 36 tests covering all type mappings, validation, positional args, and end-to-end flows.
 */
import { describe, it, expect, vi } from "vitest";
import { Command } from "commander";
import {
  deriveCommandFromSchema,
  registerToolsAsCli,
  validateTool,
  createMcpCli,
  camelToKebab,
  kebabToCamel,
  ToolValidationError,
  type CliToolDefinition,
  type ToolHandler,
} from "../../cli/mcp-cli-bridge.js";
import type { ToolDefinition } from "../../tools/tool-registry.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Parse a command with given argv (simulate CLI invocation) */
function parseCmd(cmd: Command, argv: string[]): Promise<void> {
  cmd.exitOverride(); // throw instead of process.exit
  return cmd.parseAsync(["node", "test", ...argv]);
}

/** Create a simple tool definition */
function mkTool(
  name: string,
  props: Record<string, unknown>,
  required?: string[],
  cliMeta?: CliToolDefinition["cliMeta"],
): CliToolDefinition {
  return {
    name,
    description: `Test tool: ${name}`,
    inputSchema: { type: "object" as const, properties: props, required },
    cliMeta,
  };
}

// ---------------------------------------------------------------------------
// camelToKebab / kebabToCamel
// ---------------------------------------------------------------------------

describe("camelToKebab", () => {
  it("converts camelCase to kebab-case", () => {
    expect(camelToKebab("assignedTo")).toBe("assigned-to");
    expect(camelToKebab("maxTasks")).toBe("max-tasks");
    expect(camelToKebab("simple")).toBe("simple");
    expect(camelToKebab("skipTests")).toBe("skip-tests");
  });
});

describe("kebabToCamel", () => {
  it("converts kebab-case to camelCase", () => {
    expect(kebabToCamel("assigned-to")).toBe("assignedTo");
    expect(kebabToCamel("max-tasks")).toBe("maxTasks");
    expect(kebabToCamel("simple")).toBe("simple");
  });
});

// ---------------------------------------------------------------------------
// deriveCommandFromSchema — type mappings
// ---------------------------------------------------------------------------

describe("deriveCommandFromSchema", () => {
  it("creates a command with correct name and description", () => {
    const tool = mkTool("my-tool", {});
    const cmd = deriveCommandFromSchema(tool);
    expect(cmd.name()).toBe("my-tool");
    expect(cmd.description()).toBe("Test tool: my-tool");
  });

  it("maps string properties to --flag <value>", () => {
    const tool = mkTool("send", { to: { type: "string", description: "recipient" } });
    const cmd = deriveCommandFromSchema(tool);
    const opt = cmd.options.find((o) => o.long === "--to");
    expect(opt).toBeDefined();
    expect(opt!.flags).toContain("<value>");
  });

  it("maps number properties to --flag <n> with number parser", async () => {
    const handler = vi.fn().mockResolvedValue({ ok: true });
    const tool = mkTool("peek", { lines: { type: "number", description: "line count" } }, undefined);
    const cmd = deriveCommandFromSchema(tool, handler);

    const writeSpy = vi.spyOn(process.stdout, "write").mockImplementation(() => true);
    await parseCmd(cmd, ["--lines", "42"]);
    writeSpy.mockRestore();

    expect(handler).toHaveBeenCalledWith("peek", { lines: 42 });
  });

  it("maps boolean properties to --flag (no value)", async () => {
    const handler = vi.fn().mockResolvedValue({ ok: true });
    const tool = mkTool("verify", { skipTests: { type: "boolean", description: "skip" } });
    const cmd = deriveCommandFromSchema(tool, handler);

    const writeSpy = vi.spyOn(process.stdout, "write").mockImplementation(() => true);
    await parseCmd(cmd, ["--skip-tests"]);
    writeSpy.mockRestore();

    expect(handler).toHaveBeenCalledWith("verify", { skipTests: true });
  });

  it("maps array properties to comma-separated --flag <items>", async () => {
    const handler = vi.fn().mockResolvedValue({ ok: true });
    const tool = mkTool("create-task", {
      labels: { type: "array", items: { type: "string" }, description: "labels" },
    });
    const cmd = deriveCommandFromSchema(tool, handler);

    const writeSpy = vi.spyOn(process.stdout, "write").mockImplementation(() => true);
    await parseCmd(cmd, ["--labels", "bug,frontend,urgent"]);
    writeSpy.mockRestore();

    expect(handler).toHaveBeenCalledWith("create-task", {
      labels: ["bug", "frontend", "urgent"],
    });
  });

  it("maps enum properties with choices validation", async () => {
    const tool = mkTool("update", {
      priority: { type: "string", enum: ["P0", "P1", "P2", "P3"], description: "priority" },
    });
    const handler = vi.fn().mockResolvedValue({});
    const cmd = deriveCommandFromSchema(tool, handler);

    // Valid enum value
    const writeSpy = vi.spyOn(process.stdout, "write").mockImplementation(() => true);
    await parseCmd(cmd, ["--priority", "P1"]);
    writeSpy.mockRestore();
    expect(handler).toHaveBeenCalledWith("update", { priority: "P1" });

    // Invalid enum value — should throw
    await expect(parseCmd(cmd, ["--priority", "INVALID"])).rejects.toThrow();
  });

  it("marks required fields as requiredOption", async () => {
    const tool = mkTool(
      "send",
      { message: { type: "string", description: "msg" } },
      ["message"],
    );
    const cmd = deriveCommandFromSchema(tool);

    // Missing required option should throw
    await expect(parseCmd(cmd, [])).rejects.toThrow();
  });

  it("handles optional fields without error", async () => {
    const handler = vi.fn().mockResolvedValue({});
    const tool = mkTool("list", {
      status: { type: "string", description: "filter" },
      summary: { type: "boolean", description: "compact" },
    });
    const cmd = deriveCommandFromSchema(tool, handler);

    const writeSpy = vi.spyOn(process.stdout, "write").mockImplementation(() => true);
    await parseCmd(cmd, []);
    writeSpy.mockRestore();

    expect(handler).toHaveBeenCalledWith("list", {});
  });

  it("sets aliases from cliMeta", () => {
    const tool = mkTool("list-agents", {}, undefined, { aliases: ["agents", "la"] });
    const cmd = deriveCommandFromSchema(tool);
    expect(cmd.aliases()).toContain("agents");
    expect(cmd.aliases()).toContain("la");
  });

  it("supports positional args from cliMeta", async () => {
    const handler = vi.fn().mockResolvedValue({});
    const tool = mkTool(
      "send",
      {
        to: { type: "string", description: "recipient" },
        message: { type: "string", description: "content" },
      },
      ["to", "message"],
      { positionalArgs: ["to", "message"] },
    );
    const cmd = deriveCommandFromSchema(tool, handler);

    const writeSpy = vi.spyOn(process.stdout, "write").mockImplementation(() => true);
    await parseCmd(cmd, ["worker-a", "hello"]);
    writeSpy.mockRestore();

    expect(handler).toHaveBeenCalledWith("send", { to: "worker-a", message: "hello" });
  });

  it("uses custom formatOutput from cliMeta", async () => {
    const captured: string[] = [];
    const handler = vi.fn().mockResolvedValue({ count: 5 });
    const tool = mkTool("count", {}, undefined, {
      formatOutput: (r) => `Count: ${(r as { count: number }).count}`,
    });
    const cmd = deriveCommandFromSchema(tool, handler);

    const origWrite = process.stdout.write.bind(process.stdout);
    process.stdout.write = ((chunk: unknown) => {
      captured.push(String(chunk));
      return true;
    }) as typeof process.stdout.write;
    try {
      await parseCmd(cmd, []);
    } finally {
      process.stdout.write = origWrite;
    }

    expect(captured.some((s) => s.includes("Count: 5"))).toBe(true);
  });

  it("handles number parsing errors gracefully", async () => {
    const tool = mkTool("peek", { lines: { type: "number", description: "n" } });
    const cmd = deriveCommandFromSchema(tool);

    await expect(parseCmd(cmd, ["--lines", "abc"])).rejects.toThrow("not a valid number");
  });

  it("supports default values for optional fields", async () => {
    const handler = vi.fn().mockResolvedValue({});
    const tool = mkTool("list", {
      limit: { type: "number", description: "max", default: 20 },
    });
    const cmd = deriveCommandFromSchema(tool, handler);

    const writeSpy = vi.spyOn(process.stdout, "write").mockImplementation(() => true);
    await parseCmd(cmd, []);
    writeSpy.mockRestore();

    expect(handler).toHaveBeenCalledWith("list", { limit: 20 });
  });

  it("outputs JSON by default when no formatOutput", async () => {
    const captured: string[] = [];
    const handler = vi.fn().mockResolvedValue({ status: "ok" });
    const tool = mkTool("check", {});
    const cmd = deriveCommandFromSchema(tool, handler);

    const origWrite = process.stdout.write.bind(process.stdout);
    process.stdout.write = ((chunk: unknown) => {
      captured.push(String(chunk));
      return true;
    }) as typeof process.stdout.write;
    try {
      await parseCmd(cmd, []);
    } finally {
      process.stdout.write = origWrite;
    }

    const output = captured.join("");
    expect(JSON.parse(output.trim())).toEqual({ status: "ok" });
  });
});

// ---------------------------------------------------------------------------
// validateTool
// ---------------------------------------------------------------------------

describe("validateTool", () => {
  const schema: ToolDefinition["inputSchema"] = {
    type: "object",
    properties: {
      to: { type: "string", description: "recipient" },
      message: { type: "string", description: "content" },
      count: { type: "number", description: "n" },
      force: { type: "boolean", description: "force" },
      labels: { type: "array", items: { type: "string" }, description: "tags" },
      priority: { type: "string", enum: ["P0", "P1", "P2"], description: "pri" },
    },
    required: ["to", "message"],
  };

  it("returns no errors for valid input", () => {
    const errors = validateTool("send", { to: "agent-a", message: "hi" }, schema);
    expect(errors).toHaveLength(0);
  });

  it("returns errors for missing required fields", () => {
    const errors = validateTool("send", {}, schema);
    expect(errors.length).toBeGreaterThanOrEqual(2);
    expect(errors.some((e) => e.field === "to")).toBe(true);
    expect(errors.some((e) => e.field === "message")).toBe(true);
  });

  it("returns error for wrong type — string expected, got number", () => {
    const errors = validateTool("send", { to: 123, message: "hi" }, schema);
    expect(errors.some((e) => e.field === "to" && e.reason.includes("Expected string"))).toBe(true);
  });

  it("returns error for wrong type — number expected, got string", () => {
    const errors = validateTool("send", { to: "a", message: "b", count: "not-a-number" }, schema);
    expect(errors.some((e) => e.field === "count" && e.reason.includes("Expected number"))).toBe(true);
  });

  it("returns error for wrong type — boolean expected", () => {
    const errors = validateTool("send", { to: "a", message: "b", force: "yes" }, schema);
    expect(errors.some((e) => e.field === "force" && e.reason.includes("Expected boolean"))).toBe(true);
  });

  it("returns error for wrong type — array expected", () => {
    const errors = validateTool("send", { to: "a", message: "b", labels: "not-array" }, schema);
    expect(errors.some((e) => e.field === "labels" && e.reason.includes("Expected array"))).toBe(true);
  });

  it("validates array item types", () => {
    const errors = validateTool("send", { to: "a", message: "b", labels: ["ok", 123] }, schema);
    expect(errors.some((e) => e.field === "labels[1]")).toBe(true);
  });

  it("validates enum values", () => {
    const errors = validateTool("send", { to: "a", message: "b", priority: "INVALID" }, schema);
    expect(errors.some((e) => e.field === "priority" && e.reason.includes("Invalid value"))).toBe(true);
  });

  it("accepts valid enum values", () => {
    const errors = validateTool("send", { to: "a", message: "b", priority: "P0" }, schema);
    expect(errors).toHaveLength(0);
  });

  it("treats empty string as missing for required fields", () => {
    const errors = validateTool("send", { to: "", message: "hi" }, schema);
    expect(errors.some((e) => e.field === "to")).toBe(true);
  });

  it("ToolValidationError has correct properties", () => {
    const err = new ToolValidationError("mytool", "myfield", "bad value");
    expect(err.toolName).toBe("mytool");
    expect(err.field).toBe("myfield");
    expect(err.reason).toBe("bad value");
    expect(err.name).toBe("ToolValidationError");
    expect(err.message).toContain("mytool");
  });
});

// ---------------------------------------------------------------------------
// registerToolsAsCli
// ---------------------------------------------------------------------------

describe("registerToolsAsCli", () => {
  it("registers multiple tools as subcommands", () => {
    const program = new Command();
    const tools: CliToolDefinition[] = [
      mkTool("send-message", { message: { type: "string" } }, ["message"]),
      mkTool("check-messages", {}),
      mkTool("list-agents", {}),
    ];
    const handler = vi.fn().mockResolvedValue({});

    registerToolsAsCli(program, tools, handler);

    const names = program.commands.map((c) => c.name());
    expect(names).toContain("send-message");
    expect(names).toContain("check-messages");
    expect(names).toContain("list-agents");
  });

  it("returns the program for chaining", () => {
    const program = new Command();
    const result = registerToolsAsCli(program, [], vi.fn());
    expect(result).toBe(program);
  });
});

// ---------------------------------------------------------------------------
// createMcpCli
// ---------------------------------------------------------------------------

describe("createMcpCli", () => {
  it("creates a program with name, version, description", () => {
    const handler = vi.fn().mockResolvedValue({});
    const prog = createMcpCli([], {
      name: "test-cli",
      version: "1.0.0",
      description: "Test CLI",
      handler,
    });
    expect(prog.name()).toBe("test-cli");
    expect(prog.version()).toBe("1.0.0");
    expect(prog.description()).toBe("Test CLI");
  });

  it("registers all provided tools", () => {
    const handler = vi.fn().mockResolvedValue({});
    const tools: CliToolDefinition[] = [
      mkTool("alpha", {}),
      mkTool("beta", {}),
    ];
    const prog = createMcpCli(tools, { handler });
    const names = prog.commands.map((c) => c.name());
    expect(names).toContain("alpha");
    expect(names).toContain("beta");
  });

  it("adds --json global option when jsonOutput is true", () => {
    const handler = vi.fn().mockResolvedValue({});
    const prog = createMcpCli([], { handler, jsonOutput: true });
    const jsonOpt = prog.options.find((o) => o.long === "--json");
    expect(jsonOpt).toBeDefined();
  });

  it("uses defaults for name, version, description when not provided", () => {
    const handler = vi.fn().mockResolvedValue({});
    const prog = createMcpCli([], { handler });
    expect(prog.name()).toBe("mcp-cli");
    expect(prog.version()).toBe("0.1.0");
  });
});

// ---------------------------------------------------------------------------
// End-to-end: tool definition → CLI → parse → handler → output
// ---------------------------------------------------------------------------

describe("end-to-end", () => {
  it("complete flow: tool def → CLI command → parse args → correct handler call", async () => {
    const handler = vi.fn().mockResolvedValue({ success: true, taskId: "abc123" });
    const tool = mkTool(
      "create-task",
      {
        title: { type: "string", description: "Task title" },
        priority: { type: "string", enum: ["P0", "P1", "P2", "P3"], description: "Priority" },
        labels: { type: "array", items: { type: "string" }, description: "Labels" },
        assignedTo: { type: "string", description: "Assignee" },
      },
      ["title"],
      { positionalArgs: ["title"] },
    );

    const cmd = deriveCommandFromSchema(tool, handler);

    const writeSpy = vi.spyOn(process.stdout, "write").mockImplementation(() => true);
    await parseCmd(cmd, [
      "Fix the bug",
      "--priority", "P0",
      "--labels", "bug,urgent",
      "--assigned-to", "dev-1",
    ]);
    writeSpy.mockRestore();

    expect(handler).toHaveBeenCalledWith("create-task", {
      title: "Fix the bug",
      priority: "P0",
      labels: ["bug", "urgent"],
      assignedTo: "dev-1",
    });
  });

  it("mixed positional + options with validation", async () => {
    const handler = vi.fn().mockResolvedValue({ sent: true });
    const tool = mkTool(
      "send-message",
      {
        to: { type: "string", description: "recipient" },
        message: { type: "string", description: "content" },
        messageType: { type: "string", enum: ["text", "question", "ack"], description: "type" },
      },
      ["to", "message"],
      { positionalArgs: ["to", "message"] },
    );

    const cmd = deriveCommandFromSchema(tool, handler);

    const writeSpy = vi.spyOn(process.stdout, "write").mockImplementation(() => true);
    await parseCmd(cmd, ["worker-a", "hello world", "--message-type", "question"]);
    writeSpy.mockRestore();

    expect(handler).toHaveBeenCalledWith("send-message", {
      to: "worker-a",
      message: "hello world",
      messageType: "question",
    });
  });

  it("validation then CLI parse gives consistent results", async () => {
    const schema: ToolDefinition["inputSchema"] = {
      type: "object",
      properties: {
        taskId: { type: "string", description: "id" },
        status: { type: "string", enum: ["pending", "in-progress", "done"], description: "status" },
        force: { type: "boolean", description: "force" },
      },
      required: ["taskId"],
    };

    // Validate programmatically
    const validErrors = validateTool("update", { taskId: "abc", status: "done", force: true }, schema);
    expect(validErrors).toHaveLength(0);

    const invalidErrors = validateTool("update", { taskId: "abc", status: "INVALID" }, schema);
    expect(invalidErrors.length).toBeGreaterThan(0);

    // Same via CLI
    const handler = vi.fn().mockResolvedValue({});
    const tool: CliToolDefinition = {
      name: "update",
      description: "Update task",
      inputSchema: schema,
      cliMeta: { positionalArgs: ["taskId"] },
    };
    const cmd = deriveCommandFromSchema(tool, handler);

    const writeSpy = vi.spyOn(process.stdout, "write").mockImplementation(() => true);
    await parseCmd(cmd, ["abc", "--status", "done", "--force"]);
    writeSpy.mockRestore();

    expect(handler).toHaveBeenCalledWith("update", { taskId: "abc", status: "done", force: true });
  });
});
