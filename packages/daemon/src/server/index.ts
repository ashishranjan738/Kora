import express from "express";
import { WebSocketServer, type WebSocket } from "ws";
import http from "http";
import path from "path";
import fs from "fs";
import { createAuthMiddleware, validateWsToken } from "./auth.js";
import { createApiRouter } from "./api-routes.js";
import type { SessionManager } from "../core/session-manager.js";
import type { Orchestrator } from "../core/orchestrator.js";
import type { CLIProviderRegistry } from "../cli-providers/provider-registry.js";
import type { TmuxController } from "../core/tmux-controller.js";
import type { WSEvent } from "@kora/shared";
import { PtyManager } from "../core/pty-manager.js";

export interface ServerDeps {
  sessionManager: SessionManager;
  orchestrators: Map<string, Orchestrator>;  // sessionId -> Orchestrator
  providerRegistry: CLIProviderRegistry;
  tmux: TmuxController;
  startTime: number;
  globalConfigDir: string;
}

export interface ServerOptions {
  token: string;
  deps: ServerDeps;
}

export function createServer(options: ServerOptions) {
  const { token, deps } = options;

  const app = express();
  const server = http.createServer(app);
  const wss = new WebSocketServer({ server });

  // Serve the built React dashboard
  const dashboardDistPath = path.resolve(
    __dirname,
    "../../..", // go up from dist/server/ to packages/
    "dashboard/dist"
  );

  // Read index.html once and inject the token so the dashboard can auth API calls
  let indexHtml = "";
  try {
    indexHtml = fs.readFileSync(path.join(dashboardDistPath, "index.html"), "utf-8");
    // Inject token BEFORE any other scripts so it's available when React boots
    const tokenScript = `<script>window.__KORA_TOKEN__="${token}";</script>`;
    indexHtml = indexHtml.replace("<script", `${tokenScript}\n    <script`);
  } catch {
    indexHtml = "<html><body><h1>Dashboard not built. Run: cd packages/dashboard && npm run build</h1></body></html>";
  }

  // Serve static assets (JS, CSS, images) directly
  app.use(express.static(dashboardDistPath, { index: false }));

  app.use(express.json());
  app.use(createAuthMiddleware(token));
  app.use("/api/v1", createApiRouter(deps, wss));

  // SPA fallback: serve the token-injected index.html for all non-API GET routes
  app.use((req, res, next) => {
    if (req.method === "GET" && !req.path.startsWith("/api/") && !req.path.startsWith("/terminal/")) {
      res.setHeader("Content-Type", "text/html");
      res.send(indexHtml);
    } else {
      next();
    }
  });

  // WebSocket with auth
  wss.on("connection", (ws, req) => {
    if (!validateWsToken(req.url || "", token)) {
      ws.close(4001, "Unauthorized");
      return;
    }

    const url = new URL(req.url || "", `http://localhost`);
    const termMatch = url.pathname.match(/^\/terminal\/([^/]+)\/([^/]+)$/);

    if (termMatch) {
      // Terminal streaming connection
      const [, sessionId, agentId] = termMatch;
      handleTerminalConnection(ws, sessionId, agentId, deps);
      return;
    }

    // Regular event forwarding connection
    const listeners: Array<{ emitter: Orchestrator; event: string; handler: (...args: any[]) => void }> = [];

    const subscribe = (sessionId: string, orchestrator: Orchestrator) => {
      const onSpawned = (...args: any[]) => {
        const agent = args[0];
        const evt: WSEvent = { event: "agent-spawned", sessionId, agent } as WSEvent;
        ws.send(JSON.stringify(evt));
      };

      const onRemoved = (...args: any[]) => {
        const [agentId, reason] = args as [string, string];
        const evt: WSEvent = { event: "agent-removed", sessionId, agentId, reason };
        ws.send(JSON.stringify(evt));
      };

      orchestrator.on("agent-update", onSpawned);
      orchestrator.on("agent-removed", onRemoved);

      listeners.push(
        { emitter: orchestrator, event: "agent-update", handler: onSpawned },
        { emitter: orchestrator, event: "agent-removed", handler: onRemoved },
      );
    };

    // Subscribe to all existing orchestrators
    for (const [sessionId, orchestrator] of deps.orchestrators) {
      subscribe(sessionId, orchestrator);
    }

    ws.on("close", () => {
      // Unsubscribe from all events
      for (const { emitter, event, handler } of listeners) {
        emitter.removeListener(event, handler);
      }
      listeners.length = 0;
    });
  });

  return { app, server, wss };
}

// Shared PTY manager — uses node-pty for real terminal I/O
const ptyManager = new PtyManager();

function handleTerminalConnection(
  ws: WebSocket,
  sessionId: string,
  agentId: string,
  deps: ServerDeps,
): void {
  // Plain terminal tile — tmux session name is "{sessionId}-{termId}"
  if (agentId.startsWith("term-")) {
    const tmuxSession = `${sessionId}-${agentId}`;
    deps.tmux.hasSession(tmuxSession).then((exists) => {
      if (!exists) {
        ws.close(4004, "Terminal session not found");
        return;
      }
      const attached = ptyManager.attach(tmuxSession, ws);
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
  const attached = ptyManager.attach(agent.config.tmuxSession, ws);
  if (!attached) {
    ws.close(4029, "Too many terminal connections or PTY spawn failed");
  }
}
