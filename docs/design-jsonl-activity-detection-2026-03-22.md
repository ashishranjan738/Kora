# Design: JSONL-Based Activity Detection

**Date:** 2026-03-22
**Author:** Researcher (researcher-4ccd5a6b)
**Task:** 4f050c4d — Agent activity detection from JSONL
**Depends on:** Dev 1's JSONL reader module

---

## Problem

Terminal hash-based activity detection has accuracy issues:
- System messages (notifications, broadcasts) pollute the hash → false "working"
- holdpty capturePane strips whitespace inconsistently → false state changes
- No way to distinguish "thinking" from "idle at prompt" without pattern matching
- Token/cost data unavailable (parseOutput can't see spinner text reliably)

## Discovery: Claude Code JSONL Format

Claude Code writes structured JSONL to `~/.claude/projects/{path-encoded-cwd}/{sessionId}.jsonl`.

### File Location Pattern
```
~/.claude/projects/-Users-{user}-Projects-Kora--kora-{dev-}sessions-{sessionId}-worktrees-{agentId}/{claudeSessionId}.jsonl
```

The CWD is path-encoded (slashes → dashes, leading dash). The Claude session ID is a UUID.

### Entry Types (from real data analysis)
| Type | Count (sample) | Contains stop_reason | Description |
|------|---------------|---------------------|-------------|
| `assistant` | 311 | YES | LLM responses — the key entries |
| `user` | 195 | No | User/system prompts |
| `progress` | 83 | No | Tool execution progress |
| `file-history-snapshot` | 20 | No | File state snapshots |
| `queue-operation` | 14 | No | Internal queue operations |
| `system` | 8 | No | System messages |

### The `message.stop_reason` Field
Located at `entry.message.stop_reason` (NOT top-level):

| Value | Count | Meaning | Maps to Activity |
|-------|-------|---------|-----------------|
| `tool_use` | 172 (93%) | Agent invoked a tool (Read, Write, Bash, etc.) | **WORKING** |
| `end_turn` | 12 (7%) | Agent finished responding, waiting for input | **IDLE** |
| `null/missing` | (streaming) | Response still being generated | **THINKING** |

### The `message.usage` Field — Exact Token Counts
```json
{
  "input_tokens": 1,
  "cache_creation_input_tokens": 410,
  "cache_read_input_tokens": 186540,
  "output_tokens": 445
}
```

This gives us **exact** token usage per turn — far better than spinner parsing or tiktoken estimation.

---

## Design: 4-Layer Activity Detection

Replace the current terminal-only approach with a layered system:

```
Layer 1 (highest): MCP report_idle / completion message → instant idle (EXISTING)
Layer 2 (NEW):     JSONL stop_reason → most accurate for claude-code agents
Layer 3 (existing): Terminal prompt pattern matching → fallback for non-claude-code
Layer 4 (existing): Terminal hash change detection → lowest confidence fallback
```

### New Component: JsonlActivityWatcher

```typescript
// packages/daemon/src/core/jsonl-activity-watcher.ts

interface JsonlState {
  lastEntryTimestamp: number;
  lastStopReason: string | null;  // "end_turn" | "tool_use" | null
  lastFileSize: number;
  totalInputTokens: number;
  totalOutputTokens: number;
  totalCacheReadTokens: number;
}

export class JsonlActivityWatcher {
  private states = new Map<string, JsonlState>();
  private intervals = new Map<string, NodeJS.Timeout>();

  /** Start watching an agent's JSONL file */
  startWatching(agentId: string, jsonlPath: string): void;

  /** Get current activity state from JSONL */
  getActivity(agentId: string): { activity: AgentActivity; tokenUsage: TokenUsage } | null;

  /** Stop watching */
  stopWatching(agentId: string): void;
}
```

### Detection Logic

Poll JSONL file every 3 seconds (same as terminal polling):

```typescript
async pollJsonl(agentId: string): Promise<void> {
  const state = this.states.get(agentId);
  const stat = await fs.stat(jsonlPath);

  // Fast path: file hasn't changed
  if (stat.size === state.lastFileSize) {
    // No new entries — check how long since last entry
    const silenceMs = Date.now() - state.lastEntryTimestamp;

    if (state.lastStopReason === "end_turn" && silenceMs > 5000) {
      // end_turn + 5s silence = IDLE (agent finished, waiting for input)
      return { activity: "idle" };
    }
    if (state.lastStopReason === "tool_use" && silenceMs > 30000) {
      // tool_use + 30s silence = likely IDLE (tool finished, agent thinking?)
      // Could also be long-running tool — fallback to terminal detection
      return null; // Let terminal detection decide
    }
    return null; // No change, defer to other layers
  }

  // File changed — read new entries from last known position
  const newEntries = await readNewEntries(jsonlPath, state.lastFileSize);
  state.lastFileSize = stat.size;

  for (const entry of newEntries) {
    if (entry.type === "assistant" && entry.message?.stop_reason) {
      state.lastStopReason = entry.message.stop_reason;
      state.lastEntryTimestamp = new Date(entry.timestamp).getTime();

      // Accumulate token usage
      const usage = entry.message.usage;
      if (usage) {
        state.totalInputTokens += (usage.input_tokens || 0) + (usage.cache_read_input_tokens || 0);
        state.totalOutputTokens += usage.output_tokens || 0;
        state.totalCacheReadTokens += usage.cache_read_input_tokens || 0;
      }
    }
  }

  // Determine activity from latest stop_reason
  if (state.lastStopReason === "tool_use") {
    return { activity: "working" };
  }
  if (state.lastStopReason === "end_turn") {
    return { activity: "idle" };
  }
  // Streaming (no stop_reason yet)
  return { activity: "working" };  // Thinking/streaming = working
}
```

### Integration with AgentHealthMonitor

Modify `checkIdleState()` in `agent-health.ts` to check JSONL first:

```typescript
private async checkIdleState(agentId: string, tmuxSession: string): Promise<void> {
  const agent = this.agents?.get(agentId);
  if (!agent) return;

  // Layer 1: MCP idle protection (existing — unchanged)
  if (this.isMcpIdleProtected(agentId)) return;

  // Layer 2 (NEW): JSONL-based detection for claude-code agents
  if (this.jsonlWatcher) {
    const jsonlState = this.jsonlWatcher.getActivity(agentId);
    if (jsonlState) {
      // JSONL provides definitive state — override terminal detection
      if (jsonlState.activity === "idle" && agent.activity !== "idle") {
        agent.activity = "idle";
        agent.lastActivityAt = new Date().toISOString();
        agent.idleSince = new Date().toISOString();
        this.emit("agent-idle", agentId);
      } else if (jsonlState.activity === "working" && agent.activity !== "working") {
        agent.activity = "working";
        agent.lastActivityAt = new Date().toISOString();
        delete agent.idleSince;
        this.emit("agent-working", agentId);
      }

      // Update cost tracker with exact token counts
      if (jsonlState.tokenUsage) {
        this.emit("token-update", agentId, jsonlState.tokenUsage);
      }
      return;  // JSONL is authoritative — skip terminal detection
    }
  }

  // Layer 3+4: Terminal-based detection (existing — unchanged, used as fallback)
  // ... existing checkIdleState logic ...
}
```

### Finding the JSONL Path

The JSONL path depends on the agent's CWD (worktree path). We need to:

1. Encode the agent's `workingDirectory` the same way Claude Code does (slashes → dashes)
2. Find the latest `.jsonl` file in the resulting directory

```typescript
function findJsonlPath(workingDirectory: string): string | null {
  const homedir = os.homedir();
  // Claude Code encodes CWD: /Users/foo/Projects/Bar → -Users-foo-Projects-Bar
  const encoded = workingDirectory.replace(/\//g, '-');
  const projectDir = path.join(homedir, '.claude', 'projects', encoded);

  if (!fs.existsSync(projectDir)) return null;

  // Find the most recently modified .jsonl file
  const files = fs.readdirSync(projectDir)
    .filter(f => f.endsWith('.jsonl'))
    .map(f => ({ name: f, mtime: fs.statSync(path.join(projectDir, f)).mtimeMs }))
    .sort((a, b) => b.mtime - a.mtime);

  return files.length > 0 ? path.join(projectDir, files[0].name) : null;
}
```

### Cost Tracking Integration

The JSONL `message.usage` field provides exact token counts per turn. Wire into CostTracker:

```typescript
// In orchestrator.ts, when setting up JsonlActivityWatcher:
jsonlWatcher.on("token-update", (agentId, usage) => {
  this.costTracker.updateFromOutput(agentId, {
    tokenUsage: {
      input: usage.totalInputTokens,
      output: usage.totalOutputTokens,
    },
    // Calculate cost from model pricing
    costUsd: estimateCostFromUsage(usage, agentModel),
  });
});
```

---

## Files to Create/Modify

| File | Change | Effort |
|------|--------|--------|
| `packages/daemon/src/core/jsonl-activity-watcher.ts` | **NEW** — JSONL file watcher + parser | 45 min |
| `packages/daemon/src/core/agent-health.ts` | Add Layer 2 JSONL check before terminal detection | 15 min |
| `packages/daemon/src/core/orchestrator.ts` | Wire JsonlActivityWatcher into agent lifecycle | 15 min |
| `packages/daemon/src/core/cost-tracker.ts` | Accept exact token counts from JSONL | 10 min |

**Total effort:** ~1.5 hours

---

## Advantages Over Terminal Detection

| Aspect | Terminal (current) | JSONL (proposed) |
|--------|-------------------|------------------|
| Idle detection | Pattern matching + 30s timeout | `end_turn` + 5s silence = instant |
| Working detection | Hash change (noisy) | `tool_use` = definitive |
| Thinking detection | Spinner patterns (fragile) | No stop_reason yet = streaming |
| Token counts | Spinner parsing / tiktoken estimate | Exact from `message.usage` |
| Cost calculation | ~20% error margin | Exact per-turn data |
| System message noise | Must filter notifications | Not affected (JSONL is agent-only) |
| Provider support | All providers | Claude Code only (others use terminal fallback) |

---

## Edge Cases

1. **Non-claude-code agents** — JSONL only works for Claude Code. Aider/Codex/Kiro/Goose agents fall back to terminal detection (Layer 3+4). No change for them.

2. **JSONL file not found** — Agent may not have started yet, or CWD encoding differs. Return null, fall back to terminal.

3. **Multiple JSONL files** — Agent may have been restarted. Use the most recently modified file.

4. **Large JSONL files** — Only read new bytes since last poll (seek to `lastFileSize`). No need to re-parse entire file.

5. **Permission issues** — `~/.claude/` is user-owned. The daemon runs as the same user, so no permission issues.
