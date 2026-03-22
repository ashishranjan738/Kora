import { useState, useCallback } from "react";
import { useNavigate } from "react-router-dom";
import {
  Alert,
  Badge,
  Button,
  Group,
  Text,
  Stack,
  Modal,
  Select,
  Paper,
  CloseButton,
  List,
} from "@mantine/core";
import { useMediaQuery } from "@mantine/hooks";
import { useApi } from "../hooks/useApi";
import { showSuccess, showError } from "../utils/notifications";
import type { TaskMetricsResponse, AgentTaskMetrics } from "./WorkloadChart";

// ---------- Types ----------

interface BottleneckAlertProps {
  metrics: TaskMetricsResponse;
  sessionId: string;
  /** Tasks from the session — used to show blocked task names */
  tasks?: Array<{ id: string; title: string; assignedTo?: string; status: string; dependencies?: string[] }>;
  /** Available agents for reassignment */
  agents?: Array<{ id: string; name: string; status: string }>;
  /** Score threshold to show the alert (default: 40) */
  threshold?: number;
  /** Compact mode — single line for Session Overview */
  compact?: boolean;
}

// ---------- Helpers ----------

const DEFAULT_THRESHOLD = 40;

function formatCycleTime(ms: number): string {
  if (ms <= 0) return "N/A";
  const minutes = Math.round(ms / 60000);
  if (minutes < 60) return `${minutes} min`;
  const hours = Math.floor(minutes / 60);
  const remainMins = minutes % 60;
  return remainMins > 0 ? `${hours}h ${remainMins}m` : `${hours}h`;
}

function scoreColor(score: number): string {
  if (score >= 70) return "red";
  if (score >= 50) return "orange";
  return "yellow";
}

// ---------- Component ----------

export function BottleneckAlert({
  metrics,
  sessionId,
  tasks = [],
  agents = [],
  threshold = DEFAULT_THRESHOLD,
  compact = false,
}: BottleneckAlertProps) {
  const api = useApi();
  const navigate = useNavigate();
  const isMobile = useMediaQuery("(max-width: 768px)");
  const [dismissed, setDismissed] = useState(false);
  const [dismissedScore, setDismissedScore] = useState(0);
  const [nudging, setNudging] = useState(false);
  const [reassignOpen, setReassignOpen] = useState(false);

  const bottleneck = metrics.session.topBottleneck;

  // Don't render if no bottleneck or below threshold
  if (!bottleneck || bottleneck.score < threshold) return null;

  // Re-show if score increased since dismissal
  if (dismissed && bottleneck.score <= dismissedScore) return null;

  // Find the bottleneck agent's detailed metrics
  const agentMetrics = metrics.agents.find((a) => a.agentId === bottleneck.agentId);

  // Find tasks blocked by this agent's tasks
  const bottleneckAgentTasks = tasks.filter(
    (t) => t.assignedTo === bottleneck.agentId || t.assignedTo === bottleneck.agentName
  );
  const bottleneckTaskIds = new Set(bottleneckAgentTasks.map((t) => t.id));
  const blockedByThisAgent = tasks.filter(
    (t) =>
      t.dependencies?.some((depId) => bottleneckTaskIds.has(depId)) &&
      t.status !== "done"
  );

  const handleNudge = useCallback(async () => {
    setNudging(true);
    try {
      await api.nudgeAgent(sessionId, bottleneck.agentId);
      showSuccess(`Nudged ${bottleneck.agentName}`);
    } catch (err: any) {
      showError(err.message, "Failed to nudge");
    } finally {
      setNudging(false);
    }
  }, [sessionId, bottleneck.agentId, bottleneck.agentName]);

  const handleDismiss = () => {
    setDismissed(true);
    setDismissedScore(bottleneck.score);
  };

  // ---------- Compact mode (Session Overview) ----------

  if (compact || isMobile) {
    return (
      <Alert
        color="orange"
        variant="light"
        p="xs"
        style={{ cursor: "pointer" }}
        onClick={() => navigate(`/session/${sessionId}#workload`)}
      >
        <Group gap="xs" wrap="nowrap">
          <Text size="sm" fw={600}>
            {"\u26A0"} Bottleneck: {bottleneck.agentName}
          </Text>
          <Badge color={scoreColor(bottleneck.score)} size="xs" variant="filled">
            {bottleneck.score}
          </Badge>
          <Button
            size="compact-xs"
            variant="light"
            color="orange"
            onClick={(e) => {
              e.stopPropagation();
              handleNudge();
            }}
            loading={nudging}
          >
            Nudge
          </Button>
        </Group>
      </Alert>
    );
  }

  // ---------- Full mode (Workload tab) ----------

  return (
    <>
      <Alert
        color="orange"
        variant="light"
        title={
          <Group gap="sm" justify="space-between" wrap="nowrap">
            <Group gap="xs">
              <Text fw={600}>{"\u26A0"} Bottleneck: {bottleneck.agentName}</Text>
              <Badge color={scoreColor(bottleneck.score)} size="sm" variant="filled">
                Score: {bottleneck.score}
              </Badge>
            </Group>
            <CloseButton size="sm" onClick={handleDismiss} title="Dismiss" />
          </Group>
        }
      >
        <Stack gap="sm">
          {/* Reason */}
          <Text size="sm" c="dimmed">{bottleneck.reason}</Text>

          {/* Blocked tasks list */}
          {blockedByThisAgent.length > 0 && (
            <div>
              <Text size="xs" fw={600} mb={4}>
                Holding up {blockedByThisAgent.length} task{blockedByThisAgent.length !== 1 ? "s" : ""}:
              </Text>
              <List size="xs" spacing={2}>
                {blockedByThisAgent.slice(0, 5).map((t) => (
                  <List.Item key={t.id}>
                    <Text size="xs" lineClamp={1}>{t.title}</Text>
                  </List.Item>
                ))}
                {blockedByThisAgent.length > 5 && (
                  <List.Item>
                    <Text size="xs" c="dimmed">
                      +{blockedByThisAgent.length - 5} more
                    </Text>
                  </List.Item>
                )}
              </List>
            </div>
          )}

          {/* Cycle time comparison */}
          {agentMetrics && metrics.session.avgCycleTimeMs > 0 && (
            <Text size="xs" c="dimmed">
              Avg cycle: {formatCycleTime(agentMetrics.avgCycleTimeMs)}
              {" (Team avg: "}{formatCycleTime(metrics.session.avgCycleTimeMs)}{")"}
            </Text>
          )}

          {/* Action buttons */}
          <Group gap="sm" mt={4}>
            <Button
              size="xs"
              variant="filled"
              color="orange"
              onClick={handleNudge}
              loading={nudging}
            >
              Nudge {bottleneck.agentName}
            </Button>
            <Button
              size="xs"
              variant="light"
              color="orange"
              onClick={() => setReassignOpen(true)}
            >
              Reassign Tasks
            </Button>
          </Group>
        </Stack>
      </Alert>

      {/* Reassign Modal */}
      <ReassignModal
        opened={reassignOpen}
        onClose={() => setReassignOpen(false)}
        sessionId={sessionId}
        bottleneckAgentName={bottleneck.agentName}
        tasks={bottleneckAgentTasks.filter((t) => t.status !== "done")}
        agents={agents.filter(
          (a) => a.id !== bottleneck.agentId && (a.status === "running" || a.status === "idle")
        )}
      />
    </>
  );
}

// ---------- Reassign Modal ----------

interface ReassignModalProps {
  opened: boolean;
  onClose: () => void;
  sessionId: string;
  bottleneckAgentName: string;
  tasks: Array<{ id: string; title: string; status: string }>;
  agents: Array<{ id: string; name: string }>;
}

function ReassignModal({
  opened,
  onClose,
  sessionId,
  bottleneckAgentName,
  tasks,
  agents,
}: ReassignModalProps) {
  const api = useApi();
  const [assignments, setAssignments] = useState<Record<string, string>>({});
  const [saving, setSaving] = useState(false);

  const agentOptions = agents.map((a) => ({ value: a.id, label: a.name }));

  const handleReassign = async () => {
    setSaving(true);
    let reassigned = 0;
    try {
      for (const [taskId, newAgentId] of Object.entries(assignments)) {
        if (newAgentId) {
          const agent = agents.find((a) => a.id === newAgentId);
          await api.updateTask(sessionId, taskId, { assignedTo: agent?.name || newAgentId });
          reassigned++;
        }
      }
      if (reassigned > 0) {
        showSuccess(`Reassigned ${reassigned} task${reassigned !== 1 ? "s" : ""}`);
      }
      onClose();
      setAssignments({});
    } catch (err: any) {
      showError(err.message, "Failed to reassign");
    } finally {
      setSaving(false);
    }
  };

  const selectedCount = Object.values(assignments).filter(Boolean).length;

  return (
    <Modal
      opened={opened}
      onClose={onClose}
      title={`Reassign ${bottleneckAgentName}'s tasks`}
      size="md"
    >
      <Stack gap="sm">
        {tasks.length === 0 ? (
          <Text size="sm" c="dimmed">No active tasks to reassign.</Text>
        ) : (
          <>
            <Text size="xs" c="dimmed">
              Select a new assignee for each task you want to reassign.
            </Text>
            {tasks.map((task) => (
              <Paper key={task.id} p="xs" withBorder>
                <Group justify="space-between" wrap="nowrap" gap="sm">
                  <div style={{ flex: 1, minWidth: 0 }}>
                    <Text size="sm" lineClamp={1} fw={500}>{task.title}</Text>
                    <Text size="xs" c="dimmed">{task.status}</Text>
                  </div>
                  <Select
                    size="xs"
                    placeholder="Reassign to..."
                    data={agentOptions}
                    value={assignments[task.id] || null}
                    onChange={(val) =>
                      setAssignments((prev) => ({ ...prev, [task.id]: val || "" }))
                    }
                    clearable
                    style={{ width: 160 }}
                  />
                </Group>
              </Paper>
            ))}
          </>
        )}

        <Group justify="flex-end" mt="sm">
          <Button variant="default" size="xs" onClick={onClose}>
            Cancel
          </Button>
          <Button
            size="xs"
            color="orange"
            onClick={handleReassign}
            loading={saving}
            disabled={selectedCount === 0}
          >
            Reassign {selectedCount > 0 ? `(${selectedCount})` : ""}
          </Button>
        </Group>
      </Stack>
    </Modal>
  );
}
