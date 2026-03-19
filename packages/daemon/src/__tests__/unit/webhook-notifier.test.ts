/**
 * Unit tests for WebhookNotifier
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { WebhookNotifier } from "../../core/webhook-notifier.js";
import type { WebhookConfig, WebhookEvent } from "../../core/webhook-notifier.js";
import http from "http";
import https from "https";

vi.mock("http");
vi.mock("https");
vi.mock("../../core/logger.js", () => ({
  logger: {
    debug: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    info: vi.fn(),
  },
}));

describe("WebhookNotifier", () => {
  let mockRequest: any;
  let mockResponse: any;

  beforeEach(() => {
    vi.clearAllMocks();

    // Create mock response object
    mockResponse = {
      statusCode: 200,
      resume: vi.fn(),
    };

    // Create mock request object
    mockRequest = {
      write: vi.fn(),
      end: vi.fn(),
      on: vi.fn((event, handler) => {
        if (event === "error") {
          mockRequest.errorHandler = handler;
        } else if (event === "timeout") {
          mockRequest.timeoutHandler = handler;
        }
        return mockRequest;
      }),
      destroy: vi.fn(),
      errorHandler: null as any,
      timeoutHandler: null as any,
    };

    // Mock http.request and https.request
    const mockRequestFn = (options: any, callback: (res: any) => void) => {
      // Call the callback immediately with the mock response
      setTimeout(() => callback(mockResponse), 0);
      return mockRequest;
    };

    vi.mocked(http.request).mockImplementation(mockRequestFn as any);
    vi.mocked(https.request).mockImplementation(mockRequestFn as any);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  describe("Constructor", () => {
    it("should filter out disabled webhooks", () => {
      const webhooks: WebhookConfig[] = [
        { url: "https://example.com/hook1", events: ["*"], enabled: true },
        { url: "https://example.com/hook2", events: ["*"], enabled: false },
        { url: "https://example.com/hook3", events: ["*"] }, // No enabled field = default enabled
      ];

      const notifier = new WebhookNotifier(webhooks);
      expect(notifier["webhooks"]).toHaveLength(2);
      expect(notifier["webhooks"][0].url).toBe("https://example.com/hook1");
      expect(notifier["webhooks"][1].url).toBe("https://example.com/hook3");
    });

    it("should accept empty webhook array", () => {
      const notifier = new WebhookNotifier([]);
      expect(notifier["webhooks"]).toHaveLength(0);
    });
  });

  describe("Event filtering", () => {
    it("should send to webhooks subscribed to specific event", async () => {
      const webhooks: WebhookConfig[] = [
        { url: "https://example.com/hook1", events: ["agent-crash"], enabled: true },
        { url: "https://example.com/hook2", events: ["task-complete"], enabled: true },
      ];

      const notifier = new WebhookNotifier(webhooks);
      const event: WebhookEvent = {
        event: "agent-crash",
        sessionId: "sess-1",
        agentId: "agent-1",
        timestamp: Date.now(),
      };

      await notifier.notify(event);

      // Only https://example.com/hook1 should receive the event
      expect(https.request).toHaveBeenCalledTimes(1);
      const callArgs = vi.mocked(https.request).mock.calls[0][0] as any;
      expect(callArgs.hostname).toBe("example.com");
      expect(callArgs.path).toBe("/hook1");
    });

    it("should send to webhooks with wildcard event subscription", async () => {
      const webhooks: WebhookConfig[] = [
        { url: "https://example.com/hook1", events: ["*"], enabled: true },
        { url: "https://example.com/hook2", events: ["task-complete"], enabled: true },
      ];

      const notifier = new WebhookNotifier(webhooks);
      const event: WebhookEvent = {
        event: "agent-crash",
        sessionId: "sess-1",
        timestamp: Date.now(),
      };

      await notifier.notify(event);

      // Both webhooks should receive the event (hook1 has wildcard)
      expect(https.request).toHaveBeenCalledTimes(1);
    });

    it("should not send to webhooks not subscribed to event", async () => {
      const webhooks: WebhookConfig[] = [
        { url: "https://example.com/hook1", events: ["task-complete"], enabled: true },
        { url: "https://example.com/hook2", events: ["pr-ready"], enabled: true },
      ];

      const notifier = new WebhookNotifier(webhooks);
      const event: WebhookEvent = {
        event: "agent-crash",
        sessionId: "sess-1",
        timestamp: Date.now(),
      };

      await notifier.notify(event);

      // No webhooks should receive the event
      expect(https.request).not.toHaveBeenCalled();
      expect(http.request).not.toHaveBeenCalled();
    });
  });

  describe("HTTP vs HTTPS", () => {
    it("should use https for https:// URLs", async () => {
      const webhooks: WebhookConfig[] = [
        { url: "https://example.com/hook", events: ["*"], enabled: true },
      ];

      const notifier = new WebhookNotifier(webhooks);
      const event: WebhookEvent = {
        event: "agent-crash",
        timestamp: Date.now(),
      };

      await notifier.notify(event);

      expect(https.request).toHaveBeenCalledTimes(1);
      expect(http.request).not.toHaveBeenCalled();
    });

    it("should use http for http:// URLs", async () => {
      const webhooks: WebhookConfig[] = [
        { url: "http://example.com/hook", events: ["*"], enabled: true },
      ];

      const notifier = new WebhookNotifier(webhooks);
      const event: WebhookEvent = {
        event: "agent-crash",
        timestamp: Date.now(),
      };

      await notifier.notify(event);

      expect(http.request).toHaveBeenCalledTimes(1);
      expect(https.request).not.toHaveBeenCalled();
    });
  });

  describe("Request format", () => {
    it("should send POST request with JSON payload", async () => {
      const webhooks: WebhookConfig[] = [
        { url: "https://example.com/hook", events: ["*"], enabled: true },
      ];

      const notifier = new WebhookNotifier(webhooks);
      const event: WebhookEvent = {
        event: "agent-crash",
        sessionId: "sess-1",
        agentId: "agent-1",
        timestamp: 1234567890,
      };

      await notifier.notify(event);

      expect(https.request).toHaveBeenCalledTimes(1);
      const options = vi.mocked(https.request).mock.calls[0][0] as any;

      expect(options.method).toBe("POST");
      expect(options.headers["Content-Type"]).toBe("application/json");
      expect(options.headers["User-Agent"]).toBe("Kora-Webhook/1.0");
      expect(options.timeout).toBe(5000);

      // Check payload
      expect(mockRequest.write).toHaveBeenCalledWith(JSON.stringify(event));
      expect(mockRequest.end).toHaveBeenCalled();
    });

    it("should include query parameters in request path", async () => {
      const webhooks: WebhookConfig[] = [
        { url: "https://example.com/hook?token=abc123", events: ["*"], enabled: true },
      ];

      const notifier = new WebhookNotifier(webhooks);
      const event: WebhookEvent = {
        event: "agent-crash",
        timestamp: Date.now(),
      };

      await notifier.notify(event);

      const options = vi.mocked(https.request).mock.calls[0][0] as any;
      expect(options.path).toBe("/hook?token=abc123");
    });
  });

  describe("Retry logic", () => {
    it("should retry on failure with exponential backoff", async () => {
      const webhooks: WebhookConfig[] = [
        { url: "https://example.com/hook", events: ["*"], enabled: true },
      ];

      // Mock failed response
      mockResponse.statusCode = 500;

      const notifier = new WebhookNotifier(webhooks);
      const event: WebhookEvent = {
        event: "agent-crash",
        timestamp: Date.now(),
      };

      await notifier.notify(event);

      // Should retry 3 times (initial + 2 retries)
      expect(https.request).toHaveBeenCalledTimes(3);
    }, 10000); // Increase timeout for retry delays

    it("should not retry on success", async () => {
      const webhooks: WebhookConfig[] = [
        { url: "https://example.com/hook", events: ["*"], enabled: true },
      ];

      mockResponse.statusCode = 200;

      const notifier = new WebhookNotifier(webhooks);
      const event: WebhookEvent = {
        event: "agent-crash",
        timestamp: Date.now(),
      };

      await notifier.notify(event);

      // Should only send once
      expect(https.request).toHaveBeenCalledTimes(1);
    });

    it("should accept 2xx status codes as success", async () => {
      const webhooks: WebhookConfig[] = [
        { url: "https://example.com/hook", events: ["*"], enabled: true },
      ];

      mockResponse.statusCode = 201;

      const notifier = new WebhookNotifier(webhooks);
      const event: WebhookEvent = {
        event: "agent-crash",
        timestamp: Date.now(),
      };

      await notifier.notify(event);

      expect(https.request).toHaveBeenCalledTimes(1);
    });
  });

  describe("setWebhooks", () => {
    it("should update webhook configuration", () => {
      const notifier = new WebhookNotifier([]);
      expect(notifier["webhooks"]).toHaveLength(0);

      const webhooks: WebhookConfig[] = [
        { url: "https://example.com/hook1", events: ["*"], enabled: true },
        { url: "https://example.com/hook2", events: ["task-complete"], enabled: true },
      ];

      notifier.setWebhooks(webhooks);
      expect(notifier["webhooks"]).toHaveLength(2);
    });

    it("should filter disabled webhooks when updating", () => {
      const notifier = new WebhookNotifier([]);

      const webhooks: WebhookConfig[] = [
        { url: "https://example.com/hook1", events: ["*"], enabled: true },
        { url: "https://example.com/hook2", events: ["*"], enabled: false },
      ];

      notifier.setWebhooks(webhooks);
      expect(notifier["webhooks"]).toHaveLength(1);
      expect(notifier["webhooks"][0].url).toBe("https://example.com/hook1");
    });
  });

  describe("Error handling", () => {
    it("should handle network errors gracefully", async () => {
      const webhooks: WebhookConfig[] = [
        { url: "https://example.com/hook", events: ["*"], enabled: true },
      ];

      // Trigger error immediately
      vi.mocked(https.request).mockImplementation((options: any, callback: any) => {
        setTimeout(() => {
          mockRequest.errorHandler(new Error("Network error"));
        }, 0);
        return mockRequest;
      });

      const notifier = new WebhookNotifier(webhooks);
      const event: WebhookEvent = {
        event: "agent-crash",
        timestamp: Date.now(),
      };

      // Should not throw, just log and retry
      await expect(notifier.notify(event)).resolves.toBeUndefined();
    }, 10000);
  });
});
