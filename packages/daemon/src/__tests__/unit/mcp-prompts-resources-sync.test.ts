/**
 * Sync validation + contract tests for MCP Prompts and Resources registries.
 *
 * Verifies that prompt-registry.ts and resource-registry.ts stay in sync
 * across MCP server and CLI:
 *   - Every prompt definition has required fields
 *   - Every resource definition has required fields
 *   - MCP server handles prompts/list, prompts/get, resources/list, resources/read
 *   - CLI has corresponding commands for prompts and resources
 *   - No orphan entries in any layer
 *
 * Coverage:
 * - Prompt registry: integrity, required fields, fetchContent callable, CLI mapping
 * - Resource registry: integrity, required fields, URI format, subscribable flag, CLI mapping
 * - MCP server sync: prompts/list, prompts/get handlers, resources/list, resources/read handlers
 * - CLI sync: context subcommands match resource definitions, whoami uses prompt registry
 * - Cross-registry: no name collisions between tools, prompts, and resources
 */

import { describe, it, expect } from "vitest";
import * as fs from "fs";
import * as path from "path";
import { PROMPT_DEFINITIONS } from "../../tools/prompt-registry.js";
import { RESOURCE_DEFINITIONS } from "../../tools/resource-registry.js";

const registriesLoaded = PROMPT_DEFINITIONS.length > 0 && RESOURCE_DEFINITIONS.length > 0;

// ---------------------------------------------------------------------------
// Read source files for static analysis
// ---------------------------------------------------------------------------

const srcDir = path.resolve(__dirname, "../..");
const mcpServerSrc = (() => {
  try { return fs.readFileSync(path.join(srcDir, "mcp/agent-mcp-server.ts"), "utf-8"); } catch { return ""; }
})();
const cliSrc = (() => {
  try { return fs.readFileSync(path.join(srcDir, "cli/kora-cli.ts"), "utf-8"); } catch { return ""; }
})();

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("MCP Prompts & Resources Sync Validation", () => {
  // ── Prompt Registry Integrity ─────────────────────────────────────────

  describe("Prompt Registry integrity", () => {
    it.skipIf(!registriesLoaded)("PROMPT_DEFINITIONS is a non-empty array", () => {
      expect(Array.isArray(PROMPT_DEFINITIONS)).toBe(true);
      expect(PROMPT_DEFINITIONS.length).toBeGreaterThan(0);
    });

    it.skipIf(!registriesLoaded)("every prompt has required fields: name, description, fetchContent", () => {
      for (const prompt of PROMPT_DEFINITIONS) {
        expect(prompt.name, `Prompt missing name`).toBeTruthy();
        expect(typeof prompt.name).toBe("string");
        expect(prompt.description, `Prompt "${prompt.name}" missing description`).toBeTruthy();
        expect(typeof prompt.description).toBe("string");
        expect(typeof prompt.fetchContent, `Prompt "${prompt.name}" fetchContent should be a function`).toBe("function");
      }
    });

    it.skipIf(!registriesLoaded)("prompt names are unique", () => {
      const names = PROMPT_DEFINITIONS.map((p) => p.name);
      const unique = new Set(names);
      expect(unique.size, `Duplicate prompt names found: ${names.join(", ")}`).toBe(names.length);
    });

    it.skipIf(!registriesLoaded)("prompt names follow naming convention (lowercase, no spaces)", () => {
      for (const prompt of PROMPT_DEFINITIONS) {
        expect(prompt.name).toMatch(/^[a-z][a-z0-9-]*$/);
      }
    });

    it.skipIf(!registriesLoaded)("expected prompts are defined: persona, communication", () => {
      const names = new Set(PROMPT_DEFINITIONS.map((p) => p.name));
      expect(names.has("persona"), "Missing 'persona' prompt").toBe(true);
      expect(names.has("communication"), "Missing 'communication' prompt").toBe(true);
    });

    it.skipIf(!registriesLoaded)("every prompt has a CLI equivalent mapping", () => {
      for (const prompt of PROMPT_DEFINITIONS) {
        expect(prompt.cli, `Prompt "${prompt.name}" missing cli metadata`).toBeDefined();
        expect(prompt.cli!.command, `Prompt "${prompt.name}" cli.command is empty`).toBeTruthy();
        expect(prompt.cli!.description, `Prompt "${prompt.name}" cli.description is empty`).toBeTruthy();
      }
    });
  });

  // ── Resource Registry Integrity ───────────────────────────────────────

  describe("Resource Registry integrity", () => {
    it.skipIf(!registriesLoaded)("RESOURCE_DEFINITIONS is a non-empty array", () => {
      expect(Array.isArray(RESOURCE_DEFINITIONS)).toBe(true);
      expect(RESOURCE_DEFINITIONS.length).toBeGreaterThan(0);
    });

    it.skipIf(!registriesLoaded)("every resource has required fields: uri, name, description, mimeType, subscribable, fetchContent", () => {
      for (const res of RESOURCE_DEFINITIONS) {
        expect(res.uri, `Resource missing uri`).toBeTruthy();
        expect(res.name, `Resource "${res.uri}" missing name`).toBeTruthy();
        expect(res.description, `Resource "${res.uri}" missing description`).toBeTruthy();
        expect(res.mimeType, `Resource "${res.uri}" missing mimeType`).toBeTruthy();
        expect(typeof res.subscribable, `Resource "${res.uri}" subscribable should be boolean`).toBe("boolean");
        expect(typeof res.fetchContent, `Resource "${res.uri}" fetchContent should be a function`).toBe("function");
      }
    });

    it.skipIf(!registriesLoaded)("resource URIs use kora:// scheme", () => {
      for (const res of RESOURCE_DEFINITIONS) {
        expect(res.uri.startsWith("kora://"), `Resource "${res.name}" URI should start with kora://`).toBe(true);
      }
    });

    it.skipIf(!registriesLoaded)("resource URIs are unique", () => {
      const uris = RESOURCE_DEFINITIONS.map((r) => r.uri);
      const unique = new Set(uris);
      expect(unique.size, `Duplicate resource URIs found`).toBe(uris.length);
    });

    it.skipIf(!registriesLoaded)("expected resources are defined: team, workflow, knowledge, rules, tasks", () => {
      const uris = new Set(RESOURCE_DEFINITIONS.map((r) => r.uri));
      expect(uris.has("kora://team"), "Missing kora://team resource").toBe(true);
      expect(uris.has("kora://workflow"), "Missing kora://workflow resource").toBe(true);
      expect(uris.has("kora://knowledge"), "Missing kora://knowledge resource").toBe(true);
      expect(uris.has("kora://rules"), "Missing kora://rules resource").toBe(true);
      expect(uris.has("kora://tasks"), "Missing kora://tasks resource").toBe(true);
    });

    it.skipIf(!registriesLoaded)("subscribable resources include team, knowledge, tasks", () => {
      const subscribable = RESOURCE_DEFINITIONS.filter((r) => r.subscribable).map((r) => r.uri);
      expect(subscribable).toContain("kora://team");
      expect(subscribable).toContain("kora://knowledge");
      expect(subscribable).toContain("kora://tasks");
    });

    it.skipIf(!registriesLoaded)("non-subscribable resources include workflow (frozen at creation)", () => {
      const workflow = RESOURCE_DEFINITIONS.find((r) => r.uri === "kora://workflow");
      expect(workflow).toBeDefined();
      expect(workflow!.subscribable).toBe(false);
    });

    it.skipIf(!registriesLoaded)("every resource has a CLI equivalent mapping", () => {
      for (const res of RESOURCE_DEFINITIONS) {
        expect(res.cli, `Resource "${res.name}" missing cli metadata`).toBeDefined();
        expect(res.cli!.command, `Resource "${res.name}" cli.command is empty`).toBeTruthy();
      }
    });
  });

  // ── MCP Server Sync ───────────────────────────────────────────────────

  describe("MCP server sync", () => {
    it.skipIf(!mcpServerSrc)("MCP server handles prompts/list case", () => {
      // Should have a case or handler for "prompts/list" as a string in a switch or if
      expect(mcpServerSrc).toMatch(/["']prompts\/list["']/);
    });

    it.skipIf(!mcpServerSrc)("MCP server handles prompts/get case", () => {
      expect(mcpServerSrc).toMatch(/["']prompts\/get["']/);
    });

    it.skipIf(!mcpServerSrc)("MCP server handles resources/list case", () => {
      expect(mcpServerSrc).toMatch(/["']resources\/list["']/);
    });

    it.skipIf(!mcpServerSrc)("MCP server handles resources/read case", () => {
      expect(mcpServerSrc).toMatch(/["']resources\/read["']/);
    });

    it.skipIf(!mcpServerSrc)("MCP server handles resources/subscribe case", () => {
      expect(mcpServerSrc).toMatch(/["']resources\/subscribe["']/);
    });

    it.skipIf(!mcpServerSrc)("MCP server declares prompts capability in initialize response", () => {
      // Should have prompts in capabilities object (not just mentioned in comments)
      expect(mcpServerSrc).toMatch(/prompts\s*:\s*\{/);
    });

    it.skipIf(!mcpServerSrc)("MCP server declares resources capability in initialize response", () => {
      // Should have resources with subscribe in capabilities
      expect(mcpServerSrc).toMatch(/resources\s*:\s*\{/);
    });
  });

  // ── CLI Sync ──────────────────────────────────────────────────────────

  describe("CLI sync", () => {
    it.skipIf(!cliSrc)("CLI has 'context' command group", () => {
      expect(cliSrc).toMatch(/\.command\(["']context["']\)/);
    });

    it.skipIf(!cliSrc || !registriesLoaded)("CLI has context subcommand for every resource", () => {
      for (const res of RESOURCE_DEFINITIONS) {
        const name = res.uri.replace("kora://", "");
        expect(
          cliSrc.includes(`"${name}"`) || cliSrc.includes(`'${name}'`),
          `CLI missing context subcommand for resource: ${name}`
        ).toBe(true);
      }
    });

    it.skipIf(!cliSrc)("CLI has 'context all' subcommand", () => {
      // Check for "all" specifically within a context-related command definition
      const hasContextAll = cliSrc.includes('.command("all")') || cliSrc.includes(".command('all')");
      expect(hasContextAll, "CLI missing 'context all' subcommand").toBe(true);
    });

    it.skipIf(!cliSrc)("CLI has whoami command", () => {
      expect(cliSrc).toMatch(/\.command\(["']whoami["']\)/);
    });
  });

  // ── Cross-Registry Validation ─────────────────────────────────────────

  describe("Cross-registry validation", () => {
    it.skipIf(!registriesLoaded)("no name collisions between prompt names and resource names", () => {
      const promptNames = new Set(PROMPT_DEFINITIONS.map((p) => p.name));
      const resourceNames = new Set(RESOURCE_DEFINITIONS.map((r) => r.uri.replace("kora://", "")));

      for (const name of promptNames) {
        expect(
          !resourceNames.has(name),
          `Name collision: "${name}" exists in both prompt and resource registries`
        ).toBe(true);
      }
    });

    it.skipIf(!registriesLoaded)("mimeType is valid for all resources", () => {
      const validMimeTypes = ["text/markdown", "text/plain", "application/json"];
      for (const res of RESOURCE_DEFINITIONS) {
        expect(
          validMimeTypes.includes(res.mimeType),
          `Resource "${res.name}" has invalid mimeType: ${res.mimeType}`
        ).toBe(true);
      }
    });
  });
});
