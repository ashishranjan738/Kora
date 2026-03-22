import { useEffect, useState, useCallback } from "react";
import { useNavigate } from "react-router-dom";
import {
  Stack, Group, Text, Paper, Badge, Progress, Tooltip,
} from "@mantine/core";
import { useApi } from "../hooks/useApi";
import { useWebSocket } from "../hooks/useWebSocket";
import { formatCost, formatLastSeen } from "../utils/formatters";

// ---------- Types ----------

interface SessionSummary {
  id: string;
  name: string;
  status: string;
  agentCount: number;
  activeAgentCount: number;
  crashedAgentCount: number;
  stoppedAgentCount: number;
  cost: number;
  projectPath?: string;
  createdAt?: string;
  // Task metrics (optional — fetched separately)
  activeTasks?: number;
  doneTasks?: number;
  totalTasks?: number;
  lastActivity?: string;
}

// ---------- Helpers ----------

function healthColor(active: number, crashed: number, total: number): string {
  if (crashed > 0) return "var(--accent-red)";
  if (total === 0) return "var(--text-muted)";
  if (active === 0) return "var(--accent-yellow)";
  return "var(--accent-green)";
}

function taskProgress(done: number, total: number): number {
  if (total <= 0) return 0;
  return Math.round((done / total) * 100);
}

// ---------- Component ----------

export function MultiSessionDashboard() {
  const api = useApi();
  const navigate = useNavigate();
  const [sessions, setSessions] = useState<SessionSummary[]>([]);
  const [loading, setLoading] = useState(true);

  const loadSessions = useCallback(async () => {
    try {
      const data = await api.getSessions();
      const active = (data.sessions || []).filter((s: any) => s.status === "active");
      setSessions(active);
    } catch { /* ignore */ }
    finally { setLoading(false); }
  }, []);

  useEffect(() => {
    loadSessions();
    const interval = setInterval(loadSessions, 15000);
    return () => clearInterval(interval);
  }, [loadSessions]);

  // WebSocket refresh
  const handleWsEvent = useCallback((event: any) => {
    if (["session-created", "session-stopped", "agent-spawned", "agent-removed"].includes(event.type)) {
      loadSessions();
    }
  }, [loadSessions]);

  const { subscribe, unsubscribe } = useWebSocket(handleWsEvent);
  useEffect(() => {
    subscribe("*");
    return () => unsubscribe("*");
  }, [subscribe, unsubscribe]);

  // Cross-session aggregates
  const totalAgents = sessions.reduce((sum, s) => sum + (s.agentCount || 0), 0);
  const totalActive = sessions.reduce((sum, s) => sum + (s.activeAgentCount || 0), 0);
  const totalCost = sessions.reduce((sum, s) => sum + (s.cost || 0), 0);
  const totalCrashed = sessions.reduce((sum, s) => sum + (s.crashedAgentCount || 0), 0);

  if (loading) {
    return <Text size="sm" c="dimmed" ta="center" py="xl">Loading sessions...</Text>;
  }

  if (sessions.length === 0) {
    return null; // Don't render if no active sessions
  }

  return (
    <Stack gap="md">
      {/* Cross-session metrics */}
      <Paper p="sm" withBorder style={{ background: "var(--bg-secondary)" }}>
        <Group gap="lg" wrap="wrap">
          <div>
            <Text size="xs" c="dimmed">Active Sessions</Text>
            <Text size="lg" fw={700}>{sessions.length}</Text>
          </div>
          <div>
            <Text size="xs" c="dimmed">Total Agents</Text>
            <Text size="lg" fw={700}>
              <span style={{ color: "var(--accent-green)" }}>{totalActive}</span>
              <span style={{ color: "var(--text-muted)" }}> / {totalAgents}</span>
            </Text>
          </div>
          {totalCrashed > 0 && (
            <div>
              <Text size="xs" c="dimmed">Crashed</Text>
              <Text size="lg" fw={700} c="red">{totalCrashed}</Text>
            </div>
          )}
          <div>
            <Text size="xs" c="dimmed">Total Cost</Text>
            <Text size="lg" fw={700}>{formatCost(totalCost)}</Text>
          </div>
        </Group>
      </Paper>

      {/* Session cards grid */}
      <div style={{
        display: "grid",
        gridTemplateColumns: "repeat(auto-fill, minmax(280px, 1fr))",
        gap: 12,
      }}>
        {sessions.map((s) => {
          const active = s.activeAgentCount || 0;
          const crashed = s.crashedAgentCount || 0;
          const total = s.agentCount || 0;
          const done = s.doneTasks || 0;
          const totalTasks = s.totalTasks || 0;

          return (
            <Paper
              key={s.id}
              p="sm"
              withBorder
              style={{ cursor: "pointer", transition: "border-color 0.2s" }}
              onClick={() => navigate(`/session/${s.id}`)}
            >
              <Group justify="space-between" mb={6}>
                <Text size="sm" fw={600} lineClamp={1}>{s.name || "Session"}</Text>
                <span style={{
                  width: 8, height: 8, borderRadius: "50%",
                  background: healthColor(active, crashed, total),
                  flexShrink: 0,
                }} />
              </Group>

              {/* Agent breakdown */}
              <Group gap="xs" mb={6}>
                <Badge size="xs" color="green" variant="light">{active} active</Badge>
                {crashed > 0 && <Badge size="xs" color="red" variant="light">{crashed} crashed</Badge>}
                {total - active - crashed > 0 && (
                  <Badge size="xs" color="gray" variant="light">{total - active - crashed} idle</Badge>
                )}
              </Group>

              {/* Task progress */}
              {totalTasks > 0 && (
                <div style={{ marginBottom: 6 }}>
                  <Group justify="space-between" mb={2}>
                    <Text size="xs" c="dimmed">Tasks</Text>
                    <Text size="xs" c="dimmed">{done}/{totalTasks}</Text>
                  </Group>
                  <Progress value={taskProgress(done, totalTasks)} size="xs" color="blue" />
                </div>
              )}

              {/* Footer: cost + last activity */}
              <Group justify="space-between">
                <Text size="xs" c="dimmed">{formatCost(s.cost)}</Text>
                {s.createdAt && (
                  <Tooltip label={`Started: ${new Date(s.createdAt).toLocaleString()}`}>
                    <Text size="xs" c="dimmed">{formatLastSeen(s.createdAt)}</Text>
                  </Tooltip>
                )}
              </Group>
            </Paper>
          );
        })}
      </div>
    </Stack>
  );
}
