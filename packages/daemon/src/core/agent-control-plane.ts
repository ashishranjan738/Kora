import type { ControlCommand, ControlResponse } from "@kora/shared";
import { CONTROL_DIR, PROCESSED_DIR } from "@kora/shared";
import { EventEmitter } from "events";
import fs from "fs/promises";
import fsSyn from "fs";
import path from "path";
import { logger } from "./logger.js";

export class AgentControlPlane extends EventEmitter {
  private watchers = new Map<string, fsSyn.FSWatcher>();
  private processedCommandIds = new Set<string>();

  constructor(private runtimeDir: string) { super(); }

  /** Set up control directories for an agent */
  async setupAgent(agentId: string): Promise<void> {
    const cmdDir = path.join(this.runtimeDir, CONTROL_DIR, `commands-${agentId}`);
    const resDir = path.join(this.runtimeDir, CONTROL_DIR, `responses-${agentId}`);
    await fs.mkdir(path.join(cmdDir, PROCESSED_DIR), { recursive: true });
    await fs.mkdir(resDir, { recursive: true });
  }

  /** Start watching all command directories for new commands */
  startWatching(): void {
    this.discoverAndWatchAgents().catch((err) => {
      logger.error({ err: err }, "[AgentControlPlane] Failed to discover command directories:");
    });
  }

  private async discoverAndWatchAgents(): Promise<void> {
    try {
      const controlRoot = path.join(this.runtimeDir, CONTROL_DIR);
      await fs.mkdir(controlRoot, { recursive: true });

      const entries = await fs.readdir(controlRoot, { withFileTypes: true });
      for (const entry of entries) {
        if (entry.isDirectory() && entry.name.startsWith("commands-")) {
          const agentId = entry.name.slice("commands-".length);
          this.watchAgent(agentId);
        }
      }
    } catch (err) {
      logger.error({ err: err }, "[AgentControlPlane] Error discovering command directories:");
    }
  }

  /** Watch a specific agent's command directory */
  watchAgent(agentId: string): void {
    const key = agentId;
    // Don't double-watch
    if (this.watchers.has(key)) return;

    const cmdDir = path.join(this.runtimeDir, CONTROL_DIR, `commands-${agentId}`);
    const watcher = fsSyn.watch(cmdDir, async (eventType, filename) => {
      if (!filename || !filename.endsWith(".json") || filename.startsWith(".")) return;
      const filePath = path.join(cmdDir, filename);
      try {
        // Small delay to ensure atomic rename has completed
        await new Promise((resolve) => setTimeout(resolve, 50));

        const raw = await fs.readFile(filePath, "utf-8");
        const command = JSON.parse(raw) as ControlCommand;

        // Idempotency check
        if (this.processedCommandIds.has(command.id)) return;
        this.processedCommandIds.add(command.id);

        // Move to processed
        await fs.rename(filePath, path.join(cmdDir, PROCESSED_DIR, filename));

        // Emit for the orchestrator to handle
        logger.info(`[AgentControlPlane] Received command "${command.action}" (id: ${command.id}) from agent ${agentId}`);
        this.emit("command", agentId, command);
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code === "ENOENT") return;
        logger.error({ err: err }, `[AgentControlPlane] Failed to process command file ${filename} for agent ${agentId}:`);
      }
    });

    watcher.on("error", (err: Error) => {
      logger.error({ err: err }, `[AgentControlPlane] Watcher error for ${key}:`);
    });

    this.watchers.set(key, watcher);
  }

  /** Write a response for an agent */
  async writeResponse(agentId: string, response: ControlResponse): Promise<void> {
    logger.info(`[AgentControlPlane] Writing response for command ${response.commandId} to agent ${agentId}: ${response.status}`);
    const resDir = path.join(this.runtimeDir, CONTROL_DIR, `responses-${agentId}`);
    const filename = `${Date.now()}-${response.commandId}.json`;
    const tmpFile = path.join(resDir, `.${filename}.tmp`);
    const finalFile = path.join(resDir, filename);
    await fs.writeFile(tmpFile, JSON.stringify(response, null, 2), "utf-8");
    await fs.rename(tmpFile, finalFile);
  }

  /** Load previously processed command IDs (for idempotency after restart) */
  async loadProcessedIds(): Promise<void> {
    try {
      const controlRoot = path.join(this.runtimeDir, CONTROL_DIR);
      await fs.mkdir(controlRoot, { recursive: true });

      const entries = await fs.readdir(controlRoot, { withFileTypes: true });
      for (const entry of entries) {
        if (entry.isDirectory() && entry.name.startsWith("commands-")) {
          const processedDir = path.join(controlRoot, entry.name, PROCESSED_DIR);
          try {
            const files = await fs.readdir(processedDir);
            for (const file of files) {
              if (!file.endsWith(".json")) continue;
              try {
                const raw = await fs.readFile(path.join(processedDir, file), "utf-8");
                const command = JSON.parse(raw) as ControlCommand;
                this.processedCommandIds.add(command.id);
              } catch {
                // Skip malformed files
              }
            }
          } catch {
            // processed dir may not exist yet
          }
        }
      }
    } catch {
      // Control directory may not exist yet
    }
  }

  /** Stop all watchers */
  stopWatching(): void {
    for (const [, w] of this.watchers) w.close();
    this.watchers.clear();
  }
}
