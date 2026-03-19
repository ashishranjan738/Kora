import { Badge, Group, Paper, Text, Tooltip, Progress } from "@mantine/core";

// ── Types ────────────────────────────────────────────────────

/** Fields that may carry cost data on an agent API response */
interface AgentCostFields {
  id: string;
  name?: string;
  config?: { name?: string };
  cost?: { totalCostUsd?: number; totalTokensIn?: number; totalTokensOut?: number } | number;
  tokensIn?: number;
  tokensOut?: number;
  tokens_in?: number;
  tokens_out?: number;
}

interface AgentCostData {
  id: string;
  name: string;
  tokensIn: number;
  tokensOut: number;
  costUsd: number;
}

// ── Constants ────────────────────────────────────────────────

/** Approximate cost per million tokens (used for input/output split estimate) */
const INPUT_COST_PER_M = 3;
const OUTPUT_COST_PER_M = 15;
/** Threshold below which we show "<$0.01" */
const MIN_DISPLAY_COST = 0.01;

// ── Utilities ────────────────────────────────────────────────

/** Extract cost data from an agent object (handles different API shapes) */
export function extractCostData(agent: AgentCostFields): { tokensIn: number; tokensOut: number; costUsd: number } {
  const cost = agent.cost;
  const costObj = typeof cost === "object" ? cost : undefined;
  const tokensIn = costObj?.totalTokensIn ?? agent.tokensIn ?? agent.tokens_in ?? 0;
  const tokensOut = costObj?.totalTokensOut ?? agent.tokensOut ?? agent.tokens_out ?? 0;
  const costUsd = costObj?.totalCostUsd ?? (typeof cost === "number" ? cost : 0);
  return { tokensIn, tokensOut, costUsd };
}

/** Check if any agent has real cost data */
export function hasCostData(agents: AgentCostFields[]): boolean {
  return agents.some((a) => {
    const { costUsd, tokensIn, tokensOut } = extractCostData(a);
    return costUsd > 0 || tokensIn > 0 || tokensOut > 0;
  });
}

/** Format cost — shows "--" when no data, "<$0.01" for tiny amounts */
export function formatCostSmart(cost: number | undefined, hasData: boolean): string {
  if (!hasData && (cost == null || cost === 0)) return "--";
  if (cost == null || cost === 0) return "$0.00";
  if (cost < MIN_DISPLAY_COST) return "<$0.01";
  return "$" + cost.toFixed(2);
}

function fmtTokens(n: number): string {
  if (n >= 1000000) return (n / 1000000).toFixed(1) + "M";
  if (n >= 1000) return (n / 1000).toFixed(1) + "k";
  return String(n);
}

function estimateCostSplit(tokensIn: number, tokensOut: number, totalCost: number) {
  if (totalCost === 0) return { inputCost: 0, outputCost: 0 };
  const inputWeight = tokensIn * INPUT_COST_PER_M;
  const outputWeight = tokensOut * OUTPUT_COST_PER_M;
  const totalWeight = inputWeight + outputWeight || 1;
  return {
    inputCost: totalCost * (inputWeight / totalWeight),
    outputCost: totalCost * (outputWeight / totalWeight),
  };
}

// ── Component ────────────────────────────────────────────────

interface SessionCostSummaryProps {
  agents: AgentCostFields[];
}

/** Session-level cost summary widget */
export function SessionCostSummary({ agents }: SessionCostSummaryProps) {
  const agentCosts: AgentCostData[] = agents.map((a) => {
    const { tokensIn, tokensOut, costUsd } = extractCostData(a);
    return {
      id: a.id,
      name: a.config?.name || a.name || "Agent",
      tokensIn,
      tokensOut,
      costUsd,
    };
  });

  const totalCost = agentCosts.reduce((sum, a) => sum + a.costUsd, 0);
  const totalTokensIn = agentCosts.reduce((sum, a) => sum + a.tokensIn, 0);
  const totalTokensOut = agentCosts.reduce((sum, a) => sum + a.tokensOut, 0);
  const hasData = hasCostData(agents);

  if (agents.length === 0) return null;

  return (
    <Paper
      p="md"
      withBorder
      style={{
        backgroundColor: "var(--bg-secondary)",
        borderColor: "var(--border-color)",
        marginBottom: 16,
      }}
    >
      <Group justify="space-between" mb={12}>
        <Text fw={600} size="sm" c="var(--text-primary)">
          Session Cost
        </Text>
        <Group gap={12}>
          <Tooltip label={`Input: ${fmtTokens(totalTokensIn)} tokens | Output: ${fmtTokens(totalTokensOut)} tokens`} withArrow>
            <Badge variant="light" color={hasData ? "green" : "gray"} size="sm">
              {hasData ? `$${totalCost.toFixed(2)}` : "No cost data"}
            </Badge>
          </Tooltip>
          <Text size="xs" c="dimmed">
            {fmtTokens(totalTokensIn)} in / {fmtTokens(totalTokensOut)} out
          </Text>
        </Group>
      </Group>

      {hasData && (
        <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
          {agentCosts
            .sort((a, b) => b.costUsd - a.costUsd)
            .map((agent) => {
              const pct = totalCost > 0 ? Math.round((agent.costUsd / totalCost) * 100) : 0;
              const { inputCost, outputCost } = estimateCostSplit(agent.tokensIn, agent.tokensOut, agent.costUsd);

              return (
                <Tooltip
                  key={agent.id}
                  label={`${agent.name}: $${agent.costUsd.toFixed(2)} (input ~$${inputCost.toFixed(2)}, output ~$${outputCost.toFixed(2)}) | ${fmtTokens(agent.tokensIn)} in, ${fmtTokens(agent.tokensOut)} out`}
                  withArrow
                  multiline
                  w={300}
                >
                  <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
                    <Text size="xs" c="dimmed" style={{ minWidth: 80, textAlign: "right" }}>
                      {agent.name}
                    </Text>
                    <Progress
                      value={pct}
                      color="blue"
                      size="sm"
                      radius="xl"
                      style={{ flex: 1 }}
                      styles={{ root: { backgroundColor: "var(--bg-tertiary)" } }}
                    />
                    <Text size="xs" c="dimmed" style={{ minWidth: 50, textAlign: "right" }}>
                      {agent.costUsd > 0 ? `$${agent.costUsd.toFixed(2)}` : "--"}
                    </Text>
                  </div>
                </Tooltip>
              );
            })}
        </div>
      )}

      {!hasData && (
        <Text size="xs" c="dimmed" ta="center" py={8}>
          Cost data will appear once agents start processing tokens
        </Text>
      )}
    </Paper>
  );
}
