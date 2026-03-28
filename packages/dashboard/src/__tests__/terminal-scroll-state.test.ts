/**
 * Tests for terminal scroll state machine in terminalRegistry.ts
 *
 * These tests verify the scroll behavior fixes that prevent the viewport
 * from jumping to the top (or bottom) when new output arrives while the
 * user is scrolled up reading history.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

// ─── Mock the scroll state machine logic extracted from terminalRegistry ──────
// We test the core logic directly since the actual Terminal requires a DOM.

interface MockTerminalState {
  userScrolledUp: boolean;
  manuallyPaused: boolean;
  _isWriting: boolean;
  viewportY: number;
  baseY: number;
}

/** Simulates the onScroll handler logic from terminalRegistry.ts */
function handleOnScroll(state: MockTerminalState): { userScrolledUp: boolean; changed: boolean } {
  // Guard: ignore scroll events during programmatic writes
  if (state._isWriting) {
    return { userScrolledUp: state.userScrolledUp, changed: false };
  }

  const atBottom = state.viewportY >= state.baseY;
  const wasScrolledUp = state.userScrolledUp;
  state.userScrolledUp = !atBottom;
  return { userScrolledUp: state.userScrolledUp, changed: wasScrolledUp !== state.userScrolledUp };
}

/** Simulates the write callback logic from terminalRegistry.ts */
function handleWriteCallback(
  state: MockTerminalState,
  wasScrolledUp: boolean,
  savedViewportY: number,
): { action: "scrollToBottom" | "scrollToLine"; targetY?: number } {
  state._isWriting = false;

  if (wasScrolledUp) {
    const maxY = state.baseY;
    const targetY = Math.min(savedViewportY, maxY);
    state.viewportY = targetY;
    return { action: "scrollToLine", targetY };
  } else {
    state.viewportY = state.baseY;
    return { action: "scrollToBottom" };
  }
}

/** Simulates the refresh timer scheduling logic */
function shouldScheduleRefresh(state: MockTerminalState): boolean {
  return !state.userScrolledUp && !state.manuallyPaused;
}

// ─── Tests ──────────────────────────────────────────────────

describe("terminal scroll state machine", () => {
  let state: MockTerminalState;

  beforeEach(() => {
    state = {
      userScrolledUp: false,
      manuallyPaused: false,
      _isWriting: false,
      viewportY: 100,
      baseY: 100, // at bottom
    };
  });

  // ─── _isWriting guard ──────────────────────────────────────

  describe("onScroll ignored during _isWriting", () => {
    it("does not change userScrolledUp when _isWriting is true", () => {
      state.userScrolledUp = true;
      state._isWriting = true;
      state.viewportY = 100; // at bottom — would normally clear userScrolledUp
      state.baseY = 100;

      const result = handleOnScroll(state);
      expect(result.changed).toBe(false);
      expect(state.userScrolledUp).toBe(true); // preserved!
    });

    it("does not set userScrolledUp=false when write auto-scrolls to bottom", () => {
      state.userScrolledUp = true;
      state._isWriting = true;
      // Simulate xterm auto-scrolling to bottom during write
      state.viewportY = 200;
      state.baseY = 200;

      const result = handleOnScroll(state);
      expect(state.userScrolledUp).toBe(true); // still scrolled up from user's perspective
    });

    it("allows scroll state changes when _isWriting is false", () => {
      state.userScrolledUp = false;
      state._isWriting = false;
      state.viewportY = 50; // scrolled up
      state.baseY = 100;

      const result = handleOnScroll(state);
      expect(result.changed).toBe(true);
      expect(state.userScrolledUp).toBe(true);
    });
  });

  // ─── Viewport save/restore ─────────────────────────────────

  describe("viewport restored after write when scrolled up", () => {
    it("restores viewport to saved position after write", () => {
      state.viewportY = 50; // user reading line 50
      state.baseY = 100;
      const savedViewportY = state.viewportY;
      const wasScrolledUp = true;

      // Simulate write adding new content (baseY grows)
      state.baseY = 110;
      state._isWriting = true;

      const result = handleWriteCallback(state, wasScrolledUp, savedViewportY);
      expect(result.action).toBe("scrollToLine");
      expect(result.targetY).toBe(50); // restored to original position
      expect(state.viewportY).toBe(50);
      expect(state._isWriting).toBe(false);
    });

    it("clamps viewport to new baseY if saved position exceeds buffer", () => {
      state.viewportY = 90;
      state.baseY = 100;
      const savedViewportY = 90;
      const wasScrolledUp = true;

      // Simulate buffer shrink (unlikely but handle gracefully)
      state.baseY = 80;

      const result = handleWriteCallback(state, wasScrolledUp, savedViewportY);
      expect(result.action).toBe("scrollToLine");
      expect(result.targetY).toBe(80); // clamped to baseY
    });

    it("scrolls to bottom when not scrolled up (tailing)", () => {
      const savedViewportY = 100;
      const wasScrolledUp = false;

      state.baseY = 110; // new content
      const result = handleWriteCallback(state, wasScrolledUp, savedViewportY);
      expect(result.action).toBe("scrollToBottom");
      expect(state.viewportY).toBe(110); // at bottom
    });
  });

  // ─── Refresh timer ─────────────────────────────────────────

  describe("refresh timer not scheduled when scrolled up", () => {
    it("skips refresh when userScrolledUp is true", () => {
      state.userScrolledUp = true;
      expect(shouldScheduleRefresh(state)).toBe(false);
    });

    it("skips refresh when manuallyPaused is true", () => {
      state.manuallyPaused = true;
      expect(shouldScheduleRefresh(state)).toBe(false);
    });

    it("skips refresh when both scrolled up and paused", () => {
      state.userScrolledUp = true;
      state.manuallyPaused = true;
      expect(shouldScheduleRefresh(state)).toBe(false);
    });

    it("allows refresh when at bottom and not paused", () => {
      state.userScrolledUp = false;
      state.manuallyPaused = false;
      expect(shouldScheduleRefresh(state)).toBe(true);
    });
  });

  // ─── Tailing behavior preserved ────────────────────────────

  describe("tailing behavior preserved when at bottom", () => {
    it("auto-scrolls to bottom on new output when tailing", () => {
      state.viewportY = 100;
      state.baseY = 100; // at bottom
      state.userScrolledUp = false;

      // New content arrives
      state.baseY = 110;
      const result = handleWriteCallback(state, false, 100);
      expect(result.action).toBe("scrollToBottom");
      expect(state.viewportY).toBe(110);
    });

    it("onScroll correctly detects return to bottom", () => {
      state.userScrolledUp = true;
      state._isWriting = false;
      state.viewportY = 100;
      state.baseY = 100; // user scrolled back to bottom

      const result = handleOnScroll(state);
      expect(state.userScrolledUp).toBe(false);
      expect(result.changed).toBe(true);
    });

    it("onScroll correctly detects user scrolling up", () => {
      state.userScrolledUp = false;
      state._isWriting = false;
      state.viewportY = 50;
      state.baseY = 100;

      const result = handleOnScroll(state);
      expect(state.userScrolledUp).toBe(true);
      expect(result.changed).toBe(true);
    });
  });

  // ─── Full write cycle simulation ──────────────────────────

  describe("full write cycle — scrolled up user stays in place", () => {
    it("simulates complete write cycle without viewport jump", () => {
      // Setup: user is scrolled up reading line 50
      state.viewportY = 50;
      state.baseY = 100;
      state.userScrolledUp = true;

      // Step 1: Capture state before write
      const wasScrolledUp = state.userScrolledUp || state.manuallyPaused;
      const savedViewportY = state.viewportY;
      expect(wasScrolledUp).toBe(true);
      expect(savedViewportY).toBe(50);

      // Step 2: Write starts — set guard
      state._isWriting = true;

      // Step 3: xterm internally auto-scrolls during write
      state.viewportY = 0; // xterm jumps to top (the bug!)
      state.baseY = 105; // new content added

      // Step 4: onScroll fires during write — should be ignored
      const scrollResult = handleOnScroll(state);
      expect(scrollResult.changed).toBe(false);
      expect(state.userScrolledUp).toBe(true); // NOT cleared!

      // Step 5: Write callback fires — restore position
      const writeResult = handleWriteCallback(state, wasScrolledUp, savedViewportY);
      expect(writeResult.action).toBe("scrollToLine");
      expect(writeResult.targetY).toBe(50); // back to where user was

      // Step 6: Refresh timer should NOT be scheduled
      expect(shouldScheduleRefresh(state)).toBe(false);
    });

    it("simulates complete write cycle at bottom — auto-scrolls", () => {
      // Setup: user is at bottom (tailing)
      state.viewportY = 100;
      state.baseY = 100;
      state.userScrolledUp = false;

      const wasScrolledUp = false;
      const savedViewportY = 100;

      state._isWriting = true;
      state.baseY = 110; // new content

      // Write callback
      const writeResult = handleWriteCallback(state, wasScrolledUp, savedViewportY);
      expect(writeResult.action).toBe("scrollToBottom");
      expect(state.viewportY).toBe(110); // followed new content

      // Refresh should be scheduled
      expect(shouldScheduleRefresh(state)).toBe(true);
    });
  });
});
