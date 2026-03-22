import { useEffect, useState, useCallback, useRef } from "react";
import { Group, Text, Tooltip, Skeleton } from "@mantine/core";
import { useMediaQuery } from "@mantine/hooks";
import { useApi } from "../hooks/useApi";
import { useWebSocket } from "../hooks/useWebSocket";
import type { TaskMetricsResponse } from "./WorkloadChart";
import { formatUptime } from "../utils/formatters";

// ---------- Props ----------

interface SessionMetricsBarProps {
  sessionId: string;
  agentCount: number;
  runningAgentCount: number;
  sessionStartedAt?: string;
  onNavigateTab: (tab: string) => void;
}

// ---------- Helpers ----------

const SEPARATOR = "\u2502"; // │

function bottleneckColor(score: number): string {
  if (score > 70) return "var(--accent-red, #f85149)";
  if (score >= 40) return "var(--accent-yellow, #d29922)";
  return "var(--text-muted)";
}

// ---------- Component ----------

export function SessionMetricsBar({
  sessionId,
  agentCount,
  runningAgentCount,
  sessionStartedAt,
  onNavigateTab,
}: SessionMetricsBarProps) {
  const api = useApi();
  const isMobile = useMediaQuery("(max-width: 768px)");
  const isTablet = useMediaQuery("(max-width: 1024px)");

  const [metrics, setMetrics] = useState<TaskMetricsResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const pollRef = useRef<ReturnType<typeof setInterval> | undefined>(undefined);

  const loadMetrics = useCallback(async () => {
    try {
      const data = await api.getTaskMetrics(sessionId);
      setMetrics(data as TaskMetricsResponse);
    } catch {
      // Silently fail — non-critical display component
    } finally {
      setLoading(false);
    }
  }, [sessionId]);

  // Initial load + polling
  useEffect(() => {
    loadMetrics();
    pollRef.current = setInterval(loadMetrics, 15000);
    return () => { if (pollRef.current) clearInterval(pollRef.current); };
  }, [loadMetrics]);

  // WebSocket refresh
  const handleWsEvent = useCallback(
    (event: any) => {
      if (["task-created", "task-updated", "task-deleted", "task-metrics-updated"].includes(event.type)) {
        loadMetrics();
      }
    },
    [loadMetrics],
  );

  const { subscribe, unsubscribe } = useWebSocket(handleWsEvent);

  useEffect(() => {
    if (sessionId) subscribe(sessionId);
    return () => { if (sessionId) unsubscribe(sessionId); };
  }, [sessionId, subscribe, unsubscribe]);

  // Loading skeleton
  if (loading && !metrics) {
    return (
      <div style={{
        padding: "6px 16px",
        background: "var(--bg-secondary)",
        borderBottom: "1px solid var(--border-color)",
      }}>
        <Skeleton height={16} width="60%" />
      </div>
    );
  }

  // No data yet
  if (!metrics || metrics.session.totalTasks === 0) {
    return null; // Don't show bar if there are no tasks
  }

  const { session } = metrics;
  const bottleneck = session.topBottleneck;

  const sectionStyle = (clickable = false): React.CSSProperties => ({
    cursor: clickable ? "pointer" : "default",
    whiteSpace: "nowrap",
    display: "flex",
    alignItems: "center",
    gap: 4,
  });

  const sepStyle: React.CSSProperties = {
    color: "var(--border-color)",
    fontSize: 14,
    userSelect: "none",
    flexShrink: 0,
  };

  // ---------- Mobile: ultra-compact ----------
  if (isMobile) {
    return (
      <div style={{
        padding: "4px 12px",
        background: "var(--bg-secondary)",
        borderBottom: "1px solid var(--border-color)",
        display: "flex",
        alignItems: "center",
        gap: 8,
        overflow: "hidden",
      }}>
        <Tooltip label={`${session.activeTasks} active, ${session.doneTasks} done`}>
          <Text
            size="xs"
            style={sectionStyle(true)}
            onClick={() => onNavigateTab("tasks")}
          >
            <span style={{ color: "var(--accent-blue)" }}>{session.activeTasks}</span>
            <span style={{ color: "var(--text-muted)" }}>/</span>
            <span style={{ color: "var(--accent-green)" }}>{session.doneTasks}</span>
            <span style={{ color: "var(--text-muted)" }}> tasks</span>
          </Text>
        </Tooltip>
        {bottleneck && bottleneck.score >= 40 && (
          <>
            <span style={sepStyle}>{SEPARATOR}</span>
            <Tooltip label={`Bottleneck: ${bottleneck.reason} (severity ${bottleneck.score}/100)`}>
              <Text
                size="xs"
                style={{ ...sectionStyle(true), color: bottleneckColor(bottleneck.score) }}
                onClick={() => onNavigateTab("workload")}
              >
                {"\u26A0"} {bottleneck.agentName}
              </Text>
            </Tooltip>
          </>
        )}
      </div>
    );
  }

  // ---------- Desktop / Tablet ----------
  return (
    <div style={{
      padding: "5px 16px",
      background: "var(--bg-secondary)",
      borderBottom: "1px solid var(--border-color)",
      display: "flex",
      alignItems: "center",
      gap: 10,
      overflow: "hidden",
    }}>
      {/* Agents */}
      <Tooltip label={`${runningAgentCount} running, ${agentCount - runningAgentCount} stopped/crashed`}>
        <Text
          size="xs"
          style={sectionStyle(true)}
          onClick={() => onNavigateTab("agents")}
        >
          <span style={{ color: "var(--text-muted)" }}>Agents:</span>
          <span style={{ fontWeight: 600 }}>{runningAgentCount}</span>
          <span style={{ color: "var(--text-muted)" }}>running</span>
        </Text>
      </Tooltip>

      <span style={sepStyle}>{SEPARATOR}</span>

      {/* Tasks */}
      <Tooltip label={`${session.activeTasks} active (pending + in-progress + review), ${session.doneTasks} completed`}>
        <Text
          size="xs"
          style={sectionStyle(true)}
          onClick={() => onNavigateTab("tasks")}
        >
          <span style={{ color: "var(--text-muted)" }}>Tasks:</span>
          <span style={{ color: "var(--accent-blue)", fontWeight: 600 }}>{session.activeTasks}</span>
          <span style={{ color: "var(--text-muted)" }}>active /</span>
          <span style={{ color: "var(--accent-green)", fontWeight: 600 }}>{session.doneTasks}</span>
          <span style={{ color: "var(--text-muted)" }}>done</span>
        </Text>
      </Tooltip>

      {/* Bottleneck */}
      {bottleneck && bottleneck.score >= 40 && (
        <>
          <span style={sepStyle}>{SEPARATOR}</span>
          <Tooltip label={`Bottleneck: ${bottleneck.reason} (severity ${bottleneck.score}/100)`}>
            <Text
              size="xs"
              style={{ ...sectionStyle(true), color: bottleneckColor(bottleneck.score) }}
              onClick={() => onNavigateTab("workload")}
            >
              {"\u26A0"} {bottleneck.agentName}
              <span style={{ color: "var(--text-muted)", fontWeight: 400 }}> bottleneck</span>
            </Text>
          </Tooltip>
        </>
      )}

      {/* Throughput — desktop only */}
      {!isTablet && session.throughput > 0 && (
        <>
          <span style={sepStyle}>{SEPARATOR}</span>
          <Tooltip label="Tasks completed per hour (last 2 hours)">
            <Text size="xs" style={sectionStyle()}>
              <span style={{ color: "var(--text-muted)" }}>Throughput:</span>
              <span style={{ fontWeight: 600 }}>{session.throughput.toFixed(1)}</span>
              <span style={{ color: "var(--text-muted)" }}>/hr</span>
            </Text>
          </Tooltip>
        </>
      )}

      {/* Session duration — desktop only */}
      {!isTablet && sessionStartedAt && (
        <>
          <span style={sepStyle}>{SEPARATOR}</span>
          <Tooltip label={`Session started: ${new Date(sessionStartedAt).toLocaleString()}`}>
            <Text size="xs" style={sectionStyle()}>
              <span style={{ color: "var(--text-muted)" }}>Session:</span>
              <span>{formatUptime(sessionStartedAt)}</span>
            </Text>
          </Tooltip>
        </>
      )}
    </div>
  );
}
