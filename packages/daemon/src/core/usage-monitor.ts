import type { IPtyBackend } from "./pty-backend.js";
import { CostTracker } from "./cost-tracker.js";
import type { AgentState, ParsedOutput } from "@kora/shared";
import { COST_UPDATE_INTERVAL_MS } from "@kora/shared";
import { estimateTokens, estimateCost } from "./cost-estimator.js";

export class UsageMonitor {
  private intervals = new Map<string, NodeJS.Timeout>();
  private lastTokenCount = new Map<string, number>();
  private cumulativeTokensIn = new Map<string, number>();
  private cumulativeTokensOut = new Map<string, number>();

  constructor(
    private tmux: IPtyBackend,
    private costTracker: CostTracker,
  ) {}

  /** Start monitoring an agent's token usage */
  startMonitoring(agent: AgentState): void {
    // Initialize cumulative tracking
    this.lastTokenCount.set(agent.id, 0);
    this.cumulativeTokensIn.set(agent.id, 0);
    this.cumulativeTokensOut.set(agent.id, 0);

    const interval = setInterval(async () => {
      try {
        // Capture last 200 lines of terminal output
        const output = await this.tmux.capturePane(agent.config.tmuxSession, 200, false);

        // Calculate token count for current output
        const currentTotalTokens = estimateTokens(output);
        const previousTotalTokens = this.lastTokenCount.get(agent.id) || 0;

        // Skip if no new tokens
        if (currentTotalTokens === previousTotalTokens) return;

        // Delta = new tokens since last check
        const newTokens = currentTotalTokens - previousTotalTokens;
        this.lastTokenCount.set(agent.id, currentTotalTokens);

        // All new terminal content is OUTPUT tokens (model generated this)
        const currentOut = this.cumulativeTokensOut.get(agent.id)! + newTokens;
        this.cumulativeTokensOut.set(agent.id, currentOut);

        // Estimate INPUT tokens as 2x output (rough heuristic: prompts + context ≈ 2x response)
        const currentIn = this.cumulativeTokensIn.get(agent.id)! + (newTokens * 2);
        this.cumulativeTokensIn.set(agent.id, currentIn);

        // Calculate total cost
        const totalCostUsd = estimateCost(currentIn, currentOut);

        // Update cost tracker with cumulative values
        const parsed: ParsedOutput = {
          tokenUsage: { input: currentIn, output: currentOut },
          costUsd: totalCostUsd,
        };

        this.costTracker.updateFromOutput(agent.id, parsed);
      } catch {
        // Agent may be dead, ignore
      }
    }, COST_UPDATE_INTERVAL_MS);

    this.intervals.set(agent.id, interval);
  }

  /** Stop monitoring an agent */
  stopMonitoring(agentId: string): void {
    const interval = this.intervals.get(agentId);
    if (interval) {
      clearInterval(interval);
      this.intervals.delete(agentId);
    }
    this.lastTokenCount.delete(agentId);
    this.cumulativeTokensIn.delete(agentId);
    this.cumulativeTokensOut.delete(agentId);
  }

  /** Stop all monitoring */
  stopAll(): void {
    for (const [id] of this.intervals) this.stopMonitoring(id);
  }
}
