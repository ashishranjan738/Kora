/**
 * YAML Playbook validation
 */

import * as yaml from "js-yaml";

export interface ValidationResult {
  valid: boolean;
  errors: string[];
  warnings: string[];
  parsed?: any;
}

export interface PlaybookSchema {
  version?: number;
  name: string;
  description?: string;
  author?: string;
  tags?: string[];
  defaults?: {
    provider?: string;
    model?: string;
    worktreeMode?: string;
    messagingMode?: string;
  };
  variables?: Record<string, {
    description?: string;
    default?: string;
    options?: string[];
  }>;
  agents: Array<{
    name: string;
    role: "master" | "worker";
    model?: string;
    persona?: string;
    channels?: string[];
    extraCliArgs?: string[];
    envVars?: Record<string, string>;
    budgetLimit?: number;
    initialTask?: string;
  }>;
  tasks?: Array<{
    title: string;
    description?: string;
    assignedTo?: string;
    dependencies?: string[];
    priority?: string;
  }>;
}

/**
 * Parse YAML string and return parsed object or validation errors
 */
export function parseYAML(yamlContent: string): ValidationResult {
  const errors: string[] = [];

  try {
    const parsed = yaml.load(yamlContent);
    if (!parsed || typeof parsed !== "object") {
      return {
        valid: false,
        errors: ["YAML must be an object"],
        warnings: [],
      };
    }
    return {
      valid: true,
      errors: [],
      warnings: [],
      parsed,
    };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return {
      valid: false,
      errors: [`YAML parse error: ${message}`],
      warnings: [],
    };
  }
}

// Valid priority values
const VALID_PRIORITIES = ["P0", "P1", "P2", "P3"] as const;

/**
 * Validate playbook schema
 */
export function validatePlaybook(raw: unknown): ValidationResult {
  const errors: string[] = [];
  const warnings: string[] = [];

  // Type guard
  if (!raw || typeof raw !== "object") {
    return {
      valid: false,
      errors: ["Playbook must be an object"],
      warnings: [],
    };
  }

  const playbook = raw as any; // Cast after type guard for convenience

  // Required fields
  if (!playbook.name || typeof playbook.name !== "string" || playbook.name.trim() === "") {
    errors.push("name is required and must be a non-empty string");
  }

  if (!playbook.agents || !Array.isArray(playbook.agents) || playbook.agents.length === 0) {
    errors.push("at least one agent is required");
  }

  // Agent validation
  if (Array.isArray(playbook.agents)) {
    const agentNames = new Set<string>();

    for (let i = 0; i < playbook.agents.length; i++) {
      const agent = playbook.agents[i];
      const prefix = `agents[${i}]`;

      if (!agent.name || typeof agent.name !== "string") {
        errors.push(`${prefix}: name is required and must be a string`);
      } else {
        // Check for duplicate names
        if (agentNames.has(agent.name)) {
          errors.push(`${prefix}: duplicate agent name "${agent.name}"`);
        }
        agentNames.add(agent.name);
      }

      if (!agent.role) {
        errors.push(`${prefix} (${agent.name}): role is required`);
      } else if (!["master", "worker"].includes(agent.role)) {
        errors.push(`${prefix} (${agent.name}): role must be "master" or "worker", got "${agent.role}"`);
      }

      const hasAgentModel = agent.model && typeof agent.model === "string" && agent.model.trim() !== "";
      const hasDefaultModel = playbook.defaults?.model && typeof playbook.defaults.model === "string" && playbook.defaults.model.trim() !== "";

      if (!hasAgentModel && !hasDefaultModel) {
        errors.push(`${prefix} (${agent.name}): model required (no default model set)`);
      }

      // Validate extraCliArgs is array
      if (agent.extraCliArgs && !Array.isArray(agent.extraCliArgs)) {
        errors.push(`${prefix} (${agent.name}): extraCliArgs must be an array`);
      }

      // Validate envVars is object
      if (agent.envVars && typeof agent.envVars !== "object") {
        errors.push(`${prefix} (${agent.name}): envVars must be an object`);
      }
    }

    // Exactly one master required
    const masters = playbook.agents.filter((a: any) => a.role === "master");
    if (masters.length === 0) {
      errors.push("at least one master agent is required");
    }
    if (masters.length > 1) {
      warnings.push("multiple master agents defined — only the first will orchestrate the session");
    }
  }

  // Validate defaults if present
  if (playbook.defaults) {
    if (playbook.defaults.worktreeMode && !["isolated", "shared"].includes(playbook.defaults.worktreeMode)) {
      errors.push(`defaults.worktreeMode must be "isolated" or "shared", got "${playbook.defaults.worktreeMode}"`);
    }
    if (playbook.defaults.messagingMode && !["mcp", "acknowledge"].includes(playbook.defaults.messagingMode)) {
      errors.push(`defaults.messagingMode must be "mcp" or "acknowledge", got "${playbook.defaults.messagingMode}"`);
    }
  }

  // Validate variables if present
  if (playbook.variables) {
    if (typeof playbook.variables !== "object") {
      errors.push("variables must be an object");
    } else {
      for (const [key, def] of Object.entries(playbook.variables)) {
        if (typeof def !== "object" || def === null) {
          errors.push(`variables.${key}: must be an object with description/default/options`);
        } else {
          const varDef = def as any;
          if (varDef.options && !Array.isArray(varDef.options)) {
            errors.push(`variables.${key}.options: must be an array`);
          }
        }
      }
    }
  }

  // Validate tasks if present
  if (playbook.tasks) {
    if (!Array.isArray(playbook.tasks)) {
      errors.push("tasks must be an array");
    } else {
      for (let i = 0; i < playbook.tasks.length; i++) {
        const task = playbook.tasks[i];
        const prefix = `tasks[${i}]`;

        if (!task.title || typeof task.title !== "string") {
          errors.push(`${prefix}: title is required and must be a string`);
        }

        if (task.assignedTo && playbook.agents && !playbook.agents.some((a: any) => a.name === task.assignedTo)) {
          warnings.push(`${prefix}: assignedTo "${task.assignedTo}" not found in agents`);
        }

        if (task.dependencies && !Array.isArray(task.dependencies)) {
          errors.push(`${prefix}: dependencies must be an array`);
        }

        if (task.priority && !VALID_PRIORITIES.includes(task.priority)) {
          errors.push(`${prefix}: priority must be one of ${VALID_PRIORITIES.join(", ")}, got "${task.priority}"`);
        }
      }
    }
  }

  // Check for undeclared variable references in agents and tasks
  const declaredVars = new Set(Object.keys(playbook.variables || {}));
  const agentVars = findTemplateVars(JSON.stringify(playbook.agents || []));
  const taskVars = findTemplateVars(JSON.stringify(playbook.tasks || []));
  const usedVars = new Set([...agentVars, ...taskVars]);
  for (const v of usedVars) {
    if (!declaredVars.has(v)) {
      warnings.push(`variable {{${v}}} used but not declared in variables`);
    }
  }

  return {
    valid: errors.length === 0,
    errors,
    warnings,
    parsed: playbook,
  };
}

/**
 * Find all {{variable}} references in a string
 * Supports alphanumeric, underscore, and kebab-case (hyphens)
 */
function findTemplateVars(text: string): Set<string> {
  const vars = new Set<string>();
  const regex = /\{\{([\w-]+)\}\}/g;
  let match;
  while ((match = regex.exec(text)) !== null) {
    vars.add(match[1]);
  }
  return vars;
}

/**
 * Validate and parse YAML playbook
 */
export function validateYAMLPlaybook(yamlContent: string): ValidationResult {
  // First parse YAML
  const parseResult = parseYAML(yamlContent);
  if (!parseResult.valid) {
    return parseResult;
  }

  // Then validate schema
  return validatePlaybook(parseResult.parsed);
}
