/**
 * Unit tests for PersonaBuilder — system prompt generation.
 *
 * Tests: builtin persona resolution, user persona injection, team section,
 * communication protocol, control plane, role-specific instructions,
 * knowledge entries, rules, and section ordering.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";

// Mock context-discovery to avoid filesystem access
vi.mock("../context-discovery.js", () => ({
  discoverContextFiles: vi.fn().mockReturnValue([]),
  readKnowledgeEntries: vi.fn().mockReturnValue([]),
}));

// Mock builtin-personas
vi.mock("../builtin-personas.js", () => ({
  resolveBuiltinPersona: vi.fn((key: string) => {
    if (key === "builtin:frontend") {
      return { name: "Frontend Developer", identity: "You are a frontend dev", goal: "Build UI", constraints: ["Use React"], scopeDo: ["Components"], scopeDoNot: ["Backend"] };
    }
    return null;
  }),
  renderPersonaTemplate: vi.fn((template: any, overrides?: any) => {
    let result = `## ${template.name}\n${template.identity}\n## Goal\n${template.goal}`;
    if (template.constraints?.length) {
      result += `\n## Constraints\n${template.constraints.map((c: string) => `- ${c}`).join("\n")}`;
    }
    if (overrides?.constraints?.length) {
      result += `\n${overrides.constraints.map((c: string) => `- ${c}`).join("\n")}`;
    }
    return result;
  }),
}));

import { buildPersona, type PersonaBuildOptions } from "../persona-builder.js";
import { discoverContextFiles, readKnowledgeEntries } from "../context-discovery.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function defaultOptions(overrides: Partial<PersonaBuildOptions> = {}): PersonaBuildOptions {
  return {
    agentId: "test-agent-123",
    role: "worker",
    permissions: {
      canSpawnAgents: false,
      canStopAgents: false,
      canRemoveAgents: false,
      canAccessTerminal: true,
      canEditFiles: true,
      maxSubAgents: 0,
    },
    sessionId: "test-session",
    runtimeDir: ".kora",
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("PersonaBuilder", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe("user persona", () => {
    it("includes raw user persona text", () => {
      const result = buildPersona(defaultOptions({
        userPersona: "You are a database specialist. Focus on SQL optimization.",
      }));

      expect(result).toContain("You are a database specialist");
      expect(result).toContain("SQL optimization");
    });

    it("trims whitespace from user persona", () => {
      const result = buildPersona(defaultOptions({
        userPersona: "  \n  Hello world  \n  ",
      }));

      expect(result).toContain("Hello world");
      // Should not start with whitespace in the persona section
      expect(result).not.toMatch(/^\s+Hello/m);
    });

    it("skips empty user persona", () => {
      const result = buildPersona(defaultOptions({
        userPersona: "   ",
      }));

      // Should still have communication protocol
      expect(result).toContain("Communication Protocol");
      // Should not have empty sections
      expect(result).not.toContain("\n\n\n\n");
    });
  });

  describe("builtin personas", () => {
    it("resolves builtin:frontend persona template", () => {
      const result = buildPersona(defaultOptions({
        userPersona: "builtin:frontend",
      }));

      expect(result).toContain("Frontend Developer");
      expect(result).toContain("You are a frontend dev");
      expect(result).toContain("Build UI");
    });

    it("falls back to raw text for unknown builtin", () => {
      const result = buildPersona(defaultOptions({
        userPersona: "builtin:nonexistent",
      }));

      expect(result).toContain("builtin:nonexistent");
    });

    it("applies persona overrides to template", () => {
      const result = buildPersona(defaultOptions({
        userPersona: "builtin:frontend",
        personaOverrides: {
          constraints: ["Never use jQuery"],
        },
      }));

      expect(result).toContain("Never use jQuery");
    });
  });

  describe("team section", () => {
    it("includes peer agents in a markdown table", () => {
      const result = buildPersona(defaultOptions({
        peers: [
          { id: "agent-1", name: "Architect", role: "master", provider: "claude-code", model: "default" },
          { id: "agent-2", name: "Backend", role: "worker", provider: "claude-code", model: "default" },
        ],
      }));

      expect(result).toContain("## Your Team");
      expect(result).toContain("| Architect | master | agent-1 |");
      expect(result).toContain("| Backend | worker | agent-2 |");
      expect(result).toContain("`test-agent-123`"); // Self ID
    });

    it("includes @mention fallback instructions per peer", () => {
      const result = buildPersona(defaultOptions({
        peers: [
          { id: "agent-1", name: "Frontend", role: "worker", provider: "claude-code", model: "default" },
        ],
      }));

      expect(result).toContain("@Frontend: your message here");
      expect(result).toContain("@all: broadcast to everyone");
    });

    it("includes MCP tool instructions", () => {
      const result = buildPersona(defaultOptions({
        peers: [
          { id: "agent-1", name: "Test", role: "worker", provider: "claude-code", model: "default" },
        ],
      }));

      expect(result).toContain("`send_message(to, message)`");
      expect(result).toContain("`check_messages()`");
      expect(result).toContain("`list_agents()`");
      expect(result).toContain("`broadcast(message)`");
    });

    it("skips team section when no peers", () => {
      const result = buildPersona(defaultOptions());

      expect(result).not.toContain("## Your Team");
    });
  });

  describe("communication protocol", () => {
    it("always includes communication protocol", () => {
      const result = buildPersona(defaultOptions());

      expect(result).toContain("## Communication Protocol");
      expect(result).toContain("send_message");
      expect(result).toContain("check_messages");
      expect(result).toContain("file-based messaging");
    });

    it("includes agent-specific inbox path", () => {
      const result = buildPersona(defaultOptions({ agentId: "my-agent-xyz" }));

      expect(result).toContain("inbox-my-agent-xyz/");
      expect(result).toContain("outbox-my-agent-xyz/");
    });
  });

  describe("control plane", () => {
    it("includes control plane for agents with spawn permission", () => {
      const result = buildPersona(defaultOptions({
        permissions: {
          canSpawnAgents: true,
          canStopAgents: false,
          canRemoveAgents: false,
          canAccessTerminal: true,
          canEditFiles: true,
          maxSubAgents: 5,
        },
      }));

      expect(result).toContain("Agent Management (Control Plane)");
      expect(result).toContain("spawn_agent");
      expect(result).toContain("Maximum 5 sub-agents");
    });

    it("includes remove instructions for agents with remove permission", () => {
      const result = buildPersona(defaultOptions({
        permissions: {
          canSpawnAgents: false,
          canStopAgents: false,
          canRemoveAgents: true,
          canAccessTerminal: true,
          canEditFiles: true,
          maxSubAgents: 0,
        },
      }));

      expect(result).toContain("remove-agent");
    });

    it("skips control plane for basic workers", () => {
      const result = buildPersona(defaultOptions());

      expect(result).not.toContain("Agent Management (Control Plane)");
    });
  });

  describe("role-specific instructions", () => {
    it("includes master orchestrator protocol for master role", () => {
      const result = buildPersona(defaultOptions({ role: "master" }));

      expect(result).toContain("Master Orchestrator Protocol");
      expect(result).toContain("COORDINATOR ONLY");
      expect(result).toContain("MUST NOT write code");
    });

    it("includes worker protocol for worker role", () => {
      const result = buildPersona(defaultOptions({ role: "worker" }));

      expect(result).toContain("Worker Protocol");
      expect(result).toContain("update_task");
      expect(result).toContain("Standing by");
    });
  });

  describe("knowledge and rules", () => {
    it("includes knowledge entries", () => {
      const result = buildPersona(defaultOptions({
        knowledgeEntries: [
          "API uses Express 5 with path-to-regexp v8",
          "Database is SQLite with WAL mode",
        ],
      }));

      expect(result).toContain("## Project Knowledge");
      expect(result).toContain("- API uses Express 5");
      expect(result).toContain("- Database is SQLite");
    });

    it("includes rules", () => {
      const result = buildPersona(defaultOptions({
        rules: [
          "Never push directly to main",
          "Always rebase before PR",
        ],
      }));

      expect(result).toContain("## Rules");
      expect(result).toContain("- Never push directly to main");
      expect(result).toContain("- Always rebase before PR");
    });
  });

  describe("context files", () => {
    it("includes pre-loaded context files", () => {
      const result = buildPersona(defaultOptions({
        contextFiles: [
          { name: "README.md", content: "# My Project\nThis is a cool project." },
        ],
      }));

      expect(result).toContain("## Project Context (README.md)");
      expect(result).toContain("This is a cool project");
    });

    it("discovers context files from projectPath when not pre-loaded", () => {
      (discoverContextFiles as any).mockReturnValueOnce([
        { name: "CLAUDE_CONTEXT.md", content: "Auto-discovered context" },
      ]);

      const result = buildPersona(defaultOptions({
        projectPath: "/projects/myapp",
      }));

      expect(discoverContextFiles).toHaveBeenCalledWith("/projects/myapp");
      expect(result).toContain("Auto-discovered context");
    });

    it("reads persisted knowledge from projectPath", () => {
      (readKnowledgeEntries as any).mockReturnValueOnce([
        "Important: the auth module uses JWT tokens",
      ]);

      const result = buildPersona(defaultOptions({
        projectPath: "/projects/myapp",
      }));

      expect(readKnowledgeEntries).toHaveBeenCalledWith("/projects/myapp");
      expect(result).toContain("Persisted Knowledge");
      expect(result).toContain("auth module uses JWT tokens");
    });
  });

  describe("section ordering", () => {
    it("separates sections with --- dividers", () => {
      const result = buildPersona(defaultOptions({
        userPersona: "Test persona",
        rules: ["Rule 1"],
      }));

      expect(result).toContain("---");
    });

    it("puts communication protocol after user content", () => {
      const result = buildPersona(defaultOptions({
        userPersona: "My persona text",
      }));

      const personaIdx = result.indexOf("My persona text");
      const protocolIdx = result.indexOf("Communication Protocol");

      expect(personaIdx).toBeLessThan(protocolIdx);
    });
  });
});
