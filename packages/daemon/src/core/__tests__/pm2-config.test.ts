import { describe, it, expect } from "vitest";
import fs from "fs/promises";
import path from "path";
import os from "os";
import { generatePM2Config, writePM2Config } from "../pm2-config.js";

describe("PM2 Config", () => {
  describe("generatePM2Config", () => {
    it("generates production config", () => {
      const config = generatePM2Config({
        isDev: false,
        port: 7890,
        globalConfigDir: "/home/user/.kora",
        daemonScript: "/usr/lib/kora/cli.js",
      });

      expect(config.apps).toHaveLength(1);
      const app = config.apps[0];
      expect(app.name).toBe("kora-daemon");
      expect(app.args).toContain("start");
      expect(app.args).toContain("--port");
      expect(app.args).toContain("7890");
      expect(app.env.KORA_DEV).toBe("0");
      expect(app.max_restarts).toBe(10);
      expect(app.autorestart).toBe(true);
      expect(app.kill_timeout).toBe(10000);
    });

    it("generates dev config with --dev flag", () => {
      const config = generatePM2Config({
        isDev: true,
        port: 7891,
        globalConfigDir: "/home/user/.kora-dev",
        daemonScript: "/usr/lib/kora/cli.js",
      });

      const app = config.apps[0];
      expect(app.name).toBe("kora-daemon-dev");
      expect(app.args).toContain("--dev");
      expect(app.env.KORA_DEV).toBe("1");
      expect(app.env.NODE_ENV).toBe("development");
    });

    it("includes holdpty backend flag when specified", () => {
      const config = generatePM2Config({
        isDev: false,
        port: 7890,
        globalConfigDir: "/home/user/.kora",
        daemonScript: "/usr/lib/kora/cli.js",
        backend: "holdpty",
      });

      expect(config.apps[0].args).toContain("--backend");
      expect(config.apps[0].args).toContain("holdpty");
    });

    it("configures log paths within globalConfigDir", () => {
      const config = generatePM2Config({
        isDev: false,
        port: 7890,
        globalConfigDir: "/home/user/.kora",
        daemonScript: "/usr/lib/kora/cli.js",
      });

      const app = config.apps[0];
      expect(app.error_file).toContain(".kora");
      expect(app.out_file).toContain(".kora");
    });
  });

  describe("writePM2Config", () => {
    it("writes ecosystem.config.cjs to disk", async () => {
      const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "kora-pm2-test-"));
      try {
        const config = generatePM2Config({
          isDev: false,
          port: 7890,
          globalConfigDir: tmpDir,
          daemonScript: "/usr/lib/kora/cli.js",
        });

        const configPath = await writePM2Config(tmpDir, config);
        expect(configPath).toContain("ecosystem.config.cjs");

        const content = await fs.readFile(configPath, "utf-8");
        expect(content).toContain("module.exports");
        expect(content).toContain("kora-daemon");
      } finally {
        await fs.rm(tmpDir, { recursive: true, force: true });
      }
    });
  });
});
