/**
 * E2E: Monaco Editor — file type handling, attachments.
 */
import { test, expect } from "./fixtures";
import { apiCall } from "./helpers";

test.describe("Monaco Editor", () => {
  test("upload .ts file succeeds", async ({ testSession }) => {
    const base64Data = Buffer.from("export const x = 1;").toString("base64");
    const res = await apiCall<{ filename: string; url: string }>(`/sessions/${testSession}/attachments`, {
      method: "POST",
      body: { filename: "code.ts", base64Data },
    });

    expect(res.filename).toContain(".ts");
    expect(res.url).toContain("/attachments/");
  });

  test("upload .md file succeeds", async ({ testSession }) => {
    const base64Data = Buffer.from("# Hello World\n\nMarkdown content.").toString("base64");
    const res = await apiCall<{ filename: string }>(`/sessions/${testSession}/attachments`, {
      method: "POST",
      body: { filename: "readme.md", base64Data },
    });

    expect(res.filename).toContain(".md");
  });

  test("upload image file succeeds", async ({ testSession }) => {
    const base64Data = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8/5+hHgAHggJ/PchI7wAAAABJRU5ErkJggg==";
    const res = await apiCall<{ filename: string }>(`/sessions/${testSession}/attachments`, {
      method: "POST",
      body: { filename: "image.png", base64Data },
    });

    expect(res.filename).toContain(".png");
  });

  test("binary extension (.exe) blocked", async ({ testSession }) => {
    try {
      await apiCall(`/sessions/${testSession}/attachments`, {
        method: "POST",
        body: { filename: "malware.exe", base64Data: "abc123" },
      });
      // Should not reach here
      expect(true).toBe(false);
    } catch (err: any) {
      expect(err.message).toContain("400");
    }
  });
});
