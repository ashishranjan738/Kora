# Design: Proportional Utilization Calculation

**Date:** 2026-03-22
**Author:** Researcher (researcher-4ccd5a6b)
**Task:** b908b777 — Utilization is binary 0%/100%

---

## Problem

Utilization shows exactly 0% (idle) or 100% (working). An agent that was idle for 3 hours then working for 1 minute shows 100%. No proportional time-based calculation exists.

---

## Current State

### Dashboard (frontend-only calculation)
`SessionDetail.tsx` lines 1987-1991:
```typescript
const hist = activityHistory[a.id] || [];
if (hist.length === 0) return activity === "working" ? 1 : 0;
const active = hist.filter(h => h === "working" || h === "reading" || h === "writing" || h === "running-command").length;
return active / hist.length;
```

This counts the ratio of "working" samples in `activityHistory` — an array built from frontend polling (every ~10s). **Problem:** This array is only populated while the dashboard tab is open. If you open the dashboard after 3 hours, `hist.length === 0` and utilization falls back to binary (current activity === "working" ? 100% : 0%).

### Backend (no calculation)
`agent-health.ts` tracks `activity` (working/idle) and timestamps (`lastActivityAt`, `idleSince`, `startedAt`) but does NOT compute cumulative working time.

---

## Design: Backend-Side Utilization Tracking

### New fields on AgentState

Add to `packages/shared/src/types.ts` in `AgentState`:
```typescript
export interface AgentState {
  // ... existing fields ...

  /** Cumulative milliseconds spent in "working" activity */
  workingMs?: number;
  /** Cumulative milliseconds spent in "idle" activity */
  idleMs?: number;
  /** Utilization percentage (0-100), computed as workingMs / (workingMs + idleMs) * 100 */
  utilizationPercent?: number;
}
```

### Tracking logic in AgentHealthMonitor

Add accumulator state in `agent-health.ts`:

```typescript
// New state maps in AgentHealthMonitor
private workingAccumulator = new Map<string, number>();  // cumulative working ms
private idleAccumulator = new Map<string, number>();     // cumulative idle ms
private lastActivityChange = new Map<string, { activity: string; at: number }>();
```

**On every activity state transition** (working→idle or idle→working), compute the elapsed time in the previous state and add it to the appropriate accumulator:

```typescript
private recordActivityTransition(agentId: string, newActivity: string): void {
  const last = this.lastActivityChange.get(agentId);
  const now = Date.now();

  if (last) {
    const elapsed = now - last.at;
    if (last.activity === "working") {
      this.workingAccumulator.set(agentId, (this.workingAccumulator.get(agentId) || 0) + elapsed);
    } else {
      this.idleAccumulator.set(agentId, (this.idleAccumulator.get(agentId) || 0) + elapsed);
    }
  }

  this.lastActivityChange.set(agentId, { activity: newActivity, at: now });

  // Update agent state
  const agent = this.agents?.get(agentId);
  if (agent) {
    const workingMs = this.workingAccumulator.get(agentId) || 0;
    const idleMs = this.idleAccumulator.get(agentId) || 0;
    const total = workingMs + idleMs;
    agent.workingMs = workingMs;
    agent.idleMs = idleMs;
    agent.utilizationPercent = total > 0 ? Math.round((workingMs / total) * 100) : 0;
  }
}
```

### Where to call recordActivityTransition

Insert calls at every point where `agent.activity` changes in `checkIdleState()`:

1. **Line 334** (thinking detected, transition to working):
   ```typescript
   this.recordActivityTransition(agentId, "working");
   ```

2. **Lines 371, 383, 427, 436** (idle detected):
   ```typescript
   this.recordActivityTransition(agentId, "idle");
   ```

3. **Lines 405-406** (output changed, not at prompt, transition to working):
   ```typescript
   this.recordActivityTransition(agentId, "working");
   ```

4. **Line 183** (`markIdleFromMcp`):
   ```typescript
   this.recordActivityTransition(agentId, "idle");
   ```

5. **Line 221** (`recordMcpActivity`, idle→working):
   ```typescript
   this.recordActivityTransition(agentId, "working");
   ```

### Periodic flush (handles "still working" case)

The transition-based approach doesn't account for time spent in the current state. Add a periodic flush every 30s in the existing poll loop:

```typescript
// In checkIdleState(), AFTER all detection logic:
// Flush current state duration to accumulator (for accurate real-time display)
const lastChange = this.lastActivityChange.get(agentId);
if (lastChange && agent) {
  const elapsed = Date.now() - lastChange.at;
  const workingMs = (this.workingAccumulator.get(agentId) || 0) + (lastChange.activity === "working" ? elapsed : 0);
  const idleMs = (this.idleAccumulator.get(agentId) || 0) + (lastChange.activity !== "working" ? elapsed : 0);
  const total = workingMs + idleMs;
  agent.utilizationPercent = total > 0 ? Math.round((workingMs / total) * 100) : 0;
  agent.workingMs = workingMs;
  agent.idleMs = idleMs;
}
```

This computes a real-time utilization on every health check poll (~3s) without mutating the accumulators (only the accumulators are updated on actual transitions).

### Persistence

The `workingMs`, `idleMs`, and `utilizationPercent` fields are on `AgentState`, which is already persisted by `saveAgentStates()`. On daemon restart, the accumulators need to be re-initialized from the persisted values:

```typescript
// In restoreAgent() or startMonitoring():
if (agent.workingMs) this.workingAccumulator.set(agentId, agent.workingMs);
if (agent.idleMs) this.idleAccumulator.set(agentId, agent.idleMs);
this.lastActivityChange.set(agentId, {
  activity: agent.activity === "working" ? "working" : "idle",
  at: Date.now()
});
```

### Dashboard consumption

Update `SessionDetail.tsx` to prefer backend utilization when available:

```typescript
<AgentUtilization
  utilization={(() => {
    // Prefer backend-computed utilization (survives page refresh)
    if (a.utilizationPercent !== undefined) return a.utilizationPercent / 100;
    // Fallback to frontend activity history
    const hist = activityHistory[a.id] || [];
    if (hist.length === 0) return activity === "working" ? 1 : 0;
    const active = hist.filter(h => h === "working" || h === "reading" || h === "writing" || h === "running-command").length;
    return active / hist.length;
  })()}
/>
```

### API response

The fields are already on `AgentState`, which is returned by `GET /sessions/:sid/agents`. No API changes needed — the new fields will appear automatically.

---

## Files to Modify

| File | Change | Effort |
|------|--------|--------|
| `packages/shared/src/types.ts` | Add `workingMs`, `idleMs`, `utilizationPercent` to AgentState | 2 min |
| `packages/daemon/src/core/agent-health.ts` | Add accumulator maps, `recordActivityTransition()`, periodic flush, restore init | 30 min |
| `packages/dashboard/src/pages/SessionDetail.tsx` | Prefer backend `utilizationPercent` over frontend history | 5 min |

**Total effort:** ~40 min

---

## Edge Cases

1. **Agent restarted** — `workingMs`/`idleMs` reset to 0 on new spawn (fresh agent). On restart with preserved ID, values are loaded from persisted state.

2. **Dashboard polling vs backend** — Frontend still computes its own utilization from `activityHistory` as a fallback. This handles the case where the backend hasn't been updated yet.

3. **Crashed agent** — When agent crashes, the time since last activity change is lost (not flushed). Acceptable — the error is at most 3 seconds (one poll cycle).

4. **Multiple activity sub-states** — "reading", "writing", "running-command" are all sub-states of "working". The design treats them as "working" for utilization purposes, consistent with the existing frontend logic.
