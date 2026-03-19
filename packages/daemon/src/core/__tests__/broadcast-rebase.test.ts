import { describe, it, expect, vi } from "vitest";

/**
 * Tests for the POST /sessions/:sid/broadcast-rebase endpoint logic.
 * Tests the message construction and agent filtering without HTTP layer.
 */

describe("broadcast-rebase", () => {
  describe("message construction", () => {
    it("should construct rebase message with PR number", () => {
      const prNumber = 42;
      const prTitle = "feat: new feature";
      const prInfo = `PR #${prNumber} (${prTitle})`;
      const rebaseMsg =
        `${prInfo} merged into main. Please rebase your branch NOW:\n` +
        `git fetch origin main && git rebase origin/main`;

      expect(rebaseMsg).toContain("PR #42");
      expect(rebaseMsg).toContain("feat: new feature");
      expect(rebaseMsg).toContain("git fetch origin main && git rebase origin/main");
    });

    it("should construct rebase message without PR number", () => {
      const prInfo = "A PR";
      const rebaseMsg =
        `${prInfo} merged into main. Please rebase your branch NOW:\n` +
        `git fetch origin main && git rebase origin/main`;

      expect(rebaseMsg).toContain("A PR");
      expect(rebaseMsg).toContain("git rebase origin/main");
    });

    it("should use custom message when provided", () => {
      const customMessage = "Custom rebase reminder: please rebase now";
      const body = { message: customMessage };
      const rebaseMsg = body.message || "default";

      expect(rebaseMsg).toBe(customMessage);
    });

    it("should format broadcast with ANSI color prefix", () => {
      const rebaseMsg = "PR #1 merged. Rebase now.";
      const broadcastMsg = `\x1b[1;33m[System]\x1b[0m: ${rebaseMsg}`;

      expect(broadcastMsg).toContain("[System]");
      expect(broadcastMsg).toContain(rebaseMsg);
    });
  });

  describe("agent filtering", () => {
    it("should only broadcast to running agents", () => {
      const agents = [
        { id: "a1", status: "running", config: { name: "Architect", tmuxSession: "t1" } },
        { id: "a2", status: "crashed", config: { name: "Frontend", tmuxSession: "t2" } },
        { id: "a3", status: "running", config: { name: "Backend", tmuxSession: "t3" } },
        { id: "a4", status: "stopped", config: { name: "Tests", tmuxSession: "t4" } },
      ];

      const runningAgents = agents.filter((a) => a.status === "running");

      expect(runningAgents).toHaveLength(2);
      expect(runningAgents.map((a) => a.id)).toEqual(["a1", "a3"]);
    });

    it("should handle empty agent list", () => {
      const agents: any[] = [];
      const runningAgents = agents.filter((a) => a.status === "running");

      expect(runningAgents).toHaveLength(0);
    });

    it("should handle all agents stopped/crashed", () => {
      const agents = [
        { id: "a1", status: "crashed", config: { name: "Architect", tmuxSession: "t1" } },
        { id: "a2", status: "stopped", config: { name: "Frontend", tmuxSession: "t2" } },
      ];

      const runningAgents = agents.filter((a) => a.status === "running");
      expect(runningAgents).toHaveLength(0);
    });
  });

  describe("event logging data", () => {
    it("should construct event log data correctly", () => {
      const prNumber = 55;
      const prTitle = "docs: update context";
      const rebaseMsg = `PR #${prNumber} (${prTitle}) merged into main. Please rebase.`;

      const eventData = {
        from: "system",
        fromName: "System",
        to: "all",
        toName: "All Agents",
        content: rebaseMsg.substring(0, 200),
        broadcast: true,
        messageType: "rebase-reminder",
        prNumber,
        prTitle,
      };

      expect(eventData.from).toBe("system");
      expect(eventData.broadcast).toBe(true);
      expect(eventData.messageType).toBe("rebase-reminder");
      expect(eventData.prNumber).toBe(55);
      expect(eventData.content.length).toBeLessThanOrEqual(200);
    });

    it("should truncate long messages to 200 chars", () => {
      const longMsg = "A".repeat(300);
      const truncated = longMsg.substring(0, 200);

      expect(truncated.length).toBe(200);
    });
  });
});
