/**
 * TypeScript type definitions for Orchestrator Blocking System
 */

import type { BlockingCategory } from "./detection/patterns.js";

/**
 * Orchestrator state enum
 */
export enum OrchestratorState {
  IDLE = "idle",               // No active work, waiting for user command
  PLANNING = "planning",       // Analyzing requirements, creating work plan
  EXECUTING = "executing",     // Assigning work, monitoring progress
  BLOCKED = "blocked",         // Need user input, stopped all activity
  REPORTING = "reporting"      // Summarizing completed work
}

/**
 * Metadata associated with orchestrator state
 */
export interface OrchestratorStateMetadata {
  state: OrchestratorState;
  since: string; // ISO timestamp
  reason?: string; // For BLOCKED state
  blockingCategory?: BlockingCategory;
  pendingWork?: string[]; // Task IDs
  messagesSinceStateChange: number;
  lastUserInteraction: string; // ISO timestamp
}

/**
 * Blocking decision result
 */
export interface BlockingDecision {
  blocked: boolean;
  confidence: number; // 0-100
  category: BlockingCategory;
  reason: string;
  method: "explicit" | "pattern" | "hybrid" | "none";
}

/**
 * Message priority levels
 */
export enum MessagePriority {
  CRITICAL = "critical",      // Must surface even when blocked
  HIGH = "high",              // Buffer, process on resume
  NORMAL = "normal",          // Buffer, process on resume
  LOW = "low"                 // Buffer, may discard if old
}

/**
 * Agent message structure
 */
export interface AgentMessage {
  from: string;
  to?: string;
  type: string;
  content: string;
  priority: MessagePriority;
  timestamp: string;
}

/**
 * Blocking notification for UI display
 */
export interface BlockingNotification {
  icon: string; // ⚠️
  title: string; // "ORCHESTRATOR BLOCKED"
  message: string; // Blocking reason
  category: BlockingCategory;
  actions: string[]; // ["continue", "abort", "get-details"]
  timestamp: string;
  bufferedMessageCount?: number;
}

/**
 * State transition rules
 */
export type StateTransitions = Record<OrchestratorState, OrchestratorState[]>;

/**
 * Configuration for blocking detection
 */
export interface BlockingDetectorConfig {
  enabled: boolean;
  confidenceThreshold: number; // 0-100, default 70
  useLLMEnhancement: boolean; // Enable LLM self-reflection (Phase 2)
  messageBufferSize: number; // Max buffered messages while blocked
  timeoutReminder: number; // Milliseconds before reminding user (default 1 hour)
}

/**
 * Blocking system statistics
 */
export interface BlockingStatistics {
  totalBlockingEvents: number;
  blockingsByCategory: Record<BlockingCategory, number>;
  averageBlockedDuration: number; // Milliseconds
  userOverrideRate: number; // Percentage of blocks overridden by user
  falsePositiveReports: number;
}

/**
 * User command types
 */
export type UserCommand =
  | "continue"
  | "proceed"
  | "go"
  | "resume"
  | "unblock"
  | "abort"
  | "cancel"
  | "stop"
  | "why-blocked"
  | "show-messages"
  | "get-details";

/**
 * State transition event
 */
export interface StateTransitionEvent {
  from: OrchestratorState;
  to: OrchestratorState;
  timestamp: string;
  reason: string;
  triggeredBy: "system" | "user" | "timer";
}
