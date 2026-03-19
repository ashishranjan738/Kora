import { describe, it, expect, beforeEach, vi } from "vitest";
import { OrchestratorStateMachine, STATE_TRANSITIONS } from "../../../personas/orchestrator-blocking/state-machine.js";
import { OrchestratorState } from "../../../personas/orchestrator-blocking/types.js";

describe("OrchestratorStateMachine", () => {
  let stateMachine: OrchestratorStateMachine;

  beforeEach(() => {
    stateMachine = new OrchestratorStateMachine();
  });

  describe("Initialization", () => {
    it("should start in IDLE state by default", () => {
      expect(stateMachine.getState()).toBe(OrchestratorState.IDLE);
    });

    it("should accept custom initial state", () => {
      const sm = new OrchestratorStateMachine(OrchestratorState.PLANNING);
      expect(sm.getState()).toBe(OrchestratorState.PLANNING);
    });

    it("should have empty history initially", () => {
      expect(stateMachine.getHistory()).toEqual([]);
    });
  });

  describe("Valid State Transitions", () => {
    it("should allow IDLE → PLANNING", () => {
      expect(stateMachine.canTransition(OrchestratorState.IDLE, OrchestratorState.PLANNING)).toBe(true);

      const event = stateMachine.transition(OrchestratorState.PLANNING, "Starting planning phase");

      expect(stateMachine.getState()).toBe(OrchestratorState.PLANNING);
      expect(event.from).toBe(OrchestratorState.IDLE);
      expect(event.to).toBe(OrchestratorState.PLANNING);
    });

    it("should allow PLANNING → EXECUTING", () => {
      stateMachine.transition(OrchestratorState.PLANNING, "Start planning");

      const event = stateMachine.transition(OrchestratorState.EXECUTING, "Plan ready");

      expect(stateMachine.getState()).toBe(OrchestratorState.EXECUTING);
      expect(event.from).toBe(OrchestratorState.PLANNING);
      expect(event.to).toBe(OrchestratorState.EXECUTING);
    });

    it("should allow PLANNING → BLOCKED", () => {
      stateMachine.transition(OrchestratorState.PLANNING, "Start planning");

      const event = stateMachine.transition(OrchestratorState.BLOCKED, "Need user input");

      expect(stateMachine.getState()).toBe(OrchestratorState.BLOCKED);
      expect(event.reason).toBe("Need user input");
    });

    it("should allow EXECUTING → BLOCKED", () => {
      stateMachine.transition(OrchestratorState.PLANNING, "Start");
      stateMachine.transition(OrchestratorState.EXECUTING, "Execute");

      const event = stateMachine.transition(OrchestratorState.BLOCKED, "Unexpected issue");

      expect(stateMachine.getState()).toBe(OrchestratorState.BLOCKED);
    });

    it("should allow EXECUTING → REPORTING", () => {
      stateMachine.transition(OrchestratorState.PLANNING, "Start");
      stateMachine.transition(OrchestratorState.EXECUTING, "Execute");

      const event = stateMachine.transition(OrchestratorState.REPORTING, "Work complete");

      expect(stateMachine.getState()).toBe(OrchestratorState.REPORTING);
    });

    it("should allow BLOCKED → PLANNING (resume)", () => {
      stateMachine.transition(OrchestratorState.PLANNING, "Start");
      stateMachine.transition(OrchestratorState.BLOCKED, "Blocked");

      const event = stateMachine.transition(OrchestratorState.PLANNING, "User provided input");

      expect(stateMachine.getState()).toBe(OrchestratorState.PLANNING);
      expect(event.triggeredBy).toBe("system");
    });

    it("should allow BLOCKED → IDLE (abort)", () => {
      stateMachine.transition(OrchestratorState.PLANNING, "Start");
      stateMachine.transition(OrchestratorState.BLOCKED, "Blocked");

      const event = stateMachine.transition(OrchestratorState.IDLE, "User aborted", "user");

      expect(stateMachine.getState()).toBe(OrchestratorState.IDLE);
      expect(event.triggeredBy).toBe("user");
    });

    it("should allow REPORTING → IDLE", () => {
      stateMachine.transition(OrchestratorState.PLANNING, "Start");
      stateMachine.transition(OrchestratorState.EXECUTING, "Execute");
      stateMachine.transition(OrchestratorState.REPORTING, "Report");

      const event = stateMachine.transition(OrchestratorState.IDLE, "Report sent");

      expect(stateMachine.getState()).toBe(OrchestratorState.IDLE);
    });
  });

  describe("Invalid State Transitions", () => {
    it("should not allow IDLE → BLOCKED", () => {
      expect(stateMachine.canTransition(OrchestratorState.IDLE, OrchestratorState.BLOCKED)).toBe(false);

      expect(() => {
        stateMachine.transition(OrchestratorState.BLOCKED, "Invalid");
      }).toThrow("Invalid state transition");
    });

    it("should not allow IDLE → EXECUTING", () => {
      expect(stateMachine.canTransition(OrchestratorState.IDLE, OrchestratorState.EXECUTING)).toBe(false);

      expect(() => {
        stateMachine.transition(OrchestratorState.EXECUTING, "Invalid");
      }).toThrow("Invalid state transition");
    });

    it("should not allow BLOCKED → EXECUTING", () => {
      stateMachine.transition(OrchestratorState.PLANNING, "Start");
      stateMachine.transition(OrchestratorState.BLOCKED, "Blocked");

      expect(stateMachine.canTransition(OrchestratorState.BLOCKED, OrchestratorState.EXECUTING)).toBe(false);

      expect(() => {
        stateMachine.transition(OrchestratorState.EXECUTING, "Invalid");
      }).toThrow("Invalid state transition");
    });

    it("should not allow REPORTING → BLOCKED", () => {
      stateMachine.transition(OrchestratorState.PLANNING, "Start");
      stateMachine.transition(OrchestratorState.EXECUTING, "Execute");
      stateMachine.transition(OrchestratorState.REPORTING, "Report");

      expect(stateMachine.canTransition(OrchestratorState.REPORTING, OrchestratorState.BLOCKED)).toBe(false);
    });
  });

  describe("Force Block", () => {
    it("should allow force blocking from any state", () => {
      stateMachine.transition(OrchestratorState.PLANNING, "Start");

      const event = stateMachine.forceBlock("Critical error detected");

      expect(stateMachine.getState()).toBe(OrchestratorState.BLOCKED);
      expect(event.reason).toContain("FORCE BLOCK");
      expect(event.reason).toContain("Critical error detected");
    });

    it("should emit force-block event", () => {
      const listener = vi.fn();
      stateMachine.on("force-block", listener);

      stateMachine.transition(OrchestratorState.PLANNING, "Start");
      stateMachine.forceBlock("Emergency");

      expect(listener).toHaveBeenCalledWith(
        expect.objectContaining({
          to: OrchestratorState.BLOCKED,
          reason: expect.stringContaining("FORCE BLOCK")
        })
      );
    });

    it("should not allow force blocking when already blocked", () => {
      stateMachine.transition(OrchestratorState.PLANNING, "Start");
      stateMachine.forceBlock("First block");

      expect(() => {
        stateMachine.forceBlock("Second block");
      }).toThrow("Already in BLOCKED state");
    });
  });

  describe("State History", () => {
    it("should track transition history", () => {
      stateMachine.transition(OrchestratorState.PLANNING, "Start planning");
      stateMachine.transition(OrchestratorState.EXECUTING, "Start execution");

      const history = stateMachine.getHistory();

      expect(history).toHaveLength(2);
      expect(history[0].from).toBe(OrchestratorState.IDLE);
      expect(history[0].to).toBe(OrchestratorState.PLANNING);
      expect(history[1].from).toBe(OrchestratorState.PLANNING);
      expect(history[1].to).toBe(OrchestratorState.EXECUTING);
    });

    it("should limit history with limit parameter", () => {
      stateMachine.transition(OrchestratorState.PLANNING, "1");
      stateMachine.transition(OrchestratorState.EXECUTING, "2");
      stateMachine.transition(OrchestratorState.REPORTING, "3");
      stateMachine.transition(OrchestratorState.IDLE, "4");

      const history = stateMachine.getHistory(2);

      expect(history).toHaveLength(2);
      expect(history[0].reason).toBe("3");
      expect(history[1].reason).toBe("4");
    });

    it("should include timestamps in history", () => {
      const event = stateMachine.transition(OrchestratorState.PLANNING, "Test");

      expect(event.timestamp).toBeDefined();
      expect(new Date(event.timestamp).getTime()).toBeGreaterThan(0);
    });

    it("should track who triggered transitions", () => {
      const systemEvent = stateMachine.transition(OrchestratorState.PLANNING, "System action");
      stateMachine.transition(OrchestratorState.BLOCKED, "Blocked");
      const userEvent = stateMachine.transition(OrchestratorState.IDLE, "User abort", "user");

      expect(systemEvent.triggeredBy).toBe("system");
      expect(userEvent.triggeredBy).toBe("user");
    });
  });

  describe("State Queries", () => {
    it("should report if blocked", () => {
      expect(stateMachine.isBlocked()).toBe(false);

      stateMachine.transition(OrchestratorState.PLANNING, "Start");
      expect(stateMachine.isBlocked()).toBe(false);

      stateMachine.transition(OrchestratorState.BLOCKED, "Blocked");
      expect(stateMachine.isBlocked()).toBe(true);
    });

    it("should return allowed transitions from current state", () => {
      const transitions = stateMachine.getAllowedTransitions();

      expect(transitions).toEqual([OrchestratorState.PLANNING]);
    });

    it("should calculate time in current state", () => {
      stateMachine.transition(OrchestratorState.PLANNING, "Start");

      // Wait a bit
      const before = stateMachine.getTimeInCurrentState();
      expect(before).toBeGreaterThanOrEqual(0);

      // Should increase over time
      setTimeout(() => {
        const after = stateMachine.getTimeInCurrentState();
        expect(after).toBeGreaterThan(before);
      }, 10);
    });
  });

  describe("Events", () => {
    it("should emit state-change event on transition", () => {
      const listener = vi.fn();
      stateMachine.on("state-change", listener);

      stateMachine.transition(OrchestratorState.PLANNING, "Test");

      expect(listener).toHaveBeenCalledWith(
        expect.objectContaining({
          from: OrchestratorState.IDLE,
          to: OrchestratorState.PLANNING,
          reason: "Test"
        })
      );
    });

    it("should emit state-specific events", () => {
      const planningListener = vi.fn();
      const blockedListener = vi.fn();

      stateMachine.on("state:planning", planningListener);
      stateMachine.on("state:blocked", blockedListener);

      stateMachine.transition(OrchestratorState.PLANNING, "Plan");
      stateMachine.transition(OrchestratorState.BLOCKED, "Block");

      expect(planningListener).toHaveBeenCalledTimes(1);
      expect(blockedListener).toHaveBeenCalledTimes(1);
    });
  });

  describe("Reset", () => {
    it("should reset to initial state", () => {
      stateMachine.transition(OrchestratorState.PLANNING, "Start");
      stateMachine.transition(OrchestratorState.EXECUTING, "Execute");

      stateMachine.reset();

      expect(stateMachine.getState()).toBe(OrchestratorState.IDLE);
      expect(stateMachine.getHistory()).toEqual([]);
    });

    it("should reset to custom state", () => {
      stateMachine.transition(OrchestratorState.PLANNING, "Start");

      stateMachine.reset(OrchestratorState.PLANNING);

      expect(stateMachine.getState()).toBe(OrchestratorState.PLANNING);
      expect(stateMachine.getHistory()).toEqual([]);
    });

    it("should emit reset event", () => {
      const listener = vi.fn();
      stateMachine.on("reset", listener);

      stateMachine.reset();

      expect(listener).toHaveBeenCalledWith(
        expect.objectContaining({ state: OrchestratorState.IDLE })
      );
    });
  });

  describe("State Transition Configuration", () => {
    it("should have all states defined in transitions", () => {
      const states = Object.values(OrchestratorState);
      const definedStates = Object.keys(STATE_TRANSITIONS);

      expect(definedStates.length).toBe(states.length);
      states.forEach(state => {
        expect(STATE_TRANSITIONS).toHaveProperty(state);
      });
    });

    it("should have valid target states in transitions", () => {
      const allStates = Object.values(OrchestratorState);

      for (const [from, targets] of Object.entries(STATE_TRANSITIONS)) {
        expect(allStates).toContain(from);
        targets.forEach(target => {
          expect(allStates).toContain(target);
        });
      }
    });
  });
});
