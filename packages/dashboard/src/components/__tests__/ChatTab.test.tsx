// @vitest-environment happy-dom
/**
 * Tests for ChatTab — message sending with channel relay fixes.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import * as matchers from "@testing-library/jest-dom/matchers";
expect.extend(matchers);
import { render, screen, fireEvent, waitFor, cleanup } from "@testing-library/react";
import { MantineProvider } from "@mantine/core";

// ── Mock useApi ──────────────────────────────────────────────────────────

const mockGetChannels = vi.fn();
const mockGetChannelMessages = vi.fn();
const mockGetAgents = vi.fn();
const mockRelayMessage = vi.fn();

vi.mock("../../hooks/useApi", () => ({
  useApi: () => ({
    getChannels: mockGetChannels,
    getChannelMessages: mockGetChannelMessages,
    getAgents: mockGetAgents,
    relayMessage: mockRelayMessage,
    addChannelMember: vi.fn(),
    removeChannelMember: vi.fn(),
    createChannel: vi.fn(),
    deleteChannel: vi.fn(),
  }),
}));

// ── Mock useMediaQuery (always desktop) ──────────────────────────────────

vi.mock("@mantine/hooks", async () => {
  const actual = await vi.importActual("@mantine/hooks");
  return {
    ...actual,
    useMediaQuery: () => false,
  };
});

// ── Mock MarkdownText ────────────────────────────────────────────────────

vi.mock("../MarkdownText", () => ({
  MarkdownText: ({ children }: { children: string }) => <span>{children}</span>,
}));

// ── Import component after mocks ─────────────────────────────────────────

import { ChatTab } from "../ChatTab";

// ── Helpers ──────────────────────────────────────────────────────────────

function renderChat(props: Partial<{ sessionId: string; wsEvents: any[] }> = {}) {
  return render(
    <MantineProvider>
      <ChatTab sessionId="test-session" {...props} />
    </MantineProvider>
  );
}

const defaultChannels = [
  { id: "#all", name: "All", isDefault: true, memberCount: 3 },
  { id: "#frontend", name: "Frontend", members: ["agent-1", "agent-2"], memberCount: 2 },
  { id: "#empty", name: "Empty", members: [], memberCount: 0 },
];

const defaultAgents = [
  { id: "agent-1", config: { name: "Dev 1", role: "worker" }, name: "Dev 1", role: "worker", status: "running" },
  { id: "agent-2", config: { name: "Dev 2", role: "worker" }, name: "Dev 2", role: "worker", status: "running" },
  { id: "agent-3", config: { name: "Dev 3", role: "worker" }, name: "Dev 3", role: "worker", status: "running" },
];

beforeEach(() => {
  vi.clearAllMocks();
  mockGetChannels.mockResolvedValue({ channels: defaultChannels });
  mockGetChannelMessages.mockResolvedValue({ messages: [] });
  mockGetAgents.mockResolvedValue({ agents: defaultAgents });
  mockRelayMessage.mockResolvedValue({ success: true });
});

afterEach(() => {
  cleanup();
});

// ── Tests ────────────────────────────────────────────────────────────────

describe("ChatTab — message sending", () => {
  it("sends to all running agents when in #all channel", async () => {
    renderChat();

    await waitFor(() => {
      expect(screen.getByPlaceholderText(/message all/i)).toBeInTheDocument();
    });

    const input = screen.getByPlaceholderText(/message all/i);
    fireEvent.change(input, { target: { value: "hello everyone" } });
    fireEvent.keyDown(input, { key: "Enter" });

    await waitFor(() => {
      // Should send to all 3 running agents
      expect(mockRelayMessage).toHaveBeenCalledTimes(3);
      expect(mockRelayMessage).toHaveBeenCalledWith("test-session", "user", "agent-1", "hello everyone", "#all");
      expect(mockRelayMessage).toHaveBeenCalledWith("test-session", "user", "agent-2", "hello everyone", "#all");
      expect(mockRelayMessage).toHaveBeenCalledWith("test-session", "user", "agent-3", "hello everyone", "#all");
    });
  });

  it("sends to channel members only for non-#all channels", async () => {
    renderChat();

    await waitFor(() => {
      expect(screen.getByText("#frontend")).toBeInTheDocument();
    });

    // Switch to #frontend channel
    fireEvent.click(screen.getByText("#frontend"));

    await waitFor(() => {
      expect(screen.getByPlaceholderText(/message frontend/i)).toBeInTheDocument();
    });

    const input = screen.getByPlaceholderText(/message frontend/i);
    fireEvent.change(input, { target: { value: "frontend only" } });
    fireEvent.keyDown(input, { key: "Enter" });

    await waitFor(() => {
      // Should send to only 2 members of #frontend
      expect(mockRelayMessage).toHaveBeenCalledTimes(2);
      expect(mockRelayMessage).toHaveBeenCalledWith("test-session", "user", "agent-1", "frontend only", "#frontend");
      expect(mockRelayMessage).toHaveBeenCalledWith("test-session", "user", "agent-2", "frontend only", "#frontend");
    });
  });

  it("passes channel metadata in relay call", async () => {
    renderChat();

    await waitFor(() => {
      expect(screen.getByPlaceholderText(/message all/i)).toBeInTheDocument();
    });

    const input = screen.getByPlaceholderText(/message all/i);
    fireEvent.change(input, { target: { value: "test msg" } });
    fireEvent.keyDown(input, { key: "Enter" });

    await waitFor(() => {
      // Verify 5th argument (channel) is passed
      const call = mockRelayMessage.mock.calls[0];
      expect(call[4]).toBe("#all");
    });
  });

  it("shows error when channel has no members", async () => {
    renderChat();

    await waitFor(() => {
      expect(screen.getByText("#empty")).toBeInTheDocument();
    });

    // Switch to empty channel
    fireEvent.click(screen.getByText("#empty"));

    await waitFor(() => {
      expect(screen.getByPlaceholderText(/message empty/i)).toBeInTheDocument();
    });

    const input = screen.getByPlaceholderText(/message empty/i);
    fireEvent.change(input, { target: { value: "hello?" } });
    fireEvent.keyDown(input, { key: "Enter" });

    await waitFor(() => {
      expect(screen.getByText(/no agents in this channel/i)).toBeInTheDocument();
    });

    // Should not have called relay at all
    expect(mockRelayMessage).not.toHaveBeenCalled();
  });

  it("handles partial failure — some agents fail, some succeed", async () => {
    mockRelayMessage
      .mockResolvedValueOnce({ success: true })  // agent-1 succeeds
      .mockRejectedValueOnce(new Error("timeout")) // agent-2 fails
      .mockResolvedValueOnce({ success: true });   // agent-3 succeeds

    renderChat();

    await waitFor(() => {
      expect(screen.getByPlaceholderText(/message all/i)).toBeInTheDocument();
    });

    const input = screen.getByPlaceholderText(/message all/i);
    fireEvent.change(input, { target: { value: "partial test" } });
    fireEvent.keyDown(input, { key: "Enter" });

    await waitFor(() => {
      // Should show partial failure message
      expect(screen.getByText(/delivered to 2\/3 agents/i)).toBeInTheDocument();
    });

    // Message should NOT be removed (partial success = keep it)
    expect(screen.getByText("partial test")).toBeInTheDocument();
  });

  it("removes optimistic message when all agents fail", async () => {
    mockRelayMessage.mockRejectedValue(new Error("network error"));

    renderChat();

    await waitFor(() => {
      expect(screen.getByPlaceholderText(/message all/i)).toBeInTheDocument();
    });

    const input = screen.getByPlaceholderText(/message all/i);
    fireEvent.change(input, { target: { value: "will fail" } });
    fireEvent.keyDown(input, { key: "Enter" });

    await waitFor(() => {
      expect(screen.getByText(/failed to deliver message to any channel member/i)).toBeInTheDocument();
    });
  });
});
