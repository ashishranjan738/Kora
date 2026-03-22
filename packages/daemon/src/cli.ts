#!/usr/bin/env node
import path from "path";
import fs from "fs";
import http from "http";
import {
  startDaemon,
  shutdownDaemon,
  getDaemonInfo,
  isDaemonAlive,
  cleanupDaemonInfo,
  getGlobalConfigDir,
} from "./daemon-lifecycle.js";
import { createServer } from "./server/index.js";
import { SessionManager } from "./core/session-manager.js";
import { Orchestrator } from "./core/orchestrator.js";
import { registry } from "./cli-providers/index.js";
import { loadPluginProviders } from "./cli-providers/plugin-loader.js";
import tmuxDefault from "./core/tmux-controller.js";
import { HoldptyController } from "./core/holdpty-controller.js";
import type { IPtyBackend } from "./core/pty-backend.js";
import { cleanupOrphanedSessions } from "./core/holdpty-cleanup.js";
import { DEFAULT_PORT, APP_VERSION, DEFAULT_PTY_BACKEND, getRuntimeTmuxPrefix, getRuntimeDaemonDir, SESSIONS_SUBDIR } from "@kora/shared";
import type { PtyBackendType } from "@kora/shared";
import { logger } from "./core/logger.js";
import { SuggestionsDatabase } from "./core/suggestions-db.js";
import { PlaybookDatabase } from "./core/playbook-database.js";
import { AutoCheckpoint } from "./core/auto-checkpoint.js";

const args = process.argv.slice(2);
const command = args[0];

/** Parse a --flag value from the args array */
function parseFlag(flag: string): string | undefined {
  const idx = args.indexOf(flag);
  if (idx !== -1 && idx + 1 < args.length) {
    return args[idx + 1];
  }
  return undefined;
}

async function handleStart(): Promise<void> {
  const isDev = args.includes("--dev") || process.env.KORA_DEV === "1";
  const devPort = 7891;  // Dev mode uses different port
  const defaultPort = isDev ? devPort : DEFAULT_PORT;
  const port = parseInt(parseFlag("--port") ?? String(defaultPort), 10);
  const projectPath = parseFlag("--project");
  const backendFlag = (parseFlag("--backend") || process.env.KORA_PTY_BACKEND || DEFAULT_PTY_BACKEND) as PtyBackendType;

  // Select PTY backend: "tmux" (default) or "holdpty"
  let ptyBackend: IPtyBackend;
  if (backendFlag === "holdpty") {
    // Use a persistent directory for holdpty sessions instead of /tmp/dt-{uid}
    // which macOS cleans during sleep/wake cycles, killing all agent sessions.
    const holdptyDir = path.join(require("os").homedir(), isDev ? ".kora-dev" : ".kora", "holdpty");
    fs.mkdirSync(holdptyDir, { recursive: true, mode: 0o700 });
    process.env.HOLDPTY_DIR = holdptyDir;

    // Ensure holdpty's spawn-helper binary has execute permissions.
    // npm install sometimes strips +x on macOS, causing "posix_spawnp failed".
    try {
      const spawnHelper = path.join(require.resolve("holdpty/package.json"), "..", "node_modules", "node-pty", "prebuilds", `${process.platform}-${process.arch}`, "spawn-helper");
      if (fs.existsSync(spawnHelper)) {
        fs.chmodSync(spawnHelper, 0o755);
      }
    } catch { /* non-fatal — only needed on macOS/Linux */ }

    ptyBackend = new HoldptyController();
    logger.info(`  [pty backend] holdpty (sessions: ${holdptyDir})`);
  } else {
    ptyBackend = tmuxDefault;
    logger.info(`  [pty backend] tmux`);
  }

  if (isDev) {
    process.env.KORA_DEV = "1"; // Ensure getGlobalConfigDir picks it up
    logger.info(`  [dev mode] Config: ~/.kora-dev/ | Port: ${port}`);
  }

  // 1. Start daemon (writes PID/port/token files, checks for existing)
  const info = await startDaemon({ port });

  // If the daemon PID is not ours, it was already alive
  if (info.pid !== process.pid) {
    logger.info(`Daemon already running on port ${info.port}`);
    process.exit(0);
  }

  // 2. Create SessionManager and load persisted sessions
  const globalConfigDir = getGlobalConfigDir();

  // Load plugin providers from ~/.kora/providers/ (or ~/.kora-dev/providers/)
  loadPluginProviders(registry, globalConfigDir);

  const sessionManager = new SessionManager(globalConfigDir);
  await sessionManager.load();

  // 2a. Initialize suggestions database for recent paths and flags
  const suggestionsDb = new SuggestionsDatabase(isDev);

  // 2b. Initialize playbook database for YAML playbook storage
  const playbookDb = new PlaybookDatabase(globalConfigDir);

  // 3. Ensure built-in playbooks exist in database + JSON files
  playbookDb.ensureBuiltinPlaybooks();
  const { ensureBuiltinPlaybooks: ensureJsonPlaybooks } = await import("./core/playbook-loader.js");
  await ensureJsonPlaybooks(globalConfigDir);

  // 4. Restore existing sessions — reconnect to live tmux agents
  const orchestrators = new Map<string, Orchestrator>();
  const existingSessions = sessionManager.listSessions();
  for (const config of existingSessions) {
    if (config.status === "stopped") continue;
    try {
      const runtimeDir = path.join(config.projectPath, getRuntimeDaemonDir(process.env.KORA_DEV === "1"), SESSIONS_SUBDIR, config.id);
      const orch = new Orchestrator({
        sessionId: config.id,
        projectPath: config.projectPath,
        runtimeDir,
        defaultProvider: config.defaultProvider,
        tmux: ptyBackend,
        providerRegistry: registry,
        messagingMode: config.messagingMode || "mcp",
        worktreeMode: config.worktreeMode,
      });
      await orch.start();
      // Configure workflow-aware status sets for restored sessions
      if (config.workflowStates && config.workflowStates.length > 0) {
        orch.database.setWorkflowStatuses(config.workflowStates);
      }
      const result = await orch.restore();
      orchestrators.set(config.id, orch);
      if (result.restored > 0 || result.dead > 0) {
        logger.info(`  Restored session "${config.id}": ${result.restored} agents alive, ${result.dead} dead`);
      }
    } catch (err) {
      logger.error({ err: err }, `  Failed to restore session "${config.id}":`);
    }
  }

  // 4b. Cleanup orphaned holdpty sessions that have no matching agent
  try {
    const allKnownAgents = Array.from(orchestrators.values())
      .flatMap((orch) => orch.getAgents());
    const tmuxPrefix = getRuntimeTmuxPrefix(isDev);
    const cleanup = await cleanupOrphanedSessions(ptyBackend, allKnownAgents, tmuxPrefix);
    if (cleanup.orphanedKilled > 0) {
      logger.info(`  Cleaned up ${cleanup.orphanedKilled} orphaned holdpty session(s)`);
    }
  } catch (err) {
    logger.warn({ err }, "  Holdpty cleanup failed (non-fatal)");
  }

  // 5. Create the HTTP + WebSocket server
  const { server, ptyManager } = createServer({
    token: info.token,
    deps: {
      sessionManager,
      orchestrators,
      providerRegistry: registry,
      tmux: ptyBackend,
      startTime: Date.now(),
      globalConfigDir,
      suggestionsDb,
      playbookDb,
    },
  });

  // 5. Start listening
  server.listen(info.port, () => {
    const configDirName = path.basename(getGlobalConfigDir());
    logger.info(
      `Kora daemon running on http://localhost:${info.port}`
    );
    logger.info(
      `Auth token: ${info.token.slice(0, 8)}... (saved to ~/${configDirName}/)`
    );
  });

  // 5a. Global tmux cleanup on startup — kill orphaned Kora sessions not matching any active session
  try {
    const tmuxPrefix = getRuntimeTmuxPrefix(process.env.KORA_DEV === "1");
    const allTmux = await ptyBackend.listSessions();
    const activeSessionIds = new Set(sessionManager.listSessions().map(s => s.id));
    let cleaned = 0;
    for (const s of allTmux) {
      // Only consider sessions created by this Kora instance (dev or prod)
      if (!s.startsWith(tmuxPrefix)) continue;
      const belongsToActive = Array.from(activeSessionIds).some(sid => s.startsWith(`${tmuxPrefix}${sid}-`));
      if (!belongsToActive) {
        try { await ptyBackend.killSession(s); cleaned++; } catch {}
      }
    }
    if (cleaned > 0) logger.info(`  Cleaned up ${cleaned} orphaned tmux sessions`);
  } catch {}

  // 5a-2. Prune orphaned git worktrees and stale agent branches on startup
  try {
    const { worktreeManager } = await import("./core/worktree.js");
    for (const sessionConfig of sessionManager.listSessions()) {
      if (sessionConfig.status === "stopped") continue;
      try {
        const runtimeDir = path.join(
          sessionConfig.projectPath,
          getRuntimeDaemonDir(isDev),
          SESSIONS_SUBDIR,
          sessionConfig.id,
        );
        // Get active agent IDs from the orchestrator (if restored)
        const orch = orchestrators.get(sessionConfig.id);
        const activeIds = new Set(
          orch ? orch.getAgents().filter(a => a.status === "running").map(a => a.id) : [],
        );
        const pruneResult = await worktreeManager.pruneAll(sessionConfig.projectPath, runtimeDir, activeIds);
        if (pruneResult.removedWorktrees.length > 0 || pruneResult.removedBranches.length > 0) {
          logger.info(
            `  Pruned ${pruneResult.removedWorktrees.length} worktrees, ${pruneResult.removedBranches.length} branches for session ${sessionConfig.id}` +
            (pruneResult.skippedDirty.length > 0 ? ` (skipped ${pruneResult.skippedDirty.length} with uncommitted changes)` : ""),
          );
        }
      } catch (err) {
        logger.debug({ err, sessionId: sessionConfig.id }, "Failed to prune worktrees for session");
      }
    }
  } catch {}

  // 5b. Set up periodic cleanup of orphaned tmux sessions (every 5 minutes)
  const cleanupInterval = setInterval(async () => {
    for (const [sid, orch] of orchestrators) {
      try {
        await orch.cleanup();
      } catch (err) {
        logger.error({ err: err }, `  Failed to cleanup session "${sid}":`);
      }
    }
  }, 5 * 60 * 1000); // 5 minutes

  // 5c. Start auto-checkpointing for each session (every 5 minutes)
  const checkpoints: AutoCheckpoint[] = [];
  for (const [sid, orch] of orchestrators) {
    const runtimeDir = path.join(
      sessionManager.listSessions().find(s => s.id === sid)?.projectPath || "",
      getRuntimeDaemonDir(isDev),
      SESSIONS_SUBDIR,
      sid,
    );
    const cp = new AutoCheckpoint({
      runtimeDir,
      sessionId: sid,
      getAgents: () => orch.getAgents(),
      startTime: Date.now(),
    });
    cp.start();
    checkpoints.push(cp);
  }

  // 6. Graceful shutdown on SIGINT / SIGTERM
  //    Persist state but DON'T kill agents — holdpty --bg sessions persist independently
  const shutdown = async () => {
    logger.info("\nShutting down daemon...");

    // Stop cleanup interval and checkpoints
    clearInterval(cleanupInterval);
    for (const cp of checkpoints) {
      try { await cp.save(); } catch {} // Final checkpoint before exit
      cp.stop();
    }

    // Persist all session/agent state to disk
    for (const [sid, orch] of orchestrators) {
      try {
        await orch.persistState();
        orch.messageBus.stopWatching();
        orch.controlPlane.stopWatching();
        logger.info(`  Saved state for session "${sid}"`);
      } catch (err) {
        logger.error({ err: err }, `  Failed to save state for session "${sid}":`);
      }
    }

    await sessionManager.save();
    await shutdownDaemon();

    // Close databases
    suggestionsDb.close();
    playbookDb.close();

    // Close PtyManager connections cleanly (disconnect dashboard terminals)
    ptyManager.destroyAll();

    server.close(() => {
      process.exit(0);
    });
    // Force exit after 5 seconds if server doesn't close
    setTimeout(() => process.exit(0), 5000).unref();
  };

  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);

  // SIGHUP: reload config/dashboard — do NOT exit
  // (Previous incident: kill -HUP killed the daemon, breaking all sessions)
  process.on("SIGHUP", () => {
    logger.info("[daemon] SIGHUP received — reloading (not exiting)");
    // Future: re-read index.html, reload config files
    // For now, just log and ignore to prevent accidental daemon death
  });

  // Crash resilience — catch unhandled errors and keep daemon alive
  process.on("uncaughtException", (err) => {
    logger.error({ err }, "[daemon] UNCAUGHT EXCEPTION — daemon staying alive");
    // Write to crash log for forensics
    try {
      const crashLog = path.join(getGlobalConfigDir(), "crash.log");
      const entry = `[${new Date().toISOString()}] uncaughtException: ${err.stack || err.message}\n`;
      require("fs").appendFileSync(crashLog, entry);
    } catch { /* best effort */ }
  });

  process.on("unhandledRejection", (reason, promise) => {
    const err = reason instanceof Error ? reason : new Error(String(reason));
    logger.error({ err }, "[daemon] UNHANDLED REJECTION — daemon staying alive");
    // Write to crash log for forensics
    try {
      const crashLog = path.join(getGlobalConfigDir(), "crash.log");
      const entry = `[${new Date().toISOString()}] unhandledRejection: ${err.stack || err.message}\n`;
      require("fs").appendFileSync(crashLog, entry);
    } catch { /* best effort */ }
  });

  // 7. If --project flag provided, auto-create a session for that project
  if (projectPath) {
    const resolvedPath = path.resolve(projectPath);
    try {
      const session = await sessionManager.createSession({
        name: path.basename(resolvedPath),
        projectPath: resolvedPath,
      });
      logger.info(
        `Auto-created session "${session.name}" for ${resolvedPath}`
      );
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      logger.error(`Failed to auto-create session: ${message}`);
    }
  }
}

async function handleStop(): Promise<void> {
  const info = await getDaemonInfo();
  if (!info) {
    logger.info("No daemon running");
    return;
  }

  const alive = await isDaemonAlive(info.port);
  if (alive) {
    try {
      process.kill(info.pid, "SIGTERM");
    } catch {
      // Process may already be gone
    }
  }

  await cleanupDaemonInfo();
  logger.info("Daemon stopped");
}

async function handleStatus(): Promise<void> {
  const info = await getDaemonInfo();
  if (!info) {
    logger.info("No daemon running");
    return;
  }

  const alive = await isDaemonAlive(info.port);
  if (!alive) {
    logger.info("No daemon running (stale PID file found)");
    return;
  }

  // Fetch status from the running daemon
  const statusData = await new Promise<string>((resolve, reject) => {
    const req = http.get(
      `http://localhost:${info.port}/api/v1/status`,
      (res) => {
        let body = "";
        res.on("data", (chunk: Buffer) => {
          body += chunk.toString();
        });
        res.on("end", () => resolve(body));
      }
    );
    req.on("error", reject);
    req.setTimeout(3000, () => {
      req.destroy();
      reject(new Error("Timeout"));
    });
  });

  const status = JSON.parse(statusData);
  logger.info("Daemon is running:");
  logger.info(`  PID:             ${info.pid}`);
  logger.info(`  Port:            ${info.port}`);
  logger.info(`  Version:         ${status.version}`);
  logger.info(`  API version:     ${status.apiVersion}`);
  logger.info(`  Uptime:          ${Math.round(status.uptime / 1000)}s`);
  logger.info(`  Active sessions: ${status.activeSessions}`);
  logger.info(`  Active agents:   ${status.activeAgents}`);
}

async function handleRun(): Promise<void> {
  const playbookName = args[1];
  const task = args[2] && !args[2].startsWith("--") ? args[2] : undefined;
  const isHeadless = args.includes("--headless");
  const timeoutMs = parseInt(parseFlag("--timeout") ?? "1800000", 10); // Default 30 minutes
  const projectPath = parseFlag("--project") || process.cwd();
  const isDev = args.includes("--dev") || process.env.KORA_DEV === "1";

  if (!playbookName) {
    logger.error("Error: playbook name is required");
    logger.info("Usage: kora run <playbook> [task] [--project PATH] [--headless] [--timeout MS]");
    process.exit(1);
  }

  if (!isHeadless) {
    logger.error("Error: non-headless mode not yet implemented. Use --headless flag.");
    process.exit(1);
  }

  // Headless mode: run without dashboard
  const backendFlag = (parseFlag("--backend") || process.env.KORA_PTY_BACKEND || DEFAULT_PTY_BACKEND) as PtyBackendType;
  let ptyBackend: IPtyBackend;
  if (backendFlag === "holdpty") {
    const holdptyDir = path.join(require("os").homedir(), isDev ? ".kora-dev" : ".kora", "holdpty");
    fs.mkdirSync(holdptyDir, { recursive: true, mode: 0o700 });
    process.env.HOLDPTY_DIR = holdptyDir;
    try {
      const spawnHelper = path.join(require.resolve("holdpty/package.json"), "..", "node_modules", "node-pty", "prebuilds", `${process.platform}-${process.arch}`, "spawn-helper");
      if (fs.existsSync(spawnHelper)) fs.chmodSync(spawnHelper, 0o755);
    } catch { /* non-fatal */ }
    ptyBackend = new HoldptyController();
  } else {
    ptyBackend = tmuxDefault;
  }

  if (isDev) {
    process.env.KORA_DEV = "1";
  }

  const globalConfigDir = getGlobalConfigDir();
  const sessionManager = new SessionManager(globalConfigDir);
  await sessionManager.load();

  // Initialize playbook database and ensure built-in playbooks exist
  const playbookDb = new PlaybookDatabase(globalConfigDir);
  playbookDb.ensureBuiltinPlaybooks();

  // Load the playbook from database
  const playbookRow = playbookDb.getPlaybookByName(playbookName);
  if (!playbookRow) {
    logger.error(`Error: playbook "${playbookName}" not found`);
    process.exit(1);
  }

  // Parse YAML
  const { validateYAMLPlaybook } = await import("./core/playbook-validator.js");
  const validation = validateYAMLPlaybook(playbookRow.yamlContent);
  if (!validation.valid || !validation.parsed) {
    logger.error(`Error: playbook "${playbookName}" is invalid: ${validation.errors.join(", ")}`);
    process.exit(1);
  }
  const playbook = validation.parsed;

  // Validate playbook
  if (!playbook.agents || playbook.agents.length === 0) {
    logger.error(`Error: playbook "${playbookName}" has no agents defined`);
    process.exit(1);
  }

  logger.info(`Running playbook: ${playbook.name}`);
  if (task) {
    logger.info(`Task: ${task}`);
  }

  // Create a session for this run
  const sessionName = `${playbook.name.toLowerCase().replace(/\s+/g, "-")}-${Date.now()}`;
  const session = await sessionManager.createSession({
    name: sessionName,
    projectPath: path.resolve(projectPath),
    defaultProvider: playbook.agents[0]?.provider || "claude-code",
  });

  const runtimeDir = path.join(session.projectPath, getRuntimeDaemonDir(isDev), SESSIONS_SUBDIR, session.id);
  const orch = new Orchestrator({
    sessionId: session.id,
    projectPath: session.projectPath,
    runtimeDir,
    defaultProvider: session.defaultProvider,
    tmux: ptyBackend,
    providerRegistry: registry,
    messagingMode: session.messagingMode || "mcp",
    worktreeMode: session.worktreeMode,
  });

  await orch.start();

  // Spawn agents from playbook
  const { buildPersona } = await import("./core/persona-builder.js");
  const { DEFAULT_MASTER_PERMISSIONS, DEFAULT_WORKER_PERMISSIONS } = await import("@kora/shared");

  // Sort: masters first, then workers
  const sorted = [...playbook.agents].sort((a, b) => {
    if (a.role === "master" && b.role !== "master") return -1;
    if (a.role !== "master" && b.role === "master") return 1;
    return 0;
  });

  const spawnedAgents: string[] = [];

  for (const pa of sorted) {
    const providerId = pa.provider ?? session.defaultProvider;
    const provider = registry.get(providerId);
    if (!provider) {
      logger.warn(`Skipping agent "${pa.name}" — provider "${providerId}" not found`);
      continue;
    }

    const permissions = pa.role === "master"
      ? { ...DEFAULT_MASTER_PERMISSIONS }
      : { ...DEFAULT_WORKER_PERMISSIONS };

    const currentAgents = orch.agentManager.listAgents().filter(a => a.status === "running");
    const peers = currentAgents.map(a => ({
      id: a.id,
      name: a.config.name,
      role: a.config.role,
      provider: a.config.cliProvider,
      model: a.config.model,
    }));

    const fullPersona = buildPersona({
      agentId: "pending",
      role: pa.role,
      userPersona: pa.persona,
      permissions,
      sessionId: session.id,
      runtimeDir,
      peers,
      projectPath: session.projectPath,
    });

    // Use the task param as initialTask for the master agent only
    const initialTask = pa.role === "master" && task ? task : pa.initialTask;

    const agentState = await orch.agentManager.spawnAgent({
      sessionId: session.id,
      name: pa.name,
      role: pa.role,
      provider,
      model: pa.model,
      persona: fullPersona,
      workingDirectory: session.projectPath,
      runtimeDir,
      extraCliArgs: pa.extraCliArgs,
      initialTask,
      messagingMode: session.messagingMode || "mcp",
      worktreeMode: session.worktreeMode,
    });

    spawnedAgents.push(agentState.id);
    logger.info(`  Spawned: ${pa.name} (${pa.role})`);
  }

  if (spawnedAgents.length === 0) {
    logger.error("Error: no agents spawned");
    try {
      await orch.cleanup();
      await sessionManager.stopSession(session.id);
      await sessionManager.save();
    } catch (err) {
      logger.error({ err }, "Error during cleanup:");
    }
    process.exit(1);
  }

  // Monitor agents and stream output
  let exitCode = 0;
  const startTime = Date.now();
  let outputInterval: NodeJS.Timeout | null = null;
  const seenLines = new Set<string>();

  // Stream output from master agent to stdout (incremental, de-duplicated)
  const masterAgent = orch.agentManager.listAgents().find(a => a.config.role === "master");
  if (!masterAgent) {
    logger.warn("Warning: No master agent found, output streaming disabled");
  } else {
    outputInterval = setInterval(async () => {
      try {
        // Capture recent lines
        const output = await ptyBackend.capturePane(masterAgent.config.tmuxSession, 20, false);
        const lines = output.split('\n');

        // Print only lines we haven't seen before
        for (const line of lines) {
          const trimmed = line.trim();
          if (trimmed && !seenLines.has(line)) {
            process.stdout.write(line + '\n');
            seenLines.add(line);

            // Prevent memory leak: limit seen lines to last 1000
            if (seenLines.size > 1000) {
              const firstKey = Array.from(seenLines)[0];
              if (firstKey) seenLines.delete(firstKey);
            }
          }
        }
      } catch {
        // Agent may have exited, stop streaming
        if (outputInterval) {
          clearInterval(outputInterval);
          outputInterval = null;
        }
      }
    }, 1000);
  }

  // Graceful shutdown handler for Ctrl+C
  let checkInterval: NodeJS.Timeout | null = null;

  const cleanup = async (signal: string, code: number = 130) => {
    logger.info(`\n${signal} received, cleaning up...`);
    if (outputInterval) {
      clearInterval(outputInterval);
      outputInterval = null;
    }
    if (checkInterval) {
      clearInterval(checkInterval);
      checkInterval = null;
    }

    // Cleanup orchestrator and session
    try {
      await orch.cleanup();
      await sessionManager.stopSession(session.id);
      await sessionManager.save();
    } catch (err) {
      logger.error({ err }, "Error during cleanup:");
    }

    process.exit(code);
  };

  process.on('SIGINT', () => cleanup('SIGINT'));
  process.on('SIGTERM', () => cleanup('SIGTERM'));

  checkInterval = setInterval(async () => {
    const elapsed = Date.now() - startTime;
    if (elapsed >= timeoutMs) {
      logger.error(`\nTimeout reached (${timeoutMs}ms)`);
      await cleanup('TIMEOUT', 2);
    }

    // Check if all agents are done by verifying their tmux sessions still exist
    const agents = orch.agentManager.listAgents().filter(a => spawnedAgents.includes(a.id));
    let allDone = true;
    const failedAgents: typeof agents = [];

    for (const agent of agents) {
      const sessionExists = await ptyBackend.hasSession(agent.config.tmuxSession);
      if (sessionExists) {
        allDone = false;
      } else {
        // Session ended - check if it was an error
        if (agent.status === "error" || agent.status === "crashed") {
          failedAgents.push(agent);
        }
      }
    }

    if (allDone) {
      // Check for failures
      if (failedAgents.length > 0) {
        logger.error(`\nAgents failed: ${failedAgents.map(a => a.config.name).join(", ")}`);
        await cleanup('COMPLETION', 1);
      } else {
        logger.info("\nAll agents completed successfully");
        await cleanup('COMPLETION', 0);
      }
    }
  }, 2000);
}

if (command === "start") {
  handleStart().catch((err) => {
    logger.error({ err: err }, "Failed to start daemon:");
    process.exit(1);
  });
} else if (command === "stop") {
  handleStop().catch((err) => {
    logger.error({ err: err }, "Failed to stop daemon:");
    process.exit(1);
  });
} else if (command === "status") {
  handleStatus().catch((err) => {
    logger.error({ err: err }, "Failed to get status:");
    process.exit(1);
  });
} else if (command === "run") {
  handleRun().catch((err) => {
    logger.error({ err: err }, "Failed to run playbook:");
    process.exit(1);
  });
} else if (command === "tunnel") {
  const tunnelCmd = args[1];
  (async () => {
    const { startTunnel, stopTunnel, getTunnelStatus } = await import("./core/tunnel.js");
    const tunnelDevMode = args.includes("--dev") || process.env.KORA_DEV === "1";
    const port = tunnelDevMode ? 7891 : 7890;

    if (tunnelCmd === "start") {
      try {
        // Read token from config dir
        const fs = await import("fs");
        const tunnelIsDev = args.includes("--dev") || process.env.KORA_DEV === "1";
        if (tunnelIsDev) process.env.KORA_DEV = "1";
        const tokenPath = path.join(getGlobalConfigDir(), "token");
        const token = fs.existsSync(tokenPath) ? fs.readFileSync(tokenPath, "utf-8").trim() : undefined;

        const info = await startTunnel(port, token);
        logger.info(`Tunnel started: ${info.url}`);
        logger.info(`Expires: ${info.expiresAt}`);
        // Keep process alive
        process.on("SIGINT", () => { stopTunnel(); process.exit(0); });
        process.on("SIGTERM", () => { stopTunnel(); process.exit(0); });
      } catch (err: any) {
        logger.error(err.message);
        process.exit(1);
      }
    } else if (tunnelCmd === "stop") {
      const stopped = stopTunnel();
      logger.info(stopped ? "Tunnel stopped" : "No tunnel running");
    } else if (tunnelCmd === "status") {
      const status = getTunnelStatus();
      if (status) {
        logger.info(`Tunnel active: ${status.url}`);
        logger.info(`Started: ${status.startedAt}`);
        logger.info(`Expires: ${status.expiresAt}`);
      } else {
        logger.info("No tunnel running");
      }
    } else {
      logger.info("Usage: kora tunnel start|stop|status [--dev]");
    }
  })().catch(err => { logger.error(err); process.exit(1); });
} else {
  logger.info(`Kora v${APP_VERSION}\n`);
  logger.info("Usage:");
  logger.info("  kora start [--port PORT] [--project PATH] [--dev]");
  logger.info("  kora stop");
  logger.info("  kora status");
  logger.info("  kora tunnel start|stop|status [--dev]");
  logger.info("  kora run <playbook> [task] [--project PATH] [--headless] [--timeout MS]");
}
