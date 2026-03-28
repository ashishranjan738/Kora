import path from "path";
import { Router } from "express";
import type { WebSocketServer } from "ws";
import {
  getRuntimeTmuxPrefix,
  getRuntimeDaemonDir,
  SESSIONS_SUBDIR,
} from "@kora/shared";
import type { SessionManager } from "../core/session-manager.js";
import type { Orchestrator } from "../core/orchestrator.js";
import type { CLIProviderRegistry } from "../cli-providers/provider-registry.js";
import type { IPtyBackend } from "../core/pty-backend.js";
import type { SuggestionsDatabase } from "../core/suggestions-db.js";
import type { PlaybookDatabase } from "../core/playbook-database.js";
import { logger } from "../core/logger.js";
import { saveTerminalStates, loadTerminalStates, restoreTerminalsWithHealthCheck } from "../core/terminal-persistence.js";
import type { StandaloneTerminal } from "../core/terminal-persistence.js";
import { WebhookNotifier } from "../core/webhook-notifier.js";

import { registerSessionRoutes } from "./routes/session-routes.js";
import { registerAgentRoutes } from "./routes/agent-routes.js";
import { registerTaskRoutes } from "./routes/task-routes.js";
import { registerMessageRoutes } from "./routes/message-routes.js";
import { registerEditorRoutes } from "./routes/editor-routes.js";
import { registerMiscRoutes } from "./routes/misc-routes.js";
import type { RouteDeps } from "./routes/route-deps.js";

// Cache strip-ansi import (ESM module loaded once at startup)
let stripAnsiFunc: ((text: string) => string) | null = null;
(async () => {
  const stripAnsiModule = await import("strip-ansi");
  stripAnsiFunc = stripAnsiModule.default;
})();

// Output cache to avoid repeated capturePane calls
interface CachedOutput {
  raw: string;
  timestamp: number;
  lines: string[];
}

class AgentOutputCache {
  private cache = new Map<string, CachedOutput>();
  private readonly TTL = 2000; // 2 seconds

  get(agentId: string): CachedOutput | null {
    const cached = this.cache.get(agentId);
    if (!cached) return null;

    // Check if cache is still valid
    if (Date.now() - cached.timestamp > this.TTL) {
      this.cache.delete(agentId);
      return null;
    }

    return cached;
  }

  set(agentId: string, raw: string, lines: string[]): void {
    this.cache.set(agentId, {
      raw,
      timestamp: Date.now(),
      lines,
    });
  }

  clear(agentId: string): void {
    this.cache.delete(agentId);
  }
}

const outputCache = new AgentOutputCache();

export function createApiRouter(deps: {
  sessionManager: SessionManager;
  orchestrators: Map<string, Orchestrator>;  // sessionId -> Orchestrator
  providerRegistry: CLIProviderRegistry;
  terminal: IPtyBackend;
  startTime: number;  // Date.now() at daemon start
  globalConfigDir: string;
  suggestionsDb: SuggestionsDatabase;
  playbookDb: PlaybookDatabase;
}, wss: WebSocketServer): Router {
  const { sessionManager, orchestrators, providerRegistry, terminal, startTime, globalConfigDir, suggestionsDb, playbookDb } = deps;
  const tmux = terminal; // backward-compat alias for remaining usages
  const router = Router();

  // Track standalone terminal sessions per session (id → terminal info)
  const standaloneTerminals = new Map<string, Map<string, StandaloneTerminal>>();

  // Restore standalone terminals from disk on daemon startup
  (async () => {
    const sessions = sessionManager.listSessions();
    for (const sessionConfig of sessions) {
      if (sessionConfig.status === "stopped") continue;

      try {
        const runtimeDir = path.join(sessionConfig.projectPath, getRuntimeDaemonDir(process.env.KORA_DEV === "1"), SESSIONS_SUBDIR, sessionConfig.id);
        const persisted = await loadTerminalStates(runtimeDir);
        if (persisted.length === 0) continue;

        // Verify each terminal's session exists AND socket file is accessible (for holdpty)
        const { alive, dead } = await restoreTerminalsWithHealthCheck(tmux, persisted, sessionConfig.id);

        // Populate in-memory Map with alive terminals
        if (alive.length > 0) {
          const termMap = new Map<string, StandaloneTerminal>();
          alive.forEach(t => termMap.set(t.id, t));
          standaloneTerminals.set(sessionConfig.id, termMap);

          logger.info({ sessionId: sessionConfig.id, restored: alive.length, dead: dead.length }, "Restored standalone terminals");
        }

        // Re-persist if any terminals died (clean up stale entries)
        if (dead.length > 0) {
          await saveTerminalStates(runtimeDir, alive);
        }
      } catch (err) {
        logger.error({ err: err, sessionId: sessionConfig.id }, "Failed to restore standalone terminals");
      }
    }
  })();

  // Helper function to persist standalone terminals for a session to disk
  const persistTerminalsForSession = async (sessionId: string): Promise<void> => {
    const session = sessionManager.getSession(sessionId);
    if (!session) return;

    const terminals = standaloneTerminals.get(sessionId);
    const terminalArray = terminals ? Array.from(terminals.values()) : [];

    try {
      const runtimeDir = session.runtimeDir;
      await saveTerminalStates(runtimeDir, terminalArray);
    } catch (err) {
      logger.error({ err: err, sessionId }, "Failed to persist terminal states");
    }
  };

  // Helper function to broadcast events to dashboard WebSocket clients only.
  // Terminal connections (wsType === 'terminal') are excluded to prevent
  // raw JSON from appearing in agent terminal output.
  // Respects Tier 1 (session) and Tier 2 (event-type) filters.
  // Also sends webhook notifications if configured (fire-and-forget).
  const broadcastEvent = (event: any) => {
    const message = JSON.stringify(event);
    wss.clients.forEach((client) => {
      if (client.readyState !== 1 || (client as any).wsType === 'terminal') {
        return; // Skip terminal connections and non-ready clients
      }

      // Check session filter (Tier 1)
      const subscribedSessionId = (client as any).subscribedSessionId as string | undefined;
      if (subscribedSessionId && event.sessionId && event.sessionId !== subscribedSessionId) {
        return; // Client only wants events from a specific session
      }

      // Check event type filter (Tier 2)
      const subscribedEventTypes = (client as any).subscribedEventTypes as Set<string> | undefined;
      if (subscribedEventTypes && !subscribedEventTypes.has('*')) {
        if (!event.event || !subscribedEventTypes.has(event.event)) {
          return; // Client is not subscribed to this event type
        }
      }

      client.send(message);
    });

    // Send webhook notifications if configured (fire-and-forget)
    if (event.sessionId) {
      const session = sessionManager.getSession(event.sessionId);
      if (session?.config.webhooks && session.config.webhooks.length > 0) {
        const notifier = new WebhookNotifier(session.config.webhooks);
        notifier.notify({
          ...event,
          timestamp: Date.now(),
        }).catch(err => {
          logger.warn({ err, sessionId: event.sessionId, eventType: event.event }, "Failed to send webhook notification");
        });
      }
    }
  };

  // Build shared dependencies for route modules
  const routeDeps: RouteDeps = {
    sessionManager,
    orchestrators,
    providerRegistry,
    terminal,
    startTime,
    globalConfigDir,
    suggestionsDb,
    playbookDb,
    wss,
    standaloneTerminals,
    broadcastEvent,
    persistTerminalsForSession,
    outputCache,
    stripAnsi: () => stripAnsiFunc,
  };

  // Register all route modules
  registerSessionRoutes(router, routeDeps);
  registerAgentRoutes(router, routeDeps);
  registerTaskRoutes(router, routeDeps);
  registerMessageRoutes(router, routeDeps);
  registerEditorRoutes(router, routeDeps);
  registerMiscRoutes(router, routeDeps);

  return router;
}
