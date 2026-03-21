import { useMemo, useState, useRef, useCallback } from "react";
import { Tooltip, Text } from "@mantine/core";
import type { TimelineEventData } from "./TimelineEvent";

interface TimelineGraphProps {
  events: TimelineEventData[];
  agents: Array<{ id: string; name: string }>;
  onJumpToTerminal?: (agentId: string) => void;
  onJumpToTaskBoard?: (taskId?: string) => void;
}

// Color scheme for event types
const EVENT_COLORS: Record<string, string> = {
  "agent-spawned": "#3fb950",
  "agent-removed": "#8b949e",
  "agent-crashed": "#f85149",
  "agent-restarted": "#d29922",
  "agent-status-changed": "#8b949e",
  "message-sent": "#58a6ff",
  "message-received": "#58a6ff",
  "task-created": "#bc8cff",
  "task-updated": "#bc8cff",
  "task-deleted": "#8b949e",
  "session-created": "#3fb950",
  "session-paused": "#d29922",
  "session-resumed": "#3fb950",
  "session-stopped": "#f85149",
  "user-interaction": "#d29922",
};

// Event shape: dot for instant events, bar for activity spans
const DOT_EVENTS = new Set([
  "message-sent", "message-received", "task-created", "task-updated", "task-deleted",
  "user-interaction", "cost-threshold-reached",
]);

const LANE_HEIGHT = 40;
const HEADER_HEIGHT = 30;
const Y_PADDING = 16;
const MIN_LEFT_LABEL_WIDTH = 100;
const MAX_LEFT_LABEL_WIDTH = 250;
const RIGHT_PADDING = 20;
const MIN_CHART_WIDTH = 600;
const DOT_RADIUS = 5;
const BAR_HEIGHT = 14;

interface HoverInfo {
  x: number;
  y: number;
  event: TimelineEventData;
}

function formatTime(ts: string): string {
  const d = new Date(ts);
  return d.toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit", second: "2-digit" });
}

function formatEventLabel(evt: TimelineEventData): string {
  const data = (evt.data || {}) as Record<string, string | undefined>;
  switch (evt.type) {
    case "agent-spawned":
      return `Spawned: ${data.name || "agent"}`;
    case "agent-crashed":
      return `Crashed: ${data.name || "agent"}`;
    case "agent-removed":
      return `Removed: ${data.name || "agent"}`;
    case "agent-restarted":
      return `Restarted: ${data.name || "agent"}`;
    case "message-sent":
      return `Message: ${data.fromName || "?"} -> ${data.toName || "?"}`;
    case "task-created":
      return `Task: ${data.title || "new task"}`;
    case "task-updated":
      return `Task updated: ${data.title || data.status || ""}`;
    case "session-created":
      return "Session created";
    case "session-stopped":
      return "Session stopped";
    default:
      return evt.description || evt.type;
  }
}

export function TimelineGraph({
  events,
  agents,
  onJumpToTerminal,
  onJumpToTaskBoard,
}: TimelineGraphProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const [hover, setHover] = useState<HoverInfo | null>(null);

  // Compute time range
  const { timeMin, timeMax, agentLanes } = useMemo(() => {
    if (events.length === 0) {
      return { timeMin: 0, timeMax: 1, agentLanes: [] as string[] };
    }

    const timestamps = events.map((e) => new Date(e.timestamp).getTime());
    let tMin = Math.min(...timestamps);
    let tMax = Math.max(...timestamps);

    // Add 5% padding on each side
    const span = tMax - tMin || 60000; // At least 1 minute
    tMin -= span * 0.02;
    tMax += span * 0.05;

    // Build agent lanes — agents that appear in events, preserving order
    const seenAgents = new Set<string>();
    const lanes: string[] = [];

    // Start with known agents
    for (const a of agents) {
      if (!seenAgents.has(a.id)) {
        seenAgents.add(a.id);
        lanes.push(a.id);
      }
    }

    // Add any agents from events not in the agent list
    for (const evt of events) {
      const data = (evt.data || {}) as Record<string, string | undefined>;
      const agentId = data.agentId || data.from || data.to;
      if (agentId && !seenAgents.has(agentId)) {
        seenAgents.add(agentId);
        lanes.push(agentId);
      }
    }

    // Add a "system" lane for non-agent events
    if (!seenAgents.has("__system__")) {
      lanes.push("__system__");
    }

    return { timeMin: tMin, timeMax: tMax, agentLanes: lanes };
  }, [events, agents]);

  // Compute label width dynamically based on longest agent name
  const LEFT_LABEL_WIDTH = useMemo(() => {
    if (agentLanes.length === 0) return MIN_LEFT_LABEL_WIDTH;
    const longestName = Math.max(...agentLanes.map(id => {
      if (id === "__system__") return 6; // "System"
      const agent = agents.find(a => a.id === id);
      return (agent?.name || id.split("-")[0] || id).length;
    }));
    const computed = Math.ceil(longestName * 7.5) + 16;
    return Math.min(MAX_LEFT_LABEL_WIDTH, Math.max(MIN_LEFT_LABEL_WIDTH, computed));
  }, [agentLanes, agents]);

  const chartWidth = Math.max(MIN_CHART_WIDTH, (containerRef.current?.clientWidth || 800) - LEFT_LABEL_WIDTH - RIGHT_PADDING);
  const svgHeight = HEADER_HEIGHT + agentLanes.length * LANE_HEIGHT + Y_PADDING;
  const totalWidth = LEFT_LABEL_WIDTH + chartWidth + RIGHT_PADDING;

  // Map timestamp to x position
  const timeToX = useCallback(
    (ts: number) => {
      const ratio = (ts - timeMin) / (timeMax - timeMin);
      return LEFT_LABEL_WIDTH + ratio * chartWidth;
    },
    [timeMin, timeMax, chartWidth]
  );

  // Map agent to lane index
  const agentToLaneY = useCallback(
    (agentId: string) => {
      const idx = agentLanes.indexOf(agentId);
      return HEADER_HEIGHT + (idx >= 0 ? idx : agentLanes.length - 1) * LANE_HEIGHT + LANE_HEIGHT / 2;
    },
    [agentLanes]
  );

  // Get agent name
  const getAgentName = useCallback(
    (agentId: string) => {
      if (agentId === "__system__") return "System";
      const agent = agents.find((a) => a.id === agentId);
      return agent?.name || agentId.split("-")[0] || agentId;
    },
    [agents]
  );

  // Compute time axis ticks
  const timeTicks = useMemo(() => {
    const span = timeMax - timeMin;
    const targetTicks = Math.min(10, Math.max(3, Math.floor(chartWidth / 100)));
    const interval = span / targetTicks;
    const ticks: { x: number; label: string }[] = [];

    for (let i = 0; i <= targetTicks; i++) {
      const t = timeMin + i * interval;
      ticks.push({
        x: timeToX(t),
        label: formatTime(new Date(t).toISOString()),
      });
    }
    return ticks;
  }, [timeMin, timeMax, chartWidth, timeToX]);

  // Classify events into their lanes
  const eventPositions = useMemo(() => {
    return events.map((evt) => {
      const data = (evt.data || {}) as Record<string, string | undefined>;
      const agentId = data.agentId || data.from || "__system__";
      const ts = new Date(evt.timestamp).getTime();
      const x = timeToX(ts);
      const y = agentToLaneY(agentId);
      const isDot = DOT_EVENTS.has(evt.type);
      const color = EVENT_COLORS[evt.type] || "#8b949e";

      return { evt, x, y, isDot, color, agentId };
    });
  }, [events, timeToX, agentToLaneY]);

  // Handle click on an event
  function handleEventClick(evt: TimelineEventData) {
    const data = (evt.data || {}) as Record<string, string | undefined>;
    if (evt.type.startsWith("task-") && data.taskId && onJumpToTaskBoard) {
      onJumpToTaskBoard(data.taskId);
    } else if (data.agentId && onJumpToTerminal) {
      onJumpToTerminal(data.agentId);
    }
  }

  if (events.length === 0) {
    return (
      <div style={{ textAlign: "center", padding: 48 }}>
        <Text size="lg" c="dimmed" mb={8}>No events to graph</Text>
        <Text size="sm" c="dimmed">Events will appear here as agents work</Text>
      </div>
    );
  }

  return (
    <div
      ref={containerRef}
      style={{
        position: "relative",
        overflowX: "auto",
        overflowY: "auto",
        maxHeight: "70vh",
        border: "1px solid var(--border-color)",
        borderRadius: 8,
        background: "var(--bg-secondary)",
      }}
    >
      <svg
        width={totalWidth}
        height={svgHeight}
        style={{ display: "block", minWidth: "100%" }}
      >
        {/* Background grid lines */}
        {agentLanes.map((_, idx) => {
          const y = HEADER_HEIGHT + idx * LANE_HEIGHT;
          return (
            <g key={`lane-${idx}`}>
              {/* Lane background (alternating) */}
              {idx % 2 === 0 && (
                <rect
                  x={LEFT_LABEL_WIDTH}
                  y={y}
                  width={chartWidth}
                  height={LANE_HEIGHT}
                  fill="rgba(255,255,255,0.02)"
                />
              )}
              {/* Lane separator */}
              <line
                x1={LEFT_LABEL_WIDTH}
                y1={y + LANE_HEIGHT}
                x2={LEFT_LABEL_WIDTH + chartWidth}
                y2={y + LANE_HEIGHT}
                stroke="var(--border-color)"
                strokeWidth={0.5}
                opacity={0.5}
              />
            </g>
          );
        })}

        {/* Time axis ticks */}
        {timeTicks.map((tick, i) => (
          <g key={`tick-${i}`}>
            <line
              x1={tick.x}
              y1={HEADER_HEIGHT}
              x2={tick.x}
              y2={svgHeight - Y_PADDING}
              stroke="var(--border-color)"
              strokeWidth={0.5}
              opacity={0.3}
              strokeDasharray="4,4"
            />
            <text
              x={tick.x}
              y={HEADER_HEIGHT - 8}
              textAnchor="middle"
              fill="var(--text-muted)"
              fontSize={10}
              fontFamily="inherit"
            >
              {tick.label}
            </text>
          </g>
        ))}

        {/* Agent labels (left side) */}
        {agentLanes.map((agentId, idx) => {
          const y = HEADER_HEIGHT + idx * LANE_HEIGHT + LANE_HEIGHT / 2;
          return (
            <text
              key={`label-${agentId}`}
              x={LEFT_LABEL_WIDTH - 8}
              y={y + 4}
              textAnchor="end"
              fill="var(--text-secondary)"
              fontSize={12}
              fontWeight={500}
              fontFamily="inherit"
              style={{ cursor: agentId !== "__system__" ? "pointer" : undefined }}
              onClick={() => {
                if (agentId !== "__system__" && onJumpToTerminal) {
                  onJumpToTerminal(agentId);
                }
              }}
            >
              {getAgentName(agentId)}
            </text>
          );
        })}

        {/* Left border */}
        <line
          x1={LEFT_LABEL_WIDTH}
          y1={HEADER_HEIGHT}
          x2={LEFT_LABEL_WIDTH}
          y2={svgHeight - Y_PADDING}
          stroke="var(--border-color)"
          strokeWidth={1}
        />

        {/* Events */}
        {eventPositions.map(({ evt, x, y, isDot, color }, idx) => (
          <g
            key={evt.id || idx}
            style={{ cursor: "pointer" }}
            onClick={() => handleEventClick(evt)}
            onMouseEnter={(e) => {
              const svgRect = (e.currentTarget.ownerSVGElement as SVGSVGElement).getBoundingClientRect();
              setHover({
                x: e.clientX - svgRect.left,
                y: e.clientY - svgRect.top,
                event: evt,
              });
            }}
            onMouseLeave={() => setHover(null)}
          >
            {isDot ? (
              <>
                <circle
                  cx={x}
                  cy={y}
                  r={DOT_RADIUS}
                  fill={color}
                  opacity={0.9}
                />
                <circle
                  cx={x}
                  cy={y}
                  r={DOT_RADIUS + 2}
                  fill="transparent"
                  stroke={color}
                  strokeWidth={1}
                  opacity={0.3}
                />
              </>
            ) : (
              <rect
                x={x - 1}
                y={y - BAR_HEIGHT / 2}
                width={Math.max(3, BAR_HEIGHT * 0.8)}
                height={BAR_HEIGHT}
                rx={2}
                fill={color}
                opacity={0.85}
              />
            )}
          </g>
        ))}
      </svg>

      {/* Tooltip overlay */}
      {hover && (
        <div
          style={{
            position: "absolute",
            left: hover.x + 12,
            top: hover.y - 10,
            background: "var(--bg-primary)",
            border: "1px solid var(--border-color)",
            borderRadius: 6,
            padding: "8px 12px",
            fontSize: 12,
            color: "var(--text-primary)",
            boxShadow: "0 4px 16px rgba(0,0,0,0.3)",
            zIndex: 10,
            pointerEvents: "none",
            maxWidth: 300,
            whiteSpace: "nowrap",
          }}
        >
          <div style={{ fontWeight: 600, marginBottom: 4 }}>
            {formatEventLabel(hover.event)}
          </div>
          <div style={{ color: "var(--text-muted)" }}>
            {formatTime(hover.event.timestamp)}
          </div>
          {hover.event.description && (
            <div style={{ marginTop: 4, color: "var(--text-secondary)", whiteSpace: "pre-wrap", maxWidth: 280 }}>
              {hover.event.description.slice(0, 120)}
              {hover.event.description.length > 120 ? "..." : ""}
            </div>
          )}
        </div>
      )}

      {/* Legend */}
      <div
        style={{
          display: "flex",
          flexWrap: "wrap",
          gap: 12,
          padding: "8px 12px",
          borderTop: "1px solid var(--border-color)",
          background: "var(--bg-primary)",
        }}
      >
        {[
          { color: "#3fb950", label: "Spawned/Created" },
          { color: "#f85149", label: "Crashed/Stopped" },
          { color: "#58a6ff", label: "Message" },
          { color: "#bc8cff", label: "Task" },
          { color: "#d29922", label: "Warning/Input" },
          { color: "#8b949e", label: "Other" },
        ].map(({ color, label }) => (
          <div key={label} style={{ display: "flex", alignItems: "center", gap: 4, fontSize: 11, color: "var(--text-secondary)" }}>
            <span style={{ width: 8, height: 8, borderRadius: "50%", background: color, display: "inline-block" }} />
            {label}
          </div>
        ))}
      </div>
    </div>
  );
}
