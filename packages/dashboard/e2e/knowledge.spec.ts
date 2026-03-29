/**
 * E2E: Knowledge — save, search, promote to global.
 */
import { test, expect } from "./fixtures";
import { apiCall } from "./helpers";

test.describe("Knowledge", () => {
  test("save knowledge entry and retrieve it", async ({ testSession }) => {
    await apiCall(`/sessions/${testSession}/knowledge-db`, {
      method: "POST",
      body: { key: "e2e-arch", value: "Microservices with event sourcing", savedBy: "tester" },
    });

    const entry = await apiCall<{ key: string; value: string }>(`/sessions/${testSession}/knowledge-db/e2e-arch`);
    expect(entry.key).toBe("e2e-arch");
    expect(entry.value).toContain("Microservices");
  });

  test("search knowledge returns ranked results", async ({ testSession }) => {
    await apiCall(`/sessions/${testSession}/knowledge-db`, {
      method: "POST",
      body: { key: "search-auth", value: "JWT authentication with refresh tokens", savedBy: "tester" },
    });

    await apiCall(`/sessions/${testSession}/knowledge-db`, {
      method: "POST",
      body: { key: "search-db", value: "PostgreSQL database schema", savedBy: "tester" },
    });

    const results = await apiCall<{ entries: any[] }>(`/sessions/${testSession}/knowledge-db?q=JWT authentication`);
    expect(results.entries.length).toBeGreaterThanOrEqual(1);
    expect(results.entries.some((e: any) => e.key === "search-auth")).toBe(true);
  });

  test("global knowledge promote and retrieve", async () => {
    await apiCall("/global/knowledge", {
      method: "POST",
      body: { key: "e2e-global", value: "Global architecture doc", sourceSession: "e2e", promotedBy: "tester" },
    });

    const entry = await apiCall<{ key: string; value: string }>("/global/knowledge/e2e-global");
    expect(entry.value).toContain("Global architecture");

    // Cleanup
    await apiCall("/global/knowledge/e2e-global", { method: "DELETE" }).catch(() => {});
  });
});
