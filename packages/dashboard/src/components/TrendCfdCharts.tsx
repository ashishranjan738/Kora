import { useEffect, useState, useCallback, useMemo } from "react";
import { Text, Paper, Stack, Tooltip, Badge, Group } from "@mantine/core";
import { useApi } from "../hooks/useApi";

// ---------- Types ----------

interface TrendDataPoint {
  taskSequence: number;
  taskTitle: string;
  cycleTimeMs: number;
  rollingAvgMs: number;
  completedAt: string;
}

interface CfdDataPoint {
  timestamp: string;
  counts: Record<string, number>;
}

interface WorkflowStateInfo {
  id: string;
  label: string;
  color: string;
  category: "not-started" | "active" | "closed";
}

interface TrendCfdChartsProps {
  sessionId: string;
  workflowStates: WorkflowStateInfo[];
}

// ---------- Helpers ----------

function formatDuration(ms: number): string {
  if (ms <= 0) return "N/A";
  const minutes = Math.round(ms / 60000);
  if (minutes < 1) return "<1m";
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  const rem = minutes % 60;
  return rem > 0 ? `${hours}h ${rem}m` : `${hours}h`;
}

function formatTime(iso: string): string {
  const d = new Date(iso);
  return d.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
}

// ---------- Cycle Time Trend Chart ----------

function CycleTimeTrend({ data }: { data: TrendDataPoint[] }) {
  if (data.length < 5) {
    return (
      <Paper p="md" withBorder>
        <Text size="sm" fw={600} mb="xs">Cycle Time Trend</Text>
        <Text size="xs" c="dimmed">Need 5+ completed tasks to show trend.</Text>
      </Paper>
    );
  }

  const W = 700, H = 220, PAD = { top: 20, right: 30, bottom: 30, left: 60 };
  const plotW = W - PAD.left - PAD.right;
  const plotH = H - PAD.top - PAD.bottom;

  const maxCycle = Math.max(...data.map((d) => Math.max(d.cycleTimeMs, d.rollingAvgMs)));
  const scaleX = (seq: number) => PAD.left + ((seq - 1) / Math.max(data.length - 1, 1)) * plotW;
  const scaleY = (ms: number) => PAD.top + plotH - (ms / maxCycle) * plotH;

  // Trend direction
  const firstAvg = data[0].rollingAvgMs;
  const lastAvg = data[data.length - 1].rollingAvgMs;
  const improving = lastAvg < firstAvg;
  const changePct = firstAvg > 0 ? Math.round(Math.abs(lastAvg - firstAvg) / firstAvg * 100) : 0;

  // Build rolling avg line path
  const linePath = data
    .map((d, i) => `${i === 0 ? "M" : "L"} ${scaleX(d.taskSequence)} ${scaleY(d.rollingAvgMs)}`)
    .join(" ");

  const trendColor = improving ? "var(--accent-green, #3fb950)" : "var(--accent-red, #f85149)";

  return (
    <Paper p="md" withBorder>
      <Group justify="space-between" mb="xs">
        <Text size="sm" fw={600}>Cycle Time Trend</Text>
        <Badge
          size="sm"
          color={improving ? "green" : "red"}
          variant="light"
        >
          {improving ? "\u2193" : "\u2191"} {changePct}% {improving ? "faster" : "slower"}
        </Badge>
      </Group>

      <div style={{ overflowX: "auto" }}>
        <svg width="100%" viewBox={`0 0 ${W} ${H}`} style={{ minWidth: 450, display: "block" }}>
          {/* Grid */}
          <line x1={PAD.left} y1={PAD.top} x2={PAD.left} y2={PAD.top + plotH} stroke="var(--border-color)" strokeWidth={1} />
          <line x1={PAD.left} y1={PAD.top + plotH} x2={PAD.left + plotW} y2={PAD.top + plotH} stroke="var(--border-color)" strokeWidth={1} />

          {/* Y axis labels */}
          {[0, 0.25, 0.5, 0.75, 1].map((pct) => {
            const val = maxCycle * pct;
            const y = scaleY(val);
            return (
              <g key={pct}>
                <line x1={PAD.left} y1={y} x2={PAD.left + plotW} y2={y} stroke="var(--border-color)" strokeWidth={0.5} opacity={0.2} />
                <text x={PAD.left - 8} y={y + 3} textAnchor="end" fontSize={9} fill="var(--text-muted)">{formatDuration(val)}</text>
              </g>
            );
          })}

          {/* Individual task dots */}
          {data.map((d) => (
            <Tooltip key={d.taskSequence} label={`#${d.taskSequence}: ${d.taskTitle}\n${formatDuration(d.cycleTimeMs)} (avg: ${formatDuration(d.rollingAvgMs)})`}>
              <circle
                cx={scaleX(d.taskSequence)}
                cy={scaleY(d.cycleTimeMs)}
                r={3}
                fill="var(--text-muted)"
                opacity={0.4}
              />
            </Tooltip>
          ))}

          {/* Rolling average line */}
          <path
            d={linePath}
            fill="none"
            stroke={trendColor}
            strokeWidth={2.5}
            strokeLinecap="round"
            strokeLinejoin="round"
          />

          {/* X axis: task numbers */}
          {data.filter((_, i) => i % Math.max(1, Math.floor(data.length / 6)) === 0 || i === data.length - 1).map((d) => (
            <text
              key={d.taskSequence}
              x={scaleX(d.taskSequence)}
              y={PAD.top + plotH + 16}
              textAnchor="middle"
              fontSize={9}
              fill="var(--text-muted)"
            >
              #{d.taskSequence}
            </text>
          ))}
        </svg>
      </div>
    </Paper>
  );
}

// ---------- Cumulative Flow Diagram ----------

function CumulativeFlowDiagram({ data, workflowStates }: { data: CfdDataPoint[]; workflowStates: WorkflowStateInfo[] }) {
  if (data.length < 3) {
    return (
      <Paper p="md" withBorder>
        <Text size="sm" fw={600} mb="xs">Cumulative Flow</Text>
        <Text size="xs" c="dimmed">Need more data points to show flow diagram.</Text>
      </Paper>
    );
  }

  const W = 700, H = 250, PAD = { top: 20, right: 20, bottom: 40, left: 50 };
  const plotW = W - PAD.left - PAD.right;
  const plotH = H - PAD.top - PAD.bottom;

  // Get all state IDs present in data
  const stateIds = workflowStates.map((s) => s.id);
  const stateColorMap = Object.fromEntries(workflowStates.map((s) => [s.id, s.color]));
  const stateLabelMap = Object.fromEntries(workflowStates.map((s) => [s.id, s.label]));

  // Compute max total
  const maxTotal = Math.max(1, ...data.map((d) => {
    let sum = 0;
    for (const id of stateIds) sum += d.counts[id] || 0;
    return sum;
  }));

  const scaleX = (i: number) => PAD.left + (i / Math.max(data.length - 1, 1)) * plotW;
  const scaleY = (v: number) => PAD.top + plotH - (v / maxTotal) * plotH;

  // Build stacked area paths (bottom to top)
  const areas: Array<{ stateId: string; path: string; color: string }> = [];

  for (let si = stateIds.length - 1; si >= 0; si--) {
    const stateId = stateIds[si];
    const topLine: string[] = [];
    const bottomLine: string[] = [];

    for (let i = 0; i < data.length; i++) {
      // Sum of all states below (including this one)
      let cumTop = 0;
      for (let j = 0; j <= si; j++) cumTop += data[i].counts[stateIds[j]] || 0;
      let cumBottom = 0;
      for (let j = 0; j < si; j++) cumBottom += data[i].counts[stateIds[j]] || 0;

      const x = scaleX(i);
      topLine.push(`${i === 0 ? "M" : "L"} ${x} ${scaleY(cumTop)}`);
      bottomLine.unshift(`L ${x} ${scaleY(cumBottom)}`);
    }

    const path = topLine.join(" ") + " " + bottomLine.join(" ") + " Z";
    areas.push({ stateId, path, color: stateColorMap[stateId] || "#6b7280" });
  }

  return (
    <Paper p="md" withBorder>
      <Text size="sm" fw={600} mb="xs">Cumulative Flow</Text>

      <div style={{ overflowX: "auto" }}>
        <svg width="100%" viewBox={`0 0 ${W} ${H}`} style={{ minWidth: 450, display: "block" }}>
          {/* Grid */}
          <line x1={PAD.left} y1={PAD.top} x2={PAD.left} y2={PAD.top + plotH} stroke="var(--border-color)" strokeWidth={1} />
          <line x1={PAD.left} y1={PAD.top + plotH} x2={PAD.left + plotW} y2={PAD.top + plotH} stroke="var(--border-color)" strokeWidth={1} />

          {/* Stacked areas */}
          {areas.map((a) => (
            <path key={a.stateId} d={a.path} fill={a.color} opacity={0.5} />
          ))}

          {/* Y axis */}
          {[0, 0.25, 0.5, 0.75, 1].map((pct) => {
            const val = Math.round(maxTotal * pct);
            return (
              <text key={pct} x={PAD.left - 8} y={scaleY(val) + 3} textAnchor="end" fontSize={9} fill="var(--text-muted)">
                {val}
              </text>
            );
          })}

          {/* X axis: timestamps */}
          {data.filter((_, i) => i % Math.max(1, Math.floor(data.length / 5)) === 0 || i === data.length - 1).map((d, i) => (
            <text
              key={i}
              x={scaleX(data.indexOf(d))}
              y={PAD.top + plotH + 16}
              textAnchor="middle"
              fontSize={9}
              fill="var(--text-muted)"
            >
              {formatTime(d.timestamp)}
            </text>
          ))}
        </svg>
      </div>

      {/* Legend */}
      <Group gap="sm" mt="xs" wrap="wrap">
        {workflowStates.map((s) => (
          <Group key={s.id} gap={4}>
            <span style={{ width: 10, height: 10, borderRadius: 2, background: s.color, opacity: 0.6, display: "inline-block" }} />
            <Text size="xs" c="dimmed">{s.label}</Text>
          </Group>
        ))}
      </Group>
    </Paper>
  );
}

// ---------- Main Component ----------

export function TrendCfdCharts({ sessionId, workflowStates }: TrendCfdChartsProps) {
  const api = useApi();
  const [trendData, setTrendData] = useState<TrendDataPoint[]>([]);
  const [cfdData, setCfdData] = useState<CfdDataPoint[]>([]);
  const [loaded, setLoaded] = useState(false);

  const loadData = useCallback(async () => {
    try {
      const [trend, cfd] = await Promise.allSettled([
        api.getTaskMetricsTrend(sessionId),
        api.getTaskMetricsCfd(sessionId),
      ]);
      if (trend.status === "fulfilled") setTrendData(trend.value.dataPoints || []);
      if (cfd.status === "fulfilled") setCfdData(cfd.value.dataPoints || []);
    } catch {
      // Non-critical
    } finally {
      setLoaded(true);
    }
  }, [sessionId]);

  useEffect(() => { loadData(); }, [loadData]);

  if (!loaded) return null;
  if (trendData.length < 5 && cfdData.length < 3) return null;

  return (
    <Stack gap="md">
      <CycleTimeTrend data={trendData} />
      <CumulativeFlowDiagram data={cfdData} workflowStates={workflowStates} />
    </Stack>
  );
}
