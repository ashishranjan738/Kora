// ============================================================
// Terminal Persistence — saves/restores standalone terminal state
// so terminals survive daemon restarts (holdpty --bg mode)
// ============================================================

import fs from "fs/promises";
import path from "path";
import { STATE_DIR } from "@kora/shared";
import type { IPtyBackend } from "./pty-backend.js";
import { logger } from "./logger.js";

const TERMINALS_FILE = "terminals.json";

export interface StandaloneTerminal {
  id: string;
  terminalSession: string;
  name: string;
  createdAt: string;
  projectPath: string;
}

/**
 * Save standalone terminal state for a session to disk.
 * Written to: {runtimeDir}/state/terminals.json
 */
export async function saveTerminalStates(
  runtimeDir: string,
  terminals: StandaloneTerminal[],
): Promise<void> {
  const stateDir = path.join(runtimeDir, STATE_DIR);
  await fs.mkdir(stateDir, { recursive: true });
  const filePath = path.join(stateDir, TERMINALS_FILE);
  const tmpPath = `${filePath}.tmp`;
  await fs.writeFile(tmpPath, JSON.stringify(terminals, null, 2), "utf-8");
  await fs.rename(tmpPath, filePath);
}

/**
 * Load standalone terminal states for a session from disk.
 * Returns empty array if no saved state.
 */
export async function loadTerminalStates(
  runtimeDir: string,
): Promise<StandaloneTerminal[]> {
  const filePath = path.join(runtimeDir, STATE_DIR, TERMINALS_FILE);
  try {
    const raw = await fs.readFile(filePath, "utf-8");
    return JSON.parse(raw) as StandaloneTerminal[];
  } catch {
    return [];
  }
}

/**
 * Verify that a terminal's socket file exists (for holdpty sessions).
 * Returns true if the socket exists and is accessible, false otherwise.
 */
export async function verifySocketExists(
  backend: IPtyBackend,
  sessionName: string,
): Promise<boolean> {
  try {
    // Check if backend supports getSocketPathForSession (HoldptyController)
    if (typeof (backend as any).getSocketPathForSession === "function") {
      const socketPath = await (backend as any).getSocketPathForSession(sessionName);
      await fs.access(socketPath);
      return true;
    }
    // For non-holdpty backends (e.g., tmux), socket verification is not needed
    return true;
  } catch (err) {
    logger.debug({ sessionName, err }, "Socket file does not exist or is not accessible");
    return false;
  }
}

/**
 * Restore standalone terminals with health checks.
 * Verifies both session existence (via hasSession) and socket file existence (for holdpty).
 * Returns { alive, dead } arrays of terminals.
 */
export async function restoreTerminalsWithHealthCheck(
  backend: IPtyBackend,
  persisted: StandaloneTerminal[],
  sessionId: string,
): Promise<{ alive: StandaloneTerminal[]; dead: StandaloneTerminal[] }> {
  const alive: StandaloneTerminal[] = [];
  const dead: StandaloneTerminal[] = [];

  for (const term of persisted) {
    try {
      // Check if session exists
      const sessionExists = await backend.hasSession(term.terminalSession);
      if (!sessionExists) {
        logger.debug({ sessionId, terminalId: term.id, sessionName: term.terminalSession }, "Terminal session no longer exists");
        dead.push(term);
        continue;
      }

      // For holdpty sessions, verify socket file exists
      const socketExists = await verifySocketExists(backend, term.terminalSession);
      if (!socketExists) {
        logger.warn({ sessionId, terminalId: term.id, sessionName: term.terminalSession }, "Terminal socket file missing — skipping restore");
        dead.push(term);
        continue;
      }

      alive.push(term);
    } catch (err) {
      logger.error({ err, sessionId, terminalId: term.id }, "Error during terminal health check");
      dead.push(term);
    }
  }

  return { alive, dead };
}
