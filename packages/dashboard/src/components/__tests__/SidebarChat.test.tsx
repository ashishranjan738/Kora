// @vitest-environment happy-dom
/**
 * Tests for SidebarChat component.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import * as matchers from "@testing-library/jest-dom/matchers";
expect.extend(matchers);
import { render, screen, fireEvent, waitFor, cleanup } from "@testing-library/react";
import { MantineProvider } from "@mantine/core";

// ── Mock useApi ──────────────────────────────────────────────────────────

const mockRelayMessage = vi.fn();
const mockGetChannelMessages = vi.fn();

vi.mock("../../hooks/useApi", () => ({
  useApi: () => ({
    relayMessage: mockRelayMessage,
    getChannelMessages: mockGetChannelMessages,
  }),
}));

// ── Mock useMediaQuery ───────────────────────────────────────────────────

vi.mock("@mantine/hooks", async () => {
  const actual = await vi.importActual("@mantine/hooks");
  return { ...actual, useMediaQuery: () => false };
});

// ── Mock MarkdownText ────────────────────────────────────────────────────

vi.mock("../MarkdownText", () => ({
  MarkdownText: ({ children }: { children: string }) => <span>{children}</span>,
}));

// ── Import component after mocks ─────────────────────────────────────────

import { SidebarChat } from "../SidebarChat";

// ── Helpers ──────────────────────────────────────────────────────────────

const defaultAgents = [
  { id: "master-1", name: "Orchestrator", role: "master", status: "running" },
  { id: "worker-1", name: "Dev 1", role: "worker", status: "running" },
  { id: "worker-2", name: "Dev 2", role: "worker", status: "stopped" },
];

function renderSidebar(props: Partial<{ sessionId: string; agents: any[]; wsEvents: any[] }> = {}) {
  return render(
    <MantineProvider>
      <SidebarChat
        sessionId="test-session"
        agents={defaultAgents}
        {...props}
      />
    </MantineProvider>
  );
}

// Mock localStorage
const localStorageMock: Record<string, string> = {};
Object.defineProperty(globalThis, "localStorage", {
  value: {
    getItem: (key: string) => localStorageMock[key] ?? null,
    setItem: (key: string, value: string) => { localStorageMock[key] = value; },
    removeItem: (key: string) => { delete localStorageMock[key]; },
    clear: () => { Object.keys(localStorageMock).forEach((k) => delete localStorageMock[k]); },
  },
  writable: true,
});

beforeEach(() => {
  vi.clearAllMocks();
  mockGetChannelMessages.mockResolvedValue({ messages: [] });
  mockRelayMessage.mockResolvedValue({ success: true });
  // Ensure sidebar is expanded
  localStorageMock["kora-sidebar-expanded"] = "true";
});

afterEach(() => {
  cleanup();
  Object.keys(localStorageMock).forEach((k) => delete localStorageMock[k]);
});

// ── Tests ────────────────────────────────────────────────────────────────

describe("SidebarChat", () => {
  it("defaults agent selector to master agent", async () => {
    renderSidebar();

    await waitFor(() => {
      // Master agent should be shown in the status badge
      expect(screen.getByText("Orchestrator")).toBeInTheDocument();
    });
  });

  it("sends message via relay API with correct args", async () => {
    renderSidebar();

    await waitFor(() => {
      expect(screen.getByPlaceholderText(/message orchestrator/i)).toBeInTheDocument();
    });

    const input = screen.getByPlaceholderText(/message orchestrator/i);
    fireEvent.change(input, { target: { value: "hello master" } });
    fireEvent.keyDown(input, { key: "Enter" });

    await waitFor(() => {
      expect(mockRelayMessage).toHaveBeenCalledWith(
        "test-session", "user", "master-1", "hello master", "#sidebar"
      );
    });
  });

  it("removes optimistic message on API failure", async () => {
    mockRelayMessage.mockRejectedValue(new Error("network error"));

    renderSidebar();

    await waitFor(() => {
      expect(screen.getByPlaceholderText(/message orchestrator/i)).toBeInTheDocument();
    });

    const input = screen.getByPlaceholderText(/message orchestrator/i);
    fireEvent.change(input, { target: { value: "will fail" } });
    fireEvent.keyDown(input, { key: "Enter" });

    // Optimistic message should appear then disappear
    await waitFor(() => {
      expect(screen.queryByText("will fail")).not.toBeInTheDocument();
    });
  });

  it("adds WS event message with deduplication", async () => {
    const { rerender } = renderSidebar({ wsEvents: [] });

    await waitFor(() => {
      expect(screen.getByPlaceholderText(/message orchestrator/i)).toBeInTheDocument();
    });

    const wsMsg = {
      type: "channel-message",
      message: {
        id: "msg-123",
        from: "master-1",
        fromName: "Orchestrator",
        content: "Hello from agent",
        timestamp: new Date().toISOString(),
        channel: "#sidebar",
      },
    };

    // First event — message should appear
    rerender(
      <MantineProvider>
        <SidebarChat sessionId="test-session" agents={defaultAgents} wsEvents={[wsMsg]} />
      </MantineProvider>
    );

    await waitFor(() => {
      expect(screen.getByText("Hello from agent")).toBeInTheDocument();
    });

    // Same event again — should NOT duplicate
    rerender(
      <MantineProvider>
        <SidebarChat sessionId="test-session" agents={defaultAgents} wsEvents={[wsMsg, wsMsg]} />
      </MantineProvider>
    );

    await waitFor(() => {
      const matches = screen.getAllByText("Hello from agent");
      expect(matches).toHaveLength(1);
    });
  });

  it("ignores WS events for other channels", async () => {
    const { rerender } = renderSidebar({ wsEvents: [] });

    await waitFor(() => {
      expect(screen.getByPlaceholderText(/message orchestrator/i)).toBeInTheDocument();
    });

    const otherChannelMsg = {
      type: "channel-message",
      message: {
        id: "msg-456",
        from: "worker-1",
        fromName: "Dev 1",
        content: "Not for sidebar",
        timestamp: new Date().toISOString(),
        channel: "#frontend",
      },
    };

    rerender(
      <MantineProvider>
        <SidebarChat sessionId="test-session" agents={defaultAgents} wsEvents={[otherChannelMsg]} />
      </MantineProvider>
    );

    // Should NOT appear in sidebar
    expect(screen.queryByText("Not for sidebar")).not.toBeInTheDocument();
  });
});
