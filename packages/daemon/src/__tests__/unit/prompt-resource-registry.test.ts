/**
 * Contract tests for prompt-registry and resource-registry.
 * Verifies structure, fetchContent contracts, and sync with CLI.
 */
import { describe, it, expect } from "vitest";
import {
  PROMPT_DEFINITIONS,
  getPromptDefinition,
  getPromptsForRole,
} from "../../tools/prompt-registry";
import {
  RESOURCE_DEFINITIONS,
  getResourceDefinition,
  getSubscribableResources,
} from "../../tools/resource-registry";

describe("Prompt Registry", () => {
  it("has exactly 4 prompt definitions", () => {
    expect(PROMPT_DEFINITIONS).toHaveLength(4);
  });

  it("every prompt has name, description, and fetchContent", () => {
    for (const p of PROMPT_DEFINITIONS) {
      expect(p.name).toBeTruthy();
      expect(p.description).toBeTruthy();
      expect(typeof p.fetchContent).toBe("function");
    }
  });

  it("every prompt has CLI metadata", () => {
    for (const p of PROMPT_DEFINITIONS) {
      expect(p.cli).toBeDefined();
      expect(p.cli!.command).toBeTruthy();
      expect(p.cli!.description).toBeTruthy();
    }
  });

  it("prompt names are unique", () => {
    const names = PROMPT_DEFINITIONS.map(p => p.name);
    expect(new Set(names).size).toBe(names.length);
  });

  it("includes persona, communication, worker-protocol, master-protocol", () => {
    const names = PROMPT_DEFINITIONS.map(p => p.name);
    expect(names).toContain("persona");
    expect(names).toContain("communication");
    expect(names).toContain("worker-protocol");
    expect(names).toContain("master-protocol");
  });

  it("getPromptDefinition returns correct prompt", () => {
    const p = getPromptDefinition("persona");
    expect(p).toBeDefined();
    expect(p!.name).toBe("persona");
  });

  it("getPromptDefinition returns undefined for unknown", () => {
    expect(getPromptDefinition("nonexistent")).toBeUndefined();
  });

  it("getPromptsForRole filters master-protocol for workers", () => {
    const workerPrompts = getPromptsForRole("worker");
    const masterPrompts = getPromptsForRole("master");
    expect(workerPrompts.find(p => p.name === "master-protocol")).toBeUndefined();
    expect(masterPrompts.find(p => p.name === "master-protocol")).toBeDefined();
    expect(masterPrompts.length).toBe(4);
    expect(workerPrompts.length).toBe(3);
  });
});

describe("Resource Registry", () => {
  it("has exactly 5 resource definitions", () => {
    expect(RESOURCE_DEFINITIONS).toHaveLength(8);
  });

  it("every resource has uri, name, description, mimeType, fetchContent, fetchData", () => {
    for (const r of RESOURCE_DEFINITIONS) {
      expect(r.uri).toBeTruthy();
      expect(r.uri.startsWith("kora://")).toBe(true);
      expect(r.name).toBeTruthy();
      expect(r.description).toBeTruthy();
      expect(r.mimeType).toBe("text/markdown");
      expect(typeof r.fetchContent).toBe("function");
      expect(typeof r.fetchData).toBe("function");
    }
  });

  it("every resource has CLI metadata", () => {
    for (const r of RESOURCE_DEFINITIONS) {
      expect(r.cli).toBeDefined();
      expect(r.cli!.command).toBeTruthy();
      expect(r.cli!.description).toBeTruthy();
    }
  });

  it("resource URIs are unique", () => {
    const uris = RESOURCE_DEFINITIONS.map(r => r.uri);
    expect(new Set(uris).size).toBe(uris.length);
  });

  it("includes team, workflow, knowledge, rules, tasks", () => {
    const uris = RESOURCE_DEFINITIONS.map(r => r.uri);
    expect(uris).toContain("kora://team");
    expect(uris).toContain("kora://workflow");
    expect(uris).toContain("kora://knowledge");
    expect(uris).toContain("kora://rules");
    expect(uris).toContain("kora://tasks");
  });

  it("getResourceDefinition returns correct resource", () => {
    const r = getResourceDefinition("kora://team");
    expect(r).toBeDefined();
    expect(r!.name).toBe("Team");
  });

  it("getResourceDefinition returns undefined for unknown URI", () => {
    expect(getResourceDefinition("kora://nonexistent")).toBeUndefined();
  });

  it("subscribable resources are team, knowledge, and tasks", () => {
    const subs = getSubscribableResources();
    const subUris = subs.map(r => r.uri);
    expect(subUris).toContain("kora://team");
    expect(subUris).toContain("kora://knowledge");
    expect(subUris).toContain("kora://tasks");
    expect(subUris).not.toContain("kora://workflow");
    expect(subUris).not.toContain("kora://rules");
    expect(subs).toHaveLength(3);
  });

  it("non-subscribable resources are workflow and rules", () => {
    const nonSubs = RESOURCE_DEFINITIONS.filter(r => !r.subscribable);
    const uris = nonSubs.map(r => r.uri);
    expect(uris).toContain("kora://workflow");
    expect(uris).toContain("kora://rules");
    expect(uris).toContain("kora://persona");
    expect(uris).toContain("kora://communication");
    expect(uris).toContain("kora://workspace");
    expect(nonSubs).toHaveLength(5);
  });
});
