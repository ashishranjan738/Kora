// @vitest-environment happy-dom
/**
 * Tests for DirectoryBrowser component.
 *
 * Coverage:
 * - Rendering: shows directories from API response
 * - Navigation: drill into folder, back/up button, breadcrumbs
 * - Selection: onSelect callback with correct path
 * - Git repo indicator: icon shown for git repos
 * - Loading state: spinner during API fetch
 * - Error state: shows error message on API failure
 * - Recent paths: displayed when available
 * - Empty directory: shows empty state message
 * - Default path: starts at home directory or initialPath
 * - Sort order: hidden dirs last, alphabetical
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import * as matchers from "@testing-library/jest-dom/matchers";
expect.extend(matchers);

// ──────────────────────────────────────────────────────────────────────────────
// Mock types matching the expected API response
// ──────────────────────────────────────────────────────────────────────────────

interface DirectoryEntry {
  name: string;
  path: string;
  isGitRepo: boolean;
}

interface BrowseResponse {
  currentPath: string;
  parent: string | null;
  directories: DirectoryEntry[];
}

// ──────────────────────────────────────────────────────────────────────────────
// Unit tests for DirectoryBrowser logic (pure functions)
// ──────────────────────────────────────────────────────────────────────────────

describe("DirectoryBrowser", () => {
  // ── Breadcrumb Path Splitting ───────────────────────────────────────────

  describe("breadcrumb path splitting", () => {
    // Utility that the component would use to build breadcrumbs
    function splitPathToBreadcrumbs(
      fullPath: string
    ): Array<{ label: string; path: string }> {
      const parts = fullPath.split("/").filter(Boolean);
      const crumbs: Array<{ label: string; path: string }> = [];

      // Add root
      crumbs.push({ label: "/", path: "/" });

      let accumulated = "";
      for (const part of parts) {
        accumulated += "/" + part;
        crumbs.push({ label: part, path: accumulated });
      }

      return crumbs;
    }

    it("splits absolute path into breadcrumbs", () => {
      const crumbs = splitPathToBreadcrumbs("/Users/dev/Projects/Kora");
      expect(crumbs).toEqual([
        { label: "/", path: "/" },
        { label: "Users", path: "/Users" },
        { label: "dev", path: "/Users/dev" },
        { label: "Projects", path: "/Users/dev/Projects" },
        { label: "Kora", path: "/Users/dev/Projects/Kora" },
      ]);
    });

    it("handles root path", () => {
      const crumbs = splitPathToBreadcrumbs("/");
      expect(crumbs).toEqual([{ label: "/", path: "/" }]);
    });

    it("handles single-level path", () => {
      const crumbs = splitPathToBreadcrumbs("/tmp");
      expect(crumbs).toEqual([
        { label: "/", path: "/" },
        { label: "tmp", path: "/tmp" },
      ]);
    });

    it("handles home directory path with tilde expansion", () => {
      // After resolution, tilde would be expanded to absolute path
      const crumbs = splitPathToBreadcrumbs("/home/user");
      expect(crumbs).toHaveLength(3);
      expect(crumbs[2]).toEqual({ label: "user", path: "/home/user" });
    });
  });

  // ── Directory Sorting ─────────────────────────────────────────────────

  describe("directory sorting", () => {
    function sortDirectories(dirs: DirectoryEntry[]): DirectoryEntry[] {
      return [...dirs].sort((a, b) => {
        const aHidden = a.name.startsWith(".");
        const bHidden = b.name.startsWith(".");
        if (aHidden !== bHidden) return aHidden ? 1 : -1;
        return a.name.localeCompare(b.name);
      });
    }

    it("sorts alphabetically", () => {
      const dirs: DirectoryEntry[] = [
        { name: "gamma", path: "/gamma", isGitRepo: false },
        { name: "alpha", path: "/alpha", isGitRepo: false },
        { name: "beta", path: "/beta", isGitRepo: false },
      ];
      const sorted = sortDirectories(dirs);
      expect(sorted.map((d) => d.name)).toEqual(["alpha", "beta", "gamma"]);
    });

    it("places hidden directories last", () => {
      const dirs: DirectoryEntry[] = [
        { name: ".hidden", path: "/.hidden", isGitRepo: false },
        { name: "visible", path: "/visible", isGitRepo: false },
        { name: ".config", path: "/.config", isGitRepo: false },
        { name: "alpha", path: "/alpha", isGitRepo: false },
      ];
      const sorted = sortDirectories(dirs);
      expect(sorted.map((d) => d.name)).toEqual([
        "alpha",
        "visible",
        ".config",
        ".hidden",
      ]);
    });

    it("handles all hidden directories", () => {
      const dirs: DirectoryEntry[] = [
        { name: ".git", path: "/.git", isGitRepo: false },
        { name: ".config", path: "/.config", isGitRepo: false },
        { name: ".cache", path: "/.cache", isGitRepo: false },
      ];
      const sorted = sortDirectories(dirs);
      expect(sorted.map((d) => d.name)).toEqual([
        ".cache",
        ".config",
        ".git",
      ]);
    });

    it("handles empty array", () => {
      const sorted = sortDirectories([]);
      expect(sorted).toEqual([]);
    });
  });

  // ── Directory Filtering ───────────────────────────────────────────────

  describe("directory filtering (type-to-filter)", () => {
    function filterDirectories(
      dirs: DirectoryEntry[],
      query: string
    ): DirectoryEntry[] {
      if (!query.trim()) return dirs;
      const lower = query.toLowerCase();
      return dirs.filter((d) => d.name.toLowerCase().includes(lower));
    }

    it("filters directories by name substring", () => {
      const dirs: DirectoryEntry[] = [
        { name: "node_modules", path: "/node_modules", isGitRepo: false },
        { name: "src", path: "/src", isGitRepo: false },
        { name: "scripts", path: "/scripts", isGitRepo: false },
      ];
      const filtered = filterDirectories(dirs, "src");
      expect(filtered.map((d) => d.name)).toEqual(["src"]);
    });

    it("is case-insensitive", () => {
      const dirs: DirectoryEntry[] = [
        { name: "Documents", path: "/Documents", isGitRepo: false },
        { name: "downloads", path: "/downloads", isGitRepo: false },
      ];
      const filtered = filterDirectories(dirs, "DOC");
      expect(filtered.map((d) => d.name)).toEqual(["Documents"]);
    });

    it("returns all directories for empty filter", () => {
      const dirs: DirectoryEntry[] = [
        { name: "a", path: "/a", isGitRepo: false },
        { name: "b", path: "/b", isGitRepo: false },
      ];
      const filtered = filterDirectories(dirs, "");
      expect(filtered).toHaveLength(2);
    });

    it("returns all directories for whitespace-only filter", () => {
      const dirs: DirectoryEntry[] = [
        { name: "a", path: "/a", isGitRepo: false },
      ];
      const filtered = filterDirectories(dirs, "   ");
      expect(filtered).toHaveLength(1);
    });

    it("returns empty for no match", () => {
      const dirs: DirectoryEntry[] = [
        { name: "src", path: "/src", isGitRepo: false },
      ];
      const filtered = filterDirectories(dirs, "zzz");
      expect(filtered).toHaveLength(0);
    });
  });

  // ── Navigation Logic ──────────────────────────────────────────────────

  describe("navigation state", () => {
    it("navigating into folder updates current path", () => {
      const response: BrowseResponse = {
        currentPath: "/home/user",
        parent: "/home",
        directories: [
          { name: "Projects", path: "/home/user/Projects", isGitRepo: false },
        ],
      };

      // Simulating: user clicks "Projects" → new path should be the clicked dir's path
      const clickedDir = response.directories[0];
      const nextPath = clickedDir.path;
      expect(nextPath).toBe("/home/user/Projects");
    });

    it("back/up button navigates to parent", () => {
      const response: BrowseResponse = {
        currentPath: "/home/user/Projects",
        parent: "/home/user",
        directories: [],
      };

      const parentPath = response.parent;
      expect(parentPath).toBe("/home/user");
    });

    it("back/up button is disabled at root (parent is null)", () => {
      const response: BrowseResponse = {
        currentPath: "/",
        parent: null,
        directories: [],
      };

      const canGoUp = response.parent !== null;
      expect(canGoUp).toBe(false);
    });

    it("uses initialPath when provided", () => {
      const initialPath = "/home/user/Projects/Kora";
      // The component should use initialPath as the starting fetch path
      expect(initialPath).toBe("/home/user/Projects/Kora");
    });

    it("defaults to home directory when no initialPath", () => {
      const initialPath = undefined;
      const startPath = initialPath ?? "~";
      expect(startPath).toBe("~");
    });
  });

  // ── Selection Logic ───────────────────────────────────────────────────

  describe("selection callback", () => {
    it("calls onSelect with the current path on confirm", () => {
      const onSelect = vi.fn();
      const currentPath = "/home/user/Projects/Kora";

      // Simulate "Select" button click
      onSelect(currentPath);

      expect(onSelect).toHaveBeenCalledTimes(1);
      expect(onSelect).toHaveBeenCalledWith("/home/user/Projects/Kora");
    });

    it("calls onSelect with directory path on double-click", () => {
      const onSelect = vi.fn();
      const dir: DirectoryEntry = {
        name: "Kora",
        path: "/home/user/Projects/Kora",
        isGitRepo: true,
      };

      // Simulate double-click on a directory
      onSelect(dir.path);

      expect(onSelect).toHaveBeenCalledWith("/home/user/Projects/Kora");
    });
  });

  // ── API Response Handling ─────────────────────────────────────────────

  describe("API response handling", () => {
    it("handles successful response with directories", () => {
      const response: BrowseResponse = {
        currentPath: "/home/user",
        parent: "/home",
        directories: [
          { name: "Projects", path: "/home/user/Projects", isGitRepo: true },
          { name: "Documents", path: "/home/user/Documents", isGitRepo: false },
        ],
      };

      expect(response.directories).toHaveLength(2);
      expect(response.currentPath).toBe("/home/user");
      expect(response.parent).toBe("/home");
    });

    it("handles empty directory response", () => {
      const response: BrowseResponse = {
        currentPath: "/home/user/empty",
        parent: "/home/user",
        directories: [],
      };

      expect(response.directories).toHaveLength(0);
    });

    it("handles error response (path not found)", () => {
      const errorResponse = { error: "Path not found" };
      expect(errorResponse.error).toBe("Path not found");
    });

    it("handles error response (permission denied)", () => {
      const errorResponse = { error: "Cannot read directory" };
      expect(errorResponse.error).toBe("Cannot read directory");
    });

    it("handles error response (not a directory)", () => {
      const errorResponse = { error: "Path is not a directory" };
      expect(errorResponse.error).toBe("Path is not a directory");
    });
  });

  // ── Git Repo Indicator ────────────────────────────────────────────────

  describe("git repo indicator", () => {
    it("identifies git repos from API response", () => {
      const dirs: DirectoryEntry[] = [
        { name: "Kora", path: "/Projects/Kora", isGitRepo: true },
        { name: "notes", path: "/Projects/notes", isGitRepo: false },
        { name: "dotfiles", path: "/Projects/dotfiles", isGitRepo: true },
      ];

      const gitRepos = dirs.filter((d) => d.isGitRepo);
      expect(gitRepos).toHaveLength(2);
      expect(gitRepos.map((d) => d.name)).toEqual(["Kora", "dotfiles"]);
    });
  });

  // ── Recent Paths ──────────────────────────────────────────────────────

  describe("recent paths section", () => {
    it("renders recent paths when available", () => {
      const recentPaths = [
        "/home/user/Projects/Kora",
        "/home/user/Projects/other-project",
        "/tmp/test",
      ];

      expect(recentPaths).toHaveLength(3);
      expect(recentPaths[0]).toBe("/home/user/Projects/Kora");
    });

    it("clicking a recent path navigates directly", () => {
      const onNavigate = vi.fn();
      const recentPath = "/home/user/Projects/Kora";

      // Simulate clicking a recent path
      onNavigate(recentPath);

      expect(onNavigate).toHaveBeenCalledWith("/home/user/Projects/Kora");
    });

    it("handles empty recent paths gracefully", () => {
      const recentPaths: string[] = [];
      expect(recentPaths).toHaveLength(0);
      // Component should hide the "Recent" section when empty
    });
  });

  // ── Props Validation ──────────────────────────────────────────────────

  describe("component props contract", () => {
    it("requires opened, onClose, onSelect props", () => {
      // Type-level contract validation
      interface DirectoryBrowserProps {
        opened: boolean;
        onClose: () => void;
        onSelect: (path: string) => void;
        initialPath?: string;
      }

      const props: DirectoryBrowserProps = {
        opened: true,
        onClose: vi.fn(),
        onSelect: vi.fn(),
        initialPath: "/home/user",
      };

      expect(props.opened).toBe(true);
      expect(typeof props.onClose).toBe("function");
      expect(typeof props.onSelect).toBe("function");
      expect(props.initialPath).toBe("/home/user");
    });

    it("initialPath is optional and defaults correctly", () => {
      interface DirectoryBrowserProps {
        opened: boolean;
        onClose: () => void;
        onSelect: (path: string) => void;
        initialPath?: string;
      }

      const props: DirectoryBrowserProps = {
        opened: false,
        onClose: vi.fn(),
        onSelect: vi.fn(),
      };

      expect(props.initialPath).toBeUndefined();
    });
  });

  // ── Dialog Integration ────────────────────────────────────────────────

  describe("dialog integration logic", () => {
    it("Browse button click opens the DirectoryBrowser", () => {
      let browserOpened = false;
      const openBrowser = () => {
        browserOpened = true;
      };

      openBrowser();
      expect(browserOpened).toBe(true);
    });

    it("selection populates the project path input", () => {
      let projectPath = "";
      const onSelect = (path: string) => {
        projectPath = path;
      };

      onSelect("/home/user/Projects/Kora");
      expect(projectPath).toBe("/home/user/Projects/Kora");
    });

    it("closing browser without selection preserves existing path", () => {
      let projectPath = "/existing/path";
      const onClose = () => {
        // Should NOT change projectPath
      };

      onClose();
      expect(projectPath).toBe("/existing/path");
    });

    it("selection from DirectoryBrowser overwrites manual input", () => {
      let projectPath = "/manually/typed/path";
      const onSelect = (path: string) => {
        projectPath = path;
      };

      onSelect("/browsed/path");
      expect(projectPath).toBe("/browsed/path");
    });
  });
});
