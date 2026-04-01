import { randomUUID } from "crypto";
import type { RouteDeps, Router, Request, Response } from "./route-deps.js";
import type { ProviderResponse } from "@kora/shared";
import { DEFAULT_MASTER_PERMISSIONS, DEFAULT_WORKER_PERMISSIONS } from "@kora/shared";
import { listPlaybooks, loadPlaybook, savePlaybook } from "../../core/playbook-loader.js";
import { validateYAMLPlaybook } from "../../core/playbook-validator.js";
import { buildPersona } from "../../core/persona-builder.js";
import { discoverModels } from "../../core/model-discovery.js";
import * as cronScheduler from "../../core/cron-scheduler.js";
import { logger } from "../../core/logger.js";

export function registerMiscRoutes(router: Router, deps: RouteDeps): void {
  const { sessionManager, orchestrators, providerRegistry, globalConfigDir, suggestionsDb, playbookDb, broadcastEvent } = deps;

  function getDb(sid: string) {
    const orch = orchestrators.get(sid);
    return orch?.database || null;
  }

  function getAnyDb() {
    const firstOrch = Array.from(orchestrators.values())[0];
    return firstOrch?.database;
  }

  // ─── Providers ───────────────────────────────────────────────────────

  router.get("/providers", (_req: Request, res: Response) => {
    try {
      const providers = providerRegistry.list();
      const response: ProviderResponse[] = providers.map((p) => ({
        id: p.id,
        displayName: p.displayName,
        models: p.getModels(),
        supportsHotModelSwap: p.supportsHotModelSwap,
      }));
      res.json({ providers: response });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      res.status(500).json({ error: message });
    }
  });

  router.get("/providers/:pid/models", (req: Request, res: Response) => {
    try {
      const pid = String(req.params.pid);
      const provider = providerRegistry.get(pid);
      if (!provider) {
        res.status(404).json({ error: `Provider "${pid}" not found` });
        return;
      }

      const builtInModels = provider.getModels();

      // If sessionId query param is provided, merge custom models from that session
      const sessionId = req.query.sessionId ? String(req.query.sessionId) : undefined;
      if (sessionId) {
        const session = sessionManager.getSession(sessionId);
        if (session) {
          const customModels = (session.config.customModels?.[pid] ?? []).map((m) => ({
            id: m.id,
            label: m.label,
            tier: "balanced" as const,
            custom: true as const,
          }));
          res.json({ models: [...builtInModels.map((m) => ({ ...m, custom: false })), ...customModels] });
          return;
        }
      }

      res.json({ models: builtInModels });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      res.status(500).json({ error: message });
    }
  });

  router.get("/providers/:pid/discover", async (req: Request, res: Response) => {
    try {
      const pid = String(req.params.pid);
      const provider = providerRegistry.get(pid);
      if (!provider) {
        res.status(404).json({ error: `Provider "${pid}" not found` });
        return;
      }

      const builtInModels = provider.getModels();
      const discoveredModels = await discoverModels(pid);

      res.json({ discoveredModels, builtInModels });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      res.status(500).json({ error: message });
    }
  });

  // ─── Playbooks ──────────────────────────────────────────────────────

  // GET /playbooks - list all playbook names
  router.get("/playbooks", async (req: Request, res: Response) => {
    try {
      const limit = req.query.limit ? Number(req.query.limit) : 100;
      const offset = req.query.offset ? Number(req.query.offset) : 0;

      const playbooks = playbookDb.listPlaybooks({ limit, offset });

      // Return just the names (frontend expects { playbooks: string[] })
      const names = playbooks.map(pb => pb.name);

      res.json({
        playbooks: names,
      });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      res.status(500).json({ error: message });
    }
  });

  // GET /playbooks/:id - get single playbook (supports ID or name)
  router.get("/playbooks/:id", async (req: Request, res: Response) => {
    try {
      const id = String(req.params.id);

      // Try to find by ID first, then by name
      let playbook = playbookDb.getPlaybook(id);
      if (!playbook) {
        playbook = playbookDb.getPlaybookByName(id);
      }

      if (!playbook) {
        res.status(404).json({ error: `Playbook "${id}" not found` });
        return;
      }

      // Parse the YAML content and return the parsed object
      const validation = validateYAMLPlaybook(playbook.yamlContent);
      if (!validation.valid || !validation.parsed) {
        res.status(500).json({
          error: "Failed to parse playbook YAML",
          details: validation.errors,
        });
        return;
      }

      // Return parsed playbook with metadata
      res.json({
        ...validation.parsed,
        id: playbook.id,
        source: "global",
      });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      res.status(500).json({ error: message });
    }
  });

  // POST /playbooks - upload/import YAML playbook
  router.post("/playbooks", async (req: Request, res: Response) => {
    try {
      const yamlContent = typeof req.body === "string" ? req.body : req.body.yaml;

      if (!yamlContent || typeof yamlContent !== "string") {
        res.status(400).json({ error: "YAML content is required (send as string or { yaml: '...' })" });
        return;
      }

      // Validate YAML
      const validation = validateYAMLPlaybook(yamlContent);
      if (!validation.valid) {
        res.status(400).json({
          error: "Playbook validation failed",
          errors: validation.errors,
          warnings: validation.warnings,
        });
        return;
      }

      // Check for duplicate name (advisory check - UNIQUE constraint is the source of truth)
      const existing = playbookDb.getPlaybookByName(validation.parsed.name);
      if (existing) {
        res.status(409).json({ error: `Playbook with name "${validation.parsed.name}" already exists` });
        return;
      }

      // Save to database with UNIQUE constraint protection
      const id = randomUUID();
      const now = new Date().toISOString();
      try {
        playbookDb.insertPlaybook({
          id,
          name: validation.parsed.name,
          description: validation.parsed.description || "",
          yamlContent,
          createdAt: now,
          updatedAt: now,
        });
      } catch (insertErr) {
        // Handle SQLite UNIQUE constraint violation (race condition)
        const errMsg = insertErr instanceof Error ? insertErr.message : String(insertErr);
        if (errMsg.includes("UNIQUE") || errMsg.includes("unique")) {
          res.status(409).json({ error: `Playbook with name "${validation.parsed.name}" already exists` });
          return;
        }
        throw insertErr; // Re-throw other errors
      }

      const saved = playbookDb.getPlaybook(id);
      res.status(201).json({
        ...saved,
        warnings: validation.warnings,
      });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      res.status(500).json({ error: message });
    }
  });

  // DELETE /playbooks/:id - delete playbook
  router.delete("/playbooks/:id", async (req: Request, res: Response) => {
    try {
      const id = String(req.params.id);
      const deleted = playbookDb.deletePlaybook(id);
      if (!deleted) {
        res.status(404).json({ error: `Playbook "${id}" not found` });
        return;
      }
      res.json({ success: true });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      res.status(500).json({ error: message });
    }
  });

  // POST /playbooks/:id/run - execute playbook (spawn agents)
  router.post("/playbooks/:id/run", async (req: Request, res: Response) => {
    try {
      const playbookId = String(req.params.id);
      const { sessionId, task, variables = {}, dryRun } = req.body as {
        sessionId: string;
        task?: string;
        variables?: Record<string, string>;
        dryRun?: boolean;
      };

      if (!sessionId) {
        res.status(400).json({ error: "sessionId is required" });
        return;
      }

      const session = sessionManager.getSession(sessionId);
      if (!session) {
        res.status(404).json({ error: `Session "${sessionId}" not found` });
        return;
      }

      const orch = orchestrators.get(sessionId);
      if (!orch) {
        res.status(500).json({ error: `No orchestrator for session "${sessionId}"` });
        return;
      }

      const playbook = await loadPlaybook(globalConfigDir, playbookId);
      if (!playbook) {
        res.status(404).json({ error: `Playbook "${playbookId}" not found` });
        return;
      }

      const { PlaybookExecutor } = await import("../../core/playbook-executor.js");
      const executor = new PlaybookExecutor(orch, providerRegistry, session.config, playbook, variables, session.runtimeDir);

      // Phase 1: SETUP (sync — validate, interpolate)
      try {
        const execution = executor.setup();
        if (dryRun) {
          res.json({ dryRun: true, valid: true, plan: execution });
          return;
        }
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        res.status(400).json({ error: msg });
        return;
      }

      // Wire WebSocket events
      executor.on("playbook-progress", (data: any) => broadcastEvent({ event: "playbook-progress", ...data }));
      executor.on("playbook-complete", (data: any) => broadcastEvent({ event: "playbook-complete", ...data }));
      executor.on("playbook-failed", (data: any) => broadcastEvent({ event: "playbook-failed", ...data }));

      // Phase 2+3: EXECUTE + FINALIZE (async, fire-and-forget)
      executor.run(task).catch((err) => {
        logger.error({ err }, "[playbook-run] Execution failed");
      });

      // Return 202 immediately
      res.status(202).json({
        executionId: executor.execution.id,
        status: "running",
        agents: executor.execution.agents,
      });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      res.status(500).json({ error: message });
    }
  });

  // ─── Launch Playbook into Existing Session ─────────────────────────

  router.post("/sessions/:sid/playbook", async (req: Request, res: Response) => {
    try {
      const sid = String(req.params.sid);
      const { playbook: playbookName, task } = req.body as { playbook?: string; task?: string };

      if (!playbookName) {
        res.status(400).json({ error: "playbook name is required" });
        return;
      }

      const session = sessionManager.getSession(sid);
      if (!session) {
        res.status(404).json({ error: `Session "${sid}" not found` });
        return;
      }

      const orch = orchestrators.get(sid);
      const am = orch?.agentManager;
      if (!am) {
        res.status(500).json({ error: `No Orchestrator found for session "${sid}"` });
        return;
      }

      const playbook = await loadPlaybook(globalConfigDir, playbookName);
      if (!playbook) {
        res.status(404).json({ error: `Playbook "${playbookName}" not found` });
        return;
      }

      // Check for name conflicts with existing agents
      const existingNames = new Set(am.listAgents().map(a => a.config.name.toLowerCase()));
      for (const pa of playbook.agents) {
        if (existingNames.has(pa.name.toLowerCase())) {
          res.status(409).json({ error: `Agent name "${pa.name}" conflicts with an existing agent in this session` });
          return;
        }
      }

      // Sort: masters first, then workers
      const sorted = [...playbook.agents].sort((a, b) => {
        if (a.role === "master" && b.role !== "master") return -1;
        if (a.role !== "master" && b.role === "master") return 1;
        return 0;
      });

      const spawned: Array<{ id: string; name: string; role: string; status: string }> = [];
      const executionId = `exec-${Date.now()}`;
      const agentStatuses = sorted.map(pa => ({ name: pa.name, role: pa.role, status: "pending" as string, agentId: undefined as string | undefined, error: undefined as string | undefined }));

      // Emit execution start event
      await orch.eventLog.log({ sessionId: sid, type: "playbook-progress" as any, data: {
        executionId, sessionId: sid, playbookName, phase: "execute",
        agents: agentStatuses, status: "running",
      }});
      broadcastEvent({ event: "playbook-progress", sessionId: sid, executionId, playbookName, phase: "execute", agents: agentStatuses });

      for (const pa of sorted) {
        const providerId = pa.provider ?? session.config.defaultProvider;
        const provider = providerRegistry.get(providerId);
        if (!provider) {
          // Skip agents with unknown providers, but continue spawning others
          continue;
        }

        const permissions = pa.role === "master"
          ? { ...DEFAULT_MASTER_PERMISSIONS }
          : { ...DEFAULT_WORKER_PERMISSIONS };

        const currentAgents = am.listAgents().filter(a => a.status === "running");
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
          sessionId: sid,
          runtimeDir: session.runtimeDir,
          peers,
          projectPath: session.config.projectPath,
          workflowStates: session.config.workflowStates,
          supportsMcp: provider.supportsMcp,
          messagingMode: session.config.messagingMode || "mcp",
          worktreeMode: session.config.worktreeMode,
        });

        // Use the task param as initialTask for the master agent only
        const initialTask = pa.role === "master" && task ? task : pa.initialTask;

        const agentState = await am.spawnAgent({
          sessionId: sid,
          name: pa.name,
          role: pa.role,
          provider,
          model: pa.model,
          persona: fullPersona,
          workingDirectory: session.config.projectPath,
          runtimeDir: session.runtimeDir,
          extraCliArgs: pa.extraCliArgs,
          initialTask,
          messagingMode: session.config.messagingMode || "mcp",
          worktreeMode: session.config.worktreeMode,
        });

        broadcastEvent({ event: "agent-spawned", sessionId: sid, agentId: agentState.id });
        spawned.push({ id: agentState.id, name: pa.name, role: pa.role, status: agentState.status });

        // Update execution progress
        const agentIdx = agentStatuses.findIndex(a => a.name === pa.name);
        if (agentIdx >= 0) {
          agentStatuses[agentIdx].status = "spawned";
          agentStatuses[agentIdx].agentId = agentState.id;
        }
        await orch.eventLog.log({ sessionId: sid, type: "playbook-progress" as any, data: {
          executionId, sessionId: sid, playbookName, phase: "execute",
          agents: agentStatuses, status: "running",
        }});
        broadcastEvent({ event: "playbook-progress", sessionId: sid, executionId, playbookName, agents: agentStatuses });
      }

      // Emit execution complete
      const allSpawned = agentStatuses.every(a => a.status === "spawned");
      const finalStatus = allSpawned ? "complete" : agentStatuses.some(a => a.status === "spawned") ? "partial" : "failed";
      await orch.eventLog.log({ sessionId: sid, type: "playbook-complete" as any, data: {
        executionId, sessionId: sid, playbookName, phase: "finalize",
        agents: agentStatuses, status: finalStatus,
      }});
      broadcastEvent({ event: "playbook-complete", sessionId: sid, executionId, playbookName, agents: agentStatuses, status: finalStatus });

      res.status(201).json({ spawned, total: spawned.length, executionId });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      res.status(500).json({ error: message });
    }
  });

  // ─── Cron Schedules ──────────────────────────────────────────────

  router.get("/schedules", (req: Request, res: Response) => {
    try {
      const schedules = Array.from(orchestrators.values()).flatMap(orch => {
        try { return cronScheduler.listSchedules(orch.database); } catch { return []; }
      });
      // Dedupe by ID
      const seen = new Set<string>();
      const unique = schedules.filter(s => { if (seen.has(s.id)) return false; seen.add(s.id); return true; });
      res.json({ schedules: unique });
    } catch (err) { res.status(500).json({ error: String(err) }); }
  });

  router.post("/schedules", (req: Request, res: Response) => {
    try {
      const { name, cronExpression, timezone, playbookId, sessionConfig } = req.body;
      if (!name || !cronExpression || !sessionConfig) {
        res.status(400).json({ error: "name, cronExpression, and sessionConfig are required" });
        return;
      }

      // Validate cron expression
      const validationError = cronScheduler.validateCronExpression(cronExpression);
      if (validationError) {
        res.status(400).json({ error: validationError });
        return;
      }

      // Get first available DB for storage
      const firstOrch = Array.from(orchestrators.values())[0];
      if (!firstOrch) {
        res.status(400).json({ error: "No active sessions — start a session first" });
        return;
      }

      // Check global limit
      if (!cronScheduler.canAddSchedule(firstOrch.database)) {
        res.status(400).json({ error: "Maximum 5 active schedules reached. Disable or delete existing schedules." });
        return;
      }

      const { randomUUID } = require("crypto");
      const schedule = cronScheduler.createSchedule(firstOrch.database, {
        id: randomUUID().slice(0, 8),
        name, cronExpression, timezone, playbookId, sessionConfig,
      });

      res.status(201).json(schedule);
    } catch (err) { res.status(500).json({ error: String(err) }); }
  });

  router.get("/schedules/:id", (req: Request, res: Response) => {
    try {
      const id = String(req.params.id);
      for (const orch of orchestrators.values()) {
        const schedule = cronScheduler.getSchedule(orch.database, id);
        if (schedule) { res.json(schedule); return; }
      }
      res.status(404).json({ error: "Schedule not found" });
    } catch (err) { res.status(500).json({ error: String(err) }); }
  });

  router.put("/schedules/:id", (req: Request, res: Response) => {
    try {
      const id = String(req.params.id);
      // Validate cron if provided
      if (req.body.cronExpression) {
        const err = cronScheduler.validateCronExpression(req.body.cronExpression);
        if (err) { res.status(400).json({ error: err }); return; }
      }
      for (const orch of orchestrators.values()) {
        if (cronScheduler.updateSchedule(orch.database, id, req.body)) {
          res.json({ updated: true });
          return;
        }
      }
      res.status(404).json({ error: "Schedule not found" });
    } catch (err) { res.status(500).json({ error: String(err) }); }
  });

  router.delete("/schedules/:id", (req: Request, res: Response) => {
    try {
      const id = String(req.params.id);
      for (const orch of orchestrators.values()) {
        if (cronScheduler.deleteSchedule(orch.database, id)) {
          res.json({ deleted: true });
          return;
        }
      }
      res.status(404).json({ error: "Schedule not found" });
    } catch (err) { res.status(500).json({ error: String(err) }); }
  });

  router.post("/schedules/:id/trigger", async (req: Request, res: Response) => {
    try {
      const id = String(req.params.id);
      let schedule: any = null;
      let db: any = null;
      for (const orch of orchestrators.values()) {
        schedule = cronScheduler.getSchedule(orch.database, id);
        if (schedule) { db = orch.database; break; }
      }
      if (!schedule) { res.status(404).json({ error: "Schedule not found" }); return; }

      // Mark as run + update next_run_at
      cronScheduler.markScheduleRun(db, id, schedule.cronExpression, schedule.timezone);

      res.json({ triggered: true, schedule: schedule.name, nextRunAt: cronScheduler.computeNextRun(schedule.cronExpression, schedule.timezone).toISOString() });
    } catch (err) { res.status(500).json({ error: String(err) }); }
  });

  // ─── Orphaned Resource Cleanup ──────────────────────────────────────

  /** List orphaned resources (worktrees, branches, logs) for cleanup UI */
  router.get("/sessions/:sid/orphaned-resources", async (req: Request, res: Response) => {
    try {
      const sid = String(req.params.sid);
      const session = sessionManager.getSession(sid);
      if (!session) { res.status(404).json({ error: "Session not found" }); return; }

      const orch = orchestrators.get(sid);
      const activeIds = new Set(
        orch ? orch.agentManager.listAgents().filter(a => a.status === "running").map(a => a.id) : []
      );

      const orphaned: Array<{ agentId: string; type: string; path?: string }> = [];
      const fsModule = require("fs");
      const pathModule = require("path");

      // Scan worktrees directory
      const worktreesDir = pathModule.join(session.runtimeDir, "worktrees");
      try {
        const entries = fsModule.readdirSync(worktreesDir, { withFileTypes: true });
        for (const entry of entries) {
          if (entry.isDirectory() && !activeIds.has(entry.name)) {
            orphaned.push({ agentId: entry.name, type: "worktree", path: pathModule.join(worktreesDir, entry.name) });
          }
        }
      } catch { /* dir may not exist */ }

      // Scan for stale agent branches
      try {
        const { execFileSync } = require("child_process");
        const stdout = execFileSync("git", ["branch", "--list", "agent/*"], { cwd: session.config.projectPath, encoding: "utf-8" });
        const branches = stdout.split("\n").map((b: string) => b.trim().replace(/^\*\s*/, "")).filter(Boolean);
        for (const branch of branches) {
          const agentId = branch.replace("agent/", "");
          if (!activeIds.has(agentId)) {
            orphaned.push({ agentId, type: "branch" });
          }
        }
      } catch { /* non-fatal */ }

      res.json({ orphaned, activeAgentCount: activeIds.size });
    } catch (err) {
      res.status(500).json({ error: String(err) });
    }
  });

  /** Clean up orphaned resources for specific agent IDs */
  router.post("/sessions/:sid/cleanup", async (req: Request, res: Response) => {
    try {
      const sid = String(req.params.sid);
      const session = sessionManager.getSession(sid);
      if (!session) { res.status(404).json({ error: "Session not found" }); return; }

      const { agentIds } = req.body as { agentIds?: string[] };
      if (!agentIds || !Array.isArray(agentIds) || agentIds.length === 0) {
        res.status(400).json({ error: "agentIds array is required" });
        return;
      }

      const orch = orchestrators.get(sid);
      const activeIds = new Set(
        orch ? orch.agentManager.listAgents().filter(a => a.status === "running").map(a => a.id) : []
      );

      // Safety: never clean up active agents
      const safeIds = agentIds.filter(id => !activeIds.has(id));
      if (safeIds.length === 0) {
        res.status(400).json({ error: "All specified agents are still active" });
        return;
      }

      const { WorktreeManager } = await import("../../core/worktree.js");
      const wm = new WorktreeManager();
      const keepActive = new Set([...activeIds]); // Keep all active + exclude requested
      const result = await wm.pruneAll(session.config.projectPath, session.runtimeDir, keepActive);

      res.json({
        cleaned: safeIds.length,
        removedWorktrees: result.removedWorktrees,
        removedBranches: result.removedBranches,
        skippedDirty: result.skippedDirty,
      });
    } catch (err) {
      res.status(500).json({ error: String(err) });
    }
  });

  // ── Custom Personas CRUD ──────────────────────────────────

  router.get("/personas", (_req: Request, res: Response) => {
    try {
      const personas = suggestionsDb.getPersonas();
      res.json({ personas });
    } catch (err) {
      res.status(500).json({ error: String(err) });
    }
  });

  router.post("/personas", (req: Request, res: Response) => {
    try {
      const { name, description, fullText } = req.body;
      if (!name?.trim() || !fullText?.trim()) {
        res.status(400).json({ error: "name and fullText are required" });
        return;
      }
      const id = `custom-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;
      suggestionsDb.createPersona({ id, name: name.trim(), description: (description || name).trim(), fullText: fullText.trim() });
      res.status(201).json({ id, name: name.trim(), description: (description || name).trim(), fullText: fullText.trim() });
    } catch (err) {
      res.status(500).json({ error: String(err) });
    }
  });

  router.put("/personas/:id", (req: Request, res: Response) => {
    try {
      const id = String(req.params.id);
      const existing = suggestionsDb.getPersona(id);
      if (!existing) {
        res.status(404).json({ error: `Persona "${id}" not found` });
        return;
      }
      const { name, description, fullText } = req.body;
      if (name !== undefined && !name.trim()) {
        res.status(400).json({ error: "name cannot be empty" });
        return;
      }
      if (fullText !== undefined && !fullText.trim()) {
        res.status(400).json({ error: "fullText cannot be empty" });
        return;
      }
      suggestionsDb.updatePersona(id, { name, description, fullText });
      res.json({ updated: true });
    } catch (err) {
      res.status(500).json({ error: String(err) });
    }
  });

  router.delete("/personas/:id", (req: Request, res: Response) => {
    try {
      suggestionsDb.deletePersona(String(req.params.id));
      res.json({ deleted: true });
    } catch (err) {
      res.status(500).json({ error: String(err) });
    }
  });

  // ── Post-Merge Rebase Broadcast ──────────────────────────
  router.post("/sessions/:sid/broadcast-rebase", async (req: Request, res: Response) => {
    try {
      const sid = String(req.params.sid);
      const body = req.body as { prNumber?: number | string; prTitle?: string; message?: string };

      const orch = orchestrators.get(sid);
      if (!orch) {
        res.status(404).json({ error: `Session "${sid}" not found` });
        return;
      }

      const prInfo = body.prNumber ? `PR #${body.prNumber}${body.prTitle ? ` (${body.prTitle})` : ""}` : "A PR";
      const rebaseMsg = body.message ||
        `${prInfo} merged into main. Please rebase your branch NOW:\n` +
        `git fetch origin main && git rebase origin/main`;

      const broadcastMsg = `\x1b[1;33m[System]\x1b[0m: ${rebaseMsg}`;
      const agents = orch.agentManager.listAgents().filter((a) => a.status === "running");
      const results: Array<{ agentId: string; name: string; sent: boolean }> = [];

      // Batch enqueue all, then flush once
      for (const agent of agents) {
        try {
          orch.messageQueue.enqueueBatch(agent.id, agent.config.terminalSession, broadcastMsg);
          results.push({ agentId: agent.id, name: agent.config.name, sent: true });
        } catch {
          results.push({ agentId: agent.id, name: agent.config.name, sent: false });
        }
      }
      orch.messageQueue.flushQueues();

      // Log event (reuse orchestrator's event log to avoid duplicate DB connections)
      if (orch) {
        await orch.eventLog.log({
          sessionId: sid,
          type: "message-sent" as any,
          data: {
            from: "system",
            fromName: "System",
            to: "all",
            toName: "All Agents",
            content: rebaseMsg.substring(0, 200),
            broadcast: true,
            messageType: "rebase-reminder",
            prNumber: body.prNumber,
            prTitle: body.prTitle,
          },
        });
      }

      logger.info({ sid, prNumber: body.prNumber, agentCount: results.length }, "[api] POST broadcast-rebase");
      res.json({ broadcast: true, prNumber: body.prNumber, sentTo: results.length, results });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      logger.error({ err }, "[api] POST broadcast-rebase error");
      res.status(500).json({ error: message });
    }
  });

  // ─── Webhooks ─────────────────────────────────────────────────

  router.get("/webhooks", (_req: Request, res: Response) => {
    try {
      const db = getAnyDb();
      if (!db) { res.json({ webhooks: [] }); return; }
      const webhooks = db.getWebhooks();
      // Include recent events for each webhook
      const result = webhooks.map((wh: any) => ({
        ...wh, recentEvents: db.getWebhookEvents(wh.id, 5),
      }));
      res.json({ webhooks: result });
    } catch (err) { res.status(500).json({ error: String(err) }); }
  });

  router.post("/webhooks", (req: Request, res: Response) => {
    try {
      const db = getAnyDb();
      if (!db) { res.status(400).json({ error: "No active sessions" }); return; }
      const { name, sessionConfig } = req.body;
      if (!name) { res.status(400).json({ error: "name is required" }); return; }
      const { randomUUID, createHash } = require("crypto");
      const id = randomUUID().slice(0, 8);
      const secret = createHash("sha256").update(randomUUID()).digest("hex").slice(0, 32);
      db.insertWebhook({ id, name, secret, sessionConfig });
      res.status(201).json(db.getWebhook(id));
    } catch (err) { res.status(500).json({ error: String(err) }); }
  });

  router.put("/webhooks/:id", (req: Request, res: Response) => {
    try {
      const db = getAnyDb();
      if (!db) { res.status(404).json({ error: "No active sessions" }); return; }
      const wh = db.updateWebhook(String(req.params.id), req.body);
      if (!wh) { res.status(404).json({ error: "Webhook not found" }); return; }
      res.json(wh);
    } catch (err) { res.status(500).json({ error: String(err) }); }
  });

  router.delete("/webhooks/:id", (req: Request, res: Response) => {
    try {
      const db = getAnyDb();
      if (!db) { res.status(404).json({ error: "No active sessions" }); return; }
      const deleted = db.deleteWebhook(String(req.params.id));
      res.json({ deleted });
    } catch (err) { res.status(500).json({ error: String(err) }); }
  });

  // Webhook trigger — verify HMAC-SHA256, dedup, spawn session
  router.post("/webhooks/:id/trigger", async (req: Request, res: Response) => {
    try {
      const db = getAnyDb();
      if (!db) { res.status(400).json({ error: "No active sessions" }); return; }

      const wh = db.getWebhook(String(req.params.id));
      if (!wh) { res.status(404).json({ error: "Webhook not found" }); return; }
      if (!wh.enabled) { res.status(403).json({ error: "Webhook is disabled" }); return; }

      // Verify HMAC-SHA256 signature (timing-safe comparison)
      const { createHmac, createHash, randomUUID, timingSafeEqual } = require("crypto");
      const signature = req.headers["x-webhook-signature"] || req.headers["x-hub-signature-256"] || "";
      const body = JSON.stringify(req.body);
      const expected = "sha256=" + createHmac("sha256", wh.secret).update(body).digest("hex");
      if (!signature || typeof signature !== "string" || signature.length !== expected.length ||
          !timingSafeEqual(Buffer.from(signature), Buffer.from(expected))) {
        res.status(401).json({ error: "Invalid or missing signature" });
        return;
      }

      // Dedup: skip if same payload within 60s
      const payloadHash = createHash("sha256").update(body).digest("hex").slice(0, 16);
      if (db.isWebhookDuplicate(wh.id, payloadHash)) {
        res.json({ skipped: true, reason: "Duplicate payload within 60s" });
        return;
      }

      // Template variables: {{repo}}, {{branch}}, {{actor}}
      const payload = req.body || {};
      let sessionName = wh.name || "Webhook Session";
      sessionName = sessionName.replace(/\{\{repo\}\}/g, payload.repository?.name || payload.repo || "repo");
      sessionName = sessionName.replace(/\{\{branch\}\}/g, payload.ref?.replace("refs/heads/", "") || payload.branch || "main");
      sessionName = sessionName.replace(/\{\{actor\}\}/g, payload.sender?.login || payload.actor || "webhook");

      // Record event
      const eventId = randomUUID().slice(0, 8);
      db.insertWebhookEvent({ id: eventId, webhookId: wh.id, payloadHash, status: "triggered" });

      res.json({ triggered: true, eventId, sessionName, webhookId: wh.id });
    } catch (err) { res.status(500).json({ error: String(err) }); }
  });

  // ── Global Knowledge Store ──────────────────────────────────

  router.post("/global/knowledge", (req: Request, res: Response) => {
    try {
      const { getGlobalKnowledgeDB } = require("../../core/global-knowledge.js");
      const globalDb = getGlobalKnowledgeDB(globalConfigDir);
      const { key, value, sourceSession, promotedBy } = req.body;
      if (!key || !value) { res.status(400).json({ error: "key and value required" }); return; }
      globalDb.create({ key, value, sourceSession: sourceSession || undefined, promotedBy: promotedBy || undefined });
      res.json({ success: true, key, created: true });
    } catch (err) { res.status(500).json({ error: String(err) }); }
  });

  router.get("/global/knowledge", (req: Request, res: Response) => {
    try {
      const { getGlobalKnowledgeDB } = require("../../core/global-knowledge.js");
      const globalDb = getGlobalKnowledgeDB(globalConfigDir);
      const limit = parseInt(req.query.limit as string) || 50;
      const q = req.query.q as string | undefined;
      const entries = q ? globalDb.search(q, limit) : globalDb.list(limit);
      const total = globalDb.count();
      res.json({ entries, count: entries.length, total });
    } catch (err) { res.status(500).json({ error: String(err) }); }
  });

  router.get("/global/knowledge/:key", (req: Request, res: Response) => {
    try {
      const { getGlobalKnowledgeDB } = require("../../core/global-knowledge.js");
      const globalDb = getGlobalKnowledgeDB(globalConfigDir);
      const entry = globalDb.get(decodeURIComponent(String(req.params.key)));
      if (!entry) { res.status(404).json({ error: "Global knowledge entry not found" }); return; }
      res.json(entry);
    } catch (err) { res.status(500).json({ error: String(err) }); }
  });

  router.put("/global/knowledge/:key", (req: Request, res: Response) => {
    try {
      const { getGlobalKnowledgeDB } = require("../../core/global-knowledge.js");
      const globalDb = getGlobalKnowledgeDB(globalConfigDir);
      const key = decodeURIComponent(String(req.params.key));
      const { value } = req.body;
      if (!value) { res.status(400).json({ error: "value is required" }); return; }
      const updated = globalDb.update(key, value);
      if (!updated) { res.status(404).json({ error: "Global knowledge entry not found" }); return; }
      res.json({ success: true, key, updated: true });
    } catch (err) { res.status(500).json({ error: String(err) }); }
  });

  router.delete("/global/knowledge/:key", (req: Request, res: Response) => {
    try {
      const { getGlobalKnowledgeDB } = require("../../core/global-knowledge.js");
      const globalDb = getGlobalKnowledgeDB(globalConfigDir);
      const removed = globalDb.remove(decodeURIComponent(String(req.params.key)));
      if (!removed) { res.status(404).json({ error: "Global knowledge entry not found" }); return; }
      res.json({ success: true, removed: true });
    } catch (err) { res.status(500).json({ error: String(err) }); }
  });
}
