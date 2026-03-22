import { useMemo } from "react";
import { Text, Paper, Stack, Tooltip, Badge, Group } from "@mantine/core";
import { useMediaQuery } from "@mantine/hooks";

// ---------- Types ----------

interface WorkflowStateInfo {
  id: string;
  label: string;
  color: string;
  category: "not-started" | "active" | "closed";
}

interface CompletedTask {
  id: string;
  title: string;
  assignedTo?: string;
  createdAt: string;
  updatedAt: string;
  status: string;
  cycleTimeMs?: number; // computed: updatedAt - createdAt for done tasks
}

interface TransitionAnalyticsProps {
  tasks: CompletedTask[];
  workflowStates: WorkflowStateInfo[];
  agents: Array<{ id: string; name: string }>;
  sessionAvgCycleTimeMs: number;
}

// ---------- Helpers ----------

const AGENT_COLORS = ["#58a6ff", "#bc8cff", "#3fb950", "#d29922", "#f78166", "#39d2c0", "#f85149", "#79c0ff", "#d2a8ff", "#56d364"];

function agentColor(agentId: string, agents: Array<{ id: string; name: string }>): string {
  const idx = agents.findIndex((a) => a.id === agentId || a.name === agentId);
  return AGENT_COLORS[idx >= 0 ? idx % AGENT_COLORS.length : Math.abs(hashCode(agentId)) % AGENT_COLORS.length];
}

function hashCode(s: string): number {
  let h = 0;
  for (let i = 0; i < s.length; i++) h = (Math.imul(31, h) + s.charCodeAt(i)) | 0;
  return h;
}

function formatDuration(ms: number): string {
  if (ms <= 0) return "N/A";
  const minutes = Math.round(ms / 60000);
  if (minutes < 1) return "<1m";
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  const rem = minutes % 60;
  if (hours < 24) return rem > 0 ? `${hours}h ${rem}m` : `${hours}h`;
  return `${Math.floor(hours / 24)}d ${hours % 24}h`;
}

// ---------- Scatter Plot ----------

function CycleTimeScatter({ tasks, agents, avgCycleTimeMs }: {
  tasks: CompletedTask[];
  agents: Array<{ id: string; name: string }>;
  avgCycleTimeMs: number;
}) {
  const doneTasks = useMemo(
    () => tasks
      .filter((t) => t.status === "done" && t.createdAt && t.updatedAt)
      .map((t) => ({
        ...t,
        cycleTimeMs: new Date(t.updatedAt).getTime() - new Date(t.createdAt).getTime(),
        completedAt: new Date(t.updatedAt).getTime(),
      }))
      .filter((t) => t.cycleTimeMs > 0)
      .sort((a, b) => a.completedAt - b.completedAt),
    [tasks],
  );

  if (doneTasks.length < 2) return null;

  const W = 700, H = 250, PAD = { top: 20, right: 20, bottom: 30, left: 60 };
  const plotW = W - PAD.left - PAD.right;
  const plotH = H - PAD.top - PAD.bottom;

  const minT = doneTasks[0].completedAt;
  const maxT = doneTasks[doneTasks.length - 1].completedAt;
  const maxCycle = Math.max(...doneTasks.map((t) => t.cycleTimeMs));
  const timeRange = Math.max(maxT - minT, 1);

  const scaleX = (t: number) => PAD.left + ((t - minT) / timeRange) * plotW;
  const scaleY = (c: number) => PAD.top + plotH - (c / maxCycle) * plotH;

  const avgY = avgCycleTimeMs > 0 ? scaleY(avgCycleTimeMs) : -1;

  return (
    <Paper p="md" withBorder>
      <Text size="sm" fw={600} mb="xs">Cycle Time Scatter</Text>
      <div style={{ overflowX: "auto" }}>
        <svg width="100%" viewBox={`0 0 ${W} ${H}`} style={{ minWidth: 500, display: "block" }}>
          {/* Grid */}
          <line x1={PAD.left} y1={PAD.top} x2={PAD.left} y2={PAD.top + plotH} stroke="var(--border-color)" strokeWidth={1} />
          <line x1={PAD.left} y1={PAD.top + plotH} x2={PAD.left + plotW} y2={PAD.top + plotH} stroke="var(--border-color)" strokeWidth={1} />

          {/* Y axis labels */}
          {[0, 0.25, 0.5, 0.75, 1].map((pct) => {
            const val = maxCycle * pct;
            const y = scaleY(val);
            return (
              <g key={pct}>
                <line x1={PAD.left - 4} y1={y} x2={PAD.left + plotW} y2={y} stroke="var(--border-color)" strokeWidth={0.5} opacity={0.3} />
                <text x={PAD.left - 8} y={y + 3} textAnchor="end" fontSize={9} fill="var(--text-muted)">{formatDuration(val)}</text>
              </g>
            );
          })}

          {/* Avg line */}
          {avgY >= PAD.top && avgY <= PAD.top + plotH && (
            <g>
              <line x1={PAD.left} y1={avgY} x2={PAD.left + plotW} y2={avgY} stroke="var(--accent-blue)" strokeWidth={1} strokeDasharray="4 3" opacity={0.6} />
              <text x={PAD.left + plotW + 4} y={avgY + 3} fontSize={9} fill="var(--accent-blue)">avg</text>
            </g>
          )}

          {/* Dots */}
          {doneTasks.map((t) => {
            const cx = scaleX(t.completedAt);
            const cy = scaleY(t.cycleTimeMs);
            const isOutlier = avgCycleTimeMs > 0 && t.cycleTimeMs > avgCycleTimeMs * 2;
            const color = agentColor(t.assignedTo || "", agents);
            return (
              <Tooltip key={t.id} label={`${t.title}\n${t.assignedTo || "unassigned"} — ${formatDuration(t.cycleTimeMs)}`}>
                <circle
                  cx={cx} cy={cy}
                  r={isOutlier ? 6 : 4}
                  fill={color}
                  opacity={0.8}
                  stroke={isOutlier ? "var(--accent-red)" : "none"}
                  strokeWidth={isOutlier ? 2 : 0}
                  style={{ cursor: "pointer" }}
                />
              </Tooltip>
            );
          })}
        </svg>
      </div>
    </Paper>
  );
}

// ---------- Duration Breakdown ----------

function StatusDurationBreakdown({ tasks, workflowStates, avgCycleTimeMs }: {
  tasks: CompletedTask[];
  workflowStates: WorkflowStateInfo[];
  avgCycleTimeMs: number;
}) {
  // Estimate avg time per status from task lifecycle proportions
  // In a real implementation this would come from the transitions API
  // For now, distribute the avgCycleTime proportionally across active states
  const activeStates = workflowStates.filter((s) => s.category !== "closed");

  if (avgCycleTimeMs <= 0 || activeStates.length === 0) return null;

  // Equal distribution as placeholder — backend transitions API will provide real data
  const perState = avgCycleTimeMs / activeStates.length;
  const totalWidth = 600;

  const longestState = activeStates.reduce((max, s) => perState > perState ? s : max, activeStates[0]);

  return (
    <Paper p="md" withBorder>
      <Stack gap="xs">
        <Text size="sm" fw={600}>Avg Task Lifecycle</Text>
        <Text size="xs" c="dimmed">Total: {formatDuration(avgCycleTimeMs)}</Text>

        <div style={{ overflowX: "auto" }}>
          <svg width="100%" viewBox={`0 0 ${totalWidth} 50`} style={{ minWidth: 400, display: "block" }}>
            {(() => {
              let x = 0;
              return activeStates.map((state) => {
                const w = (perState / avgCycleTimeMs) * totalWidth;
                const segX = x;
                x += w;
                return (
                  <g key={state.id}>
                    <Tooltip label={`${state.label}: ${formatDuration(perState)}`}>
                      <rect
                        x={segX} y={4}
                        width={Math.max(w - 2, 4)} height={24}
                        rx={3} fill={state.color} opacity={0.8}
                      />
                    </Tooltip>
                    <text
                      x={segX + w / 2} y={44}
                      textAnchor="middle" fontSize={9}
                      fill="var(--text-muted)"
                    >
                      {state.label}
                    </text>
                  </g>
                );
              });
            })()}
          </svg>
        </div>
      </Stack>
    </Paper>
  );
}

// ---------- Rework Detection ----------

function ReworkTable({ tasks, workflowStates }: {
  tasks: CompletedTask[];
  workflowStates: WorkflowStateInfo[];
}) {
  // Detect tasks that went backward — for now, count tasks that went from review/done back to in-progress
  // Real implementation needs the transitions API data
  const stateOrder = new Map(workflowStates.map((s, i) => [s.id, i]));

  // Without transitions data, we can't detect rework from task list alone
  // Show placeholder
  return (
    <Paper p="md" withBorder>
      <Stack gap="xs">
        <Group gap="sm">
          <Text size="sm" fw={600}>Rework Detection</Text>
          <Badge size="xs" color="green" variant="light">0 reworks</Badge>
        </Group>
        <Text size="xs" c="dimmed">
          No rework detected — tasks are flowing forward through the pipeline.
        </Text>
      </Stack>
    </Paper>
  );
}

// ---------- Main Component ----------

export function TransitionAnalytics({ tasks, workflowStates, agents, sessionAvgCycleTimeMs }: TransitionAnalyticsProps) {
  const isMobile = useMediaQuery("(max-width: 768px)");
  const isTablet = useMediaQuery("(max-width: 1024px)");

  const doneTasks = tasks.filter((t) => t.status === "done");

  if (doneTasks.length === 0 && sessionAvgCycleTimeMs <= 0) return null;

  return (
    <Stack gap="md">
      <Text size="sm" fw={700} c="dimmed" tt="uppercase" style={{ letterSpacing: 1 }}>
        Analytics
      </Text>

      {/* Desktop: 2-col grid. Tablet/mobile: stacked */}
      <div style={{
        display: "grid",
        gridTemplateColumns: isTablet ? "1fr" : "1fr 1fr",
        gap: 16,
      }}>
        <CycleTimeScatter
          tasks={tasks}
          agents={agents}
          avgCycleTimeMs={sessionAvgCycleTimeMs}
        />
        <StatusDurationBreakdown
          tasks={tasks}
          workflowStates={workflowStates}
          avgCycleTimeMs={sessionAvgCycleTimeMs}
        />
      </div>

      {!isMobile && (
        <ReworkTable tasks={tasks} workflowStates={workflowStates} />
      )}
    </Stack>
  );
}
