/**
 * Holdpty stale session auto-cleanup.
 *
 * On daemon startup, scans for holdpty sessions that no longer have a
 * valid agent. Kills orphaned sessions to prevent resource leaks.
 *
 * A session is "orphaned" if:
 * - Its name starts with the kora prefix (kora-- or kora-dev--)
 * - No known agent references it as their tmuxSession
 */

import type { IPtyBackend } from "./pty-backend.js";
import type { AgentState } from "@kora/shared";
import { logger } from "./logger.js";

export interface CleanupResult {
  /** Total holdpty sessions found */
  totalSessions: number;
  /** Sessions that matched a known agent */
  knownSessions: number;
  /** Orphaned sessions that were killed */
  orphanedKilled: number;
  /** Session names that were killed */
  killedNames: string[];
}

/**
 * Scan for orphaned holdpty sessions and kill them.
 *
 * @param ptyBackend - The PTY backend (holdpty or tmux)
 * @param knownAgents - All known agents from all sessions (restored + dead)
 * @param prefix - The tmux session prefix to filter by (e.g., "kora-dev--")
 */
export async function cleanupOrphanedSessions(
  ptyBackend: IPtyBackend,
  knownAgents: AgentState[],
  prefix: string,
): Promise<CleanupResult> {
  const result: CleanupResult = {
    totalSessions: 0,
    knownSessions: 0,
    orphanedKilled: 0,
    killedNames: [],
  };

  try {
    // 1. List all active holdpty/tmux sessions
    const allSessions = await ptyBackend.listSessions();

    // 2. Filter to only kora-managed sessions (matching prefix)
    const koraSessions = allSessions.filter((name) => name.startsWith(prefix));
    result.totalSessions = koraSessions.length;

    if (koraSessions.length === 0) {
      return result;
    }

    // 3. Build set of known tmux session names from all agents
    const knownTmuxSessions = new Set<string>(
      knownAgents
        .map((agent) => agent.config.tmuxSession)
        .filter((s): s is string => !!s),
    );

    // 4. Find orphaned sessions (kora-prefixed but not in known agents)
    for (const sessionName of koraSessions) {
      if (knownTmuxSessions.has(sessionName)) {
        result.knownSessions++;
        continue;
      }

      // Orphaned — kill it
      try {
        await ptyBackend.killSession(sessionName);
        result.orphanedKilled++;
        result.killedNames.push(sessionName);
        logger.info(`[holdpty-cleanup] Killed orphaned session: ${sessionName}`);
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        logger.warn(`[holdpty-cleanup] Failed to kill orphaned session ${sessionName}: ${msg}`);
      }
    }

    if (result.orphanedKilled > 0) {
      logger.info(
        `[holdpty-cleanup] Cleaned up ${result.orphanedKilled} orphaned session(s) out of ${result.totalSessions} total`,
      );
    }
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    logger.error(`[holdpty-cleanup] Error during cleanup scan: ${msg}`);
  }

  return result;
}
