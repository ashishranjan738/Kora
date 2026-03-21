import { useMemo } from "react";
import { useNavigate } from "react-router-dom";
import { Text, Paper, Stack, Group, Loader, Badge, Tooltip } from "@mantine/core";
import { getLoadColor } from "../utils/workload";

// ---------- Types ----------

export interface AgentTaskMetrics {
  agentId: string;
  agentName: string;
  /** Task counts keyed by workflow state id (e.g. "pending", "in-progress") */
  tasksByStatus: Record<string, number>;
  totalActiveTasks: number;
  doneTasks: number;
  blockedTasks: number;
  loadPercentage: number;
  capacity: number;
  isOverloaded: boolean;
  isIdle: boolean;
  bottleneckScore: number;
  avgCycleTimeMs: number;
  taskBlockingOthers: number;
  blockedAgents: string[];
  activity?: string; // working / idle / blocked etc.
}

export interface SessionTaskMetrics {
  totalTasks: number;
  activeTasks: number;
  doneTasks: number;
  blockedTasks: number;
  avgCycleTimeMs: number;
  throughput: number;
  topBottleneck: {
    agentId: string;
    agentName: string;
    score: number;
    reason: string;
  } | null;
  loadDistribution: {
    overloaded: number;
    balanced: number;
    underutilized: number;
    idle: number;
  };
}

export interface TaskMetricsResponse {
  session: SessionTaskMetrics;
  agents: AgentTaskMetrics[];
}

interface WorkflowStateInfo {
  id: string;
  label: string;
  color: string;
  category: "not-started" | "active" | "closed";
}

// ---------- Props ----------

interface WorkloadChartProps {
  metrics: TaskMetricsResponse | null;
  workflowStates: WorkflowStateInfo[];
  sessionId: string;
  loading?: boolean;
  error?: string | null;
}

// ---------- Helpers ----------

const BAR_HEIGHT = 28;
const ROW_GAP = 12;
const LABEL_WIDTH = 120;
const BAR_PADDING_RIGHT = 180; // space for badges on the right

function activityLabel(activity?: string): string {
  if (!activity) return "";
  const map: Record<string, string> = {
    working: "working",
    idle: "idle",
    reading: "reading",
    writing: "writing",
    "running-command": "running",
    crashed: "crashed",
    stopped: "stopped",
    blocked: "blocked",
  };
  return map[activity] || activity;
}

// ---------- Component ----------

export function WorkloadChart({ metrics, workflowStates, sessionId, loading, error }: WorkloadChartProps) {
  const navigate = useNavigate();

  // Build a color map from workflow states (dynamic, not hardcoded)
  const stateColorMap = useMemo(() => {
    const map: Record<string, string> = {};
    for (const ws of workflowStates) {
      map[ws.id] = ws.color;
    }
    return map;
  }, [workflowStates]);

  const stateLabelMap = useMemo(() => {
    const map: Record<string, string> = {};
    for (const ws of workflowStates) {
      map[ws.id] = ws.label;
    }
    return map;
  }, [workflowStates]);

  // Compute max tasks for scaling bars
  const maxTasks = useMemo(() => {
    if (!metrics?.agents.length) return 1;
    return Math.max(1, ...metrics.agents.map((a) => a.totalActiveTasks + a.doneTasks));
  }, [metrics]);

  // Loading state
  if (loading) {
    return (
      <Paper p="xl" withBorder style={{ display: "flex", alignItems: "center", justifyContent: "center", minHeight: 200 }}>
        <Stack align="center" gap="sm">
          <Loader size="md" />
          <Text size="sm" c="dimmed">Loading workload data...</Text>
        </Stack>
      </Paper>
    );
  }

  // Error state
  if (error) {
    return (
      <Paper p="xl" withBorder style={{ minHeight: 200 }}>
        <Stack align="center" gap="sm">
          <Text size="lg" c="red">Failed to load workload data</Text>
          <Text size="sm" c="dimmed">{error}</Text>
        </Stack>
      </Paper>
    );
  }

  // Empty state
  if (!metrics || metrics.agents.length === 0) {
    return (
      <Paper p="xl" withBorder style={{ display: "flex", alignItems: "center", justifyContent: "center", minHeight: 200 }}>
        <Stack align="center" gap="sm">
          <Text size="lg" c="dimmed">No tasks yet</Text>
          <Text size="sm" c="dimmed">Assign tasks to agents to see workload distribution.</Text>
        </Stack>
      </Paper>
    );
  }

  const svgHeight = metrics.agents.length * (BAR_HEIGHT + ROW_GAP) + 40; // +40 for legend

  // Sorted by totalActiveTasks descending (busiest first)
  const sortedAgents = [...metrics.agents].sort((a, b) => b.totalActiveTasks - a.totalActiveTasks);

  // Active workflow states (exclude "done"/"closed" category for the stacked bar — show done separately)
  const activeStates = workflowStates.filter((s) => s.category !== "closed");

  return (
    <Stack gap="md">
      {/* Session summary */}
      <Group gap="lg" wrap="wrap">
        <Paper p="sm" withBorder style={{ minWidth: 120 }}>
          <Text size="xs" c="dimmed">Total Tasks</Text>
          <Text size="lg" fw={600}>{metrics.session.totalTasks}</Text>
        </Paper>
        <Paper p="sm" withBorder style={{ minWidth: 120 }}>
          <Text size="xs" c="dimmed">Active</Text>
          <Text size="lg" fw={600} c="blue">{metrics.session.activeTasks}</Text>
        </Paper>
        <Paper p="sm" withBorder style={{ minWidth: 120 }}>
          <Text size="xs" c="dimmed">Done</Text>
          <Text size="lg" fw={600} c="green">{metrics.session.doneTasks}</Text>
        </Paper>
        {metrics.session.blockedTasks > 0 && (
          <Paper p="sm" withBorder style={{ minWidth: 120 }}>
            <Text size="xs" c="dimmed">Blocked</Text>
            <Text size="lg" fw={600} c="red">{metrics.session.blockedTasks}</Text>
          </Paper>
        )}
        {metrics.session.topBottleneck && (
          <Paper p="sm" withBorder style={{ minWidth: 200, borderColor: "var(--accent-yellow)" }}>
            <Text size="xs" c="dimmed">Top Bottleneck</Text>
            <Text size="sm" fw={600} c="yellow">{metrics.session.topBottleneck.agentName}</Text>
            <Text size="xs" c="dimmed">{metrics.session.topBottleneck.reason}</Text>
          </Paper>
        )}
      </Group>

      {/* Chart */}
      <Paper p="md" withBorder>
        <Text size="sm" fw={600} mb="sm">Agent Workload</Text>

        <div style={{ overflowX: "auto" }}>
          <svg
            width="100%"
            viewBox={`0 0 800 ${svgHeight}`}
            style={{ minWidth: 600, display: "block" }}
          >
            {sortedAgents.map((agent, i) => {
              const y = i * (BAR_HEIGHT + ROW_GAP);
              const barMaxWidth = 800 - LABEL_WIDTH - BAR_PADDING_RIGHT;
              const totalTasks = agent.totalActiveTasks + agent.doneTasks;
              const scale = maxTasks > 0 ? barMaxWidth / maxTasks : 0;

              // Build segments for each active workflow state
              let xOffset = LABEL_WIDTH;
              const segments: Array<{
                x: number;
                width: number;
                color: string;
                stateId: string;
                count: number;
              }> = [];

              for (const state of activeStates) {
                const count = agent.tasksByStatus[state.id] || 0;
                if (count > 0) {
                  const w = count * scale;
                  segments.push({
                    x: xOffset,
                    width: w,
                    color: stateColorMap[state.id] || "#6b7280",
                    stateId: state.id,
                    count,
                  });
                  xOffset += w;
                }
              }

              // Done tasks segment (lighter, at the end)
              if (agent.doneTasks > 0) {
                const doneColor = stateColorMap["done"] || "#22c55e";
                const w = agent.doneTasks * scale;
                segments.push({
                  x: xOffset,
                  width: w,
                  color: doneColor,
                  stateId: "done",
                  count: agent.doneTasks,
                });
                xOffset += w;
              }

              return (
                <g
                  key={agent.agentId}
                  style={{ cursor: "pointer" }}
                  onClick={() => navigate(`/session/${sessionId}#tasks`)}
                >
                  {/* Agent name label */}
                  <text
                    x={LABEL_WIDTH - 8}
                    y={y + BAR_HEIGHT / 2 + 1}
                    textAnchor="end"
                    dominantBaseline="middle"
                    fill="var(--text-primary, #c9d1d9)"
                    fontSize={13}
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
                    width={barMaxWidth}
                    height={BAR_HEIGHT}
                    rx={4}
                    fill="var(--bg-tertiary, #161b22)"
                    opacity={0.5}
                  />

                  {/* Stacked bar segments */}
                  {segments.map((seg, si) => (
                    <Tooltip
                      key={seg.stateId}
                      label={`${stateLabelMap[seg.stateId] || seg.stateId}: ${seg.count}`}
                    >
                      <rect
                        x={seg.x}
                        y={y + 2}
                        width={Math.max(seg.width - 1, 0)}
                        height={BAR_HEIGHT - 4}
                        rx={si === 0 ? 3 : 0}
                        fill={seg.color}
                        opacity={seg.stateId === "done" ? 0.4 : 0.85}
                      />
                    </Tooltip>
                  ))}

                  {/* Task count */}
                  <text
                    x={xOffset + 8}
                    y={y + BAR_HEIGHT / 2 + 1}
                    dominantBaseline="middle"
                    fill="var(--text-secondary, #8b949e)"
                    fontSize={12}
                  >
                    {totalTasks} task{totalTasks !== 1 ? "s" : ""}
                  </text>

                  {/* Status indicators on the right */}
                  {agent.isOverloaded && (
                    <text
                      x={800 - 70}
                      y={y + BAR_HEIGHT / 2 + 1}
                      dominantBaseline="middle"
                      fill="var(--accent-red, #f85149)"
                      fontSize={14}
                    >
                      {"\u26A0"} overloaded
                    </text>
                  )}
                  {agent.isIdle && agent.totalActiveTasks === 0 && (
                    <text
                      x={800 - 50}
                      y={y + BAR_HEIGHT / 2 + 1}
                      dominantBaseline="middle"
                      fill="var(--text-muted, #484f58)"
                      fontSize={14}
                    >
                      {"\uD83D\uDCA4"}
                    </text>
                  )}
                  {!agent.isOverloaded && !agent.isIdle && agent.activity && (
                    <text
                      x={800 - 70}
                      y={y + BAR_HEIGHT / 2 + 1}
                      dominantBaseline="middle"
                      fill="var(--text-muted, #484f58)"
                      fontSize={11}
                    >
                      [{activityLabel(agent.activity)}]
                    </text>
                  )}
                </g>
              );
            })}

            {/* Legend */}
            {(() => {
              const legendY = sortedAgents.length * (BAR_HEIGHT + ROW_GAP) + 8;
              let lx = LABEL_WIDTH;
              const allStates = [...activeStates, ...workflowStates.filter((s) => s.category === "closed")];
              return (
                <g>
                  {allStates.map((state) => {
                    const x = lx;
                    lx += state.label.length * 7 + 30;
                    return (
                      <g key={state.id}>
                        <rect
                          x={x}
                          y={legendY}
                          width={12}
                          height={12}
                          rx={2}
                          fill={state.color}
                          opacity={state.category === "closed" ? 0.4 : 0.85}
                        />
                        <text
                          x={x + 16}
                          y={legendY + 10}
                          fill="var(--text-secondary, #8b949e)"
                          fontSize={11}
                        >
                          {state.label}
                        </text>
                      </g>
                    );
                  })}
                </g>
              );
            })()}
          </svg>
        </div>
      </Paper>

      {/* Load distribution summary */}
      <Group gap="sm" wrap="wrap">
        {metrics.session.loadDistribution.overloaded > 0 && (
          <Badge color="red" variant="light" size="lg">
            {metrics.session.loadDistribution.overloaded} overloaded
          </Badge>
        )}
        <Badge color="green" variant="light" size="lg">
          {metrics.session.loadDistribution.balanced} balanced
        </Badge>
        {metrics.session.loadDistribution.underutilized > 0 && (
          <Badge color="yellow" variant="light" size="lg">
            {metrics.session.loadDistribution.underutilized} underutilized
          </Badge>
        )}
        {metrics.session.loadDistribution.idle > 0 && (
          <Badge color="gray" variant="light" size="lg">
            {metrics.session.loadDistribution.idle} idle
          </Badge>
        )}
      </Group>
    </Stack>
  );
}
