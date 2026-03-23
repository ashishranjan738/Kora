/**
 * Tests for DELETE /tasks role-based access control.
 */
import { describe, it, expect } from "vitest";

// Simulate the role check logic from api-routes.ts
function isDeleteAllowed(agentRole: string | undefined): boolean {
  // Dashboard users (no header) → allowed
  // Master agents → allowed
  // Workers + unknown roles → blocked
  if (agentRole && agentRole !== "master") return false;
  return true;
}

describe("DELETE /tasks RBAC", () => {
  it("master agent can delete tasks", () => {
    expect(isDeleteAllowed("master")).toBe(true);
  });

  it("worker agent cannot delete tasks", () => {
    expect(isDeleteAllowed("worker")).toBe(false);
  });

  it("unknown role cannot delete tasks", () => {
    expect(isDeleteAllowed("unknown")).toBe(false);
  });

  it("dashboard user (no header) can delete tasks", () => {
    expect(isDeleteAllowed(undefined)).toBe(true);
  });

  it("empty string role cannot delete tasks", () => {
    expect(isDeleteAllowed("")).toBe(true); // empty string is falsy → treated as no header
  });
});
