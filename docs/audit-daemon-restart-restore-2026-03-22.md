# Audit: Daemon Restart/Restore Flow

**Date:** 2026-03-22
**Author:** Researcher (researcher-4ccd5a6b)
**Task:** d59e0edd — Audit daemon startup, session restore, and agent reconnection

---

## Executive Summary

The restore flow successfully reconnects to running agents after daemon restart. All 8 agents were restored with correct status. However, **3 bugs** were found where the restore flow skips steps that the spawn flow performs, leading to degraded messaging and resource tracking after restart.

---

## Live Verification

| Check | Result | Notes |
|-------|--------|-------|
| All 8 agents restored? | PASS | All show `status: "running"`, correct names/IDs |
| Activity detection working? | PASS | All show `activity: "working"`, `lastActivityAt` updating |
| MCP tools working? | PASS | `list_agents`, `send_message`, `check_messages` all functional |
| Task assignments preserved? | PASS | All agents have correct `currentTask`/`currentTaskId` |
| Post-restart messaging? | PASS | Sent test message to Tester, `send_message` returned success |

---

## Restore Flow Analysis

### Spawn Flow (normal agent creation)
```
agentManager.spawnAgent()
  → emit "agent-spawned"
    → messageBus.setupAgent()
    → controlPlane.setupAgent() + watchAgent()
    → costTracker.initAgent()
    → usageMonitor.startMonitoring()
    → autoRelay.startMonitoring()
    → messageQueue.registerMcpAgent()     ← CRITICAL
    → messageQueue.registerAgentRole()    ← MISSING FROM RESTORE (via playbook)
    → worktreeInfo.set()                  ← IN-MEMORY ONLY
```

### Restore Flow (after daemon restart)
```
orchestrator.restore()
  → loadAgentStates() from disk
  → For each agent:
    → tmux.hasSession() / capturePane() check
    → agentManager.restoreAgent()         ← Just sets map + starts health monitor
    → messageBus.setupAgent()
    → controlPlane.setupAgent() + watchAgent()
    → costTracker.initAgent()
    → usageMonitor.startMonitoring()
    → autoRelay.startMonitoring()
    ← MISSING: messageQueue.registerMcpAgent()
    ← MISSING: messageQueue.registerAgentRole()
    ← MISSING: worktreeInfo restoration
```

---

## Bugs Found

### BUG-1: `registerMcpAgent()` not called during restore (P1)

**File:** `orchestrator.ts` lines 976-992

During spawn, `registerMcpAgent()` is called at line 304 (inside the `agent-spawned` event handler). During restore, this step is **completely missing**.

**Impact:** After daemon restart, the `MessageQueue.mcpAgents` set is empty. This means:
- `deliver()` (line 500) checks `this.mcpAgents.has(msg.agentId)` — returns false
- Messages fall through to `deliverViaMcp()` instead of `deliverViaMcpPending()`
- This writes to `inbox-{agentId}/` (legacy path) instead of `mcp-pending/{agentId}/`
- The MCP server's `check_messages` reads from `mcp-pending/` first — may miss messages written to `inbox/`

**Why messaging still works:** The `check_messages` tool has a 3-tier fallback (SQLite → mcp-pending → inbox files), so messages are eventually found. But it's hitting the legacy path unnecessarily, and the notification format differs.

**Fix:** Add to restore flow (after line 990):
```typescript
// Register MCP-capable agents for mcp-pending delivery
if (agent.config.cliProvider) {
  const provider = this.config.providerRegistry.get(agent.config.cliProvider);
  if (provider?.supportsMcp) {
    this.messageQueue.registerMcpAgent(agent.id);
  }
}
```

**Effort:** 5 min

### BUG-2: `registerAgentRole()` not called during restore (P2)

**File:** `orchestrator.ts` restore flow + `playbook-executor.ts` line 273

The playbook executor calls `registerAgentRole()` when spawning agents. The normal `agent-spawned` event handler does NOT call it either. After restart, all agents default to the "worker" rate limit (10 msgs/min) regardless of actual role.

**Impact:** The master/orchestrator agent gets the worker rate limit (10/min instead of 25/min) after restart. This could cause message buffering for active orchestrators.

**Fix:** Add to restore flow:
```typescript
this.messageQueue.registerAgentRole(agent.id, agent.config.role);
```

**Effort:** 2 min

### BUG-3: `worktreeInfo` not restored (KNOWN — already in worktree spec)

**File:** `agent-manager.ts` line 50

The `worktreeInfo` map is empty after restart. This was already documented in `docs/spec-worktree-cleanup-2026-03-22.md` and fixed in PR #279 (adds fallback filesystem scan in `stopAgent`). No additional action needed.

---

## Race Condition Analysis

### Q: Can agents be restored before orchestrator is fully initialized?

**Answer: No — safe.** The `restore()` method is called after `start()` sets up all infrastructure (message bus watching, control plane watching, message queue started). The call order in `api-routes.ts` (session creation) is:
1. `new Orchestrator(config)` — constructor sets up all internal components
2. `orch.start()` — starts watching
3. `orch.restore()` — reconnects to existing agents

### Q: Can WebSocket clients miss the restore event?

**Answer: Partially.** The restore logs a `session-resumed` event but doesn't emit individual `agent-spawned` WebSocket events for each restored agent. Dashboard clients that connect AFTER restore will fetch the correct state via API. But clients connected DURING restart won't get real-time push of the restore.

**Impact:** LOW — dashboard auto-refreshes on reconnect.

---

## State Persistence Completeness

### What IS persisted (survives restart):
- Agent config (name, role, provider, model, working directory, tmux session name)
- Agent status, health check state
- Agent cost data (totalTokensIn/Out, totalCostUsd)
- Agent activity state (activity, lastActivityAt, idleSince)
- Child agent relationships

### What is NOT persisted (lost on restart):
- `worktreeInfo` map — fixed by PR #279 fallback
- `mcpAgents` set in MessageQueue — **BUG-1**
- `agentRoles` map in MessageQueue — **BUG-2**
- Conversation loop detection counters — acceptable (resets are fine)
- Rate limit windows — acceptable (resets on restart are fine)
- Re-notification state — acceptable (will rebuild from unread counts)
- Blocking state machine — acceptable (agents re-detected on next poll)

---

## Recommendations

| # | Description | File | Effort | Priority |
|---|-------------|------|--------|----------|
| 1 | Register MCP agents during restore | `orchestrator.ts` | 5 min | P1 |
| 2 | Register agent roles during restore | `orchestrator.ts` | 2 min | P1 |
| 3 | Also register roles in `agent-spawned` handler (not just playbook) | `orchestrator.ts` | 2 min | P2 |

**Total effort:** ~10 minutes for all 3 fixes.

---

## Conclusion

The restore flow is solid for basic reconnection but has 2 messaging-related registration gaps. Messages still work due to fallback paths, but delivery takes the legacy code path and rate limits are wrong for master agents. Both fixes are trivial (~10 min total).
