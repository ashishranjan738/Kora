// @vitest-environment happy-dom
/**
 * Tests for AgentActivityBadge likely-idle heuristic.
 * Tests the logic by checking rendered output via snapshot of badge text.
 * Each test renders fresh into an isolated container and unmounts immediately.
 */
import { describe, it, expect, vi } from "vitest";
import { createElement } from "react";
import { renderToString } from "react-dom/server";
import { MantineProvider } from "@mantine/core";
import { AgentActivityBadge } from "../AgentActivityBadge";

vi.mock("@mantine/hooks", async () => {
  const actual = await vi.importActual("@mantine/hooks");
  return { ...actual, useMediaQuery: () => false };
});

/** Server-side render to get HTML string — no DOM pollution */
function renderBadgeHTML(props: Record<string, unknown> = {}): string {
  const defaultProps = { activity: "working", ...props };
  return renderToString(
    createElement(MantineProvider, null,
      createElement(AgentActivityBadge as any, defaultProps)
    )
  );
}

describe("AgentActivityBadge", () => {
  describe("likely idle heuristic", () => {
    it("shows Idle? when working with 0 active tasks", () => {
      const html = renderBadgeHTML({ activity: "working", activeTasks: 0 });
      expect(html).toContain("Idle?");
    });

    it("shows Working when working with active tasks", () => {
      const html = renderBadgeHTML({ activity: "working", activeTasks: 2 });
      expect(html).toContain("Working");
      expect(html).not.toContain("Idle?");
    });

    it("shows Idle when idle with 0 tasks (not likely-idle)", () => {
      const html = renderBadgeHTML({ activity: "idle", activeTasks: 0 });
      expect(html).toContain("Idle");
      expect(html).not.toContain("Idle?");
    });

    it("shows Working when activeTasks undefined (backward compat)", () => {
      const html = renderBadgeHTML({ activity: "working" });
      expect(html).toContain("Working");
      expect(html).not.toContain("Idle?");
    });
  });

  describe("compact mode", () => {
    it("shows Idle? in compact mode with 0 tasks", () => {
      const html = renderBadgeHTML({ activity: "working", activeTasks: 0, compact: true });
      expect(html).toContain("Idle?");
    });

    it("shows Working in compact mode with tasks", () => {
      const html = renderBadgeHTML({ activity: "working", activeTasks: 1, compact: true });
      expect(html).toContain("Working");
    });
  });

  describe("standard activity states", () => {
    it("renders working state", () => {
      const html = renderBadgeHTML({ activity: "working" });
      expect(html).toContain("Working");
    });

    it("renders idle state", () => {
      const html = renderBadgeHTML({ activity: "idle" });
      expect(html).toContain("Idle");
    });

    it("renders crashed state", () => {
      const html = renderBadgeHTML({ activity: "crashed" });
      expect(html).toContain("Crashed");
    });

    it("renders stopped state", () => {
      const html = renderBadgeHTML({ activity: "stopped" });
      expect(html).toContain("Stopped");
    });
  });
});
