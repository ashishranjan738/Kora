// ============================================================
// Cost tracker — per-agent token usage and budget enforcement
// ============================================================

import { EventEmitter } from "events";
import type { AgentCost, ParsedOutput } from "@kora/shared";

export class CostTracker extends EventEmitter {
  private costs = new Map<string, AgentCost>();

  /** Initialize tracking for an agent */
  initAgent(agentId: string): void {
    this.costs.set(agentId, {
      totalTokensIn: 0,
      totalTokensOut: 0,
      totalCostUsd: 0,
      lastUpdatedAt: new Date().toISOString(),
    });
  }

  /** Update cost from parsed output */
  updateFromOutput(agentId: string, parsed: ParsedOutput): void {
    const cost = this.costs.get(agentId);
    if (!cost) {
      throw new Error(
        `Cost tracking not initialized for agent "${agentId}". Call initAgent first.`,
      );
    }

    const now = new Date().toISOString();

    if (parsed.tokenUsage) {
      // CLI output shows cumulative totals — take the max to avoid double-counting
      cost.totalTokensIn = Math.max(cost.totalTokensIn, parsed.tokenUsage.input);
      cost.totalTokensOut = Math.max(cost.totalTokensOut, parsed.tokenUsage.output);
    }

    if (parsed.costUsd !== undefined) {
      // Provider reported cost directly — cumulative from CLI, take the max
      cost.totalCostUsd = Math.max(cost.totalCostUsd, parsed.costUsd);
    }

    if (parsed.contextWindowPercent !== undefined) {
      cost.contextWindowPercent = parsed.contextWindowPercent;
    }

    cost.lastUpdatedAt = now;
    this.emit("cost-updated", agentId, cost);
  }

  /** Get current cost for an agent */
  getCost(agentId: string): AgentCost | undefined {
    return this.costs.get(agentId);
  }

  /** Get total cost across all agents */
  getTotalCost(): number {
    let total = 0;
    for (const cost of this.costs.values()) {
      total += cost.totalCostUsd;
    }
    return total;
  }

  /** Check if agent has exceeded budget. Emits 'budget-exceeded' event if so. */
  checkBudget(agentId: string, limit: number | undefined): boolean {
    if (limit === undefined) {
      return false;
    }

    const cost = this.costs.get(agentId);
    if (!cost) {
      return false;
    }

    const exceeded = cost.totalCostUsd >= limit;
    if (exceeded) {
      this.emit("budget-exceeded", agentId, cost, limit);
    }
    return exceeded;
  }

  /** Remove agent tracking */
  removeAgent(agentId: string): void {
    this.costs.delete(agentId);
  }
}
