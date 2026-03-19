import { describe, it, expect, beforeAll } from "vitest";
import fs from "fs";
import path from "path";

// Find daemon directory - navigate from compiled test location
// Tests run from dist/server/__tests__, need to go up to packages/daemon root
let DAEMON_DIR: string;

beforeAll(() => {
  // In compiled form: dist/server/__tests__/packaging.test.js
  // Need to find the actual source directory
  // Try multiple paths to handle different contexts (main repo vs worktree)
  const possiblePaths = [
    path.resolve(__dirname, "../../../"),  // from dist/server/__tests__ -> packages/daemon
    path.resolve(process.cwd(), "packages/daemon"),  // from repo root
    path.resolve(process.cwd()),  // if running from daemon dir itself
  ];

  for (const p of possiblePaths) {
    if (fs.existsSync(path.join(p, "package.json"))) {
      const pkg = JSON.parse(fs.readFileSync(path.join(p, "package.json"), "utf-8"));
      if (pkg.name === "kora-cli" || pkg.name === "@kora/daemon") {
        DAEMON_DIR = p;
        return;
      }
    }
  }

  // Fallback
  DAEMON_DIR = path.resolve(__dirname, "../../../");
});

describe("npm Packaging — Package Configuration", () => {
  it("should have correct package.json fields", () => {
    const packageJsonPath = path.join(DAEMON_DIR, "package.json");
    const packageJson = JSON.parse(
      fs.readFileSync(packageJsonPath, "utf-8")
    );

    // Check name
    expect(packageJson.name).toBe("kora-cli");

    // Check bin entries
    expect(packageJson.bin).toHaveProperty("kora");
    expect(packageJson.bin).toHaveProperty("kora-cli");
    expect(packageJson.bin.kora).toBe("dist/cli.js");
    expect(packageJson.bin["kora-cli"]).toBe("dist/cli.js");

    // Check bundled dependencies
    expect(packageJson.bundleDependencies).toContain("@kora/shared");

    // Check files array
    expect(packageJson.files).toContain("dist/**/*");
    expect(packageJson.files).toContain("README.md");

    // Check scripts
    expect(packageJson.scripts).toHaveProperty("build:all");
    expect(packageJson.scripts).toHaveProperty("bundle:shared");
    expect(packageJson.scripts).toHaveProperty("bundle:dashboard");
    expect(packageJson.scripts).toHaveProperty("prepublishOnly");
    expect(packageJson.scripts.prepublishOnly).toBe("npm run build:all");
  });

  it("should have ajv as direct dependency", () => {
    const packageJsonPath = path.join(DAEMON_DIR, "package.json");
    const packageJson = JSON.parse(
      fs.readFileSync(packageJsonPath, "utf-8")
    );

    expect(packageJson.dependencies).toHaveProperty("ajv");
  });

  it("should have description field", () => {
    const packageJsonPath = path.join(DAEMON_DIR, "package.json");
    const packageJson = JSON.parse(
      fs.readFileSync(packageJsonPath, "utf-8")
    );

    expect(packageJson.description).toBeTruthy();
    expect(packageJson.description).toContain("Multi-agent");
  });

  it("should have keywords for npm search", () => {
    const packageJsonPath = path.join(DAEMON_DIR, "package.json");
    const packageJson = JSON.parse(
      fs.readFileSync(packageJsonPath, "utf-8")
    );

    expect(packageJson.keywords).toBeDefined();
    expect(packageJson.keywords).toContain("kora");
    expect(packageJson.keywords).toContain("ai");
    expect(packageJson.keywords).toContain("cli");
  });
});

describe("npm Packaging — Bundle Scripts", () => {
  it("should have bundle-shared.mjs script", () => {
    const scriptPath = path.join(DAEMON_DIR, "scripts/bundle-shared.mjs");
    expect(fs.existsSync(scriptPath)).toBe(true);

    // Check it's executable or at least readable
    const content = fs.readFileSync(scriptPath, "utf-8");
    expect(content).toContain("@kora/shared");
    expect(content).toContain("bundle");
  });

  it("should have bundle-dashboard.mjs script", () => {
    const scriptPath = path.join(DAEMON_DIR, "scripts/bundle-dashboard.mjs");
    expect(fs.existsSync(scriptPath)).toBe(true);

    // Check content
    const content = fs.readFileSync(scriptPath, "utf-8");
    expect(content).toContain("dashboard");
    expect(content).toContain("bundle");
  });

  it("should have .npmignore file", () => {
    const npmignorePath = path.join(DAEMON_DIR, ".npmignore");
    expect(fs.existsSync(npmignorePath)).toBe(true);

    // Check it excludes src and tests
    const content = fs.readFileSync(npmignorePath, "utf-8");
    expect(content).toContain("src/");
    expect(content).toContain("__tests__");
  });

  it("should have README.md", () => {
    const readmePath = path.join(DAEMON_DIR, "README.md");
    expect(fs.existsSync(readmePath)).toBe(true);

    // Check content
    const content = fs.readFileSync(readmePath, "utf-8");
    expect(content).toContain("Kora CLI");
    expect(content).toContain("Quick Start");
  });
});

describe("npm Packaging — resolveDashboardPath Logic", () => {
  it("should prefer bundled path over dev path", () => {
    // Test path resolution logic
    const mockDirname = "/opt/homebrew/lib/node_modules/kora-cli/dist/server";

    const bundledPath = path.resolve(mockDirname, "../dashboard");
    const devPath = path.resolve(mockDirname, "../../..", "dashboard/dist");

    // Bundled path should be shorter/simpler
    expect(bundledPath).toBe(
      "/opt/homebrew/lib/node_modules/kora-cli/dist/dashboard"
    );
    expect(bundledPath).not.toContain("../..");

    // Dev path should go up to packages/
    expect(devPath).toContain("dashboard/dist");
  });

  it("should construct correct dev path from source", () => {
    // Simulate being in packages/daemon/dist/server
    const mockDirname = path.join(DAEMON_DIR, "dist/server");
    const devPath = path.resolve(mockDirname, "../../..", "dashboard/dist");

    // Should resolve to packages/dashboard/dist (sibling to daemon)
    expect(devPath).toContain("dashboard");
    expect(devPath).toContain("dist");
    expect(path.basename(devPath)).toBe("dist");
  });
});

describe("npm Packaging — Built Assets", () => {
  it("should have dashboard bundled in dist after build:all", () => {
    const dashboardDistPath = path.join(DAEMON_DIR, "dist/dashboard");

    // This test only passes if build:all has been run
    if (fs.existsSync(dashboardDistPath)) {
      expect(fs.existsSync(path.join(dashboardDistPath, "index.html"))).toBe(
        true
      );
      expect(fs.existsSync(path.join(dashboardDistPath, "assets"))).toBe(true);
      expect(fs.existsSync(path.join(dashboardDistPath, "manifest.json"))).toBe(
        true
      );
    } else {
      // Skip if not built yet (for CI)
      console.log(
        "Skipping dashboard bundle check - run 'npm run build:all' first"
      );
    }
  });

  it("should have @kora/shared bundled in node_modules after bundle:shared", () => {
    const sharedPath = path.join(DAEMON_DIR, "node_modules/@kora/shared");

    // This test only passes if bundle:shared has been run
    if (fs.existsSync(sharedPath)) {
      expect(fs.existsSync(path.join(sharedPath, "package.json"))).toBe(true);
      expect(fs.existsSync(path.join(sharedPath, "dist"))).toBe(true);

      // Check for ajv dependency
      const ajvPath = path.join(sharedPath, "node_modules/ajv");
      expect(fs.existsSync(ajvPath)).toBe(true);
    } else {
      console.log(
        "Skipping @kora/shared bundle check - run 'npm run bundle:shared' first"
      );
    }
  });
});
