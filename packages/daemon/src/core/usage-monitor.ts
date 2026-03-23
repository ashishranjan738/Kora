import type { IPtyBackend } from "./pty-backend.js";
import { CostTracker } from "./cost-tracker.js";
import type { AgentState, ParsedOutput, CLIProvider } from "@kora/shared";
import { COST_UPDATE_INTERVAL_MS } from "@kora/shared";
import { estimateTokens, estimateCost } from "./cost-estimator.js";
import { ClaudeSessionReader } from "./claude-session-reader.js";
import { logger } from "./logger.js";

const COST_POLL_MIN_INTERVAL_MS = 60_000; // Max once per 60s

export class UsageMonitor {
  private intervals = new Map<string, NodeJS.Timeout>();
  private lastTokenCount = new Map<string, number>();
  private cumulativeTokensIn = new Map<string, number>();
  private cumulativeTokensOut = new Map<string, number>();
  private agentProviders = new Map<string, CLIProvider>();
  private agentSessions = new Map<string, string>();
  /** Last time /cost was polled for each agent (prevents spamming) */
  private lastCostPollTime = new Map<string, number>();
  /** Callback to check if agent is idle (set by orchestrator) */
  private isAgentIdleFn: ((agentId: string) => boolean) | null = null;
  /** JSONL-based session reader for silent cost tracking (no terminal disruption) */
  private jsonlReader = new ClaudeSessionReader();
  /** Whether JSONL reader has been attempted for each agent */
  private jsonlInitAttempted = new Set<string>();

  constructor(
    private tmux: IPtyBackend,
    private costTracker: CostTracker,
    private providerRegistry?: { get(id: string): CLIProvider | undefined },
  ) {}

  /** Set callback to check agent idle status */
  setIdleChecker(fn: (agentId: string) => boolean): void {
    this.isAgentIdleFn = fn;
  }

  /** Start monitoring an agent's token usage */
  startMonitoring(agent: AgentState): void {
    this.lastTokenCount.set(agent.id, 0);
    this.cumulativeTokensIn.set(agent.id, 0);
    this.cumulativeTokensOut.set(agent.id, 0);
    // Resolve provider for provider-specific parsing
    if (this.providerRegistry) {
      const provider = this.providerRegistry.get(agent.config.cliProvider);
      if (provider) this.agentProviders.set(agent.id, provider);
    }

    this.agentSessions.set(agent.id, agent.config.tmuxSession);

    const interval = setInterval(async () => {
      try {
        const provider = this.agentProviders.get(agent.id);

        // Tier 1: Try JSONL file reading (silent, no terminal disruption)
        if (provider?.id === "claude-code") {
          const jsonlUsage = this.readJsonlUsage(agent);
          if (jsonlUsage) {
            // JSONL provides accurate cumulative tokens — use directly
            this.costTracker.updateFromOutput(agent.id, jsonlUsage);
            return; // Skip terminal scraping when JSONL data is available
          }
        }

        // Tier 2: Terminal output parsing (passive — no commands sent)
        const output = await this.tmux.capturePane(agent.config.tmuxSession, 200, false);

        if (provider) {
          // Use provider-specific parsing for accurate metrics
          this.updateFromProvider(agent.id, output, provider);
        } else {
          // Fallback: generic tiktoken estimation
          this.updateFromEstimate(agent.id, output);
        }
      } catch {
        // Agent may be dead, ignore
      }
    }, COST_UPDATE_INTERVAL_MS);

    this.intervals.set(agent.id, interval);
  }

  /**
   * Provider-specific parsing — extracts real metrics from terminal output.
   * For Kiro: reads Credits and context window % from the prompt.
   * For Claude Code: reads token counts from status line.
   */
  private updateFromProvider(agentId: string, output: string, provider: CLIProvider): void {
    const parsed = provider.parseOutput(output);

    // For providers that report per-turn credits (Kiro), accumulate them
    if (provider.id === "kiro" && parsed.costUsd !== undefined) {
      // Kiro shows "Credits: X.XX" per response — these are per-turn, not cumulative.
      // Find ALL credit lines in the output and sum them for true cumulative cost.
      const allCredits = output.match(/Credits:\s*([\d.]+)/g);
      if (allCredits) {
        let totalCredits = 0;
        for (const match of allCredits) {
          const val = parseFloat(match.replace(/Credits:\s*/, ""));
          if (!isNaN(val)) totalCredits += val;
        }
        parsed.costUsd = totalCredits;
      }
    }

    // Provider-parsed values auto-correct the estimates
    if (parsed.tokenUsage || parsed.costUsd !== undefined || parsed.contextWindowPercent !== undefined) {
      this.costTracker.updateFromOutput(agentId, parsed);
    }
  }

  /** Fallback: estimate tokens from terminal output using tiktoken */
  private updateFromEstimate(agentId: string, output: string): void {
    const currentTotalTokens = estimateTokens(output);
    const previousTotalTokens = this.lastTokenCount.get(agentId) || 0;

    if (currentTotalTokens === previousTotalTokens) return;

    const newTokens = currentTotalTokens - previousTotalTokens;
    this.lastTokenCount.set(agentId, currentTotalTokens);

    const currentOut = this.cumulativeTokensOut.get(agentId)! + newTokens;
    this.cumulativeTokensOut.set(agentId, currentOut);

    const currentIn = this.cumulativeTokensIn.get(agentId)! + (newTokens * 2);
    this.cumulativeTokensIn.set(agentId, currentIn);

    const totalCostUsd = estimateCost(currentIn, currentOut);

    const parsed: ParsedOutput = {
      tokenUsage: { input: currentIn, output: currentOut },
      costUsd: totalCostUsd,
    };

    this.costTracker.updateFromOutput(agentId, parsed);
  }

  /** Immediately poll all monitored agents and return fresh cost data */
  async pollNow(): Promise<void> {
    const promises: Promise<void>[] = [];
    for (const [agentId, tmuxSession] of this.agentSessions) {
      promises.push((async () => {
        try {
          const output = await this.tmux.capturePane(tmuxSession, 200, false);
          const provider = this.agentProviders.get(agentId);
          if (provider) {
            this.updateFromProvider(agentId, output, provider);
          } else {
            this.updateFromEstimate(agentId, output);
          }
        } catch { /* agent may be dead */ }
      })());
    }
    await Promise.all(promises);
  }

  /**
   * Read usage from Claude Code's JSONL session files (silent — no terminal disruption).
   * Returns ParsedOutput if JSONL data available, null otherwise.
   */
  private readJsonlUsage(agent: AgentState): ParsedOutput | null {
    const agentId = agent.id;

    // Lazy init: initAgent scans ~/.claude/sessions/ to find matching cwd
    if (!this.jsonlReader.hasAgent(agentId) && !this.jsonlInitAttempted.has(agentId)) {
      this.jsonlInitAttempted.add(agentId);
      const workDir = agent.config.workingDirectory;
      if (workDir) {
        try {
          if (this.jsonlReader.initAgent(agentId, 0, workDir)) {
            logger.info({ agentId, workDir }, "[UsageMonitor] JSONL reader initialized via cwd match");
          }
        } catch { /* non-fatal */ }
      }
    }

    if (!this.jsonlReader.hasAgent(agentId)) return null;

    const usage = this.jsonlReader.getUsage(agentId);
    if (!usage || usage.totalTokens === 0) return null;

    return {
      tokenUsage: {
        input: usage.inputTokens + usage.cacheCreationTokens + usage.cacheReadTokens,
        output: usage.outputTokens,
      },
      costUsd: estimateCost(
        usage.inputTokens + usage.cacheCreationTokens + usage.cacheReadTokens,
        usage.outputTokens,
      ),
    };
  }

  /**
   * Poll `/cost` command on an idle Claude Code agent to get cumulative token usage.
   * Only runs when: agent is idle, provider is claude-code, last poll >60s ago.
   */
  private async pollCostCommand(agentId: string, tmuxSession: string, provider: CLIProvider): Promise<void> {
    const now = Date.now();
    const lastPoll = this.lastCostPollTime.get(agentId) || 0;
    if (now - lastPoll < COST_POLL_MIN_INTERVAL_MS) return;

    this.lastCostPollTime.set(agentId, now);

    try {
      // Send /cost command (literal mode to avoid interpretation)
      await this.tmux.sendKeys(tmuxSession, "/cost", { literal: true });
      await this.tmux.sendKeys(tmuxSession, "", { literal: false }); // Enter

      // Wait for output to appear
      await new Promise(resolve => setTimeout(resolve, 2500));

      // Capture and parse the output
      const output = await this.tmux.capturePane(tmuxSession, 30, false);
      const parsed = provider.parseOutput(output);

      if (parsed.tokenUsage || parsed.costUsd !== undefined) {
        this.costTracker.updateFromOutput(agentId, parsed);
        logger.debug({ agentId, tokens: parsed.tokenUsage, cost: parsed.costUsd },
          "[UsageMonitor] /cost poll captured metrics");
      }
    } catch (err) {
      logger.debug({ err, agentId }, "[UsageMonitor] /cost poll failed (non-fatal)");
    }
  }

  /** Stop monitoring an agent */
  stopMonitoring(agentId: string): void {
    this.agentSessions.delete(agentId);
    const interval = this.intervals.get(agentId);
    if (interval) {
      clearInterval(interval);
      this.intervals.delete(agentId);
    }
    this.lastTokenCount.delete(agentId);
    this.cumulativeTokensIn.delete(agentId);
    this.cumulativeTokensOut.delete(agentId);
    this.agentProviders.delete(agentId);
    this.lastCostPollTime.delete(agentId);
    this.jsonlReader.removeAgent(agentId);
    this.jsonlInitAttempted.delete(agentId);
  }

  /**
   * Get tool usage summary for an agent from JSONL session data.
   * Returns { toolName: count } sorted by count descending.
   */
  getToolUsageSummary(agentId: string): Record<string, number> | null {
    if (!this.jsonlReader.hasAgent(agentId)) return null;
    const toolCalls = this.jsonlReader.getToolCalls(agentId);
    if (toolCalls.length === 0) return null;

    const counts: Record<string, number> = {};
    for (const call of toolCalls) {
      counts[call.name] = (counts[call.name] || 0) + 1;
    }

    // Sort by count descending
    return Object.fromEntries(
      Object.entries(counts).sort(([, a], [, b]) => b - a)
    );
  }

  /**
   * Get tool usage for all monitored agents.
   */
  getAllToolUsage(): Record<string, Record<string, number>> {
    const result: Record<string, Record<string, number>> = {};
    for (const agentId of this.intervals.keys()) {
      const usage = this.getToolUsageSummary(agentId);
      if (usage) result[agentId] = usage;
    }
    return result;
  }

  /**
   * Get files modified by an agent from JSONL session data.
   * Returns list of file paths touched by Read/Edit/Write tool calls.
   */
  getFilesModified(agentId: string): string[] | null {
    if (!this.jsonlReader.hasAgent(agentId)) return null;
    return this.jsonlReader.getFilesModified(agentId);
  }

  /**
   * Get conversation metrics for an agent from JSONL session data.
   * Returns turn count + messages per minute rate.
   */
  getConversationMetrics(agentId: string): { turnCount: number; messagesPerMinute: number } | null {
    if (!this.jsonlReader.hasAgent(agentId)) return null;
    const turnCount = this.jsonlReader.getTurnCount(agentId);
    // Compute messages/min from agent start time
    const agentStartKey = this.agentSessions.get(agentId);
    let messagesPerMinute = 0;
    if (turnCount > 0) {
      // Estimate from monitoring start time
      const monitoringDurationMs = Date.now() - (this.lastCostPollTime.get(agentId) || Date.now());
      const durationMinutes = Math.max(1, monitoringDurationMs / 60_000);
      messagesPerMinute = Math.round((turnCount / durationMinutes) * 10) / 10;
    }
    return { turnCount, messagesPerMinute };
  }

  /** Stop all monitoring */
  stopAll(): void {
    for (const [id] of this.intervals) this.stopMonitoring(id);
  }
}
