import { TmuxController } from "./tmux-controller.js";
import { CostTracker } from "./cost-tracker.js";
import type { CLIProvider } from "@kora/shared";
import type { AgentState } from "@kora/shared";
import { COST_UPDATE_INTERVAL_MS } from "@kora/shared";

export class UsageMonitor {
  private intervals = new Map<string, NodeJS.Timeout>();
  private lastOutput = new Map<string, string>();

  constructor(
    private tmux: TmuxController,
    private costTracker: CostTracker,
    private providerResolver: (agentId: string) => CLIProvider | undefined,
  ) {}

  /** Start monitoring an agent's token usage */
  startMonitoring(agent: AgentState): void {
    const interval = setInterval(async () => {
      try {
        // Capture last 50 lines of terminal output
        const output = await this.tmux.capturePane(agent.config.tmuxSession, 50, false);

        // Skip if output hasn't changed
        const lastOut = this.lastOutput.get(agent.id);
        if (output === lastOut) return;
        this.lastOutput.set(agent.id, output);

        // Get the provider to parse the output
        const provider = this.providerResolver(agent.id);
        if (!provider) return;

        // Parse output for token usage
        const parsed = provider.parseOutput(output);

        // Update cost tracker
        if (parsed.tokenUsage || parsed.costUsd !== undefined) {
          this.costTracker.updateFromOutput(agent.id, parsed);
        }
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
  }

  /** Stop all monitoring */
  stopAll(): void {
    for (const [id] of this.intervals) this.stopMonitoring(id);
  }
}
