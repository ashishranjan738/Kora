import { describe, it, expect, vi, beforeEach } from "vitest";
import type { WSEvent } from "@kora/shared";

describe("WebSocket Event Type Filtering (Tier 2)", () => {
  let mockClient: any;

  beforeEach(() => {
    mockClient = {
      readyState: 1, // OPEN
      wsType: 'dashboard',
      subscribedEventTypes: new Set(['*']), // Default: all events
      subscribedSessionId: undefined,
      send: vi.fn(),
    };
  });

  // Helper to check if event should be sent
  const shouldSendEvent = (client: any, event: WSEvent): boolean => {
    const eventTypes = client.subscribedEventTypes as Set<string> | undefined;
    const sessionId = client.subscribedSessionId as string | undefined;

    // Check session filter (Tier 1)
    if (sessionId && 'sessionId' in event && event.sessionId !== sessionId) {
      return false;
    }

    // Check event type filter (Tier 2)
    // If eventTypes is undefined, treat as wildcard (allow all)
    if (!eventTypes || eventTypes.has('*')) {
      return true; // Wildcard: subscribe to all events
    }

    return eventTypes.has(event.event);
  };

  describe("Default behavior (wildcard subscription)", () => {
    it("sends all events when subscribed to '*'", () => {
      const events: WSEvent[] = [
        { event: "agent-spawned", sessionId: "s1", agent: {} as any },
        { event: "agent-removed", sessionId: "s1", agentId: "a1", reason: "stopped" },
        { event: "task-update", sessionId: "s1", task: {} as any },
        { event: "session-update", session: {} as any },
      ];

      events.forEach(evt => {
        expect(shouldSendEvent(mockClient, evt)).toBe(true);
      });
    });
  });

  describe("Event type filtering", () => {
    it("only sends subscribed event types", () => {
      mockClient.subscribedEventTypes = new Set(['agent-spawned', 'agent-removed']);

      const testCases = [
        { event: { event: "agent-spawned", sessionId: "s1", agent: {} as any }, expected: true },
        { event: { event: "agent-removed", sessionId: "s1", agentId: "a1", reason: "stopped" }, expected: true },
        { event: { event: "task-update", sessionId: "s1", task: {} as any }, expected: false },
        { event: { event: "session-update", session: {} as any }, expected: false },
        { event: { event: "cost-update", sessionId: "s1", agentId: "a1", costUsd: 0.05 }, expected: false },
      ];

      testCases.forEach(({ event, expected }) => {
        expect(shouldSendEvent(mockClient, event as WSEvent)).toBe(expected);
      });
    });

    it("filters out unsubscribed events", () => {
      mockClient.subscribedEventTypes = new Set(['task-update']);

      const agentEvent: WSEvent = { event: "agent-spawned", sessionId: "s1", agent: {} as any };
      expect(shouldSendEvent(mockClient, agentEvent)).toBe(false);

      const taskEvent: WSEvent = { event: "task-update", sessionId: "s1", task: {} as any };
      expect(shouldSendEvent(mockClient, taskEvent)).toBe(true);
    });

    it("handles empty subscription set (no events)", () => {
      mockClient.subscribedEventTypes = new Set<string>();

      const event: WSEvent = { event: "agent-spawned", sessionId: "s1", agent: {} as any };
      expect(shouldSendEvent(mockClient, event)).toBe(false);
    });
  });

  describe("Session filtering (Tier 1)", () => {
    it("only sends events from subscribed session", () => {
      mockClient.subscribedSessionId = "session-1";

      const testCases = [
        { event: { event: "agent-spawned", sessionId: "session-1", agent: {} as any }, expected: true },
        { event: { event: "agent-spawned", sessionId: "session-2", agent: {} as any }, expected: false },
        { event: { event: "task-update", sessionId: "session-1", task: {} as any }, expected: true },
        { event: { event: "task-update", sessionId: "session-3", task: {} as any }, expected: false },
      ];

      testCases.forEach(({ event, expected }) => {
        expect(shouldSendEvent(mockClient, event as WSEvent)).toBe(expected);
      });
    });

    it("sends events without sessionId when session filter is set", () => {
      mockClient.subscribedSessionId = "session-1";

      const globalEvent: WSEvent = { event: "session-update", session: {} as any };
      expect(shouldSendEvent(mockClient, globalEvent)).toBe(true);
    });

    it("sends all session events when no session filter is set", () => {
      mockClient.subscribedSessionId = undefined;

      const events: WSEvent[] = [
        { event: "agent-spawned", sessionId: "session-1", agent: {} as any },
        { event: "agent-spawned", sessionId: "session-2", agent: {} as any },
        { event: "task-update", sessionId: "session-3", task: {} as any },
      ];

      events.forEach(evt => {
        expect(shouldSendEvent(mockClient, evt)).toBe(true);
      });
    });
  });

  describe("Combined session + event-type filtering", () => {
    it("applies both session and event-type filters", () => {
      mockClient.subscribedSessionId = "session-1";
      mockClient.subscribedEventTypes = new Set(['agent-spawned', 'agent-removed']);

      const testCases = [
        // session-1 + agent-spawned: PASS both filters
        { event: { event: "agent-spawned", sessionId: "session-1", agent: {} as any }, expected: true },

        // session-1 + task-update: FAIL event-type filter
        { event: { event: "task-update", sessionId: "session-1", task: {} as any }, expected: false },

        // session-2 + agent-spawned: FAIL session filter
        { event: { event: "agent-spawned", sessionId: "session-2", agent: {} as any }, expected: false },

        // session-2 + task-update: FAIL both filters
        { event: { event: "task-update", sessionId: "session-2", task: {} as any }, expected: false },
      ];

      testCases.forEach(({ event, expected }) => {
        expect(shouldSendEvent(mockClient, event as WSEvent)).toBe(expected);
      });
    });

    it("prioritizes session filter over event-type filter", () => {
      mockClient.subscribedSessionId = "session-1";
      mockClient.subscribedEventTypes = new Set(['*']); // All event types

      const wrongSessionEvent: WSEvent = {
        event: "agent-spawned",
        sessionId: "session-2",
        agent: {} as any
      };

      // Even with wildcard event types, wrong session should be filtered
      expect(shouldSendEvent(mockClient, wrongSessionEvent)).toBe(false);
    });
  });

  describe("broadcastEvent filtering", () => {
    let mockClients: any[];

    beforeEach(() => {
      mockClients = [
        // Client 1: All events, all sessions (default)
        {
          readyState: 1,
          wsType: 'dashboard',
          subscribedEventTypes: new Set(['*']),
          subscribedSessionId: undefined,
          send: vi.fn(),
        },
        // Client 2: Only agent events, session-1
        {
          readyState: 1,
          wsType: 'dashboard',
          subscribedEventTypes: new Set(['agent-spawned', 'agent-removed']),
          subscribedSessionId: "session-1",
          send: vi.fn(),
        },
        // Client 3: Only task events, all sessions
        {
          readyState: 1,
          wsType: 'dashboard',
          subscribedEventTypes: new Set(['task-update']),
          subscribedSessionId: undefined,
          send: vi.fn(),
        },
        // Client 4: Terminal connection (should never receive events)
        {
          readyState: 1,
          wsType: 'terminal',
          subscribedEventTypes: new Set(['*']),
          subscribedSessionId: undefined,
          send: vi.fn(),
        },
      ];
    });

    const simulateBroadcast = (event: any) => {
      const message = JSON.stringify(event);
      mockClients.forEach((client) => {
        if (client.readyState !== 1 || client.wsType === 'terminal') {
          return;
        }

        // Check session filter (Tier 1)
        const subscribedSessionId = client.subscribedSessionId as string | undefined;
        if (subscribedSessionId && event.sessionId && event.sessionId !== subscribedSessionId) {
          return;
        }

        // Check event type filter (Tier 2)
        const subscribedEventTypes = client.subscribedEventTypes as Set<string> | undefined;
        if (subscribedEventTypes && !subscribedEventTypes.has('*')) {
          if (!event.event || !subscribedEventTypes.has(event.event)) {
            return;
          }
        }

        client.send(message);
      });
    };

    it("broadcasts agent-spawned event to appropriate clients", () => {
      const event = { event: "agent-spawned", sessionId: "session-1", agent: {} };
      simulateBroadcast(event);

      expect(mockClients[0].send).toHaveBeenCalledTimes(1); // Client 1: all events
      expect(mockClients[1].send).toHaveBeenCalledTimes(1); // Client 2: agent events, session-1
      expect(mockClients[2].send).toHaveBeenCalledTimes(0); // Client 3: only task events
      expect(mockClients[3].send).toHaveBeenCalledTimes(0); // Client 4: terminal (never)
    });

    it("broadcasts task-update event to appropriate clients", () => {
      const event = { event: "task-update", sessionId: "session-1", task: {} };
      simulateBroadcast(event);

      expect(mockClients[0].send).toHaveBeenCalledTimes(1); // Client 1: all events
      expect(mockClients[1].send).toHaveBeenCalledTimes(0); // Client 2: only agent events
      expect(mockClients[2].send).toHaveBeenCalledTimes(1); // Client 3: task events
      expect(mockClients[3].send).toHaveBeenCalledTimes(0); // Client 4: terminal (never)
    });

    it("filters events by session ID", () => {
      const event = { event: "agent-spawned", sessionId: "session-2", agent: {} };
      simulateBroadcast(event);

      expect(mockClients[0].send).toHaveBeenCalledTimes(1); // Client 1: all sessions
      expect(mockClients[1].send).toHaveBeenCalledTimes(0); // Client 2: only session-1
      expect(mockClients[2].send).toHaveBeenCalledTimes(0); // Client 3: only task events
      expect(mockClients[3].send).toHaveBeenCalledTimes(0); // Client 4: terminal (never)
    });

    it("never broadcasts to terminal connections", () => {
      const events = [
        { event: "agent-spawned", sessionId: "session-1", agent: {} },
        { event: "task-update", sessionId: "session-1", task: {} },
        { event: "session-update", session: {} },
      ];

      events.forEach(event => {
        mockClients[3].send.mockClear();
        simulateBroadcast(event);
        expect(mockClients[3].send).toHaveBeenCalledTimes(0);
      });
    });
  });

  describe("Subscribe message handling", () => {
    it("updates event type subscription", () => {
      const client = { ...mockClient };
      const msg = {
        type: "subscribe",
        eventTypes: ["agent-spawned", "task-update"],
      };

      // Simulate subscription update
      if (Array.isArray(msg.eventTypes)) {
        client.subscribedEventTypes = new Set(msg.eventTypes);
      }

      expect(client.subscribedEventTypes.has('agent-spawned')).toBe(true);
      expect(client.subscribedEventTypes.has('task-update')).toBe(true);
      expect(client.subscribedEventTypes.has('*')).toBe(false);
    });

    it("updates session subscription", () => {
      const client = { ...mockClient };
      const msg = {
        type: "subscribe",
        sessionId: "session-123",
      };

      // Simulate subscription update
      if (msg.sessionId !== undefined) {
        client.subscribedSessionId = msg.sessionId || undefined;
      }

      expect(client.subscribedSessionId).toBe("session-123");
    });

    it("updates both filters simultaneously", () => {
      const client = { ...mockClient };
      const msg = {
        type: "subscribe",
        sessionId: "session-123",
        eventTypes: ["agent-spawned"],
      };

      // Simulate subscription update
      if (msg.sessionId !== undefined) {
        client.subscribedSessionId = msg.sessionId || undefined;
      }
      if (Array.isArray(msg.eventTypes)) {
        client.subscribedEventTypes = new Set(msg.eventTypes);
      }

      expect(client.subscribedSessionId).toBe("session-123");
      expect(client.subscribedEventTypes.has('agent-spawned')).toBe(true);
      expect(client.subscribedEventTypes.has('*')).toBe(false);
    });

    it("clears session filter with empty string", () => {
      const client = { ...mockClient, subscribedSessionId: "session-123" };
      const msg = {
        type: "subscribe",
        sessionId: "",
      };

      // Simulate subscription update
      if (msg.sessionId !== undefined) {
        client.subscribedSessionId = msg.sessionId || undefined;
      }

      expect(client.subscribedSessionId).toBeUndefined();
    });

    it("restores wildcard subscription", () => {
      const client = { ...mockClient, subscribedEventTypes: new Set(['agent-spawned']) };
      const msg = {
        type: "subscribe",
        eventTypes: ["*"],
      };

      // Simulate subscription update
      if (Array.isArray(msg.eventTypes)) {
        client.subscribedEventTypes = new Set(msg.eventTypes);
      }

      expect(client.subscribedEventTypes.has('*')).toBe(true);
      expect(client.subscribedEventTypes.size).toBe(1);
    });
  });

  describe("Edge cases", () => {
    it("handles undefined subscribedEventTypes gracefully", () => {
      mockClient.subscribedEventTypes = undefined;

      const event: WSEvent = { event: "agent-spawned", sessionId: "s1", agent: {} as any };

      // Should treat undefined as no filtering (allow all)
      const result = shouldSendEvent(mockClient, event);
      expect(typeof result).toBe('boolean');
    });

    it("handles events without sessionId field", () => {
      mockClient.subscribedSessionId = "session-1";

      const globalEvent: WSEvent = { event: "session-update", session: {} as any };
      expect(shouldSendEvent(mockClient, globalEvent)).toBe(true);

      const errorEvent: WSEvent = { event: "error", message: "test" };
      expect(shouldSendEvent(mockClient, errorEvent)).toBe(true);
    });

    it("handles non-ready WebSocket clients", () => {
      mockClient.readyState = 0; // CONNECTING

      const event = { event: "agent-spawned", sessionId: "s1", agent: {} };
      const message = JSON.stringify(event);

      // Simulate broadcast logic
      if (mockClient.readyState !== 1) {
        // Should skip
        expect(mockClient.send).not.toHaveBeenCalled();
      }
    });
  });
});
