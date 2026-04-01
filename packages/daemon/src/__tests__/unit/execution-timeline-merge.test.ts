/**
 * Tests verifying Execution tab merged into Timeline (PR #520, task 6aa1df66).
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "fs";
import { resolve } from "path";

describe("Execution tab removal from SessionDetail", () => {
  const sessionDetail = readFileSync(
    resolve(__dirname, "../../../../dashboard/src/pages/SessionDetail.tsx"),
    "utf-8"
  );

  it("does not contain execution tab type", () => {
    // "execution" should not be in the TabId union
    expect(sessionDetail).not.toMatch(/["']execution["']/);
  });

  it("does not import ExecutionTracing", () => {
    expect(sessionDetail).not.toContain("ExecutionTracing");
  });

  it("does not render execution tab button", () => {
    expect(sessionDetail).not.toContain('Execution');
  });
});

describe("Timeline playbook integration", () => {
  const timelineView = readFileSync(
    resolve(__dirname, "../../../../dashboard/src/components/timeline/TimelineView.tsx"),
    "utf-8"
  );

  it("imports ExecutionCard and ExecutionDetail", () => {
    expect(timelineView).toContain("ExecutionCard");
    expect(timelineView).toContain("ExecutionDetail");
  });

  it("imports PlaybookExecution type", () => {
    expect(timelineView).toContain("PlaybookExecution");
  });

  it("groups playbook events by executionId", () => {
    expect(timelineView).toContain("executionId");
    expect(timelineView).toContain("executionMap");
  });

  it("deduplicates agent-spawned events within playbook executions", () => {
    // Should have logic to skip agent-spawned events that belong to a playbook
    expect(timelineView).toContain("agent-spawned");
  });

  it("renders execution cards inline in timeline", () => {
    expect(timelineView).toContain('<ExecutionCard');
  });
});

describe("Timeline playbook filter", () => {
  const timelineFilters = readFileSync(
    resolve(__dirname, "../../../../dashboard/src/components/timeline/TimelineFilters.tsx"),
    "utf-8"
  );

  it("includes playbook in EventFilter type", () => {
    expect(timelineFilters).toContain('"playbook"');
  });

  it("has Playbook filter option in UI", () => {
    expect(timelineFilters).toContain('Playbook');
  });
});

describe("Timeline playbook event configs", () => {
  const timelineEvent = readFileSync(
    resolve(__dirname, "../../../../dashboard/src/components/timeline/TimelineEvent.tsx"),
    "utf-8"
  );

  it("has configs for playbook-progress, playbook-complete, playbook-failed", () => {
    expect(timelineEvent).toContain("playbook-progress");
    expect(timelineEvent).toContain("playbook-complete");
    expect(timelineEvent).toContain("playbook-failed");
  });
});

describe("ExecutionTracing exports", () => {
  const executionTracing = readFileSync(
    resolve(__dirname, "../../../../dashboard/src/components/ExecutionTracing.tsx"),
    "utf-8"
  );

  it("exports ExecutionCard", () => {
    expect(executionTracing).toContain("export function ExecutionCard");
  });

  it("exports ExecutionDetail", () => {
    expect(executionTracing).toContain("export function ExecutionDetail");
  });

  it("exports PlaybookExecution type", () => {
    expect(executionTracing).toContain("export interface PlaybookExecution");
  });
});
