/**
 * Tests for boot-prompt-builder.ts — role-specific guardrails in system prompt.
 */
import { describe, it, expect } from "vitest";
import { buildBootPrompt, BootPromptOptions } from "../../core/boot-prompt-builder.js";

// ── Backward Compatibility ──────────────────────────────

describe("buildBootPrompt — backward compatibility", () => {
  it("accepts string messaging mode (old API)", () => {
    const prompt = buildBootPrompt("mcp");
    expect(prompt).toContain("get_context");
    expect(prompt).toContain("NEVER read .kora/ files");
  });

  it("accepts no arguments (defaults to MCP)", () => {
    const prompt = buildBootPrompt();
    expect(prompt).toContain("get_context");
  });

  it("CLI mode works with string arg", () => {
    const prompt = buildBootPrompt("cli");
    expect(prompt).toContain("kora-cli context all");
  });

  it("terminal mode works with string arg", () => {
    const prompt = buildBootPrompt("terminal");
    expect(prompt).toContain("@AgentName");
  });
});

// ── Messaging Modes ──────────────────────────────────────

describe("buildBootPrompt — messaging modes", () => {
  it("MCP mode includes core tools", () => {
    const prompt = buildBootPrompt({ messagingMode: "mcp" });
    expect(prompt).toContain("get_context(resource)");
    expect(prompt).toContain("send_message(to, message)");
    expect(prompt).toContain("check_messages()");
    expect(prompt).toContain("list_tasks()");
    expect(prompt).toContain("update_task(taskId, status, comment)");
  });

  it("CLI mode includes kora-cli commands", () => {
    const prompt = buildBootPrompt({ messagingMode: "cli" });
    expect(prompt).toContain("kora-cli context all");
    expect(prompt).toContain("kora-cli send");
    expect(prompt).toContain("kora-cli messages");
    expect(prompt).toContain("kora-cli tasks");
  });

  it("terminal mode includes @mention instructions", () => {
    const prompt = buildBootPrompt({ messagingMode: "terminal" });
    expect(prompt).toContain("@AgentName");
    expect(prompt).toContain("@all");
  });

  it("all modes include NEVER rules", () => {
    for (const mode of ["mcp", "cli", "terminal"] as const) {
      const prompt = buildBootPrompt({ messagingMode: mode });
      expect(prompt).toContain("NEVER read .kora/ files");
    }
  });
});

// ── Role Identity ──────────────────────────────────────

describe("buildBootPrompt — role identity", () => {
  it("includes agent name and role when provided", () => {
    const prompt = buildBootPrompt({
      agentName: "Dev 1",
      agentRole: "worker",
      sessionName: "my-session",
    });
    expect(prompt).toContain("You are Dev 1");
    expect(prompt).toContain("worker");
    expect(prompt).toContain('session "my-session"');
  });

  it("includes display roleName when provided", () => {
    const prompt = buildBootPrompt({
      agentName: "Alice",
      agentRole: "worker",
      roleName: "Product Manager",
    });
    expect(prompt).toContain("Product Manager");
  });

  it("omits identity when no agent info provided", () => {
    const prompt = buildBootPrompt({ messagingMode: "mcp" });
    expect(prompt).not.toContain("Your role:");
  });
});

// ── Role-Specific Constraints ──────────────────────────

describe("buildBootPrompt — role-specific constraints", () => {
  it("master gets coordinator constraint", () => {
    const prompt = buildBootPrompt({ agentName: "Arch", agentRole: "master" });
    expect(prompt).toContain("COORDINATOR ONLY");
    expect(prompt).toContain("NEVER write code");
    expect(prompt).toContain("Delegate ALL implementation");
  });

  it("worker gets implementer constraint", () => {
    const prompt = buildBootPrompt({ agentName: "Dev", agentRole: "worker" });
    expect(prompt).toContain("IMPLEMENTER");
    expect(prompt).toContain("STOP immediately");
  });

  it("Product Manager gets PM-specific constraint", () => {
    const prompt = buildBootPrompt({ agentName: "PM", agentRole: "worker", roleName: "Product Manager" });
    expect(prompt).toContain("Define requirements");
    expect(prompt).toContain("Do NOT write implementation code");
  });

  it("Reviewer gets review-specific constraint", () => {
    const prompt = buildBootPrompt({ agentName: "Rev", agentRole: "worker", roleName: "Reviewer" });
    expect(prompt).toContain("Review code");
    expect(prompt).toContain("NEVER modify implementation files");
  });

  it("Tester gets test-specific constraint", () => {
    const prompt = buildBootPrompt({ agentName: "QA", agentRole: "worker", roleName: "Tester" });
    expect(prompt).toContain("Write and run tests");
    expect(prompt).toContain("NEVER write implementation code");
  });

  it("Researcher gets research-specific constraint", () => {
    const prompt = buildBootPrompt({ agentName: "Res", agentRole: "worker", roleName: "Researcher" });
    expect(prompt).toContain("Research, analyze");
    expect(prompt).toContain("NEVER write implementation code");
  });

  it("unknown roleName falls back to agentRole constraint", () => {
    const prompt = buildBootPrompt({ agentName: "Custom", agentRole: "master", roleName: "Custom Role" });
    expect(prompt).toContain("COORDINATOR ONLY"); // Falls back to master
  });

  it("no role info defaults to worker constraint", () => {
    const prompt = buildBootPrompt({ agentName: "Default" });
    expect(prompt).toContain("IMPLEMENTER"); // Default worker
  });
});

// ── Workspace Rules ──────────────────────────────────────

describe("buildBootPrompt — workspace rules", () => {
  it("shared workspace includes file-safety rules", () => {
    const prompt = buildBootPrompt({ agentName: "Dev", agentRole: "worker", worktreeMode: "shared" });
    expect(prompt).toContain("Shared repo");
    expect(prompt).toContain("ONLY edit files assigned");
    expect(prompt).toContain("NEVER force-push");
  });

  it("isolated workspace includes worktree freedom", () => {
    const prompt = buildBootPrompt({ agentName: "Dev", agentRole: "worker", worktreeMode: "isolated" });
    expect(prompt).toContain("Isolated git worktree");
    expect(prompt).toContain("Work freely");
  });

  it("no workspace mode omits workspace rules", () => {
    const prompt = buildBootPrompt({ agentName: "Dev", agentRole: "worker" });
    expect(prompt).not.toContain("Shared repo");
    expect(prompt).not.toContain("Isolated git worktree");
  });
});

// ── Worker Protocol ──────────────────────────────────────

describe("buildBootPrompt — worker protocol", () => {
  it("worker gets protocol instructions", () => {
    const prompt = buildBootPrompt({ agentName: "Dev", agentRole: "worker" });
    expect(prompt).toContain("PROTOCOL:");
    expect(prompt).toContain("Acknowledge task");
    expect(prompt).toContain("verify_work");
    expect(prompt).toContain("STOP");
  });

  it("master does NOT get worker protocol", () => {
    const prompt = buildBootPrompt({ agentName: "Arch", agentRole: "master" });
    expect(prompt).not.toContain("PROTOCOL:");
  });
});

// ── Pipeline Rules ──────────────────────────────────────

describe("buildBootPrompt — pipeline rules", () => {
  it("includes pipeline when states provided", () => {
    const prompt = buildBootPrompt({
      agentName: "Dev",
      agentRole: "worker",
      pipelineStates: ["backlog", "in-progress", "review", "done"],
    });
    expect(prompt).toContain("PIPELINE: backlog → in-progress → review → done");
    expect(prompt).toContain("MUST follow allowed transitions");
    expect(prompt).toContain("NEXT state");
  });

  it("omits pipeline when no states provided", () => {
    const prompt = buildBootPrompt({ agentName: "Dev", agentRole: "worker" });
    expect(prompt).not.toContain("PIPELINE:");
  });

  it("omits pipeline when empty array", () => {
    const prompt = buildBootPrompt({ agentName: "Dev", agentRole: "worker", pipelineStates: [] });
    expect(prompt).not.toContain("PIPELINE:");
  });
});

// ── Project Rules (.kora.yml) ────────────────────────────

describe("buildBootPrompt — project rules", () => {
  it("includes rules when provided", () => {
    const prompt = buildBootPrompt({
      agentName: "Dev",
      agentRole: "worker",
      rules: ["No Co-Authored-By in commits", "Run make check before pushing"],
    });
    expect(prompt).toContain("PROJECT RULES:");
    expect(prompt).toContain("No Co-Authored-By in commits");
    expect(prompt).toContain("Run make check before pushing");
  });

  it("omits rules when not provided", () => {
    const prompt = buildBootPrompt({ agentName: "Dev", agentRole: "worker" });
    expect(prompt).not.toContain("PROJECT RULES:");
  });

  it("omits rules when empty array", () => {
    const prompt = buildBootPrompt({ agentName: "Dev", agentRole: "worker", rules: [] });
    expect(prompt).not.toContain("PROJECT RULES:");
  });
});

// ── Size Constraint ──────────────────────────────────────

describe("buildBootPrompt — size constraints", () => {
  it("stays under 3KB for a fully-loaded worker prompt", () => {
    const prompt = buildBootPrompt({
      messagingMode: "mcp",
      agentName: "Dev 1c",
      agentRole: "worker",
      roleName: "Tester",
      worktreeMode: "isolated",
      sessionName: "two-pizza-team",
      pipelineStates: ["backlog", "in-progress", "review", "testing", "staging", "done"],
      rules: [
        "No Co-Authored-By in commits",
        "Run make check before pushing",
        "Always use Make commands — never raw npm/node",
        "Do NOT touch production directory",
      ],
    });
    expect(prompt.length).toBeLessThan(3072); // 3KB
  });

  it("stays under 3KB for a fully-loaded master prompt", () => {
    const prompt = buildBootPrompt({
      messagingMode: "mcp",
      agentName: "Engineering Manager",
      agentRole: "master",
      roleName: "master",
      worktreeMode: "shared",
      sessionName: "two-pizza-team",
      pipelineStates: ["backlog", "in-progress", "review", "testing", "staging", "done"],
      rules: ["Coordinate all agents", "Review before merge", "No force-push to main"],
    });
    expect(prompt.length).toBeLessThan(3072);
  });
});

// ── Full Integration ──────────────────────────────────────

describe("buildBootPrompt — full integration", () => {
  it("produces correct structure for a worker in MCP mode", () => {
    const prompt = buildBootPrompt({
      messagingMode: "mcp",
      agentName: "Dev 2",
      agentRole: "worker",
      roleName: "worker",
      worktreeMode: "isolated",
      sessionName: "sprint-5",
      pipelineStates: ["pending", "in-progress", "review", "done"],
      rules: ["No secrets in commits"],
    });

    // Order: Kora intro → identity → guardrails → tools → rules
    const introIdx = prompt.indexOf("Kora agent");
    const identityIdx = prompt.indexOf("You are Dev 2");
    const constraintIdx = prompt.indexOf("ROLE CONSTRAINT:");
    const pipelineIdx = prompt.indexOf("PIPELINE:");
    const projectRulesIdx = prompt.indexOf("PROJECT RULES:");
    const protocolIdx = prompt.indexOf("PROTOCOL:");
    const toolsIdx = prompt.indexOf("Core tools:");
    const neverIdx = prompt.indexOf("NEVER read .kora/");

    expect(introIdx).toBeGreaterThanOrEqual(0);
    expect(identityIdx).toBeGreaterThan(introIdx);
    expect(constraintIdx).toBeGreaterThan(identityIdx);
    expect(pipelineIdx).toBeGreaterThan(constraintIdx);
    expect(projectRulesIdx).toBeGreaterThan(pipelineIdx);
    expect(protocolIdx).toBeGreaterThan(projectRulesIdx);
    expect(toolsIdx).toBeGreaterThan(protocolIdx);
    expect(neverIdx).toBeGreaterThan(toolsIdx);
  });
});
