import { describe, it, expect, vi, beforeEach, afterAll, afterEach } from "vitest";
import express from "express";
import request from "supertest";
import { mkdtempSync, rmSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";
import { createHmac } from "crypto";
import { createWebhookRouter } from "../webhook-routes.js";

const TEST_WEBHOOK_SECRET = "test-webhook-secret-12345";

// Use a real temp directory outside system paths — home dir is safe
const TEST_PROJECT_DIR = mkdtempSync(join(process.env.HOME || tmpdir(), ".kora-webhook-test-"));
afterAll(() => { try { rmSync(TEST_PROJECT_DIR, { recursive: true }); } catch {} });

// Mock playbook loader
vi.mock("../../core/playbook-loader.js", () => ({
  loadPlaybook: vi.fn(async (_dir: string, name: string) => {
    if (name === "master-workers") {
      return {
        name: "master-workers",
        description: "Test playbook",
        agents: [
          { name: "Architect", role: "master", model: "default" },
          { name: "Worker", role: "worker", model: "default" },
        ],
      };
    }
    return null;
  }),
}));

// Mock PlaybookExecutor (dynamic import)
vi.mock("../../core/playbook-executor.js", () => {
  class MockExecutor {
    execution = { id: "exec-123", agents: [] };
    setup() { return this.execution; }
    run() { return Promise.resolve(); }
    on() { return this; }
  }
  return { PlaybookExecutor: MockExecutor };
});

// Create mock deps
function createMockDeps() {
  const mockSession = {
    config: { id: "test-session", projectPath: TEST_PROJECT_DIR, name: "test" },
    runtimeDir: "/tmp/test/.kora",
  };

  const mockOrch = {
    eventLog: { log: vi.fn() },
    agentManager: { listAgents: () => [] },
    messageQueue: { setBroadcastCallback: vi.fn() },
  };

  return {
    sessionManager: {
      createSession: vi.fn().mockResolvedValue({ id: "test-session", projectPath: TEST_PROJECT_DIR, name: "test", defaultProvider: "claude-code" }),
      getSession: vi.fn().mockReturnValue(mockSession),
    } as any,
    orchestrators: new Map() as any,
    providerRegistry: {} as any,
    tmux: {} as any,
    globalConfigDir: "/tmp/.kora",
    playbookDb: {} as any,
    createOrchestrator: vi.fn().mockResolvedValue(mockOrch),
  };
}

/** Compute HMAC-SHA256 signature for a request body. */
function hmacSign(body: object): string {
  return "sha256=" + createHmac("sha256", TEST_WEBHOOK_SECRET).update(JSON.stringify(body)).digest("hex");
}

describe("webhook-routes", () => {
  let app: express.Express;
  let deps: ReturnType<typeof createMockDeps>;
  const origSecret = process.env.KORA_WEBHOOK_SECRET;

  beforeEach(() => {
    vi.clearAllMocks();
    process.env.KORA_WEBHOOK_SECRET = TEST_WEBHOOK_SECRET;
    deps = createMockDeps();
    app = express();
    app.use(express.json());
    app.use("/api/v1", createWebhookRouter(deps));
  });

  afterEach(() => {
    if (origSecret !== undefined) process.env.KORA_WEBHOOK_SECRET = origSecret;
    else delete process.env.KORA_WEBHOOK_SECRET;
  });

  describe("POST /webhooks/trigger", () => {
    it("creates session from generic webhook", async () => {
      const body = {
        playbook: "master-workers",
        projectPath: TEST_PROJECT_DIR,
        task: "Fix the login bug",
      };
      const res = await request(app)
        .post("/api/v1/webhooks/trigger")
        .set("X-Webhook-Signature", hmacSign(body))
        .send(body);

      expect(res.status).toBe(201);
      expect(res.body.sessionId).toBe("test-session");
      expect(res.body.playbook).toBe("master-workers");
      expect(res.body.status).toBe("spawning");
      expect(res.body.dashboardUrl).toContain("test-session");
      expect(deps.sessionManager.createSession).toHaveBeenCalled();
      expect(deps.createOrchestrator).toHaveBeenCalled();
    });

    it("rejects missing playbook", async () => {
      const body = { projectPath: TEST_PROJECT_DIR };
      const res = await request(app)
        .post("/api/v1/webhooks/trigger")
        .set("X-Webhook-Signature", hmacSign(body))
        .send(body);

      expect(res.status).toBe(400);
      expect(res.body.error).toContain("playbook");
    });

    it("rejects missing projectPath", async () => {
      const body = { playbook: "master-workers" };
      const res = await request(app)
        .post("/api/v1/webhooks/trigger")
        .set("X-Webhook-Signature", hmacSign(body))
        .send(body);

      expect(res.status).toBe(400);
      expect(res.body.error).toContain("projectPath");
    });

    it("returns 404 for unknown playbook", async () => {
      const body = { playbook: "nonexistent", projectPath: TEST_PROJECT_DIR };
      const res = await request(app)
        .post("/api/v1/webhooks/trigger")
        .set("X-Webhook-Signature", hmacSign(body))
        .send(body);

      expect(res.status).toBe(404);
      expect(res.body.error).toContain("not found");
    });

    it("parses GitHub push webhook", async () => {
      const body = {
        playbook: "master-workers",
        projectPath: TEST_PROJECT_DIR,
        ref: "refs/heads/main",
        commits: [{ id: "abc123" }],
        sender: { login: "octocat" },
        repository: { full_name: "owner/repo", html_url: "https://github.com/owner/repo" },
      };
      const res = await request(app)
        .post("/api/v1/webhooks/trigger")
        .set("X-GitHub-Event", "push")
        .set("X-Webhook-Signature", hmacSign(body))
        .send(body);

      expect(res.status).toBe(201);
      expect(res.body.trigger.source).toBe("github");
      expect(res.body.trigger.event).toBe("push");
      expect(res.body.trigger.actor).toBe("octocat");
    });

    it("parses GitHub pull_request webhook", async () => {
      const body = {
        playbook: "master-workers",
        projectPath: TEST_PROJECT_DIR,
        pull_request: {
          number: 42,
          title: "Fix auth bug",
          html_url: "https://github.com/owner/repo/pull/42",
          head: { ref: "fix-auth" },
          user: { login: "developer" },
        },
        sender: { login: "developer" },
        repository: { full_name: "owner/repo" },
      };
      const res = await request(app)
        .post("/api/v1/webhooks/trigger")
        .set("X-GitHub-Event", "pull_request")
        .set("X-Webhook-Signature", hmacSign(body))
        .send(body);

      expect(res.status).toBe(201);
      expect(res.body.trigger.source).toBe("github");
      expect(res.body.trigger.event).toBe("pull_request");
    });

    it("parses Slack slash command", async () => {
      const body = {
        command: "/kora",
        text: "master-workers fix the login page",
        team_id: "T12345",
        channel_name: "engineering",
        user_name: "alice",
        projectPath: TEST_PROJECT_DIR,
      };
      const res = await request(app)
        .post("/api/v1/webhooks/trigger")
        .set("X-Webhook-Signature", hmacSign(body))
        .send(body);

      expect(res.status).toBe(201);
      expect(res.body.trigger.source).toBe("slack");
      expect(res.body.trigger.event).toBe("slash_command");
    });
  });

  describe("GET /webhooks/status", () => {
    it("returns webhook endpoint info", async () => {
      const res = await request(app).get("/api/v1/webhooks/status");

      expect(res.status).toBe(200);
      expect(res.body.enabled).toBe(true);
      expect(res.body.supportedSources).toContain("github");
      expect(res.body.supportedSources).toContain("slack");
    });
  });
});
