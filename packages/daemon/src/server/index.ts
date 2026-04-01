import express from "express";
import { WebSocketServer, type WebSocket } from "ws";
import http from "http";
import path from "path";
import fs from "fs";
import crypto from "crypto";
import { createAuthMiddleware, validateWsToken } from "./auth.js";
import { createApiRouter } from "./api-routes.js";
import { createWebhookRouter } from "./webhook-routes.js";
import type { SessionManager } from "../core/session-manager.js";
import type { Orchestrator } from "../core/orchestrator.js";
import type { CLIProviderRegistry } from "../cli-providers/provider-registry.js";
import type { IPtyBackend } from "../core/pty-backend.js";
import type { SuggestionsDatabase } from "../core/suggestions-db.js";
import type { PlaybookDatabase } from "../core/playbook-database.js";
import type { WSEvent } from "@kora/shared";
import { getRuntimeTmuxPrefix as getSessionPrefix } from "@kora/shared";
import { PtyManager } from "../core/pty-manager.js";
import { logger } from "../core/logger.js";
import { notificationService } from "../core/notification-service.js";
import pinoHttp from "pino-http";

export interface ServerDeps {
  sessionManager: SessionManager;
  orchestrators: Map<string, Orchestrator>;  // sessionId -> Orchestrator
  providerRegistry: CLIProviderRegistry;
  terminal: IPtyBackend;
  startTime: number;
  globalConfigDir: string;
  suggestionsDb: SuggestionsDatabase;
  playbookDb: PlaybookDatabase;
}

export interface ServerOptions {
  token: string;
  deps: ServerDeps;
}

export interface CreateAppOptions {
  token: string;
  deps: ServerDeps;
  skipDashboard?: boolean;
}

/**
 * Resolve dashboard path:
 * - Production (npm): dist/dashboard (bundled)
 * - Development: ../../dashboard/dist (relative from dist/server/)
 *
 * Checks bundled path first, falls back to dev path.
 */
function resolveDashboardPath(): string {
  // Bundled path: dist/dashboard (npm package structure)
  const bundledPath = path.resolve(__dirname, '../dashboard');

  // Dev path: packages/dashboard/dist (monorepo structure)
  const devPath = path.resolve(__dirname, '../../..', 'dashboard/dist');

  // Try bundled first (npm package)
  if (fs.existsSync(path.join(bundledPath, 'index.html'))) {
    logger.info(`  [dashboard] Using bundled: ${bundledPath}`);
    return bundledPath;
  }

  // Fallback to dev path (monorepo)
  if (fs.existsSync(path.join(devPath, 'index.html'))) {
    logger.info(`  [dashboard] Using dev path: ${devPath}`);
    return devPath;
  }

  logger.error('Dashboard not found. Run: cd packages/dashboard && npm run build');
  // Return dev path as fallback (will show error message in browser)
  return devPath;
}

/**
 * Create an Express app for integration testing (no WebSocket, no HTTP server).
 */
export function createApp(options: CreateAppOptions) {
  const { token, deps, skipDashboard = false } = options;
  const app = express();

  app.use(express.json());
  app.use(pinoHttp({
    logger,
    autoLogging: {
      ignore: (req) => req.url?.startsWith("/api/v1/status") ?? false,
    },
  }));
  app.use(createAuthMiddleware(token));

  // For testing, we pass a mock wss to createApiRouter
  const mockWss = { clients: new Set() } as any;
  app.use("/api/v1", createApiRouter(deps, mockWss));

  if (!skipDashboard) {
    const dashboardDistPath = resolveDashboardPath();
    app.use(express.static(dashboardDistPath, { index: false }));
  }

  return app;
}

export function createServer(options: ServerOptions) {
  const { token, deps } = options;

  const app = express();
  const server = http.createServer(app);
  const wss = new WebSocketServer({ server });

  // ── WebSocket ping/pong heartbeat ──────────────────────────────
  const WS_PING_INTERVAL_MS = 30_000;

  const heartbeatInterval = setInterval(() => {
    wss.clients.forEach((ws) => {
      if ((ws as any).isAlive === false) {
        logger.debug("[ws-heartbeat] Terminating dead connection (missed pong)");
        ws.terminate();
        return;
      }
      (ws as any).isAlive = false;
      ws.ping();
    });
  }, WS_PING_INTERVAL_MS);

  // Clean up interval on server close
  wss.on("close", () => {
    clearInterval(heartbeatInterval);
  });

  // Set up global notification broadcast
  notificationService.on("notification", (notification) => {
    const event: WSEvent = {
      event: "notification",
      sessionId: notification.sessionId,
      notification: {
        id: notification.id,
        type: notification.type,
        title: notification.title,
        body: notification.body,
        agentId: notification.agentId,
        timestamp: notification.timestamp,
      },
    };

    // Broadcast to all WebSocket clients subscribed to this session
    wss.clients.forEach((client) => {
      if (client.readyState === 1 && (client as any).wsType === "dashboard") {
        // Check if this client is subscribed to the notification's session
        const subscribedSessions = (client as any).subscribedSessions as Set<string> | undefined;
        if (subscribedSessions?.has(notification.sessionId)) {
          try {
            client.send(JSON.stringify(event));
          } catch (err) {
            logger.error({ err }, "Failed to broadcast notification to WebSocket client");
          }
        }
      }
    });
  });

  // Configure PTY manager with the active terminal backend
  ptyManager.setBackend(deps.terminal);



  // Serve the built React dashboard
  const dashboardDistPath = resolveDashboardPath();

  // Read index.html template and prepare for per-request nonce injection
  let indexHtmlTemplate = "";
  const CSP_NONCE_PLACEHOLDER = "__CSP_NONCE__";
  try {
    indexHtmlTemplate = fs.readFileSync(path.join(dashboardDistPath, "index.html"), "utf-8");
    // Inject token BEFORE any other scripts so it's available when React boots
    // Use nonce placeholder — replaced per-request with a fresh cryptographic nonce
    const tokenScript = `<script nonce="${CSP_NONCE_PLACEHOLDER}">window.__KORA_TOKEN__="${token}";</script>`;
    indexHtmlTemplate = indexHtmlTemplate.replace("<script", `${tokenScript}\n    <script`);
  } catch {
    indexHtmlTemplate = "<html><body><h1>Dashboard not built. Run: cd packages/dashboard && npm run build</h1></body></html>";
  }

  // Serve static assets (JS, CSS, images) directly
  app.use(express.static(dashboardDistPath, { index: false }));

  app.use(express.json());
  app.use(pinoHttp({
    logger,
    autoLogging: {
      ignore: (req) => req.url?.startsWith("/api/v1/status") ?? false,
    },
  }));
  app.use(createAuthMiddleware(token));
  app.use("/api/v1", createApiRouter(deps, wss));

  // Mount webhook routes (event-triggered sessions)
  app.use("/api/v1", createWebhookRouter({
    sessionManager: deps.sessionManager,
    orchestrators: deps.orchestrators,
    providerRegistry: deps.providerRegistry,
    terminal: deps.terminal,
    globalConfigDir: deps.globalConfigDir,
    playbookDb: deps.playbookDb,
    createOrchestrator: async (sessionId, projectPath, runtimeDir) => {
      const { Orchestrator } = await import("../core/orchestrator.js");
      const orch = new Orchestrator({
        sessionId,
        projectPath,
        runtimeDir,
        defaultProvider: "claude-code",
        terminal: deps.terminal,
        providerRegistry: deps.providerRegistry,
        messagingMode: "mcp",
      });
      await orch.start();
      return orch;
    },
  }));

  // SPA fallback: serve the token-injected index.html for all non-API GET routes
  app.use((req, res, next) => {
    if (req.method === "GET" && !req.path.startsWith("/api/") && !req.path.startsWith("/terminal/")) {
      // Generate per-request nonce for CSP
      const nonce = crypto.randomBytes(16).toString("base64");
      const html = indexHtmlTemplate.replace(CSP_NONCE_PLACEHOLDER, nonce);
      res.setHeader("Content-Type", "text/html");
      res.setHeader("Cache-Control", "no-cache, no-store, must-revalidate");
      res.setHeader("Content-Security-Policy", `script-src 'self' 'nonce-${nonce}' 'unsafe-eval'; object-src 'none'; base-uri 'self'`);
      res.send(html);
    } else {
      next();
    }
  });

  // WebSocket with auth + connection limit
  const MAX_WS_CONNECTIONS = 50; // Max concurrent WebSocket connections
  wss.on("connection", (ws, req) => {
    // Connection limit — reject when exceeded
    if (wss.clients.size > MAX_WS_CONNECTIONS) {
      logger.warn({ clientCount: wss.clients.size }, "WebSocket connection rejected: max connections reached");
      ws.close(4008, "Too many connections");
      return;
    }

    // Mark connection alive for heartbeat
    (ws as any).isAlive = true;
    ws.on("pong", () => { (ws as any).isAlive = true; });

    if (!validateWsToken(req.url || "", token)) {
      const sanitizedUrl = req.url?.split('?')[0] || 'unknown';
      logger.warn({ path: sanitizedUrl }, 'WebSocket connection rejected: unauthorized');
      ws.close(4001, "Unauthorized");
      return;
    }

    const url = new URL(req.url || "", `http://localhost`);
    const termMatch = url.pathname.match(/^\/terminal\/([^/]+)\/([^/]+)$/);

    if (termMatch) {
      // Terminal streaming connection — tag so broadcastEvent skips it
      (ws as any).wsType = 'terminal';
      const [, sessionId, agentId] = termMatch;
      handleTerminalConnection(ws, sessionId, agentId, deps);
      return;
    }

    // Regular event forwarding connection — tag as dashboard
    (ws as any).wsType = 'dashboard';

    // Tier 2: Event-type filtering
    // Track which event types this client is subscribed to (default: wildcard = all events)
    (ws as any).subscribedEventTypes = new Set<string>(['*']);

    const listeners: Array<{ emitter: Orchestrator; event: string; handler: (...args: any[]) => void }> = [];
    const subscriptions = new Set<string>(); // Track which sessionIds this WS is subscribed to (Tier 1)
    (ws as any).subscribedSessions = subscriptions; // Expose for notification broadcast

    // Helper to check if an event should be sent to this client (Tier 2)
    const shouldSendEvent = (event: WSEvent, eventSessionId: string): boolean => {
      const eventTypes = (ws as any).subscribedEventTypes as Set<string> | undefined;

      // Check session filter (Tier 1)
      // Only send if client is subscribed to this event's session
      if (!subscriptions.has(eventSessionId)) {
        return false;
      }

      // Check event type filter (Tier 2)
      // If eventTypes is undefined or contains wildcard, allow all events
      if (!eventTypes || eventTypes.has('*')) {
        return true;
      }

      return eventTypes.has(event.event);
    };

    const subscribe = (sessionId: string) => {
      // Skip if already subscribed
      if (subscriptions.has(sessionId)) {
        return;
      }

      const orchestrator = deps.orchestrators.get(sessionId);
      if (!orchestrator) {
        logger.warn({ sessionId }, 'WebSocket subscribe: session not found');
        return;
      }

      const onSpawned = (...args: any[]) => {
        const agent = args[0];
        const evt: WSEvent = { event: "agent-spawned", sessionId, agent } as WSEvent;
        if (shouldSendEvent(evt, sessionId)) {
          ws.send(JSON.stringify(evt));
        }
      };

      const onRemoved = (...args: any[]) => {
        const [agentId, reason] = args as [string, string];
        const evt: WSEvent = { event: "agent-removed", sessionId, agentId, reason };
        if (shouldSendEvent(evt, sessionId)) {
          ws.send(JSON.stringify(evt));
        }
      };

      orchestrator.on("agent-update", onSpawned);
      orchestrator.on("agent-removed", onRemoved);

      listeners.push(
        { emitter: orchestrator, event: "agent-update", handler: onSpawned },
        { emitter: orchestrator, event: "agent-removed", handler: onRemoved },
      );

      subscriptions.add(sessionId);
      logger.debug({ sessionId }, 'WebSocket subscribed to session');
    };

    const unsubscribe = (sessionId: string) => {
      if (!subscriptions.has(sessionId)) {
        return;
      }

      // Remove listeners for this session
      const toRemove = listeners.filter(l => {
        // Check if this listener belongs to the session we're unsubscribing from
        const orchestrator = deps.orchestrators.get(sessionId);
        return l.emitter === orchestrator;
      });

      for (const { emitter, event, handler } of toRemove) {
        emitter.removeListener(event, handler);
      }

      // Remove from listeners array
      for (let i = listeners.length - 1; i >= 0; i--) {
        if (toRemove.includes(listeners[i])) {
          listeners.splice(i, 1);
        }
      }

      subscriptions.delete(sessionId);
      logger.debug({ sessionId }, 'WebSocket unsubscribed from session');
    };

    // Handle incoming messages for subscribe/unsubscribe
    ws.on("message", (data) => {
      try {
        const msg = JSON.parse(data.toString());

        if (msg.type === "subscribe") {
          // Tier 1: Session filtering
          if (msg.sessionId) {
            subscribe(msg.sessionId);
          }

          // Tier 2: Event-type filtering
          if (Array.isArray(msg.eventTypes)) {
            (ws as any).subscribedEventTypes = new Set(msg.eventTypes);
            logger.debug({ eventTypes: msg.eventTypes }, 'WebSocket event-type filter updated');
          }
        } else if (msg.type === "unsubscribe" && msg.sessionId) {
          unsubscribe(msg.sessionId);
        }
      } catch (err) {
        logger.warn({ err }, 'WebSocket: failed to parse message');
      }
    });

    ws.on("close", () => {
      // Unsubscribe from all events
      for (const { emitter, event, handler } of listeners) {
        emitter.removeListener(event, handler);
      }
      listeners.length = 0;
      subscriptions.clear();
    });
  });

  return { app, server, wss, ptyManager };
}

// Shared PTY manager — uses node-pty for real terminal I/O via the configured backend
const ptyManager = new PtyManager();

function handleTerminalConnection(
  ws: WebSocket,
  sessionId: string,
  agentId: string,
  deps: ServerDeps,
): void {
  // Plain terminal tile — session name is "kora--{sessionId}-{termId}" or "kora-dev--..."
  if (agentId.startsWith("term-")) {
    const terminalSession = `${getSessionPrefix(process.env.KORA_DEV === "1")}${sessionId}-${agentId}`;
    deps.terminal.hasSession(terminalSession).then((exists) => {
      if (!exists) {
        ws.close(4004, "Terminal session not found");
        return;
      }
      const attached = ptyManager.attach(terminalSession, ws);
      if (!attached) {
        ws.close(4029, "Too many terminal connections or PTY spawn failed");
      }
    });
    return;
  }

  // Agent terminal — existing behaviour
  const orchestrator = deps.orchestrators.get(sessionId);
  if (!orchestrator) {
    ws.close(4004, `Session "${sessionId}" not found`);
    return;
  }

  const agent = orchestrator.agentManager.getAgent(agentId);
  if (!agent) {
    ws.close(4004, `Agent "${agentId}" not found in session "${sessionId}"`);
    return;
  }

  // Attach via node-pty: full keyboard, real-time streaming, proper resize
  const attached = ptyManager.attach(agent.config.terminalSession, ws);
  if (!attached) {
    ws.close(4029, "Too many terminal connections or PTY spawn failed");
  }
}
