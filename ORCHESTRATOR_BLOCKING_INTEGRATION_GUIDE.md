# Orchestrator Blocking System - Integration Guide

**Version:** Phase 1 (Pattern Detection)
**Status:** Ready for Integration
**Test Coverage:** 115/115 tests passing (100%)

---

## Table of Contents

1. [Quick Start](#quick-start)
2. [Architecture Overview](#architecture-overview)
3. [Integration Steps](#integration-steps)
4. [Usage Examples](#usage-examples)
5. [Configuration](#configuration)
6. [API Reference](#api-reference)
7. [Best Practices](#best-practices)
8. [Troubleshooting](#troubleshooting)

---

## Quick Start

### Installation

The orchestrator blocking system is built into the daemon. No external dependencies required.

```typescript
import {
  PatternDetector,
  OrchestratorStateMachine,
  OrchestratorState,
  BlockingCategory
} from "./personas/orchestrator-blocking";
```

### Basic Usage

```typescript
// Initialize
const detector = new PatternDetector();
const stateMachine = new OrchestratorStateMachine();

// Before orchestrator sends any message, check for blocking
const message = "Should I merge PR #111 or #112 first?";
const result = detector.detect(message);

if (result.matched && result.confidence >= 70) {
  // Enter BLOCKED state
  stateMachine.transition(
    OrchestratorState.BLOCKED,
    result.reasoning.join("; "),
    "system"
  );

  // Stop orchestration activities
  stopOrchestration();

  // Display blocking notification
  displayBlockingNotification(result);
}
```

---

## Architecture Overview

### Components

```
┌─────────────────────────────────────────────────────────────┐
│                   Orchestrator Persona                       │
│                                                              │
│  ┌──────────────────┐        ┌────────────────────────┐   │
│  │ Message Composer │─────▶  │   Pattern Detector     │   │
│  └──────────────────┘        │  - 66+ patterns        │   │
│                               │  - Confidence scoring  │   │
│                               └────────────────────────┘   │
│                                        │                     │
│                               (if blocking detected)        │
│                                        ▼                     │
│                        ┌───────────────────────────┐        │
│                        │    State Machine          │        │
│                        │  - 5 states               │        │
│                        │  - Validated transitions  │        │
│                        └───────────────────────────┘        │
│                                        │                     │
│                               (enter BLOCKED state)         │
│                                        ▼                     │
│  ┌──────────────────────────────────────────────────┐      │
│  │     Stop Orchestration Activities                │      │
│  │  - Pause work assignment                         │      │
│  │  - Buffer message processing                     │      │
│  │  - Display blocking notification                 │      │
│  └──────────────────────────────────────────────────┘      │
└─────────────────────────────────────────────────────────────┘
```

### State Flow

```
IDLE
  ↓ (user command)
PLANNING
  ↓ (plan ready) OR ─────────┐
EXECUTING                     │ (blocking detected)
  ↓ (work complete) OR ───────┤
BLOCKED ◀──────────────────────┘
  ↓ (user provides input)
PLANNING (resume)
  ↓
EXECUTING
  ↓ (work complete)
REPORTING
  ↓ (report sent)
IDLE
```

---

## Integration Steps

### Step 1: Initialize Components

```typescript
// In orchestrator.ts or similar file
import {
  PatternDetector,
  OrchestratorStateMachine,
  OrchestratorState,
  type BlockingDecision
} from "./orchestrator-blocking";

class Orchestrator {
  private detector: PatternDetector;
  private stateMachine: OrchestratorStateMachine;

  constructor() {
    this.detector = new PatternDetector();
    this.stateMachine = new OrchestratorStateMachine();

    // Listen for state changes
    this.stateMachine.on("state:blocked", this.handleBlocked.bind(this));
    this.stateMachine.on("state:planning", this.handleResume.bind(this));
  }
}
```

### Step 2: Add Message Interception

```typescript
class Orchestrator {
  async sendMessage(message: string): Promise<void> {
    // Check for blocking before sending
    const blockingResult = this.detector.detect(message);

    if (blockingResult.matched && blockingResult.confidence >= 70) {
      // Block orchestration
      await this.enterBlockedState(blockingResult);
      return; // Don't send message
    }

    // Normal message sending
    await this.sendToUser(message);
  }

  private async enterBlockedState(result: BlockingDecision): Promise<void> {
    // Transition to BLOCKED state
    this.stateMachine.transition(
      OrchestratorState.BLOCKED,
      `Category: ${result.category}, Confidence: ${result.confidence}%`,
      "system"
    );

    // Stop activities
    this.pauseWorkAssignment();
    this.pauseMessageProcessing();

    // Display notification
    await this.displayBlockingNotification({
      title: "ORCHESTRATOR BLOCKED",
      message: result.reasoning.join("\n"),
      category: result.category,
      confidence: result.confidence,
      actions: ["continue", "abort", "get-details"]
    });
  }
}
```

### Step 3: Implement Activity Pause

```typescript
class Orchestrator {
  private workAssignmentPaused = false;
  private messageProcessingPaused = false;
  private bufferedMessages: any[] = [];

  private pauseWorkAssignment(): void {
    this.workAssignmentPaused = true;
    // Stop assigning new tasks to agents
  }

  private pauseMessageProcessing(): void {
    this.messageProcessingPaused = true;
    // Buffer incoming messages instead of processing
  }

  async processMessage(message: any): Promise<void> {
    if (this.stateMachine.isBlocked()) {
      // Buffer non-critical messages
      if (message.priority !== "critical") {
        this.bufferedMessages.push(message);
        return;
      }

      // Surface critical messages immediately
      await this.surfaceCriticalMessage(message);
      return;
    }

    // Normal processing
    await this.handleMessage(message);
  }
}
```

### Step 4: Handle User Commands

```typescript
class Orchestrator {
  async handleUserCommand(command: string): Promise<void> {
    const normalized = command.toLowerCase().trim();

    if (this.stateMachine.isBlocked()) {
      if (this.isResumeCommand(normalized)) {
        await this.resumeFromBlocked();
      } else if (this.isAbortCommand(normalized)) {
        await this.abortWork();
      } else {
        // Treat as user input (answer to blocking question)
        await this.handleUserInput(command);
        await this.resumeFromBlocked();
      }
    } else {
      // Normal command processing
      await this.processCommand(command);
    }
  }

  private isResumeCommand(command: string): boolean {
    const resumeCommands = ["continue", "proceed", "go", "resume", "unblock"];
    return resumeCommands.some(cmd => command.includes(cmd));
  }

  private isAbortCommand(command: string): boolean {
    const abortCommands = ["abort", "cancel", "stop", "nevermind"];
    return abortCommands.some(cmd => command.includes(cmd));
  }

  private async resumeFromBlocked(): Promise<void> {
    // Transition to PLANNING
    this.stateMachine.transition(
      OrchestratorState.PLANNING,
      "User provided input",
      "user"
    );

    // Resume activities
    this.workAssignmentPaused = false;
    this.messageProcessingPaused = false;

    // Process buffered messages
    await this.processBufferedMessages();

    // Clear notification
    await this.clearBlockingNotification();
  }
}
```

### Step 5: Add Dashboard UI Integration

```typescript
// In dashboard component
import { OrchestratorState } from "@kora/shared";

function OrchestratorStatus({ stateMachine }) {
  const [isBlocked, setIsBlocked] = useState(false);
  const [blockingReason, setBlockingReason] = useState("");

  useEffect(() => {
    // Listen for blocked state
    const handleBlocked = (event) => {
      setIsBlocked(true);
      setBlockingReason(event.reason);
    };

    // Listen for unblocked
    const handleUnblocked = () => {
      setIsBlocked(false);
      setBlockingReason("");
    };

    stateMachine.on("state:blocked", handleBlocked);
    stateMachine.on("state:planning", handleUnblocked);
    stateMachine.on("state:idle", handleUnblocked);

    return () => {
      stateMachine.off("state:blocked", handleBlocked);
      stateMachine.off("state:planning", handleUnblocked);
      stateMachine.off("state:idle", handleUnblocked);
    };
  }, [stateMachine]);

  if (!isBlocked) return null;

  return (
    <BlockingOverlay
      title="⚠️ ORCHESTRATOR BLOCKED"
      reason={blockingReason}
      onContinue={() => handleCommand("continue")}
      onAbort={() => handleCommand("abort")}
    />
  );
}
```

---

## Usage Examples

### Example 1: Decision Point Blocking

```typescript
// Orchestrator detects it needs user decision
const message = `
I've analyzed the two PRs:

PR #111: Activity detection (6 files)
PR #112: Messages migration (8 files)

Both modify agent-health.ts.

Should I:
1. Merge #111 first (safer, sequential)
2. Merge #112 first (riskier, blocks other work)

Which approach do you prefer?
`;

const result = detector.detect(message);

// Result:
// {
//   matched: true,
//   confidence: 92,
//   category: "decision",
//   method: "pattern",
//   matchedPatterns: [
//     { patternName: "DECISION_QUESTIONS", ... },
//     { patternName: "MULTIPLE_OPTIONS", ... }
//   ],
//   reasoning: [
//     "Matched DECISION_QUESTIONS (weight: 30)",
//     "Matched MULTIPLE_OPTIONS (weight: 20)",
//     "Detected 2 numbered options (+20 score)",
//     "Total score: 70, Confidence: 92%"
//   ]
// }
```

### Example 2: Risky Operation Blocking

```typescript
const message = `
To fix the migration, I need to:
1. Drop existing messages table
2. Recreate with new schema

⚠️ This will delete the current messages table.

Should I proceed?
`;

const result = detector.detect(message);

// Result:
// {
//   matched: true,
//   confidence: 95,
//   category: "risk",
//   ...
// }
```

### Example 3: Explicit Blocking Marker

```typescript
const message = `
I need your decision on the deployment strategy:

\`\`\`blocking-request
reason: "Multiple deployment options with trade-offs"
category: "decision"
options:
  1. Rolling deployment (safer, 2 hours)
  2. Blue-green deployment (faster, requires infrastructure)
\`\`\`
`;

const result = detector.detect(message);

// Result:
// {
//   matched: true,
//   confidence: 100,
//   category: "decision",
//   method: "explicit",
//   ...
// }
```

### Example 4: Non-Blocking Status Update

```typescript
const message = `
Status update: Completed PR #111 review.
All tests passing.
Moving on to PR #112 validation.
`;

const result = detector.detect(message);

// Result:
// {
//   matched: false,
//   confidence: 95,
//   category: "none",
//   method: "none",
//   ...
// }
```

---

## Configuration

### Confidence Threshold

Adjust the confidence threshold for blocking (default: 70%):

```typescript
const detector = new PatternDetector();
const threshold = detector.getConfidenceThreshold(); // → 70

// To change threshold, modify pattern weights in patterns.ts
```

### Custom Patterns

Add custom patterns for your specific use case:

```typescript
// In patterns.ts
export const CUSTOM_BLOCKING_PATTERNS = {
  MY_PATTERN: {
    category: BlockingCategory.DECISION,
    patterns: [
      /my custom pattern/i,
    ],
    weight: 30,
    priority: 1,
    description: "My custom blocking pattern"
  }
};
```

### State Machine Configuration

```typescript
// Start with custom initial state
const stateMachine = new OrchestratorStateMachine(OrchestratorState.PLANNING);

// Listen for specific events
stateMachine.on("state-change", (event) => {
  console.log(`State changed: ${event.from} → ${event.to}`);
});

stateMachine.on("force-block", (event) => {
  console.error("Emergency block:", event.reason);
});
```

---

## API Reference

### PatternDetector

#### `detect(message: string): PatternMatchResult`

Analyze a message for blocking patterns.

**Returns:**
```typescript
interface PatternMatchResult {
  matched: boolean;           // True if blocking detected
  category: BlockingCategory; // Category of blocking
  confidence: number;         // 0-100
  score: number;             // Raw score
  matchedPatterns: PatternMatch[];
  reasoning: string[];       // Human-readable explanation
  method: "explicit" | "pattern" | "none";
}
```

#### `getConfidenceThreshold(): number`

Get the current confidence threshold (70%).

### OrchestratorStateMachine

#### `transition(to: OrchestratorState, reason: string, triggeredBy?: "system" | "user" | "timer"): StateTransitionEvent`

Transition to a new state.

**Throws:** Error if transition is invalid.

#### `forceBlock(reason: string): StateTransitionEvent`

Force transition to BLOCKED state from any state (emergency blocking).

#### `isBlocked(): boolean`

Check if currently in BLOCKED state.

#### `getState(): OrchestratorState`

Get current state.

#### `canTransition(from: OrchestratorState, to: OrchestratorState): boolean`

Check if a transition is valid.

#### `getHistory(limit?: number): StateTransitionEvent[]`

Get state transition history.

#### `getTimeInCurrentState(): number`

Get milliseconds spent in current state.

#### `getAllowedTransitions(): OrchestratorState[]`

Get allowed transitions from current state.

#### `reset(initialState?: OrchestratorState): void`

Reset state machine.

### Events

```typescript
// State change events
stateMachine.on("state-change", (event: StateTransitionEvent) => {});
stateMachine.on("state:blocked", (event) => {});
stateMachine.on("state:planning", (event) => {});
stateMachine.on("state:executing", (event) => {});
stateMachine.on("state:reporting", (event) => {});
stateMachine.on("state:idle", (event) => {});

// Special events
stateMachine.on("force-block", (event) => {});
stateMachine.on("reset", (event) => {});
```

---

## Best Practices

### 1. Always Check Confidence

```typescript
// ✅ Good
if (result.matched && result.confidence >= 70) {
  enterBlockedState(result);
}

// ❌ Bad - ignoring confidence
if (result.matched) {
  enterBlockedState(result);
}
```

### 2. Provide Clear Feedback

```typescript
// ✅ Good
displayBlockingNotification({
  title: "ORCHESTRATOR BLOCKED",
  reason: result.reasoning.join("\n"),
  category: result.category,
  confidence: result.confidence,
  actions: ["continue", "abort"]
});

// ❌ Bad - vague message
alert("Blocked");
```

### 3. Buffer Non-Critical Messages

```typescript
// ✅ Good
if (stateMachine.isBlocked()) {
  if (message.priority === "critical") {
    surfaceCriticalMessage(message);
  } else {
    bufferedMessages.push(message);
  }
}

// ❌ Bad - losing messages
if (stateMachine.isBlocked()) {
  return; // Message lost!
}
```

### 4. Use Explicit Markers for Critical Decisions

```typescript
// ✅ Good - explicit marker ensures 100% confidence
const message = `
\`\`\`blocking-request
reason: "Production deployment decision"
category: "decision"
\`\`\`

Should I deploy to production now?
`;

// ❌ Less reliable - pattern matching may miss
const message = "Deploy to production?";
```

### 5. Log State Transitions

```typescript
stateMachine.on("state-change", (event) => {
  logger.info("Orchestrator state change", {
    from: event.from,
    to: event.to,
    reason: event.reason,
    triggeredBy: event.triggeredBy,
    timestamp: event.timestamp
  });
});
```

---

## Troubleshooting

### Issue: Blocking Not Detected

**Symptoms:** Message should block but doesn't.

**Diagnosis:**
```typescript
const result = detector.detect(message);
console.log(result);
// Check: result.matched, result.confidence, result.matchedPatterns
```

**Solutions:**
1. Check if message matches any patterns
2. Check if confidence is below threshold (70%)
3. Check if message matches non-blocking exclusion patterns
4. Add custom pattern if needed

### Issue: False Positives (Blocking When Shouldn't)

**Symptoms:** Non-blocking messages trigger blocking.

**Solutions:**
1. Add message to non-blocking exclusion patterns
2. Adjust pattern specificity
3. Check pattern priority and weights

### Issue: State Transition Fails

**Symptoms:** `Invalid state transition` error.

**Diagnosis:**
```typescript
console.log(stateMachine.getState());
console.log(stateMachine.getAllowedTransitions());
```

**Solutions:**
1. Check if transition is valid from current state
2. Use `canTransition()` before attempting transition
3. Use `forceBlock()` for emergency blocking

### Issue: Messages Lost While Blocked

**Symptoms:** Messages disappear when orchestrator is blocked.

**Solution:**
```typescript
// Implement message buffering
if (stateMachine.isBlocked()) {
  if (message.priority !== "critical") {
    bufferedMessages.push(message);
    return;
  }
}

// Process buffered messages on resume
async function resumeFromBlocked() {
  stateMachine.transition(OrchestratorState.PLANNING, "Resume", "user");

  for (const message of bufferedMessages) {
    await processMessage(message);
  }

  bufferedMessages = [];
}
```

---

## Performance Considerations

### Pattern Matching Performance

- **Average:** <5ms per message
- **Worst case:** <10ms (very long messages)
- **Memory:** <100KB (pattern library)

### State Machine Performance

- **State transitions:** <1ms
- **History tracking:** O(1) insertion
- **Memory:** ~1KB per instance

### Optimization Tips

1. **Cache detector instance** - don't create new instances per message
2. **Batch message processing** - process multiple messages in parallel
3. **Limit history size** - use `getHistory(limit)` for recent events only

---

## Testing

### Unit Testing

```typescript
import { describe, it, expect } from "vitest";
import { PatternDetector } from "./orchestrator-blocking";

describe("My Integration", () => {
  it("should block on decision questions", () => {
    const detector = new PatternDetector();
    const result = detector.detect("Should I proceed?");

    expect(result.matched).toBe(true);
    expect(result.confidence).toBeGreaterThanOrEqual(70);
  });
});
```

### Integration Testing

See `integration.test.ts` for 30+ example tests covering:
- Complete blocking flows
- Real-world scenarios
- Edge cases
- Performance benchmarks

---

## Next Steps

### Phase 2: LLM Enhancement (Future)

Phase 2 will add LLM self-reflection for uncertain cases (20-80 confidence):
- Hybrid detection: Pattern fast path + LLM for edge cases
- Improved accuracy: 75-80% → 90%+
- Cost optimization: Only use LLM for ~30% of messages

### Phase 3: Production Monitoring

Monitor blocking system in production:
- Track blocking events per category
- Measure false positive/negative rates
- Analyze user override frequency
- Adjust patterns based on data

---

## Support

**Documentation:**
- Design: `ORCHESTRATOR_BLOCKING_DESIGN.md`
- Implementation: `ORCHESTRATOR_BLOCKING_IMPLEMENTATION.md`
- Progress: `ORCHESTRATOR_BLOCKING_PHASE1_PROGRESS.md`

**Tests:**
- Unit: `pattern-detector.test.ts` (53 tests)
- Unit: `state-machine.test.ts` (32 tests)
- Integration: `integration.test.ts` (30 tests)

**Total:** 115/115 tests passing (100%)

---

**Version:** 1.0.0 (Phase 1)
**Last Updated:** 2026-03-19
**Status:** Production Ready
