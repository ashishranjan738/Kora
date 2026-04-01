/**
 * Integration tests for GET /sessions/:sid/files/raw endpoint (PR #515).
 *
 * Verifies binary file serving with correct Content-Type, path traversal
 * protection, security headers, and inline vs. attachment disposition.
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import request from "supertest";
import { setupTestApp, type TestContext } from "./test-setup.js";
import { join } from "path";
import { mkdirSync, writeFileSync, realpathSync } from "fs";

describe("GET /sessions/:sid/files/raw", () => {
  let ctx: TestContext;
  let sessionId: string;
  let projectPath: string;

  beforeEach(async () => {
    ctx = setupTestApp();
    await ctx.sessionManager.load();

    // Create project directory with test files
    projectPath = join(ctx.testDir, "raw-test-project");
    mkdirSync(projectPath, { recursive: true });

    // Create various test files
    writeFileSync(join(projectPath, "image.png"), Buffer.from([0x89, 0x50, 0x4e, 0x47])); // PNG magic bytes
    writeFileSync(join(projectPath, "photo.jpg"), Buffer.from([0xff, 0xd8, 0xff])); // JPEG magic bytes
    writeFileSync(join(projectPath, "doc.pdf"), Buffer.from("%PDF-1.4"));
    writeFileSync(join(projectPath, "readme.md"), "# Hello\n\nThis is markdown.");
    writeFileSync(join(projectPath, "data.json"), '{"key": "value"}');
    writeFileSync(join(projectPath, "style.css"), "body { color: red; }");
    writeFileSync(join(projectPath, "app.ts"), "const x: number = 1;");
    writeFileSync(join(projectPath, "archive.zip"), Buffer.from([0x50, 0x4b, 0x03, 0x04]));
    mkdirSync(join(projectPath, "subdir"), { recursive: true });
    writeFileSync(join(projectPath, "subdir", "nested.txt"), "nested file");

    // Create session
    const res = await request(ctx.app)
      .post("/api/v1/sessions")
      .set("Authorization", `Bearer ${ctx.token}`)
      .send({ name: "Raw Test", projectPath, provider: "claude-code" });

    sessionId = res.body.id;
  });

  afterEach(() => {
    ctx.cleanup();
  });

  // --- Happy path: correct MIME types ---

  it("serves PNG with image/png content type", async () => {
    const res = await request(ctx.app)
      .get(`/api/v1/sessions/${sessionId}/files/raw`)
      .query({ path: "image.png" })
      .set("Authorization", `Bearer ${ctx.token}`);

    expect(res.status).toBe(200);
    expect(res.headers["content-type"]).toContain("image/png");
    expect(res.headers["content-disposition"]).toContain("inline");
    expect(res.headers["x-content-type-options"]).toBe("nosniff");
  });

  it("serves JPEG with image/jpeg content type", async () => {
    const res = await request(ctx.app)
      .get(`/api/v1/sessions/${sessionId}/files/raw`)
      .query({ path: "photo.jpg" })
      .set("Authorization", `Bearer ${ctx.token}`);

    expect(res.status).toBe(200);
    expect(res.headers["content-type"]).toContain("image/jpeg");
    expect(res.headers["content-disposition"]).toContain("inline");
  });

  it("serves PDF with application/pdf content type and inline disposition", async () => {
    const res = await request(ctx.app)
      .get(`/api/v1/sessions/${sessionId}/files/raw`)
      .query({ path: "doc.pdf" })
      .set("Authorization", `Bearer ${ctx.token}`);

    expect(res.status).toBe(200);
    expect(res.headers["content-type"]).toContain("application/pdf");
    expect(res.headers["content-disposition"]).toContain("inline");
  });

  it("serves markdown with text/markdown content type", async () => {
    const res = await request(ctx.app)
      .get(`/api/v1/sessions/${sessionId}/files/raw`)
      .query({ path: "readme.md" })
      .set("Authorization", `Bearer ${ctx.token}`);

    expect(res.status).toBe(200);
    expect(res.headers["content-type"]).toContain("text/markdown");
  });

  it("serves JSON with application/json content type", async () => {
    const res = await request(ctx.app)
      .get(`/api/v1/sessions/${sessionId}/files/raw`)
      .query({ path: "data.json" })
      .set("Authorization", `Bearer ${ctx.token}`);

    expect(res.status).toBe(200);
    expect(res.headers["content-type"]).toContain("application/json");
  });

  it("serves TypeScript with text/plain content type", async () => {
    const res = await request(ctx.app)
      .get(`/api/v1/sessions/${sessionId}/files/raw`)
      .query({ path: "app.ts" })
      .set("Authorization", `Bearer ${ctx.token}`);

    expect(res.status).toBe(200);
    expect(res.headers["content-type"]).toContain("text/plain");
  });

  it("serves nested files correctly", async () => {
    const res = await request(ctx.app)
      .get(`/api/v1/sessions/${sessionId}/files/raw`)
      .query({ path: "subdir/nested.txt" })
      .set("Authorization", `Bearer ${ctx.token}`);

    expect(res.status).toBe(200);
    expect(res.headers["content-type"]).toContain("text/plain");
  });

  // --- Security: attachment disposition for unsafe types ---

  it("forces attachment disposition for non-safe types (zip)", async () => {
    const res = await request(ctx.app)
      .get(`/api/v1/sessions/${sessionId}/files/raw`)
      .query({ path: "archive.zip" })
      .set("Authorization", `Bearer ${ctx.token}`);

    expect(res.status).toBe(200);
    expect(res.headers["content-disposition"]).toContain("attachment");
    expect(res.headers["content-security-policy"]).toBe("default-src 'none'");
  });

  it("does not add CSP header for safe inline types", async () => {
    const res = await request(ctx.app)
      .get(`/api/v1/sessions/${sessionId}/files/raw`)
      .query({ path: "image.png" })
      .set("Authorization", `Bearer ${ctx.token}`);

    expect(res.status).toBe(200);
    expect(res.headers["content-security-policy"]).toBeUndefined();
  });

  // --- Path traversal protection ---

  it("rejects path traversal with ../", async () => {
    const res = await request(ctx.app)
      .get(`/api/v1/sessions/${sessionId}/files/raw`)
      .query({ path: "../../../etc/passwd" })
      .set("Authorization", `Bearer ${ctx.token}`);

    expect(res.status).toBe(403);
    expect(res.body.error).toContain("Access denied");
  });

  it("rejects absolute path outside project", async () => {
    const res = await request(ctx.app)
      .get(`/api/v1/sessions/${sessionId}/files/raw`)
      .query({ path: "/etc/passwd" })
      .set("Authorization", `Bearer ${ctx.token}`);

    expect(res.status).toBe(403);
    expect(res.body.error).toContain("Access denied");
  });

  // --- Error cases ---

  it("returns 400 when path query param is missing", async () => {
    const res = await request(ctx.app)
      .get(`/api/v1/sessions/${sessionId}/files/raw`)
      .set("Authorization", `Bearer ${ctx.token}`);

    expect(res.status).toBe(400);
    expect(res.body.error).toContain("path");
  });

  it("returns 404 for non-existent file", async () => {
    const res = await request(ctx.app)
      .get(`/api/v1/sessions/${sessionId}/files/raw`)
      .query({ path: "does-not-exist.png" })
      .set("Authorization", `Bearer ${ctx.token}`);

    expect(res.status).toBe(404);
    expect(res.body.error).toContain("not found");
  });

  it("returns 404 for non-existent session", async () => {
    const res = await request(ctx.app)
      .get("/api/v1/sessions/nonexistent-sid/files/raw")
      .query({ path: "image.png" })
      .set("Authorization", `Bearer ${ctx.token}`);

    expect(res.status).toBe(404);
  });

  it("returns 404 when path points to a directory", async () => {
    const res = await request(ctx.app)
      .get(`/api/v1/sessions/${sessionId}/files/raw`)
      .query({ path: "subdir" })
      .set("Authorization", `Bearer ${ctx.token}`);

    expect(res.status).toBe(404);
    expect(res.body.error).toContain("not found");
  });

  // --- Auth ---

  it("rejects unauthenticated requests", async () => {
    const res = await request(ctx.app)
      .get(`/api/v1/sessions/${sessionId}/files/raw`)
      .query({ path: "image.png" });

    expect(res.status).toBe(401);
  });

  it("accepts token via query parameter", async () => {
    const res = await request(ctx.app)
      .get(`/api/v1/sessions/${sessionId}/files/raw`)
      .query({ path: "image.png", token: ctx.token });

    expect(res.status).toBe(200);
    expect(res.headers["content-type"]).toContain("image/png");
  });
});
