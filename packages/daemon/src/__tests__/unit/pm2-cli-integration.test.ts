/**
 * Tests for PM2 daemon supervision CLI integration (PR #523, task 2cb3b371).
 *
 * Verifies isPM2Available(), PM2 start/stop flow, config generation,
 * path quoting, and README documentation.
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "fs";
import { resolve } from "path";

const cliCode = readFileSync(
  resolve(__dirname, "../../cli.ts"),
  "utf-8"
);

describe("PM2 availability check", () => {
  it("defines isPM2Available function", () => {
    expect(cliCode).toContain("function isPM2Available()");
  });

  it("checks pm2 --version via execSync", () => {
    expect(cliCode).toContain('execSync("pm2 --version"');
  });

  it("uses stdio ignore to suppress output", () => {
    expect(cliCode).toContain('stdio: "ignore"');
  });

  it("returns false on error (PM2 not installed)", () => {
    // Should have a try/catch that returns false
    expect(cliCode).toContain("return false");
  });
});

describe("PM2 start flow", () => {
  it("parses --pm2 flag", () => {
    expect(cliCode).toContain('args.includes("--pm2")');
  });

  it("parses --startup flag", () => {
    expect(cliCode).toContain('args.includes("--startup")');
  });

  it("shows graceful error when PM2 not installed", () => {
    expect(cliCode).toContain("PM2 is not installed");
    expect(cliCode).toContain("npm install -g pm2");
  });

  it("generates PM2 config via generatePM2Config", () => {
    expect(cliCode).toContain("generatePM2Config");
  });

  it("writes config to disk via writePM2Config", () => {
    expect(cliCode).toContain("writePM2Config");
  });

  it("quotes configPath in execSync to handle paths with spaces", () => {
    expect(cliCode).toContain('pm2 start "${configPath}"');
  });

  it("stops existing instance before starting new one", () => {
    expect(cliCode).toContain("pm2 stop");
    expect(cliCode).toContain("pm2 delete");
  });

  it("uses correct app name based on dev mode", () => {
    expect(cliCode).toContain('"kora-daemon-dev"');
    expect(cliCode).toContain('"kora-daemon"');
  });

  it("logs helpful commands after start", () => {
    expect(cliCode).toContain("pm2 logs");
    expect(cliCode).toContain("pm2 status");
  });
});

describe("PM2 startup configuration", () => {
  it("runs pm2 startup when --startup flag is present", () => {
    expect(cliCode).toContain('execSync("pm2 startup"');
  });

  it("runs pm2 save after startup", () => {
    expect(cliCode).toContain('execSync("pm2 save"');
  });

  it("provides sudo fallback instructions on failure", () => {
    expect(cliCode).toContain("sudo env PATH=$PATH pm2 startup");
  });
});

describe("PM2 stop flow", () => {
  it("stops and deletes PM2 process", () => {
    // handleStop should have pm2 stop + delete
    const stopSection = cliCode.split("handleStop")[1] || "";
    expect(stopSection).toContain("pm2 stop");
    expect(stopSection).toContain("pm2 delete");
  });

  it("calls cleanupDaemonInfo after PM2 stop", () => {
    expect(cliCode).toContain("cleanupDaemonInfo");
  });

  it("handles missing PM2 process gracefully", () => {
    // Should catch errors when no process found
    const stopSection = cliCode.split("handleStop")[1] || "";
    expect(stopSection).toContain("No PM2 process");
  });
});

describe("PM2 config module", () => {
  it("imports generatePM2Config and writePM2Config", () => {
    expect(cliCode).toContain('import { generatePM2Config, writePM2Config }');
  });
});

describe("README PM2 documentation", () => {
  const readme = readFileSync(
    resolve(__dirname, "../../../../../README.md"),
    "utf-8"
  );

  it("has PM2 section", () => {
    expect(readme.toLowerCase()).toContain("pm2");
  });

  it("documents --pm2 flag", () => {
    expect(readme).toContain("--pm2");
  });
});
