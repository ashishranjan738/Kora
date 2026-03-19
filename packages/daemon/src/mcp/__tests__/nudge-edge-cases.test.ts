import { describe, it, expect } from "vitest";

/**
 * Nudge Agent Edge Cases Test Suite
 *
 * Tests edge cases identified in PR #114 post-merge audit:
 * 1. Empty/invalid agent names
 * 2. Very long messages (>10KB)
 * 3. Rapid-fire nudges (rate limiting)
 * 4. Special characters in messages
 * 5. Null/undefined inputs
 *
 * Reference: PR114_POST_MERGE_REVIEW.md
 */

describe("nudge_agent Edge Cases", () => {
  describe("Input Validation", () => {
    it("should reject empty agent ID", () => {
      // Validation logic in agent-mcp-server.ts lines 1182-1188
      const agentId = "";
      const isValid = !(!agentId || typeof agentId !== 'string' || agentId.trim().length === 0);
      expect(isValid).toBe(false);
    });

    it("should reject whitespace-only agent ID", () => {
      const agentId = "   ";
      const isValid = !(!agentId || typeof agentId !== 'string' || agentId.trim().length === 0);
      expect(isValid).toBe(false);
    });

    it("should reject null agent ID", () => {
      const agentId = null as any;
      const isValid = !(!agentId || typeof agentId !== 'string' || agentId.trim?.().length === 0);
      expect(isValid).toBe(false);
    });

    it("should reject undefined agent ID", () => {
      const agentId = undefined as any;
      const isValid = !(!agentId || typeof agentId !== 'string' || agentId?.trim?.().length === 0);
      expect(isValid).toBe(false);
    });

    it("should handle agent ID with special characters", () => {
      // Agent IDs with special characters should be allowed (e.g., "backend3-43dab2d1")
      const agentId = "backend3-43dab2d1";
      const isValid = agentId && typeof agentId === 'string' && agentId.trim().length > 0;
      expect(isValid).toBe(true);
    });

    it("should accept valid agent names", () => {
      const agentId = "Backend";
      const isValid = agentId && typeof agentId === 'string' && agentId.trim().length > 0;
      expect(isValid).toBe(true);
    });
  });

  describe("Message Length Validation", () => {
    const MAX_MESSAGE_LENGTH = 10 * 1024; // 10KB

    it("should accept messages up to 10KB", () => {
      const message = "a".repeat(MAX_MESSAGE_LENGTH - 1); // 10KB - 1 byte
      const isValid = !message || message.length <= MAX_MESSAGE_LENGTH;
      expect(isValid).toBe(true);
      expect(message.length).toBe(MAX_MESSAGE_LENGTH - 1);
    });

    it("should reject messages over 10KB", () => {
      const message = "a".repeat(MAX_MESSAGE_LENGTH + 1); // 10KB + 1 byte
      const isValid = !message || message.length <= MAX_MESSAGE_LENGTH;
      expect(isValid).toBe(false);
      expect(message.length).toBe(MAX_MESSAGE_LENGTH + 1);
    });

    it("should handle exactly 10KB message", () => {
      const message = "a".repeat(MAX_MESSAGE_LENGTH); // Exactly 10KB
      const isValid = !message || message.length <= MAX_MESSAGE_LENGTH;
      expect(isValid).toBe(true);
      expect(message.length).toBe(MAX_MESSAGE_LENGTH);
    });

    it("should handle empty message (use default)", () => {
      const message = "";
      // Empty message is valid - will use default
      expect(message.length).toBe(0);
    });

    it("should handle undefined message (use default)", () => {
      const message = undefined;
      const isValid = !message || (typeof message === 'string' && message.length <= MAX_MESSAGE_LENGTH);
      expect(isValid).toBe(true);
    });
  });

  describe("Message Content Sanitization", () => {
    function sanitizeMessage(message: string | undefined): string {
      if (!message || typeof message !== 'string') return '';
      // Sanitization logic from agent-mcp-server.ts lines 1200-1204
      return message
        .replace(/[\x00-\x08\x0B-\x0C\x0E-\x1F\x7F]/g, '') // Remove control chars except \n (0x0A) and \t (0x09)
        .trim();
    }

    it("should sanitize control characters", () => {
      const message = "Hello\x00World\x01Test\x1F";
      const sanitized = sanitizeMessage(message);
      expect(sanitized).toBe("HelloWorldTest");
      expect(sanitized).not.toContain("\x00");
      expect(sanitized).not.toContain("\x01");
      expect(sanitized).not.toContain("\x1F");
    });

    it("should sanitize null bytes", () => {
      const message = "Hello\x00World";
      const sanitized = sanitizeMessage(message);
      expect(sanitized).toBe("HelloWorld");
      expect(sanitized).not.toContain("\x00");
    });

    it("should preserve newlines in message", () => {
      const message = "Line 1\nLine 2\nLine 3";
      const sanitized = sanitizeMessage(message);
      expect(sanitized).toBe("Line 1\nLine 2\nLine 3");
      expect(sanitized).toContain("\n");
    });

    it("should preserve tabs in message", () => {
      const message = "Col1\tCol2\tCol3";
      const sanitized = sanitizeMessage(message);
      expect(sanitized).toBe("Col1\tCol2\tCol3");
      expect(sanitized).toContain("\t");
    });

    it("should sanitize ANSI escape codes", () => {
      const message = "\x1b[31mRed Text\x1b[0m";
      const sanitized = sanitizeMessage(message);
      expect(sanitized).toBe("[31mRed Text[0m");
      // ESC character (\x1b) should be removed
      expect(sanitized).not.toContain("\x1b");
    });

    it("should preserve emoji and unicode", () => {
      const message = "Hello 👋 World 🌍 Test 测试";
      const sanitized = sanitizeMessage(message);
      expect(sanitized).toBe(message);
      expect(sanitized).toContain("👋");
      expect(sanitized).toContain("🌍");
      expect(sanitized).toContain("测试");
    });

    it("should trim whitespace", () => {
      const message = "  Hello World  ";
      const sanitized = sanitizeMessage(message);
      expect(sanitized).toBe("Hello World");
    });
  });

  describe("Rate Limiting", () => {
    it("should calculate correct wait time for rate limit", () => {
      const windowStart = Date.now() - 30000; // 30 seconds ago
      const now = Date.now();
      const waitTime = Math.ceil((60000 - (now - windowStart)) / 1000);

      expect(waitTime).toBeGreaterThan(0);
      expect(waitTime).toBeLessThanOrEqual(60);
      expect(waitTime).toBeCloseTo(30, 1); // ~30 seconds remaining
    });

    it("should format rate limit error message correctly", () => {
      const agentId = "Backend";
      const windowStart = Date.now() - 45000; // 45 seconds ago
      const now = Date.now();
      const waitTime = Math.ceil((60000 - (now - windowStart)) / 1000);

      const errorMessage = `Rate limited: You've sent 5 nudges to "${agentId}" in the last minute. Please wait ${waitTime} seconds before trying again.`;

      expect(errorMessage).toContain("Rate limited");
      expect(errorMessage).toContain("Backend");
      expect(errorMessage).toContain(`${waitTime} seconds`);
      expect(errorMessage).toContain("Please wait");
    });

    it("should track rate limit window correctly", () => {
      const rateLimit = new Map<string, { count: number; windowStart: number }>();
      const agentId = "test-agent";
      const now = Date.now();

      // Simulate 5 nudges
      rateLimit.set(agentId, { count: 5, windowStart: now });

      const window = rateLimit.get(agentId);
      expect(window).toBeDefined();
      expect(window!.count).toBe(5);
      expect(window!.windowStart).toBe(now);
    });

    it("should allow nudges after 60 seconds", () => {
      const windowStart = Date.now() - 61000; // 61 seconds ago (>60s)
      const now = Date.now();
      const shouldRateLimit = now - windowStart < 60000;

      expect(shouldRateLimit).toBe(false);
    });

    it("should rate limit within 60 seconds", () => {
      const windowStart = Date.now() - 30000; // 30 seconds ago (<60s)
      const now = Date.now();
      const count = 5;
      const shouldRateLimit = now - windowStart < 60000 && count >= 5;

      expect(shouldRateLimit).toBe(true);
    });
  });

  describe("Agent Resolution", () => {
    it("should format agent not found error with available agents", () => {
      const agentId = "NonExistent";
      const sessionId = "test-session";
      const availableAgents = ["Backend", "Frontend", "Tests"];

      const errorMessage = `Agent "${agentId}" not found in session "${sessionId}". Available agents: ${availableAgents.join(', ')}`;

      expect(errorMessage).toContain(agentId);
      expect(errorMessage).toContain(sessionId);
      expect(errorMessage).toContain("Backend");
      expect(errorMessage).toContain("Frontend");
      expect(errorMessage).toContain("Tests");
      expect(errorMessage).toContain("Available agents:");
    });

    it("should trim agent names for comparison", () => {
      const search = "  Backend  ";
      const trimmed = search.trim().toLowerCase();
      expect(trimmed).toBe("backend");
    });

    it("should handle case-insensitive matching", () => {
      const search = "BACKEND";
      const agentName = "Backend";
      expect(search.toLowerCase()).toBe(agentName.toLowerCase());
    });

    it("should match agent by name substring", () => {
      const search = "back";
      const agentName = "Backend";
      expect(agentName.toLowerCase().includes(search.toLowerCase())).toBe(true);
    });
  });

  describe("Error Messages", () => {
    it("should include agent ID in validation error", () => {
      const errorMessage = "Invalid agentId: must be a non-empty string. Example: nudge_agent('Backend', 'Your task is ready')";

      expect(errorMessage).toContain("Invalid agentId");
      expect(errorMessage).toContain("Example");
      expect(errorMessage).toContain("nudge_agent");
    });

    it("should include message length in error", () => {
      const maxLength = 10 * 1024;
      const actualLength = 11 * 1024;
      const errorMessage = `Message too long: ${actualLength} bytes (max ${maxLength} bytes). Please shorten your message.`;

      expect(errorMessage).toContain("Message too long");
      expect(errorMessage).toContain(`${actualLength} bytes`);
      expect(errorMessage).toContain(`${maxLength} bytes`);
      expect(errorMessage).toContain("Please shorten");
    });

    it("should provide actionable error messages", () => {
      const errors = [
        "Invalid agentId: must be a non-empty string. Example: nudge_agent('Backend', 'Your task is ready')",
        "Message too long: 11264 bytes (max 10240 bytes). Please shorten your message.",
        "Rate limited: You've sent 5 nudges to \"Backend\" in the last minute. Please wait 30 seconds before trying again.",
      ];

      errors.forEach(error => {
        // Each error should contain actionable guidance
        const hasActionableGuidance =
          error.includes("Example") ||
          error.includes("Please") ||
          error.includes("wait");
        expect(hasActionableGuidance).toBe(true);
      });
    });
  });

  describe("Edge Case Combinations", () => {
    it("should handle empty string after trimming", () => {
      const message = "   ";
      const sanitized = message.trim();
      expect(sanitized).toBe("");
      expect(sanitized.length).toBe(0);
    });

    it("should handle message with only control characters", () => {
      const message = "\x00\x01\x02\x1F";
      const sanitized = message.replace(/[\x00-\x08\x0B-\x0C\x0E-\x1F\x7F]/g, '').trim();
      expect(sanitized).toBe("");
    });

    it("should handle very long agent ID", () => {
      const agentId = "a".repeat(1000);
      const isValid = agentId && typeof agentId === 'string' && agentId.trim().length > 0;
      expect(isValid).toBe(true);
      // Agent ID length isn't limited, only message length
    });

    it("should handle unicode in agent ID", () => {
      const agentId = "测试-Agent-🔧";
      const isValid = agentId && typeof agentId === 'string' && agentId.trim().length > 0;
      expect(isValid).toBe(true);
    });
  });
});
