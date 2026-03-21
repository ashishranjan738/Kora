import type { IPtyBackend } from "./pty-backend.js";
import { CostTracker } from "./cost-tracker.js";
import type { AgentState, ParsedOutput, CLIProvider } from "@kora/shared";
import { COST_UPDATE_INTERVAL_MS } from "@kora/shared";
import { estimateTokens, estimateCost } from "./cost-estimator.js";

export class UsageMonitor {
  private intervals = new Map<string, NodeJS.Timeout>();
  private lastTokenCount = new Map<string, number>();
  private cumulativeTokensIn = new Map<string, number>();
  private cumulativeTokensOut = new Map<string, number>();
  private agentProviders = new Map<string, CLIProvider>();
  // Track cumulative credits for providers that report per-turn credits (Kiro)
  private cumulativeCredits = new Map<string, number>();
  private lastCreditsSeen = new Map<string, number>();

  constructor(
    private tmux: IPtyBackend,
    private costTracker: CostTracker,
    private providerRegistry?: { get(id: string): CLIProvider | undefined },
  ) {}

  /** Start monitoring an agent's token usage */
  startMonitoring(agent: AgentState): void {
    this.lastTokenCount.set(agent.id, 0);
    this.cumulativeTokensIn.set(agent.id, 0);
    this.cumulativeTokensOut.set(agent.id, 0);
    this.cumulativeCredits.set(agent.id, 0);
    this.lastCreditsSeen.set(agent.id, 0);

    // Resolve provider for provider-specific parsing
    if (this.providerRegistry) {
      const provider = this.providerRegistry.get(agent.config.cliProvider);
      if (provider) this.agentProviders.set(agent.id, provider);
    }

    this.agentSessions.set(agent.id, agent.config.tmuxSession);

    const interval = setInterval(async () => {
      try {
        const output = await this.tmux.capturePane(agent.config.tmuxSession, 200, false);
        const provider = this.agentProviders.get(agent.id);

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

  private agentSessions = new Map<string, string>();

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
    this.cumulativeCredits.delete(agentId);
    this.lastCreditsSeen.delete(agentId);
  }

  /** Stop all monitoring */
  stopAll(): void {
    for (const [id] of this.intervals) this.stopMonitoring(id);
  }
}
