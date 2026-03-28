import fs from "fs/promises";
import path from "path";

/**
 * Per-project configuration stored in `.kora.yml` (version-controlled).
 */
export interface ProjectConfig {
  default_provider?: string;
  default_model?: string;
  knowledge?: string[];        // Short knowledge statements injected into all agent personas
  rules?: string[];            // Rules all agents must follow
  agents?: {
    master?: { model?: string; persona?: string; autonomy?: number };
    default_worker?: { model?: string; persona?: string; autonomy?: number };
  };
}

/**
 * Load project config from .kora.yml
 * Falls back to .kora.json if the YAML file doesn't exist.
 * Returns null if neither file exists.
 * Uses a simple YAML-subset parser (no external dependency).
 */
export async function loadProjectConfig(projectPath: string): Promise<ProjectConfig | null> {
  // Try YAML first
  const ymlPath = path.join(projectPath, ".kora.yml");
  try {
    const raw = await fs.readFile(ymlPath, "utf-8");
    return parseSimpleYaml(raw);
  } catch {
    // YAML not found or unreadable, try JSON fallback
  }

  // Fallback: try JSON
  const jsonPath = path.join(projectPath, ".kora.json");
  try {
    const raw = await fs.readFile(jsonPath, "utf-8");
    return JSON.parse(raw) as ProjectConfig;
  } catch {
    return null;
  }
}

/**
 * Simple YAML-subset parser that handles:
 * - key: value (strings and numbers)
 * - Lists with "- item" syntax
 * - One level of nesting with indentation (2-space indent for nested objects)
 *
 * This avoids requiring a YAML dependency. For complex configs,
 * users can use JSON format (.kora.json) as a fallback.
 */
function parseSimpleYaml(raw: string): ProjectConfig {
  const result: Record<string, unknown> = {};
  const lines = raw.split("\n");

  let currentTopKey: string | null = null;
  let currentNestedKey: string | null = null;
  let currentList: string[] | null = null;
  let currentNested: Record<string, unknown> | null = null;

  for (const line of lines) {
    // Skip empty lines and comments
    if (line.trim() === "" || line.trim().startsWith("#")) {
      continue;
    }

    const indent = line.length - line.trimStart().length;
    const trimmed = line.trim();

    if (indent === 0) {
      // Flush any pending list or nested object
      flushPending();

      // Top-level key
      const colonIdx = trimmed.indexOf(":");
      if (colonIdx === -1) continue;

      const key = trimmed.slice(0, colonIdx).trim();
      const value = trimmed.slice(colonIdx + 1).trim();

      currentTopKey = key;

      if (value === "") {
        // Could be a list or nested object — will be determined by subsequent lines
      } else {
        result[key] = parseValue(value);
        currentTopKey = null;
      }
    } else if (indent >= 2 && indent < 4 && currentTopKey) {
      // One level of nesting (2-space indent)
      if (trimmed.startsWith("- ")) {
        // List item
        const item = trimmed.slice(2).trim();
        if (!currentList) {
          currentList = [];
        }
        currentList.push(parseValue(item) as string);
      } else {
        // Nested object key
        flushList();

        const colonIdx = trimmed.indexOf(":");
        if (colonIdx === -1) continue;

        const key = trimmed.slice(0, colonIdx).trim();
        const value = trimmed.slice(colonIdx + 1).trim();

        if (value === "") {
          // Sub-nested object — start collecting
          if (!currentNested) {
            currentNested = {};
          }
          currentNestedKey = key;
        } else {
          if (!currentNested) {
            currentNested = {};
          }
          currentNested[key] = parseValue(value);
          currentNestedKey = null;
        }
      }
    } else if (indent >= 4 && currentTopKey && currentNestedKey) {
      // Two levels of nesting (4-space indent) — properties of a sub-object
      if (!currentNested) {
        currentNested = {};
      }
      if (typeof currentNested[currentNestedKey] !== "object" || currentNested[currentNestedKey] === null) {
        currentNested[currentNestedKey] = {};
      }

      const colonIdx = trimmed.indexOf(":");
      if (colonIdx === -1) continue;

      const key = trimmed.slice(0, colonIdx).trim();
      const value = trimmed.slice(colonIdx + 1).trim();

      (currentNested[currentNestedKey] as Record<string, unknown>)[key] = parseValue(value);
    }
  }

  // Flush any remaining pending data
  flushPending();

  return result as unknown as ProjectConfig;

  function flushList(): void {
    if (currentList && currentTopKey) {
      result[currentTopKey] = currentList;
      currentList = null;
    }
  }

  function flushNested(): void {
    if (currentNested && currentTopKey) {
      result[currentTopKey] = currentNested;
      currentNested = null;
      currentNestedKey = null;
    }
  }

  function flushPending(): void {
    flushList();
    flushNested();
  }
}

/**
 * Parse a YAML scalar value into a JS primitive.
 */
function parseValue(value: string): string | number | boolean | null {
  // Remove surrounding quotes if present
  if (
    (value.startsWith('"') && value.endsWith('"')) ||
    (value.startsWith("'") && value.endsWith("'"))
  ) {
    return value.slice(1, -1);
  }

  // Booleans
  if (value === "true") return true;
  if (value === "false") return false;

  // Null
  if (value === "null" || value === "~") return null;

  // Numbers
  const num = Number(value);
  if (!isNaN(num) && value !== "") return num;

  // Plain string
  return value;
}
