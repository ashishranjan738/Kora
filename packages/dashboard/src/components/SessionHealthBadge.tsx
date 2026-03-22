import { useEffect, useState } from "react";
import { Group, Text, Tooltip } from "@mantine/core";
import { useApi } from "../hooks/useApi";
import { formatLastSeen } from "../utils/formatters";

// ---------- Props ----------

interface SessionHealthBadgeProps {
  sessionId: string;
  /** Agent counts from the sessions list API */
  activeAgentCount?: number;
  crashedAgentCount?: number;
  totalAgentCount?: number;
}

// ---------- Helpers ----------

function healthDotColor(active: number, crashed: number, total: number): string {
  if (crashed > 0) return "var(--accent-red, #f85149)";
  if (total === 0) return "var(--text-muted, #484f58)";
  if (active === 0) return "var(--accent-yellow, #d29922)";
  if (active < total) return "var(--accent-yellow, #d29922)";
  return "var(--accent-green, #3fb950)";
}

function healthLabel(active: number, crashed: number, total: number): string {
  if (crashed > 0) return `${crashed} crashed`;
  if (total === 0) return "no agents";
  if (active === total) return "all healthy";
  if (active === 0) return "all idle/stopped";
  return `${active}/${total} active`;
}

// ---------- Component ----------

export function SessionHealthBadge({
  sessionId,
  activeAgentCount = 0,
  crashedAgentCount = 0,
  totalAgentCount = 0,
}: SessionHealthBadgeProps) {
  const api = useApi();
  const [taskCount, setTaskCount] = useState<{ active: number; done: number } | null>(null);
  const [lastActivity, setLastActivity] = useState<string | null>(null);

  // Fetch task counts (lightweight — just count from existing tasks API)
  useEffect(() => {
    let cancelled = false;
    async function load() {
      try {
        const data = await api.getTasks(sessionId);
        const tasks = (data as any).tasks || [];
        if (cancelled) return;
        const active = tasks.filter((t: any) => t.status !== "done").length;
        const done = tasks.filter((t: any) => t.status === "done").length;
        setTaskCount({ active, done });

        // Find most recent activity timestamp
        const timestamps = tasks
          .map((t: any) => t.updatedAt || t.createdAt)
          .filter(Boolean)
          .sort()
          .reverse();
        if (timestamps.length > 0) setLastActivity(timestamps[0]);
      } catch {
        // Non-critical — silently fail
      }
    }
    load();
    return () => { cancelled = true; };
  }, [sessionId]);

  const dotColor = healthDotColor(activeAgentCount, crashedAgentCount, totalAgentCount);
  const label = healthLabel(activeAgentCount, crashedAgentCount, totalAgentCount);

  return (
    <Group gap={6} wrap="nowrap" style={{ fontSize: 11, color: "var(--text-muted)" }}>
      {/* Health dot */}
      <Tooltip label={label}>
        <span
          style={{
            width: 7,
            height: 7,
            borderRadius: "50%",
            background: dotColor,
            flexShrink: 0,
            display: "inline-block",
          }}
        />
      </Tooltip>

      {/* Task counts */}
      {taskCount && (taskCount.active > 0 || taskCount.done > 0) && (
        <Text size="xs" c="dimmed" style={{ whiteSpace: "nowrap" }}>
          {taskCount.active > 0 && (
            <span style={{ color: "var(--accent-blue)" }}>{taskCount.active} active</span>
          )}
          {taskCount.active > 0 && taskCount.done > 0 && " · "}
          {taskCount.done > 0 && (
            <span>{taskCount.done} done</span>
          )}
        </Text>
      )}

      {/* Last activity */}
      {lastActivity && (
        <Tooltip label={`Last task update: ${new Date(lastActivity).toLocaleString()}`}>
          <Text size="xs" c="dimmed" style={{ whiteSpace: "nowrap" }}>
            · {formatLastSeen(lastActivity)}
          </Text>
        </Tooltip>
      )}
    </Group>
  );
}
