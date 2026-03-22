import { useEffect, useState, useCallback } from "react";
import {
  Stack,
  Group,
  Text,
  Paper,
  Switch,
  NumberInput,
  Select,
  Button,
  Loader,
  Alert,
  Table,
  Badge,
  Tooltip,
  Divider,
} from "@mantine/core";
import { useApi } from "../hooks/useApi";
import { showSuccess, showError } from "../utils/notifications";
import { formatLastSeen } from "../utils/formatters";

// ---------- Types ----------

interface NudgePolicy {
  enabled: boolean;
  nudgeAfterMinutes: number;
  intervalMinutes: number;
  target: "assignee" | "architect" | "user" | "all";
  escalateAfterCount: number;
  escalateTo: "architect" | "user" | "all";
  maxNudges: number;
}

/** Nudge record from the backend */
interface NudgeRecord {
  id: string;
  task_id: string;
  task_title?: string;
  session_id: string;
  status_at_nudge: string;
  target_agent_id: string | null;
  target_type: string;
  nudge_count: number;
  is_escalation: boolean | number;
  message: string | null;
  created_at: string;
}

interface NudgePolicyEditorProps {
  sessionId: string;
  /** Status color map from workflow states — keys are status IDs, values are hex colors */
  statusColors?: Record<string, string>;
}

// ---------- Helpers ----------

const TARGET_OPTIONS = [
  { value: "assignee", label: "Assignee" },
  { value: "architect", label: "Architect / Master" },
  { value: "user", label: "User (Dashboard)" },
  { value: "all", label: "All agents" },
];

const ESCALATE_OPTIONS = [
  { value: "architect", label: "Architect / Master" },
  { value: "user", label: "User (Dashboard)" },
  { value: "all", label: "All agents" },
];

/** Default fallback colors for common statuses */
const DEFAULT_STATUS_COLORS: Record<string, string> = {
  "pending": "gray",
  "in-progress": "blue",
  "review": "yellow",
  "e2e-testing": "cyan",
  "staging": "teal",
  "blocked": "red",
  "done": "green",
};

function getStatusBadgeColor(status: string, statusColors?: Record<string, string>): string {
  // Prefer dynamic colors from workflow state config
  if (statusColors?.[status]) return statusColors[status];
  return DEFAULT_STATUS_COLORS[status] || "gray";
}

// ---------- Component ----------

export function NudgePolicyEditor({ sessionId, statusColors }: NudgePolicyEditorProps) {
  const api = useApi();
  const [policies, setPolicies] = useState<Record<string, NudgePolicy>>({});
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [dirty, setDirty] = useState(false);

  const loadPolicies = useCallback(async () => {
    try {
      const data = await api.getNudgePolicies(sessionId);
      setPolicies((data as any).policies || {});
      setError(null);
    } catch (err: any) {
      setError(err.message || "Failed to load nudge policies");
    } finally {
      setLoading(false);
    }
  }, [sessionId]);

  useEffect(() => {
    loadPolicies();
  }, [loadPolicies]);

  const updatePolicy = (status: string, field: keyof NudgePolicy, value: string | number | boolean) => {
    setPolicies((prev) => ({
      ...prev,
      [status]: { ...prev[status], [field]: value },
    }));
    setDirty(true);
  };

  const handleSave = async () => {
    setSaving(true);
    try {
      await api.updateNudgePolicies(sessionId, policies);
      setDirty(false);
      showSuccess("Nudge policies saved");
    } catch (err: any) {
      showError(err.message, "Failed to save policies");
    } finally {
      setSaving(false);
    }
  };

  if (loading) {
    return (
      <Paper p="md" withBorder>
        <Group justify="center" p="xl">
          <Loader size="sm" />
          <Text size="sm" c="dimmed">Loading nudge policies...</Text>
        </Group>
      </Paper>
    );
  }

  if (error) {
    return (
      <Alert color="red" title="Error loading nudge policies">
        {error}
      </Alert>
    );
  }

  const statuses = Object.keys(policies);

  if (statuses.length === 0) {
    return (
      <Paper p="md" withBorder>
        <Text c="dimmed" size="sm">No nudge policies configured. The watchdog will use default settings.</Text>
      </Paper>
    );
  }

  return (
    <Stack gap="md">
      <Group justify="space-between">
        <Text size="sm" fw={600}>Stale Task Nudge Policies</Text>
        <Button
          size="xs"
          onClick={handleSave}
          loading={saving}
          disabled={!dirty}
          variant={dirty ? "filled" : "light"}
        >
          {dirty ? "Save Changes" : "Saved"}
        </Button>
      </Group>

      <Text size="xs" c="dimmed">
        Configure when and who gets nudged for tasks stuck in each status.
      </Text>

      {statuses.map((status) => {
        const policy = policies[status];
        if (!policy) return null;

        return (
          <Paper key={status} p="sm" withBorder>
            <Group justify="space-between" mb="xs">
              <Group gap="xs">
                <Badge color={getStatusBadgeColor(status, statusColors)} variant="light" size="sm">
                  {status}
                </Badge>
                <Switch
                  size="xs"
                  checked={policy.enabled}
                  onChange={(e) => updatePolicy(status, "enabled", e.currentTarget.checked)}
                  label={policy.enabled ? "Active" : "Disabled"}
                />
              </Group>
            </Group>

            {policy.enabled && (
              <Stack gap="xs" mt="xs">
                <Group gap="md" wrap="wrap">
                  <NumberInput
                    size="xs"
                    label="Nudge after (min)"
                    description="Time in status before first nudge"
                    value={policy.nudgeAfterMinutes}
                    onChange={(val) => updatePolicy(status, "nudgeAfterMinutes", val || 0)}
                    min={1}
                    max={240}
                    step={5}
                    style={{ width: 160 }}
                  />
                  <NumberInput
                    size="xs"
                    label="Interval (min)"
                    description="Re-nudge every N minutes"
                    value={policy.intervalMinutes}
                    onChange={(val) => updatePolicy(status, "intervalMinutes", val || 0)}
                    min={5}
                    max={120}
                    step={5}
                    style={{ width: 160 }}
                  />
                  <Select
                    size="xs"
                    label="Nudge target"
                    description="Who gets nudged"
                    data={TARGET_OPTIONS}
                    value={policy.target}
                    onChange={(val) => updatePolicy(status, "target", val || "assignee")}
                    style={{ width: 180 }}
                  />
                </Group>

                <Divider my={4} />

                <Group gap="md" wrap="wrap">
                  <NumberInput
                    size="xs"
                    label="Escalate after"
                    description="Nudges before escalation"
                    value={policy.escalateAfterCount}
                    onChange={(val) => updatePolicy(status, "escalateAfterCount", val || 0)}
                    min={0}
                    max={20}
                    style={{ width: 160 }}
                  />
                  <Select
                    size="xs"
                    label="Escalate to"
                    description="Escalation target"
                    data={ESCALATE_OPTIONS}
                    value={policy.escalateTo}
                    onChange={(val) => updatePolicy(status, "escalateTo", val || "user")}
                    style={{ width: 180 }}
                  />
                  <NumberInput
                    size="xs"
                    label="Max nudges"
                    description="0 = unlimited"
                    value={policy.maxNudges}
                    onChange={(val) => updatePolicy(status, "maxNudges", val || 0)}
                    min={0}
                    max={50}
                    style={{ width: 160 }}
                  />
                </Group>
              </Stack>
            )}
          </Paper>
        );
      })}
    </Stack>
  );
}

// ---------- Nudge History Panel ----------

interface NudgeHistoryProps {
  sessionId: string;
  taskId?: string; // If provided, show for a specific task; otherwise session-wide
  statusColors?: Record<string, string>;
}

export function NudgeHistory({ sessionId, taskId, statusColors }: NudgeHistoryProps) {
  const api = useApi();
  const [nudges, setNudges] = useState<NudgeRecord[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    async function load() {
      try {
        const data = taskId
          ? await api.getNudgeHistory(sessionId, taskId)
          : await api.getSessionNudges(sessionId, 50);
        setNudges(((data as any).nudges || []) as NudgeRecord[]);
      } catch {
        // Silently fail — not critical
      } finally {
        setLoading(false);
      }
    }
    load();
  }, [sessionId, taskId]);

  if (loading) {
    return (
      <Group justify="center" p="sm">
        <Loader size="xs" />
        <Text size="xs" c="dimmed">Loading nudge history...</Text>
      </Group>
    );
  }

  if (nudges.length === 0) {
    return (
      <Text size="xs" c="dimmed" p="sm">
        No nudges sent yet.
      </Text>
    );
  }

  return (
    <Table striped highlightOnHover withTableBorder withColumnBorders fz="xs">
      <Table.Thead>
        <Table.Tr>
          {!taskId && <Table.Th>Task</Table.Th>}
          <Table.Th>Status</Table.Th>
          <Table.Th>Target</Table.Th>
          <Table.Th>#</Table.Th>
          <Table.Th>Time</Table.Th>
        </Table.Tr>
      </Table.Thead>
      <Table.Tbody>
        {nudges.map((nudge: any, i: number) => (
          <Table.Tr key={nudge.id || i}>
            {!taskId && (
              <Table.Td>
                <Text size="xs" lineClamp={1}>{nudge.task_title || nudge.task_id}</Text>
              </Table.Td>
            )}
            <Table.Td>
              <Badge size="xs" color={getStatusBadgeColor(nudge.status_at_nudge, statusColors)} variant="light">
                {nudge.status_at_nudge}
              </Badge>
            </Table.Td>
            <Table.Td>
              <Group gap={4}>
                <Text size="xs">{nudge.target_type}</Text>
                {nudge.is_escalation ? (
                  <Badge size="xs" color="orange" variant="light">escalated</Badge>
                ) : null}
              </Group>
            </Table.Td>
            <Table.Td>
              <Text size="xs">#{nudge.nudge_count}</Text>
            </Table.Td>
            <Table.Td>
              <Tooltip label={new Date(nudge.created_at).toLocaleString()}>
                <Text size="xs" c="dimmed">
                  {formatLastSeen(nudge.created_at)}
                </Text>
              </Tooltip>
            </Table.Td>
          </Table.Tr>
        ))}
      </Table.Tbody>
    </Table>
  );
}

// ---------- Stale Task Badge ----------

interface StaleTaskBadgeProps {
  nudgeCount: number;
  lastNudgeAt?: string;
  isEscalated?: boolean;
}

export function StaleTaskBadge({ nudgeCount, lastNudgeAt, isEscalated }: StaleTaskBadgeProps) {
  if (nudgeCount === 0) return null;

  const label = lastNudgeAt
    ? `${nudgeCount} nudge${nudgeCount !== 1 ? "s" : ""} sent, last ${formatLastSeen(lastNudgeAt)}`
    : `${nudgeCount} nudge${nudgeCount !== 1 ? "s" : ""} sent`;

  return (
    <Tooltip label={label} withArrow>
      <Badge
        size="xs"
        color={isEscalated ? "orange" : "yellow"}
        variant="light"
        leftSection={<span style={{ fontSize: 10 }}>{"\u23F0"}</span>}
      >
        {nudgeCount}
      </Badge>
    </Tooltip>
  );
}

