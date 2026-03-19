import { describe, it, expect, vi, beforeEach } from "vitest";
import { MessageQueue } from "../../core/message-queue.js";
import type { IPtyBackend } from "../../core/pty-backend.js";

describe("Nudge Visibility Fixes", () => {
  let messageQueue: MessageQueue;
  let mockTmux: IPtyBackend;
  let mockDatabase: any;
  let sendKeysCallArgs: any[];

  beforeEach(() => {
    sendKeysCallArgs = [];

    // Mock IPtyBackend
    mockTmux = {
      sendKeys: vi.fn(async (session: string, keys: string, options?: { literal?: boolean }) => {
        sendKeysCallArgs.push({ session, keys, options });
      }),
      capturePane: vi.fn(async () => "$ "),
      spawn: vi.fn(),
      kill: vi.fn(),
      list: vi.fn(async () => []),
      exists: vi.fn(async () => true),
      restore: vi.fn(async () => ({})),
      cleanup: vi.fn(async () => {}),
    } as any;

    // Mock database
    mockDatabase = {
      insertEvent: vi.fn(),
      trackMessageDelivery: vi.fn(),
      updateMessageDeliveryStatus: vi.fn(),
      insertMessage: vi.fn(),
    };

    messageQueue = new MessageQueue(mockTmux, "/tmp/test-runtime", "mcp");
    messageQueue.setDeliveryTracking(mockDatabase, "test-session");
    messageQueue.setRenotifyCallbacks(
      async (agentId: string) => 3, // Mock unread count
      (agentId: string) => "test-session"
    );
  });

  describe("Literal Flag Standardization", () => {
    it("should use literal:true for MCP pending notifications", async () => {
      messageQueue.registerMcpAgent("agent-1");

      const success = await messageQueue.deliverDirect(
        "agent-1",
        "test-session",
        "[Broadcast]: Test message",
        "system",
        "agent-1"
      );

      expect(success).toBe(true);

      // Find the notification call (last sendKeys call)
      const notificationCall = sendKeysCallArgs[sendKeysCallArgs.length - 1];
      expect(notificationCall.options?.literal).toBe(true);
    });

    it("should use literal:true for terminal mode messages", async () => {
      const terminalQueue = new MessageQueue(mockTmux, "/tmp/test-runtime", "terminal");

      terminalQueue.enqueue(
        "agent-1",
        "test-session",
        "[Message from teammate]: Test",
        "system"
      );

      // Wait for async delivery
      await new Promise(resolve => setTimeout(resolve, 100));

      const deliveryCall = sendKeysCallArgs[sendKeysCallArgs.length - 1];
      expect(deliveryCall.options?.literal).toBe(true);
    });
  });

  describe("Error Handling", () => {
    it("should log error when nudge delivery fails", async () => {
      const mockTmuxFailing = {
        ...mockTmux,
        sendKeys: vi.fn(async () => {
          throw new Error("Session not found");
        }),
      } as any;

      const failingQueue = new MessageQueue(mockTmuxFailing, "/tmp/test", "mcp");
      failingQueue.setDeliveryTracking(mockDatabase, "test-session");
      failingQueue.setRenotifyCallbacks(
        async () => 3,
        () => "test-session"
      );
      failingQueue.registerMcpAgent("agent-1");

      const success = await failingQueue.deliverDirect(
        "agent-1",
        "test-session",
        ">>> 📬 YOU HAVE 3 UNREAD MESSAGE(S) — run check_messages NOW <<<",
        undefined,
        "agent-1"
      );

      // Should return false on failure after retries
      expect(success).toBe(false);
    });

    it("should track delivery metrics on failure", async () => {
      const mockTmuxFailing = {
        ...mockTmux,
        sendKeys: vi.fn(async () => {
          throw new Error("Socket write error");
        }),
      } as any;

      const failingQueue = new MessageQueue(mockTmuxFailing, "/tmp/test", "mcp");

      const mockBroadcast = vi.fn();
      failingQueue.setBroadcastCallback(mockBroadcast);
      failingQueue.setDeliveryTracking(mockDatabase, "test-session");
      failingQueue.registerMcpAgent("agent-1");

      await failingQueue.deliverDirect(
        "agent-1",
        "test-session",
        "Test message",
        undefined,
        "agent-1"
      );

      // Check that delivery-failed event was broadcast
      const failureEvents = mockBroadcast.mock.calls.filter(
        (call: any) => call[0].event === "delivery-failed"
      );
      expect(failureEvents.length).toBeGreaterThan(0);
    });
  });

  describe("Nudge Agent Method", () => {
    it("should return unread count on successful nudge", async () => {
      messageQueue.registerMcpAgent("agent-1");

      const unread = await messageQueue.nudgeAgent("agent-1", "test-session");

      expect(unread).toBe(3); // Mock returns 3
      expect(sendKeysCallArgs.length).toBeGreaterThan(0);
    });

    it("should return 0 when no unread messages", async () => {
      const emptyQueue = new MessageQueue(mockTmux, "/tmp/test", "mcp");
      emptyQueue.setRenotifyCallbacks(
        async () => 0, // No unread messages
        () => "test-session"
      );

      const unread = await emptyQueue.nudgeAgent("agent-1", "test-session");

      expect(unread).toBe(0);
      expect(sendKeysCallArgs.length).toBe(0); // No sendKeys call
    });

    it("should format nudge notification correctly", async () => {
      messageQueue.registerMcpAgent("agent-1");

      await messageQueue.nudgeAgent("agent-1", "test-session");

      const notificationCall = sendKeysCallArgs[sendKeysCallArgs.length - 1];
      // Notification is wrapped by deliverDirect, so check for generic format
      expect(notificationCall.keys).toContain("message");
      expect(notificationCall.keys).toContain("check_messages");
    });
  });

  describe("Delivery Confirmation", () => {
    it("should return true on successful delivery", async () => {
      messageQueue.registerMcpAgent("agent-1");

      const success = await messageQueue.deliverDirect(
        "agent-1",
        "test-session",
        "Test nudge",
        undefined,
        "agent-1"
      );

      expect(success).toBe(true);
    });

    it("should return false after all retries exhausted", async () => {
      const mockTmuxFailing = {
        ...mockTmux,
        sendKeys: vi.fn(async () => {
          throw new Error("Persistent failure");
        }),
      } as any;

      const failingQueue = new MessageQueue(mockTmuxFailing, "/tmp/test", "mcp");
      failingQueue.setDeliveryTracking(mockDatabase, "test-session");
      failingQueue.registerMcpAgent("agent-1");

      const success = await failingQueue.deliverDirect(
        "agent-1",
        "test-session",
        "Test message",
        undefined,
        "agent-1"
      );

      expect(success).toBe(false);
    });
  });

  describe("Notification Format", () => {
    it("should send notification with literal:true flag", async () => {
      messageQueue.registerMcpAgent("agent-1");

      await messageQueue.nudgeAgent("agent-1", "test-session");

      const notificationCall = sendKeysCallArgs[sendKeysCallArgs.length - 1];
      // The important fix: literal flag should be true for consistent rendering
      expect(notificationCall.options?.literal).toBe(true);
    });

    it("should send check_messages prompt in notification", async () => {
      messageQueue.registerMcpAgent("agent-1");

      await messageQueue.nudgeAgent("agent-1", "test-session");

      const notificationCall = sendKeysCallArgs[sendKeysCallArgs.length - 1];
      // Notification should tell agent to check messages
      expect(notificationCall.keys).toContain("check_messages");
    });

    it("should not accidentally execute commands with literal:true", async () => {
      messageQueue.registerMcpAgent("agent-1");

      // Nudge with potentially dangerous content
      await messageQueue.deliverDirect(
        "agent-1",
        "test-session",
        "Test message with $(dangerous command)",
        undefined,
        "agent-1"
      );

      const notificationCall = sendKeysCallArgs[sendKeysCallArgs.length - 1];
      // With literal:true, this should be safe - no command execution
      expect(notificationCall.options?.literal).toBe(true);
    });
  });
});
