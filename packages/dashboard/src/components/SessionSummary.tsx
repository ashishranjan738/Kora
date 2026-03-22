import { useEffect, useState, useCallback } from "react";
import { ActionIcon, Badge, Group, Paper, Text, Tooltip, Progress, Button, Stack } from "@mantine/core";
import { useApi } from "../hooks/useApi";
import { AgentTopology } from "./AgentTopology";
import { extractCostData, hasCostData } from "./CostSummary";

interface SessionSummaryProps {
  sessionId: string;
  agents: Array<{
    id: string;
    name?: string;
    status: string;
    config?: { name?: string };
    startedAt?: string;
    cost?: { totalCostUsd?: number; totalTokensIn?: number; totalTokensOut?: number; contextWindowPercent?: number };
  }>;
  onNudgeAgent?: (agentId: string) => void;
  onBroadcast?: () => void;
  onAgentClick?: (agentId: string) => void;
  workflowStates?: Array<{ id: string; label: string; color: string; category?: string }>;
}

interface TaskData {
  id: string;
  title: string;
  status: string;
  assignedTo?: string;
  createdAt?: string;
  updatedAt?: string;
}

function fmtTokens(n: number): string {
  if (n >= 1000000) return (n / 1000000).toFixed(1) + "M";
  if (n >= 1000) return (n / 1000).toFixed(1) + "k";
  return String(n);
}

function formatDuration(ms: number): string {
  if (ms < 0) return "--";
  const totalMin = Math.floor(ms / 60000);
  if (totalMin < 60) return `${totalMin}m`;
  const hours = Math.floor(totalMin / 60);
  const mins = totalMin % 60;
  return mins > 0 ? `${hours}h ${mins}m` : `${hours}h`;
}

export function SessionSummary({ sessionId, agents, onNudgeAgent, onBroadcast, onAgentClick, workflowStates }: SessionSummaryProps) {
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

  // Task metrics - use workflow state categories when available
  const catMap: Record<string, string> = {};
  if (workflowStates?.length) { for (const s of workflowStates) { if (s.category) catMap[s.id] = s.category; } }
  const doneTasks = tasks.filter((t) => { const c = catMap[t.status]; return c ? c === "closed" : t.status === "done"; });
  const inProgressTasks = tasks.filter((t) => { const c = catMap[t.status]; return c ? c === "active" : t.status === "in-progress" || t.status === "review"; });
  const pendingTasks = tasks.filter((t) => { const c = catMap[t.status]; return c ? c === "not-started" : t.status === "pending" || t.status === "backlog"; });
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

  // Cost metrics
  const totalCost = agents.reduce((sum, a) => sum + (a.cost?.totalCostUsd || 0), 0);
  const totalTokensIn = agents.reduce((sum, a) => sum + (a.cost?.totalTokensIn || 0), 0);
  const totalTokensOut = agents.reduce((sum, a) => sum + (a.cost?.totalTokensOut || 0), 0);

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
      <Group justify="space-between" mb={12}>
        <Text fw={600} size="sm" c="var(--text-primary)">
          Session Overview
        </Text>
        <Tooltip label="Refresh metrics (polls terminal output)" withArrow>
          <ActionIcon
            variant="subtle"
            size="sm"
            onClick={async () => {
              try { await api.pollUsage(sessionId); fetchTasks(); } catch {}
            }}
            style={{ color: "var(--text-muted)" }}
          >
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <polyline points="23 4 23 10 17 10" /><polyline points="1 20 1 14 7 14" />
              <path d="M3.51 9a9 9 0 0 1 14.85-3.36L23 10M1 14l4.64 4.36A9 9 0 0 0 20.49 15" />
            </svg>
          </ActionIcon>
        </Tooltip>
      </Group>

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

        {/* Cost */}
        {totalCost > 0 && (
          <div>
            <Text size="xs" c="dimmed" mb={2}>Cost</Text>
            <Group gap={8}>
              <Text size="sm" fw={600} c="var(--text-primary)">${totalCost.toFixed(2)}</Text>
              <Tooltip label={`${totalTokensIn.toLocaleString()} in / ${totalTokensOut.toLocaleString()} out`} withArrow>
                <Text size="xs" c="dimmed">
                  {((totalTokensIn + totalTokensOut) / 1000).toFixed(1)}k tokens
                </Text>
              </Tooltip>
            </Group>
          </div>
        )}

        {/* Context Window — shown when agents report it (e.g. Kiro) */}
        {(() => {
          const agentsWithContext = agents.filter(a => a.cost?.contextWindowPercent != null && a.cost.contextWindowPercent > 0);
          if (agentsWithContext.length === 0) return null;
          const avgContext = Math.round(agentsWithContext.reduce((sum, a) => sum + (a.cost?.contextWindowPercent || 0), 0) / agentsWithContext.length);
          const maxContext = Math.max(...agentsWithContext.map(a => a.cost?.contextWindowPercent || 0));
          return (
            <div>
              <Text size="xs" c="dimmed" mb={2}>Context Window</Text>
              <Group gap={8}>
                <Text size="sm" fw={600} c={maxContext > 80 ? "var(--accent-red)" : maxContext > 50 ? "var(--accent-yellow)" : "var(--text-primary)"}>{avgContext}% avg</Text>
                <Tooltip label={`Highest: ${maxContext}% — ${agentsWithContext.length} agent${agentsWithContext.length !== 1 ? "s" : ""} reporting`} withArrow>
                  <Text size="xs" c="dimmed">max {maxContext}%</Text>
                </Tooltip>
              </Group>
            </div>
          );
        })()}
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

      {/* Per-agent cost breakdown (bar chart) */}
      {hasCostData(agents) && agents.length > 0 && (() => {
        const agentCosts = agents.map((a) => {
          const { tokensIn, tokensOut, costUsd } = extractCostData(a);
          return { id: a.id, name: a.config?.name || a.name || "Agent", tokensIn, tokensOut, costUsd };
        }).sort((a, b) => b.costUsd - a.costUsd);

        return (
          <div style={{ marginTop: 16 }}>
            <Text size="xs" c="dimmed" fw={500} mb={6}>Cost by Agent</Text>
            <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
              {agentCosts.map((agent) => {
                const pct = totalCost > 0 ? Math.round((agent.costUsd / totalCost) * 100) : 0;
                return (
                  <Tooltip
                    key={agent.id}
                    label={`${agent.name}: $${agent.costUsd.toFixed(2)} | ${fmtTokens(agent.tokensIn)} in, ${fmtTokens(agent.tokensOut)} out`}
                    withArrow
                    multiline
                    w={280}
                  >
                    <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
                      <Text size="xs" c="dimmed" style={{ minWidth: 90, textAlign: "right", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
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
          </div>
        );
      })()}

      {/* Agent Topology */}
      {agents.length > 1 && (
        <div style={{ marginTop: 16 }}>
          <AgentTopology agents={agents} onAgentClick={onAgentClick} />
        </div>
      )}
    </Paper>
  );
}
