/**
 * ESLint 9 flat config for Kora monorepo.
 * Uses typescript-eslint for TS parsing. Type-checking handled by `make typecheck`.
 */
import tseslint from "typescript-eslint";

export default tseslint.config(
  // TypeScript recommended rules (includes parser)
  ...tseslint.configs.recommended,

  // Project-specific overrides
  {
    files: ["packages/*/src/**/*.ts", "packages/*/src/**/*.tsx"],
    rules: {
      // Relax rules that are too strict for this codebase
      "@typescript-eslint/no-explicit-any": "off",    // Used extensively for API responses
      "@typescript-eslint/no-unused-vars": "off",     // tsc strict mode handles this
      "@typescript-eslint/no-require-imports": "off",  // Used in a few legacy spots
      "@typescript-eslint/no-empty-object-type": "off", // Used in EventEmitter patterns

      // Keep useful rules
      "no-debugger": "error",
      "no-duplicate-case": "error",
      "no-constant-condition": ["error", { checkLoops: false }],
    },
  },

  // Ignore build outputs and generated files
  {
    ignores: [
      "**/dist/**",
      "**/node_modules/**",
      "**/.kora/**",
      "**/.kora-dev/**",
      "**/.claude/**",
      "**/coverage/**",
    ],
  },
);
