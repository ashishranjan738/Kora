/**
 * Auto-Checkpoint — Periodic state persistence for disaster recovery.
 *
 * Saves agent states, session data, and task snapshots to disk at regular
 * intervals. On daemon restart, the latest checkpoint is used to restore
 * the session. Holdpty sessions survive independently (--bg flag), so the
 * daemon just needs to reconnect to them.
 *
 * Checkpoint data is written atomically (tmp + rename) to avoid corruption.
 */

import fs from "fs/promises";
import path from "path";
import type { AgentState } from "@kora/shared";
import { logger } from "./logger.js";

const CHECKPOINT_DIR = "checkpoints";
const MAX_CHECKPOINTS = 5; // Keep last 5 checkpoints for rollback

export interface CheckpointData {
  version: 1;
  timestamp: string;
  sessionId: string;
  agents: AgentState[];
  metadata: {
    daemonPid: number;
    uptime: number;           // seconds since daemon start
    agentCount: number;
    activeAgentCount: number;
  };
}

export class AutoCheckpoint {
  private interval: NodeJS.Timeout | null = null;
  private runtimeDir: string;
  private sessionId: string;
  private getAgents: () => AgentState[];
  private startTime: number;
  private checkpointCount = 0;

  constructor(opts: {
    runtimeDir: string;
    sessionId: string;
    getAgents: () => AgentState[];
    startTime: number;
  }) {
    this.runtimeDir = opts.runtimeDir;
    this.sessionId = opts.sessionId;
    this.getAgents = opts.getAgents;
    this.startTime = opts.startTime;
  }

  /** Start periodic checkpointing */
  start(intervalMs: number = 5 * 60 * 1000): void {
    if (this.interval) return; // Already running

    // Save immediately on start
    this.save().catch(err => logger.error({ err }, "[checkpoint] Initial save failed"));

    this.interval = setInterval(() => {
      this.save().catch(err => logger.error({ err }, "[checkpoint] Periodic save failed"));
    }, intervalMs);
    this.interval.unref(); // Don't keep process alive just for checkpointing

    logger.info(`[checkpoint] Auto-checkpoint started (every ${intervalMs / 1000}s)`);
  }

  /** Stop periodic checkpointing */
  stop(): void {
    if (this.interval) {
      clearInterval(this.interval);
      this.interval = null;
    }
  }

  /** Save a checkpoint to disk */
  async save(): Promise<string> {
    const checkpointDir = path.join(this.runtimeDir, CHECKPOINT_DIR);
    await fs.mkdir(checkpointDir, { recursive: true });

    const agents = this.getAgents();
    const activeAgents = agents.filter(a => a.status === "running" || a.activity === "working");

    const data: CheckpointData = {
      version: 1,
      timestamp: new Date().toISOString(),
      sessionId: this.sessionId,
      agents,
      metadata: {
        daemonPid: process.pid,
        uptime: Math.round((Date.now() - this.startTime) / 1000),
        agentCount: agents.length,
        activeAgentCount: activeAgents.length,
      },
    };

    // Write atomically: tmp file → rename
    const filename = `checkpoint-${Date.now()}.json`;
    const filePath = path.join(checkpointDir, filename);
    const tmpPath = `${filePath}.tmp`;

    await fs.writeFile(tmpPath, JSON.stringify(data, null, 2), "utf-8");
    await fs.rename(tmpPath, filePath);

    this.checkpointCount++;

    // Also write a "latest" copy for quick access
    const latestPath = path.join(checkpointDir, "latest.json");
    try {
      await fs.copyFile(filePath, latestPath);
    } catch {
      // Fallback: write directly (less atomic but works on all filesystems)
      await fs.writeFile(latestPath, JSON.stringify(data, null, 2), "utf-8");
    }

    // Prune old checkpoints (keep MAX_CHECKPOINTS)
    await this.pruneOldCheckpoints(checkpointDir);

    logger.debug(`[checkpoint] Saved checkpoint #${this.checkpointCount}: ${filename} (${agents.length} agents, ${activeAgents.length} active)`);

    return filePath;
  }

  /** Load the latest checkpoint from disk */
  static async loadLatest(runtimeDir: string): Promise<CheckpointData | null> {
    const latestPath = path.join(runtimeDir, CHECKPOINT_DIR, "latest.json");
    try {
      const raw = await fs.readFile(latestPath, "utf-8");
      return JSON.parse(raw) as CheckpointData;
    } catch {
      return null;
    }
  }

  /** Load a specific checkpoint by filename */
  static async load(runtimeDir: string, filename: string): Promise<CheckpointData | null> {
    const filePath = path.join(runtimeDir, CHECKPOINT_DIR, filename);
    try {
      const raw = await fs.readFile(filePath, "utf-8");
      return JSON.parse(raw) as CheckpointData;
    } catch {
      return null;
    }
  }

  /** List all available checkpoints (newest first) */
  static async listCheckpoints(runtimeDir: string): Promise<string[]> {
    const checkpointDir = path.join(runtimeDir, CHECKPOINT_DIR);
    try {
      const files = await fs.readdir(checkpointDir);
      return files
        .filter(f => f.startsWith("checkpoint-") && f.endsWith(".json"))
        .sort()
        .reverse();
    } catch {
      return [];
    }
  }

  /** Remove old checkpoints, keeping only the most recent MAX_CHECKPOINTS */
  private async pruneOldCheckpoints(checkpointDir: string): Promise<void> {
    try {
      const files = await fs.readdir(checkpointDir);
      const checkpoints = files
        .filter(f => f.startsWith("checkpoint-") && f.endsWith(".json"))
        .sort()
        .reverse();

      // Remove older checkpoints beyond the limit
      for (let i = MAX_CHECKPOINTS; i < checkpoints.length; i++) {
        try {
          await fs.unlink(path.join(checkpointDir, checkpoints[i]));
        } catch {
          // Ignore cleanup errors
        }
      }
    } catch {
      // Ignore errors during pruning
    }
  }
}
