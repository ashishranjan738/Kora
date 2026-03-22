/**
 * Tests for PRs #209-214: enriched list_agents, cycle time, skill-aware scoring.
 *
 * Covers:
 * 1. availableForWork computation (idle + no in-progress task + not master)
 * 2. Enriched agent fields (currentTask, activeTasks, skills, pendingMessages)
 * 3. Cycle time duration breakdown
 * 4. Skill-aware scoring with real persona text
 */

import { describe, it, expect } from "vitest";
import {
  detectAgentSkills,
  detectSkillsFromPersona,
  getSkillMismatches,
} from "@kora/shared";

// ---------------------------------------------------------------------------
// availableForWork computation
// ---------------------------------------------------------------------------

describe("availableForWork computation (PR #213)", () => {
  function computeAvailableForWork(agent: {
    activity: string;
    role: string;
    inProgressTask: boolean;
    idleDurationMs: number;
  }): boolean {
    return (
      agent.activity === "idle" &&
      !agent.inProgressTask &&
      agent.role !== "master" &&
      agent.idleDurationMs > 0
    );
  }

  it("idle worker with no task is available", () => {
    expect(computeAvailableForWork({
      activity: "idle",
      role: "worker",
      inProgressTask: false,
      idleDurationMs: 5000,
    })).toBe(true);
  });

  it("working worker is NOT available", () => {
    expect(computeAvailableForWork({
      activity: "working",
      role: "worker",
      inProgressTask: false,
      idleDurationMs: 0,
    })).toBe(false);
  });

  it("idle worker WITH in-progress task is NOT available", () => {
    expect(computeAvailableForWork({
      activity: "idle",
      role: "worker",
      inProgressTask: true,
      idleDurationMs: 5000,
    })).toBe(false);
  });

  it("master agent is NEVER available (even if idle)", () => {
    expect(computeAvailableForWork({
      activity: "idle",
      role: "master",
      inProgressTask: false,
      idleDurationMs: 5000,
    })).toBe(false);
  });

  it("idle worker with zero idle duration is NOT available", () => {
    expect(computeAvailableForWork({
      activity: "idle",
      role: "worker",
      inProgressTask: false,
      idleDurationMs: 0,
    })).toBe(false);
  });

  it("blocked agent is NOT available", () => {
    expect(computeAvailableForWork({
      activity: "blocked",
      role: "worker",
      inProgressTask: false,
      idleDurationMs: 5000,
    })).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Enriched agent response fields
// ---------------------------------------------------------------------------

describe("Enriched list_agents response (PR #213)", () => {
  function enrichAgent(agent: any, tasks: any[]) {
    const inProgressTask = tasks.find(t =>
      (t.assignedTo === agent.id || t.assignedTo === agent.name) && t.status === "in-progress"
    );
    const activeTasks = tasks.filter(t =>
      t.assignedTo === agent.id || t.assignedTo === agent.name
    );

    return {
      name: agent.name,
      id: agent.id,
      role: agent.role,
      status: agent.status,
      activity: agent.activity,
      currentTask: inProgressTask ? inProgressTask.title : null,
      currentTaskId: inProgressTask ? inProgressTask.id : null,
      activeTasks: activeTasks.length,
      skills: agent.skills || [],
      availableForWork: agent.activity === "idle" && !inProgressTask && agent.role !== "master",
    };
  }

  it("includes currentTask when agent has in-progress task", () => {
    const enriched = enrichAgent(
      { id: "w1", name: "Worker", role: "worker", status: "running", activity: "working" },
      [{ id: "t1", title: "Fix login", status: "in-progress", assignedTo: "Worker" }],
    );
    expect(enriched.currentTask).toBe("Fix login");
    expect(enriched.currentTaskId).toBe("t1");
  });

  it("currentTask is null when no in-progress task", () => {
    const enriched = enrichAgent(
      { id: "w1", name: "Worker", role: "worker", status: "running", activity: "idle" },
      [{ id: "t1", title: "Done task", status: "done", assignedTo: "Worker" }],
    );
    expect(enriched.currentTask).toBeNull();
  });

  it("counts active tasks assigned to agent", () => {
    const enriched = enrichAgent(
      { id: "w1", name: "Worker", role: "worker", status: "running", activity: "working" },
      [
        { id: "t1", title: "Task 1", status: "in-progress", assignedTo: "Worker" },
        { id: "t2", title: "Task 2", status: "review", assignedTo: "Worker" },
        { id: "t3", title: "Task 3", status: "pending", assignedTo: "Other" },
      ],
    );
    expect(enriched.activeTasks).toBe(2);
  });

  it("matches by agent ID or name", () => {
    const enriched = enrichAgent(
      { id: "worker-abc123", name: "Dev 1", role: "worker", status: "running", activity: "working" },
      [
        { id: "t1", title: "By ID", status: "in-progress", assignedTo: "worker-abc123" },
        { id: "t2", title: "By Name", status: "review", assignedTo: "Dev 1" },
      ],
    );
    expect(enriched.activeTasks).toBe(2);
  });

  it("includes skills array", () => {
    const enriched = enrichAgent(
      { id: "w1", name: "Tester", role: "worker", status: "running", activity: "idle", skills: ["testing"] },
      [],
    );
    expect(enriched.skills).toEqual(["testing"]);
  });
});

// ---------------------------------------------------------------------------
// Cycle time duration breakdown (PR #210)
// ---------------------------------------------------------------------------

describe("Cycle time duration breakdown (PR #210)", () => {
  interface Transition {
    fromStatus: string | null;
    toStatus: string;
    changedAt: string;
    durationMs: number | null;
  }

  function computeDurations(transitions: { fromStatus: string | null; toStatus: string; changedAt: string }[]): Transition[] {
    return transitions.map((t, i) => ({
      ...t,
      durationMs: i > 0
        ? new Date(t.changedAt).getTime() - new Date(transitions[i - 1].changedAt).getTime()
        : null,
    }));
  }

  function statusDurationBreakdown(transitions: Transition[]): Record<string, number> {
    const breakdown: Record<string, number> = {};
    for (const t of transitions) {
      if (t.fromStatus && t.durationMs && t.durationMs > 0) {
        breakdown[t.fromStatus] = (breakdown[t.fromStatus] || 0) + t.durationMs;
      }
    }
    return breakdown;
  }

  it("computes duration between consecutive transitions", () => {
    const transitions = computeDurations([
      { fromStatus: null, toStatus: "pending", changedAt: "2026-03-22T01:00:00Z" },
      { fromStatus: "pending", toStatus: "in-progress", changedAt: "2026-03-22T01:10:00Z" },
      { fromStatus: "in-progress", toStatus: "review", changedAt: "2026-03-22T02:00:00Z" },
      { fromStatus: "review", toStatus: "done", changedAt: "2026-03-22T02:15:00Z" },
    ]);

    expect(transitions[0].durationMs).toBeNull(); // first transition
    expect(transitions[1].durationMs).toBe(10 * 60 * 1000); // 10 min
    expect(transitions[2].durationMs).toBe(50 * 60 * 1000); // 50 min
    expect(transitions[3].durationMs).toBe(15 * 60 * 1000); // 15 min
  });

  it("produces correct duration breakdown by status", () => {
    const transitions = computeDurations([
      { fromStatus: null, toStatus: "pending", changedAt: "2026-03-22T01:00:00Z" },
      { fromStatus: "pending", toStatus: "in-progress", changedAt: "2026-03-22T01:10:00Z" },
      { fromStatus: "in-progress", toStatus: "review", changedAt: "2026-03-22T02:00:00Z" },
      { fromStatus: "review", toStatus: "done", changedAt: "2026-03-22T02:15:00Z" },
    ]);

    const breakdown = statusDurationBreakdown(transitions);
    expect(breakdown["pending"]).toBe(10 * 60 * 1000);
    expect(breakdown["in-progress"]).toBe(50 * 60 * 1000);
    expect(breakdown["review"]).toBe(15 * 60 * 1000);
    expect(breakdown["done"]).toBeUndefined(); // final status has no outgoing transition
  });

  it("total cycle time equals sum of durations", () => {
    const transitions = computeDurations([
      { fromStatus: null, toStatus: "backlog", changedAt: "2026-03-22T01:00:00Z" },
      { fromStatus: "backlog", toStatus: "in-progress", changedAt: "2026-03-22T01:05:00Z" },
      { fromStatus: "in-progress", toStatus: "done", changedAt: "2026-03-22T01:45:00Z" },
    ]);

    const total = transitions.reduce((s, t) => s + (t.durationMs || 0), 0);
    expect(total).toBe(45 * 60 * 1000); // 45 min total
  });

  it("handles tasks that go back (review -> in-progress -> review -> done)", () => {
    const transitions = computeDurations([
      { fromStatus: null, toStatus: "pending", changedAt: "2026-03-22T01:00:00Z" },
      { fromStatus: "pending", toStatus: "in-progress", changedAt: "2026-03-22T01:10:00Z" },
      { fromStatus: "in-progress", toStatus: "review", changedAt: "2026-03-22T01:40:00Z" },
      { fromStatus: "review", toStatus: "in-progress", changedAt: "2026-03-22T01:45:00Z" }, // rejected
      { fromStatus: "in-progress", toStatus: "review", changedAt: "2026-03-22T02:15:00Z" }, // resubmit
      { fromStatus: "review", toStatus: "done", changedAt: "2026-03-22T02:20:00Z" },
    ]);

    const breakdown = statusDurationBreakdown(transitions);
    // in-progress: 30min + 30min = 60min
    expect(breakdown["in-progress"]).toBe(60 * 60 * 1000);
    // review: 5min + 5min = 10min
    expect(breakdown["review"]).toBe(10 * 60 * 1000);
  });

  it("handles empty transitions", () => {
    const transitions = computeDurations([]);
    expect(transitions).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// Skill-aware scoring with real persona text (PR #209)
// ---------------------------------------------------------------------------

describe("Skill-aware scoring with real personas (PR #209)", () => {
  const SKILL_MATCH_BONUS = 50;
  const SKILL_MISMATCH_PENALTY = -100;

  function scoreTaskForAgent(agentPersona: string, agentName: string, taskLabels: string[]): number {
    const skills = detectAgentSkills({ persona: agentPersona, name: agentName, role: "worker" });
    const mismatches = getSkillMismatches(skills, taskLabels);
    if (mismatches.length > 0) return SKILL_MISMATCH_PENALTY;
    const hasMatch = skills.some(s => taskLabels.includes(s));
    return hasMatch ? SKILL_MATCH_BONUS : 0;
  }

  it("frontend persona gets +50 for frontend task", () => {
    const score = scoreTaskForAgent(
      "You are a React developer building dashboard UI components with Mantine.",
      "Frontend Dev",
      ["frontend", "bug"],
    );
    expect(score).toBe(SKILL_MATCH_BONUS);
  });

  it("research persona gets -100 for frontend-only task", () => {
    // Researcher persona has no frontend skills — should get mismatch penalty
    const score = scoreTaskForAgent(
      "You investigate and analyze system design alternatives.",
      "Analyst",
      ["frontend"],
    );
    expect(score).toBe(SKILL_MISMATCH_PENALTY);
  });

  it("tester persona gets +50 for testing task", () => {
    const score = scoreTaskForAgent(
      "You write vitest unit and integration tests.",
      "Tester",
      ["testing"],
    );
    expect(score).toBe(SKILL_MATCH_BONUS);
  });

  it("generic agent gets 0 for non-skill labels", () => {
    const score = scoreTaskForAgent(
      "General purpose agent.",
      "Agent-42",
      ["bug", "urgent", "P0"],
    );
    expect(score).toBe(0);
  });

  it("full-stack persona matches both frontend and backend tasks", () => {
    const frontendScore = scoreTaskForAgent(
      "Full-stack developer building React UI and Express API.",
      "Fullstack Dev",
      ["frontend"],
    );
    const backendScore = scoreTaskForAgent(
      "Full-stack developer building React UI and Express API.",
      "Fullstack Dev",
      ["backend"],
    );
    expect(frontendScore).toBe(SKILL_MATCH_BONUS);
    expect(backendScore).toBe(SKILL_MATCH_BONUS);
  });

  it("researcher persona mismatches on frontend task", () => {
    const score = scoreTaskForAgent(
      "Research and evaluate architecture alternatives.",
      "Researcher",
      ["frontend"],
    );
    expect(score).toBe(SKILL_MISMATCH_PENALTY);
  });
});
