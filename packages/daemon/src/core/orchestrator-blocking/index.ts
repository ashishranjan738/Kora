/**
 * Orchestrator Blocking System - Public API
 *
 * Exports all public interfaces and classes for the orchestrator blocking system.
 */

// Types
export {
  OrchestratorState,
  MessagePriority,
  type OrchestratorStateMetadata,
  type BlockingDecision,
  type AgentMessage,
  type BlockingNotification,
  type StateTransitions,
  type BlockingDetectorConfig,
  type BlockingStatistics,
  type UserCommand,
  type StateTransitionEvent
} from "./types.js";

// Pattern Detection
export {
  BlockingCategory,
  BLOCKING_PATTERNS,
  NON_BLOCKING_PATTERNS,
  EXPLICIT_BLOCK_MARKER,
  type PatternDefinition,
  getCategories,
  countPatterns,
  getPatternsByCategory
} from "./detection/patterns.js";

export {
  PatternDetector,
  type PatternMatch,
  type PatternMatchResult
} from "./detection/pattern-detector.js";
