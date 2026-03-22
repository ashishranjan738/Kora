import { useEffect, useState, useCallback, useRef } from "react";
import { useParams, Link } from "react-router-dom";
import { Stack, Text, Group, Paper } from "@mantine/core";
import { useApi } from "../hooks/useApi";
import { useWebSocket } from "../hooks/useWebSocket";
import { WorkloadChart, type TaskMetricsResponse } from "../components/WorkloadChart";
import { DEFAULT_WORKFLOW_STATES } from "@kora/shared";

export function WorkloadPage() {
  const { sessionId } = useParams<{ sessionId: string }>();
  const api = useApi();

  const [metrics, setMetrics] = useState<TaskMetricsResponse | null>(null);
  const [session, setSession] = useState<any>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const pollRef = useRef<ReturnType<typeof setInterval> | undefined>(undefined);

  // Fetch session for workflow states
  const loadSession = useCallback(async () => {
    if (!sessionId) return;
    try {
      const data = await api.getSession(sessionId) as any;
      setSession(data.session ?? data);
    } catch {
      // Non-critical — we fall back to default states
    }
  }, [sessionId]);

  // Fetch task metrics
  const loadMetrics = useCallback(async () => {
    if (!sessionId) return;
    try {
      const data = await api.getTaskMetrics(sessionId);
      setMetrics(data as TaskMetricsResponse);
      setError(null);
    } catch (err: any) {
      // If the API doesn't exist yet (backend not implemented), show mock-friendly error
      if (err.message?.includes("404")) {
        setError("Task metrics API not available yet. Backend endpoint needed: GET /api/v1/sessions/:sid/task-metrics");
      } else {
        setError(err.message || "Failed to load metrics");
      }
    } finally {
      setLoading(false);
    }
  }, [sessionId]);

  // Initial load
  useEffect(() => {
    loadSession();
    loadMetrics();
  }, [loadSession, loadMetrics]);

  // WebSocket: refresh on task-related events
  const handleWsEvent = useCallback(
    (event: any) => {
      const refreshTypes = [
        "task-created",
        "task-updated",
        "task-deleted",
        "task-metrics-updated",
        "agent-spawned",
        "agent-removed",
      ];
      if (refreshTypes.includes(event.type)) {
        loadMetrics();
      }
    },
    [loadMetrics],
  );

  const { subscribe, unsubscribe } = useWebSocket(handleWsEvent);

  useEffect(() => {
    if (sessionId) {
      subscribe(sessionId);
    }
    return () => {
      if (sessionId) unsubscribe(sessionId);
    };
  }, [sessionId, subscribe, unsubscribe]);

  // Polling fallback (10s) in case WebSocket events aren't available
  useEffect(() => {
    pollRef.current = setInterval(loadMetrics, 10000);
    return () => {
      if (pollRef.current) clearInterval(pollRef.current);
    };
  }, [loadMetrics]);

  // Get workflow states from session config, fallback to defaults
  const workflowStates = session?.workflowStates ?? session?.config?.workflowStates ?? DEFAULT_WORKFLOW_STATES;

  return (
    <div style={{ padding: "16px 24px", maxWidth: 1200, margin: "0 auto" }}>
      <Stack gap="md">
        {/* Breadcrumb */}
        <Group gap="xs">
          <Link
            to={`/session/${sessionId}`}
            style={{ color: "var(--accent-blue, #58a6ff)", textDecoration: "none", fontSize: 14 }}
          >
            &larr; {session?.name || sessionId}
          </Link>
          <Text size="sm" c="dimmed">/</Text>
          <Text size="sm" fw={600}>Workload</Text>
        </Group>

        <WorkloadChart
          metrics={metrics}
          workflowStates={workflowStates}
          sessionId={sessionId || ""}
          loading={loading}
          error={error}
        />
      </Stack>
    </div>
  );
}
