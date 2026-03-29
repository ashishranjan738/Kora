/**
 * Integration tests for tool removal (verify_work, prepare_pr, create_pr).
 */

import { describe, it, expect } from "vitest";
import { ALL_TOOL_NAMES, TOOL_DEFINITIONS } from "../../tools/tool-registry.js";

describe("Tool removal", () => {
  it("removed tools are not in ALL_TOOL_NAMES", () => {
    const names = ALL_TOOL_NAMES as readonly string[];
    expect(names).not.toContain("verify_work");
    expect(names).not.toContain("prepare_pr");
    expect(names).not.toContain("create_pr");
  });

  it("removed tools have no TOOL_DEFINITIONS entry", () => {
    const definedNames = TOOL_DEFINITIONS.map((d) => d.name);
    expect(definedNames).not.toContain("verify_work");
    expect(definedNames).not.toContain("prepare_pr");
    expect(definedNames).not.toContain("create_pr");
  });
});
