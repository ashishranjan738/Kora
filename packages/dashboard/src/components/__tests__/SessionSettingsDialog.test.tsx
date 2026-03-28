// @vitest-environment happy-dom
/**
 * Tests for SessionSettingsDialog — allowMasterForceTransition checkbox.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import * as matchers from "@testing-library/jest-dom/matchers";
expect.extend(matchers);
import { render, screen, fireEvent, waitFor, cleanup } from "@testing-library/react";
import { MantineProvider } from "@mantine/core";

// ── Mock useApi ──────────────────────────────────────────────────────────

const mockGetProviders = vi.fn();
const mockGetSession = vi.fn();
const mockGetSessionModels = vi.fn();
const mockGetSessionInstructions = vi.fn();
const mockUpdateSessionConfig = vi.fn();

vi.mock("../../hooks/useApi", () => ({
  useApi: () => ({
    getProviders: mockGetProviders,
    getSession: mockGetSession,
    getSessionModels: mockGetSessionModels,
    getSessionInstructions: mockGetSessionInstructions,
    updateSessionConfig: mockUpdateSessionConfig,
  }),
}));

// ── Mock useMediaQuery (always desktop) ──────────────────────────────────

vi.mock("@mantine/hooks", async () => {
  const actual = await vi.importActual("@mantine/hooks");
  return {
    ...actual,
    useMediaQuery: () => false,
  };
});

// ── Mock child components that make their own API calls ──────────────────

vi.mock("../NudgePolicyEditor", () => ({
  NudgePolicyEditor: () => <div data-testid="nudge-policy-editor" />,
}));

vi.mock("../CleanupPanel", () => ({
  CleanupPanel: () => <div data-testid="cleanup-panel" />,
}));

// ── Import component after mocks ─────────────────────────────────────────

import { SessionSettingsDialog } from "../SessionSettingsDialog";

// ── Helpers ──────────────────────────────────────────────────────────────

function renderDialog(props: Partial<{ sessionId: string; onClose: () => void }> = {}) {
  const defaultProps = {
    sessionId: "test-session",
    onClose: vi.fn(),
    ...props,
  };
  return render(
    <MantineProvider>
      <SessionSettingsDialog {...defaultProps} />
    </MantineProvider>
  );
}

/** Find the force-transition switch input element */
function getForceTransitionSwitch(): HTMLInputElement {
  const input = document.querySelector(
    'input[aria-label="Allow master agents to force task transitions"]'
  ) as HTMLInputElement;
  if (!input) throw new Error("Force transition switch not found");
  return input;
}

const defaultSessionData = {
  worktreeMode: "isolated",
  autoAssign: true,
  allowMasterForceTransition: false,
};

beforeEach(() => {
  vi.clearAllMocks();
  mockGetProviders.mockResolvedValue({ providers: [] });
  mockGetSession.mockResolvedValue(defaultSessionData);
  mockGetSessionModels.mockResolvedValue({ models: [] });
  mockGetSessionInstructions.mockResolvedValue({ instructions: "" });
  mockUpdateSessionConfig.mockResolvedValue({ success: true });
});

afterEach(() => {
  cleanup();
});

// ── Tests ────────────────────────────────────────────────────────────────

describe("SessionSettingsDialog — allowMasterForceTransition", () => {
  it("renders the force transition toggle with correct label", async () => {
    renderDialog();

    await waitFor(() => {
      expect(
        screen.getByText("Allow master agents to force task transitions")
      ).toBeInTheDocument();
    });
  });

  it("renders unchecked by default when allowMasterForceTransition is false", async () => {
    mockGetSession.mockResolvedValue({
      ...defaultSessionData,
      allowMasterForceTransition: false,
    });

    renderDialog();

    await waitFor(() => {
      const toggle = getForceTransitionSwitch();
      expect(toggle.checked).toBe(false);
    });
  });

  it("renders checked when allowMasterForceTransition is true from session data", async () => {
    mockGetSession.mockResolvedValue({
      ...defaultSessionData,
      allowMasterForceTransition: true,
    });

    renderDialog();

    await waitFor(() => {
      const toggle = getForceTransitionSwitch();
      expect(toggle.checked).toBe(true);
    });
  });

  it("sends correct API call when toggled on", async () => {
    mockGetSession.mockResolvedValue({
      ...defaultSessionData,
      allowMasterForceTransition: false,
    });

    renderDialog();

    await waitFor(() => {
      getForceTransitionSwitch();
    });

    const toggle = getForceTransitionSwitch();
    fireEvent.click(toggle);

    await waitFor(() => {
      expect(mockUpdateSessionConfig).toHaveBeenCalledWith("test-session", {
        allowMasterForceTransition: true,
      });
    });
  });

  it("sends correct API call when toggled off", async () => {
    mockGetSession.mockResolvedValue({
      ...defaultSessionData,
      allowMasterForceTransition: true,
    });

    renderDialog();

    await waitFor(() => {
      const toggle = getForceTransitionSwitch();
      expect(toggle.checked).toBe(true);
    });

    const toggle = getForceTransitionSwitch();
    fireEvent.click(toggle);

    await waitFor(() => {
      expect(mockUpdateSessionConfig).toHaveBeenCalledWith("test-session", {
        allowMasterForceTransition: false,
      });
    });
  });

  it("reverts UI state on API failure", async () => {
    mockGetSession.mockResolvedValue({
      ...defaultSessionData,
      allowMasterForceTransition: false,
    });
    mockUpdateSessionConfig.mockRejectedValue(new Error("API error"));

    renderDialog();

    await waitFor(() => {
      const toggle = getForceTransitionSwitch();
      expect(toggle.checked).toBe(false);
    });

    const toggle = getForceTransitionSwitch();
    fireEvent.click(toggle);

    // Should revert back to unchecked after API failure
    await waitFor(() => {
      expect(toggle.checked).toBe(false);
    });
  });

  it("shows description text explaining the toggle", async () => {
    renderDialog();

    await waitFor(() => {
      expect(
        screen.getByText(/when enabled, master\/orchestrator agents can bypass pipeline transitions/i)
      ).toBeInTheDocument();
    });
  });
});
