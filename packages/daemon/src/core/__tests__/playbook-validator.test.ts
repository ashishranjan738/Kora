import { describe, it, expect } from "vitest";
import { validateYAMLPlaybook, validatePlaybook } from "../playbook-validator.js";

describe("Playbook Validator", () => {
  describe("YAML Parsing", () => {
    it("parses valid YAML", () => {
      const yaml = `
version: 1
name: "Test Playbook"
description: "A test playbook"
agents:
  - name: Worker
    role: worker
    model: claude-sonnet-4
`;
      const result = validateYAMLPlaybook(yaml);
      expect(result.valid).toBe(true);
      expect(result.errors).toHaveLength(0);
      expect(result.parsed.name).toBe("Test Playbook");
    });

    it("rejects invalid YAML syntax", () => {
      const yaml = `
name: "Test
agents: [
`;
      const result = validateYAMLPlaybook(yaml);
      expect(result.valid).toBe(false);
      expect(result.errors.length).toBeGreaterThan(0);
      expect(result.errors[0]).toContain("YAML parse error");
    });

    it("rejects non-object YAML", () => {
      const yaml = "just a string";
      const result = validateYAMLPlaybook(yaml);
      expect(result.valid).toBe(false);
      expect(result.errors).toContain("YAML must be an object");
    });
  });

  describe("Schema Validation", () => {
    it("requires name field", () => {
      const playbook = {
        agents: [{ name: "Worker", role: "worker", model: "test" }],
      };
      const result = validatePlaybook(playbook);
      expect(result.valid).toBe(false);
      expect(result.errors.some(e => e.includes("name is required"))).toBe(true);
    });

    it("requires at least one agent", () => {
      const playbook = {
        name: "Test",
        agents: [],
      };
      const result = validatePlaybook(playbook);
      expect(result.valid).toBe(false);
      expect(result.errors.some(e => e.includes("at least one agent is required"))).toBe(true);
    });

    it("requires agent name", () => {
      const playbook = {
        name: "Test",
        agents: [{ role: "worker", model: "test" }],
      };
      const result = validatePlaybook(playbook);
      expect(result.valid).toBe(false);
      expect(result.errors.some(e => e.includes("name is required"))).toBe(true);
    });

    it("requires agent role", () => {
      const playbook = {
        name: "Test",
        agents: [{ name: "Worker", model: "test" }],
      };
      const result = validatePlaybook(playbook);
      expect(result.valid).toBe(false);
      expect(result.errors.some(e => e.includes("role is required"))).toBe(true);
    });

    it("validates agent role values", () => {
      const playbook = {
        name: "Test",
        agents: [{ name: "Worker", role: "invalid", model: "test" }],
      };
      const result = validatePlaybook(playbook);
      expect(result.valid).toBe(false);
      expect(result.errors.some(e => e.includes("role must be"))).toBe(true);
    });

    it("requires model if no default", () => {
      const playbook = {
        name: "Test",
        agents: [{ name: "Worker", role: "worker" }],
      };
      const result = validatePlaybook(playbook);
      expect(result.valid).toBe(false);
      expect(result.errors.some(e => e.includes("model required"))).toBe(true);
    });

    it("accepts model from defaults", () => {
      const playbook = {
        name: "Test",
        defaults: { model: "claude-sonnet-4" },
        agents: [{ name: "Worker", role: "worker" }],
      };
      const result = validatePlaybook(playbook);
      expect(result.valid).toBe(true);
    });

    it("requires at least one master agent", () => {
      const playbook = {
        name: "Test",
        agents: [
          { name: "Worker1", role: "worker", model: "test" },
          { name: "Worker2", role: "worker", model: "test" },
        ],
      };
      const result = validatePlaybook(playbook);
      expect(result.valid).toBe(false);
      expect(result.errors.some(e => e.includes("at least one master agent required"))).toBe(true);
    });

    it("warns about multiple master agents", () => {
      const playbook = {
        name: "Test",
        agents: [
          { name: "Master1", role: "master", model: "test" },
          { name: "Master2", role: "master", model: "test" },
        ],
      };
      const result = validatePlaybook(playbook);
      expect(result.valid).toBe(true);
      expect(result.warnings.some(w => w.includes("multiple master agents"))).toBe(true);
    });

    it("detects duplicate agent names", () => {
      const playbook = {
        name: "Test",
        agents: [
          { name: "Worker", role: "master", model: "test" },
          { name: "Worker", role: "worker", model: "test" },
        ],
      };
      const result = validatePlaybook(playbook);
      expect(result.valid).toBe(false);
      expect(result.errors.some(e => e.includes("duplicate agent name"))).toBe(true);
    });
  });

  describe("Task Validation", () => {
    it("validates task structure", () => {
      const playbook = {
        name: "Test",
        agents: [{ name: "Master", role: "master", model: "test" }],
        tasks: [
          { title: "Task 1" },
          { description: "Missing title" }, // Invalid
        ],
      };
      const result = validatePlaybook(playbook);
      expect(result.valid).toBe(false);
      expect(result.errors.some(e => e.includes("title is required"))).toBe(true);
    });

    it("warns about invalid assignedTo", () => {
      const playbook = {
        name: "Test",
        agents: [{ name: "Master", role: "master", model: "test" }],
        tasks: [
          { title: "Task 1", assignedTo: "NonExistent" },
        ],
      };
      const result = validatePlaybook(playbook);
      expect(result.valid).toBe(true);
      expect(result.warnings.some(w => w.includes("not found in agents"))).toBe(true);
    });

    it("validates task priority", () => {
      const playbook = {
        name: "Test",
        agents: [{ name: "Master", role: "master", model: "test" }],
        tasks: [
          { title: "Task 1", priority: "INVALID" },
        ],
      };
      const result = validatePlaybook(playbook);
      expect(result.valid).toBe(false);
      expect(result.errors.some(e => e.includes("priority must be one of"))).toBe(true);
    });
  });

  describe("Variables", () => {
    it("warns about undeclared variables", () => {
      const playbook = {
        name: "Test",
        agents: [
          {
            name: "Master",
            role: "master",
            model: "test",
            persona: "You are a {{framework}} developer", // Undeclared variable
          },
        ],
      };
      const result = validatePlaybook(playbook);
      expect(result.valid).toBe(true);
      expect(result.warnings.some(w => w.includes("{{framework}} used but not declared"))).toBe(true);
    });

    it("accepts declared variables", () => {
      const playbook = {
        name: "Test",
        variables: {
          framework: {
            description: "Framework to use",
            default: "React",
          },
        },
        agents: [
          {
            name: "Master",
            role: "master",
            model: "test",
            persona: "You are a {{framework}} developer",
          },
        ],
      };
      const result = validatePlaybook(playbook);
      expect(result.valid).toBe(true);
      expect(result.warnings).toHaveLength(0);
    });
  });

  describe("Defaults Validation", () => {
    it("validates worktreeMode", () => {
      const playbook = {
        name: "Test",
        defaults: { worktreeMode: "invalid" },
        agents: [{ name: "Master", role: "master", model: "test" }],
      };
      const result = validatePlaybook(playbook);
      expect(result.valid).toBe(false);
      expect(result.errors.some(e => e.includes("worktreeMode must be"))).toBe(true);
    });

    it("validates messagingMode", () => {
      const playbook = {
        name: "Test",
        defaults: { messagingMode: "invalid" },
        agents: [{ name: "Master", role: "master", model: "test" }],
      };
      const result = validatePlaybook(playbook);
      expect(result.valid).toBe(false);
      expect(result.errors.some(e => e.includes("messagingMode must be"))).toBe(true);
    });
  });

  describe("Full Playbook Validation", () => {
    it("validates a complete valid playbook", () => {
      const yaml = `
version: 1
name: "Full Stack Team"
description: "A complete full-stack development team"
author: "test@example.com"
tags: ["fullstack", "web"]

defaults:
  provider: claude-code
  model: claude-sonnet-4
  worktreeMode: isolated
  messagingMode: mcp

variables:
  project_name:
    description: "Project name"
    default: "my-app"
  framework:
    description: "Frontend framework"
    options: ["React", "Vue", "Angular"]
    default: "React"

agents:
  - name: Architect
    role: master
    model: claude-opus-4
    persona: "You are an architect for {{project_name}}"
    initialTask: "Plan the architecture"
  - name: Frontend
    role: worker
    model: claude-sonnet-4
    persona: "You are a {{framework}} frontend developer"
  - name: Backend
    role: worker
    model: claude-sonnet-4
    persona: "You are a backend developer"

tasks:
  - title: "Design API"
    assignedTo: Backend
    priority: P0
  - title: "Build UI"
    assignedTo: Frontend
    priority: P1
    dependencies: ["Design API"]
`;
      const result = validateYAMLPlaybook(yaml);
      expect(result.valid).toBe(true);
      expect(result.errors).toHaveLength(0);
      expect(result.warnings).toHaveLength(0);
    });
  });
});
