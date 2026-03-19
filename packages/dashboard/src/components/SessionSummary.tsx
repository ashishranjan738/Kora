import { useEffect, useState, useCallback } from "react";
import { Badge, Group, Paper, Text, Tooltip, Progress, Button, Stack } from "@mantine/core";
import { useApi } from "../hooks/useApi";

interface SessionSummaryProps {
  sessionId: string;
  agents: Array<{
    id: string;
    name?: string;
    status: string;
    config?: { name?: string };
    startedAt?: string;
  }>;
  onNudgeAgent?: (agentId: string) => void;
  onBroadcast?: () => void;
}

interface TaskData {
  id: string;
  title: string;
  status: string;
  assignedTo?: string;
  createdAt?: string;
  updatedAt?: string;
}

function formatDuration(ms: number): string {
  if (ms < 0) return "--";
  const totalMin = Math.floor(ms / 60000);
  if (totalMin < 60) return `${totalMin}m`;
  const hours = Math.floor(totalMin / 60);
  const mins = totalMin % 60;
  return mins > 0 ? `${hours}h ${mins}m` : `${hours}h`;
}

export function SessionSummary({ sessionId, agents, onNudgeAgent, onBroadcast }: SessionSummaryProps) {
  const api = useApi();
  const [tasks, setTasks] = useState<TaskData[]>([]);
  const [loading, setLoading] = useState(true);

  const fetchTasks = useCallback(async () => {
    try {
      const data = await api.getTasks(sessionId);
      setTasks(data.tasks || []);
    } catch {
      // ignore
    } finally {
      setLoading(false);
    }
  }, [sessionId]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    fetchTasks();
    const interval = setInterval(fetchTasks, 10000);
    return () => clearInterval(interval);
  }, [fetchTasks]);

  // Agent metrics
  const activeAgents = agents.filter((a) => a.status === "running" || a.status === "idle" || a.status === "waiting");
  const idleAgents = agents.filter((a) => a.status === "idle");
  const crashedAgents = agents.filter((a) => a.status === "crashed" || a.status === "error");

  // Task metrics
  const doneTasks = tasks.filter((t) => t.status === "done");
  const inProgressTasks = tasks.filter((t) => t.status === "in-progress");
  const pendingTasks = tasks.filter((t) => t.status === "pending");
  const totalTasks = tasks.length;
  const completionPct = totalTasks > 0 ? Math.round((doneTasks.length / totalTasks) * 100) : 0;

  // Bottleneck: agent with most assigned pending/in-progress tasks
  const agentTaskCounts = new Map<string, number>();
  for (const t of [...pendingTasks, ...inProgressTasks]) {
    if (t.assignedTo) {
      agentTaskCounts.set(t.assignedTo, (agentTaskCounts.get(t.assignedTo) || 0) + 1);
    }
  }
  let bottleneckAgent: { id: string; name: string; count: number } | null = null;
  for (const [agentId, count] of agentTaskCounts) {
    if (!bottleneckAgent || count > bottleneckAgent.count) {
      const agent = agents.find((a) => a.id === agentId);
      bottleneckAgent = { id: agentId, name: agent?.config?.name || agent?.name || agentId, count };
    }
  }

  // Session duration
  const earliestStart = agents
    .map((a) => a.startedAt)
    .filter(Boolean)
    .map((s) => new Date(s!).getTime())
    .sort((a, b) => a - b)[0];
  const sessionDuration = earliestStart ? Date.now() - earliestStart : 0;

  // Average task completion time
  const completionTimes = doneTasks
    .filter((t) => t.createdAt && t.updatedAt)
    .map((t) => new Date(t.updatedAt!).getTime() - new Date(t.createdAt!).getTime())
    .filter((ms) => ms > 0);
  const avgCompletionMs = completionTimes.length > 0
    ? completionTimes.reduce((sum, t) => sum + t, 0) / completionTimes.length
    : 0;

  if (loading) return null;

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
      <Text fw={600} size="sm" c="var(--text-primary)" mb={12}>
        Session Overview
      </Text>

      {/* Top metrics row */}
      <Group gap="lg" mb={12} wrap="wrap">
        {/* Agents */}
        <div>
          <Text size="xs" c="dimmed" mb={2}>Agents</Text>
          <Group gap={4}>
            <Badge variant="light" color="green" size="sm">{activeAgents.length} active</Badge>
            {idleAgents.length > 0 && <Badge variant="light" color="gray" size="sm">{idleAgents.length} idle</Badge>}
            {crashedAgents.length > 0 && <Badge variant="filled" color="red" size="sm">{crashedAgents.length} crashed</Badge>}
          </Group>
        </div>

        {/* Tasks */}
        <div>
          <Text size="xs" c="dimmed" mb={2}>Tasks</Text>
          <Group gap={4}>
            <Badge variant="light" color="green" size="sm">{doneTasks.length} done</Badge>
            {inProgressTasks.length > 0 && <Badge variant="light" color="blue" size="sm">{inProgressTasks.length} in progress</Badge>}
            {pendingTasks.length > 0 && <Badge variant="light" color="gray" size="sm">{pendingTasks.length} pending</Badge>}
          </Group>
        </div>

        {/* Time */}
        <div>
          <Text size="xs" c="dimmed" mb={2}>Time</Text>
          <Group gap={8}>
            <Text size="sm" c="var(--text-primary)">{formatDuration(sessionDuration)}</Text>
            {avgCompletionMs > 0 && (
              <Tooltip label="Average task completion time" withArrow>
                <Text size="xs" c="dimmed">avg {formatDuration(avgCompletionMs)}/task</Text>
              </Tooltip>
            )}
          </Group>
        </div>
      </Group>

      {/* Progress bar */}
      {totalTasks > 0 && (
        <div style={{ marginBottom: 12 }}>
          <Group justify="space-between" mb={4}>
            <Text size="xs" c="dimmed">Task Progress</Text>
            <Text size="xs" c="dimmed">{completionPct}% ({doneTasks.length}/{totalTasks})</Text>
          </Group>
          <Progress
            value={completionPct}
            color={completionPct === 100 ? "green" : "blue"}
            size="md"
            radius="xl"
            styles={{ root: { backgroundColor: "var(--bg-tertiary)" } }}
          />
        </div>
      )}

      {/* Bottleneck indicator */}
      {bottleneckAgent && bottleneckAgent.count >= 2 && (
        <Paper
          p="xs"
          withBorder
          style={{
            backgroundColor: "rgba(210,153,34,0.06)",
            borderColor: "rgba(210,153,34,0.2)",
            marginBottom: 12,
          }}
        >
          <Group gap={8}>
            <Text size="xs" c="var(--accent-yellow)" fw={600}>Bottleneck</Text>
            <Text size="xs" c="var(--text-secondary)">
              {bottleneckAgent.name} has {bottleneckAgent.count} pending tasks
            </Text>
          </Group>
        </Paper>
      )}

      {/* Quick actions */}
      <Group gap={8}>
        {idleAgents.length > 0 && onNudgeAgent && (
          <Tooltip label={`Nudge ${idleAgents.length} idle agent${idleAgents.length !== 1 ? "s" : ""}`} withArrow>
            <Button
              size="xs"
              variant="light"
              color="yellow"
              onClick={() => idleAgents.forEach((a) => onNudgeAgent(a.id))}
            >
              Nudge idle ({idleAgents.length})
            </Button>
          </Tooltip>
        )}
        {onBroadcast && agents.length > 0 && (
          <Button size="xs" variant="light" color="blue" onClick={onBroadcast}>
            Broadcast
          </Button>
        )}
      </Group>
    </Paper>
  );
}
