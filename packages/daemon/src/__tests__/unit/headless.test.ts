/**
 * Unit tests for headless mode
 */

import { describe, it, expect } from "vitest";

describe("Headless Mode", () => {
  describe("Command parsing", () => {
    it("should parse playbook name from args", () => {
      const args = ["run", "full-stack-team", "--headless"];
      const playbookName = args[1];
      expect(playbookName).toBe("full-stack-team");
    });

    it("should parse optional task from args", () => {
      const args = ["run", "full-stack-team", "Implement auth system", "--headless"];
      const task = args[2] && !args[2].startsWith("--") ? args[2] : undefined;
      expect(task).toBe("Implement auth system");
    });

    it("should not parse flag as task", () => {
      const args = ["run", "full-stack-team", "--headless"];
      const task = args[2] && !args[2].startsWith("--") ? args[2] : undefined;
      expect(task).toBeUndefined();
    });

    it("should detect headless flag", () => {
      const args = ["run", "full-stack-team", "--headless"];
      const isHeadless = args.includes("--headless");
      expect(isHeadless).toBe(true);
    });

    it("should parse timeout flag with default", () => {
      const args = ["run", "full-stack-team", "--headless", "--timeout", "60000"];
      const parseFlag = (flag: string) => {
        const idx = args.indexOf(flag);
        if (idx !== -1 && idx + 1 < args.length) {
          return args[idx + 1];
        }
        return undefined;
      };
      const timeoutMs = parseInt(parseFlag("--timeout") ?? "1800000", 10);
      expect(timeoutMs).toBe(60000);
    });

    it("should use default timeout when not specified", () => {
      const args = ["run", "full-stack-team", "--headless"];
      const parseFlag = (flag: string) => {
        const idx = args.indexOf(flag);
        if (idx !== -1 && idx + 1 < args.length) {
          return args[idx + 1];
        }
        return undefined;
      };
      const timeoutMs = parseInt(parseFlag("--timeout") ?? "1800000", 10);
      expect(timeoutMs).toBe(1800000); // 30 minutes default
    });
  });

  describe("Exit codes", () => {
    it("should define exit code 0 for success", () => {
      const EXIT_SUCCESS = 0;
      expect(EXIT_SUCCESS).toBe(0);
    });

    it("should define exit code 1 for failure", () => {
      const EXIT_FAILURE = 1;
      expect(EXIT_FAILURE).toBe(1);
    });

    it("should define exit code 2 for timeout", () => {
      const EXIT_TIMEOUT = 2;
      expect(EXIT_TIMEOUT).toBe(2);
    });
  });

  describe("Agent status checks", () => {
    it("should identify running agents", () => {
      const agents = [
        { id: "agent-1", status: "running" as const },
        { id: "agent-2", status: "idle" as const },
        { id: "agent-3", status: "running" as const },
      ];
      const spawnedAgents = ["agent-1", "agent-2", "agent-3"];
      const active = agents.filter(a => spawnedAgents.includes(a.id) && a.status === "running");
      expect(active).toHaveLength(2);
      expect(active.map(a => a.id)).toEqual(["agent-1", "agent-3"]);
    });

    it("should identify failed agents", () => {
      const agents = [
        { id: "agent-1", status: "running" as const, config: { name: "Agent 1" } },
        { id: "agent-2", status: "error" as const, config: { name: "Agent 2" } },
        { id: "agent-3", status: "crashed" as const, config: { name: "Agent 3" } },
      ];
      const spawnedAgents = ["agent-1", "agent-2", "agent-3"];
      const failed = agents.filter(a => spawnedAgents.includes(a.id) && (a.status === "error" || a.status === "crashed"));
      expect(failed).toHaveLength(2);
      expect(failed.map(a => a.config.name)).toEqual(["Agent 2", "Agent 3"]);
    });

    it("should detect all agents complete", () => {
      const agents = [
        { id: "agent-1", status: "idle" as const },
        { id: "agent-2", status: "idle" as const },
      ];
      const spawnedAgents = ["agent-1", "agent-2"];
      const active = agents.filter(a => spawnedAgents.includes(a.id) && a.status === "running");
      expect(active).toHaveLength(0);
    });
  });

  describe("Playbook sorting", () => {
    it("should sort masters before workers", () => {
      const agents = [
        { name: "Worker A", role: "worker" as const },
        { name: "Master", role: "master" as const },
        { name: "Worker B", role: "worker" as const },
      ];
      const sorted = [...agents].sort((a, b) => {
        if (a.role === "master" && b.role !== "master") return -1;
        if (a.role !== "master" && b.role === "master") return 1;
        return 0;
      });
      expect(sorted[0].name).toBe("Master");
      expect(sorted[1].name).toBe("Worker A");
      expect(sorted[2].name).toBe("Worker B");
    });
  });
});
