// @vitest-environment happy-dom
import { describe, it, expect, vi } from "vitest";
import * as matchers from "@testing-library/jest-dom/matchers";
expect.extend(matchers);
import { render, screen } from "@testing-library/react";
import { MantineProvider } from "@mantine/core";
import { AgentActivityBadge } from "../AgentActivityBadge";

vi.mock("@mantine/hooks", async () => {
  const actual = await vi.importActual("@mantine/hooks");
  return { ...actual, useMediaQuery: () => false };
});

function renderBadge(props: Partial<Parameters<typeof AgentActivityBadge>[0]> = {}) {
  const defaultProps = {
    activity: "working" as const,
    ...props,
  };
  return render(
    <MantineProvider>
      <AgentActivityBadge {...defaultProps} />
    </MantineProvider>
  );
}

describe("AgentActivityBadge", () => {
  describe("likely idle heuristic", () => {
    it("shows 'Idle?' when working with 0 active tasks", () => {
      renderBadge({ activity: "working", activeTasks: 0 });
      expect(screen.getByText(/Idle\?/)).toBeInTheDocument();
    });

    it("shows normal 'Working' when working with active tasks", () => {
      renderBadge({ activity: "working", activeTasks: 2 });
      expect(screen.getByText(/Working/)).toBeInTheDocument();
      expect(screen.queryByText(/Idle\?/)).not.toBeInTheDocument();
    });

    it("shows normal 'Idle' when idle with 0 tasks (not likely-idle)", () => {
      renderBadge({ activity: "idle", activeTasks: 0 });
      expect(screen.getByText(/Idle/)).toBeInTheDocument();
      expect(screen.queryByText(/Idle\?/)).not.toBeInTheDocument();
    });

    it("shows normal 'Working' when activeTasks is undefined (backward compat)", () => {
      renderBadge({ activity: "working" });
      expect(screen.getByText(/Working/)).toBeInTheDocument();
      expect(screen.queryByText(/Idle\?/)).not.toBeInTheDocument();
    });
  });

  describe("compact mode", () => {
    it("shows 'Idle?' in compact mode with 0 tasks", () => {
      renderBadge({ activity: "working", activeTasks: 0, compact: true });
      expect(screen.getByText(/Idle\?/)).toBeInTheDocument();
    });

    it("shows short label in compact mode normally", () => {
      renderBadge({ activity: "working", activeTasks: 1, compact: true });
      expect(screen.getByText(/Working/)).toBeInTheDocument();
    });
  });

  describe("standard activity states", () => {
    it("renders working state", () => {
      renderBadge({ activity: "working" });
      expect(screen.getByText(/Working/)).toBeInTheDocument();
    });

    it("renders idle state", () => {
      renderBadge({ activity: "idle" });
      expect(screen.getByText(/Idle/)).toBeInTheDocument();
    });

    it("renders crashed state", () => {
      renderBadge({ activity: "crashed" });
      expect(screen.getByText(/Crashed/)).toBeInTheDocument();
    });

    it("renders stopped state", () => {
      renderBadge({ activity: "stopped" });
      expect(screen.getByText(/Stopped/)).toBeInTheDocument();
    });
  });
});
