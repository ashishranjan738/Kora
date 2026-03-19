/**
 * YAML Playbook validation (daemon-specific YAML parsing + shared validation)
 */

import * as yaml from "js-yaml";
import { validatePlaybook as sharedValidatePlaybook, ValidationResult as SharedValidationResult } from "@kora/shared";

/**
 * Daemon-specific validation result that includes the parsed object
 */
export interface ValidationResult extends SharedValidationResult {
  parsed?: any;
}

/**
 * Parse YAML string and return parsed object or validation errors
 */
export function parseYAML(yamlContent: string): ValidationResult {
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

/**
 * Validate playbook object using shared validator
 * (Re-exported for backward compatibility with existing daemon tests)
 */
export function validatePlaybook(playbook: unknown): ValidationResult {
  const result = sharedValidatePlaybook(playbook);
  return {
    ...result,
    parsed: result.valid ? playbook : undefined,
  };
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

  // Then validate using shared validator
  const sharedResult = sharedValidatePlaybook(parseResult.parsed);

  return {
    ...sharedResult,
    parsed: sharedResult.valid ? parseResult.parsed : undefined,
  };
}
