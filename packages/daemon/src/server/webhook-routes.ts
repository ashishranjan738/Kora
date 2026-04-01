/**
 * Webhook Routes — Event-triggered session creation.
 *
 * External services (GitHub, Slack, CI/CD, generic HTTP) can trigger
 * new Kora sessions by calling POST /api/v1/webhooks/trigger with a
 * playbook name and project path. The endpoint creates a session,
 * loads the playbook, spawns agents, and returns the session ID.
 *
 * Supports:
 * - Generic webhook: { playbook, projectPath, trigger, metadata }
 * - GitHub webhook: auto-detects push/PR events from headers
 * - Slack command: parses slash command format
 */

import { Router } from "express";
import type { Request, Response } from "express";
import crypto from "crypto";
import type { SessionManager } from "../core/session-manager.js";
import type { Orchestrator } from "../core/orchestrator.js";
import type { CLIProviderRegistry } from "../cli-providers/provider-registry.js";
import type { IPtyBackend } from "../core/pty-backend.js";
import type { PlaybookDatabase } from "../core/playbook-database.js";
import { loadPlaybook } from "../core/playbook-loader.js";
import { logger } from "../core/logger.js";

export interface WebhookDeps {
  sessionManager: SessionManager;
  orchestrators: Map<string, Orchestrator>;
  providerRegistry: CLIProviderRegistry;
  terminal: IPtyBackend;
  globalConfigDir: string;
  playbookDb: PlaybookDatabase;
  /** Callback to set up a new orchestrator (mirrors session creation in api-routes) */
  createOrchestrator: (sessionId: string, projectPath: string, runtimeDir: string) => Promise<Orchestrator>;
}

/** Trigger source types */
type TriggerSource = "github" | "slack" | "generic" | "ci";

interface WebhookPayload {
  /** Playbook name or ID to execute */
  playbook: string;
  /** Absolute path to the project directory */
  projectPath: string;
  /** What triggered this session */
  trigger?: {
    source: TriggerSource;
    event?: string;       // e.g. "push", "pull_request", "slash_command"
    ref?: string;         // e.g. "refs/heads/main"
    actor?: string;       // Who triggered it
    url?: string;         // Link to the triggering event
  };
  /** Task/prompt to give the master agent */
  task?: string;
  /** Session name override (auto-generated if omitted) */
  sessionName?: string;
  /** Variable substitutions for playbook templates */
  variables?: Record<string, string>;
  /** Arbitrary metadata stored with the session */
  metadata?: Record<string, unknown>;
}

export function createWebhookRouter(deps: WebhookDeps): Router {
  const router = Router();
  const {
    sessionManager,
    orchestrators,
    globalConfigDir,
    createOrchestrator,
  } = deps;

  // ─── POST /webhooks/trigger — Create session from webhook event ────

  router.post("/webhooks/trigger", async (req: Request, res: Response) => {
    try {
      // HMAC-SHA256 verification — required. Reject if secret not configured.
      const webhookSecret = process.env.KORA_WEBHOOK_SECRET;
      if (!webhookSecret) {
        res.status(503).json({ error: "Webhook endpoint disabled — KORA_WEBHOOK_SECRET not configured" });
        return;
      }
      const signature = req.headers["x-webhook-signature"] || req.headers["x-hub-signature-256"];
      if (!signature) {
        res.status(401).json({ error: "Missing webhook signature header (X-Webhook-Signature or X-Hub-Signature-256)" });
        return;
      }
      const { createHmac, timingSafeEqual } = await import("crypto");
      const body = JSON.stringify(req.body);
      const expected = "sha256=" + createHmac("sha256", webhookSecret).update(body).digest("hex");
      if (typeof signature !== "string" || signature.length !== expected.length ||
          !timingSafeEqual(Buffer.from(signature), Buffer.from(expected))) {
        res.status(401).json({ error: "Invalid webhook signature" });
        return;
      }

      // Detect source from headers
      const payload = parseWebhookPayload(req);

      if (!payload.playbook) {
        res.status(400).json({ error: "playbook is required" });
        return;
      }
      if (!payload.projectPath) {
        res.status(400).json({ error: "projectPath is required" });
        return;
      }

      // Validate projectPath: must be absolute, exist, be a directory, and not a system path
      const path = await import("path");
      const fs = await import("fs");
      const resolvedProject = path.resolve(payload.projectPath);
      const systemPaths = ["/etc", "/usr", "/bin", "/sbin", "/var", "/tmp", "/dev", "/proc", "/sys"];
      if (systemPaths.some(sp => resolvedProject === sp || resolvedProject.startsWith(sp + "/"))) {
        res.status(403).json({ error: "projectPath cannot be a system directory" });
        return;
      }
      try {
        const stat = fs.statSync(resolvedProject);
        if (!stat.isDirectory()) {
          res.status(400).json({ error: "projectPath must be a directory" });
          return;
        }
      } catch {
        res.status(404).json({ error: "projectPath does not exist" });
        return;
      }

      // Verify playbook exists
      const playbook = await loadPlaybook(globalConfigDir, payload.playbook);
      if (!playbook) {
        res.status(404).json({ error: `Playbook "${payload.playbook}" not found` });
        return;
      }

      // Generate session name
      const source = payload.trigger?.source || "webhook";
      const event = payload.trigger?.event || "trigger";
      const sessionName = payload.sessionName ||
        `${source}-${event}-${Date.now().toString(36)}`;

      // Create session
      const config = await sessionManager.createSession({
        name: sessionName,
        projectPath: payload.projectPath,
        defaultProvider: (playbook.agents[0]?.provider) || "claude-code",
        messagingMode: "mcp",
      });

      const session = sessionManager.getSession(config.id);
      if (!session) {
        res.status(500).json({ error: "Session created but not found" });
        return;
      }

      // Create orchestrator
      const orch = await createOrchestrator(
        config.id,
        config.projectPath,
        session.runtimeDir,
      );
      orchestrators.set(config.id, orch);

      // Execute playbook (async, fire-and-forget)
      const { PlaybookExecutor } = await import("../core/playbook-executor.js");
      const executor = new PlaybookExecutor(
        orch,
        deps.providerRegistry,
        session.config,
        playbook,
        payload.variables || {},
        session.runtimeDir,
      );

      try {
        executor.setup();
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        res.status(400).json({ error: `Playbook setup failed: ${msg}` });
        return;
      }

      // Fire and forget — agents spawn in background
      executor.run(payload.task).catch(async (err) => {
        logger.error({ err }, `[webhook] Playbook execution failed for session ${config.id}`);
        // Clean up failed session to avoid orphans
        try {
          const failedOrch = orchestrators.get(config.id);
          if (failedOrch) {
            await failedOrch.stop();
            orchestrators.delete(config.id);
          }
          await sessionManager.stopSession(config.id);
          logger.info(`[webhook] Cleaned up failed session ${config.id}`);
        } catch (cleanupErr) {
          logger.warn({ err: cleanupErr }, `[webhook] Failed to clean up session ${config.id}`);
        }
      });

      // Log the trigger event
      orch.eventLog.log({
        sessionId: config.id,
        type: "session-created",
        data: {
          trigger: payload.trigger,
          playbook: payload.playbook,
          metadata: payload.metadata,
          source: "webhook",
        },
      });

      logger.info({
        sessionId: config.id,
        playbook: payload.playbook,
        trigger: payload.trigger,
      }, "[webhook] Session triggered");

      // Return 201 with session info
      res.status(201).json({
        sessionId: config.id,
        sessionName,
        playbook: payload.playbook,
        trigger: payload.trigger,
        status: "spawning",
        dashboardUrl: `/session/${config.id}`,
      });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      logger.error({ err }, "[webhook] Trigger failed");
      res.status(500).json({ error: message });
    }
  });

  // ─── GET /webhooks/status — Check webhook endpoint health ──────────

  router.get("/webhooks/status", (_req: Request, res: Response) => {
    res.json({
      enabled: true,
      supportedSources: ["github", "slack", "generic", "ci"],
      endpoint: "/api/v1/webhooks/trigger",
      method: "POST",
    });
  });

  return router;
}

// ─── Payload Parsing ──────────────────────────────────────────────────

/**
 * Parse webhook payload from request, auto-detecting source from headers.
 */
function parseWebhookPayload(req: Request): WebhookPayload {
  const body = req.body || {};

  // GitHub webhook detection
  const githubEvent = req.headers["x-github-event"] as string;
  if (githubEvent) {
    return parseGitHubWebhook(body, githubEvent);
  }

  // Slack slash command detection
  if (body.command && body.text && body.team_id) {
    return parseSlackCommand(body);
  }

  // Generic webhook
  return {
    playbook: body.playbook,
    projectPath: body.projectPath,
    trigger: body.trigger || {
      source: "generic" as TriggerSource,
      event: "trigger",
    },
    task: body.task,
    sessionName: body.sessionName,
    variables: body.variables,
    metadata: body.metadata,
  };
}

/**
 * Parse GitHub webhook payload into our standard format.
 */
function parseGitHubWebhook(body: any, event: string): WebhookPayload {
  const repo = body.repository;
  const sender = body.sender;

  let task: string | undefined;
  let ref: string | undefined;

  if (event === "push") {
    ref = body.ref;
    const branch = ref?.replace("refs/heads/", "") || "unknown";
    const commits = body.commits?.length || 0;
    task = `Review ${commits} new commit(s) pushed to ${branch} by ${sender?.login || "unknown"}`;
  } else if (event === "pull_request") {
    const pr = body.pull_request;
    ref = pr?.head?.ref;
    task = `Review PR #${pr?.number}: "${pr?.title}" by ${pr?.user?.login || "unknown"}`;
  } else if (event === "issues") {
    const issue = body.issue;
    task = `Investigate issue #${issue?.number}: "${issue?.title}"`;
  }

  return {
    playbook: body.playbook || "master-workers",  // Default playbook for GitHub events
    projectPath: body.projectPath || "",           // Must be provided or pre-configured
    trigger: {
      source: "github",
      event,
      ref,
      actor: sender?.login,
      url: body.pull_request?.html_url || body.repository?.html_url,
    },
    task,
    sessionName: body.sessionName,
    variables: body.variables,
    metadata: {
      githubEvent: event,
      repository: repo?.full_name,
      sender: sender?.login,
    },
  };
}

/**
 * Parse Slack slash command into our standard format.
 */
function parseSlackCommand(body: any): WebhookPayload {
  const parts = (body.text || "").split(" ");
  const playbook = parts[0] || "master-workers";
  const task = parts.slice(1).join(" ") || undefined;

  return {
    playbook,
    projectPath: body.projectPath || "",  // Must be pre-configured
    trigger: {
      source: "slack",
      event: "slash_command",
      actor: body.user_name,
    },
    task,
    sessionName: body.sessionName,
    metadata: {
      slackTeamId: body.team_id,
      slackChannel: body.channel_name,
      slackUser: body.user_name,
    },
  };
}
