/**
 * mcp-cli-bridge — Auto-generates Commander.js CLI commands from MCP tool definitions.
 *
 * Provides a bridge between MCP tool schemas (JSON Schema) and Commander.js CLI,
 * enabling a single source of truth for both MCP and CLI interfaces.
 */

import { Command } from "commander";
import type { ToolDefinition } from "../tools/tool-registry.js";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** CLI metadata extension for ToolDefinition — controls CLI-specific behavior */
export interface CliMeta {
  /** Which schema properties become positional args (in order) */
  positionalArgs?: string[];
  /** Command aliases (e.g. ["ls", "list"]) */
  aliases?: string[];
  /** Custom output formatter for the tool result */
  formatOutput?: (result: unknown) => string;
}

/** Extended tool definition with optional CLI metadata */
export interface CliToolDefinition extends ToolDefinition {
  cliMeta?: CliMeta;
}

/** Handler invoked when a CLI command is executed */
export type ToolHandler = (
  toolName: string,
  args: Record<string, unknown>,
) => Promise<unknown>;

/** Options for createMcpCli */
export interface CreateMcpCliOptions {
  /** Program name */
  name?: string;
  /** Program version */
  version?: string;
  /** Program description */
  description?: string;
  /** Default handler for all tools */
  handler: ToolHandler;
  /** Global --json flag for JSON output */
  jsonOutput?: boolean;
}

/** Validation error with structured details */
export class ToolValidationError extends Error {
  constructor(
    public readonly toolName: string,
    public readonly field: string,
    public readonly reason: string,
  ) {
    super(`Validation error for "${toolName}": ${field} — ${reason}`);
    this.name = "ToolValidationError";
  }
}

// ---------------------------------------------------------------------------
// Schema property type extraction
// ---------------------------------------------------------------------------

interface SchemaProperty {
  type?: string;
  description?: string;
  enum?: string[];
  items?: { type?: string };
  default?: unknown;
}

function getSchemaProperty(
  props: Record<string, unknown>,
  key: string,
): SchemaProperty {
  return (props[key] || {}) as SchemaProperty;
}

// ---------------------------------------------------------------------------
// Core: deriveCommandFromSchema
// ---------------------------------------------------------------------------

/**
 * Converts a ToolDefinition (with optional CliMeta) into a Commander.js Command.
 *
 * Schema mapping rules:
 * - string  → --flag <value>
 * - number  → --flag <n>  (parsed with parseInt/parseFloat)
 * - boolean → --flag      (no value, toggle)
 * - array   → --flag <items>  (comma-separated)
 * - enum    → choices validation
 * - required fields without positional config → required options
 */
export function deriveCommandFromSchema(
  toolDef: CliToolDefinition,
  handler?: ToolHandler,
): Command {
  const { name, description, inputSchema, cliMeta } = toolDef;
  const cmd = new Command(name);
  cmd.description(description);

  // Set aliases
  if (cliMeta?.aliases?.length) {
    for (const alias of cliMeta.aliases) {
      cmd.alias(alias);
    }
  }

  const properties = inputSchema.properties || {};
  const required = new Set(inputSchema.required || []);
  const positionalSet = new Set(cliMeta?.positionalArgs || []);

  // Add positional arguments (in order specified by cliMeta)
  if (cliMeta?.positionalArgs) {
    for (const argName of cliMeta.positionalArgs) {
      const prop = getSchemaProperty(properties, argName);
      const isRequired = required.has(argName);
      const bracket = isRequired ? `<${argName}>` : `[${argName}]`;
      cmd.argument(bracket, prop.description || argName);
    }
  }

  // Add options for non-positional properties
  for (const [key, rawProp] of Object.entries(properties)) {
    if (positionalSet.has(key)) continue;

    const prop = rawProp as SchemaProperty;
    const flagName = camelToKebab(key);
    const isReq = required.has(key);

    switch (prop.type) {
      case "boolean": {
        const flag = `--${flagName}`;
        const desc = prop.description || key;
        if (isReq) {
          cmd.requiredOption(flag, desc);
        } else {
          cmd.option(flag, desc);
        }
        break;
      }

      case "number": {
        const flag = `--${flagName} <n>`;
        const desc = prop.description || key;
        const parser = (val: string) => {
          const n = Number(val);
          if (isNaN(n)) throw new Error(`"${val}" is not a valid number for --${flagName}`);
          return n;
        };
        if (isReq) {
          cmd.requiredOption(flag, desc, parser);
        } else if (prop.default !== undefined) {
          cmd.option(flag, desc, parser, prop.default as number);
        } else {
          cmd.option(flag, desc, parser);
        }
        break;
      }

      case "array": {
        const flag = `--${flagName} <items>`;
        const desc = (prop.description || key) + " (comma-separated)";
        const parser = (val: string) =>
          val.split(",").map((s) => s.trim());
        if (isReq) {
          cmd.requiredOption(flag, desc, parser);
        } else {
          cmd.option(flag, desc, parser);
        }
        break;
      }

      case "string":
      default: {
        // String or unknown type — treat as string
        const hasEnum = prop.enum && prop.enum.length > 0;
        const flag = `--${flagName} <value>`;
        const desc = prop.description || key;

        if (hasEnum) {
          // Use choices validation via argParser
          const allowed = prop.enum!;
          const parser = (val: string) => {
            if (!allowed.includes(val)) {
              throw new Error(
                `Invalid value "${val}" for --${flagName}. Allowed: ${allowed.join(", ")}`,
              );
            }
            return val;
          };
          if (isReq) {
            cmd.requiredOption(flag, desc, parser);
          } else if (prop.default !== undefined) {
            cmd.option(flag, desc, parser, prop.default as string);
          } else {
            cmd.option(flag, desc, parser);
          }
        } else {
          if (isReq) {
            cmd.requiredOption(flag, desc);
          } else if (prop.default !== undefined) {
            cmd.option(flag, desc, prop.default as string);
          } else {
            cmd.option(flag, desc);
          }
        }
        break;
      }
    }
  }

  // Wire up the action handler
  if (handler) {
    cmd.action(async (...rawArgs: unknown[]) => {
      // Collect positional args + options
      const args: Record<string, unknown> = {};

      // Positional args come first in rawArgs
      const positionals = cliMeta?.positionalArgs || [];
      for (let i = 0; i < positionals.length; i++) {
        if (rawArgs[i] !== undefined) {
          args[positionals[i]] = rawArgs[i];
        }
      }

      // Options object is the last arg before Command
      const optsObj =
        rawArgs.length > positionals.length
          ? (rawArgs[positionals.length] as Record<string, unknown>)
          : {};

      // Map kebab-cased option keys back to camelCase
      if (optsObj && typeof optsObj === "object") {
        for (const [k, v] of Object.entries(optsObj)) {
          if (v !== undefined) {
            args[kebabToCamel(k)] = v;
          }
        }
      }

      const result = await handler(name, args);

      // Format output
      if (cliMeta?.formatOutput) {
        process.stdout.write(cliMeta.formatOutput(result) + "\n");
      } else {
        process.stdout.write(JSON.stringify(result, null, 2) + "\n");
      }
    });
  }

  return cmd;
}

// ---------------------------------------------------------------------------
// Core: registerToolsAsCli
// ---------------------------------------------------------------------------

/**
 * Batch-register all tool definitions as subcommands on a Commander program.
 * Returns the program for chaining.
 */
export function registerToolsAsCli(
  program: Command,
  tools: CliToolDefinition[],
  handler: ToolHandler,
): Command {
  for (const tool of tools) {
    const cmd = deriveCommandFromSchema(tool, handler);
    program.addCommand(cmd);
  }
  return program;
}

// ---------------------------------------------------------------------------
// Core: validateTool
// ---------------------------------------------------------------------------

/**
 * Unified validation for MCP + CLI tool arguments against JSON Schema.
 * Returns an array of validation errors (empty = valid).
 */
export function validateTool(
  toolName: string,
  args: Record<string, unknown>,
  schema: ToolDefinition["inputSchema"],
): ToolValidationError[] {
  const errors: ToolValidationError[] = [];
  const properties = schema.properties || {};
  const required = schema.required || [];

  // Check required fields
  for (const field of required) {
    if (args[field] === undefined || args[field] === null || args[field] === "") {
      errors.push(
        new ToolValidationError(toolName, field, "Required field is missing"),
      );
    }
  }

  // Validate types of provided fields
  for (const [key, value] of Object.entries(args)) {
    if (value === undefined || value === null) continue;

    const prop = getSchemaProperty(properties, key);
    if (!prop.type) continue; // Unknown property, skip

    switch (prop.type) {
      case "string":
        if (typeof value !== "string") {
          errors.push(
            new ToolValidationError(toolName, key, `Expected string, got ${typeof value}`),
          );
        } else if (prop.enum && prop.enum.length > 0 && !prop.enum.includes(value)) {
          errors.push(
            new ToolValidationError(
              toolName,
              key,
              `Invalid value "${value}". Allowed: ${prop.enum.join(", ")}`,
            ),
          );
        }
        break;

      case "number":
        if (typeof value !== "number" || isNaN(value)) {
          errors.push(
            new ToolValidationError(toolName, key, `Expected number, got ${typeof value}`),
          );
        }
        break;

      case "boolean":
        if (typeof value !== "boolean") {
          errors.push(
            new ToolValidationError(toolName, key, `Expected boolean, got ${typeof value}`),
          );
        }
        break;

      case "array":
        if (!Array.isArray(value)) {
          errors.push(
            new ToolValidationError(toolName, key, `Expected array, got ${typeof value}`),
          );
        } else if (prop.items?.type) {
          for (let i = 0; i < value.length; i++) {
            if (typeof value[i] !== prop.items.type) {
              errors.push(
                new ToolValidationError(
                  toolName,
                  `${key}[${i}]`,
                  `Expected ${prop.items.type}, got ${typeof value[i]}`,
                ),
              );
            }
          }
        }
        break;
    }
  }

  return errors;
}

// ---------------------------------------------------------------------------
// Core: createMcpCli
// ---------------------------------------------------------------------------

/**
 * High-level API: takes tool definitions and options, returns a fully configured
 * Commander program with all tools registered as subcommands.
 */
export function createMcpCli(
  toolDefinitions: CliToolDefinition[],
  options: CreateMcpCliOptions,
): Command {
  const program = new Command();
  program
    .name(options.name || "mcp-cli")
    .version(options.version || "0.1.0")
    .description(options.description || "Auto-generated CLI from MCP tool definitions");

  if (options.jsonOutput) {
    program.option("--json", "Output raw JSON");
  }

  registerToolsAsCli(program, toolDefinitions, options.handler);

  return program;
}

// ---------------------------------------------------------------------------
// Utilities
// ---------------------------------------------------------------------------

/** Convert camelCase to kebab-case (e.g. "assignedTo" → "assigned-to") */
export function camelToKebab(str: string): string {
  return str.replace(/[A-Z]/g, (m) => `-${m.toLowerCase()}`);
}

/** Convert kebab-case to camelCase (e.g. "assigned-to" → "assignedTo") */
export function kebabToCamel(str: string): string {
  return str.replace(/-([a-z])/g, (_, c: string) => c.toUpperCase());
}
