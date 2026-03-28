import Ajv from "ajv";
import playbookSchema from "./playbook-schema.json";

// Ajv v8 is installed in packages/shared/node_modules but tsc resolves
// root node_modules/ajv v6 types in worktrees. Use generic ErrorObject type.
type AjvErrorObject = {
  keyword: string;
  instancePath?: string;
  dataPath?: string;
  schemaPath: string;
  params: Record<string, any>;
  message?: string;
};

const ajv = new Ajv({ allErrors: true, strict: false } as any);
const validateSchema = ajv.compile(playbookSchema);

export interface ValidationResult {
  valid: boolean;
  errors: string[];
  warnings: string[];
}

/**
 * Validate a playbook against the JSON Schema.
 * Returns structured validation result with errors (blocking) and warnings (non-blocking).
 */
export function validatePlaybook(playbook: unknown): ValidationResult {
  const errors: string[] = [];
  const warnings: string[] = [];

  // Run JSON Schema validation
  const valid = validateSchema(playbook);

  if (!valid && validateSchema.errors) {
    for (const error of validateSchema.errors) {
      errors.push(formatAjvError(error));
    }
  }

  // If schema validation failed, return early
  if (!valid) {
    return { valid: false, errors, warnings };
  }

  // Type assertion after schema validation
  const pb = playbook as any;

  // Additional business logic validations

  // Check for exactly one master agent
  const masters = (pb.agents || []).filter((a: any) => a.role === "master");
  if (masters.length === 0) {
    errors.push("At least one master agent is required");
  } else if (masters.length > 1) {
    warnings.push(
      `Multiple master agents found (${masters.length}). Only the first will act as orchestrator.`
    );
  }

  // Check agent names are unique
  const agentNames = new Set<string>();
  for (const agent of pb.agents || []) {
    if (agentNames.has(agent.name)) {
      errors.push(`Duplicate agent name: "${agent.name}"`);
    }
    agentNames.add(agent.name);
  }

  // Check that agents have a model (either individually or via defaults)
  const hasDefaultModel = pb.defaults?.model && pb.defaults.model.trim() !== "";
  for (const agent of pb.agents || []) {
    const agentModel = agent.model?.trim();
    if ((!agentModel || agentModel === "") && !hasDefaultModel) {
      errors.push(
        `Agent "${agent.name}" requires a model (no defaults.model set)`
      );
    }
  }

  // Check variable references in agent personas, initialTask, and tasks
  const declaredVars = new Set(Object.keys(pb.variables || {}));
  const allText = JSON.stringify({ agents: pb.agents, tasks: pb.tasks });
  const usedVars = findTemplateVariables(allText);

  for (const varName of usedVars) {
    if (!declaredVars.has(varName)) {
      warnings.push(
        `Variable "{{${varName}}}" is used but not declared in variables section`
      );
    }
  }

  // Check task references
  if (pb.tasks) {
    const agentNames = new Set((pb.agents || []).map((a: any) => a.name));
    for (const task of pb.tasks) {
      if (task.assignedTo && !agentNames.has(task.assignedTo)) {
        warnings.push(
          `Task "${task.title}" is assigned to "${task.assignedTo}" which is not in the agents list`
        );
      }
    }
  }

  return {
    valid: errors.length === 0,
    errors,
    warnings,
  };
}

/**
 * Format Ajv validation error into human-readable message.
 */
function formatAjvError(error: AjvErrorObject): string {
  const path = error.instancePath || error.dataPath || "root";

  switch (error.keyword) {
    case "required":
      return `${path}: missing required property "${error.params.missingProperty}"`;
    case "type":
      return `${path}: should be ${error.params.type}`;
    case "enum":
      return `${path}: should be one of [${error.params.allowedValues.join(", ")}]`;
    case "minLength":
      return `${path}: should have minimum length of ${error.params.limit}`;
    case "minItems":
      return `${path}: should have at least ${error.params.limit} item(s)`;
    case "additionalProperties":
      return `${path}: should not have additional property "${error.params.additionalProperty}"`;
    case "pattern":
      return `${path}: should match pattern ${error.params.pattern}`;
    case "const":
      return `${path}: should be equal to constant ${(error.params as Record<string, unknown>).allowedValue}`;
    default:
      return `${path}: ${error.message}`;
  }
}

/**
 * Find all template variable references ({{variable_name}}) in text.
 */
function findTemplateVariables(text: string): Set<string> {
  const variables = new Set<string>();
  const regex = /\{\{([\w-]+)\}\}/g;
  let match;

  while ((match = regex.exec(text)) !== null) {
    variables.add(match[1]);
  }

  return variables;
}
