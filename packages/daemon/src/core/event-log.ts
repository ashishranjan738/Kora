// ============================================================
// Structured event log — uses SQLite for storage
// Falls back to JSONL if database is not available
// ============================================================

import { randomUUID } from "crypto";
import { EventEmitter } from "events";
import type { OrchestratorEvent, EventType } from "@kora/shared";
import type { AppDatabase } from "./database.js";
import { logger } from "./logger.js";

export class EventLog extends EventEmitter {
  private database: AppDatabase | null = null;

  constructor(private runtimeDir: string) {
    super();
  }

  /** Attach (or detach) a database instance for SQLite-backed storage */
  setDatabase(db: AppDatabase | null): void {
    this.database = db;
  }

  /** Log an event */
  async log(
    event: Omit<OrchestratorEvent, "id" | "timestamp">,
  ): Promise<OrchestratorEvent> {
    const now = new Date();
    const fullEvent: OrchestratorEvent = {
      ...event,
      id: randomUUID(),
      timestamp: now.toISOString(),
    };

    if (this.database?.isOpen) {
      try {
        // Extract agentId from event data for efficient filtering
        const data = (fullEvent as any).data || {};
        const agentId = data.agentId || data.from || data.agent?.id || undefined;
        this.database.insertEvent({
          id: fullEvent.id,
          sessionId: fullEvent.sessionId,
          type: fullEvent.type,
          data,
          timestamp: fullEvent.timestamp,
          agentId,
        });
      } catch (err) {
        logger.error({ err: err }, "[EventLog] SQLite write failed, falling back to JSONL:");
        await this.appendToJsonl(fullEvent, now);
      }
    } else {
      await this.appendToJsonl(fullEvent, now);
    }

    this.emit("event", fullEvent);
    return fullEvent;
  }

  /** Query events with filters */
  async query(params: {
    since?: string;
    until?: string;
    before?: string;
    limit?: number;
    offset?: number;
    type?: EventType;
    types?: string[];
    sessionId?: string;
    agentId?: string;
    search?: string;
    order?: "asc" | "desc";
  }): Promise<OrchestratorEvent[]> {
    if (this.database?.isOpen) {
      try {
        const rows = this.database.queryEvents({
          sessionId: params.sessionId,
          since: params.since,
          until: params.until,
          before: params.before,
          limit: params.limit,
          offset: params.offset,
          type: params.type,
          types: params.types,
          agentId: params.agentId,
          search: params.search,
          order: params.order,
        });
        return rows.map(r => ({
          id: r.id,
          sessionId: r.sessionId,
          type: r.type as EventType,
          data: r.data,
          timestamp: r.timestamp,
        }));
      } catch (err) {
        logger.error({ err: err }, "[EventLog] SQLite query failed, falling back to JSONL:");
      }
    }

    // Fallback: read from JSONL files
    return this.queryFromJsonl(params);
  }

  /** Count events matching filters (for pagination) */
  async count(params: {
    sessionId?: string;
    since?: string;
    until?: string;
    before?: string;
    type?: EventType;
    types?: string[];
    agentId?: string;
    search?: string;
  }): Promise<number> {
    if (this.database?.isOpen) {
      try {
        return this.database.countEvents({
          sessionId: params.sessionId,
          since: params.since,
          until: params.until,
          before: params.before,
          type: params.type,
          types: params.types,
          agentId: params.agentId,
          search: params.search,
        });
      } catch (err) {
        logger.error({ err: err }, "[EventLog] SQLite count failed:");
      }
    }
    return 0;
  }

  // ─── JSONL fallback (legacy) ─────────────────────────────

  private async appendToJsonl(event: OrchestratorEvent, date: Date): Promise<void> {
    const { mkdir, appendFile } = await import("fs/promises");
    const path = await import("path");
    const { EVENTS_DIR } = await import("@kora/shared");
    const eventsDir = path.join(this.runtimeDir, EVENTS_DIR);
    const dateStr = `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}-${String(date.getDate()).padStart(2, "0")}`;
    const filePath = path.join(eventsDir, `${dateStr}.jsonl`);

    await mkdir(path.dirname(filePath), { recursive: true });
    await appendFile(filePath, JSON.stringify(event) + "\n", "utf-8");
  }

  private async queryFromJsonl(params: {
    since?: string;
    limit?: number;
    type?: EventType;
  }): Promise<OrchestratorEvent[]> {
    const { readdir, readFile } = await import("fs/promises");
    const path = await import("path");
    const { EVENTS_DIR } = await import("@kora/shared");
    const eventsDir = path.join(this.runtimeDir, EVENTS_DIR);

    let files: string[];
    try {
      files = await readdir(eventsDir);
    } catch {
      return [];
    }

    const jsonlFiles = files.filter(f => f.endsWith(".jsonl")).sort();
    const allEvents: OrchestratorEvent[] = [];

    for (const file of jsonlFiles) {
      let content: string;
      try {
        content = await readFile(path.join(eventsDir, file), "utf-8");
      } catch { continue; }

      for (const line of content.trim().split("\n").filter(Boolean)) {
        try {
          const event: OrchestratorEvent = JSON.parse(line);
          if (params.since && new Date(event.timestamp) < new Date(params.since)) continue;
          if (params.type && event.type !== params.type) continue;
          allEvents.push(event);
        } catch { /* skip malformed */ }
      }
    }

    allEvents.sort((a, b) => new Date(b.timestamp).getTime() - new Date(a.timestamp).getTime());
    return params.limit ? allEvents.slice(0, params.limit) : allEvents;
  }
}
