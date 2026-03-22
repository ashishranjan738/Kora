/**
 * Unit tests for TaskBoard dynamic workflow columns validation.
 * Tests transition logic, status validation, category grouping,
 * and template correctness at the logic layer.
 *
 * Covers E2E test plan scenarios TC-1 through TC-8 at the unit level.
 */

import { describe, it, expect } from "vitest";
import {
  DEFAULT_WORKFLOW_STATES,
  PIPELINE_TEMPLATES,
  autoGenerateTransitions,
  validatePipeline,
  getPipelineTemplate,
  type WorkflowState,
} from "@kora/shared";

// ---------------------------------------------------------------------------
// Helpers — replicate transition validation from api-routes.ts
// ---------------------------------------------------------------------------

function isValidTransition(
  states: WorkflowState[],
  fromId: string,
  toId: string,
): boolean {
  const fromState = states.find(s => s.id === fromId);
  if (!fromState?.transitions?.length) return true; // free movement
  const effective = new Set<string>(fromState.transitions);
  for (const t of fromState.transitions) {
    const ts = states.find(s => s.id === t);
    if (ts?.skippable && ts.transitions?.length) {
      for (const st of ts.transitions) effective.add(st);
    }
  }
  return effective.has(toId);
}

function getEffectiveTransitions(
  states: WorkflowState[],
  fromId: string,
): string[] {
  const fromState = states.find(s => s.id === fromId);
  if (!fromState?.transitions?.length) return states.map(s => s.id);
  const effective = new Set<string>(fromState.transitions);
  for (const t of fromState.transitions) {
    const ts = states.find(s => s.id === t);
    if (ts?.skippable && ts.transitions?.length) {
      for (const st of ts.transitions) effective.add(st);
    }
  }
  return [...effective];
}

function getStatusesByCategory(
  states: WorkflowState[],
  category: "not-started" | "active" | "closed",
): string[] {
  return states.filter(s => s.category === category).map(s => s.id);
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("TaskBoard dynamic workflow — unit logic", () => {

  // ─── TC-1: Default 4-column board ─────────────────────

  describe("TC-1: Default 4-column board", () => {
    const states = DEFAULT_WORKFLOW_STATES;

    it("has exactly 4 states", () => {
      expect(states).toHaveLength(4);
    });

    it("state IDs are: pending, in-progress, review, done", () => {
      expect(states.map(s => s.id)).toEqual(["pending", "in-progress", "review", "done"]);
    });

    it("all states have labels", () => {
      for (const s of states) {
        expect(s.label).toBeTruthy();
      }
    });

    it("all states have valid hex colors", () => {
      for (const s of states) {
        expect(s.color).toMatch(/^#[0-9a-f]{6}$/i);
      }
    });

    it("categories: not-started(1), active(2), closed(1)", () => {
      expect(getStatusesByCategory(states, "not-started")).toEqual(["pending"]);
      expect(getStatusesByCategory(states, "active")).toEqual(["in-progress", "review"]);
      expect(getStatusesByCategory(states, "closed")).toEqual(["done"]);
    });
  });

  // ─── TC-2: Full Pipeline (6 columns) ──────────────────

  describe("TC-2: Full Pipeline template", () => {
    const fullTemplate = getPipelineTemplate("full");
    const states = fullTemplate.states;

    it("has exactly 6 states", () => {
      expect(states).toHaveLength(6);
    });

    it("state IDs: backlog, in-progress, review, e2e-testing, staging, done", () => {
      expect(states.map(s => s.id)).toEqual([
        "backlog", "in-progress", "review", "e2e-testing", "staging", "done",
      ]);
    });

    it("has correct labels", () => {
      const labels = Object.fromEntries(states.map(s => [s.id, s.label]));
      expect(labels["backlog"]).toBe("Backlog");
      expect(labels["in-progress"]).toBe("In Progress");
      expect(labels["review"]).toBe("Review");
      expect(labels["e2e-testing"]).toBe("E2E Testing");
      expect(labels["staging"]).toBe("Staging");
      expect(labels["done"]).toBe("Done");
    });

    it("all have hex colors", () => {
      for (const s of states) {
        expect(s.color).toMatch(/^#[0-9a-f]{6}$/i);
      }
    });

    it("categories are correct", () => {
      expect(getStatusesByCategory(states, "not-started")).toEqual(["backlog"]);
      expect(getStatusesByCategory(states, "active")).toEqual([
        "in-progress", "review", "e2e-testing", "staging",
      ]);
      expect(getStatusesByCategory(states, "closed")).toEqual(["done"]);
    });

    it("e2e-testing and staging are marked skippable", () => {
      const e2e = states.find(s => s.id === "e2e-testing")!;
      const staging = states.find(s => s.id === "staging")!;
      expect(e2e.skippable).toBe(true);
      expect(staging.skippable).toBe(true);
    });

    it("non-skippable states are NOT marked skippable", () => {
      const backlog = states.find(s => s.id === "backlog")!;
      const inProgress = states.find(s => s.id === "in-progress")!;
      const review = states.find(s => s.id === "review")!;
      const done = states.find(s => s.id === "done")!;
      expect(backlog.skippable).toBeFalsy();
      expect(inProgress.skippable).toBeFalsy();
      expect(review.skippable).toBeFalsy();
      expect(done.skippable).toBeFalsy();
    });
  });

  // ─── TC-4: Transition validation ──────────────────────

  describe("TC-4: Transition validation (Full Pipeline)", () => {
    const states = getPipelineTemplate("full").states;

    describe("valid forward transitions", () => {
      it("backlog -> in-progress", () => {
        expect(isValidTransition(states, "backlog", "in-progress")).toBe(true);
      });

      it("in-progress -> review", () => {
        expect(isValidTransition(states, "in-progress", "review")).toBe(true);
      });

      it("review -> e2e-testing", () => {
        expect(isValidTransition(states, "review", "e2e-testing")).toBe(true);
      });

      it("e2e-testing -> staging", () => {
        expect(isValidTransition(states, "e2e-testing", "staging")).toBe(true);
      });

      it("staging -> done", () => {
        expect(isValidTransition(states, "staging", "done")).toBe(true);
      });

      it("e2e-testing -> done", () => {
        expect(isValidTransition(states, "e2e-testing", "done")).toBe(true);
      });
    });

    describe("skippable transitions", () => {
      it("review -> done (skip e2e-testing + staging)", () => {
        expect(isValidTransition(states, "review", "done")).toBe(true);
      });

      it("review -> staging (skip e2e-testing)", () => {
        expect(isValidTransition(states, "review", "staging")).toBe(true);
      });

      it("e2e-testing -> done (skip staging)", () => {
        expect(isValidTransition(states, "e2e-testing", "done")).toBe(true);
      });
    });

    describe("invalid transitions (must be rejected)", () => {
      it("backlog -> done", () => {
        expect(isValidTransition(states, "backlog", "done")).toBe(false);
      });

      it("backlog -> review", () => {
        expect(isValidTransition(states, "backlog", "review")).toBe(false);
      });

      it("backlog -> e2e-testing", () => {
        expect(isValidTransition(states, "backlog", "e2e-testing")).toBe(false);
      });

      it("backlog -> staging", () => {
        expect(isValidTransition(states, "backlog", "staging")).toBe(false);
      });

      it("in-progress -> done", () => {
        expect(isValidTransition(states, "in-progress", "done")).toBe(false);
      });

      it("in-progress -> e2e-testing", () => {
        expect(isValidTransition(states, "in-progress", "e2e-testing")).toBe(false);
      });

      it("in-progress -> staging", () => {
        expect(isValidTransition(states, "in-progress", "staging")).toBe(false);
      });
    });

    describe("backward transitions (configured)", () => {
      it("review -> in-progress (rejection/rework)", () => {
        expect(isValidTransition(states, "review", "in-progress")).toBe(true);
      });

      it("e2e-testing -> review (test failed)", () => {
        expect(isValidTransition(states, "e2e-testing", "review")).toBe(true);
      });

      it("staging -> e2e-testing (regression found)", () => {
        expect(isValidTransition(states, "staging", "e2e-testing")).toBe(true);
      });
    });

    describe("effective transitions include skippable expansions", () => {
      it("review has e2e-testing, in-progress, AND expanded targets (staging, done)", () => {
        const effective = getEffectiveTransitions(states, "review");
        expect(effective).toContain("e2e-testing");
        expect(effective).toContain("in-progress");
        expect(effective).toContain("staging");
        expect(effective).toContain("done");
      });

      it("e2e-testing has staging, done, review, AND expanded targets", () => {
        const effective = getEffectiveTransitions(states, "e2e-testing");
        expect(effective).toContain("staging");
        expect(effective).toContain("done");
        expect(effective).toContain("review");
      });
    });
  });

  // ─── TC-6: Category-based grouping ────────────────────

  describe("TC-6: Category grouping across templates", () => {
    it("default template: all tasks categorizable", () => {
      const states = DEFAULT_WORKFLOW_STATES;
      const allIds = states.map(s => s.id);
      const categorized = [
        ...getStatusesByCategory(states, "not-started"),
        ...getStatusesByCategory(states, "active"),
        ...getStatusesByCategory(states, "closed"),
      ];
      expect(categorized.sort()).toEqual(allIds.sort());
    });

    it("full pipeline template: all tasks categorizable", () => {
      const states = getPipelineTemplate("full").states;
      const allIds = states.map(s => s.id);
      const categorized = [
        ...getStatusesByCategory(states, "not-started"),
        ...getStatusesByCategory(states, "active"),
        ...getStatusesByCategory(states, "closed"),
      ];
      expect(categorized.sort()).toEqual(allIds.sort());
    });

    it("simple template: all tasks categorizable", () => {
      const states = getPipelineTemplate("simple").states;
      const allIds = states.map(s => s.id);
      const categorized = [
        ...getStatusesByCategory(states, "not-started"),
        ...getStatusesByCategory(states, "active"),
        ...getStatusesByCategory(states, "closed"),
      ];
      expect(categorized.sort()).toEqual(allIds.sort());
    });

    it("every template has at least one closed state", () => {
      for (const template of PIPELINE_TEMPLATES) {
        if (template.id === "custom") continue;
        const closed = getStatusesByCategory(template.states, "closed");
        expect(closed.length).toBeGreaterThanOrEqual(1);
      }
    });

    it("every template has at least one not-started state", () => {
      for (const template of PIPELINE_TEMPLATES) {
        if (template.id === "custom") continue;
        const notStarted = getStatusesByCategory(template.states, "not-started");
        expect(notStarted.length).toBeGreaterThanOrEqual(1);
      }
    });
  });

  // ─── TC-8: Simple template ────────────────────────────

  describe("TC-8: Simple template", () => {
    const states = getPipelineTemplate("simple").states;

    it("has exactly 3 states", () => {
      expect(states).toHaveLength(3);
    });

    it("state IDs: todo, in-progress, done", () => {
      expect(states.map(s => s.id)).toEqual(["todo", "in-progress", "done"]);
    });

    it("labels: To Do, In Progress, Done", () => {
      expect(states.map(s => s.label)).toEqual(["To Do", "In Progress", "Done"]);
    });

    it("valid transitions: todo -> in-progress -> done", () => {
      expect(isValidTransition(states, "todo", "in-progress")).toBe(true);
      expect(isValidTransition(states, "in-progress", "done")).toBe(true);
    });

    it("invalid direct skip: todo -> done", () => {
      expect(isValidTransition(states, "todo", "done")).toBe(false);
    });
  });

  // ─── autoGenerateTransitions correctness ──────────────

  describe("autoGenerateTransitions", () => {
    it("generates forward transitions for linear pipeline", () => {
      const raw: WorkflowState[] = [
        { id: "a", label: "A", color: "#000", category: "not-started" },
        { id: "b", label: "B", color: "#000", category: "active" },
        { id: "c", label: "C", color: "#000", category: "closed" },
      ];
      const result = autoGenerateTransitions(raw);

      expect(result[0].transitions).toContain("b");
      expect(result[1].transitions).toContain("c");
    });

    it("preserves skippable flag", () => {
      const raw: WorkflowState[] = [
        { id: "a", label: "A", color: "#000", category: "not-started" },
        { id: "b", label: "B", color: "#000", category: "active", skippable: true },
        { id: "c", label: "C", color: "#000", category: "closed" },
      ];
      const result = autoGenerateTransitions(raw);
      const b = result.find(s => s.id === "b")!;
      expect(b.skippable).toBe(true);
    });
  });

  // ─── Pipeline validation ──────────────────────────────

  describe("validatePipeline", () => {
    it("default states with auto-generated transitions are valid", () => {
      const withTransitions = autoGenerateTransitions(DEFAULT_WORKFLOW_STATES);
      const result = validatePipeline(withTransitions);
      expect(result.valid).toBe(true);
      expect(result.errors).toHaveLength(0);
    });

    it("all template states are valid", () => {
      for (const template of PIPELINE_TEMPLATES) {
        if (template.id === "custom") continue;
        const result = validatePipeline(template.states);
        expect(result.valid).toBe(true);
        expect(result.errors).toHaveLength(0);
      }
    });

    it("rejects empty pipeline", () => {
      const result = validatePipeline([]);
      expect(result.valid).toBe(false);
      expect(result.errors.length).toBeGreaterThan(0);
    });

    it("rejects pipeline without closed state", () => {
      const badStates: WorkflowState[] = [
        { id: "a", label: "A", color: "#000", category: "not-started" },
        { id: "b", label: "B", color: "#000", category: "active" },
      ];
      const result = validatePipeline(badStates);
      expect(result.valid).toBe(false);
      expect(result.errors.length).toBeGreaterThan(0);
    });

    it("rejects duplicate IDs", () => {
      const dupStates: WorkflowState[] = [
        { id: "a", label: "A", color: "#000", category: "not-started" },
        { id: "a", label: "B", color: "#000", category: "closed" },
      ];
      const result = validatePipeline(dupStates);
      expect(result.valid).toBe(false);
      expect(result.errors.length).toBeGreaterThan(0);
    });
  });
});
