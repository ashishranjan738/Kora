/**
 * Unit + integration tests for configurable workflow states.
 */
import { describe, it, expect } from "vitest";
import { DEFAULT_WORKFLOW_STATES, type WorkflowState } from "@kora/shared";

describe("Default workflow states", () => {
  it("has 4 default states", () => {
    expect(DEFAULT_WORKFLOW_STATES).toHaveLength(4);
  });

  it("states are in correct order", () => {
    const ids = DEFAULT_WORKFLOW_STATES.map(s => s.id);
    expect(ids).toEqual(["pending", "in-progress", "review", "done"]);
  });

  it("has correct categories", () => {
    const categories = DEFAULT_WORKFLOW_STATES.map(s => s.category);
    expect(categories).toEqual(["not-started", "active", "active", "closed"]);
  });

  it("all states have required fields", () => {
    for (const s of DEFAULT_WORKFLOW_STATES) {
      expect(s.id).toBeTruthy();
      expect(s.label).toBeTruthy();
      expect(s.color).toMatch(/^#[0-9a-f]{6}$/i);
      expect(["not-started", "active", "closed"]).toContain(s.category);
    }
  });
});

describe("Transition validation logic", () => {
  const customStates: WorkflowState[] = [
    { id: "pending", label: "Backlog", color: "#6b7280", category: "not-started", transitions: ["in-progress"] },
    { id: "in-progress", label: "In Progress", color: "#3b82f6", category: "active", transitions: ["review"] },
    { id: "review", label: "Review", color: "#f59e0b", category: "active", transitions: ["e2e-testing", "in-progress"] },
    { id: "e2e-testing", label: "E2E Testing", color: "#8b5cf6", category: "active", transitions: ["done", "in-progress"], skippable: true },
    { id: "done", label: "Done", color: "#22c55e", category: "closed" },
  ];

  function isValidTransition(fromId: string, toId: string): boolean {
    const fromState = customStates.find(s => s.id === fromId);
    if (!fromState?.transitions?.length) return true; // free movement
    const effective = new Set<string>(fromState.transitions);
    // Add skippable targets
    for (const t of fromState.transitions) {
      const ts = customStates.find(s => s.id === t);
      if (ts?.skippable && ts.transitions?.length) {
        for (const st of ts.transitions) effective.add(st);
      }
    }
    return effective.has(toId);
  }

  it("allows valid forward transitions", () => {
    expect(isValidTransition("pending", "in-progress")).toBe(true);
    expect(isValidTransition("in-progress", "review")).toBe(true);
    expect(isValidTransition("review", "e2e-testing")).toBe(true);
    expect(isValidTransition("e2e-testing", "done")).toBe(true);
  });

  it("allows backward transitions when configured", () => {
    expect(isValidTransition("review", "in-progress")).toBe(true);
    expect(isValidTransition("e2e-testing", "in-progress")).toBe(true);
  });

  it("rejects skipping required steps", () => {
    expect(isValidTransition("pending", "done")).toBe(false);
    expect(isValidTransition("pending", "review")).toBe(false);
    expect(isValidTransition("in-progress", "done")).toBe(false);
    expect(isValidTransition("in-progress", "e2e-testing")).toBe(false);
  });

  it("allows skipping skippable states", () => {
    // review → done is valid because e2e-testing is skippable
    // review's transitions include e2e-testing, and e2e-testing.skippable=true
    // so e2e-testing's transitions (done, in-progress) are added to review's effective transitions
    expect(isValidTransition("review", "done")).toBe(true);
  });

  it("done has no transitions (terminal state)", () => {
    const done = customStates.find(s => s.id === "done");
    expect(done?.transitions).toBeUndefined();
    // Free movement from done (no transitions defined)
    expect(isValidTransition("done", "pending")).toBe(true);
  });
});

describe("Skippable state semantics", () => {
  it("skippable flag is optional and defaults to false", () => {
    const state: WorkflowState = {
      id: "test", label: "Test", color: "#000", category: "active",
    };
    expect(state.skippable).toBeUndefined();
    expect(state.skippable ?? false).toBe(false);
  });

  it("skippable state with transitions expands parent effective transitions", () => {
    const states: WorkflowState[] = [
      { id: "a", label: "A", color: "#000", category: "active", transitions: ["b"] },
      { id: "b", label: "B", color: "#000", category: "active", transitions: ["c"], skippable: true },
      { id: "c", label: "C", color: "#000", category: "closed" },
    ];

    // A's transitions include B. B is skippable → A can also go to C
    const aState = states.find(s => s.id === "a")!;
    const effective = new Set<string>(aState.transitions);
    for (const t of aState.transitions!) {
      const ts = states.find(s => s.id === t);
      if (ts?.skippable && ts.transitions?.length) {
        for (const st of ts.transitions) effective.add(st);
      }
    }
    expect(effective.has("b")).toBe(true);
    expect(effective.has("c")).toBe(true); // skip through b
  });
});

describe("Workflow state validation", () => {
  it("rejects unknown status IDs", () => {
    const validIds = DEFAULT_WORKFLOW_STATES.map(s => s.id);
    expect(validIds.includes("pending")).toBe(true);
    expect(validIds.includes("unknown-status")).toBe(false);
  });

  it("custom pipeline with e2e-testing has 5 states", () => {
    const custom: WorkflowState[] = [
      ...DEFAULT_WORKFLOW_STATES.slice(0, 3), // pending, in-progress, review
      { id: "e2e-testing", label: "E2E Testing", color: "#8b5cf6", category: "active", skippable: true },
      DEFAULT_WORKFLOW_STATES[3], // done
    ];
    expect(custom).toHaveLength(5);
    expect(custom.map(s => s.id)).toEqual(["pending", "in-progress", "review", "e2e-testing", "done"]);
  });
});

describe("Pipeline string generation", () => {
  it("generates readable pipeline from states", () => {
    const pipeline = DEFAULT_WORKFLOW_STATES.map(s => s.id).join(" → ");
    expect(pipeline).toBe("pending → in-progress → review → done");
  });

  it("includes skippable markers", () => {
    const states: WorkflowState[] = [
      { id: "a", label: "A", color: "#000", category: "not-started" },
      { id: "b", label: "B", color: "#000", category: "active", skippable: true },
      { id: "c", label: "C", color: "#000", category: "closed" },
    ];
    const pipeline = states.map(s => s.skippable ? `${s.id}?` : s.id).join(" → ");
    expect(pipeline).toBe("a → b? → c");
  });
});
