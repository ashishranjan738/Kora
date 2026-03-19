import { describe, it, expect } from "vitest";
import { execSync } from "child_process";
import * as fs from "fs";
import * as path from "path";

describe("Makefile validation", () => {
  const repoRoot = path.resolve(__dirname, "../../../../");

  // Test 1: Verify make install removes holdpty bundled node-pty
  it("removes holdpty bundled node-pty after make install", { timeout: 10000 }, () => {
    // Path to the bundled node-pty that should be removed
    const holdptyNodePtyPath = path.join(
      repoRoot,
      "node_modules",
      "holdpty",
      "node_modules",
      "node-pty"
    );

    // Check if holdpty is installed at all
    const holdptyPath = path.join(repoRoot, "node_modules", "holdpty");

    if (!fs.existsSync(holdptyPath)) {
      // If holdpty isn't installed, skip this test
      console.log("Holdpty not installed, skipping bundled node-pty check");
      return;
    }

    // Verify the bundled node-pty directory does NOT exist
    // (it should be removed by make install)
    const bundledNodePtyExists = fs.existsSync(holdptyNodePtyPath);

    expect(bundledNodePtyExists).toBe(false);
  });

  // Test 2: Verify Makefile has install target with cleanup command
  it("has install target with holdpty node-pty cleanup", () => {
    const makefilePath = path.join(repoRoot, "Makefile");

    expect(fs.existsSync(makefilePath)).toBe(true);

    const makefileContent = fs.readFileSync(makefilePath, "utf-8");

    // Verify install target exists
    expect(makefileContent).toContain("install:");

    // Verify cleanup command is present
    expect(makefileContent).toMatch(
      /rm -rf.*holdpty\/node_modules\/node-pty/
    );
  });

  // Test 3: Verify node-pty is available at top level (not bundled)
  it("has node-pty available at top level after make install", () => {
    const topLevelNodePtyPath = path.join(
      repoRoot,
      "node_modules",
      "node-pty"
    );

    // node-pty should be installed at the top level
    const topLevelExists = fs.existsSync(topLevelNodePtyPath);

    expect(topLevelExists).toBe(true);
  });
});
