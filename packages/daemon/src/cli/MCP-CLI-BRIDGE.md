# mcp-cli-bridge

**Auto-generate CLI commands from MCP tool definitions. Single source of truth for MCP servers and CLIs.**

mcp-cli-bridge takes your [Model Context Protocol](https://modelcontextprotocol.io/) tool definitions (JSON Schema `inputSchema`) and generates fully functional [Commander.js](https://github.com/tj/commander.js) CLI commands — with positional args, typed flags, validation, and custom formatters.

Add a tool once in your registry. It appears in both your MCP server and your CLI automatically.

```
TOOL_DEFINITIONS (JSON Schema)
       |
       +---> MCP Server (tools/list, tools/call)
       |
       +---> CLI (commander.js subcommands)  <-- mcp-cli-bridge
       |
       +---> Unified validation (shared between both)
```

## Quick Start

```typescript
import { createMcpCli } from "./mcp-cli-bridge.js";

const tools = [
  {
    name: "send_message",
    description: "Send a message to another agent",
    inputSchema: {
      type: "object",
      properties: {
        to: { type: "string", description: "Recipient agent name or ID" },
        message: { type: "string", description: "Message content" },
      },
      required: ["to", "message"],
    },
    cliMeta: {
      positionalArgs: ["to", "message"],  // <to> <message> instead of --to --message
      aliases: ["msg"],
    },
  },
];

const cli = createMcpCli(tools, {
  name: "my-tool",
  version: "1.0.0",
  handler: async (toolName, args) => {
    // Call your API, run your logic, etc.
    return await callDaemonApi(toolName, args);
  },
});

cli.parse(process.argv);
```

```bash
$ my-tool send_message alice "Hello world"
{ "success": true, "sentTo": "alice" }

$ my-tool send_message --help
Usage: my-tool send_message <to> <message>

Send a message to another agent

Arguments:
  to       Recipient agent name or ID
  message  Message content
```

## API Reference

### `deriveCommandFromSchema(toolDef, handler?)`

Converts a single `CliToolDefinition` into a Commander.js `Command`.

**Parameters:**
- `toolDef: CliToolDefinition` — Tool definition with optional `cliMeta`
- `handler?: ToolHandler` — Async function called when the command executes

**Returns:** `Command` — A configured Commander.js command

**Schema mapping rules:**

| JSON Schema type | CLI mapping | Example |
|-----------------|-------------|---------|
| `string` | `--flag <value>` | `--status active` |
| `string` + `enum` | `--flag <value>` with validation | `--priority P0` (rejects `P5`) |
| `number` | `--flag <n>` (parsed to Number) | `--max-tasks 10` |
| `boolean` | `--flag` (toggle, no value) | `--force` |
| `array` | `--flag <items>` (comma-separated) | `--labels bug,frontend` |
| required field | Required option or positional arg | Error if missing |

**Positional args** are controlled via `cliMeta.positionalArgs`. Required fields listed there become `<arg>` (required positional), optional become `[arg]`.

```typescript
import { deriveCommandFromSchema } from "./mcp-cli-bridge.js";

const cmd = deriveCommandFromSchema({
  name: "create_task",
  description: "Create a new task",
  inputSchema: {
    type: "object",
    properties: {
      title: { type: "string", description: "Task title" },
      priority: { type: "string", description: "P0-P3" },
      labels: { type: "array", items: { type: "string" }, description: "Task labels" },
      force: { type: "boolean", description: "Skip validation" },
    },
    required: ["title"],
  },
  cliMeta: {
    positionalArgs: ["title"],
  },
}, async (toolName, args) => {
  return await api.createTask(args);
});

// Usage: create_task "Fix the bug" --priority P0 --labels bug,backend --force
```

### `registerToolsAsCli(program, tools, handler)`

Batch-register all tool definitions as subcommands on an existing Commander program.

**Parameters:**
- `program: Command` — Commander.js program to add commands to
- `tools: CliToolDefinition[]` — Array of tool definitions
- `handler: ToolHandler` — Shared handler for all tools

**Returns:** `Command` — The program (for chaining)

```typescript
import { Command } from "commander";
import { registerToolsAsCli } from "./mcp-cli-bridge.js";
import { TOOL_DEFINITIONS } from "./tool-registry.js";

const program = new Command();
program.name("kora-cli").version("1.0.0");

registerToolsAsCli(program, TOOL_DEFINITIONS, async (toolName, args) => {
  return await callDaemonApi(toolName, args);
});

// All 30 tools are now available as subcommands
program.parse(process.argv);
```

### `validateTool(toolName, args, schema)`

Unified validation for both MCP and CLI tool arguments. Checks required fields, type correctness, enum values, and array item types.

**Parameters:**
- `toolName: string` — Tool name (for error messages)
- `args: Record<string, unknown>` — Arguments to validate
- `schema: ToolDefinition["inputSchema"]` — JSON Schema to validate against

**Returns:** `ToolValidationError[]` — Array of errors (empty = valid)

```typescript
import { validateTool, ToolValidationError } from "./mcp-cli-bridge.js";

const errors = validateTool("update_task", { status: 42 }, {
  type: "object",
  properties: {
    taskId: { type: "string" },
    status: { type: "string" },
  },
  required: ["taskId"],
});

// errors = [
//   ToolValidationError { toolName: "update_task", field: "taskId", reason: "Required field is missing" },
//   ToolValidationError { toolName: "update_task", field: "status", reason: "Expected string, got number" },
// ]
```

Use in MCP server handlers:
```typescript
// In your MCP tools/call handler:
const errors = validateTool(toolName, toolArgs, toolDef.inputSchema);
if (errors.length > 0) {
  return { error: errors.map(e => e.message).join("; ") };
}
```

### `createMcpCli(toolDefinitions, options)`

High-level API that creates a fully configured Commander program from tool definitions.

**Parameters:**
- `toolDefinitions: CliToolDefinition[]` — All tool definitions
- `options: CreateMcpCliOptions`:
  - `name?: string` — Program name (default: `"mcp-cli"`)
  - `version?: string` — Version string
  - `description?: string` — Program description
  - `handler: ToolHandler` — Handler for all tool invocations
  - `jsonOutput?: boolean` — Add global `--json` flag

**Returns:** `Command` — Ready-to-parse Commander program

### `camelToKebab(str)` / `kebabToCamel(str)`

Utility functions for case conversion between JSON Schema property names (camelCase) and CLI flags (kebab-case).

```typescript
camelToKebab("assignedTo")  // "assigned-to"
kebabToCamel("assigned-to") // "assignedTo"
```

## Types

### `CliToolDefinition`

Extends `ToolDefinition` with optional CLI metadata:

```typescript
interface CliToolDefinition extends ToolDefinition {
  cliMeta?: {
    /** Properties that become positional args (in order) */
    positionalArgs?: string[];
    /** Command aliases */
    aliases?: string[];
    /** Custom output formatter */
    formatOutput?: (result: unknown) => string;
  };
}
```

### `ToolHandler`

The function called when a CLI command executes:

```typescript
type ToolHandler = (
  toolName: string,
  args: Record<string, unknown>,
) => Promise<unknown>;
```

### `ToolValidationError`

Structured validation error:

```typescript
class ToolValidationError extends Error {
  toolName: string;  // Which tool
  field: string;     // Which field failed
  reason: string;    // Why it failed
}
```

## Adding a New Tool (Single Source of Truth)

When you add a tool to Kora, you make ONE change and it appears everywhere:

### Step 1: Add to tool-registry.ts

```typescript
// In TOOL_DEFINITIONS array:
{
  name: "my_new_tool",
  description: "Does something amazing",
  inputSchema: {
    type: "object",
    properties: {
      target: { type: "string", description: "Target to operate on" },
      dryRun: { type: "boolean", description: "Preview without executing" },
    },
    required: ["target"],
  },
}
```

### Step 2: Add handler to tool-handlers.ts

```typescript
export async function handleMyNewTool(
  ctx: ToolContext,
  args: Record<string, string>,
): Promise<unknown> {
  return await ctx.apiCall("POST", `/api/v1/sessions/${ctx.sessionId}/my-endpoint`, {
    target: args.target,
    dryRun: args.dryRun === "true",
  });
}

// Add to TOOL_HANDLER_MAP:
export const TOOL_HANDLER_MAP = {
  // ...existing handlers
  my_new_tool: handleMyNewTool,
};
```

### What happens automatically:

- **MCP server**: `tools/list` includes the new tool. `tools/call` delegates to `TOOL_HANDLER_MAP`.
- **CLI**: `kora-cli my_new_tool --target foo --dry-run` works immediately via `registerToolsAsCli`.
- **Validation**: `validateTool` checks args in both MCP and CLI paths.
- **Sync test**: `tool-registry-sync.test.ts` verifies all three stay aligned.

### Optional: Add CLI metadata

For better CLI ergonomics, add `cliMeta` in `getToolDefinitionsWithCliMeta()`:

```typescript
{
  ...toolDef,
  cliMeta: {
    positionalArgs: ["target"],     // kora-cli my_new_tool <target>
    aliases: ["mnt"],               // kora-cli mnt <target>
    formatOutput: (result) => {     // Human-readable output
      const r = result as any;
      return r.success ? "Done!" : `Error: ${r.error}`;
    },
  },
}
```

## How It Works Internally

```
tool-registry.ts          mcp-cli-bridge.ts           kora-cli.ts
+------------------+      +----------------------+    +------------------+
| TOOL_DEFINITIONS | ---> | deriveCommandFromSchema| -> | Commander program |
| (JSON Schema)    |      | registerToolsAsCli   |    | (30 subcommands) |
+------------------+      +----------------------+    +------------------+
        |                          |
        v                          v
  MCP agent-mcp-server.ts    validateTool()
  (tools/list, tools/call)   (shared validation)
```

1. `tool-registry.ts` defines all tools with JSON Schema `inputSchema`
2. `mcp-cli-bridge.ts` reads those definitions and generates Commander.js commands
3. `kora-cli.ts` calls `registerToolsAsCli()` at startup — 30 tools auto-registered
4. MCP server reads the same `TOOL_DEFINITIONS` for `tools/list`
5. Both paths use `validateTool()` for argument validation
6. `tool-registry-sync.test.ts` ensures they never drift apart

## Design Decisions

**Why runtime registration, not code generation?**
- No build step needed — tools appear instantly when added to the registry
- No generated files to drift out of sync
- Commander.js natively supports dynamic `.command()` registration

**Why Commander.js, not yargs/oclif?**
- Kora already used Commander.js — zero migration cost
- Commander.js has excellent TypeScript support
- Dynamic command registration is a first-class feature
- oclif requires file-per-command; yargs has weaker TS support

**Why positionalArgs in cliMeta, not auto-derived?**
- Not all required fields make good positional args (e.g., `taskId` is required but `--task-id <id>` reads better than `<taskId>`)
- Positional arg ORDER matters and can't be reliably inferred from object keys
- Explicit is better than implicit for public API

**Why unified validation?**
- Before: MCP had inline validation, CLI had Commander.js built-in, neither matched
- After: `validateTool()` runs the same checks in both paths
- Catches type mismatches, missing required fields, invalid enum values consistently

## Test Coverage

38 tests across 7 categories:
- `camelToKebab` / `kebabToCamel` — case conversion
- `deriveCommandFromSchema` — all type mappings (string, number, boolean, array, enum)
- `positionalArgs` — positional argument handling
- `validateTool` — required fields, type checking, enum validation, array items
- `registerToolsAsCli` — batch registration
- `createMcpCli` — high-level API
- `ToolValidationError` — error structure

Run tests:
```bash
npx vitest run packages/daemon/src/__tests__/unit/mcp-cli-bridge.test.ts
```

## License

MIT
