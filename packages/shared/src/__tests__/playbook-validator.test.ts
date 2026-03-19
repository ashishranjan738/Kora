import { describe, it, expect } from "vitest";
import { validatePlaybook } from "../playbook-validator";

describe("validatePlaybook", () => {
  describe("valid playbooks", () => {
    it("should accept a minimal valid playbook", () => {
      const playbook = {
        name: "Test Playbook",
        description: "A test playbook",
        agents: [
          {
            name: "Agent1",
            role: "master",
            model: "claude-sonnet-4-6",
          },
        ],
      };

      const result = validatePlaybook(playbook);

      expect(result.valid).toBe(true);
      expect(result.errors).toHaveLength(0);
    });

    it("should accept a full-featured playbook", () => {
      const playbook = {
        version: 1,
        name: "Full Stack Team",
        description: "A complete full-stack development team",
        author: "test@example.com",
        tags: ["fullstack", "web"],
        defaults: {
          provider: "claude-code",
          model: "claude-sonnet-4-6",
          worktreeMode: "isolated",
          messagingMode: "mcp",
        },
        variables: {
          project_name: {
            description: "Project name",
            type: "string",
            default: "my-app",
          },
          framework: {
            description: "Frontend framework",
            type: "string",
            options: ["React", "Vue", "Angular"],
          },
        },
        agents: [
          {
            name: "Architect",
            role: "master",
            model: "claude-opus-4-6",
            persona: "builtin:architect",
            channels: ["#all", "#orchestration"],
            extraCliArgs: ["--dangerously-skip-permissions"],
            envVars: { DEBUG: "true" },
            budgetLimit: 5.0,
            initialTask: "Plan the {{project_name}} architecture",
          },
          {
            name: "Frontend",
            role: "worker",
            persona: "You are a frontend developer",
            channels: ["#all", "#frontend"],
          },
        ],
        tasks: [
          {
            title: "Setup project structure",
            description: "Create folders and config files",
            assignedTo: "Architect",
            priority: "P0",
            labels: ["setup"],
            dependencies: [],
          },
        ],
        worktreeMode: "isolated",
        messagingMode: "mcp",
        budget: 20.0,
      };

      const result = validatePlaybook(playbook);

      expect(result.valid).toBe(true);
      expect(result.errors).toHaveLength(0);
    });

    it("should accept playbook with defaults.model and no agent.model", () => {
      const playbook = {
        name: "Test",
        description: "Test",
        defaults: {
          model: "claude-sonnet-4-6",
        },
        agents: [
          {
            name: "Agent1",
            role: "master",
          },
        ],
      };

      const result = validatePlaybook(playbook);

      expect(result.valid).toBe(true);
      expect(result.errors).toHaveLength(0);
    });
  });

  describe("required fields", () => {
    it("should reject playbook without name", () => {
      const playbook = {
        description: "Test",
        agents: [{ name: "Agent1", role: "master", model: "test" }],
      };

      const result = validatePlaybook(playbook);

      expect(result.valid).toBe(false);
      expect(result.errors.some((e) => e.includes("name"))).toBe(true);
    });

    it("should accept playbook without description", () => {
      const playbook = {
        name: "Test",
        agents: [{ name: "Agent1", role: "master", model: "test" }],
      };

      const result = validatePlaybook(playbook);

      expect(result.valid).toBe(true);
      expect(result.errors).toHaveLength(0);
    });

    it("should reject playbook without agents", () => {
      const playbook = {
        name: "Test",
        description: "Test",
        agents: [],
      };

      const result = validatePlaybook(playbook);

      expect(result.valid).toBe(false);
      expect(result.errors.some((e) => e.includes("agent"))).toBe(true);
    });

    it("should reject agent without name", () => {
      const playbook = {
        name: "Test",
        description: "Test",
        agents: [{ role: "master", model: "test" }],
      };

      const result = validatePlaybook(playbook);

      expect(result.valid).toBe(false);
      expect(result.errors.some((e) => e.includes("name"))).toBe(true);
    });

    it("should reject agent without role", () => {
      const playbook = {
        name: "Test",
        description: "Test",
        agents: [{ name: "Agent1", model: "test" }],
      };

      const result = validatePlaybook(playbook);

      expect(result.valid).toBe(false);
      expect(result.errors.some((e) => e.includes("role"))).toBe(true);
    });
  });

  describe("agent role validation", () => {
    it("should reject invalid role", () => {
      const playbook = {
        name: "Test",
        description: "Test",
        agents: [{ name: "Agent1", role: "invalid", model: "test" }],
      };

      const result = validatePlaybook(playbook);

      expect(result.valid).toBe(false);
      expect(result.errors.some((e) => e.includes("master") || e.includes("worker"))).toBe(true);
    });

    it("should error when no master agent exists", () => {
      const playbook = {
        name: "Test",
        description: "Test",
        agents: [
          { name: "Worker1", role: "worker", model: "test" },
          { name: "Worker2", role: "worker", model: "test" },
        ],
      };

      const result = validatePlaybook(playbook);

      expect(result.valid).toBe(false);
      expect(result.errors.some((e) => e.includes("master"))).toBe(true);
    });

    it("should warn when multiple master agents exist", () => {
      const playbook = {
        name: "Test",
        description: "Test",
        agents: [
          { name: "Master1", role: "master", model: "test" },
          { name: "Master2", role: "master", model: "test" },
        ],
      };

      const result = validatePlaybook(playbook);

      expect(result.valid).toBe(true);
      expect(result.warnings.some((w) => w.includes("Multiple master"))).toBe(true);
    });
  });

  describe("agent model validation", () => {
    it("should error when agent has no model and no defaults.model", () => {
      const playbook = {
        name: "Test",
        description: "Test",
        agents: [{ name: "Agent1", role: "master" }],
      };

      const result = validatePlaybook(playbook);

      expect(result.valid).toBe(false);
      expect(result.errors.some((e) => e.includes("model"))).toBe(true);
    });

    it("should accept agent without model when defaults.model exists", () => {
      const playbook = {
        name: "Test",
        description: "Test",
        defaults: { model: "claude-sonnet-4-6" },
        agents: [{ name: "Agent1", role: "master" }],
      };

      const result = validatePlaybook(playbook);

      expect(result.valid).toBe(true);
      expect(result.errors).toHaveLength(0);
    });

    it("should error when agent has empty string model and no defaults.model", () => {
      const playbook = {
        name: "Test",
        description: "Test",
        agents: [{ name: "Agent1", role: "master", model: "" }],
      };

      const result = validatePlaybook(playbook);

      expect(result.valid).toBe(false);
      expect(result.errors.some((e) => e.includes("model"))).toBe(true);
    });

    it("should error when defaults.model is empty string", () => {
      const playbook = {
        name: "Test",
        description: "Test",
        defaults: { model: "" },
        agents: [{ name: "Agent1", role: "master" }],
      };

      const result = validatePlaybook(playbook);

      expect(result.valid).toBe(false);
      expect(result.errors.some((e) => e.includes("model"))).toBe(true);
    });
  });

  describe("agent name uniqueness", () => {
    it("should error when duplicate agent names exist", () => {
      const playbook = {
        name: "Test",
        description: "Test",
        agents: [
          { name: "Agent1", role: "master", model: "test" },
          { name: "Agent1", role: "worker", model: "test" },
        ],
      };

      const result = validatePlaybook(playbook);

      expect(result.valid).toBe(false);
      expect(result.errors.some((e) => e.includes("Duplicate"))).toBe(true);
    });
  });

  describe("variable validation", () => {
    it("should accept valid variable definitions", () => {
      const playbook = {
        name: "Test",
        description: "Test",
        variables: {
          project_name: {
            description: "Project name",
            type: "string",
            default: "my-app",
          },
          framework: {
            description: "Framework",
            options: ["React", "Vue"],
          },
        },
        agents: [{ name: "Agent1", role: "master", model: "test" }],
      };

      const result = validatePlaybook(playbook);

      expect(result.valid).toBe(true);
      expect(result.errors).toHaveLength(0);
    });

    it("should warn when undeclared variable is used", () => {
      const playbook = {
        name: "Test",
        description: "Test",
        agents: [
          {
            name: "Agent1",
            role: "master",
            model: "test",
            persona: "Build {{project_name}} using {{framework}}",
          },
        ],
      };

      const result = validatePlaybook(playbook);

      expect(result.valid).toBe(true);
      expect(result.warnings.some((w) => w.includes("project_name"))).toBe(true);
      expect(result.warnings.some((w) => w.includes("framework"))).toBe(true);
    });

    it("should not warn when declared variable is used", () => {
      const playbook = {
        name: "Test",
        description: "Test",
        variables: {
          project_name: {
            description: "Project name",
            default: "my-app",
          },
        },
        agents: [
          {
            name: "Agent1",
            role: "master",
            model: "test",
            persona: "Build {{project_name}}",
          },
        ],
      };

      const result = validatePlaybook(playbook);

      expect(result.valid).toBe(true);
      expect(result.warnings.some((w) => w.includes("project_name"))).toBe(false);
    });
  });

  describe("task validation", () => {
    it("should accept valid tasks", () => {
      const playbook = {
        name: "Test",
        description: "Test",
        agents: [{ name: "Agent1", role: "master", model: "test" }],
        tasks: [
          {
            title: "Task 1",
            description: "Do something",
            assignedTo: "Agent1",
            priority: "P0",
            labels: ["urgent"],
            dependencies: [],
          },
        ],
      };

      const result = validatePlaybook(playbook);

      expect(result.valid).toBe(true);
      expect(result.errors).toHaveLength(0);
    });

    it("should warn when task assigned to non-existent agent", () => {
      const playbook = {
        name: "Test",
        description: "Test",
        agents: [{ name: "Agent1", role: "master", model: "test" }],
        tasks: [
          {
            title: "Task 1",
            assignedTo: "NonExistentAgent",
          },
        ],
      };

      const result = validatePlaybook(playbook);

      expect(result.valid).toBe(true);
      expect(result.warnings.some((w) => w.includes("NonExistentAgent"))).toBe(true);
    });
  });

  describe("enum validation", () => {
    it("should reject invalid defaults.provider", () => {
      const playbook = {
        name: "Test",
        description: "Test",
        defaults: {
          provider: "invalid-provider",
        },
        agents: [{ name: "Agent1", role: "master", model: "test" }],
      };

      const result = validatePlaybook(playbook);

      expect(result.valid).toBe(false);
      expect(result.errors.some((e) => e.includes("provider"))).toBe(true);
    });

    it("should reject invalid defaults.worktreeMode", () => {
      const playbook = {
        name: "Test",
        description: "Test",
        defaults: {
          worktreeMode: "invalid",
        },
        agents: [{ name: "Agent1", role: "master", model: "test" }],
      };

      const result = validatePlaybook(playbook);

      expect(result.valid).toBe(false);
      expect(result.errors.some((e) => e.includes("worktreeMode"))).toBe(true);
    });

    it("should reject invalid task priority", () => {
      const playbook = {
        name: "Test",
        description: "Test",
        agents: [{ name: "Agent1", role: "master", model: "test" }],
        tasks: [
          {
            title: "Task 1",
            priority: "P5",
          },
        ],
      };

      const result = validatePlaybook(playbook);

      expect(result.valid).toBe(false);
      expect(result.errors.some((e) => e.includes("priority"))).toBe(true);
    });
  });

  describe("channel pattern validation", () => {
    it("should accept valid channel names", () => {
      const playbook = {
        name: "Test",
        description: "Test",
        agents: [
          {
            name: "Agent1",
            role: "master",
            model: "test",
            channels: ["#all", "#frontend", "#backend-api"],
          },
        ],
      };

      const result = validatePlaybook(playbook);

      expect(result.valid).toBe(true);
      expect(result.errors).toHaveLength(0);
    });

    it("should reject invalid channel names", () => {
      const playbook = {
        name: "Test",
        description: "Test",
        agents: [
          {
            name: "Agent1",
            role: "master",
            model: "test",
            channels: ["invalid", "#UPPERCASE"],
          },
        ],
      };

      const result = validatePlaybook(playbook);

      expect(result.valid).toBe(false);
      expect(result.errors.length).toBeGreaterThan(0);
    });
  });

  describe("additional properties", () => {
    it("should reject unknown properties at root level", () => {
      const playbook = {
        name: "Test",
        description: "Test",
        agents: [{ name: "Agent1", role: "master", model: "test" }],
        unknownField: "value",
      };

      const result = validatePlaybook(playbook);

      expect(result.valid).toBe(false);
      expect(result.errors.some((e) => e.includes("unknownField"))).toBe(true);
    });

    it("should reject unknown properties in agent", () => {
      const playbook = {
        name: "Test",
        description: "Test",
        agents: [
          {
            name: "Agent1",
            role: "master",
            model: "test",
            unknownField: "value",
          },
        ],
      };

      const result = validatePlaybook(playbook);

      expect(result.valid).toBe(false);
      expect(result.errors.some((e) => e.includes("unknownField"))).toBe(true);
    });
  });
});
