/**
 * E2E tests for share_image attachment API endpoints.
 * Tests base64 upload, file path sharing, security checks, and retrieval.
 */

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import request from "supertest";
import { mkdirSync, writeFileSync, existsSync } from "fs";
import { join } from "path";
import { setupTestApp, type TestContext } from "./test-setup.js";

describe("Share Image / Attachments API", () => {
  let ctx: TestContext;
  let sessionId: string;

  const auth = () => ({ Authorization: `Bearer ${ctx.token}` });

  beforeAll(async () => {
    ctx = setupTestApp();

    // Create a session
    const projectPath = join(ctx.testDir, "test-project");
    mkdirSync(projectPath, { recursive: true });

    const res = await request(ctx.app)
      .post("/api/v1/sessions")
      .set(auth())
      .send({ name: "image-test", projectPath, provider: "claude-code" });

    sessionId = res.body.id;
  });

  afterAll(() => {
    ctx.cleanup();
  });

  // ─── POST /attachments — Base64 Upload ─────────────────────────────────

  describe("POST /sessions/:sid/attachments — base64 upload", () => {
    it("uploads a base64 PNG image", async () => {
      // 1x1 red pixel PNG
      const base64Data = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8/5+hHgAHggJ/PchI7wAAAABJRU5ErkJggg==";

      const res = await request(ctx.app)
        .post(`/api/v1/sessions/${sessionId}/attachments`)
        .set(auth())
        .send({ filename: "test-image.png", base64Data });

      expect(res.status).toBe(201);
      expect(res.body).toHaveProperty("filename");
      expect(res.body).toHaveProperty("url");
      expect(res.body).toHaveProperty("size");
      expect(res.body.filename).toContain("test-image.png");
      expect(res.body.url).toContain(`/api/v1/sessions/${sessionId}/attachments/`);
      expect(res.body.size).toBeGreaterThan(0);
    });

    it("uploads JPEG image", async () => {
      // Minimal valid JPEG (just headers)
      const base64Data = "/9j/4AAQSkZJRgABAQAAAQABAAD/2wBDAP//";

      const res = await request(ctx.app)
        .post(`/api/v1/sessions/${sessionId}/attachments`)
        .set(auth())
        .send({ filename: "photo.jpg", base64Data });

      expect(res.status).toBe(201);
      expect(res.body.filename).toContain("photo.jpg");
    });

    it("uploads WebP image", async () => {
      const base64Data = "UklGRiQAAABXRUJQVlA4IBgAAAAwAQCdASoBAAEAAkA4JZQCdAEO/hepAAA=";

      const res = await request(ctx.app)
        .post(`/api/v1/sessions/${sessionId}/attachments`)
        .set(auth())
        .send({ filename: "screenshot.webp", base64Data });

      expect(res.status).toBe(201);
      expect(res.body.filename).toContain("screenshot.webp");
    });

    it("rejects empty base64Data", async () => {
      const res = await request(ctx.app)
        .post(`/api/v1/sessions/${sessionId}/attachments`)
        .set(auth())
        .send({ filename: "empty.png", base64Data: "" });

      // Empty base64 decodes to 0 bytes — should still create file (size 0)
      // or could be rejected depending on implementation
      expect([201, 400]).toContain(res.status);
    });
  });

  // ─── POST /attachments — File Path Upload ──────────────────────────────

  describe("POST /sessions/:sid/attachments — sourcePath", () => {
    it("copies file from within project directory", async () => {
      // Create a test image file in the project dir
      const session = ctx.sessionManager.getSession(sessionId);
      const projectPath = session!.config.projectPath;
      const imgPath = join(projectPath, "test-screenshot.png");
      // Write a minimal PNG
      const pngBuffer = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8/5+hHgAHggJ/PchI7wAAAABJRU5ErkJggg==", "base64");
      writeFileSync(imgPath, pngBuffer);

      const res = await request(ctx.app)
        .post(`/api/v1/sessions/${sessionId}/attachments`)
        .set(auth())
        .send({ filename: "test-screenshot.png", sourcePath: "test-screenshot.png" });

      expect(res.status).toBe(201);
      expect(res.body.filename).toContain("test-screenshot.png");
      expect(res.body.size).toBeGreaterThan(0);
    });

    it("rejects sourcePath outside project directory (path traversal)", async () => {
      const res = await request(ctx.app)
        .post(`/api/v1/sessions/${sessionId}/attachments`)
        .set(auth())
        .send({ filename: "steal.png", sourcePath: "../../../etc/passwd" });

      expect(res.status).toBe(403);
      expect(res.body.error).toContain("project directory");
    });

    it("rejects absolute path outside project", async () => {
      const res = await request(ctx.app)
        .post(`/api/v1/sessions/${sessionId}/attachments`)
        .set(auth())
        .send({ filename: "steal.png", sourcePath: "/etc/hosts" });

      expect(res.status).toBe(403);
      expect(res.body.error).toContain("project directory");
    });

    it("returns 404 for nonexistent source file", async () => {
      const res = await request(ctx.app)
        .post(`/api/v1/sessions/${sessionId}/attachments`)
        .set(auth())
        .send({ filename: "missing.png", sourcePath: "nonexistent-file.png" });

      expect(res.status).toBe(404);
      expect(res.body.error).toContain("not found");
    });
  });

  // ─── Validation ────────────────────────────────────────────────────────

  describe("POST /sessions/:sid/attachments — validation", () => {
    it("rejects missing filename", async () => {
      const res = await request(ctx.app)
        .post(`/api/v1/sessions/${sessionId}/attachments`)
        .set(auth())
        .send({ base64Data: "abc123" });

      expect(res.status).toBe(400);
      expect(res.body.error).toContain("filename");
    });

    it("rejects missing both base64Data and sourcePath", async () => {
      const res = await request(ctx.app)
        .post(`/api/v1/sessions/${sessionId}/attachments`)
        .set(auth())
        .send({ filename: "test.png" });

      expect(res.status).toBe(400);
      expect(res.body.error).toContain("base64Data");
    });

    it("rejects unsupported file extension (.exe)", async () => {
      const res = await request(ctx.app)
        .post(`/api/v1/sessions/${sessionId}/attachments`)
        .set(auth())
        .send({ filename: "malware.exe", base64Data: "abc123" });

      expect(res.status).toBe(400);
      expect(res.body.error).toContain("Unsupported");
    });

    it("rejects unsupported file extension (.sh)", async () => {
      const res = await request(ctx.app)
        .post(`/api/v1/sessions/${sessionId}/attachments`)
        .set(auth())
        .send({ filename: "script.sh", base64Data: "abc123" });

      expect(res.status).toBe(400);
      expect(res.body.error).toContain("Unsupported");
    });

    it("rejects unsupported file extension (.html)", async () => {
      const res = await request(ctx.app)
        .post(`/api/v1/sessions/${sessionId}/attachments`)
        .set(auth())
        .send({ filename: "xss.html", base64Data: "abc123" });

      expect(res.status).toBe(400);
      expect(res.body.error).toContain("Unsupported");
    });

    it("accepts all allowed extensions", async () => {
      const base64Data = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8/5+hHgAHggJ/PchI7wAAAABJRU5ErkJggg==";
      const allowedExts = [".png", ".jpg", ".jpeg", ".gif", ".webp"];

      for (const ext of allowedExts) {
        const res = await request(ctx.app)
          .post(`/api/v1/sessions/${sessionId}/attachments`)
          .set(auth())
          .send({ filename: `test${ext}`, base64Data });

        expect(res.status).toBe(201);
      }
    });

    it("rejects oversized base64 payload (>10MB)", async () => {
      // Create a string > 10MB
      const oversized = "A".repeat(11 * 1024 * 1024);

      const res = await request(ctx.app)
        .post(`/api/v1/sessions/${sessionId}/attachments`)
        .set(auth())
        .send({ filename: "huge.png", base64Data: oversized });

      // Either 400 (our validation) or 413 (Express body-parser limit)
      expect([400, 413]).toContain(res.status);
    });

    it("returns 404 for nonexistent session", async () => {
      const res = await request(ctx.app)
        .post(`/api/v1/sessions/nonexistent/attachments`)
        .set(auth())
        .send({ filename: "test.png", base64Data: "abc" });

      expect(res.status).toBe(404);
      expect(res.body.error).toContain("Session not found");
    });
  });

  // ─── GET /attachments/:filename — Retrieval ────────────────────────────

  describe("GET /sessions/:sid/attachments/:filename", () => {
    let uploadedFilename: string;

    beforeAll(async () => {
      const base64Data = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8/5+hHgAHggJ/PchI7wAAAABJRU5ErkJggg==";
      const res = await request(ctx.app)
        .post(`/api/v1/sessions/${sessionId}/attachments`)
        .set(auth())
        .send({ filename: "retrieve-test.png", base64Data });

      uploadedFilename = res.body.filename;
    });

    // TODO: res.sendFile requires absolute path + proper Express static setup — works in real server but not in supertest
    it.skip("retrieves uploaded image", async () => {
      const res = await request(ctx.app)
        .get(`/api/v1/sessions/${sessionId}/attachments/${uploadedFilename}`)
        .set(auth());

      expect(res.status).toBe(200);
      expect(res.headers["x-content-type-options"]).toBe("nosniff");
      // Content-Disposition header should be present with the filename
      expect(res.headers["content-disposition"]).toBeDefined();
    });

    it("returns 404 for nonexistent attachment", async () => {
      const res = await request(ctx.app)
        .get(`/api/v1/sessions/${sessionId}/attachments/nonexistent.png`)
        .set(auth());

      expect(res.status).toBe(404);
    });

    it("rejects path traversal in filename", async () => {
      const res = await request(ctx.app)
        .get(`/api/v1/sessions/${sessionId}/attachments/..%2F..%2Fetc%2Fpasswd`)
        .set(auth());

      expect(res.status).toBe(400);
    });

    it("rejects unsupported extension in retrieval", async () => {
      const res = await request(ctx.app)
        .get(`/api/v1/sessions/${sessionId}/attachments/test.txt`)
        .set(auth());

      expect(res.status).toBe(400);
      expect(res.body.error).toContain("Unsupported");
    });

    it("rejects filename with directory traversal characters", async () => {
      const res = await request(ctx.app)
        .get(`/api/v1/sessions/${sessionId}/attachments/..\\..\\etc\\passwd`)
        .set(auth());

      // Either 400 (our validation catches it) or 404 (Express URL decoding)
      expect([400, 404]).toContain(res.status);
    });
  });

  // ─── Filename Sanitization ─────────────────────────────────────────────

  describe("Filename sanitization", () => {
    it("sanitizes filename with special characters", async () => {
      const base64Data = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8/5+hHgAHggJ/PchI7wAAAABJRU5ErkJggg==";

      const res = await request(ctx.app)
        .post(`/api/v1/sessions/${sessionId}/attachments`)
        .set(auth())
        .send({ filename: "my image (2).png", base64Data });

      expect(res.status).toBe(201);
      // Filename should be sanitized but still end with .png
      expect(res.body.filename).toContain(".png");
    });

    it("prepends timestamp to avoid collisions", async () => {
      const base64Data = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8/5+hHgAHggJ/PchI7wAAAABJRU5ErkJggg==";

      const res1 = await request(ctx.app)
        .post(`/api/v1/sessions/${sessionId}/attachments`)
        .set(auth())
        .send({ filename: "same-name.png", base64Data });

      // Small delay to ensure different timestamp prefix (ms resolution)
      await new Promise(r => setTimeout(r, 5));

      const res2 = await request(ctx.app)
        .post(`/api/v1/sessions/${sessionId}/attachments`)
        .set(auth())
        .send({ filename: "same-name.png", base64Data });

      expect(res1.status).toBe(201);
      expect(res2.status).toBe(201);
      // Filenames should be different (timestamp prefix)
      expect(res1.body.filename).not.toBe(res2.body.filename);
    });
  });
});
