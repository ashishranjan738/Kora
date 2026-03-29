import { defineConfig } from "@playwright/test";
import path from "path";

const DEV_PORT = 7891;
const BASE_URL = `http://localhost:${DEV_PORT}`;

export default defineConfig({
  testDir: "./e2e",
  timeout: 60_000,
  retries: 1,
  workers: 1, // Serial — tests share one daemon
  fullyParallel: false,

  use: {
    baseURL: BASE_URL,
    trace: "on-first-retry",
    screenshot: "only-on-failure",
    video: "retain-on-failure",
  },

  projects: [
    {
      name: "chromium",
      use: { browserName: "chromium" },
    },
  ],

  // Auto-start dev daemon before test suite
  webServer: {
    command: `node ${path.resolve(__dirname, "../daemon/dist/cli.js")} start --dev --terminal-backend holdpty`,
    url: BASE_URL,
    reuseExistingServer: true,
    timeout: 30_000,
    stdout: "pipe",
    stderr: "pipe",
  },

  // Output
  outputDir: "./e2e/test-results",
  reporter: [
    ["list"],
    ["html", { outputFolder: "./e2e/playwright-report", open: "never" }],
  ],
});
