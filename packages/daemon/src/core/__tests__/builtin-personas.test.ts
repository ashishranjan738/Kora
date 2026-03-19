import { describe, it, expect } from "vitest";
import {
  BUILTIN_PERSONAS,
  resolveBuiltinPersona,
  renderPersonaTemplate,
} from "../builtin-personas.js";
import { buildPersona } from "../persona-builder.js";

// ---------------------------------------------------------------------------
// Tests — Builtin persona registry
// ---------------------------------------------------------------------------

describe("BUILTIN_PERSONAS", () => {
  it("has 6 builtin personas", () => {
    expect(Object.keys(BUILTIN_PERSONAS)).toHaveLength(6);
  });

  it("includes all expected roles", () => {
    const roles = Object.keys(BUILTIN_PERSONAS);
    expect(roles).toContain("architect");
    expect(roles).toContain("frontend");
    expect(roles).toContain("backend");
    expect(roles).toContain("tester");
    expect(roles).toContain("reviewer");
    expect(roles).toContain("researcher");
  });

  it("all personas have required fields", () => {
    for (const [name, template] of Object.entries(BUILTIN_PERSONAS)) {
      expect(template.identity, `${name} missing identity`).toBeTruthy();
      expect(template.goal, `${name} missing goal`).toBeTruthy();
      expect(template.constraints.length, `${name} has no constraints`).toBeGreaterThan(0);
      expect(template.sop.length, `${name} has no SOP`).toBeGreaterThan(0);
      expect(template.scopeDo.length, `${name} has no DO scope`).toBeGreaterThan(0);
      expect(template.scopeDoNot.length, `${name} has no DO NOT scope`).toBeGreaterThan(0);
    }
  });

  it("all personas include Co-Authored-By ban in constraints", () => {
    for (const [name, template] of Object.entries(BUILTIN_PERSONAS)) {
      const hasBan = template.constraints.some(c => c.includes("Co-Authored-By"));
      expect(hasBan, `${name} missing Co-Authored-By constraint`).toBe(true);
    }
  });

  it("all personas include prod safety constraint", () => {
    for (const [name, template] of Object.entries(BUILTIN_PERSONAS)) {
      const hasProd = template.constraints.some(c => c.includes("7890") || c.includes("production"));
      expect(hasProd, `${name} missing prod safety constraint`).toBe(true);
    }
  });
});

// ---------------------------------------------------------------------------
// Tests — resolveBuiltinPersona
// ---------------------------------------------------------------------------

describe("resolveBuiltinPersona", () => {
  it("resolves builtin:architect", () => {
    const result = resolveBuiltinPersona("builtin:architect");
    expect(result).not.toBeNull();
    expect(result!.identity).toContain("Architect");
  });

  it("resolves builtin:frontend", () => {
    const result = resolveBuiltinPersona("builtin:frontend");
    expect(result).not.toBeNull();
    expect(result!.identity).toContain("frontend");
  });

  it("resolves case-insensitively", () => {
    const result = resolveBuiltinPersona("builtin:BACKEND");
    expect(result).not.toBeNull();
  });

  it("returns null for non-builtin strings", () => {
    expect(resolveBuiltinPersona("You are a specialist")).toBeNull();
    expect(resolveBuiltinPersona("custom persona text")).toBeNull();
  });

  it("returns null for unknown builtin", () => {
    expect(resolveBuiltinPersona("builtin:unknown")).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// Tests — renderPersonaTemplate
// ---------------------------------------------------------------------------

describe("renderPersonaTemplate", () => {
  it("renders all sections in correct order", () => {
    const template = BUILTIN_PERSONAS.frontend;
    const rendered = renderPersonaTemplate(template);

    const identityIdx = rendered.indexOf("## Identity");
    const goalIdx = rendered.indexOf("## Goal");
    const constraintsIdx = rendered.indexOf("## Constraints");
    const sopIdx = rendered.indexOf("## Standard Operating Procedure");
    const scopeIdx = rendered.indexOf("## Scope");

    // Constraints must appear BEFORE SOP and scope
    expect(constraintsIdx).toBeGreaterThan(goalIdx);
    expect(constraintsIdx).toBeLessThan(sopIdx);
    expect(sopIdx).toBeLessThan(scopeIdx);
  });

  it("includes identity text", () => {
    const rendered = renderPersonaTemplate(BUILTIN_PERSONAS.backend);
    expect(rendered).toContain("backend specialist");
  });

  it("includes numbered constraints", () => {
    const rendered = renderPersonaTemplate(BUILTIN_PERSONAS.tester);
    expect(rendered).toContain("1. NEVER include Co-Authored-By");
  });

  it("includes DO and DO NOT scope", () => {
    const rendered = renderPersonaTemplate(BUILTIN_PERSONAS.reviewer);
    expect(rendered).toContain("**DO:**");
    expect(rendered).toContain("**DO NOT:**");
  });

  it("includes git workflow when present", () => {
    const rendered = renderPersonaTemplate(BUILTIN_PERSONAS.frontend);
    expect(rendered).toContain("## Git Workflow");
    expect(rendered).toContain("git rebase");
  });

  it("applies overrides — extra constraints", () => {
    const rendered = renderPersonaTemplate(BUILTIN_PERSONAS.backend, {
      constraints: ["NEVER use console.log in production code"],
    });
    expect(rendered).toContain("NEVER use console.log");
  });

  it("applies overrides — extra scope items", () => {
    const rendered = renderPersonaTemplate(BUILTIN_PERSONAS.frontend, {
      scopeDo: ["WebSocket client code"],
      scopeDoNot: ["Server-side rendering"],
    });
    expect(rendered).toContain("WebSocket client code");
    expect(rendered).toContain("Server-side rendering");
  });
});

// ---------------------------------------------------------------------------
// Tests — buildPersona integration with builtin templates
// ---------------------------------------------------------------------------

describe("buildPersona with builtin templates", () => {
  it("resolves builtin:frontend in buildPersona", () => {
    const result = buildPersona({
      agentId: "test-agent",
      role: "worker",
      userPersona: "builtin:frontend",
      permissions: { canSpawnAgents: false, canRemoveAgents: false, canModifyFiles: true, maxSubAgents: 0 },
      sessionId: "test-session",
      runtimeDir: ".kora-dev",
    });

    expect(result).toContain("## Identity");
    expect(result).toContain("frontend specialist");
    expect(result).toContain("## Constraints");
    expect(result).toContain("Co-Authored-By");
  });

  it("falls back to raw text for non-builtin persona", () => {
    const result = buildPersona({
      agentId: "test-agent",
      role: "worker",
      userPersona: "You are a custom agent",
      permissions: { canSpawnAgents: false, canRemoveAgents: false, canModifyFiles: true, maxSubAgents: 0 },
      sessionId: "test-session",
      runtimeDir: ".kora-dev",
    });

    expect(result).toContain("You are a custom agent");
    expect(result).not.toContain("## Identity");
  });

  it("includes worker protocol for builtin worker persona", () => {
    const result = buildPersona({
      agentId: "test-agent",
      role: "worker",
      userPersona: "builtin:backend",
      permissions: { canSpawnAgents: false, canRemoveAgents: false, canModifyFiles: true, maxSubAgents: 0 },
      sessionId: "test-session",
      runtimeDir: ".kora-dev",
    });

    expect(result).toContain("## Worker Protocol");
    expect(result).toContain("## Identity");
  });

  it("includes master protocol for builtin architect persona", () => {
    const result = buildPersona({
      agentId: "test-agent",
      role: "master",
      userPersona: "builtin:architect",
      permissions: { canSpawnAgents: true, canRemoveAgents: true, canModifyFiles: false, maxSubAgents: 5 },
      sessionId: "test-session",
      runtimeDir: ".kora-dev",
    });

    expect(result).toContain("## Master Orchestrator Protocol");
    expect(result).toContain("## Agent Management");
  });

  it("passes persona overrides to builtin template", () => {
    const result = buildPersona({
      agentId: "test-agent",
      role: "worker",
      userPersona: "builtin:tester",
      permissions: { canSpawnAgents: false, canRemoveAgents: false, canModifyFiles: true, maxSubAgents: 0 },
      sessionId: "test-session",
      runtimeDir: ".kora-dev",
      personaOverrides: {
        constraints: ["Must achieve 90% code coverage"],
      },
    });

    expect(result).toContain("Must achieve 90% code coverage");
  });
});
