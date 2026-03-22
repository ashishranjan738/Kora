# Kora Dogfooding Session Report — 2026-03-22

**Session:** karodev (8 agents, all claude-code)
**Duration:** ~4 hours (18:00 - 22:00 UTC)
**Team:** Engineering Manager (master), Product Manager, Researcher, Dev 1, Dev 2, Dev 3, Tester, Reviewer

---

## Executive Summary

First large-scale dogfooding session running 8 Kora agents on Kora itself. Discovered **50+ bugs** across security, messaging, UI, backend, and testing infrastructure. Merged **13+ PRs** fixing critical issues. The platform proved stable enough to sustain 8 concurrent agents for 4+ hours while actively finding and fixing its own bugs.

---

## Round 1: Initial Bug Hunt (18:00 - 19:30)

### Researcher Findings
| # | Bug | Severity | Source | Status |
|---|-----|----------|--------|--------|
| 1 | Double unread notification on every MCP tool response | P1 | MCP audit | Fixed (PR #281) |
| 2 | Broadcast self-delivery — sender sees own broadcast | P1 | MCP audit | Fixed (PR #281) |
| 3 | Conversation loop limit (8/2min) uses bidirectional key | P2 | MCP audit | Documented |
| 4 | check_messages dedup uses content prefix, not message ID | P2 | MCP audit | Documented |
| 5 | @mention auto-relay disabled in MCP mode (no fallback) | P2 | MCP audit | Documented |
| 6 | countUnreadMessages HTTP call on every tool response | P3 | MCP audit | Documented |
| 7 | Critical messages bypass queue (no rate limit) | P2 | MCP audit | Documented |
| 8 | TTL expiry scan has dead code (while/break) | LOW | MCP audit | Documented |
| 9 | Race condition in check_messages multi-source reads | P2 | MCP audit | Documented |
| 10 | worktreeInfo map in-memory only — lost on restart | P1 | Worktree spec | Fixed (PR #279) |

### PRs Merged (Round 1)
| PR | Title | Fixes |
|----|-------|-------|
| #276 | Shell injection, HMAC bypass, MCP role perms, port fallback, unread count | 5 security/backend fixes |
| #277 | Session DELETE dead code, SQL params, EventLog dupe, invalid status | 4 API audit fixes |
| #278 | 5 HIGH UI bugs + 2 polish fixes | 7 UI fixes |
| #279 | Stale worktree cleanup (pruneAll, stopAgent, session delete, startup) | Worktree resource leak |
| #280 | P0 idle detection (spinners, false positives, frozen timestamps) + workflow | Idle detection + workflow |
| #281 | Broadcast self-delivery + double notification fixes | 2 messaging fixes |
| #282 | 146 test fixes (99% pass rate) | Test infrastructure |

---

## Round 2: Post-Merge Verification (19:30 - 20:30)

### Researcher Findings
| # | Bug | Severity | Source | Status |
|---|-----|----------|--------|--------|
| 11 | Cost tracking empty — Claude Code doesn't show tokens in terminal | P1 | Cost audit | Documented |
| 12 | Utilization always 100% — system messages change activity hash | P2 | Cost audit | Documented |
| 13 | lastActivityAt only updates on state transitions, not continuously | P1 | Direct investigation | Fixed (PR #280) |
| 14 | registerMcpAgent() missing from restore flow | P1 | Restart audit | Fixed (PR #283) |
| 15 | registerAgentRole() missing from restore flow | P2 | Restart audit | Fixed (PR #283) |
| 16 | Vitest worktree pollution — 4757 test files instead of ~80 | P0 | Test audit | Fixed (PR #284) |
| 17 | TimelineFilters mock misalignment (7 test failures) | P1 | Test audit | Documented |

### PRs Merged (Round 2)
| PR | Title | Fixes |
|----|-------|-------|
| #283 | Restore flow: register MCP agents + roles after restart | 2 restart bugs |
| #284 | Vitest exclude patterns for worktrees | Test infrastructure |

---

## Round 3: Deep Bug Hunt (20:30 - 22:00)

### Researcher Findings
| # | Bug | Severity | Source | Status |
|---|-----|----------|--------|--------|
| 18 | cleanupAllPipeProcesses() never called during shutdown | P1 | Holdpty audit | Documented |
| 19 | Capture cache leak for crashed sessions | P2 | Holdpty audit | Documented |
| 20 | sendKeys \r could auto-confirm dangerous prompts | MEDIUM | Holdpty audit | Documented |
| 21 | Dead code: unused originalOnMessage in PtyManager | LOW | Holdpty audit | Documented |

### PRs Merged (Round 3)
| PR | Title | Fixes |
|----|-------|-------|
| #285 | Broadcast persistent storage | Broadcast delivery |
| #286+ | Various additional fixes from Dev 1-3, Tester | Multiple |

---

## Research Deliverables

| Document | Location | Content |
|----------|----------|---------|
| MCP Messaging Audit | `docs/audit-mcp-messaging-2026-03-22.md` | 9 bugs, rate limiting analysis, architecture assessment |
| Worktree Cleanup Spec | `docs/spec-worktree-cleanup-2026-03-22.md` | Root cause, 5-step implementation plan, safety considerations |
| Cost Tracking Audit | `docs/audit-cost-tracking-2026-03-22.md` | parseOutput gap, utilization false positives, 4 fix recommendations |
| Restart/Restore Audit | `docs/audit-daemon-restart-restore-2026-03-22.md` | 2 registration bugs, state persistence completeness analysis |
| Test Failures Audit | `docs/audit-test-failures-2026-03-22.md` | Vitest worktree pollution, 18 real failures categorized |
| Holdpty Terminal Audit | `docs/audit-holdpty-terminal-2026-03-22.md` | 4 bugs, performance analysis, connection cleanup matrix |

---

## Remaining Issues (Not Yet Fixed)

### P1 — Should fix soon
- Cost tracking empty for Claude Code (parseOutput can't see tokens in terminal)
- cleanupAllPipeProcesses() never called during shutdown
- TimelineFilters/TimelineView test mock misalignment (11 test failures)

### P2 — Should fix
- Conversation loop limit too restrictive for master agents (8/2min bidirectional)
- check_messages dedup uses content prefix instead of message ID
- @mention auto-relay disabled in MCP mode (no fallback)
- Capture cache leak for crashed holdpty sessions
- registerAgentRole not called in normal agent-spawned handler (only playbook)
- Utilization always 100% (system messages pollute activity hash)

### P3 — Nice to have
- countUnreadMessages HTTP call on every MCP tool response (perf)
- Critical messages bypass queue without rate limiting
- sendKeys \r could auto-confirm prompts (add noEnter option)
- Dead code cleanup (TTL while/break, unused variable)

---

## Key Metrics

- **Total bugs found:** 50+ across all agents
- **Researcher bugs found:** 21 (detailed above)
- **PRs merged:** 13+
- **Test fixes:** 146 tests fixed
- **Pass rate improvement:** → 99%
- **Agents running concurrently:** 8 for 4+ hours
- **Zero downtime incidents** during dogfooding (daemon stable)
- **Inter-agent messaging:** Confirmed working across all 3 rounds

---

## Lessons Learned

1. **Worktree pollution is real** — Running agents with git worktrees means vitest/build tools can accidentally scan all worktrees. Exclude patterns must be comprehensive.

2. **In-memory state is fragile** — Multiple bugs (worktreeInfo, mcpAgents, agentRoles) traced to in-memory-only maps that are lost on daemon restart. Consider persisting critical state to disk or SQLite.

3. **Activity detection is hard** — Terminal text hashing is noisy. System-injected messages (notifications, broadcasts, nudges) pollute the hash. MCP tool call timestamps are a more reliable signal.

4. **The 3-tier message fallback works** — SQLite → mcp-pending files → inbox files. Even with registration bugs after restart, messages still delivered via fallback paths. Defense in depth pays off.

5. **Dogfooding finds bugs that tests don't** — 8 agents actively using MCP tools, sending messages, and managing tasks exposed race conditions, resource leaks, and edge cases that unit tests couldn't catch.
