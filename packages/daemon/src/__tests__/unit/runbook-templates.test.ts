/**
 * Tests for pipeline runbook default templates and auto-population.
 */
import { describe, it, expect } from "vitest";
import {
  DEFAULT_STATE_INSTRUCTIONS,
  populateDefaultInstructions,
  validatePipeline,
} from "@kora/shared";
import type { WorkflowState } from "@kora/shared";
import { DEFAULT_WORKFLOW_STATES } from "@kora/shared";

describe("DEFAULT_STATE_INSTRUCTIONS", () => {
  it("has templates for common active states", () => {
    expect(DEFAULT_STATE_INSTRUCTIONS["in-progress"]).toBeDefined();
    expect(DEFAULT_STATE_INSTRUCTIONS["review"]).toBeDefined();
    expect(DEFAULT_STATE_INSTRUCTIONS["testing"]).toBeDefined();
    expect(DEFAULT_STATE_INSTRUCTIONS["staging"]).toBeDefined();
  });

  it("templates are non-empty strings", () => {
    for (const [key, value] of Object.entries(DEFAULT_STATE_INSTRUCTIONS)) {
      expect(typeof value).toBe("string");
      expect(value.trim().length).toBeGreaterThan(0);
    }
  });

  it("does not have templates for terminal states", () => {
    expect(DEFAULT_STATE_INSTRUCTIONS["pending"]).toBeUndefined();
    expect(DEFAULT_STATE_INSTRUCTIONS["done"]).toBeUndefined();
  });
});

describe("populateDefaultInstructions", () => {
  it("fills in instructions for states matching known templates", () => {
    const states: WorkflowState[] = [
      { id: "pending", label: "Pending", color: "#ccc", category: "not-started" },
      { id: "in-progress", label: "In Progress", color: "#00f", category: "active" },
      { id: "review", label: "Review", color: "#ff0", category: "active" },
      { id: "done", label: "Done", color: "#0f0", category: "closed" },
    ];

    const result = populateDefaultInstructions(states);

    expect(result[0].instructions).toBeUndefined(); // pending — no template
    expect(result[1].instructions).toBe(DEFAULT_STATE_INSTRUCTIONS["in-progress"]);
    expect(result[2].instructions).toBe(DEFAULT_STATE_INSTRUCTIONS["review"]);
    expect(result[3].instructions).toBeUndefined(); // done — no template
  });

  it("preserves existing instructions", () => {
    const states: WorkflowState[] = [
      { id: "in-progress", label: "In Progress", color: "#00f", category: "active", instructions: "Custom instructions" },
      { id: "review", label: "Review", color: "#ff0", category: "active" },
    ];

    const result = populateDefaultInstructions(states);

    expect(result[0].instructions).toBe("Custom instructions"); // preserved
    expect(result[1].instructions).toBe(DEFAULT_STATE_INSTRUCTIONS["review"]); // filled
  });

  it("handles unknown state IDs gracefully", () => {
    const states: WorkflowState[] = [
      { id: "custom-state", label: "Custom", color: "#abc", category: "active" },
    ];

    const result = populateDefaultInstructions(states);

    expect(result[0].instructions).toBeUndefined(); // no template for custom-state
  });

  it("handles empty array", () => {
    expect(populateDefaultInstructions([])).toEqual([]);
  });
});

describe("DEFAULT_WORKFLOW_STATES includes instructions", () => {
  it("in-progress has instructions", () => {
    const inProgress = DEFAULT_WORKFLOW_STATES.find(s => s.id === "in-progress");
    expect(inProgress?.instructions).toBeDefined();
    expect(inProgress?.instructions?.length).toBeGreaterThan(0);
  });

  it("review has instructions", () => {
    const review = DEFAULT_WORKFLOW_STATES.find(s => s.id === "review");
    expect(review?.instructions).toBeDefined();
    expect(review?.instructions?.length).toBeGreaterThan(0);
  });

  it("pending and done have no instructions", () => {
    const pending = DEFAULT_WORKFLOW_STATES.find(s => s.id === "pending");
    const done = DEFAULT_WORKFLOW_STATES.find(s => s.id === "done");
    expect(pending?.instructions).toBeUndefined();
    expect(done?.instructions).toBeUndefined();
  });
});

describe("validatePipeline warns about empty instructions", () => {
  it("validates pipeline with active states (instructions warning is non-blocking)", () => {
    const states: WorkflowState[] = [
      { id: "pending", label: "Pending", color: "#ccc", category: "not-started", transitions: ["active"] },
      { id: "active", label: "Active", color: "#00f", category: "active", transitions: ["done"] },
      { id: "done", label: "Done", color: "#0f0", category: "closed" },
    ];

    const result = validatePipeline(states);

    // Pipeline is valid — empty instructions is a warning, not an error
    expect(result.valid).toBe(true);
    expect(result.errors).toHaveLength(0);
  });

  it("pipeline with instructions is also valid", () => {
    const states: WorkflowState[] = [
      { id: "pending", label: "Pending", color: "#ccc", category: "not-started", transitions: ["active"] },
      { id: "active", label: "Active", color: "#00f", category: "active", transitions: ["done"], instructions: "Do the work." },
      { id: "done", label: "Done", color: "#0f0", category: "closed" },
    ];

    const result = validatePipeline(states);

    expect(result.valid).toBe(true);
    expect(result.errors).toHaveLength(0);
  });
});
