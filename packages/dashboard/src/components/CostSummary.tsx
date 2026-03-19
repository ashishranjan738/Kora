import { Badge, Group, Paper, Text, Tooltip, Progress } from "@mantine/core";

interface AgentCostData {
  id: string;
  name: string;
  tokensIn: number;
  tokensOut: number;
  costUsd: number;
}

/** Extract cost data from an agent object (handles different API shapes) */
export function extractCostData(agent: any): { tokensIn: number; tokensOut: number; costUsd: number } {
  const tokensIn = agent.cost?.totalTokensIn ?? agent.tokensIn ?? agent.tokens_in ?? 0;
  const tokensOut = agent.cost?.totalTokensOut ?? agent.tokensOut ?? agent.tokens_out ?? 0;
  const costUsd = agent.cost?.totalCostUsd ?? (typeof agent.cost === "number" ? agent.cost : 0);
  return { tokensIn, tokensOut, costUsd };
}

/** Check if any agent has real cost data */
export function hasCostData(agents: any[]): boolean {
  return agents.some((a) => {
    const { costUsd, tokensIn, tokensOut } = extractCostData(a);
    return costUsd > 0 || tokensIn > 0 || tokensOut > 0;
  });
}

/** Format cost display — shows "No data" instead of "$0.00" when no data exists */
export function formatCostSmart(cost: number | undefined, hasData: boolean): string {
  if (!hasData && (cost == null || cost === 0)) return "--";
  if (cost == null || cost === 0) return "$0.00";
  if (cost < 0.01) return "<$0.01";
  return "$" + cost.toFixed(2);
}

/** Format token count */
function fmtTokens(n: number): string {
  if (n >= 1000000) return (n / 1000000).toFixed(1) + "M";
  if (n >= 1000) return (n / 1000).toFixed(1) + "k";
  return String(n);
}

/** Estimate cost split (rough: input tokens ~$3/M, output ~$15/M for Claude) */
function estimateCostSplit(tokensIn: number, tokensOut: number, totalCost: number) {
  if (totalCost === 0) return { inputCost: 0, outputCost: 0 };
  const inputWeight = tokensIn * 3;
  const outputWeight = tokensOut * 15;
  const totalWeight = inputWeight + outputWeight || 1;
  return {
    inputCost: totalCost * (inputWeight / totalWeight),
    outputCost: totalCost * (outputWeight / totalWeight),
  };
}

interface SessionCostSummaryProps {
  agents: any[];
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
  const maxAgentCost = Math.max(...agentCosts.map((a) => a.costUsd), 0.01);

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

      {/* Per-agent cost bars */}
      {hasData && (
        <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
          {agentCosts
            .sort((a, b) => b.costUsd - a.costUsd)
            .map((agent) => {
              const pct = Math.round((agent.costUsd / maxAgentCost) * 100);
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

/** Small inline cost sparkline showing cost accumulation over time */
interface CostSparklineProps {
  /** Array of cumulative cost values over time */
  history: number[];
  width?: number;
  height?: number;
}

export function CostSparkline({ history, width = 60, height = 14 }: CostSparklineProps) {
  if (history.length < 2) return null;

  const max = Math.max(...history, 0.01);
  const points = history.map((val, i) => {
    const x = (i / (history.length - 1)) * width;
    const y = height - (val / max) * height;
    return `${x},${y}`;
  }).join(" ");

  return (
    <Tooltip label={`Cost: $${history[history.length - 1]?.toFixed(2) || "0.00"}`} withArrow>
      <svg width={width} height={height} style={{ display: "block" }}>
        <polyline
          points={points}
          fill="none"
          stroke="var(--accent-green)"
          strokeWidth="1.5"
          strokeLinecap="round"
          strokeLinejoin="round"
        />
      </svg>
    </Tooltip>
  );
}
