/**
 * Integration tests for get_context resource definitions.
 */

import { describe, it, expect } from "vitest";

describe("get_context resource definitions", () => {
  it("RESOURCE_DEFINITIONS includes persona and communication", async () => {
    const { RESOURCE_DEFINITIONS } = await import("../../tools/resource-registry.js");
    const uris = RESOURCE_DEFINITIONS.map((r: any) => r.uri);
    expect(uris).toContain("kora://persona");
    expect(uris).toContain("kora://communication");
  });

  it("RESOURCE_DEFINITIONS includes team, workflow, tasks, knowledge, rules, workspace", async () => {
    const { RESOURCE_DEFINITIONS } = await import("../../tools/resource-registry.js");
    const uris = RESOURCE_DEFINITIONS.map((r: any) => r.uri);
    expect(uris).toContain("kora://team");
    expect(uris).toContain("kora://workflow");
    expect(uris).toContain("kora://tasks");
    expect(uris).toContain("kora://knowledge");
    expect(uris).toContain("kora://rules");
    expect(uris).toContain("kora://workspace");
  });
});
