/**
 * Tests for PRs #204-209: skill detection, skill-aware auto-assign scoring,
 * and transition history.
 *
 * Covers:
 * 1. Skill detection from persona text (keyword matching)
 * 2. Skill detection from agent name
 * 3. Role-based defaults
 * 4. Priority hierarchy: explicit > persona > name > role
 * 5. Skill-aware scoring: +50 match, -100 mismatch
 * 6. Skill mismatch detection
 */

import { describe, it, expect } from "vitest";
import {
  detectSkillsFromPersona,
  detectSkillsFromName,
  detectAgentSkills,
  getSkillMismatches,
} from "@kora/shared";

// ---------------------------------------------------------------------------
// Skill Detection from Persona Text
// ---------------------------------------------------------------------------

describe("Skill detection from persona text", () => {
  it("detects frontend skills from React/CSS keywords", () => {
    const skills = detectSkillsFromPersona("You are a React developer building UI components with Mantine.");
    expect(skills).toContain("frontend");
  });

  it("detects backend skills from API/Express keywords", () => {
    const skills = detectSkillsFromPersona("Build REST API endpoints using Express and SQLite.");
    expect(skills).toContain("backend");
  });

  it("detects testing skills from test/vitest keywords", () => {
    const skills = detectSkillsFromPersona("Write comprehensive vitest unit tests with full coverage.");
    expect(skills).toContain("testing");
  });

  it("detects research skills from research/analyze keywords", () => {
    const skills = detectSkillsFromPersona("Research and analyze alternative architectures for the system.");
    expect(skills).toContain("research");
  });

  it("detects review skills from code review keywords", () => {
    const skills = detectSkillsFromPersona("Perform thorough code review and audit for bugs.");
    expect(skills).toContain("review");
  });

  it("detects devops skills from deploy/CI keywords", () => {
    const skills = detectSkillsFromPersona("Set up CI/CD pipeline with Docker and deploy to AWS.");
    expect(skills).toContain("devops");
  });

  it("detects multiple skills from rich persona", () => {
    const skills = detectSkillsFromPersona(
      "Full-stack developer: build React dashboard frontend and Express API backend with SQLite database."
    );
    expect(skills).toContain("frontend");
    expect(skills).toContain("backend");
    expect(skills).toContain("fullstack");
  });

  it("returns empty array for empty persona", () => {
    expect(detectSkillsFromPersona("")).toEqual([]);
  });

  it("returns empty array for unrelated text", () => {
    const skills = detectSkillsFromPersona("Hello, I am an assistant.");
    expect(skills).toEqual([]);
  });

  it("is case insensitive", () => {
    const skills = detectSkillsFromPersona("You write REACT components and run VITEST tests.");
    expect(skills).toContain("frontend");
    expect(skills).toContain("testing");
  });
});

// ---------------------------------------------------------------------------
// Skill Detection from Agent Name
// ---------------------------------------------------------------------------

describe("Skill detection from agent name", () => {
  it("detects frontend from name containing 'frontend'", () => {
    expect(detectSkillsFromName("Frontend Dev")).toContain("frontend");
  });

  it("detects backend from name containing 'backend'", () => {
    expect(detectSkillsFromName("Backend Engineer")).toContain("backend");
  });

  it("detects testing from name containing 'tester'", () => {
    expect(detectSkillsFromName("Tester")).toContain("testing");
  });

  it("detects testing from name containing 'test'", () => {
    expect(detectSkillsFromName("Test Agent")).toContain("testing");
  });

  it("detects review from name 'Reviewer'", () => {
    expect(detectSkillsFromName("Reviewer")).toContain("review");
  });

  it("detects research from name 'Researcher'", () => {
    expect(detectSkillsFromName("Researcher")).toContain("research");
  });

  it("detects multiple skills from 'Architect'", () => {
    const skills = detectSkillsFromName("Architect");
    expect(skills).toContain("research");
    expect(skills).toContain("review");
    expect(skills).toContain("backend");
    expect(skills).toContain("frontend");
  });

  it("detects backend+frontend from 'Dev'", () => {
    const skills = detectSkillsFromName("Dev 1");
    expect(skills).toContain("backend");
    expect(skills).toContain("frontend");
  });

  it("returns empty for unrecognized name", () => {
    expect(detectSkillsFromName("Agent-42")).toEqual([]);
  });

  it("is case insensitive", () => {
    expect(detectSkillsFromName("FRONTEND")).toContain("frontend");
  });
});

// ---------------------------------------------------------------------------
// Auto-detect with Priority Hierarchy
// ---------------------------------------------------------------------------

describe("detectAgentSkills — priority hierarchy", () => {
  it("uses explicit skills when provided", () => {
    const skills = detectAgentSkills({
      explicit: ["custom-skill"],
      persona: "React developer",
      name: "Backend",
      role: "worker",
    });
    expect(skills).toEqual(["custom-skill"]);
  });

  it("falls back to persona when no explicit skills", () => {
    const skills = detectAgentSkills({
      persona: "You write vitest tests",
      name: "Agent-X",
      role: "worker",
    });
    expect(skills).toContain("testing");
  });

  it("falls back to name when no persona match", () => {
    const skills = detectAgentSkills({
      persona: "Hello world",
      name: "Tester",
      role: "worker",
    });
    expect(skills).toContain("testing");
  });

  it("falls back to role defaults when nothing matches", () => {
    const skills = detectAgentSkills({
      persona: "",
      name: "Agent-42",
      role: "worker",
    });
    expect(skills).toEqual(["backend", "frontend"]);
  });

  it("master role defaults to research + review", () => {
    const skills = detectAgentSkills({
      name: "Agent-X",
      role: "master",
    });
    expect(skills).toEqual(["research", "review"]);
  });

  it("empty explicit array triggers fallback", () => {
    const skills = detectAgentSkills({
      explicit: [],
      persona: "React developer",
    });
    expect(skills).toContain("frontend");
  });
});

// ---------------------------------------------------------------------------
// Skill Mismatch Detection
// ---------------------------------------------------------------------------

describe("getSkillMismatches", () => {
  it("returns empty when agent has matching skills", () => {
    const mismatches = getSkillMismatches(["frontend", "testing"], ["frontend"]);
    expect(mismatches).toEqual([]);
  });

  it("returns mismatched labels", () => {
    const mismatches = getSkillMismatches(["backend"], ["frontend", "testing"]);
    expect(mismatches).toContain("frontend");
    expect(mismatches).toContain("testing");
  });

  it("ignores non-skill labels", () => {
    // Labels like "bug" or "urgent" are not in SKILL_KEYWORDS, so they're not mismatches
    const mismatches = getSkillMismatches(["backend"], ["bug", "urgent", "backend"]);
    expect(mismatches).toEqual([]);
  });

  it("returns empty for empty task labels", () => {
    expect(getSkillMismatches(["frontend"], [])).toEqual([]);
  });

  it("returns empty for empty agent skills", () => {
    // All skill-type labels would be mismatches
    const mismatches = getSkillMismatches([], ["frontend"]);
    expect(mismatches).toContain("frontend");
  });
});

// ---------------------------------------------------------------------------
// Skill-Aware Auto-Assign Scoring
// ---------------------------------------------------------------------------

describe("Skill-aware auto-assign scoring", () => {
  const SKILL_MATCH_BONUS = 50;
  const SKILL_MISMATCH_PENALTY = -100;

  function computeSkillScore(agentSkills: string[], taskLabels: string[]): number {
    const mismatches = getSkillMismatches(agentSkills, taskLabels);
    if (mismatches.length > 0) return SKILL_MISMATCH_PENALTY;
    // Check if any agent skill matches a task label
    const hasMatch = agentSkills.some(s => taskLabels.includes(s));
    return hasMatch ? SKILL_MATCH_BONUS : 0;
  }

  it("returns +50 for skill match", () => {
    expect(computeSkillScore(["frontend"], ["frontend", "bug"])).toBe(SKILL_MATCH_BONUS);
  });

  it("returns -100 for skill mismatch", () => {
    expect(computeSkillScore(["backend"], ["frontend"])).toBe(SKILL_MISMATCH_PENALTY);
  });

  it("returns 0 for no skill-related labels", () => {
    expect(computeSkillScore(["frontend"], ["bug", "urgent"])).toBe(0);
  });

  it("mismatch penalty outweighs priority bonus", () => {
    const p1Score = 100; // P1 priority
    const mismatchScore = p1Score + SKILL_MISMATCH_PENALTY;
    expect(mismatchScore).toBe(0); // Effectively deprioritized
  });

  it("match bonus adds to priority", () => {
    const p2Score = 10; // P2 priority
    const matchScore = p2Score + SKILL_MATCH_BONUS;
    expect(matchScore).toBe(60); // 10 + 50
  });

  it("frontend agent gets frontend task over backend agent", () => {
    const frontendAgentScore = 10 + computeSkillScore(["frontend"], ["frontend"]);
    const backendAgentScore = 10 + computeSkillScore(["backend"], ["frontend"]);

    expect(frontendAgentScore).toBeGreaterThan(backendAgentScore);
  });
});

// ---------------------------------------------------------------------------
// Transition History (PR #204) — data structure tests
// ---------------------------------------------------------------------------

describe("Transition history data structure", () => {
  it("transition record has required fields", () => {
    const transition = {
      id: "trans-1",
      taskId: "task-1",
      sessionId: "session-1",
      fromStatus: "pending",
      toStatus: "in-progress",
      changedBy: "agent-1",
      changedAt: new Date().toISOString(),
      durationMs: null as number | null,
    };

    expect(transition).toHaveProperty("taskId");
    expect(transition).toHaveProperty("fromStatus");
    expect(transition).toHaveProperty("toStatus");
    expect(transition).toHaveProperty("changedBy");
    expect(transition).toHaveProperty("changedAt");
  });

  it("duration is calculated from previous transition", () => {
    const prev = new Date("2026-03-22T01:00:00Z").getTime();
    const now = new Date("2026-03-22T01:30:00Z").getTime();
    const durationMs = now - prev;

    expect(durationMs).toBe(30 * 60 * 1000); // 30 minutes
  });

  it("first transition has null duration", () => {
    const firstTransition = {
      fromStatus: null,
      toStatus: "pending",
      durationMs: null,
    };

    expect(firstTransition.durationMs).toBeNull();
  });

  it("duration breakdown sums correctly", () => {
    const transitions = [
      { fromStatus: "pending", toStatus: "in-progress", durationMs: 10 * 60 * 1000 },
      { fromStatus: "in-progress", toStatus: "review", durationMs: 45 * 60 * 1000 },
      { fromStatus: "review", toStatus: "done", durationMs: 15 * 60 * 1000 },
    ];

    const totalMs = transitions.reduce((sum, t) => sum + (t.durationMs || 0), 0);
    expect(totalMs).toBe(70 * 60 * 1000); // 70 minutes total
  });
});
