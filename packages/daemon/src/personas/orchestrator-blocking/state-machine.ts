/**
 * State Machine for Orchestrator Blocking System
 *
 * Manages orchestrator state transitions with validation and event tracking.
 */

import { OrchestratorState, type StateTransitionEvent, type StateTransitions } from "./types.js";
import { EventEmitter } from "events";

/**
 * Valid state transitions
 */
export const STATE_TRANSITIONS: StateTransitions = {
  [OrchestratorState.IDLE]: [
    OrchestratorState.PLANNING
  ],

  [OrchestratorState.PLANNING]: [
    OrchestratorState.EXECUTING,
    OrchestratorState.BLOCKED,
    OrchestratorState.IDLE // Can return to idle if planning is aborted
  ],

  [OrchestratorState.EXECUTING]: [
    OrchestratorState.REPORTING,
    OrchestratorState.BLOCKED,
    OrchestratorState.IDLE // Can return to idle if execution is aborted
  ],

  [OrchestratorState.BLOCKED]: [
    OrchestratorState.PLANNING, // Resume from blocked state
    OrchestratorState.IDLE // User aborts work
  ],

  [OrchestratorState.REPORTING]: [
    OrchestratorState.IDLE
  ]
};

/**
 * State Machine for orchestrator state management
 */
export class OrchestratorStateMachine extends EventEmitter {
  private currentState: OrchestratorState;
  private stateHistory: StateTransitionEvent[] = [];

  constructor(initialState: OrchestratorState = OrchestratorState.IDLE) {
    super();
    this.currentState = initialState;
  }

  /**
   * Get current state
   */
  getState(): OrchestratorState {
    return this.currentState;
  }

  /**
   * Check if a transition is valid
   */
  canTransition(from: OrchestratorState, to: OrchestratorState): boolean {
    const allowedTransitions = STATE_TRANSITIONS[from];
    return allowedTransitions.includes(to);
  }

  /**
   * Transition to a new state
   *
   * @throws Error if transition is invalid
   */
  transition(
    to: OrchestratorState,
    reason: string,
    triggeredBy: "system" | "user" | "timer" = "system"
  ): StateTransitionEvent {
    const from = this.currentState;

    // Validate transition
    if (!this.canTransition(from, to)) {
      throw new Error(
        `Invalid state transition: ${from} → ${to}. ` +
        `Allowed transitions from ${from}: ${STATE_TRANSITIONS[from].join(", ")}`
      );
    }

    // Create transition event
    const event: StateTransitionEvent = {
      from,
      to,
      timestamp: new Date().toISOString(),
      reason,
      triggeredBy
    };

    // Update state
    this.currentState = to;
    this.stateHistory.push(event);

    // Emit events
    this.emit("state-change", event);
    this.emit(`state:${to}`, event);

    return event;
  }

  /**
   * Force transition to BLOCKED state (emergency blocking)
   */
  forceBlock(reason: string): StateTransitionEvent {
    // BLOCKED state can be reached from any non-BLOCKED state
    if (this.currentState === OrchestratorState.BLOCKED) {
      throw new Error("Already in BLOCKED state");
    }

    // Temporarily allow transition from current state to BLOCKED
    const from = this.currentState;

    // Create transition event
    const event: StateTransitionEvent = {
      from,
      to: OrchestratorState.BLOCKED,
      timestamp: new Date().toISOString(),
      reason: `FORCE BLOCK: ${reason}`,
      triggeredBy: "system"
    };

    // Update state
    this.currentState = OrchestratorState.BLOCKED;
    this.stateHistory.push(event);

    // Emit events
    this.emit("state-change", event);
    this.emit("state:blocked", event);
    this.emit("force-block", event);

    return event;
  }

  /**
   * Get state history
   */
  getHistory(limit?: number): StateTransitionEvent[] {
    if (limit) {
      return this.stateHistory.slice(-limit);
    }
    return [...this.stateHistory];
  }

  /**
   * Get time spent in current state (milliseconds)
   */
  getTimeInCurrentState(): number {
    if (this.stateHistory.length === 0) {
      return 0;
    }

    const lastTransition = this.stateHistory[this.stateHistory.length - 1];
    const lastTransitionTime = new Date(lastTransition.timestamp).getTime();
    return Date.now() - lastTransitionTime;
  }

  /**
   * Check if currently blocked
   */
  isBlocked(): boolean {
    return this.currentState === OrchestratorState.BLOCKED;
  }

  /**
   * Get allowed transitions from current state
   */
  getAllowedTransitions(): OrchestratorState[] {
    return STATE_TRANSITIONS[this.currentState];
  }

  /**
   * Reset state machine
   */
  reset(initialState: OrchestratorState = OrchestratorState.IDLE): void {
    this.currentState = initialState;
    this.stateHistory = [];
    this.emit("reset", { state: initialState });
  }
}
