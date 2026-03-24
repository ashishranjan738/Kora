import type { AgentConfig, AgentState, AgentRole, AgentPermissions, AgentCost, MessagingMode, WorktreeMode } from "@kora/shared";
import { AutonomyLevel, DEFAULT_MASTER_PERMISSIONS, DEFAULT_WORKER_PERMISSIONS, DEFAULT_MAX_RESTARTS, PERSONAS_DIR, GRACEFUL_SHUTDOWN_TIMEOUT_MS, getRuntimeTmuxPrefix, MCP_SERVER_NAME, SPAWN_TIMEOUT_MS, MAX_AGENTS_PER_SESSION } from "@kora/shared";
import type { CLIProvider } from "@kora/shared";
import { detectAgentSkills } from "@kora/shared";
import type { IPtyBackend } from "./pty-backend.js";
import { AgentHealthMonitor } from "./agent-health.js";
import { WorktreeManager } from "./worktree.js";
import { EventEmitter } from "events";
import { v4 as uuidv4 } from "uuid";
import fs from "fs/promises";
import { readFileSync } from "fs";
import path from "path";
import { fileURLToPath } from "url";
import { logger } from "./logger.js";

export interface SpawnAgentOptions {
  sessionId: string;
  name: string;
  role: AgentRole;
  provider: CLIProvider;
  model: string;
  persona?: string;
  workingDirectory: string;
  runtimeDir: string;           // path to .kora/
  autonomyLevel?: AutonomyLevel;
  spawnedBy?: string;
  extraCliArgs?: string[];
  envVars?: Record<string, string>;
  initialTask?: string;
  messagingMode?: MessagingMode;
  worktreeMode?: WorktreeMode;
  skipArgValidation?: boolean;
  /** Reuse a specific agent ID instead of generating a new one (used by restart to preserve identity) */
  forceAgentId?: string;
  /** Kiro workspace root directory (set internally during Kiro MCP config setup) */
  _kiroWorkspaceRoot?: string;
}

/** Convert a name like "CSS Expert" to "css-expert" */
function slugify(name: string): string {
  return name
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

export class AgentManager extends EventEmitter {
  private agents = new Map<string, AgentState>();
  private worktreeInfo = new Map<string, { projectPath: string; runtimeDir: string }>();

  constructor(
    private tmux: IPtyBackend,
    private healthMonitor: AgentHealthMonitor,
    private worktreeManager: WorktreeManager = new WorktreeManager(),
  ) {
    super();
    // Listen for health events
    this.healthMonitor.on("agent-dead", (agentId) => this.handleAgentCrash(agentId));
    this.healthMonitor.on("agent-idle", (agentId) => this.emit("agent-idle", agentId));
    this.healthMonitor.on("agent-working", (agentId) => this.emit("agent-working", agentId));
  }

  /** Spawn a new agent */
  async spawnAgent(options: SpawnAgentOptions): Promise<AgentState> {
    // 0. Check agent limit
    const sessionAgents = Array.from(this.agents.values()).filter(
      (a) => a.config.sessionId === options.sessionId
    );
    if (sessionAgents.length >= MAX_AGENTS_PER_SESSION) {
      throw new Error(`Cannot spawn agent: session ${options.sessionId} has reached maximum of ${MAX_AGENTS_PER_SESSION} agents`);
    }

    // Wrap spawn logic with timeout
    const spawnPromise = this._spawnAgentInternal(options);
    const timeoutPromise = new Promise<never>((_, reject) => {
      setTimeout(() => reject(new Error(`Agent spawn timeout after ${SPAWN_TIMEOUT_MS}ms`)), SPAWN_TIMEOUT_MS);
    });

    return Promise.race([spawnPromise, timeoutPromise]);
  }

  /** Internal spawn logic (extracted for timeout wrapping) */
  private async _spawnAgentInternal(options: SpawnAgentOptions): Promise<AgentState> {
    // 1. Generate agent ID (slugify name) — or reuse existing ID for restarts
    const agentId = options.forceAgentId ?? (slugify(options.name) + "-" + uuidv4().slice(0, 8));
    const isDev = process.env.KORA_DEV === "1";
    const tmuxSession = `${getRuntimeTmuxPrefix(isDev)}${options.sessionId}-${agentId}`;

    // 2. Write persona files
    const personasDir = path.join(options.runtimeDir, PERSONAS_DIR);
    await fs.mkdir(personasDir, { recursive: true });

    // 2a. Write full persona to {agentId}-prompt.md (for get_context("persona") API to serve)
    const personaFile = path.join(personasDir, `${agentId}-prompt.md`);
    if (options.persona) {
      const personaWithId = options.persona
        .replace(/inbox-pending\//g, `inbox-${agentId}/`)
        .replace(/outbox-pending\//g, `outbox-${agentId}/`)
        .replace(/commands-pending\//g, `commands-${agentId}/`)
        .replace(/responses-pending\//g, `responses-${agentId}/`)
        .replace(/"from":"pending"/g, `"from":"${agentId}"`)           // Fix outbox JSON example
        .replace(/Your ID is `pending`/g, `Your ID is \`${agentId}\``); // Fix team section self-ID
      await fs.writeFile(personaFile, personaWithId, "utf-8");
    }

    // 2b. Write tiny boot prompt as system prompt file (instructs agent to call get_context)
    const { buildBootPrompt } = await import("./boot-prompt-builder.js");
    const bootPrompt = buildBootPrompt(options.messagingMode);
    const systemPromptFile = path.join(personasDir, `${agentId}-boot.md`);
    await fs.writeFile(systemPromptFile, bootPrompt, "utf-8");

    // Create git worktree for agent isolation (if in a git repo and not shared mode)
    let agentWorkDir = options.workingDirectory;
    if (options.worktreeMode !== "shared" && await this.worktreeManager.isGitRepo(options.workingDirectory)) {
      try {
        agentWorkDir = await this.worktreeManager.createWorktree(
          options.workingDirectory,
          options.runtimeDir,
          agentId,
        );
        this.worktreeInfo.set(agentId, {
          projectPath: options.workingDirectory,
          runtimeDir: options.runtimeDir,
        });
      } catch (err) {
        logger.error({ err: err }, `[agent-manager] Failed to create worktree for ${agentId}, using main directory:`);
      }
    }

    // Kiro-specific: inject boot prompt via steering files instead of CLI flags.
    // Kiro doesn't support --system-prompt-file; it reads .kiro/steering/*.md
    // Boot prompt is ~500 bytes — no file conflicts in shared workspaces.
    // Full persona available via get_context("persona") API.
    if (options.provider.id === "kiro") {
      const { buildBootPrompt } = await import("./boot-prompt-builder.js");
      const kiroBootPrompt = buildBootPrompt(options.messagingMode);

      const kiroSteeringDir = path.join(agentWorkDir, ".kiro", "steering");
      await fs.mkdir(kiroSteeringDir, { recursive: true });
      await fs.writeFile(
        path.join(kiroSteeringDir, "kora.md"),
        kiroBootPrompt,
        "utf-8",
      );

      // Also write AGENTS.md which Kiro auto-reads from workspace root
      // AGENTS.md also gets boot prompt (Kiro reads this automatically)
      await fs.writeFile(
        path.join(agentWorkDir, "AGENTS.md"),
        kiroBootPrompt,
        "utf-8",
      );
    }

    // 3a. Generate MCP config for inter-agent messaging (MCP-capable providers + MCP mode only)
    const effectiveMessagingMode = options.messagingMode ?? "mcp";
    let mcpConfigPath: string | undefined;
    // Generate MCP config for MCP-capable providers in MCP mode only.
    // CLI mode means kora-cli only — no MCP server, for ALL providers including Kiro.
    const needsMcpConfig = options.provider.supportsMcp && effectiveMessagingMode === "mcp";
    if (needsMcpConfig) {
      try {
        const mcpDir = path.join(options.runtimeDir, "mcp");
        await fs.mkdir(mcpDir, { recursive: true });
        mcpConfigPath = path.join(mcpDir, `${agentId}-mcp.json`);

        // Resolve path to the compiled MCP server script
        // __dirname at runtime is <pkg>/dist/core/, MCP server is at <pkg>/dist/mcp/
        const mcpServerScript = path.resolve(__dirname, "../mcp/agent-mcp-server.js");

        // Read daemon port and token from global config (~/.kora/ or ~/.kora-dev/)
        const os = await import("os");
        const isDev = process.env.KORA_DEV === "1";
        const configDir = process.env.KORA_CONFIG_DIR || path.join(os.default.homedir(), isDev ? ".kora-dev" : ".kora");
        const globalDir = configDir;
        let daemonPort = "7890";
        let daemonToken = "";
        try {
          daemonPort = (await fs.readFile(path.join(globalDir, "daemon.port"), "utf-8")).trim();
        } catch { /* use default */ }
        try {
          daemonToken = (await fs.readFile(path.join(globalDir, "daemon.token"), "utf-8")).trim();
        } catch { /* empty token */ }

        const mcpConfig = {
          mcpServers: {
            [MCP_SERVER_NAME]: {
              command: "node",
              args: [
                mcpServerScript,
                "--agent-id", agentId,
                "--session-id", options.sessionId,
                // agent-role, daemon-url, token, project-path self-bootstrapped via API
              ],
              env: {
                KORA_DEV: isDev ? "1" : "0",
                ...(process.env.KORA_CONFIG_DIR ? { KORA_CONFIG_DIR: process.env.KORA_CONFIG_DIR } : {}),
              },
            },
          },
        };
        await fs.writeFile(mcpConfigPath, JSON.stringify(mcpConfig, null, 2), "utf-8");
      } catch (err) {
        logger.error({ err: err }, `[agent-manager] Failed to generate MCP config for ${agentId}:`);
        mcpConfigPath = undefined;
      }
    }

    // 3b. Build command via provider.buildCommand(...)
    const command = options.provider.buildCommand({
      model: options.model,
      systemPromptFile: options.persona ? systemPromptFile : undefined,
      workingDirectory: agentWorkDir,
      extraArgs: options.extraCliArgs,
      skipArgValidation: options.skipArgValidation,
    });

    // 3c. Apply autonomy level flags
    const effectiveAutonomy = options.autonomyLevel ?? AutonomyLevel.AutoApply;
    if (effectiveAutonomy === AutonomyLevel.FullAuto) {
      // Full auto: skip all permission prompts
      if (options.provider.id === "claude-code" && !command.includes("--dangerously-skip-permissions")) {
        command.push("--dangerously-skip-permissions");
      } else if (options.provider.id === "aider" && !command.includes("--yes")) {
        command.push("--yes");
      } else if (options.provider.id === "kiro" && !command.includes("--trust-all-tools")) {
        command.push("--trust-all-tools");
      }
    }

    // 3d. Append MCP config and pre-approve tools for MCP-capable providers
    if (options.provider.supportsMcp) {
      if (mcpConfigPath && effectiveMessagingMode === "mcp") {
        // Provider-specific MCP config flag
        if (options.provider.id === "kiro") {
          // Kiro uses its own MCP config management — we'll set it up via kiro-cli mcp add before spawning
          // For now, trust tools via --trust-tools
        } else {
          // Claude Code and others use --mcp-config
          command.push("--mcp-config", mcpConfigPath);
        }

        // Build list of pre-approved tools (provider-specific names)
        const isKiro = options.provider.id === "kiro";

        if (isKiro) {
          // Kiro: --trust-tools accepts only: read, write, shell as built-in names.
          // MCP tools use @server/tool format. For FullAuto we already pass
          // --trust-all-tools so no need for --trust-tools at all.
          if (effectiveAutonomy < AutonomyLevel.FullAuto) {
            const kiroTools: string[] = ["read"];
            // MCP tools with @kora/ prefix
            const mcpToolNames = [
              "send_message", "check_messages", "list_agents", "broadcast",
              "list_tasks", "update_task", "create_task",
              "peek_agent", "nudge_agent",
              "report_idle", "request_task",
              "list_personas", "save_persona",
            ];
            kiroTools.push(...mcpToolNames.map(t => `@kora/${t}`));
            if (effectiveAutonomy >= AutonomyLevel.AutoApply) {
              kiroTools.push("write", "shell");
            }
            if (options.role === "master") {
              kiroTools.push("@kora/spawn_agent", "@kora/remove_agent");
            }
            command.push(`--trust-tools=${kiroTools.join(",")}`);
          }
          // FullAuto: --trust-all-tools already added in step 3c, no --trust-tools needed
        } else {
          // Claude Code: --allowedTools with space-separated tool names
          const approvedTools: string[] = [
            "Read", "Glob", "Grep", "LS",
            "mcp__kora__send_message", "mcp__kora__check_messages",
            "mcp__kora__list_agents", "mcp__kora__broadcast",
            "mcp__kora__list_tasks", "mcp__kora__update_task", "mcp__kora__create_task",
            "mcp__kora__peek_agent", "mcp__kora__nudge_agent",
            "mcp__kora__report_idle", "mcp__kora__request_task",
            "mcp__kora__list_personas", "mcp__kora__save_persona",
          ];
          if (effectiveAutonomy >= AutonomyLevel.AutoApply) {
            approvedTools.push("Edit", "Write", "Bash");
          }
          if (options.role === "master") {
            approvedTools.push("mcp__kora__spawn_agent", "mcp__kora__remove_agent");
          }
          command.push("--allowedTools", ...approvedTools);
        }
      } else if (options.provider.id === "kiro") {
        // Kiro in non-MCP mode (CLI mode): needs read + write + shell to run kora-cli.
        // Kiro has no Bash tool — shell trust is required for ANY command execution.
        const kiroCliTools = ["read", "write", "shell"];
        command.push(`--trust-tools=${kiroCliTools.join(",")}`);
      } else {
        // Claude Code in non-MCP modes: only pre-approve read operations
        command.push(
          "--allowedTools",
          "Read",
          "Glob",
          "Grep",
          "LS",
        );
      }
    }

    // 4. Create tmux session
    await this.tmux.newSession(tmuxSession);

    // 5. Wait for shell to be ready by polling capturePane for a prompt character
    const maxWait = 3000; // 3 seconds max (fresh shells start fast)
    const pollInterval = 200; // check every 200ms
    let startTime = Date.now();
    while (Date.now() - startTime < maxWait) {
      const output = await this.tmux.capturePane(tmuxSession, 5, false);
      const lines = output.trim().split('\n').filter(l => l.trim());
      const lastLine = lines[lines.length - 1] || '';
      if (lastLine.match(/[$%>#]\s*$/)) break;
      await new Promise(r => setTimeout(r, pollInterval));
    }

    // 5b. For Kiro: write workspace MCP config directly to <worktree>/.kiro/settings/mcp.json
    // All Kiro agents (built-in and custom) have includeMcpJson: true by default,
    // so they automatically load MCP servers from the workspace config.
    // This gives per-agent isolation (each worktree has its own config)
    // and works with any agent (kiro_planner, kiro_help, custom agents).
    if (options.provider.id === "kiro" && mcpConfigPath) {
      try {
        const mcpConfig = JSON.parse(readFileSync(mcpConfigPath, "utf-8"));
        const serverConfig = mcpConfig?.mcpServers?.kora || mcpConfig?.mcpServers?.[MCP_SERVER_NAME];
        if (serverConfig) {
          // For Kiro, write workspace MCP config to a per-agent directory.
          // In isolated mode, agentWorkDir is already unique per agent (git worktree).
          // In shared mode, agentWorkDir is the project root (shared by all agents),
          // so we use a per-agent subdirectory under runtimeDir to avoid overwrites.
          const kiroWorkspaceRoot = agentWorkDir === options.workingDirectory
            ? path.join(options.runtimeDir, "kiro-workspaces", agentId)  // shared: use per-agent dir
            : agentWorkDir;                                                // isolated: worktree is already unique
          const kiroSettingsDir = path.join(kiroWorkspaceRoot, ".kiro", "settings");
          await fs.mkdir(kiroSettingsDir, { recursive: true });
          const kiroMcpConfig = {
            mcpServers: {
              kora: {
                command: serverConfig.command,
                args: serverConfig.args || [],
              },
            },
          };
          await fs.writeFile(
            path.join(kiroSettingsDir, "mcp.json"),
            JSON.stringify(kiroMcpConfig, null, 2),
            "utf-8"
          );
          // Store the Kiro workspace root so we cd there before starting chat
          options._kiroWorkspaceRoot = kiroWorkspaceRoot;
          logger.info(`[agent-manager] Wrote Kiro workspace MCP config for ${agentId} at ${kiroSettingsDir}/mcp.json`);
        }
      } catch (err) {
        logger.warn({ err }, `[agent-manager] Failed to write Kiro MCP config for ${agentId}`);
      }
    }

    // 6. Set environment variables via export commands (works for both tmux and holdpty)
    const envEntries: [string, string][] = [];
    if (options.envVars) {
      envEntries.push(...Object.entries(options.envVars));
    }
    // Always set KORA_* env vars so agents (MCP and non-MCP) can access daemon
    envEntries.push(["KORA_AGENT_ID", agentId]);
    envEntries.push(["KORA_SESSION_ID", options.sessionId]);
    try {
      const os = await import("os");
      const isDev = process.env.KORA_DEV === "1";
      const cfgDir = process.env.KORA_CONFIG_DIR || path.join(os.default.homedir(), isDev ? ".kora-dev" : ".kora");
      try { const port = (await fs.readFile(path.join(cfgDir, "daemon.port"), "utf-8")).trim(); envEntries.push(["KORA_DAEMON_URL", `http://localhost:${port}`]); } catch { envEntries.push(["KORA_DAEMON_URL", `http://localhost:${isDev ? 7891 : 7890}`]); }
      // KORA_TOKEN intentionally NOT exported to agent env — prevents direct API curl
      // kora-cli and MCP server read token from ~/.kora[-dev]/daemon.token file
    } catch { /* non-fatal */ }
    if (process.env.KORA_DEV === "1") {
      envEntries.push(["KORA_DEV", "1"]);
    }
    if (process.env.KORA_CONFIG_DIR) {
      envEntries.push(["KORA_CONFIG_DIR", process.env.KORA_CONFIG_DIR]);
    }
    // Add monorepo root node_modules/.bin to PATH so `kora-cli` is accessible from agent terminals
    // __dirname at runtime = packages/daemon/dist/core/ → go up 4 levels to monorepo root
    // PATH is handled separately since $PATH must expand in the shell (can't use single quotes)
    const daemonBinDir = path.resolve(__dirname, "../../../../node_modules/.bin");

    // Export env vars individually to avoid terminal line buffer truncation.
    // Single long export lines can exceed terminal width and get corrupted.
    if (envEntries.length > 0) {
      const escapeValue = (v: string) => v.replace(/'/g, "'\\''");
      for (const [k, v] of envEntries) {
        await this.tmux.sendKeys(tmuxSession, `export ${k}='${escapeValue(v)}'`, { literal: false });
      }
      await new Promise(r => setTimeout(r, 300)); // brief pause for shell to process all exports
    }
    // PATH uses double quotes so $PATH expands in the shell
    await this.tmux.sendKeys(tmuxSession, `export PATH="${daemonBinDir}:$PATH"`, { literal: false });
    await new Promise(r => setTimeout(r, 100));

    // 7. cd to workingDirectory (use worktree if available)
    // For Kiro: cd to the Kiro workspace root so it loads the per-agent .kiro/settings/mcp.json
    const cdTarget = options._kiroWorkspaceRoot || agentWorkDir;
    await this.tmux.sendKeys(tmuxSession, `cd ${cdTarget}`, { literal: false });

    // Wait for cd to complete — poll for prompt to reappear
    startTime = Date.now();
    while (Date.now() - startTime < maxWait) {
      const output = await this.tmux.capturePane(tmuxSession, 5, false);
      const lines = output.trim().split('\n').filter(l => l.trim());
      const lastLine = lines[lines.length - 1] || '';
      if (lastLine.match(/[$%>#]\s*$/)) break;
      await new Promise(r => setTimeout(r, pollInterval));
    }

    // 8. Send the command to tmux via sendKeys (join args with spaces)
    const fullCommand = command.join(" ");
    logger.info(`[agent-manager] Sending CLI command for ${agentId}: ${command[0]} (${command.length} args)`);
    await this.tmux.sendKeys(tmuxSession, fullCommand, { literal: false });

    // 8b. Fire-and-forget verification: after a delay, check if the CLI command
    //     actually reached the terminal. If sendKeys failed silently (e.g. holdpty
    //     socket race), retry once. This runs async to avoid blocking spawn.
    //     Skip for providers that launch interactive UIs quickly (Kiro) — their
    //     output won't contain the binary name, causing false-positive retries.
    const skipRetryProviders = ["kiro"];
    if (!skipRetryProviders.includes(options.provider.id)) {
      setTimeout(async () => {
        try {
          const verifyOutput = await this.tmux.capturePane(tmuxSession, 10, false);
          const cliBinary = command[0]; // e.g. "claude", "aider", "codex"
          // Only retry if we got real terminal output but the command is missing
          if (verifyOutput.length > 20 && !verifyOutput.includes(cliBinary)) {
            logger.warn(`[agent-manager] CLI command not detected in terminal for ${agentId}, retrying sendKeys...`);
            await new Promise(r => setTimeout(r, 800));
            await this.tmux.sendKeys(tmuxSession, fullCommand, { literal: false });
          }
        } catch {
          // capturePane may fail for mock backends — skip verification
        }
      }, 1500);
    }

    // 9. If initialTask, wait 5 seconds then send it via sendKeys
    //    (Claude Code needs time to fully start up)
    if (options.initialTask) {
      await new Promise((resolve) => setTimeout(resolve, 5000));
      await this.tmux.sendKeys(tmuxSession, options.initialTask, { literal: true });
    }

    // 10. Start health monitoring
    this.healthMonitor.startMonitoring(agentId, tmuxSession);

    // 11. Start pipe-pane for terminal streaming
    await this.tmux.pipePaneStart(tmuxSession, path.join(options.runtimeDir, `${agentId}.log`));

    // 12. Create AgentState, store in map
    const permissions: AgentPermissions = options.role === "master"
      ? { ...DEFAULT_MASTER_PERMISSIONS }
      : { ...DEFAULT_WORKER_PERMISSIONS };

    const now = new Date().toISOString();

    const agentState: AgentState = {
      id: agentId,
      sessionId: options.sessionId,
      config: {
        id: agentId,
        sessionId: options.sessionId,
        name: options.name,
        role: options.role,
        model: options.model,
        cliProvider: options.provider.id,
        persona: options.persona ?? "",
        workingDirectory: agentWorkDir,
        projectPath: options.workingDirectory,
        tmuxSession,
        autonomyLevel: options.autonomyLevel ?? AutonomyLevel.AutoApply,
        permissions,
        spawnedBy: options.spawnedBy ?? "",
        restartPolicy: "on-crash",
        maxRestarts: DEFAULT_MAX_RESTARTS,
        extraCliArgs: options.extraCliArgs,
        envVars: options.envVars,
        skills: detectAgentSkills({ persona: options.persona, name: options.name, role: options.role }),
      },
      status: "running",
      activity: "working",
      output: [],
      childAgents: [],
      startedAt: now,
      lastActivityAt: now,
      lastOutputAt: now,
      healthCheck: {
        lastPingAt: now,
        consecutiveFailures: 0,
        restartCount: 0,
      },
      cost: { totalTokensIn: 0, totalTokensOut: 0, totalCostUsd: 0, lastUpdatedAt: now },
    };

    // Auto-assign channels based on role and name
    const autoChannels: string[] = ["#all"];
    if (options.role === "master") {
      autoChannels.push("#orchestration");
    }
    const nameChannel = `#${slugify(options.name)}`;
    autoChannels.push(nameChannel);
    agentState.config.channels = autoChannels;

    this.agents.set(agentId, agentState);

    // 13. Emit "agent-spawned"
    this.emit("agent-spawned", agentState);

    return agentState;
  }

  /** Stop an agent gracefully */
  async stopAgent(agentId: string, reason: string, timeoutMs?: number, opts?: { skipWorktreeRemoval?: boolean }): Promise<void> {
    const agent = this.agents.get(agentId);
    if (!agent) throw new Error(`Agent ${agentId} not found`);

    const tmuxSession = agent.config.tmuxSession;

    // 1. Stop health monitoring
    this.healthMonitor.stopMonitoring(agentId);

    // 2. Gracefully stop tmux/holdpty session
    const sessionExists = await this.tmux.hasSession(tmuxSession);
    if (sessionExists) {
      try { await this.tmux.pipePaneStop(tmuxSession); } catch {}

      try { await this.tmux.sendKeys(tmuxSession, "/exit", { literal: false }); } catch {}

      // Wait up to timeout for exit
      const deadline = Date.now() + (timeoutMs ?? GRACEFUL_SHUTDOWN_TIMEOUT_MS);
      while (Date.now() < deadline) {
        const alive = await this.tmux.hasSession(tmuxSession);
        if (!alive) break;
        await new Promise((resolve) => setTimeout(resolve, 500));
      }
    }

    // 3. Always call killSession to clean up socket/metadata files
    // Even if session is already dead, HoldptyController.killSession()
    // cleans up orphaned socket + metadata files on disk.
    try { await this.tmux.killSession(tmuxSession); } catch {}

    // 6. Clean up git worktree (if one was created for this agent)
    if (!opts?.skipWorktreeRemoval) {
      const wtInfo = this.worktreeInfo.get(agentId);
      if (wtInfo) {
        try {
          await this.worktreeManager.removeWorktree(wtInfo.projectPath, wtInfo.runtimeDir, agentId);
        } catch (err) {
          logger.error({ err: err }, `[agent-manager] Failed to remove worktree for ${agentId}:`);
        }
        this.worktreeInfo.delete(agentId);
      } else {
        // Fallback: worktreeInfo may be empty after daemon restart.
        // Try to remove worktree using the agent's working directory as a hint.
        const agent = this.agents.get(agentId);
        if (agent?.config.workingDirectory) {
          const workDir = agent.config.workingDirectory;
          // Check if workingDirectory is under a worktrees/ directory
          if (workDir.includes("/worktrees/")) {
            const runtimeDir = workDir.substring(0, workDir.indexOf("/worktrees/"));
            // Find the project root by going up from runtimeDir
            // runtimeDir is typically {project}/.kora/sessions/{sessionId}
            // projectPath is typically 3-4 levels up, but we can use git rev-parse
            try {
              const { execFile: execFileCb } = await import("child_process");
              const { promisify } = await import("util");
              const exec = promisify(execFileCb);
              const { stdout } = await exec("git", ["rev-parse", "--show-toplevel"], { cwd: workDir });
              const projectPath = stdout.trim();
              await this.worktreeManager.removeWorktree(projectPath, runtimeDir, agentId);
              logger.info(`[agent-manager] Removed worktree for ${agentId} via fallback path detection`);
            } catch (err) {
              logger.debug({ err }, `[agent-manager] Fallback worktree removal failed for ${agentId}`);
            }
          }
        }
      }
    } else {
      logger.info(`[agent-manager] Preserving worktree for ${agentId} (restart mode)`);
    }

    // 7. Remove from agents map
    this.agents.delete(agentId);

    // 8. Emit "agent-removed"
    this.emit("agent-removed", agentId, reason);
  }

  /** Handle agent crash (called by health monitor) */
  private async handleAgentCrash(agentId: string): Promise<void> {
    const agent = this.agents.get(agentId);
    if (!agent) return;

    // 1. Mark status as "crashed"
    agent.status = "crashed";

    // 2. Check restart policy and restart count
    const maxRestarts = DEFAULT_MAX_RESTARTS;

    // 3. If should restart: re-spawn, increment restartCount, emit "agent-restarted"
    if (agent.healthCheck.restartCount < maxRestarts) {
      agent.healthCheck.restartCount += 1;
      agent.status = "running";

      // Re-create the tmux session and restart the agent process
      const tmuxSession = agent.config.tmuxSession;
      await this.tmux.newSession(tmuxSession);
      // Re-launch requires a resolved CLIProvider; emit event so the caller can handle it
      await this.tmux.sendKeys(tmuxSession, `cd ${agent.config.workingDirectory}`, { literal: false });
      this.healthMonitor.startMonitoring(agentId, tmuxSession);

      this.emit("agent-restarted", agentId, agent.healthCheck.restartCount);
    } else {
      // 4. If max restarts exceeded: emit "agent-crashed", leave as crashed
      this.healthMonitor.stopMonitoring(agentId);
      this.emit("agent-crashed", agentId);
    }
  }

  /** Send a message to an agent via tmux send-keys */
  async sendMessage(agentId: string, message: string): Promise<void> {
    const agent = this.agents.get(agentId);
    if (!agent) throw new Error(`Agent ${agentId} not found`);
    const tmuxSession = agent.config.tmuxSession;
    await this.tmux.sendKeys(tmuxSession, message, { literal: false });
  }

  /** Change agent model (restarts the agent) */
  async changeModel(agentId: string, model: string, provider: CLIProvider): Promise<void> {
    const agent = this.agents.get(agentId);
    if (!agent) throw new Error(`Agent ${agentId} not found`);

    // If provider supports hot swap, use it. Otherwise, restart.
    if (provider.supportsHotModelSwap) {
      await this.tmux.sendKeys(agent.config.tmuxSession, provider.buildModelSwapCommand!(model), { literal: false });
      agent.config.model = model;
      agent.config.cliProvider = provider.id;
    } else {
      const options: SpawnAgentOptions = {
        sessionId: agent.config.tmuxSession.replace(getRuntimeTmuxPrefix(process.env.KORA_DEV === "1"), "").split("-").slice(0, -1).join("-"),
        name: agent.config.name,
        role: agent.config.role,
        provider,
        model,
        persona: agent.config.persona,
        workingDirectory: agent.config.workingDirectory,
        runtimeDir: path.dirname(agent.config.tmuxSession), // will be overridden
        autonomyLevel: agent.config.autonomyLevel,
      };
      await this.stopAgent(agentId, "model change");
      await this.spawnAgent(options);
    }
  }

  /** Get agent state */
  getAgent(agentId: string): AgentState | undefined {
    return this.agents.get(agentId);
  }

  /** List all agents */
  listAgents(): AgentState[] {
    return [...this.agents.values()];
  }

  /** Get the internal agents map (for health monitor) */
  getAgentsMap(): Map<string, AgentState> {
    return this.agents;
  }

  /**
   * Mark agent as idle from MCP signal (Layer 1 — highest confidence).
   * Called when agent uses report_idle tool or sends a completion message.
   * Protected from terminal polling override for 2 minutes.
   */
  markIdleFromMcp(agentId: string, reason?: string): void {
    this.healthMonitor.markIdleFromMcp(agentId, reason);
  }

  /**
   * Clear MCP idle protection for an agent. Called when a user explicitly
   * sends a message to the agent — the agent is about to receive new work,
   * so terminal polling should detect the activity transition.
   */
  clearIdleProtection(agentId: string): void {
    this.healthMonitor.clearIdleProtection(agentId);
  }

  /**
   * Record that an agent made an MCP tool call (read file, send message, etc.)
   * Prevents premature idle detection while agent is actively using tools.
   */
  recordMcpCall(agentId: string, toolName?: string): void {
    this.healthMonitor.recordMcpCall(agentId, toolName);
  }

  /**
   * Restore an agent from persisted state — re-registers without spawning tmux.
   * Used after daemon restart to reconnect to still-running tmux sessions.
   */
  restoreAgent(agent: AgentState): void {
    this.agents.set(agent.id, agent);
    // Resume health monitoring for this agent
    this.healthMonitor.startMonitoring(agent.id, agent.config.tmuxSession);
  }

  /** Stop all agents */
  async stopAll(): Promise<void> {
    for (const [id] of this.agents) {
      await this.stopAgent(id, "session shutdown");
    }
    // Clean up any remaining worktrees after all agents are stopped
    await this.cleanupWorktrees();
  }

  /**
   * Clean up git worktrees for agents that are no longer running.
   * Also removes orphaned worktree directories that don't match any active agent.
   */
  async cleanupWorktrees(): Promise<void> {
    // Clean up worktrees for agents that are no longer running
    const runningAgentIds = new Set(this.agents.keys());

    for (const [agentId, wtInfo] of this.worktreeInfo.entries()) {
      if (!runningAgentIds.has(agentId)) {
        try {
          await this.worktreeManager.removeWorktree(wtInfo.projectPath, wtInfo.runtimeDir, agentId);
          this.worktreeInfo.delete(agentId);
        } catch (err) {
          logger.error({ err: err }, `[agent-manager] Failed to cleanup worktree for ${agentId}:`);
        }
      }
    }

    // Check for orphaned worktree directories
    // Get a runtimeDir from any worktree info entry, or skip if none exist
    if (this.worktreeInfo.size === 0) return;

    const firstWtInfo = this.worktreeInfo.values().next().value;
    if (!firstWtInfo) return;

    const worktreesDir = path.join(firstWtInfo.runtimeDir, "worktrees");

    try {
      const entries = await fs.readdir(worktreesDir, { withFileTypes: true });

      for (const entry of entries) {
        if (entry.isDirectory()) {
          const dirName = entry.name;
          // Check if this directory matches any active agent
          const hasActiveAgent = Array.from(runningAgentIds).some(agentId =>
            dirName.includes(agentId) || agentId.includes(dirName)
          );

          if (!hasActiveAgent) {
            // Orphaned directory - remove it
            const orphanedPath = path.join(worktreesDir, dirName);
            try {
              await fs.rm(orphanedPath, { recursive: true, force: true });
              logger.info(`[agent-manager] Removed orphaned worktree directory: ${orphanedPath}`);
            } catch (err) {
              logger.error({ err: err }, `[agent-manager] Failed to remove orphaned worktree directory ${orphanedPath}:`);
            }
          }
        }
      }
    } catch (err) {
      // Directory might not exist, which is fine
      if ((err as any).code !== 'ENOENT') {
        logger.error({ err: err }, `[agent-manager] Failed to scan worktrees directory:`);
      }
    }
  }
}
