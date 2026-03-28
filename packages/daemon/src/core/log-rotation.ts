// ============================================================
// Log rotation utilities — prevents unbounded log growth
//
// Provides size-based rotation, age-based pruning, and startup
// cleanup for all daemon log files (crash, PM2, JSONL events,
// agent terminal, knowledge).
// ============================================================

import * as fs from "fs";
import * as fsPromises from "fs/promises";
import * as path from "path";
import { logger } from "./logger.js";

// ─── Constants ──────────────────────────────────────────────

/** Max crash.log size before rotation (10 MB) */
export const CRASH_LOG_MAX_BYTES = 10 * 1024 * 1024;

/** Bytes to keep when truncating crash.log (1 MB — most recent entries) */
export const CRASH_LOG_KEEP_BYTES = 1 * 1024 * 1024;

/** Max PM2 log size (50 MB per file) */
export const PM2_LOG_MAX_SIZE = "50M";

/** Max age for JSONL event log files (30 days) */
export const JSONL_MAX_AGE_DAYS = 30;

/** Max knowledge.md size before trimming (5 MB) */
export const KNOWLEDGE_MAX_BYTES = 5 * 1024 * 1024;

/** Bytes to keep when trimming knowledge.md (500 KB) */
export const KNOWLEDGE_KEEP_BYTES = 500 * 1024;

/** Max agent terminal log size (2 MB — matches existing orchestrator behavior) */
export const AGENT_LOG_MAX_BYTES = 2 * 1024 * 1024;

/** Bytes to keep when truncating agent logs (1 MB) */
export const AGENT_LOG_KEEP_BYTES = 1 * 1024 * 1024;

// ─── Core rotation function ─────────────────────────────────

/**
 * Rotate a file by size: if it exceeds `maxBytes`, keep only the
 * last `keepBytes` from the tail. This is a truncation-based rotation
 * that preserves the most recent data.
 *
 * @returns true if the file was rotated, false otherwise
 */
export async function rotateFileBySize(
  filePath: string,
  maxBytes: number,
  keepBytes: number,
): Promise<boolean> {
  try {
    const stats = await fsPromises.stat(filePath);
    if (stats.size <= maxBytes) return false;

    const readOffset = stats.size - keepBytes;
    const fh = await fsPromises.open(filePath, "r");
    try {
      const buf = Buffer.alloc(keepBytes);
      await fh.read(buf, 0, keepBytes, readOffset);
      await fh.close();
      await fsPromises.writeFile(filePath, buf);
      logger.info(
        `[log-rotation] Rotated ${filePath} (was ${Math.round(stats.size / 1024 / 1024)}MB, kept last ${Math.round(keepBytes / 1024)}KB)`,
      );
      return true;
    } catch (readErr) {
      await fh.close().catch(() => {});
      throw readErr;
    }
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code !== "ENOENT") {
      logger.warn({ err, filePath }, "[log-rotation] rotateFileBySize failed (non-fatal)");
    }
    return false;
  }
}

/**
 * Synchronous version of rotateFileBySize for use in crash handlers
 * where async operations are not safe.
 *
 * @returns true if the file was rotated, false otherwise
 */
export function rotateFileBySizeSync(
  filePath: string,
  maxBytes: number,
  keepBytes: number,
): boolean {
  try {
    const stats = fs.statSync(filePath);
    if (stats.size <= maxBytes) return false;

    const readOffset = stats.size - keepBytes;
    const fd = fs.openSync(filePath, "r");
    try {
      const buf = Buffer.alloc(keepBytes);
      fs.readSync(fd, buf, 0, keepBytes, readOffset);
      fs.closeSync(fd);
      fs.writeFileSync(filePath, buf);
      return true;
    } catch {
      try { fs.closeSync(fd); } catch { /* best effort */ }
      return false;
    }
  } catch {
    return false;
  }
}

// ─── JSONL event log pruning ────────────────────────────────

/**
 * Delete JSONL event log files older than `maxAgeDays`.
 * Files are named `YYYY-MM-DD.jsonl` so we can parse the date from the filename.
 *
 * @returns number of files deleted
 */
export async function pruneOldJsonlFiles(
  eventsDir: string,
  maxAgeDays: number = JSONL_MAX_AGE_DAYS,
): Promise<number> {
  try {
    const files = await fsPromises.readdir(eventsDir);
    const jsonlFiles = files.filter(f => f.endsWith(".jsonl"));
    const cutoff = new Date();
    cutoff.setDate(cutoff.getDate() - maxAgeDays);

    let deleted = 0;
    for (const file of jsonlFiles) {
      const dateStr = file.replace(".jsonl", "");
      const fileDate = new Date(dateStr);
      if (isNaN(fileDate.getTime())) continue; // skip malformed filenames

      if (fileDate < cutoff) {
        try {
          await fsPromises.unlink(path.join(eventsDir, file));
          deleted++;
        } catch { /* best effort */ }
      }
    }

    if (deleted > 0) {
      logger.info(`[log-rotation] Pruned ${deleted} old JSONL event files (>${maxAgeDays} days)`);
    }
    return deleted;
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code !== "ENOENT") {
      logger.warn({ err }, "[log-rotation] pruneOldJsonlFiles failed (non-fatal)");
    }
    return 0;
  }
}

// ─── Startup log pruning ────────────────────────────────────

/**
 * Run on daemon startup: prune oversized and stale log files across
 * all known locations.
 *
 * Covers:
 * - crash.log in global config dir
 * - PM2 logs in global config dir
 * - JSONL event logs in all session runtime dirs
 * - knowledge.md per session
 */
export async function pruneLogsOnStartup(globalConfigDir: string): Promise<void> {
  logger.info("[log-rotation] Running startup log pruning...");

  // 1. Rotate crash.log
  await rotateFileBySize(
    path.join(globalConfigDir, "crash.log"),
    CRASH_LOG_MAX_BYTES,
    CRASH_LOG_KEEP_BYTES,
  );

  // 2. Rotate PM2 logs (in case PM2 max_size isn't enabled or didn't run)
  const pm2Logs = ["pm2-out.log", "pm2-error.log"];
  for (const logFile of pm2Logs) {
    await rotateFileBySize(
      path.join(globalConfigDir, logFile),
      50 * 1024 * 1024, // 50 MB
      5 * 1024 * 1024,  // keep last 5 MB
    );
  }

  // 3. Prune old JSONL event files in all session directories
  try {
    const sessionsDir = path.join(globalConfigDir, "daemon-sessions");
    const sessions = await fsPromises.readdir(sessionsDir).catch(() => [] as string[]);
    for (const sessionId of sessions) {
      const eventsDir = path.join(sessionsDir, sessionId, "events");
      await pruneOldJsonlFiles(eventsDir, JSONL_MAX_AGE_DAYS);

      // Also rotate knowledge.md per session
      const knowledgePath = path.join(sessionsDir, sessionId, "knowledge.md");
      await rotateFileBySize(knowledgePath, KNOWLEDGE_MAX_BYTES, KNOWLEDGE_KEEP_BYTES);
    }
  } catch (err) {
    logger.warn({ err }, "[log-rotation] Session log pruning failed (non-fatal)");
  }

  logger.info("[log-rotation] Startup log pruning complete");
}
