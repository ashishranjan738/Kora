import { Badge, Tooltip, Group, Text, Progress } from "@mantine/core";
import { useState, useEffect } from "react";
import type { AgentActivity } from "./AgentCardTerminal";

interface AgentActivityBadgeProps {
  activity: AgentActivity;
  /** When the agent entered this activity state (ISO timestamp) */
  since?: string;
  /** Show idle warning when idle > thresholdMs (default 60s) */
  idleWarningThresholdMs?: number;
  /** Compact mode — just the dot + short label */
  compact?: boolean;
  /** Number of active tasks — used to detect "working" with 0 tasks (likely idle) */
  activeTasks?: number;
}

const ACTIVITY_CONFIG: Record<AgentActivity, {
  color: string;
  label: string;
  shortLabel: string;
  icon: string;
  dotClass: string;
}> = {
  working: { color: "green", label: "Working", shortLabel: "Working", icon: "\u2699", dotClass: "activity-working" },
  idle: { color: "gray", label: "Idle", shortLabel: "Idle", icon: "\u23F8", dotClass: "activity-idle" },
  reading: { color: "blue", label: "Reading files", shortLabel: "Reading", icon: "\uD83D\uDCC4", dotClass: "activity-reading" },
  writing: { color: "violet", label: "Writing files", shortLabel: "Writing", icon: "\u270F", dotClass: "activity-writing" },
  "running-command": { color: "orange", label: "Running command", shortLabel: "Running", icon: "\u25B6", dotClass: "activity-running" },
  crashed: { color: "red", label: "Crashed", shortLabel: "Crashed", icon: "\u26A0", dotClass: "activity-crashed" },
  stopped: { color: "gray", label: "Stopped", shortLabel: "Stopped", icon: "\u23F9", dotClass: "activity-stopped" },
};

function formatDuration(ms: number): string {
  if (ms < 1000) return "just now";
  const seconds = Math.floor(ms / 1000);
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  const remainMin = minutes % 60;
  return remainMin > 0 ? `${hours}h ${remainMin}m` : `${hours}h`;
}

export function AgentActivityBadge({
  activity,
  since,
  idleWarningThresholdMs = 60000,
  compact = false,
  activeTasks,
}: AgentActivityBadgeProps) {
  const [elapsed, setElapsed] = useState(0);

  // Update elapsed time every second when we have a `since` timestamp
  useEffect(() => {
    if (!since) { setElapsed(0); return; }
    const update = () => setElapsed(Date.now() - new Date(since).getTime());
    update();
    const timer = setInterval(update, 1000);
    return () => clearInterval(timer);
  }, [since]);

  const config = ACTIVITY_CONFIG[activity] || ACTIVITY_CONFIG.idle;
  const isIdle = activity === "idle";
  const isIdleWarning = isIdle && elapsed > idleWarningThresholdMs;
  // Detect "likely idle" — agent reports working but has 0 active tasks
  const isLikelyIdle = !isIdle && activity === "working" && activeTasks === 0;
  const badgeColor = isIdleWarning ? "yellow" : isLikelyIdle ? "teal" : config.color;

  const durationText = since ? formatDuration(elapsed) : "";
  const tooltipText = isLikelyIdle
    ? `Showing "working" but has 0 active tasks — may be idle (detection lag)`
    : `${config.label}${durationText ? ` for ${durationText}` : ""}${isIdleWarning ? " — no active task" : ""}`;

  if (compact) {
    return (
      <Tooltip label={tooltipText} withArrow position="top">
        <Badge
          variant={isIdleWarning ? "filled" : "light"}
          color={badgeColor}
          size="xs"
          leftSection={
            <span className={`activity-dot-sm ${config.dotClass}`} />
          }
        >
          {isLikelyIdle ? "Idle?" : config.shortLabel}
          {durationText && !isLikelyIdle && <span style={{ opacity: 0.7, marginLeft: 4 }}>{durationText}</span>}
        </Badge>
      </Tooltip>
    );
  }

  return (
    <Tooltip label={tooltipText} withArrow position="top">
      <Badge
        variant={isIdleWarning ? "filled" : "light"}
        color={badgeColor}
        size="sm"
        leftSection={
          <span className={`activity-dot-sm ${config.dotClass}`} />
        }
        styles={{
          root: isIdleWarning ? { animation: "tl-pulse 2s infinite" } : undefined,
        }}
      >
        {isLikelyIdle ? "\u23F8 Idle? (0 tasks)" : `${config.icon} ${config.label}`}
        {durationText && !isLikelyIdle && (
          <Text component="span" size="xs" ml={4} opacity={0.7}>
            {durationText}
          </Text>
        )}
      </Badge>
    </Tooltip>
  );
}

/** Agent utilization bar — shows % time working vs idle */
interface AgentUtilizationProps {
  /** Ratio of time working (0-1) */
  utilization: number;
  /** Optional label */
  label?: string;
}

export function AgentUtilization({ utilization, label }: AgentUtilizationProps) {
  const pct = Math.round(utilization * 100);
  const color = pct >= 70 ? "green" : pct >= 40 ? "yellow" : "red";

  return (
    <Tooltip label={`${pct}% utilization — Working time / Total uptime. Higher = more productive.${label ? ` ${label}` : ""}`} withArrow multiline w={220}>
      <div style={{ display: "flex", alignItems: "center", gap: 6, minWidth: 80 }}>
        <Progress
          value={pct}
          color={color}
          size="sm"
          radius="xl"
          style={{ flex: 1 }}
          styles={{
            root: { backgroundColor: "var(--bg-tertiary)" },
          }}
        />
        <Text size="xs" c="dimmed" style={{ minWidth: 28, textAlign: "right" }}>
          {pct}%
        </Text>
      </div>
    </Tooltip>
  );
}

/** Mini sparkline showing recent activity pattern */
interface ActivitySparklineProps {
  /** Array of activity states over time (most recent last) */
  history: AgentActivity[];
  width?: number;
  height?: number;
}

const ACTIVITY_COLORS: Record<string, string> = {
  working: "var(--accent-green)",
  reading: "var(--accent-blue)",
  writing: "var(--accent-purple, #bc8cff)",
  "running-command": "var(--accent-yellow)",
  idle: "var(--bg-tertiary)",
  crashed: "var(--accent-red)",
  stopped: "var(--text-muted)",
};

export function ActivitySparkline({ history, width = 80, height = 16 }: ActivitySparklineProps) {
  if (history.length === 0) return null;

  const barWidth = Math.max(2, Math.floor(width / history.length));

  return (
    <Tooltip
      label={`Last ${history.length} checks — ${history.filter((h) => h === "working" || h === "reading" || h === "writing" || h === "running-command").length}/${history.length} active`}
      withArrow
    >
      <div
        style={{
          display: "flex",
          alignItems: "flex-end",
          gap: 1,
          height,
          width,
        }}
      >
        {history.map((act, i) => {
          const isActive = act === "working" || act === "reading" || act === "writing" || act === "running-command";
          return (
            <div
              key={i}
              style={{
                width: barWidth,
                height: isActive ? height : Math.round(height * 0.3),
                backgroundColor: ACTIVITY_COLORS[act] || ACTIVITY_COLORS.idle,
                borderRadius: 1,
                transition: "height 0.2s ease",
              }}
            />
          );
        })}
      </div>
    </Tooltip>
  );
}
