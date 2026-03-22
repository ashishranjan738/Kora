import { Stack, Group, Text, Badge, Divider, Button } from "@mantine/core";
import { formatCost, formatTokens, formatLastSeen } from "../utils/formatters";

// ---------- Types ----------

interface AgentDetailPopoverProps {
  agent: any;
  tasks?: any[];
  onNudge?: () => void;
  onExpand?: () => void;
}

// ---------- Component ----------

export function AgentDetailPopover({ agent, tasks = [], onNudge, onExpand }: AgentDetailPopoverProps) {
  const name = agent.config?.name || agent.name || "Agent";
  const provider = agent.provider || agent.config?.cliProvider || "";
  const model = agent.model || agent.config?.model || "";
  const tokenIn = agent.tokenUsage?.input ?? agent.tokensIn ?? agent.tokens_in;
  const tokenOut = agent.tokenUsage?.output ?? agent.tokensOut ?? agent.tokens_out;
  const cost = agent.tokenUsage?.cost ?? (typeof agent.cost === "number" ? agent.cost : agent.cost?.totalCostUsd);

  const agentTasks = tasks.filter((t: any) =>
    t.assignedTo === agent.id || t.assignedTo === name
  );
  const activeTasks = agentTasks.filter((t: any) => t.status !== "done").length;
  const doneTasks = agentTasks.filter((t: any) => t.status === "done").length;

  const isCrashed = agent.status === "crashed" || agent.status === "error";
  const isIdle = agent.activity === "idle";

  return (
    <Stack gap="xs" style={{ minWidth: 220, maxWidth: 280 }}>
      {/* Identity */}
      <div>
        <Text size="sm" fw={700}>{name}</Text>
        <Text size="xs" c="dimmed">{[provider, model].filter(Boolean).join(" / ")}</Text>
      </div>

      <Divider />

      {/* Status & Activity */}
      <Group justify="space-between">
        <Text size="xs" c="dimmed">Status</Text>
        <Badge
          size="xs"
          color={isCrashed ? "red" : agent.status === "running" ? "green" : "gray"}
          variant="light"
        >
          {agent.status || "unknown"}
        </Badge>
      </Group>
      <Group justify="space-between">
        <Text size="xs" c="dimmed">Activity</Text>
        <Group gap={4}>
          <span style={{
            width: 6, height: 6, borderRadius: "50%",
            background: isIdle ? "var(--accent-yellow)" : isCrashed ? "var(--accent-red)" : "var(--accent-green)",
            display: "inline-block",
          }} />
          <Text size="xs" fw={500}>
            {agent.subActivity || (isIdle ? "Idle" : isCrashed ? "Crashed" : "Working")}
            {agent.idleSince && isIdle && ` (${formatLastSeen(agent.idleSince).replace(" ago", "")})`}
          </Text>
        </Group>
      </Group>

      <Divider />

      {/* Tasks */}
      <Group justify="space-between">
        <Text size="xs" c="dimmed">Tasks</Text>
        <Text size="xs">
          <span style={{ color: "var(--accent-blue)" }}>{activeTasks} active</span>
          {" | "}
          <span>{doneTasks} done</span>
        </Text>
      </Group>
      {agent.currentTask && (
        <Group justify="space-between">
          <Text size="xs" c="dimmed">Current</Text>
          <Text size="xs" lineClamp={1} style={{ maxWidth: 150 }}>
            {typeof agent.currentTask === "string" ? agent.currentTask : agent.currentTask.title}
          </Text>
        </Group>
      )}

      <Divider />

      {/* Tokens & Cost */}
      <Group justify="space-between">
        <Text size="xs" c="dimmed">Tokens</Text>
        <Text size="xs">In: {formatTokens(tokenIn)} Out: {formatTokens(tokenOut)}</Text>
      </Group>
      <Group justify="space-between">
        <Text size="xs" c="dimmed">Cost</Text>
        <Text size="xs" fw={500}>{formatCost(cost)}</Text>
      </Group>

      {/* Last seen */}
      {agent.lastOutputAt && (
        <Group justify="space-between">
          <Text size="xs" c="dimmed">Last output</Text>
          <Text size="xs">{formatLastSeen(agent.lastOutputAt)}</Text>
        </Group>
      )}

      <Divider />

      {/* Actions */}
      <Group gap="xs">
        {onNudge && (
          <Button size="compact-xs" variant="light" color="yellow" onClick={onNudge}>
            Nudge
          </Button>
        )}
        {onExpand && (
          <Button size="compact-xs" variant="light" color="blue" onClick={onExpand}>
            Expand
          </Button>
        )}
      </Group>
    </Stack>
  );
}
