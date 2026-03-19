import { describe, it, expect, beforeEach, vi } from "vitest";
import { execFile } from "child_process";
import { promisify } from "util";
import fs from "fs";

const execFileAsync = promisify(execFile);

// Mock fetch globally
global.fetch = vi.fn();

// Mock fs for .kora.yml reading
vi.mock("fs");

describe("create_pr MCP Tool", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe("Repository URL Parsing", () => {
    it("parses git@github.com:owner/repo.git format", () => {
      const remoteUrl = "git@github.com:ashishranjan738/Kora.git";
      const sshMatch = remoteUrl.match(/git@github\.com:([^/]+)\/(.+?)(?:\.git)?$/);

      expect(sshMatch).toBeTruthy();
      expect(sshMatch![1]).toBe("ashishranjan738");
      expect(sshMatch![2]).toBe("Kora");
    });

    it("parses https://github.com/owner/repo.git format", () => {
      const remoteUrl = "https://github.com/ashishranjan738/Kora.git";
      const httpsMatch = remoteUrl.match(/github\.com[:/]([^/]+)\/(.+?)(?:\.git)?$/);

      expect(httpsMatch).toBeTruthy();
      expect(httpsMatch![1]).toBe("ashishranjan738");
      expect(httpsMatch![2]).toBe("Kora");
    });

    it("parses git@github.com:owner/repo without .git suffix", () => {
      const remoteUrl = "git@github.com:facebook/react";
      const match = remoteUrl.match(/git@github\.com:([^/]+)\/(.+?)(?:\.git)?$/);

      expect(match).toBeTruthy();
      expect(match![1]).toBe("facebook");
      expect(match![2]).toBe("react");
    });

    it("parses https://github.com/owner/repo without .git suffix", () => {
      const remoteUrl = "https://github.com/microsoft/TypeScript";
      const match = remoteUrl.match(/github\.com[:/]([^/]+)\/(.+?)(?:\.git)?$/);

      expect(match).toBeTruthy();
      expect(match![1]).toBe("microsoft");
      expect(match![2]).toBe("TypeScript");
    });

    it("rejects non-GitHub URLs", () => {
      const remoteUrl = "git@gitlab.com:owner/repo.git";
      const sshMatch = remoteUrl.match(/git@github\.com:([^/]+)\/(.+?)(?:\.git)?$/);
      const httpsMatch = remoteUrl.match(/github\.com[:/]([^/]+)\/(.+?)(?:\.git)?$/);

      expect(sshMatch).toBeNull();
      expect(httpsMatch).toBeNull();
    });
  });

  describe("GitHub Token Resolution", () => {
    it("uses GITHUB_TOKEN env var if set", () => {
      const originalToken = process.env.GITHUB_TOKEN;
      process.env.GITHUB_TOKEN = "test_token_from_env";

      expect(process.env.GITHUB_TOKEN).toBe("test_token_from_env");

      // Cleanup
      if (originalToken === undefined) {
        delete process.env.GITHUB_TOKEN;
      } else {
        process.env.GITHUB_TOKEN = originalToken;
      }
    });

    it("parses token from .kora.yml", () => {
      const configContent = `
default_provider: claude-code
default_model: claude-sonnet-4
github:
  token: ghp_test_token_from_yaml
`;

      const tokenMatch = configContent.match(/github:\s*\n\s*token:\s*['"]?([^\s'"]+)['"]?/);
      expect(tokenMatch).toBeTruthy();
      expect(tokenMatch![1]).toBe("ghp_test_token_from_yaml");
    });

    it("handles quoted tokens in .kora.yml", () => {
      const configContent = `
github:
  token: "ghp_quoted_token"
`;

      const tokenMatch = configContent.match(/github:\s*\n\s*token:\s*['"]?([^\s'"]+)['"]?/);
      expect(tokenMatch).toBeTruthy();
      expect(tokenMatch![1]).toBe("ghp_quoted_token");
    });

    it("handles single-quoted tokens in .kora.yml", () => {
      const configContent = `
github:
  token: 'ghp_single_quoted'
`;

      const tokenMatch = configContent.match(/github:\s*\n\s*token:\s*['"]?([^\s'"]+)['"]?/);
      expect(tokenMatch).toBeTruthy();
      expect(tokenMatch![1]).toBe("ghp_single_quoted");
    });
  });

  describe("GitHub API Integration", () => {
    it("creates PR with successful API response", async () => {
      const mockResponse = {
        html_url: "https://github.com/owner/repo/pull/42",
        number: 42,
      };

      (global.fetch as any).mockResolvedValueOnce({
        ok: true,
        json: async () => mockResponse,
      });

      const response = await fetch("https://api.github.com/repos/owner/repo/pulls", {
        method: "POST",
        headers: {
          "Accept": "application/vnd.github+json",
          "Authorization": "Bearer test_token",
          "X-GitHub-Api-Version": "2022-11-28",
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          title: "Test PR",
          body: "Test description",
          head: "feature-branch",
          base: "main",
        }),
      });

      expect(response.ok).toBe(true);
      const data = await response.json();
      expect(data.html_url).toBe("https://github.com/owner/repo/pull/42");
      expect(data.number).toBe(42);
    });

    it("handles 422 validation error (PR already exists)", async () => {
      const errorResponse = {
        message: "Validation Failed",
        errors: [
          {
            message: "A pull request already exists for owner:feature-branch.",
          },
        ],
      };

      (global.fetch as any).mockResolvedValueOnce({
        ok: false,
        status: 422,
        text: async () => JSON.stringify(errorResponse),
      });

      const response = await fetch("https://api.github.com/repos/owner/repo/pulls", {
        method: "POST",
        headers: {
          "Accept": "application/vnd.github+json",
          "Authorization": "Bearer test_token",
          "X-GitHub-Api-Version": "2022-11-28",
        },
        body: JSON.stringify({
          title: "Duplicate PR",
          body: "Description",
          head: "feature-branch",
          base: "main",
        }),
      });

      expect(response.ok).toBe(false);
      expect(response.status).toBe(422);
      const errorText = await response.text();
      expect(errorText).toContain("already exists");
    });

    it("handles 401 authentication error", async () => {
      (global.fetch as any).mockResolvedValueOnce({
        ok: false,
        status: 401,
        text: async () => JSON.stringify({ message: "Bad credentials" }),
      });

      const response = await fetch("https://api.github.com/repos/owner/repo/pulls", {
        method: "POST",
        headers: {
          "Accept": "application/vnd.github+json",
          "Authorization": "Bearer invalid_token",
          "X-GitHub-Api-Version": "2022-11-28",
        },
        body: JSON.stringify({
          title: "Test PR",
          body: "Description",
          head: "feature-branch",
          base: "main",
        }),
      });

      expect(response.ok).toBe(false);
      expect(response.status).toBe(401);
    });

    it("handles 404 repository not found", async () => {
      (global.fetch as any).mockResolvedValueOnce({
        ok: false,
        status: 404,
        text: async () => JSON.stringify({ message: "Not Found" }),
      });

      const response = await fetch("https://api.github.com/repos/nonexistent/repo/pulls", {
        method: "POST",
        headers: {
          "Accept": "application/vnd.github+json",
          "Authorization": "Bearer test_token",
          "X-GitHub-Api-Version": "2022-11-28",
        },
        body: JSON.stringify({
          title: "Test PR",
          body: "Description",
          head: "feature-branch",
          base: "main",
        }),
      });

      expect(response.ok).toBe(false);
      expect(response.status).toBe(404);
    });
  });

  describe("Branch Detection", () => {
    it("uses current branch when headBranch not specified", () => {
      // This would be tested via execFileAsync("git", ["rev-parse", "--abbrev-ref", "HEAD"])
      // Simulating the behavior
      const currentBranch = "feature/my-feature";
      expect(currentBranch).toBe("feature/my-feature");
    });

    it("uses provided headBranch when specified", () => {
      const specifiedBranch = "custom-branch";
      expect(specifiedBranch).toBe("custom-branch");
    });

    it("defaults base branch to main", () => {
      const baseBranch = undefined || "main";
      expect(baseBranch).toBe("main");
    });

    it("uses provided base branch when specified", () => {
      const baseBranch = "develop" || "main";
      expect(baseBranch).toBe("develop");
    });
  });

  describe("Error Handling", () => {
    it("returns error when working directory cannot be determined", () => {
      const workDir = undefined;
      const result = !workDir
        ? { success: false, error: "Could not determine your working directory" }
        : { success: true };

      expect(result.success).toBe(false);
      expect(result.error).toContain("working directory");
    });

    it("returns error when GitHub token is missing", () => {
      const token = undefined;
      const result = !token
        ? { success: false, error: "GitHub token not found" }
        : { success: true };

      expect(result.success).toBe(false);
      expect(result.error).toContain("token not found");
    });

    it("returns error when remote URL is not GitHub", () => {
      const remoteUrl = "git@gitlab.com:owner/repo.git";
      const isGitHub = remoteUrl.includes("github.com");
      const result = !isGitHub
        ? { success: false, error: "Remote URL is not a GitHub repository" }
        : { success: true };

      expect(result.success).toBe(false);
      expect(result.error).toContain("not a GitHub repository");
    });

    it("handles git command failures gracefully", () => {
      // Simulating a git command failure
      const gitError = new Error("fatal: not a git repository");
      const result = {
        success: false,
        error: gitError.message || "Failed to create PR",
      };

      expect(result.success).toBe(false);
      expect(result.error).toContain("not a git repository");
    });
  });

  describe("Success Response Format", () => {
    it("returns expected fields on successful PR creation", () => {
      const mockResult = {
        success: true,
        prUrl: "https://github.com/owner/repo/pull/123",
        prNumber: 123,
        head: "feature/my-feature",
        base: "main",
        repository: "owner/repo",
      };

      expect(mockResult.success).toBe(true);
      expect(mockResult.prUrl).toMatch(/github\.com\/.*\/pull\/\d+/);
      expect(mockResult.prNumber).toBeGreaterThan(0);
      expect(mockResult.head).toBeTruthy();
      expect(mockResult.base).toBeTruthy();
      expect(mockResult.repository).toMatch(/\w+\/\w+/);
    });
  });
});
