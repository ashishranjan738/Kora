/**
 * Cron scheduler for auto-starting sessions on a schedule.
 *
 * Uses cron-parser for expression parsing (no built-in timer).
 * Check loop piggybacks on daemon's existing periodic checks.
 *
 * Pre-computes next_run_at for efficient querying.
 */

import CronExpressionParser from "cron-parser";
import cronstrue from "cronstrue";
import { logger } from "./logger.js";
import type { AppDatabase } from "./database.js";

const MAX_ACTIVE_SCHEDULES = 5;

export interface ScheduleConfig {
  id: string;
  name: string;
  cronExpression: string;
  timezone?: string;
  playbookId?: string;
  sessionConfig: Record<string, unknown>;
  enabled: boolean;
  lastRunAt?: string;
  nextRunAt?: string;
  createdAt: string;
  updatedAt: string;
  humanReadable?: string;
}

/**
 * Validate a cron expression.
 * @returns null if valid, error message if invalid.
 */
export function validateCronExpression(expr: string): string | null {
  try {
    CronExpressionParser.parse(expr);
    return null;
  } catch (err: any) {
    return `Invalid cron expression: ${err.message}`;
  }
}

/**
 * Compute the next run time for a cron expression.
 */
export function computeNextRun(cronExpression: string, timezone?: string): Date {
  const options: any = {};
  if (timezone && timezone !== "system") {
    options.tz = timezone;
  }
  const interval = CronExpressionParser.parse(cronExpression, options);
  return interval.next().toDate();
}

/**
 * Get a human-readable description of a cron expression.
 */
export function describeCron(expr: string): string {
  try {
    return cronstrue.toString(expr);
  } catch {
    return expr;
  }
}

/**
 * Check for due schedules and return their IDs.
 * Queries the database for schedules where next_run_at <= now AND enabled = 1.
 */
export function getDueSchedules(db: AppDatabase): Array<ScheduleConfig> {
  const now = new Date().toISOString();
  const rows = db.db.prepare(
    `SELECT * FROM session_schedules WHERE enabled = 1 AND next_run_at IS NOT NULL AND next_run_at <= ? ORDER BY next_run_at ASC`
  ).all(now) as any[];

  return rows.map(mapScheduleRow);
}

/**
 * After a schedule fires, update last_run_at and compute next_run_at.
 */
export function markScheduleRun(db: AppDatabase, scheduleId: string, cronExpression: string, timezone?: string): void {
  const now = new Date().toISOString();
  const nextRun = computeNextRun(cronExpression, timezone).toISOString();

  db.db.prepare(
    `UPDATE session_schedules SET last_run_at = ?, next_run_at = ?, updated_at = ? WHERE id = ?`
  ).run(now, nextRun, now, scheduleId);
}

/**
 * Count active (enabled) schedules.
 */
export function countActiveSchedules(db: AppDatabase): number {
  const row = db.db.prepare(
    `SELECT COUNT(*) as count FROM session_schedules WHERE enabled = 1`
  ).get() as any;
  return row?.count ?? 0;
}

/**
 * Check if adding a new schedule would exceed the global limit.
 */
export function canAddSchedule(db: AppDatabase): boolean {
  return countActiveSchedules(db) < MAX_ACTIVE_SCHEDULES;
}

function mapScheduleRow(r: any): ScheduleConfig {
  let humanReadable: string | undefined;
  try { humanReadable = describeCron(r.cron_expression); } catch { /* ignore */ }

  return {
    id: r.id,
    name: r.name,
    cronExpression: r.cron_expression,
    timezone: r.timezone || "system",
    playbookId: r.playbook_id || undefined,
    sessionConfig: JSON.parse(r.session_config || "{}"),
    enabled: r.enabled === 1,
    lastRunAt: r.last_run_at || undefined,
    nextRunAt: r.next_run_at || undefined,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
    humanReadable,
  };
}

// ─── Database CRUD (uses raw db access since schedules are global, not per-session) ───

/**
 * Validate sessionConfig has required fields for session creation.
 * Catches malformed configs at schedule creation time instead of at cron fire time.
 */
export function validateSessionConfig(config: Record<string, unknown>): string | null {
  if (!config || typeof config !== "object") return "sessionConfig must be an object";
  if (!config.projectPath || typeof config.projectPath !== "string") return "sessionConfig.projectPath is required";
  if (!config.name || typeof config.name !== "string") return "sessionConfig.name is required";
  return null;
}

export function createSchedule(db: AppDatabase, schedule: {
  id: string;
  name: string;
  cronExpression: string;
  timezone?: string;
  playbookId?: string;
  sessionConfig: Record<string, unknown>;
}): ScheduleConfig {
  // Validate sessionConfig shape before persisting
  const configError = validateSessionConfig(schedule.sessionConfig);
  if (configError) throw new Error(`Invalid schedule: ${configError}`);

  const now = new Date().toISOString();
  const nextRun = computeNextRun(schedule.cronExpression, schedule.timezone).toISOString();

  db.db.prepare(
    `INSERT INTO session_schedules (id, name, cron_expression, timezone, playbook_id, session_config, enabled, next_run_at, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, 1, ?, ?, ?)`
  ).run(
    schedule.id, schedule.name, schedule.cronExpression,
    schedule.timezone || "system", schedule.playbookId || null,
    JSON.stringify(schedule.sessionConfig), nextRun, now, now,
  );

  return getSchedule(db, schedule.id)!;
}

export function getSchedule(db: AppDatabase, id: string): ScheduleConfig | null {
  const row = db.db.prepare(`SELECT * FROM session_schedules WHERE id = ?`).get(id) as any;
  if (!row) return null;
  return mapScheduleRow(row);
}

export function listSchedules(db: AppDatabase): ScheduleConfig[] {
  const rows = db.db.prepare(`SELECT * FROM session_schedules ORDER BY created_at DESC`).all() as any[];
  return rows.map(mapScheduleRow);
}

export function updateSchedule(db: AppDatabase, id: string, updates: Partial<{
  name: string;
  cronExpression: string;
  timezone: string;
  playbookId: string;
  sessionConfig: Record<string, unknown>;
  enabled: boolean;
}>): boolean {
  const existing = db.db.prepare(`SELECT * FROM session_schedules WHERE id = ?`).get(id) as any;
  if (!existing) return false;

  const now = new Date().toISOString();
  const newCron = updates.cronExpression || existing.cron_expression;
  const newTz = updates.timezone || existing.timezone;
  const newEnabled = updates.enabled !== undefined ? (updates.enabled ? 1 : 0) : existing.enabled;

  // Recompute next_run_at if cron changed
  let nextRun = existing.next_run_at;
  if (updates.cronExpression) {
    nextRun = computeNextRun(newCron, newTz).toISOString();
  }

  db.db.prepare(
    `UPDATE session_schedules SET name = ?, cron_expression = ?, timezone = ?, playbook_id = ?, session_config = ?, enabled = ?, next_run_at = ?, updated_at = ? WHERE id = ?`
  ).run(
    updates.name || existing.name,
    newCron, newTz,
    updates.playbookId !== undefined ? updates.playbookId : existing.playbook_id,
    updates.sessionConfig ? JSON.stringify(updates.sessionConfig) : existing.session_config,
    newEnabled, nextRun, now, id,
  );

  return true;
}

export function deleteSchedule(db: AppDatabase, id: string): boolean {
  return db.db.prepare(`DELETE FROM session_schedules WHERE id = ?`).run(id).changes > 0;
}
