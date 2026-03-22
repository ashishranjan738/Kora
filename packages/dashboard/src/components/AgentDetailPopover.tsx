import { Stack, Group, Text, Badge, Divider, Button, Progress, Code, CopyButton, Tooltip } from "@mantine/core";
import { formatCost, formatTokens, formatLastSeen, formatUptime } from "../utils/formatters";
import { FlagIndicator, ChannelIndicator } from "./FlagIndicator";

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
  const pendingTasks = agentTasks.filter((t: any) => t.status === "pending" || t.status === "backlog").length;
  const doneTasks = agentTasks.filter((t: any) => t.status === "done").length;
  const capacity = agent.capacity ?? 5;
  const utilization = capacity > 0 ? Math.min(100, Math.round((activeTasks / capacity) * 100)) : 0;
  const skills: string[] = agent.config?.skills || [];
  const uptime = agent.startedAt ? formatUptime(agent.startedAt) : null;
  const flags: string[] = (agent.config?.extraCliArgs as string[]) || [];
  const channels: string[] = (agent.config?.channels as string[]) || [];
  const worktreePath = agent.config?.workingDirectory || "";
  const agentId = agent.id || "";

  const isCrashed = agent.status === "crashed" || agent.status === "error";
  const isIdle = agent.activity === "idle";

  return (
    <Stack gap="xs" style={{ minWidth: 260, maxWidth: 300 }}>
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
          {pendingTasks > 0 && <span style={{ color: "var(--text-muted)" }}> · {pendingTasks} pending</span>}
          {" · "}
          <span style={{ color: "var(--accent-green)" }}>{doneTasks} done</span>
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

      {/* Uptime */}
      {uptime && (
        <Group justify="space-between">
          <Text size="xs" c="dimmed">Uptime</Text>
          <Text size="xs">{uptime}</Text>
        </Group>
      )}

      {/* Utilization */}
      {activeTasks > 0 && (
        <div>
          <Group justify="space-between" mb={4}>
            <Tooltip label="Working time / Total uptime. Higher = more productive.">
              <Group gap={4} style={{ cursor: "help" }}>
                <Text size="xs" c="dimmed">Utilization</Text>
                <Text size="xs" c="dimmed" style={{ fontSize: 10 }}>&#8505;</Text>
              </Group>
            </Tooltip>
            <Text size="xs" fw={500} c={utilization > 80 ? "var(--accent-red)" : utilization > 50 ? "var(--accent-yellow)" : "var(--accent-green)"}>
              {utilization}%
            </Text>
          </Group>
          <Progress
            value={utilization}
            size="xs"
            color={utilization > 80 ? "red" : utilization > 50 ? "yellow" : "green"}
            styles={{ root: { backgroundColor: "var(--bg-tertiary)" } }}
          />
        </div>
      )}

      {/* Skills */}
      {skills.length > 0 && (
        <div>
          <Text size="xs" c="dimmed" mb={4}>Skills</Text>
          <Group gap={4}>
            {skills.map((skill: string) => (
              <Badge
                key={skill}
                size="xs"
                variant="dot"
                color={
                  skill === "frontend" ? "cyan" : skill === "backend" ? "orange" :
                  skill === "testing" ? "green" : skill === "review" ? "grape" :
                  skill === "research" ? "violet" : skill === "devops" ? "indigo" : "gray"
                }
              >
                {skill}
              </Badge>
            ))}
          </Group>
        </div>
      )}

      {/* Flags & Channels */}
      {(flags.length > 0 || channels.length > 0) && (
        <div>
          <Group gap={8}>
            {flags.length > 0 && <FlagIndicator flags={flags} />}
            {channels.length > 0 && <ChannelIndicator channels={channels} />}
          </Group>
        </div>
      )}

      {/* Worktree Path */}
      {worktreePath && (
        <Group justify="space-between" wrap="nowrap">
          <Text size="xs" c="dimmed" style={{ flexShrink: 0 }}>Worktree</Text>
          <Tooltip label={worktreePath}>
            <Text size="xs" ff="var(--font-mono)" lineClamp={1} style={{ maxWidth: 180, direction: "rtl", textAlign: "left" }}>
              {worktreePath.split("/").slice(-3).join("/")}
            </Text>
          </Tooltip>
        </Group>
      )}

      {/* Agent ID (copyable) */}
      <Group justify="space-between" wrap="nowrap">
        <Text size="xs" c="dimmed">ID</Text>
        <CopyButton value={agentId}>
          {({ copied, copy }) => (
            <Tooltip label={copied ? "Copied!" : "Click to copy"}>
              <Code
                style={{ cursor: "pointer", fontSize: 10, maxWidth: 160 }}
                onClick={copy}
              >
                {agentId.slice(0, 20)}{agentId.length > 20 ? "…" : ""}
              </Code>
            </Tooltip>
          )}
        </CopyButton>
      </Group>

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
