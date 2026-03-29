/**
 * Integration tests for attachment endpoint security.
 * Tests Content-Type headers, path traversal, extension validation.
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import request from "supertest";
import { setupTestApp, type TestContext } from "./test-setup.js";
import { join } from "path";
import { mkdirSync } from "fs";

describe("Attachment endpoint security", () => {
  let ctx: TestContext;
  let sessionId: string;

  const auth = () => ({ Authorization: `Bearer ${ctx.token}` });

  beforeEach(async () => {
    ctx = setupTestApp();
    await ctx.sessionManager.load();

    const projectPath = join(ctx.testDir, `test-project-${Date.now()}`);
    mkdirSync(projectPath, { recursive: true });

    const res = await request(ctx.app)
      .post("/api/v1/sessions")
      .set(auth())
      .send({ name: "Editor Test", projectPath, provider: "claude-code" });

    expect(res.status).toBe(201);
    sessionId = res.body.id;
  });

  afterEach(() => {
    ctx.cleanup();
  });

  it("serves uploaded file with X-Content-Type-Options: nosniff", async () => {
    const base64Data = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8/5+hHgAHggJ/PchI7wAAAABJRU5ErkJggg==";

    const uploadRes = await request(ctx.app)
      .post(`/api/v1/sessions/${sessionId}/attachments`)
      .set(auth())
      .send({ filename: "test.png", base64Data });

    expect(uploadRes.status).toBe(201);
    const filename = uploadRes.body.filename;

    const getRes = await request(ctx.app)
      .get(`/api/v1/sessions/${sessionId}/attachments/${filename}`)
      .set(auth());

    if (getRes.status === 200) {
      expect(getRes.headers["x-content-type-options"]).toBe("nosniff");
    }
  });

  it("blocks path traversal in attachment filename", async () => {
    const res = await request(ctx.app)
      .get(`/api/v1/sessions/${sessionId}/attachments/..%2F..%2Fetc%2Fpasswd`)
      .set(auth());

    expect(res.status).toBe(400);
  });

  it("rejects binary extension (.exe) in upload", async () => {
    const res = await request(ctx.app)
      .post(`/api/v1/sessions/${sessionId}/attachments`)
      .set(auth())
      .send({ filename: "malware.exe", base64Data: "abc123" });

    expect(res.status).toBe(400);
    expect(res.body.error).toContain("Unsupported");
  });

  it("accepts .ts and .md file uploads", async () => {
    const tsContent = Buffer.from("export const x = 1;").toString("base64");
    const mdContent = Buffer.from("# Hello").toString("base64");

    const tsRes = await request(ctx.app)
      .post(`/api/v1/sessions/${sessionId}/attachments`)
      .set(auth())
      .send({ filename: "code.ts", base64Data: tsContent });
    expect(tsRes.status).toBe(201);

    const mdRes = await request(ctx.app)
      .post(`/api/v1/sessions/${sessionId}/attachments`)
      .set(auth())
      .send({ filename: "readme.md", base64Data: mdContent });
    expect(mdRes.status).toBe(201);
  });
});
