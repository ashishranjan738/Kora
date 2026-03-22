/**
 * Workflow pipeline utility functions.
 * Shared between dashboard (client-side validation) and daemon (server-side enforcement).
 */

import type { WorkflowState } from "./types.js";

/**
 * Auto-generate transitions for an ordered pipeline of workflow states.
 *
 * Rules:
 * 1. Each state transitions forward to the next state in order.
 * 2. If the next state is skippable, also allow transitioning to the state after it.
 * 3. Active states can transition backward to the previous active state (rework).
 *    (Does NOT add backward transitions to "not-started" category states.)
 * 4. Terminal state (last) has no outgoing transitions.
 * 5. First state only goes forward.
 */
export function autoGenerateTransitions(states: WorkflowState[]): WorkflowState[] {
  if (states.length === 0) return [];
  if (states.length === 1) return [{ ...states[0], transitions: [] }];

  return states.map((state, i) => {
    // If user already set transitions, preserve them
    if (state.transitions && state.transitions.length > 0) return state;

    const isFirst = i === 0;
    const isLast = i === states.length - 1;

    // Terminal state: no outgoing transitions
    if (isLast) return { ...state, transitions: [] };

    const transitions: string[] = [];

    // Forward: always allow next state
    transitions.push(states[i + 1].id);

    // Forward skip: if next state is skippable and there's a state after it
    if (states[i + 1].skippable && i + 2 < states.length) {
      transitions.push(states[i + 2].id);
    }

    // Backward: allow going back to previous state
    // Active states can always go back one step (including back to backlog)
    if (!isFirst) {
      transitions.push(states[i - 1].id);
    }

    return { ...state, transitions };
  });
}

/**
 * Compute the effective set of valid transition targets from a given state.
 * Handles skippable state expansion (one level only — NOT recursive).
 * Always includes closed-category states as valid targets.
 *
 * @param currentStateId - The state to compute transitions from
 * @param workflowStates - All workflow states in the pipeline
 * @returns Set of valid target state IDs, or null if no transitions defined
 */
export function getEffectiveTransitions(
  currentStateId: string,
  workflowStates: WorkflowState[],
): Set<string> | null {
  const currentState = workflowStates.find(s => s.id === currentStateId);
  if (!currentState?.transitions?.length) return null;

  const effective = new Set<string>(currentState.transitions);

  // Expand skippable states ONE level only — add their non-closed forward transitions.
  // This prevents transitive chaining (e.g. skip e2e → skip staging → done).
  for (const t of currentState.transitions) {
    const targetState = workflowStates.find(s => s.id === t);
    if (targetState?.skippable && targetState.transitions?.length) {
      for (const skipTarget of targetState.transitions) {
        const skipTargetState = workflowStates.find(s => s.id === skipTarget);
        // Only add non-closed targets — closed states are handled separately below.
        // This prevents skippable expansion from reaching "done" through intermediate states.
        if (skipTargetState && skipTargetState.category !== "closed") {
          effective.add(skipTarget);
        }
      }
    }
  }

  // Always allow closed-category states as direct targets (e.g. "done")
  for (const s of workflowStates) {
    if (s.category === "closed") effective.add(s.id);
  }

  return effective;
}

/**
 * Validate a workflow pipeline for correctness.
 */
export interface PipelineValidationResult {
  valid: boolean;
  errors: string[];
  warnings: string[];
}

export function validatePipeline(states: WorkflowState[]): PipelineValidationResult {
  const errors: string[] = [];
  const warnings: string[] = [];

  if (states.length === 0) {
    return { valid: false, errors: ["Pipeline must have at least one state."], warnings };
  }
  if (states.length === 1) {
    return { valid: false, errors: ["Pipeline must have at least 2 states."], warnings };
  }

  // Duplicate IDs
  const ids = states.map(s => s.id);
  const idSet = new Set(ids);
  if (idSet.size !== ids.length) {
    const dupes = ids.filter((id, i) => ids.indexOf(id) !== i);
    errors.push(`Duplicate state IDs: ${[...new Set(dupes)].join(", ")}`);
  }

  // Terminal state
  const closedStates = states.filter(s => s.category === "closed");
  if (closedStates.length === 0) {
    errors.push("Pipeline must have at least one terminal state (category: closed).");
  }

  // Invalid transition targets
  for (const state of states) {
    if (state.transitions) {
      for (const targetId of state.transitions) {
        if (!idSet.has(targetId)) {
          errors.push(`"${state.label}" references unknown state "${targetId}".`);
        }
      }
    }
  }

  // Reachability (BFS from first state)
  if (states.length > 1 && errors.length === 0) {
    const reachable = new Set<string>([states[0].id]);
    const queue = [states[0].id];

    while (queue.length > 0) {
      const currentId = queue.shift()!;
      const current = states.find(s => s.id === currentId);
      if (!current?.transitions?.length) continue;
      for (const targetId of current.transitions) {
        if (!reachable.has(targetId)) {
          reachable.add(targetId);
          queue.push(targetId);
        }
      }
    }

    const unreachable = states.filter(s => !reachable.has(s.id));
    if (unreachable.length > 0) {
      errors.push(`Unreachable: ${unreachable.map(s => s.label).join(", ")}`);
    }
  }

  // Warnings
  if (states[0].category !== "not-started") {
    warnings.push(`First state "${states[0].label}" should be category "not-started".`);
  }
  if (states[0].skippable) warnings.push("First state should not be skippable.");
  if (states[states.length - 1].skippable) warnings.push("Last state should not be skippable.");

  // Empty transitions warning (not an error — means free movement)
  const activeWithNoTransitions = states.filter(s =>
    s.category !== "closed" && (!s.transitions || s.transitions.length === 0)
  );
  if (activeWithNoTransitions.length > 0 && states.some(s => s.transitions?.length)) {
    warnings.push(`States with no transitions allow free movement: ${activeWithNoTransitions.map(s => s.label).join(", ")}`);
  }

  return { valid: errors.length === 0, errors, warnings };
}
