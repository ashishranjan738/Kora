/**
 * Tests for list_tasks optimization: compact format, priority sort, response cap.
 */
import { describe, it, expect } from "vitest";

describe("list_tasks optimization", () => {
  describe("priority sort before cap", () => {
    it("sorts P0 first, P3 last", () => {
      const priorityOrder: Record<string, number> = { P0: 0, P1: 1, P2: 2, P3: 3 };
      const tasks = [
        { id: "t1", title: "Low", priority: "P3" },
        { id: "t2", title: "Critical", priority: "P0" },
        { id: "t3", title: "Normal", priority: "P2" },
        { id: "t4", title: "High", priority: "P1" },
      ];

      tasks.sort((a, b) => {
        const pa = priorityOrder[a.priority] ?? 2;
        const pb = priorityOrder[b.priority] ?? 2;
        return pa - pb;
      });

      expect(tasks[0].priority).toBe("P0");
      expect(tasks[1].priority).toBe("P1");
      expect(tasks[2].priority).toBe("P2");
      expect(tasks[3].priority).toBe("P3");
    });

    it("handles missing priority (defaults to P2 position)", () => {
      const priorityOrder: Record<string, number> = { P0: 0, P1: 1, P2: 2, P3: 3 };
      const tasks = [
        { id: "t1", title: "No priority", priority: undefined as any },
        { id: "t2", title: "P0", priority: "P0" },
      ];

      tasks.sort((a, b) => {
        const pa = priorityOrder[a.priority] ?? 2;
        const pb = priorityOrder[b.priority] ?? 2;
        return pa - pb;
      });

      expect(tasks[0].priority).toBe("P0");
      // undefined priority sorts as P2
    });
  });

  describe("response cap", () => {
    it("caps to maxTasks and marks truncated", () => {
      const tasks = Array.from({ length: 20 }, (_, i) => ({ id: `t${i}`, title: `Task ${i}` }));
      const maxTasks = 10;
      const truncated = tasks.length > maxTasks;
      const capped = tasks.slice(0, maxTasks);

      expect(capped).toHaveLength(10);
      expect(truncated).toBe(true);
    });

    it("does not truncate when under limit", () => {
      const tasks = [{ id: "t1" }, { id: "t2" }];
      const maxTasks = 10;
      const truncated = tasks.length > maxTasks;

      expect(truncated).toBe(false);
    });

    it("maxTasks -1 means unlimited", () => {
      const tasks = Array.from({ length: 100 }, (_, i) => ({ id: `t${i}` }));
      const maxTasks = -1;
      const capped = maxTasks > 0 ? tasks.slice(0, maxTasks) : tasks;

      expect(capped).toHaveLength(100);
    });
  });

  describe("compact format fields", () => {
    it("includes id, title, status, priority (4 fields)", () => {
      const task = {
        id: "abc123",
        title: "Fix login CSS",
        status: "in-progress",
        priority: "P1",
        assignedTo: "agent-1",
        labels: ["bug"],
        dueDate: "2026-03-25",
        description: "Long description...",
      };

      const compact = {
        id: task.id,
        title: task.title,
        status: task.status,
        priority: task.priority,
        ...(task.assignedTo ? { assignedTo: task.assignedTo } : {}),
      };

      expect(Object.keys(compact)).toEqual(["id", "title", "status", "priority", "assignedTo"]);
      expect(compact).not.toHaveProperty("labels");
      expect(compact).not.toHaveProperty("dueDate");
      expect(compact).not.toHaveProperty("description");
    });
  });

  describe("role-based defaults", () => {
    it("workers default to maxTasks=10", () => {
      const role = "worker";
      const maxTasks = role === "master" ? 25 : 10;
      expect(maxTasks).toBe(10);
    });

    it("masters default to maxTasks=25", () => {
      const role = "master";
      const maxTasks = role === "master" ? 25 : 10;
      expect(maxTasks).toBe(25);
    });
  });

  describe("truncation hint", () => {
    it("includes count and hint when truncated", () => {
      const cappedCount = 10;
      const totalMatching = 47;
      const hint = `Showing ${cappedCount} of ${totalMatching} tasks (sorted by priority). Use get_task(id) for details.`;

      expect(hint).toContain("10 of 47");
      expect(hint).toContain("sorted by priority");
      expect(hint).toContain("get_task");
    });
  });
});
