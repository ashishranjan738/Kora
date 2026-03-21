import { Tooltip, Group, Text } from "@mantine/core";

// ---------- Types ----------

interface AgentLoadBadgeProps {
  activeTasks: number;
  doneTasks: number;
  blockedTasks: number;
  loadPercentage: number;
  compact?: boolean; // On narrow cards, collapse to just the load bar
}

// ---------- Helpers ----------

function getLoadColor(pct: number): string {
  if (pct > 100) return "var(--accent-red, #f85149)";
  if (pct >= 70) return "var(--accent-yellow, #d29922)";
  return "var(--accent-green, #3fb950)";
}

// ---------- Component ----------

export function AgentLoadBadge({
  activeTasks,
  doneTasks,
  blockedTasks,
  loadPercentage,
  compact = false,
}: AgentLoadBadgeProps) {
  const barColor = getLoadColor(loadPercentage);
  const barWidth = Math.min(loadPercentage, 120); // cap visual at 120%

  const tooltipText = `${activeTasks} active | ${doneTasks} done${blockedTasks > 0 ? ` | ${blockedTasks} blocked` : ""} | Load: ${loadPercentage}%`;

  // Compact mode: just the load bar
  if (compact) {
    return (
      <Tooltip label={tooltipText} withArrow>
        <div
          style={{
            width: 40,
            height: 6,
            borderRadius: 3,
            background: "var(--bg-tertiary, #161b22)",
            overflow: "hidden",
            flexShrink: 0,
          }}
        >
          <div
            style={{
              width: `${Math.min(barWidth, 100)}%`,
              height: "100%",
              borderRadius: 3,
              background: barColor,
              transition: "width 0.3s ease, background 0.3s ease",
            }}
          />
        </div>
      </Tooltip>
    );
  }

  return (
    <Tooltip label={tooltipText} withArrow>
      <Group gap={6} wrap="nowrap" style={{ flexShrink: 0 }}>
        {/* Task counts */}
        <Text size="xs" c="dimmed" style={{ whiteSpace: "nowrap", lineHeight: 1 }}>
          {activeTasks} active
          {doneTasks > 0 && <span style={{ margin: "0 3px", opacity: 0.5 }}>|</span>}
          {doneTasks > 0 && <>{doneTasks} done</>}
          {blockedTasks > 0 && (
            <>
              <span style={{ margin: "0 3px", opacity: 0.5 }}>|</span>
              <span style={{ color: "var(--accent-red, #f85149)" }}>
                {"\u26A0"} {blockedTasks}
              </span>
            </>
          )}
        </Text>

        {/* Mini load bar */}
        <div
          style={{
            width: 36,
            height: 6,
            borderRadius: 3,
            background: "var(--bg-tertiary, #161b22)",
            overflow: "hidden",
            flexShrink: 0,
          }}
        >
          <div
            style={{
              width: `${Math.min(barWidth, 100)}%`,
              height: "100%",
              borderRadius: 3,
              background: barColor,
              transition: "width 0.3s ease, background 0.3s ease",
            }}
          />
        </div>
      </Group>
    </Tooltip>
  );
}
