#!/usr/bin/env node
import path from "path";
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
import tmuxDefault from "./core/tmux-controller.js";
import { HoldptyController } from "./core/holdpty-controller.js";
import type { IPtyBackend } from "./core/pty-backend.js";
import { DEFAULT_PORT, APP_VERSION, DEFAULT_PTY_BACKEND, getRuntimeTmuxPrefix, getRuntimeDaemonDir } from "@kora/shared";
import type { PtyBackendType } from "@kora/shared";
import { logger } from "./core/logger.js";
import { ensureBuiltinPlaybooks } from "./core/playbook-loader.js";
import { SuggestionsDatabase } from "./core/suggestions-db.js";
import { PlaybookDatabase } from "./core/playbook-database.js";

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
    ptyBackend = new HoldptyController();
    logger.info(`  [pty backend] holdpty`);
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
  const sessionManager = new SessionManager(globalConfigDir);
  await sessionManager.load();

  // 2a. Initialize suggestions database for recent paths and flags
  const suggestionsDb = new SuggestionsDatabase(isDev);

  // 2b. Initialize playbook database for YAML playbook storage
  const playbookDb = new PlaybookDatabase(globalConfigDir);

  // 3. Ensure built-in playbooks exist
  await ensureBuiltinPlaybooks(globalConfigDir);

  // 4. Restore existing sessions — reconnect to live tmux agents
  const orchestrators = new Map<string, Orchestrator>();
  const existingSessions = sessionManager.listSessions();
  for (const config of existingSessions) {
    if (config.status === "stopped") continue;
    try {
      const runtimeDir = path.join(config.projectPath, getRuntimeDaemonDir(process.env.KORA_DEV === "1"));
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
      const result = await orch.restore();
      orchestrators.set(config.id, orch);
      if (result.restored > 0 || result.dead > 0) {
        logger.info(`  Restored session "${config.id}": ${result.restored} agents alive, ${result.dead} dead`);
      }
    } catch (err) {
      logger.error({ err: err }, `  Failed to restore session "${config.id}":`);
    }
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

  // 6. Graceful shutdown on SIGINT / SIGTERM
  //    Persist state but DON'T kill agents — holdpty --bg sessions persist independently
  const shutdown = async () => {
    logger.info("\nShutting down daemon...");

    // Stop cleanup interval
    clearInterval(cleanupInterval);

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

  // Ensure built-in playbooks exist
  await ensureBuiltinPlaybooks(globalConfigDir);

  // Load the playbook
  const playbook = await (await import("./core/playbook-loader.js")).loadPlaybook(globalConfigDir, playbookName);
  if (!playbook) {
    logger.error(`Error: playbook "${playbookName}" not found`);
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

  const runtimeDir = path.join(session.projectPath, getRuntimeDaemonDir(isDev));
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
    await orch.cleanup();
    process.exit(1);
  }

  // Monitor agents and stream output
  let exitCode = 0;
  const startTime = Date.now();
  let outputInterval: NodeJS.Timeout | null = null;

  // Stream output from master agent to stdout
  const masterAgent = orch.agentManager.listAgents().find(a => a.config.role === "master");
  if (masterAgent) {
    outputInterval = setInterval(async () => {
      try {
        const output = await ptyBackend.capturePane(masterAgent.config.tmuxSession, 10, false);
        if (output.trim()) {
          process.stdout.write(output);
        }
      } catch {
        // Agent may have exited
      }
    }, 1000);
  }

  const checkInterval = setInterval(async () => {
    const elapsed = Date.now() - startTime;
    if (elapsed > timeoutMs) {
      logger.error(`\nTimeout reached (${timeoutMs}ms)`);
      if (outputInterval) clearInterval(outputInterval);
      clearInterval(checkInterval);
      await orch.cleanup();
      process.exit(2);
    }

    // Check if all agents are done
    const agents = orch.agentManager.listAgents();
    const active = agents.filter(a => spawnedAgents.includes(a.id) && a.status === "running");

    if (active.length === 0) {
      if (outputInterval) clearInterval(outputInterval);
      clearInterval(checkInterval);

      // Check for failures
      const failed = agents.filter(a => spawnedAgents.includes(a.id) && (a.status === "error" || a.status === "crashed"));
      if (failed.length > 0) {
        logger.error(`\nAgents failed: ${failed.map(a => a.config.name).join(", ")}`);
        exitCode = 1;
      } else {
        logger.info("\nAll agents completed successfully");
      }

      await orch.cleanup();
      process.exit(exitCode);
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
} else {
  logger.info(`Kora v${APP_VERSION}\n`);
  logger.info("Usage:");
  logger.info("  kora start [--port PORT] [--project PATH] [--dev]");
  logger.info("  kora stop");
  logger.info("  kora status");
  logger.info("  kora run <playbook> [task] [--project PATH] [--headless] [--timeout MS]");
}
