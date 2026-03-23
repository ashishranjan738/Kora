// @vitest-environment happy-dom
/**
 * Tests for DirectoryBrowser component — real RTL rendering with mocked API.
 *
 * Coverage:
 * - Renders modal with title when opened
 * - Does not fetch when opened=false
 * - Shows loading state during fetch
 * - Displays directory entries from API response
 * - Clicking a directory drills in (triggers new fetch)
 * - Go Up button navigates to parent
 * - Go Up button disabled when parent is null (root)
 * - Go Home button navigates to home directory
 * - Select button calls onSelect with current path
 * - Cancel button calls onClose
 * - Error state renders alert (permission denied, not found)
 * - Empty directory shows "No subdirectories"
 * - Filter input filters visible directories
 * - Git repo badge shown for git directories
 * - Breadcrumbs rendered from current path
 * - Recent paths displayed when available
 * - Selected path shown in footer
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import * as matchers from "@testing-library/jest-dom/matchers";
expect.extend(matchers);
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import { MantineProvider } from "@mantine/core";

// ── Mock useApi ──────────────────────────────────────────────────────────

const mockBrowseDirectories = vi.fn();
const mockGetRecentPaths = vi.fn();

vi.mock("../../hooks/useApi", () => ({
  useApi: () => ({
    browseDirectories: mockBrowseDirectories,
    getRecentPaths: mockGetRecentPaths,
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

// ── Import component after mocks ─────────────────────────────────────────

import { DirectoryBrowser } from "../DirectoryBrowser";

// ── Helpers ──────────────────────────────────────────────────────────────

function renderBrowser(props: Partial<Parameters<typeof DirectoryBrowser>[0]> = {}) {
  const defaultProps = {
    opened: true,
    onClose: vi.fn(),
    onSelect: vi.fn(),
    ...props,
  };
  return {
    ...render(
      <MantineProvider>
        <DirectoryBrowser {...defaultProps} />
      </MantineProvider>
    ),
    props: defaultProps,
  };
}

const defaultResponse = {
  path: "/home/user/Projects",
  parent: "/home/user",
  directories: [
    { name: "Kora", path: "/home/user/Projects/Kora", isGitRepo: true },
    { name: "notes", path: "/home/user/Projects/notes", isGitRepo: false },
    { name: "tools", path: "/home/user/Projects/tools", isGitRepo: false },
  ],
  homeDir: "/home/user",
};

// ── Tests ────────────────────────────────────────────────────────────────

describe("DirectoryBrowser", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockBrowseDirectories.mockResolvedValue(defaultResponse);
    mockGetRecentPaths.mockResolvedValue({ paths: [] });
  });

  // ── Rendering ─────────────────────────────────────────────────────────

  it("renders modal with title when opened", async () => {
    renderBrowser();

    expect(screen.getByText("Browse Directory")).toBeInTheDocument();
  });

  it("does not call browseDirectories when opened=false", () => {
    renderBrowser({ opened: false });

    expect(mockBrowseDirectories).not.toHaveBeenCalled();
  });

  it("displays directory entries after loading", async () => {
    renderBrowser();

    await waitFor(() => {
      expect(screen.getByText("Kora")).toBeInTheDocument();
    });
    expect(screen.getByText("notes")).toBeInTheDocument();
    expect(screen.getByText("tools")).toBeInTheDocument();
  });

  it("calls browseDirectories on mount", async () => {
    renderBrowser();

    await waitFor(() => {
      expect(mockBrowseDirectories).toHaveBeenCalled();
    });
  });

  it("calls browseDirectories with initialPath when provided", async () => {
    renderBrowser({ initialPath: "/home/user/Projects" });

    await waitFor(() => {
      expect(mockBrowseDirectories).toHaveBeenCalledWith("/home/user/Projects");
    });
  });

  // ── Loading State ─────────────────────────────────────────────────────

  it("shows loading text during fetch", async () => {
    mockBrowseDirectories.mockReturnValue(new Promise(() => {}));

    renderBrowser();

    expect(screen.getByText("Loading directories...")).toBeInTheDocument();
  });

  // ── Directory Navigation ──────────────────────────────────────────────

  it("drills into directory on click", async () => {
    const drillResponse = {
      path: "/home/user/Projects/Kora",
      parent: "/home/user/Projects",
      directories: [
        { name: "packages", path: "/home/user/Projects/Kora/packages", isGitRepo: false },
      ],
      homeDir: "/home/user",
    };

    // Component does double fetch: "" -> sets currentPath -> second fetch with real path
    mockBrowseDirectories
      .mockResolvedValueOnce(defaultResponse)  // fetch 1: initial ""
      .mockResolvedValueOnce(defaultResponse)  // fetch 2: currentPath updated
      .mockResolvedValueOnce(drillResponse);   // fetch 3: after click

    renderBrowser();

    await waitFor(() => {
      expect(screen.getByText("Kora")).toBeInTheDocument();
    });

    fireEvent.click(screen.getByText("Kora"));

    await waitFor(() => {
      expect(screen.getByText("packages")).toBeInTheDocument();
    });

    expect(mockBrowseDirectories).toHaveBeenCalledWith("/home/user/Projects/Kora");
  });

  it("Go Up button navigates to parent", async () => {
    const parentResponse = {
      path: "/home/user",
      parent: "/home",
      directories: [
        { name: "Projects", path: "/home/user/Projects", isGitRepo: false },
        { name: "Documents", path: "/home/user/Documents", isGitRepo: false },
      ],
      homeDir: "/home/user",
    };

    mockBrowseDirectories
      .mockResolvedValueOnce(defaultResponse)  // fetch 1: initial ""
      .mockResolvedValueOnce(defaultResponse)  // fetch 2: currentPath updated
      .mockResolvedValueOnce(parentResponse);  // fetch 3: after Go Up click

    renderBrowser();

    await waitFor(() => {
      expect(screen.getByText("Kora")).toBeInTheDocument();
    });

    const upButton = screen.getByLabelText("Go up");
    fireEvent.click(upButton);

    await waitFor(() => {
      expect(screen.getByText("Documents")).toBeInTheDocument();
    });

    expect(mockBrowseDirectories).toHaveBeenCalledWith("/home/user");
  });

  it("Go Up button is disabled at root (parent is null)", async () => {
    mockBrowseDirectories.mockResolvedValue({
      path: "/",
      parent: null,
      directories: [{ name: "home", path: "/home", isGitRepo: false }],
      homeDir: "/home/user",
    });

    renderBrowser({ initialPath: "/" });

    await waitFor(() => {
      expect(screen.getByText("home")).toBeInTheDocument();
    });

    const upButton = screen.getByLabelText("Go up");
    expect(upButton).toBeDisabled();
  });

  it("Go Home button navigates to home directory", async () => {
    const homeResponse = {
      path: "/home/user",
      parent: "/home",
      directories: [{ name: "Projects", path: "/home/user/Projects", isGitRepo: false }],
      homeDir: "/home/user",
    };

    mockBrowseDirectories
      .mockResolvedValueOnce(defaultResponse)  // fetch 1: initial ""
      .mockResolvedValueOnce(defaultResponse)  // fetch 2: currentPath updated
      .mockResolvedValueOnce(homeResponse);    // fetch 3: after Go Home click

    renderBrowser();

    await waitFor(() => {
      expect(screen.getByText("Kora")).toBeInTheDocument();
    });

    const homeButton = screen.getByLabelText("Go home");
    fireEvent.click(homeButton);

    await waitFor(() => {
      expect(mockBrowseDirectories).toHaveBeenCalledWith("/home/user");
    });
  });

  // ── Selection ─────────────────────────────────────────────────────────

  it("Select button calls onSelect with current path", async () => {
    const { props } = renderBrowser();

    await waitFor(() => {
      expect(screen.getByText("Kora")).toBeInTheDocument();
    });

    const selectBtn = screen.getByText("Select This Directory");
    fireEvent.click(selectBtn);

    expect(props.onSelect).toHaveBeenCalledWith("/home/user/Projects");
    expect(props.onClose).toHaveBeenCalled();
  });

  it("Cancel button calls onClose", async () => {
    const { props } = renderBrowser();

    await waitFor(() => {
      expect(screen.getByText("Kora")).toBeInTheDocument();
    });

    fireEvent.click(screen.getByText("Cancel"));

    expect(props.onClose).toHaveBeenCalled();
  });

  // ── Error State ───────────────────────────────────────────────────────

  it("shows error alert on permission denied", async () => {
    mockBrowseDirectories.mockRejectedValue(new Error("API 403: permission denied"));

    renderBrowser();

    await waitFor(() => {
      expect(screen.getByText(/permission denied/i)).toBeInTheDocument();
    });
  });

  it("shows not found error message", async () => {
    mockBrowseDirectories.mockRejectedValue(new Error("ENOENT: not found"));

    renderBrowser();

    await waitFor(() => {
      expect(screen.getByText(/not found/i)).toBeInTheDocument();
    });
  });

  // ── Empty Directory ───────────────────────────────────────────────────

  it("shows 'No subdirectories' for empty directory", async () => {
    mockBrowseDirectories.mockResolvedValue({
      path: "/home/user/empty",
      parent: "/home/user",
      directories: [],
      homeDir: "/home/user",
    });

    renderBrowser({ initialPath: "/home/user/empty" });

    await waitFor(() => {
      expect(screen.getByText("No subdirectories")).toBeInTheDocument();
    });
  });

  // ── Filter ────────────────────────────────────────────────────────────

  it("filters directories by typed text", async () => {
    renderBrowser();

    await waitFor(() => {
      expect(screen.getByText("Kora")).toBeInTheDocument();
    });

    const filterInput = screen.getByPlaceholderText("Type to filter...");
    fireEvent.change(filterInput, { target: { value: "kor" } });

    expect(screen.getByText("Kora")).toBeInTheDocument();
    expect(screen.queryByText("notes")).not.toBeInTheDocument();
    expect(screen.queryByText("tools")).not.toBeInTheDocument();
  });

  it("shows 'No matching directories' when filter matches nothing", async () => {
    renderBrowser();

    await waitFor(() => {
      expect(screen.getByText("Kora")).toBeInTheDocument();
    });

    const filterInput = screen.getByPlaceholderText("Type to filter...");
    fireEvent.change(filterInput, { target: { value: "zzzzz" } });

    expect(screen.getByText("No matching directories")).toBeInTheDocument();
  });

  // ── Git Repo Badge ────────────────────────────────────────────────────

  it("shows git badge for git repo directories", async () => {
    renderBrowser();

    await waitFor(() => {
      expect(screen.getByText("Kora")).toBeInTheDocument();
    });

    const gitBadges = screen.getAllByText("git");
    expect(gitBadges.length).toBeGreaterThanOrEqual(1);
  });

  // ── Breadcrumbs ───────────────────────────────────────────────────────

  it("renders breadcrumbs from current path", async () => {
    renderBrowser();

    await waitFor(() => {
      expect(screen.getByText("Kora")).toBeInTheDocument();
    });

    // Path is /home/user/Projects, homeDir is /home/user
    // Breadcrumbs should be: ~ / Projects
    expect(screen.getByText("~")).toBeInTheDocument();
    expect(screen.getByText("Projects")).toBeInTheDocument();
  });

  it("clicking breadcrumb navigates to that path", async () => {
    const homeResponse = {
      path: "/home/user",
      parent: "/home",
      directories: [{ name: "Projects", path: "/home/user/Projects", isGitRepo: false }],
      homeDir: "/home/user",
    };

    mockBrowseDirectories
      .mockResolvedValueOnce(defaultResponse)  // fetch 1: initial ""
      .mockResolvedValueOnce(defaultResponse)  // fetch 2: currentPath updated
      .mockResolvedValueOnce(homeResponse);    // fetch 3: after breadcrumb click

    renderBrowser();

    await waitFor(() => {
      expect(screen.getByText("Kora")).toBeInTheDocument();
    });

    // Click the ~ breadcrumb to go to home
    fireEvent.click(screen.getByText("~"));

    await waitFor(() => {
      expect(mockBrowseDirectories).toHaveBeenCalledWith("/home/user");
    });
  });

  // ── Recent Paths ──────────────────────────────────────────────────────

  it("displays recent paths when available", async () => {
    mockGetRecentPaths.mockResolvedValue({
      paths: ["/home/user/Projects/Kora", "/home/user/other"],
    });

    renderBrowser();

    await waitFor(() => {
      expect(screen.getByText("Recent:")).toBeInTheDocument();
    });
  });

  it("hides recent paths section when none available", async () => {
    mockGetRecentPaths.mockResolvedValue({ paths: [] });

    renderBrowser();

    await waitFor(() => {
      expect(screen.getByText("Kora")).toBeInTheDocument();
    });

    expect(screen.queryByText("Recent:")).not.toBeInTheDocument();
  });

  // ── Selected path display ─────────────────────────────────────────────

  it("shows current path in the footer", async () => {
    renderBrowser();

    await waitFor(() => {
      expect(screen.getByText("Kora")).toBeInTheDocument();
    });

    expect(screen.getByText("Selected:")).toBeInTheDocument();
    expect(screen.getByText("/home/user/Projects")).toBeInTheDocument();
  });
});
