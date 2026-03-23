/**
 * Integration tests for GET /api/v1/browse/directories endpoint.
 *
 * Coverage:
 * - Happy path: lists subdirectories at a given path
 * - Default to home directory when no path param
 * - isGitRepo detection (directories with .git folder/file)
 * - Sorting: alphabetical order
 * - Hidden directory filtering (default vs showHidden=true)
 * - Parent path returned (null at root)
 * - Path traversal protection (.. sequences resolved safely)
 * - Boundary enforcement (paths outside home dir rejected)
 * - Null byte rejection
 * - Non-existent path -> 404
 * - File path (not directory) -> 400
 * - Empty directory -> empty array
 * - Response shape validation
 * - Auth required
 */

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import request from "supertest";
import { mkdirSync, writeFileSync } from "fs";
import { join } from "path";
import { homedir } from "os";
import { setupTestApp, type TestContext } from "./test-setup.js";

describe("GET /api/v1/browse/directories", () => {
  let ctx: TestContext;
  let testRoot: string;

  const auth = () => ({ Authorization: `Bearer ${ctx.token}` });

  beforeAll(() => {
    ctx = setupTestApp();

    // Create test directory under home dir to satisfy boundary enforcement
    testRoot = join(homedir(), ".kora-test-browse-" + Date.now());
    mkdirSync(testRoot, { recursive: true });

    // Create test directory structure:
    // testRoot/
    //   alpha/
    //   beta/
    //     .git/          <- git repo (directory)
    //   gamma/
    //   .hidden-dir/     <- hidden (dot-prefixed)
    //   file.txt         <- not a directory
    //   empty-dir/
    //   git-worktree/
    //     .git           <- file (worktree-style)

    mkdirSync(join(testRoot, "alpha"), { recursive: true });
    mkdirSync(join(testRoot, "beta", ".git"), { recursive: true });
    mkdirSync(join(testRoot, "gamma"), { recursive: true });
    mkdirSync(join(testRoot, ".hidden-dir"), { recursive: true });
    mkdirSync(join(testRoot, "empty-dir"), { recursive: true });
    writeFileSync(join(testRoot, "file.txt"), "not a directory");

    // Git worktree style: .git is a file, not a directory
    mkdirSync(join(testRoot, "git-worktree"), { recursive: true });
    writeFileSync(
      join(testRoot, "git-worktree", ".git"),
      "gitdir: /some/other/path/.git/worktrees/foo"
    );
  });

  afterAll(() => {
    // Clean up test directory under home
    try {
      const { rmSync } = require("fs");
      rmSync(testRoot, { recursive: true, force: true });
    } catch {
      // ignore
    }
    ctx.cleanup();
  });

  // ── Happy Path ────────────────────────────────────────────────────────

  it("returns directory listing for a valid path", async () => {
    const res = await request(ctx.app)
      .get("/api/v1/browse/directories")
      .query({ path: testRoot })
      .set(auth());

    expect(res.status).toBe(200);
    expect(res.body).toHaveProperty("currentPath");
    expect(res.body).toHaveProperty("parent");
    expect(res.body).toHaveProperty("directories");
    expect(Array.isArray(res.body.directories)).toBe(true);
  });

  it("returns correct response shape for each directory entry", async () => {
    const res = await request(ctx.app)
      .get("/api/v1/browse/directories")
      .query({ path: testRoot })
      .set(auth());

    expect(res.status).toBe(200);
    for (const dir of res.body.directories) {
      expect(dir).toHaveProperty("name");
      expect(dir).toHaveProperty("path");
      expect(dir).toHaveProperty("isGitRepo");
      expect(typeof dir.name).toBe("string");
      expect(typeof dir.path).toBe("string");
      expect(typeof dir.isGitRepo).toBe("boolean");
    }
  });

  it("includes homeDir in response", async () => {
    const res = await request(ctx.app)
      .get("/api/v1/browse/directories")
      .query({ path: testRoot })
      .set(auth());

    expect(res.status).toBe(200);
    expect(res.body).toHaveProperty("homeDir");
    expect(res.body.homeDir).toBe(homedir());
  });

  it("returns only directories, not files", async () => {
    const res = await request(ctx.app)
      .get("/api/v1/browse/directories")
      .query({ path: testRoot })
      .set(auth());

    expect(res.status).toBe(200);
    const names = res.body.directories.map((d: any) => d.name);
    expect(names).not.toContain("file.txt");
  });

  it("currentPath matches the resolved requested path", async () => {
    const res = await request(ctx.app)
      .get("/api/v1/browse/directories")
      .query({ path: testRoot })
      .set(auth());

    expect(res.status).toBe(200);
    expect(res.body.currentPath).toBe(testRoot);
  });

  it("returns parent directory path", async () => {
    const res = await request(ctx.app)
      .get("/api/v1/browse/directories")
      .query({ path: testRoot })
      .set(auth());

    expect(res.status).toBe(200);
    expect(res.body.parent).toBe(join(testRoot, ".."));
  });

  // ── Default Path ──────────────────────────────────────────────────────

  it("defaults to home directory when no path param provided", async () => {
    const res = await request(ctx.app)
      .get("/api/v1/browse/directories")
      .set(auth());

    expect(res.status).toBe(200);
    expect(res.body.currentPath).toBe(homedir());
  });

  it("defaults to home directory when path param is empty string", async () => {
    const res = await request(ctx.app)
      .get("/api/v1/browse/directories")
      .query({ path: "" })
      .set(auth());

    expect(res.status).toBe(200);
    expect(res.body.currentPath).toBe(homedir());
  });

  it("defaults to home directory when path param is whitespace", async () => {
    const res = await request(ctx.app)
      .get("/api/v1/browse/directories")
      .query({ path: "   " })
      .set(auth());

    expect(res.status).toBe(200);
    expect(res.body.currentPath).toBe(homedir());
  });

  // ── Git Repo Detection ────────────────────────────────────────────────

  it("detects .git directory as git repo", async () => {
    const res = await request(ctx.app)
      .get("/api/v1/browse/directories")
      .query({ path: testRoot })
      .set(auth());

    expect(res.status).toBe(200);
    const beta = res.body.directories.find((d: any) => d.name === "beta");
    expect(beta).toBeDefined();
    expect(beta.isGitRepo).toBe(true);
  });

  it("detects .git file (worktree) as git repo", async () => {
    const res = await request(ctx.app)
      .get("/api/v1/browse/directories")
      .query({ path: testRoot })
      .set(auth());

    expect(res.status).toBe(200);
    const wt = res.body.directories.find((d: any) => d.name === "git-worktree");
    expect(wt).toBeDefined();
    expect(wt.isGitRepo).toBe(true);
  });

  it("returns isGitRepo false for non-git directories", async () => {
    const res = await request(ctx.app)
      .get("/api/v1/browse/directories")
      .query({ path: testRoot })
      .set(auth());

    expect(res.status).toBe(200);
    const alpha = res.body.directories.find((d: any) => d.name === "alpha");
    expect(alpha).toBeDefined();
    expect(alpha.isGitRepo).toBe(false);
  });

  // ── Hidden Directory Filtering ─────────────────────────────────────────

  it("filters hidden directories by default", async () => {
    const res = await request(ctx.app)
      .get("/api/v1/browse/directories")
      .query({ path: testRoot })
      .set(auth());

    expect(res.status).toBe(200);
    const names = res.body.directories.map((d: any) => d.name);
    expect(names).not.toContain(".hidden-dir");
  });

  it("includes hidden directories when showHidden=true", async () => {
    const res = await request(ctx.app)
      .get("/api/v1/browse/directories")
      .query({ path: testRoot, showHidden: "true" })
      .set(auth());

    expect(res.status).toBe(200);
    const names = res.body.directories.map((d: any) => d.name);
    expect(names).toContain(".hidden-dir");
  });

  // ── Sorting ───────────────────────────────────────────────────────────

  it("sorts directories alphabetically", async () => {
    const res = await request(ctx.app)
      .get("/api/v1/browse/directories")
      .query({ path: testRoot })
      .set(auth());

    expect(res.status).toBe(200);
    const names = res.body.directories.map((d: any) => d.name);
    const sorted = [...names].sort((a: string, b: string) => a.localeCompare(b));
    expect(names).toEqual(sorted);
  });

  // ── Empty Directory ───────────────────────────────────────────────────

  it("returns empty array for empty directory", async () => {
    const res = await request(ctx.app)
      .get("/api/v1/browse/directories")
      .query({ path: join(testRoot, "empty-dir") })
      .set(auth());

    expect(res.status).toBe(200);
    expect(res.body.directories).toEqual([]);
    expect(res.body.currentPath).toBe(join(testRoot, "empty-dir"));
    expect(res.body.parent).toBe(testRoot);
  });

  // ── Root Path ─────────────────────────────────────────────────────────

  it("returns null parent at filesystem root", async () => {
    const res = await request(ctx.app)
      .get("/api/v1/browse/directories")
      .query({ path: "/" })
      .set(auth());

    expect(res.status).toBe(200);
    expect(res.body.currentPath).toBe("/");
    expect(res.body.parent).toBeNull();
  });

  // ── Error Cases ───────────────────────────────────────────────────────

  it("returns 404 for non-existent path", async () => {
    const nonExistent = join(homedir(), "this-path-definitely-does-not-exist-" + Date.now());
    const res = await request(ctx.app)
      .get("/api/v1/browse/directories")
      .query({ path: nonExistent })
      .set(auth());

    expect(res.status).toBe(404);
    expect(res.body).toHaveProperty("error");
  });

  it("returns 400 for path that is a file, not directory", async () => {
    const res = await request(ctx.app)
      .get("/api/v1/browse/directories")
      .query({ path: join(testRoot, "file.txt") })
      .set(auth());

    expect(res.status).toBe(400);
    expect(res.body).toHaveProperty("error");
  });

  // ── Security: Boundary Enforcement ────────────────────────────────────

  it("rejects paths outside home directory with 403", async () => {
    const res = await request(ctx.app)
      .get("/api/v1/browse/directories")
      .query({ path: "/etc" })
      .set(auth());

    expect(res.status).toBe(403);
    expect(res.body.error).toMatch(/access denied/i);
  });

  // ── Security: Path Traversal ──────────────────────────────────────────

  it("resolves .. sequences safely (path traversal)", async () => {
    // Try to escape via .. — should resolve to the real path
    const res = await request(ctx.app)
      .get("/api/v1/browse/directories")
      .query({ path: join(testRoot, "alpha", "..", ".", "empty-dir") })
      .set(auth());

    // Should resolve successfully to testRoot/empty-dir
    expect(res.status).toBe(200);
    expect(res.body.currentPath).toBe(join(testRoot, "empty-dir"));
  });

  it("rejects paths with null bytes", async () => {
    const res = await request(ctx.app)
      .get("/api/v1/browse/directories")
      .query({ path: join(homedir(), "\0malicious") })
      .set(auth());

    // Should be rejected — either 400 or 404
    expect([400, 404, 500]).toContain(res.status);
  });

  // ── Auth ──────────────────────────────────────────────────────────────

  it("rejects unauthenticated requests", async () => {
    const res = await request(ctx.app)
      .get("/api/v1/browse/directories")
      .query({ path: testRoot });

    expect(res.status).toBe(401);
  });
});
