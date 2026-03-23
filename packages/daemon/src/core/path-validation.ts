/**
 * Path validation utilities for filesystem browsing and session creation.
 * Provides consistent path validation across all API endpoints.
 */
import fs from "fs";
import os from "os";
import path from "path";

export interface PathValidationResult {
  valid: boolean;
  resolved: string;
  isGitRepo: boolean;
  error?: string;
}

export interface ValidatePathOptions {
  /** If true, enforce that the path is within the user's home directory. Default: false */
  enforceBoundary?: boolean;
}

/**
 * Validates a project path: resolves to absolute (with symlink resolution),
 * checks existence, confirms it's a directory, and detects git repos.
 */
export function validateProjectPath(inputPath: string, options: ValidatePathOptions = {}): PathValidationResult {
  if (!inputPath || !inputPath.trim()) {
    return { valid: false, resolved: "", isGitRepo: false, error: "Path is required" };
  }

  const initial = path.resolve(inputPath.trim());

  // Block null bytes
  if (initial.includes("\0")) {
    return { valid: false, resolved: initial, isGitRepo: false, error: "Invalid path" };
  }

  if (!fs.existsSync(initial)) {
    return { valid: false, resolved: initial, isGitRepo: false, error: "Path does not exist" };
  }

  // Resolve symlinks to get the real path — prevents symlink escape attacks
  let resolved: string;
  try {
    resolved = fs.realpathSync(initial);
  } catch {
    return { valid: false, resolved: initial, isGitRepo: false, error: "Cannot resolve path" };
  }

  let stat: fs.Stats;
  try {
    stat = fs.statSync(resolved);
  } catch {
    return { valid: false, resolved, isGitRepo: false, error: "Cannot access path" };
  }

  if (!stat.isDirectory()) {
    return { valid: false, resolved, isGitRepo: false, error: "Path is not a directory" };
  }

  // Upper boundary check — prevent browsing sensitive system directories
  if (options.enforceBoundary) {
    const homeDir = os.homedir();
    if (!resolved.startsWith(homeDir) && resolved !== "/") {
      return { valid: false, resolved, isGitRepo: false, error: "Access denied: path outside home directory" };
    }
  }

  // Check if it's a git repo (.git can be a directory or file for worktrees)
  let isGitRepo = false;
  try {
    const gitPath = path.join(resolved, ".git");
    if (fs.existsSync(gitPath)) {
      const gitStat = fs.statSync(gitPath);
      isGitRepo = gitStat.isDirectory() || gitStat.isFile();
    }
  } catch {
    // Not a git repo — that's fine
  }

  return { valid: true, resolved, isGitRepo };
}

/** Default set of directory names to hide in browse results */
export const DEFAULT_HIDDEN_PATTERNS = new Set([
  "node_modules",
  ".git",
  ".next",
  ".nuxt",
  ".svelte-kit",
  "__pycache__",
  ".cache",
  ".turbo",
  ".parcel-cache",
]);

/**
 * Determines if a directory entry should be hidden in browse results.
 * Hidden = starts with "." OR is in the default hidden patterns list.
 */
export function isHiddenDirectory(name: string): boolean {
  return name.startsWith(".") || DEFAULT_HIDDEN_PATTERNS.has(name);
}
