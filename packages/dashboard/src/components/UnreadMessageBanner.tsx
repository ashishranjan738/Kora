import { useMemo } from "react";
import { Group, Text, Badge, Tooltip } from "@mantine/core";

// ---------- Types ----------

interface Agent {
  id: string;
  name?: string;
  config?: { name?: string };
  unreadMessages?: number;
  status?: string;
}

interface UnreadMessageBannerProps {
  agents: Agent[];
  onNudge?: (agentId: string) => void;
}

// ---------- Component ----------

/**
 * Persistent banner showing agents with unread messages.
 * Always visible at the top of Command Center when any agent has unread messages.
 */
export function UnreadMessageBanner({ agents, onNudge }: UnreadMessageBannerProps) {
  const agentsWithUnread = useMemo(
    () => agents.filter((a) => (a.unreadMessages ?? 0) > 0),
    [agents],
  );

  const totalUnread = useMemo(
    () => agentsWithUnread.reduce((sum, a) => sum + (a.unreadMessages ?? 0), 0),
    [agentsWithUnread],
  );

  if (agentsWithUnread.length === 0) return null;

  return (
    <div
      style={{
        padding: "4px 12px",
        background: "rgba(210, 153, 34, 0.1)",
        borderBottom: "1px solid var(--accent-yellow, #d29922)",
        display: "flex",
        alignItems: "center",
        gap: 8,
        flexWrap: "wrap",
      }}
    >
      <Badge color="yellow" variant="filled" size="sm" style={{ flexShrink: 0 }}>
        {totalUnread} unread
      </Badge>

      {agentsWithUnread.map((agent) => {
        const name = agent.config?.name || agent.name || agent.id;
        return (
          <Tooltip key={agent.id} label={`${name} has ${agent.unreadMessages} unread message${agent.unreadMessages !== 1 ? "s" : ""} — click to nudge`}>
            <Group
              gap={4}
              wrap="nowrap"
              style={{
                cursor: onNudge ? "pointer" : "default",
                padding: "2px 8px",
                borderRadius: 4,
                background: "rgba(210, 153, 34, 0.15)",
              }}
              onClick={() => onNudge?.(agent.id)}
            >
              <Text size="xs" fw={500} c="var(--accent-yellow)">
                {name}
              </Text>
              <Badge size="xs" color="red" variant="filled" circle>
                {agent.unreadMessages}
              </Badge>
            </Group>
          </Tooltip>
        );
      })}

      <Text size="xs" c="dimmed" style={{ marginLeft: "auto" }}>
        Click agent to nudge
      </Text>
    </div>
  );
}
