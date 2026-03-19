import type { IPtyBackend } from "./pty-backend.js";
import { CostTracker } from "./cost-tracker.js";
import type { AgentState, ParsedOutput } from "@kora/shared";
import { COST_UPDATE_INTERVAL_MS } from "@kora/shared";
import { estimateTokens, estimateCost } from "./cost-estimator.js";

export class UsageMonitor {
  private intervals = new Map<string, NodeJS.Timeout>();
  private lastOutput = new Map<string, string>();
  private cumulativeTokensIn = new Map<string, number>();
  private cumulativeTokensOut = new Map<string, number>();

  constructor(
    private tmux: IPtyBackend,
    private costTracker: CostTracker,
  ) {}

  /** Start monitoring an agent's token usage */
  startMonitoring(agent: AgentState): void {
    // Initialize cumulative tracking
    this.cumulativeTokensIn.set(agent.id, 0);
    this.cumulativeTokensOut.set(agent.id, 0);

    const interval = setInterval(async () => {
      try {
        // Capture last 200 lines of terminal output
        const output = await this.tmux.capturePane(agent.config.tmuxSession, 200, false);

        // Skip if output hasn't changed
        const lastOut = this.lastOutput.get(agent.id) || "";
        if (output === lastOut) return;

        // Calculate new content (model's response since last check)
        const newContent = output.slice(lastOut.length);
        const newTokensOut = estimateTokens(newContent);

        // Estimate input tokens from full accumulated output (context)
        const newTokensIn = estimateTokens(output);

        // Update cumulative totals
        const totalTokensIn = this.cumulativeTokensIn.get(agent.id)! + newTokensIn;
        const totalTokensOut = this.cumulativeTokensOut.get(agent.id)! + newTokensOut;
        this.cumulativeTokensIn.set(agent.id, totalTokensIn);
        this.cumulativeTokensOut.set(agent.id, totalTokensOut);

        // Calculate total cost
        const totalCostUsd = estimateCost(totalTokensIn, totalTokensOut);

        // Update cost tracker with cumulative values
        const parsed: ParsedOutput = {
          tokenUsage: { input: totalTokensIn, output: totalTokensOut },
          costUsd: totalCostUsd,
        };

        this.costTracker.updateFromOutput(agent.id, parsed);
        this.lastOutput.set(agent.id, output);
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
    this.lastOutput.delete(agentId);
    this.cumulativeTokensIn.delete(agentId);
    this.cumulativeTokensOut.delete(agentId);
  }

  /** Stop all monitoring */
  stopAll(): void {
    for (const [id] of this.intervals) this.stopMonitoring(id);
  }
}
