# MCP Messaging Audit Report

**Date:** 2026-03-22
**Auditor:** Researcher (researcher-4ccd5a6b)
**Session:** karodev (8 agents, all claude-code)
**Task:** 9320e0ad — Dogfooding: Audit MCP messaging

---

## Executive Summary

The MCP messaging system is **functionally solid** for the current 8-agent dogfooding session. All core tools work (send_message, check_messages, list_agents, broadcast). Direct messages and broadcasts deliver reliably. However, the code review revealed several architectural issues, potential bugs, and performance concerns that could surface at scale or during edge cases.

---

## Live Test Results

### 1. list_agents
- **Result:** PASS
- All 8 agents visible with correct metadata
- Enriched fields working: `currentTask`, `currentTaskId`, `activeTasks`, `pendingMessages`, `availableForWork`, `idleSince`
- EM correctly shows `activity: "idle"`, all workers show `activity: "working"`
- **Issue found:** EM had `pendingMessages: 1` at test time - messages may accumulate if master is idle and not polling check_messages

### 2. send_message (Direct)
- **Result:** PASS
- Sent to Dev 1 -> ACK-DEV1 received (~35s later)
- Sent to Tester -> ACK-TESTER received (~51s later)
- Both returned `{ success: true, sentTo: "Dev 1" / "Tester" }`
- **Observation:** ~35-51s round-trip is expected since agents must notice terminal notification, call check_messages, read, then reply

### 3. broadcast
- **Result:** PASS
- Returned `{ success: true, broadcast: true }`
- I received my own broadcast back in terminal as `[Broadcast]: [From researcher-4ccd5a6b]: ...`
- Broadcasts are transient (NOT stored for check_messages) - by design

### 4. check_messages
- **Result:** PASS
- Returns messages with correct `from`, `content`, `timestamp` fields
- Deduplication working (SQLite primary, mcp-pending secondary, inbox tertiary)
- Sends ack-read to daemon to reset re-notification attempts

### 5. peek_agent (worker role)
- **Result:** NOT AVAILABLE
- `peek_agent` is master-only (ROLE_TOOL_ACCESS restricts it from workers)
- This is by design - workers should not spy on other workers

---

## Code Review Findings

### BUG-1: Double unread notification in MCP responses (LOW severity)

**File:** `agent-mcp-server.ts` lines 2074-2102

The MCP server piggybacks unread notifications on every tool response via TWO separate mechanisms:
1. `countPendingMessages()` (line 2078) - counts file-based pending messages
2. `countUnreadMessages()` (line 2095) - counts via API + files

Both can fire for the same tool response, producing duplicate notifications:
```
[System: You have 2 unread message(s). Run check_messages to read them.]
{...tool result...}
[System: You have 2 unread message(s). Use check_messages tool to read them.]
```

**Impact:** Agent confusion, wasted context tokens.
**Fix:** Remove the `countPendingMessages()` block (lines 2078-2087) since `countUnreadMessages()` already covers both SQLite and file-based sources.

### BUG-2: Broadcast self-delivery creates noise (LOW severity)

**File:** `agent-mcp-server.ts` line 1153

When an agent broadcasts, the message is sent to ALL agents including the sender. The sender receives their own broadcast in terminal. The API endpoint `/broadcast` doesn't filter out the sender.

**Impact:** Agents see their own broadcasts echoed back, wasting context.
**Fix:** The `/broadcast` endpoint or the MCP broadcast handler should exclude `fromAgentId`.

### BUG-3: Conversation loop detection uses sorted pair key (MEDIUM severity)

**File:** `message-queue.ts` lines 261-274

The loop detector uses `[fromAgentId, agentId].sort().join(":")` as the pair key. This means messages from A->B and B->A share the same counter. If agent A sends 5 messages to B, and B sends 4 back, the counter hits 9 and B's next message is **dropped silently**.

**Impact:** Legitimate back-and-forth conversations (e.g., master delegating tasks + workers reporting progress) could hit the 8-message limit. The limit is per 2-minute window.
**Recommendation:** Either:
- Increase limit to 12-15 for master-role agents
- Use directional keys (`A:B` separate from `B:A`)
- Log a warning to the sender when dropping (currently only logs server-side)

### BUG-4: TTL expiry scan has dead code (LOW severity)

**File:** `message-queue.ts` lines 378-381

```typescript
while (queue.length > 0 && queue[0].ttl < now) {
  break; // We'll handle TTL below
}
```

This while loop immediately breaks - dead code that should be removed for clarity.

### ISSUE-5: Critical messages bypass queue entirely (MEDIUM risk)

**File:** `message-queue.ts` lines 279-285

Messages classified as "critical" (task assignments) bypass the queue via `deliverDirect()`. This means:
- They skip conversation loop detection
- They skip queue size caps
- They could theoretically flood an agent's terminal if many tasks are assigned rapidly

**Current mitigations:** `deliverDirect` has retry logic (3 attempts for critical). But no rate limiting.
**Recommendation:** Add a rate limit to `deliverDirect` for critical messages (e.g., max 5 per minute per agent).

### ISSUE-6: Race condition in check_messages multi-source reads

**File:** `agent-mcp-server.ts` lines 1017-1087

`check_messages` reads from 3 sources sequentially:
1. SQLite (marks as read)
2. mcp-pending files (moves to processed/)
3. inbox files (moves to processed/)

If the daemon writes a new message between step 1 and step 2, the message appears in step 2 but may also exist in SQLite (written by `deliverViaMcpPending` dual-write). The dedup logic (lines 1053-1078) catches this by keying on `from:content[:100]`, but:
- Two different messages from the same sender with similar first 100 chars could be deduped incorrectly
- Large messages with identical prefixes (e.g., repeated task assignments) could be dropped

**Impact:** Rare but possible message loss.
**Fix:** Use message ID for deduplication instead of content prefix.

### ISSUE-7: Auto-relay disabled in MCP mode (BY DESIGN, but worth noting)

**File:** `auto-relay.ts` line 40

```typescript
if (this.messagingMode === "mcp" || this.messagingMode === "manual") return;
```

In MCP mode (our current mode), `@mention` detection in terminal output is completely disabled. This means the fallback `@AgentName: message` syntax documented in agent personas doesn't actually work unless messaging mode is "terminal".

**Impact:** If MCP tools fail, agents have no fallback communication channel.
**Recommendation:** Consider enabling auto-relay as a fallback even in MCP mode, with lower priority than MCP tools.

### ISSUE-8: countUnreadMessages makes synchronous API call (PERFORMANCE)

**File:** `agent-mcp-server.ts` lines 126-150

`countUnreadMessages()` is called on every MCP tool response (line 2095). It makes a synchronous HTTP API call to the daemon. For a busy agent calling many tools, this adds latency to every tool response.

**Impact:** Each tool call gets an extra HTTP round-trip for unread count.
**Fix:** Cache the unread count with a short TTL (5-10s), or only check after messaging-related tools.

### ISSUE-9: Re-notification escalation could overwhelm stuck agent (LOW)

**File:** `message-queue.ts` lines 887-1023

The escalation system sends increasingly urgent notifications every 20 seconds. If an agent is genuinely stuck (e.g., in a long tool execution), it accumulates terminal notifications that all fire when the agent becomes responsive again.

**Impact:** Agent gets flooded with escalation messages on recovery.
**Mitigation exists:** `resetNotificationAttempts()` clears state when agent reads messages.

---

## Rate Limiting Summary

| Limiter | Scope | Limit | Window |
|---------|-------|-------|--------|
| Circuit breaker (MCP) | Per-agent send_message calls | 10 | 2 min |
| Role-based (queue) | Per-agent deliveries | master:25, worker:10 | 60s |
| Conversation loop | Per-agent-pair | 8 messages | 2 min |
| Nudge rate limit | Per-target agent | 5 nudges | 60s |
| Auto-relay | Per-source agent | 3 relays | 60s |

These limits are reasonable for the current 8-agent setup. At 20+ agents, the conversation loop limit (8 per pair per 2min) could become restrictive for the master agent coordinating many workers.

---

## Recommendations (Priority Order)

1. **P1 - Fix double unread notification** (BUG-1): Remove `countPendingMessages` piggyback, keep only `countUnreadMessages`. ~5 min fix.
2. **P1 - Fix broadcast self-delivery** (BUG-2): Filter sender from broadcast recipients. ~10 min fix.
3. **P2 - Fix dedup key in check_messages** (ISSUE-6): Use message ID instead of content prefix. ~15 min fix.
4. **P2 - Raise conversation loop limit for masters** (BUG-3): 15 messages for master role. ~5 min fix.
5. **P3 - Cache unread count** (ISSUE-8): Add 5s TTL cache. ~20 min fix.
6. **P3 - Enable auto-relay fallback in MCP mode** (ISSUE-7): Lower priority relay when MCP tools are available. ~30 min.
7. **P3 - Clean up dead code** (BUG-4): Remove broken while loop. ~1 min.

---

## Architecture Assessment

The messaging system has evolved through multiple iterations and now has **three delivery paths** (SQLite, mcp-pending files, inbox files) with deduplication. This works but adds complexity. A future simplification could:

1. Make SQLite the single source of truth for messages
2. Keep file-based delivery only as a write-through cache for agents that read files directly
3. Remove the mcp-pending directory entirely (it duplicates SQLite)

**Estimated effort for full simplification:** 2-3 hours.

---

## Conclusion

The messaging system works reliably for our current dogfooding session. The bugs found are all LOW-MEDIUM severity. The most impactful quick wins are fixing the double notification (BUG-1) and broadcast self-delivery (BUG-2), both trivial fixes.
