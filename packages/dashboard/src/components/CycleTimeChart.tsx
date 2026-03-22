import { useMemo } from "react";
import { Text, Paper, Stack, Tooltip } from "@mantine/core";
import type { TaskMetricsResponse } from "./WorkloadChart";

// ---------- Types ----------

interface WorkflowStateInfo {
  id: string;
  label: string;
  color: string;
  category: "not-started" | "active" | "closed";
}

interface CycleTimeChartProps {
  metrics: TaskMetricsResponse;
  workflowStates: WorkflowStateInfo[];
}

// ---------- Helpers ----------

const BAR_HEIGHT = 24;
const ROW_GAP = 10;
const LABEL_WIDTH = 120;
const BAR_MAX_WIDTH = 500;

function formatDuration(ms: number): string {
  if (ms <= 0) return "N/A";
  const minutes = Math.round(ms / 60000);
  if (minutes < 1) return "<1 min";
  if (minutes < 60) return `${minutes} min`;
  const hours = Math.floor(minutes / 60);
  const remainMins = minutes % 60;
  if (hours < 24) return remainMins > 0 ? `${hours}h ${remainMins}m` : `${hours}h`;
  const days = Math.floor(hours / 24);
  const remainHrs = hours % 24;
  return remainHrs > 0 ? `${days}d ${remainHrs}h` : `${days}d`;
}

// ---------- Component ----------

export function CycleTimeChart({ metrics, workflowStates }: CycleTimeChartProps) {
  // Build color/label maps from workflow states
  const stateColorMap = useMemo(() => {
    const map: Record<string, string> = {};
    for (const ws of workflowStates) map[ws.id] = ws.color;
    return map;
  }, [workflowStates]);

  const stateLabelMap = useMemo(() => {
    const map: Record<string, string> = {};
    for (const ws of workflowStates) map[ws.id] = ws.label;
    return map;
  }, [workflowStates]);

  // Filter agents with cycle time data
  const agentsWithCycleTime = useMemo(
    () => metrics.agents.filter((a) => a.avgCycleTimeMs > 0).sort((a, b) => b.avgCycleTimeMs - a.avgCycleTimeMs),
    [metrics.agents],
  );

  if (agentsWithCycleTime.length === 0) {
    return null; // Don't render if no cycle time data
  }

  const maxCycleTime = Math.max(1, ...agentsWithCycleTime.map((a) => a.avgCycleTimeMs));
  const teamAvg = metrics.session.avgCycleTimeMs;
  const svgHeight = agentsWithCycleTime.length * (BAR_HEIGHT + ROW_GAP) + 30;

  return (
    <Paper p="md" withBorder>
      <Stack gap="sm">
        <Text size="sm" fw={600}>Average Cycle Time</Text>
        <Text size="xs" c="dimmed">
          Time from task start to completion per agent.
          {teamAvg > 0 && ` Team average: ${formatDuration(teamAvg)}`}
        </Text>

        <div style={{ overflowX: "auto" }}>
          <svg
            width="100%"
            viewBox={`0 0 ${LABEL_WIDTH + BAR_MAX_WIDTH + 120} ${svgHeight}`}
            style={{ minWidth: 500, display: "block" }}
          >
            {/* Team average line */}
            {teamAvg > 0 && (() => {
              const avgX = LABEL_WIDTH + (teamAvg / maxCycleTime) * BAR_MAX_WIDTH;
              return (
                <g>
                  <line
                    x1={avgX}
                    y1={0}
                    x2={avgX}
                    y2={svgHeight - 20}
                    stroke="var(--accent-blue, #58a6ff)"
                    strokeWidth={1.5}
                    strokeDasharray="4 3"
                    opacity={0.6}
                  />
                  <text
                    x={avgX}
                    y={svgHeight - 6}
                    textAnchor="middle"
                    fill="var(--accent-blue, #58a6ff)"
                    fontSize={10}
                    opacity={0.8}
                  >
                    avg {formatDuration(teamAvg)}
                  </text>
                </g>
              );
            })()}

            {agentsWithCycleTime.map((agent, i) => {
              const y = i * (BAR_HEIGHT + ROW_GAP);
              const barWidth = (agent.avgCycleTimeMs / maxCycleTime) * BAR_MAX_WIDTH;
              const isSlow = teamAvg > 0 && agent.avgCycleTimeMs > teamAvg * 1.5;
              const isFast = teamAvg > 0 && agent.avgCycleTimeMs < teamAvg * 0.7;

              // Color: red if slow, green if fast, default blue
              const barColor = isSlow
                ? "var(--accent-red, #f85149)"
                : isFast
                  ? "var(--accent-green, #3fb950)"
                  : "var(--accent-blue, #58a6ff)";

              return (
                <g key={agent.agentId}>
                  {/* Agent name */}
                  <text
                    x={LABEL_WIDTH - 8}
                    y={y + BAR_HEIGHT / 2 + 1}
                    textAnchor="end"
                    dominantBaseline="middle"
                    fill="var(--text-primary, #c9d1d9)"
                    fontSize={12}
                    fontWeight={500}
                  >
                    {agent.agentName.length > 14
                      ? agent.agentName.slice(0, 13) + "..."
                      : agent.agentName}
                  </text>

                  {/* Background track */}
                  <rect
                    x={LABEL_WIDTH}
                    y={y}
                    width={BAR_MAX_WIDTH}
                    height={BAR_HEIGHT}
                    rx={4}
                    fill="var(--bg-tertiary, #161b22)"
                    opacity={0.5}
                  />

                  {/* Cycle time bar */}
                  <Tooltip label={`${agent.agentName}: ${formatDuration(agent.avgCycleTimeMs)} avg cycle time`}>
                    <rect
                      x={LABEL_WIDTH}
                      y={y + 3}
                      width={Math.max(barWidth, 4)}
                      height={BAR_HEIGHT - 6}
                      rx={3}
                      fill={barColor}
                      opacity={0.8}
                    />
                  </Tooltip>

                  {/* Duration label */}
                  <text
                    x={LABEL_WIDTH + barWidth + 8}
                    y={y + BAR_HEIGHT / 2 + 1}
                    dominantBaseline="middle"
                    fill="var(--text-secondary, #8b949e)"
                    fontSize={11}
                  >
                    {formatDuration(agent.avgCycleTimeMs)}
                    {isSlow && " (slow)"}
                    {isFast && " (fast)"}
                  </text>
                </g>
              );
            })}
          </svg>
        </div>
      </Stack>
    </Paper>
  );
}
