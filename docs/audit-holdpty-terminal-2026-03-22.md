# Audit: Holdpty Terminal Backend

**Date:** 2026-03-22
**Author:** Researcher (researcher-4ccd5a6b)
**Task:** Round 3 — Audit holdpty terminal backend for memory leaks, cleanup issues, error handling

---

## Architecture Overview

Two components handle terminal I/O:

1. **PtyManager** (`pty-manager.ts`) — Manages node-pty processes for WebSocket terminal streaming. Spawns a PTY per session, fans output to connected WebSocket clients, handles resize/input.

2. **HoldptyController** (`holdpty-controller.ts`) — Backend for persistent PTY sessions via Unix sockets. Handles session creation/destruction, sendKeys (attach mode → send mode fallback), capturePane (cached socket replay), pipe logging.

**Key interaction:** `sendKeys` routes through PtyManager when a dashboard terminal is connected (fast path), falls back to direct socket attach when no dashboard is open.

---

## Bugs Found

### BUG-1: `cleanupAllPipeProcesses()` never called during shutdown (P1)

**File:** `holdpty-controller.ts` line 684

The method exists to kill all tracked `holdpty logs --follow` pipe processes. But it is **never called anywhere** in the codebase.

**Evidence:** `grep -r cleanupAllPipeProcesses` only finds the method definition — no callers.

The daemon shutdown handler in `cli.ts` (line 288) calls `ptyManager.destroyAll()` but never calls `holdptyController.cleanupAllPipeProcesses()`.

**Impact:** On daemon shutdown, pipe processes (detached `holdpty logs --follow` children) are orphaned. They continue running, consuming file descriptors and writing to log files. Over multiple daemon restarts, these accumulate.

**Fix:** Add `holdptyController.cleanupAllPipeProcesses()` to the shutdown handler in `cli.ts`, before `ptyManager.destroyAll()`.

**Effort:** 2 min

### BUG-2: Capture cache never cleaned for crashed sessions (P2)

**File:** `holdpty-controller.ts` lines 83-84

```typescript
private captureCache = new Map<string, CaptureCache>();
private capturePending = new Map<string, Promise<string>>();
```

These maps are cleaned in `killSession()` (line 341-342) but NOT cleaned when a session dies unexpectedly (crash, OOM, macOS sleep). The `hasSession()` method detects dead sessions and cleans up socket/metadata files, but doesn't clean the capture cache.

**Impact:** Stale cache entries accumulate in memory. Each entry holds up to 1000 lines of terminal text. With many agents over time, this is a slow memory leak.

**Fix:** Add cache cleanup to `cleanupStaleSession()`:
```typescript
private async cleanupStaleSession(name: string): Promise<void> {
  // ... existing cleanup ...
  this.captureCache.delete(name);  // ADD
  this.capturePending.delete(name); // ADD
}
```

**Effort:** 2 min

### BUG-3: PtyManager dead code — unused `originalOnMessage` variable (LOW)

**File:** `pty-manager.ts` line 98

```typescript
const originalOnMessage = ws.listeners("message").pop() as Function;
ws.removeAllListeners("message");
```

`originalOnMessage` is captured but never referenced again. The code removes the initial `ws.on("message")` listener and replaces it with a new one that handles both JSON control messages and raw terminal input. The original listener is lost.

**Impact:** None functionally — the replacement handler does the same thing plus resize handling. But the variable capture is dead code.

**Fix:** Remove `const originalOnMessage = ...` line. ~1 min.

### BUG-4: `sendKeys` always appends `\r` — could trigger prompts (MEDIUM)

**File:** `holdpty-controller.ts` line 366

```typescript
const data = keys + "\r";
```

Every `sendKeys` call appends a carriage return (Enter). This is correct for commands, but system notifications (like `[New message from X...]`) also go through sendKeys. When delivered to a terminal at a confirmation prompt ("Do you want to proceed? [y/N]"), the `\r` could accidentally press Enter and confirm the prompt.

**Impact:** Could auto-confirm dangerous prompts during message delivery. The MessageQueue uses `sendKeys` with `{ literal: true }` for notifications.

**Mitigation:** The `literal` flag is ignored by holdpty (comment on line 364 confirms this). The MessageQueue checks prompt state before delivering, but the 60s force-delivery timeout bypasses this check.

**Recommendation:** For notification-only messages, consider NOT appending `\r`. Add a `noEnter` option to sendKeys.

**Effort:** 15 min

---

## Performance Analysis

### capturePane caching — WELL DESIGNED

The 1000-line cache with 1s TTL and in-flight deduplication is excellent:
- Before: 20+ full history socket replays per 3s cycle
- After: ~10 cached replays (constant time)
- Multiple callers (health monitor, usage monitor, auto-relay, message queue) share the same fetch

### sendKeys routing — WELL DESIGNED

The PtyManager fast path avoids exclusive attach mode conflicts:
- Dashboard open: routes through PtyManager.write() (instant, no socket)
- No dashboard: direct socket connection with attach→send fallback

### Socket timeout handling — ADEQUATE

All socket connections have explicit timeouts (1s for probes, 3s for captures, 5s for attach sends). Sockets are destroyed on timeout. No obvious leak paths.

---

## Connection Cleanup Analysis

| Scenario | PtyManager Cleanup | HoldptyController Cleanup |
|----------|-------------------|--------------------------|
| WebSocket client closes | Removes from `clients` set, kills PTY if last client | N/A |
| PTY process exits | Closes all clients, removes from `sessions` map | N/A |
| Agent stopped (stopAgent) | N/A | `killSession()` — stops holdpty, cleans socket/metadata/cache |
| Daemon shutdown | `destroyAll()` — kills all PTY processes | **MISSING** — pipe processes orphaned (BUG-1) |
| Session dies unexpectedly | N/A | `hasSession()` detects + cleans socket files, but NOT cache (BUG-2) |
| Max connections reached | Returns false, client not added | N/A |

---

## Summary

| Bug | Severity | Effort | Description |
|-----|----------|--------|-------------|
| BUG-1 | P1 | 2 min | Pipe processes never cleaned on shutdown |
| BUG-2 | P2 | 2 min | Capture cache leak for crashed sessions |
| BUG-3 | LOW | 1 min | Dead code (unused variable) |
| BUG-4 | MEDIUM | 15 min | sendKeys \r could auto-confirm prompts |

**Overall assessment:** The holdpty backend is well-engineered with good caching, fallback strategies, and error handling. The 2 bugs found are minor resource leaks, not correctness issues. The `\r` appending on notifications (BUG-4) is the most impactful issue for dogfooding safety.
