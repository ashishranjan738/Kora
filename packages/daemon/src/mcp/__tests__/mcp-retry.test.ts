import { describe, it, expect, vi, beforeEach } from "vitest";

// ---------------------------------------------------------------------------
// Test the retry logic extracted from agent-mcp-server.ts apiCall()
// Since agent-mcp-server.ts is a standalone script with side-effects,
// we replicate the retry logic here against the same contract.
// ---------------------------------------------------------------------------

const API_RETRY_MAX = 3;
const API_RETRY_BASE_MS = 100; // Faster for tests (real: 2000ms)

function isRetryableError(err: unknown): boolean {
  if (!(err instanceof Error)) return false;
  const msg = err.message;
  return msg.includes("ECONNREFUSED") || msg.includes("ECONNRESET") || msg.includes("EPIPE");
}

async function apiCallWithRetry(
  callFn: () => Promise<unknown>,
  maxRetries: number = API_RETRY_MAX,
  baseMs: number = API_RETRY_BASE_MS,
): Promise<unknown> {
  let lastError: unknown;
  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    try {
      return await callFn();
    } catch (err) {
      lastError = err;
      if (attempt < maxRetries && isRetryableError(err)) {
        const delayMs = baseMs * Math.pow(2, attempt);
        await new Promise(r => setTimeout(r, delayMs));
      } else {
        throw err;
      }
    }
  }
  throw lastError;
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("MCP apiCall retry logic", () => {
  it("succeeds on first attempt — no retry", async () => {
    const fn = vi.fn().mockResolvedValue({ ok: true });
    const result = await apiCallWithRetry(fn);
    expect(result).toEqual({ ok: true });
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it("retries on ECONNREFUSED and succeeds on second attempt", async () => {
    const fn = vi.fn()
      .mockRejectedValueOnce(new Error("connect ECONNREFUSED 127.0.0.1:7891"))
      .mockResolvedValue({ ok: true });

    const result = await apiCallWithRetry(fn, 3, 10);
    expect(result).toEqual({ ok: true });
    expect(fn).toHaveBeenCalledTimes(2);
  });

  it("retries on ECONNRESET and succeeds on third attempt", async () => {
    const fn = vi.fn()
      .mockRejectedValueOnce(new Error("read ECONNRESET"))
      .mockRejectedValueOnce(new Error("read ECONNRESET"))
      .mockResolvedValue({ recovered: true });

    const result = await apiCallWithRetry(fn, 3, 10);
    expect(result).toEqual({ recovered: true });
    expect(fn).toHaveBeenCalledTimes(3);
  });

  it("retries on EPIPE", async () => {
    const fn = vi.fn()
      .mockRejectedValueOnce(new Error("write EPIPE"))
      .mockResolvedValue({ ok: true });

    const result = await apiCallWithRetry(fn, 3, 10);
    expect(result).toEqual({ ok: true });
    expect(fn).toHaveBeenCalledTimes(2);
  });

  it("throws after max retries exhausted", async () => {
    const fn = vi.fn().mockRejectedValue(new Error("connect ECONNREFUSED 127.0.0.1:7891"));

    await expect(apiCallWithRetry(fn, 3, 10)).rejects.toThrow("ECONNREFUSED");
    expect(fn).toHaveBeenCalledTimes(4); // initial + 3 retries
  });

  it("does NOT retry non-retryable errors (e.g., 404)", async () => {
    const fn = vi.fn().mockRejectedValue(new Error("Request failed with status 404"));

    await expect(apiCallWithRetry(fn, 3, 10)).rejects.toThrow("404");
    expect(fn).toHaveBeenCalledTimes(1); // no retry
  });

  it("does NOT retry non-Error throws", async () => {
    const fn = vi.fn().mockRejectedValue("string error");

    await expect(apiCallWithRetry(fn, 3, 10)).rejects.toBe("string error");
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it("does NOT retry timeout errors", async () => {
    const fn = vi.fn().mockRejectedValue(new Error("socket hang up"));

    await expect(apiCallWithRetry(fn, 3, 10)).rejects.toThrow("socket hang up");
    expect(fn).toHaveBeenCalledTimes(1);
  });
});

describe("isRetryableError", () => {
  it("returns true for ECONNREFUSED", () => {
    expect(isRetryableError(new Error("connect ECONNREFUSED 127.0.0.1:7891"))).toBe(true);
  });

  it("returns true for ECONNRESET", () => {
    expect(isRetryableError(new Error("read ECONNRESET"))).toBe(true);
  });

  it("returns true for EPIPE", () => {
    expect(isRetryableError(new Error("write EPIPE"))).toBe(true);
  });

  it("returns false for other errors", () => {
    expect(isRetryableError(new Error("ENOENT"))).toBe(false);
    expect(isRetryableError(new Error("timeout"))).toBe(false);
    expect(isRetryableError(new Error("404 Not Found"))).toBe(false);
  });

  it("returns false for non-Error", () => {
    expect(isRetryableError("string")).toBe(false);
    expect(isRetryableError(null)).toBe(false);
    expect(isRetryableError(undefined)).toBe(false);
  });
});
