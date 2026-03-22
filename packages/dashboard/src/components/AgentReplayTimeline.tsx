import { useEffect, useState, useCallback, useMemo } from "react";
import {
  Timeline,
  Text,
  Paper,
  Stack,
  Group,
  Badge,
  Button,
  TextInput,
  Select,
  Collapse,
  Code,
  Tooltip,
  Loader,
} from "@mantine/core";
import { useApi } from "../hooks/useApi";
import { formatLastSeen } from "../utils/formatters";

// ---------- Types ----------

interface ToolTrace {
  id: string;
  toolName: string;
  timestamp: string;
  durationMs: number;
  success: boolean;
  error?: string;
  inputArgs?: string; // JSON string, truncated to 10KB
  outputResult?: string; // JSON string, truncated to 10KB
}

interface AgentReplayTimelineProps {
  sessionId: string;
  agentId: string;
}

// ---------- Helpers ----------

function formatDuration(ms: number): string {
  if (ms < 1000) return `${ms}ms`;
  if (ms < 60000) return `${(ms / 1000).toFixed(1)}s`;
  return `${Math.floor(ms / 60000)}m ${Math.round((ms % 60000) / 1000)}s`;
}

function toolColor(name: string): string {
  if (name.includes("read") || name.includes("list") || name.includes("get")) return "cyan";
  if (name.includes("write") || name.includes("edit") || name.includes("create")) return "teal";
  if (name.includes("bash") || name.includes("command") || name.includes("exec")) return "indigo";
  if (name.includes("send") || name.includes("broadcast") || name.includes("message")) return "orange";
  if (name.includes("task") || name.includes("update")) return "grape";
  return "blue";
}

const MAX_PREVIEW = 500;

function truncateJson(str: string | undefined): string {
  if (!str) return "";
  if (str.length <= MAX_PREVIEW) return str;
  return str.slice(0, MAX_PREVIEW) + "...";
}

// ---------- Component ----------

export function AgentReplayTimeline({ sessionId, agentId }: AgentReplayTimelineProps) {
  const api = useApi();
  const [traces, setTraces] = useState<ToolTrace[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [expandedId, setExpandedId] = useState<string | null>(null);
  const [filterTool, setFilterTool] = useState<string | null>(null);
  const [filterStatus, setFilterStatus] = useState<string | null>(null);
  const [search, setSearch] = useState("");

  const loadTraces = useCallback(async () => {
    try {
      const data = await fetch(`/api/v1/sessions/${sessionId}/agents/${agentId}/traces`, {
        headers: { Authorization: `Bearer ${(window as any).__KORA_TOKEN__ || ""}` },
      });
      if (!data.ok) {
        if (data.status === 404) {
          setError("Traces API not available yet.");
        } else {
          setError(`Failed to load traces (${data.status})`);
        }
        return;
      }
      const json = await data.json();
      setTraces(json.traces || []);
      setError(null);
    } catch (err: any) {
      setError(err.message || "Failed to load traces");
    } finally {
      setLoading(false);
    }
  }, [sessionId, agentId]);

  useEffect(() => {
    loadTraces();
    const interval = setInterval(loadTraces, 15000);
    return () => clearInterval(interval);
  }, [loadTraces]);

  // Get unique tool names for filter
  const toolNames = useMemo(
    () => Array.from(new Set(traces.map((t) => t.toolName))).sort(),
    [traces],
  );

  // Apply filters
  const filteredTraces = useMemo(() => {
    let result = traces;
    if (filterTool) result = result.filter((t) => t.toolName === filterTool);
    if (filterStatus === "success") result = result.filter((t) => t.success);
    if (filterStatus === "fail") result = result.filter((t) => !t.success);
    if (search.trim()) {
      const q = search.toLowerCase();
      result = result.filter(
        (t) =>
          t.toolName.toLowerCase().includes(q) ||
          (t.inputArgs || "").toLowerCase().includes(q) ||
          (t.outputResult || "").toLowerCase().includes(q),
      );
    }
    return result;
  }, [traces, filterTool, filterStatus, search]);

  const handleExport = () => {
    const json = JSON.stringify(filteredTraces, null, 2);
    const blob = new Blob([json], { type: "application/json" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `agent-traces-${agentId}-${new Date().toISOString().slice(0, 19)}.json`;
    a.click();
    URL.revokeObjectURL(url);
  };

  if (loading) {
    return (
      <Paper p="xl" withBorder>
        <Group justify="center" gap="sm">
          <Loader size="sm" />
          <Text size="sm" c="dimmed">Loading tool traces...</Text>
        </Group>
      </Paper>
    );
  }

  if (error) {
    return (
      <Paper p="xl" withBorder>
        <Text size="sm" c="dimmed" ta="center">{error}</Text>
      </Paper>
    );
  }

  if (traces.length === 0) {
    return (
      <Paper p="xl" withBorder>
        <Text size="sm" c="dimmed" ta="center">No tool traces recorded yet.</Text>
      </Paper>
    );
  }

  return (
    <Stack gap="md">
      {/* Header + Filters */}
      <Group justify="space-between" wrap="wrap">
        <Group gap="sm">
          <Text size="lg" fw={700}>Tool Trace Timeline</Text>
          <Badge variant="light" color="blue" size="sm">{filteredTraces.length} calls</Badge>
        </Group>
        <Group gap="sm">
          <TextInput
            size="xs"
            placeholder="Search..."
            value={search}
            onChange={(e) => setSearch(e.currentTarget.value)}
            style={{ width: 150 }}
            styles={{ input: { backgroundColor: "var(--bg-primary)", borderColor: "var(--border-color)", color: "var(--text-primary)" } }}
          />
          <Select
            size="xs"
            placeholder="Tool"
            data={toolNames.map((t) => ({ value: t, label: t }))}
            value={filterTool}
            onChange={setFilterTool}
            clearable
            style={{ width: 140 }}
          />
          <Select
            size="xs"
            placeholder="Status"
            data={[{ value: "success", label: "Success" }, { value: "fail", label: "Failed" }]}
            value={filterStatus}
            onChange={setFilterStatus}
            clearable
            style={{ width: 100 }}
          />
          <Button size="xs" variant="light" onClick={handleExport}>
            Export JSON
          </Button>
        </Group>
      </Group>

      {/* Timeline */}
      <Timeline active={filteredTraces.length - 1} bulletSize={20} lineWidth={2}>
        {filteredTraces.map((trace) => {
          const isExpanded = expandedId === trace.id;
          return (
            <Timeline.Item
              key={trace.id}
              bullet={
                <span style={{
                  width: 8, height: 8, borderRadius: "50%",
                  background: trace.success ? "var(--accent-green)" : "var(--accent-red)",
                  display: "inline-block",
                }} />
              }
              title={
                <Group gap="xs" style={{ cursor: "pointer" }} onClick={() => setExpandedId(isExpanded ? null : trace.id)}>
                  <Badge size="xs" color={toolColor(trace.toolName)} variant="light">
                    {trace.toolName}
                  </Badge>
                  <Text size="xs" c="dimmed">{formatDuration(trace.durationMs)}</Text>
                  {!trace.success && (
                    <Badge size="xs" color="red" variant="filled">failed</Badge>
                  )}
                  <Text size="xs" c="dimmed" style={{ marginLeft: "auto" }}>
                    {formatLastSeen(trace.timestamp)}
                  </Text>
                  <Text size="xs" c="blue">{isExpanded ? "collapse" : "expand"}</Text>
                </Group>
              }
            >
              <Collapse in={isExpanded}>
                <Stack gap="xs" mt="xs">
                  <Text size="xs" c="dimmed">
                    {new Date(trace.timestamp).toLocaleString()} — {formatDuration(trace.durationMs)}
                  </Text>
                  {trace.inputArgs && (
                    <div>
                      <Text size="xs" fw={600} mb={2}>Input:</Text>
                      <Code block style={{ maxHeight: 200, overflow: "auto", fontSize: 11 }}>
                        {truncateJson(trace.inputArgs)}
                      </Code>
                    </div>
                  )}
                  {trace.outputResult && (
                    <div>
                      <Text size="xs" fw={600} mb={2}>Output:</Text>
                      <Code block style={{ maxHeight: 200, overflow: "auto", fontSize: 11 }}>
                        {truncateJson(trace.outputResult)}
                      </Code>
                    </div>
                  )}
                  {trace.error && (
                    <div>
                      <Text size="xs" fw={600} c="red" mb={2}>Error:</Text>
                      <Code block color="red" style={{ fontSize: 11 }}>{trace.error}</Code>
                    </div>
                  )}
                </Stack>
              </Collapse>
            </Timeline.Item>
          );
        })}
      </Timeline>
    </Stack>
  );
}
