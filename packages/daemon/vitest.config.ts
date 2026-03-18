import { defineConfig } from "vitest/config";
import path from "path";

export default defineConfig({
  resolve: {
    alias: {
      "@kora/shared": path.resolve(__dirname, "../shared/dist/index.js"),
    },
  },
  test: {
    globals: true,
    environment: "node",
    include: ["src/**/__tests__/**/*.test.ts"],
    typecheck: {
      tsconfig: "./tsconfig.json",
    },
  },
});
