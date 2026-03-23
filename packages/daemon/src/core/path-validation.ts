/**
 * Path validation utilities for filesystem browsing and session creation.
 * Provides consistent path validation across all API endpoints.
 */
import fs from "fs";
import path from "path";

export interface PathValidationResult {
  valid: boolean;
  resolved: string;
  isGitRepo: boolean;
  error?: string;
}

/**
 * Validates a project path: resolves to absolute, checks existence,
 * confirms it's a directory, and detects git repos.
 */
export function validateProjectPath(inputPath: string): PathValidationResult {
  if (!inputPath || !inputPath.trim()) {
    return { valid: false, resolved: "", isGitRepo: false, error: "Path is required" };
  }

  const resolved = path.resolve(inputPath.trim());

  // Block null bytes
  if (resolved.includes("\0")) {
    return { valid: false, resolved, isGitRepo: false, error: "Invalid path" };
  }

  if (!fs.existsSync(resolved)) {
    return { valid: false, resolved, isGitRepo: false, error: "Path does not exist" };
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
