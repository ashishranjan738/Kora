import type { Router, Request, Response } from "express";
import type { WebSocketServer } from "ws";
import type { SessionManager } from "../../core/session-manager.js";
import type { Orchestrator } from "../../core/orchestrator.js";
import type { CLIProviderRegistry } from "../../cli-providers/provider-registry.js";
import type { IPtyBackend } from "../../core/pty-backend.js";
import type { SuggestionsDatabase } from "../../core/suggestions-db.js";
import type { PlaybookDatabase } from "../../core/playbook-database.js";
import type { StandaloneTerminal } from "../../core/terminal-persistence.js";

export interface RouteDeps {
  sessionManager: SessionManager;
  orchestrators: Map<string, Orchestrator>;
  providerRegistry: CLIProviderRegistry;
  terminal: IPtyBackend;
  startTime: number;
  globalConfigDir: string;
  suggestionsDb: SuggestionsDatabase;
  playbookDb: PlaybookDatabase;
  wss: WebSocketServer;
  standaloneTerminals: Map<string, Map<string, StandaloneTerminal>>;
  broadcastEvent: (event: any) => void;
  persistTerminalsForSession: (sessionId: string) => Promise<void>;
  outputCache: { get(id: string): any; set(id: string, raw: string, lines: string[]): void; clear(id: string): void; };
  stripAnsi: () => ((text: string) => string) | null;
}

export type { Router, Request, Response };
