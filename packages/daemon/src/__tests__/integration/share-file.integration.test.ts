/**
 * Integration tests for share_file tool and attachment API.
 * Tests file type validation, size limits, and backward compatibility.
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import request from "supertest";
import { setupTestApp, type TestContext } from "./test-setup.js";
import { join } from "path";
import { mkdirSync, writeFileSync } from "fs";

describe("share_file attachments", () => {
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
      .send({ name: "File Test", projectPath, provider: "claude-code" });

    expect(res.status).toBe(201);
    sessionId = res.body.id;
  });

  afterEach(() => {
    ctx.cleanup();
  });

  it("shares .md file via base64 and returns URL", async () => {
    const content = Buffer.from("# Hello World\n\nThis is a test.").toString("base64");
    const res = await request(ctx.app)
      .post(`/api/v1/sessions/${sessionId}/attachments`)
      .set(auth())
      .send({ filename: "readme.md", base64Data: content });

    expect(res.status).toBe(201);
    expect(res.body).toHaveProperty("url");
    expect(res.body.url).toContain("/attachments/");
    expect(res.body.filename).toContain(".md");
  });

  it("shares .ts file via base64", async () => {
    const content = Buffer.from("export const hello = 'world';").toString("base64");
    const res = await request(ctx.app)
      .post(`/api/v1/sessions/${sessionId}/attachments`)
      .set(auth())
      .send({ filename: "index.ts", base64Data: content });

    expect(res.status).toBe(201);
    expect(res.body.filename).toContain(".ts");
  });

  it("blocks .exe file upload", async () => {
    const res = await request(ctx.app)
      .post(`/api/v1/sessions/${sessionId}/attachments`)
      .set(auth())
      .send({ filename: "malware.exe", base64Data: "abc123" });

    expect(res.status).toBe(400);
    expect(res.body.error).toContain("Unsupported");
  });

  it("rejects non-image file exceeding 1MB", async () => {
    const session = ctx.sessionManager.getSession(sessionId);
    const projectPath = session!.config.projectPath;
    const bigFile = join(projectPath, "huge.log");
    writeFileSync(bigFile, "x".repeat(1.1 * 1024 * 1024));

    const res = await request(ctx.app)
      .post(`/api/v1/sessions/${sessionId}/attachments`)
      .set(auth())
      .send({ filename: "huge.log", sourcePath: "huge.log" });

    expect(res.status).toBe(400);
    expect(res.body.error).toContain("size limit");
  });

  it("still accepts image uploads (backward compat)", async () => {
    const base64Data = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8/5+hHgAHggJ/PchI7wAAAABJRU5ErkJggg==";
    const res = await request(ctx.app)
      .post(`/api/v1/sessions/${sessionId}/attachments`)
      .set(auth())
      .send({ filename: "screenshot.png", base64Data });

    expect(res.status).toBe(201);
    expect(res.body.filename).toContain(".png");
    expect(res.body).toHaveProperty("url");
  });
});
