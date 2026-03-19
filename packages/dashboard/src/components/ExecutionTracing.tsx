import { useState, useEffect, useCallback } from "react";
import { useApi } from "../hooks/useApi";
import {
  Stack,
  Group,
  Text,
  Badge,
  Paper,
  Collapse,
  Progress,
  Timeline,
  Alert,
  Loader,
  ActionIcon,
  Tooltip,
  Box,
} from "@mantine/core";

interface AgentExecutionStatus {
  name: string;
  role: "master" | "worker";
  status: "pending" | "spawning" | "spawned" | "failed";
  agentId?: string;
  error?: string;
}

interface PlaybookExecution {
  id: string;
  sessionId: string;
  playbookName: string;
  status: "pending" | "running" | "complete" | "partial" | "failed";
  agents: AgentExecutionStatus[];
  startedAt: string;
  completedAt?: string;
  error?: string;
  taskIds?: string[];
  variables?: Record<string, string>;
  phase?: "setup" | "execute" | "finalize";
  dryRun?: boolean;
}

interface PlaybookEventData {
  executionId?: string;
  sessionId?: string;
  playbookName?: string;
  phase?: "setup" | "execute" | "finalize";
  agents?: AgentExecutionStatus[];
  taskIds?: string[];
  error?: string;
  variables?: Record<string, string>;
  dryRun?: boolean;
}

interface ExecutionTracingProps {
  sessionId: string;
}

const STATUS_COLORS: Record<string, string> = {
  pending: "gray",
  running: "blue",
  complete: "green",
  partial: "yellow",
  failed: "red",
};

const AGENT_STATUS_COLORS: Record<string, string> = {
  pending: "gray",
  spawning: "blue",
  spawned: "green",
  failed: "red",
};

const PHASE_LABELS: Record<string, string> = {
  setup: "Setup",
  execute: "Execute",
  finalize: "Finalize",
};

function formatDuration(startedAt: string, completedAt?: string): string {
  const start = new Date(startedAt).getTime();
  const end = completedAt ? new Date(completedAt).getTime() : Date.now();
  const diffMs = end - start;
  const seconds = Math.floor(diffMs / 1000);
  const minutes = Math.floor(seconds / 60);
  const hours = Math.floor(minutes / 60);

  if (hours > 0) return `${hours}h ${minutes % 60}m`;
  if (minutes > 0) return `${minutes}m ${seconds % 60}s`;
  return `${seconds}s`;
}

function timeAgo(dateStr: string): string {
  const now = Date.now();
  const then = new Date(dateStr).getTime();
  const seconds = Math.floor((now - then) / 1000);
  if (seconds < 60) return `${seconds}s ago`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  return `${days}d ago`;
}

function ExecutionCard({ execution, onClick }: { execution: PlaybookExecution; onClick: () => void }) {
  const isActive = execution.status === "running";
  const spawnedCount = execution.agents.filter((a) => a.status === "spawned").length;
  const totalAgents = execution.agents.length;
  const progress = totalAgents > 0 ? (spawnedCount / totalAgents) * 100 : 0;

  return (
    <Paper
      p="md"
      withBorder
      style={{
        cursor: "pointer",
        borderColor: isActive ? "var(--accent-blue)" : "var(--border-color)",
        backgroundColor: "var(--bg-primary)",
        transition: "border-color 0.15s, box-shadow 0.15s",
      }}
      onClick={onClick}
      className="execution-card-hover"
    >
      <Group justify="space-between" align="flex-start" wrap="nowrap" mb="sm">
        <div style={{ flex: 1, minWidth: 0 }}>
          <Text fw={600} size="sm" c="var(--text-primary)" truncate>
            {execution.playbookName}
          </Text>
          <Text size="xs" c="var(--text-secondary)" mt={2}>
            {timeAgo(execution.startedAt)}
          </Text>
        </div>
        <Badge color={STATUS_COLORS[execution.status]} variant="filled" size="sm">
          {execution.status}
        </Badge>
      </Group>

      {isActive && (
        <Box mb="sm">
          <Group gap={6} mb={4}>
            <Text size="xs" c="var(--text-secondary)">
              {spawnedCount}/{totalAgents} agents spawned
            </Text>
            {execution.phase && (
              <Badge size="xs" variant="light" color="blue">
                {PHASE_LABELS[execution.phase] || execution.phase}
              </Badge>
            )}
          </Group>
          <Progress value={progress} size="sm" color="blue" />
        </Box>
      )}

      <Group gap="sm" wrap="wrap">
        <Tooltip label={`Execution ID: ${execution.id}`}>
          <Badge
            variant="light"
            color="gray"
            size="xs"
            style={{ fontFamily: "var(--font-mono)", cursor: "pointer" }}
            onClick={(e) => {
              e.stopPropagation();
              try {
                navigator.clipboard.writeText(execution.id);
              } catch (err) {
                console.error("Failed to copy execution ID:", err);
              }
            }}
          >
            #{execution.id.slice(0, 8)}
          </Badge>
        </Tooltip>

        {execution.completedAt && (
          <Text size="xs" c="var(--text-muted)">
            Duration: {formatDuration(execution.startedAt, execution.completedAt)}
          </Text>
        )}

        {execution.dryRun && (
          <Badge size="xs" variant="light" color="purple">
            Dry Run
          </Badge>
        )}
      </Group>
    </Paper>
  );
}

function ExecutionDetail({ execution }: { execution: PlaybookExecution }) {
  return (
    <Stack gap="md" mt="md" p="md" style={{ backgroundColor: "var(--bg-secondary)", borderRadius: 8 }}>
      {/* Execution Info */}
      <Group gap="md" wrap="wrap">
        <div>
          <Text size="xs" c="var(--text-secondary)" mb={2}>
            Execution ID
          </Text>
          <Text
            size="sm"
            ff="var(--font-mono)"
            c="var(--text-primary)"
            style={{ cursor: "pointer" }}
            onClick={() => {
              try {
                navigator.clipboard.writeText(execution.id);
              } catch (err) {
                console.error("Failed to copy execution ID:", err);
              }
            }}
            title="Click to copy"
          >
            {execution.id}
          </Text>
        </div>
        <div>
          <Text size="xs" c="var(--text-secondary)" mb={2}>
            Started
          </Text>
          <Text size="sm" c="var(--text-primary)">
            {new Date(execution.startedAt).toLocaleString()}
          </Text>
        </div>
        {execution.completedAt && (
          <div>
            <Text size="xs" c="var(--text-secondary)" mb={2}>
              Duration
            </Text>
            <Text size="sm" c="var(--text-primary)">
              {formatDuration(execution.startedAt, execution.completedAt)}
            </Text>
          </div>
        )}
      </Group>

      {/* Variables */}
      {execution.variables && Object.keys(execution.variables).length > 0 && (
        <Box>
          <Text size="sm" fw={600} c="var(--text-primary)" mb="xs">
            Variables
          </Text>
          <Paper p="sm" style={{ backgroundColor: "var(--bg-tertiary)", borderRadius: 6 }}>
            <Stack gap={4}>
              {Object.entries(execution.variables).map(([key, value]) => (
                <Group key={key} gap={8}>
                  <Text size="xs" c="var(--text-secondary)" ff="var(--font-mono)">
                    {key}:
                  </Text>
                  <Text size="xs" c="var(--text-primary)" ff="var(--font-mono)">
                    {value}
                  </Text>
                </Group>
              ))}
            </Stack>
          </Paper>
        </Box>
      )}

      {/* Error */}
      {execution.error && (
        <Alert color="red" variant="light" title="Execution Failed">
          <Text size="sm" style={{ whiteSpace: "pre-wrap" }}>
            {execution.error}
          </Text>
        </Alert>
      )}

      {/* Agent Spawn Status */}
      <Box>
        <Text size="sm" fw={600} c="var(--text-primary)" mb="xs">
          Agent Spawn Status ({execution.agents.filter((a) => a.status === "spawned").length}/{execution.agents.length})
        </Text>
        <Timeline active={execution.agents.length} bulletSize={20} lineWidth={2}>
          {execution.agents.map((agent, i) => (
            <Timeline.Item
              key={i}
              title={
                <Group gap={8}>
                  <Text size="sm" fw={500} c="var(--text-primary)">
                    {agent.name}
                  </Text>
                  <Badge size="xs" variant="light" color={agent.role === "master" ? "yellow" : "blue"}>
                    {agent.role}
                  </Badge>
                  <Badge size="xs" color={AGENT_STATUS_COLORS[agent.status]} variant="filled">
                    {agent.status}
                  </Badge>
                </Group>
              }
              bullet={
                <span style={{ fontSize: 10 }}>
                  {agent.status === "spawned" ? "✓" : agent.status === "failed" ? "✗" : "⋯"}
                </span>
              }
              color={AGENT_STATUS_COLORS[agent.status]}
            >
              {agent.agentId && (
                <Text size="xs" c="var(--text-muted)" mt={4}>
                  Agent ID: {agent.agentId}
                </Text>
              )}
              {agent.error && (
                <Text size="xs" c="var(--accent-red)" mt={4}>
                  Error: {agent.error}
                </Text>
              )}
            </Timeline.Item>
          ))}
        </Timeline>
      </Box>

      {/* Task IDs */}
      {execution.taskIds && execution.taskIds.length > 0 && (
        <Box>
          <Text size="sm" fw={600} c="var(--text-primary)" mb="xs">
            Created Tasks ({execution.taskIds.length})
          </Text>
          <Group gap={4}>
            {execution.taskIds.map((taskId) => (
              <Badge
                key={taskId}
                variant="light"
                color="blue"
                size="xs"
                style={{ fontFamily: "var(--font-mono)", cursor: "pointer" }}
                onClick={() => {
                  try {
                    navigator.clipboard.writeText(taskId);
                  } catch (err) {
                    console.error("Failed to copy task ID:", err);
                  }
                }}
                title="Click to copy"
              >
                #{taskId.slice(0, 8)}
              </Badge>
            ))}
          </Group>
        </Box>
      )}
    </Stack>
  );
}

export function ExecutionTracing({ sessionId }: ExecutionTracingProps) {
  const api = useApi();
  const [executions, setExecutions] = useState<Map<string, PlaybookExecution>>(new Map());
  const [expandedId, setExpandedId] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  // Reconstruct executions from events
  const loadExecutions = useCallback(async () => {
    setLoading(true);
    try {
      const { events } = await api.getEventsByTypes(
        sessionId,
        ["playbook-progress", "playbook-complete", "playbook-failed"],
        1000
      );

      const executionMap = new Map<string, PlaybookExecution>();

      for (const event of events || []) {
        const data = event.data as PlaybookEventData;
        const executionId = data.executionId;
        if (!executionId) continue;

        // Initialize or update execution
        if (!executionMap.has(executionId)) {
          executionMap.set(executionId, {
            id: executionId,
            sessionId: data.sessionId || sessionId,
            playbookName: data.playbookName || "Unknown",
            status: "pending",
            agents: data.agents || [],
            startedAt: event.timestamp,
            variables: data.variables,
            phase: data.phase,
            dryRun: data.dryRun,
          });
        }

        const execution = executionMap.get(executionId)!;

        // Update based on event type
        if (event.type === "playbook-progress") {
          execution.status = "running";
          execution.phase = data.phase;
          if (data.agents) execution.agents = data.agents;
        } else if (event.type === "playbook-complete") {
          execution.status = "complete";
          execution.completedAt = event.timestamp;
          if (data.agents) execution.agents = data.agents;
          if (data.taskIds) execution.taskIds = data.taskIds;
        } else if (event.type === "playbook-failed") {
          execution.status = "failed";
          execution.completedAt = event.timestamp;
          execution.error = data.error;
          if (data.agents) execution.agents = data.agents;
        }
      }

      setExecutions(executionMap);
    } catch (err) {
      console.error("Failed to load executions:", err);
    } finally {
      setLoading(false);
    }
  }, [sessionId]); // api methods are stable, no need to include in deps

  useEffect(() => {
    loadExecutions();
  }, [loadExecutions]);

  const executionList = Array.from(executions.values()).sort(
    (a, b) => new Date(b.startedAt).getTime() - new Date(a.startedAt).getTime()
  );

  if (loading) {
    return (
      <Stack align="center" justify="center" py={60}>
        <Loader size="md" />
        <Text c="var(--text-secondary)">Loading execution history...</Text>
      </Stack>
    );
  }

  if (executionList.length === 0) {
    return (
      <Stack align="center" justify="center" py={60}>
        <Text size="lg" c="var(--text-muted)">
          No playbook executions yet
        </Text>
        <Text size="sm" c="var(--text-muted)" ta="center" maw={400}>
          Launch a playbook to see execution history here
        </Text>
      </Stack>
    );
  }

  return (
    <Stack gap="md">
      {executionList.map((execution) => (
        <div key={execution.id}>
          <ExecutionCard
            execution={execution}
            onClick={() => setExpandedId(expandedId === execution.id ? null : execution.id)}
          />
          <Collapse in={expandedId === execution.id}>
            <ExecutionDetail execution={execution} />
          </Collapse>
        </div>
      ))}
    </Stack>
  );
}
