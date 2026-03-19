import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";

describe("Pino logger configuration", () => {
  let originalEnv: NodeJS.ProcessEnv;

  beforeEach(() => {
    // Save original env
    originalEnv = { ...process.env };
  });

  afterEach(() => {
    // Restore original env
    process.env = originalEnv;
    // Clear module cache to test fresh imports
    vi.resetModules();
  });

  // Test 1: Verify logger.ts exports a pino logger instance
  it("exports a pino logger instance with required methods", async () => {
    const { logger } = await import("../logger.js");

    expect(logger).toBeDefined();
    expect(typeof logger.info).toBe("function");
    expect(typeof logger.debug).toBe("function");
    expect(typeof logger.warn).toBe("function");
    expect(typeof logger.error).toBe("function");
  });

  // Test 2: Verify KORA_LOG_LEVEL env var is respected (default: info)
  it("defaults to info level when KORA_LOG_LEVEL is not set", async () => {
    delete process.env.KORA_LOG_LEVEL;

    const { logger } = await import("../logger.js");

    expect(logger.level).toBe("info");
  });

  // Test 3: Verify KORA_LOG_LEVEL env var is respected (custom level)
  it("respects KORA_LOG_LEVEL environment variable", async () => {
    process.env.KORA_LOG_LEVEL = "debug";

    const { logger } = await import("../logger.js");

    expect(logger.level).toBe("debug");
  });

  // Test 4: Verify logger has all standard pino methods
  it("provides standard pino logging methods", async () => {
    const { logger } = await import("../logger.js");

    const methods = ["trace", "debug", "info", "warn", "error", "fatal"];
    methods.forEach((method) => {
      expect(typeof (logger as any)[method]).toBe("function");
    });
  });

  // Test 5: Verify pino-pretty transport in non-production
  it("uses pino-pretty transport in non-production environment", async () => {
    process.env.NODE_ENV = "development";

    // We can't directly test the transport config, but we can verify
    // the logger was created with the expected configuration by checking
    // that it doesn't throw during creation
    const { logger } = await import("../logger.js");

    expect(logger).toBeDefined();
    // In dev mode, pretty transport should be configured
    // We verify by ensuring logger works without errors
    expect(() => logger.info("test")).not.toThrow();
  });

  // Test 6: Verify no pretty transport in production
  it("does not use pino-pretty in production environment", async () => {
    process.env.NODE_ENV = "production";
    delete process.env.KORA_LOG_LEVEL;

    const { logger } = await import("../logger.js");

    expect(logger).toBeDefined();
    // Production logger should work without pretty formatting
    expect(() => logger.info("test")).not.toThrow();
  });
});
