import { useState, useEffect, useCallback } from "react";
import { useApi } from "../hooks/useApi";
import { showError, showSuccess } from "../utils/notifications";
import { ConfirmDialog } from "./ConfirmDialog";
import {
  Button,
  Checkbox,
  Group,
  Text,
  Stack,
  Paper,
  Badge,
  Loader,
  Alert,
  Progress,
} from "@mantine/core";

interface OrphanedResource {
  agentId: string;
  name: string;
  worktreePath?: string;
  branchName?: string;
  logSize?: number;
  createdAt?: string;
}

interface CleanupPanelProps {
  sessionId: string;
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

function timeAgo(dateStr: string): string {
  const seconds = Math.floor((Date.now() - new Date(dateStr).getTime()) / 1000);
  if (seconds < 60) return `${seconds}s ago`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  return `${Math.floor(hours / 24)}d ago`;
}

export function CleanupPanel({ sessionId }: CleanupPanelProps) {
  const api = useApi();
  const [resources, setResources] = useState<OrphanedResource[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [showConfirm, setShowConfirm] = useState(false);
  const [cleaning, setCleaning] = useState(false);
  const [progress, setProgress] = useState(0);
  const [cleanResult, setCleanResult] = useState<{ cleaned: number; errors: string[] } | null>(null);

  const loadResources = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const data = await api.getOrphanedResources(sessionId);
      setResources(data.resources || []);
    } catch (err: any) {
      if (err.message?.includes("404")) {
        setError("Cleanup API not available yet. Backend endpoint needed.");
      } else {
        setError(err.message || "Failed to scan for orphaned resources");
      }
    } finally {
      setLoading(false);
    }
  }, [sessionId]);

  useEffect(() => {
    loadResources();
  }, [loadResources]);

  const toggleSelect = (agentId: string) => {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(agentId)) {
        next.delete(agentId);
      } else {
        next.add(agentId);
      }
      return next;
    });
  };

  const toggleSelectAll = () => {
    if (selected.size === resources.length) {
      setSelected(new Set());
    } else {
      setSelected(new Set(resources.map((r) => r.agentId)));
    }
  };

  const handleCleanup = async () => {
    setShowConfirm(false);
    setCleaning(true);
    setProgress(10);
    setCleanResult(null);

    try {
      setProgress(30);
      const result = await api.cleanupResources(sessionId, Array.from(selected));
      setProgress(100);
      setCleanResult(result);

      if (result.cleaned > 0) {
        showSuccess(`Cleaned up ${result.cleaned} orphaned resource${result.cleaned !== 1 ? "s" : ""}`);
      }
      if (result.errors.length > 0) {
        showError(`${result.errors.length} cleanup error${result.errors.length !== 1 ? "s" : ""}: ${result.errors[0]}`, "Partial cleanup");
      }

      // Refresh the list
      setSelected(new Set());
      await loadResources();
    } catch (err: any) {
      showError(err.message || "Cleanup failed", "Cleanup Error");
    } finally {
      setCleaning(false);
      setProgress(0);
    }
  };

  const totalLogSize = resources.reduce((sum, r) => sum + (r.logSize || 0), 0);
  const selectedResources = resources.filter((r) => selected.has(r.agentId));
  const selectedLogSize = selectedResources.reduce((sum, r) => sum + (r.logSize || 0), 0);

  return (
    <Stack gap="md">
      <Group justify="space-between" align="center">
        <div>
          <Text fw={600} size="sm" c="var(--text-primary)">
            Orphaned Resources
          </Text>
          <Text size="xs" c="var(--text-muted)">
            Stale worktrees, branches, and logs from removed agents
          </Text>
        </div>
        <Button
          variant="subtle"
          size="xs"
          onClick={loadResources}
          loading={loading}
          styles={{
            root: { color: "var(--accent-blue)" },
          }}
        >
          Rescan
        </Button>
      </Group>

      {loading && (
        <Group justify="center" py="xl">
          <Loader size="sm" />
          <Text size="sm" c="var(--text-muted)">
            Scanning for orphaned resources...
          </Text>
        </Group>
      )}

      {error && (
        <Alert color="yellow" variant="light" styles={{ message: { fontSize: 13 } }}>
          {error}
        </Alert>
      )}

      {!loading && !error && resources.length === 0 && (
        <Paper
          p="xl"
          withBorder
          style={{
            backgroundColor: "var(--bg-tertiary)",
            borderColor: "var(--border-color)",
            textAlign: "center",
          }}
        >
          <Text size="sm" c="var(--accent-green)" fw={500}>
            No orphaned resources found
          </Text>
          <Text size="xs" c="var(--text-muted)" mt={4}>
            All agent worktrees and branches are accounted for
          </Text>
        </Paper>
      )}

      {!loading && resources.length > 0 && (
        <>
          {/* Summary bar */}
          <Group justify="space-between" align="center">
            <Group gap="sm">
              <Checkbox
                checked={selected.size === resources.length}
                indeterminate={selected.size > 0 && selected.size < resources.length}
                onChange={toggleSelectAll}
                label={
                  <Text size="xs" c="var(--text-secondary)">
                    Select All ({resources.length})
                  </Text>
                }
                styles={{
                  input: {
                    backgroundColor: "var(--bg-tertiary)",
                    borderColor: "var(--border-color)",
                  },
                }}
              />
              {totalLogSize > 0 && (
                <Badge variant="light" color="gray" size="sm">
                  {formatBytes(totalLogSize)} total
                </Badge>
              )}
            </Group>
            <Button
              size="xs"
              color="red"
              variant="light"
              disabled={selected.size === 0 || cleaning}
              loading={cleaning}
              onClick={() => setShowConfirm(true)}
            >
              Clean Up ({selected.size})
            </Button>
          </Group>

          {/* Progress bar during cleanup */}
          {cleaning && (
            <Progress
              value={progress}
              animated
              size="sm"
              color="red"
              styles={{
                root: { backgroundColor: "var(--bg-tertiary)" },
              }}
            />
          )}

          {/* Resource list */}
          <Stack gap={4}>
            {resources.map((resource) => (
              <Paper
                key={resource.agentId}
                p="sm"
                withBorder
                style={{
                  backgroundColor: selected.has(resource.agentId)
                    ? "rgba(248, 81, 73, 0.06)"
                    : "var(--bg-primary)",
                  borderColor: selected.has(resource.agentId)
                    ? "var(--accent-red)"
                    : "var(--border-color)",
                  cursor: "pointer",
                  transition: "border-color 0.15s, background-color 0.15s",
                }}
                onClick={() => toggleSelect(resource.agentId)}
              >
                <Group gap="sm" wrap="nowrap">
                  <Checkbox
                    checked={selected.has(resource.agentId)}
                    onChange={() => toggleSelect(resource.agentId)}
                    styles={{
                      input: {
                        backgroundColor: "var(--bg-tertiary)",
                        borderColor: "var(--border-color)",
                      },
                    }}
                  />
                  <div style={{ flex: 1, minWidth: 0 }}>
                    <Group gap={8} wrap="nowrap">
                      <Text size="sm" fw={500} c="var(--text-primary)" lineClamp={1}>
                        {resource.name}
                      </Text>
                      {resource.branchName && (
                        <Badge
                          variant="outline"
                          color="blue"
                          size="xs"
                          styles={{ root: { flexShrink: 0 } }}
                        >
                          {resource.branchName}
                        </Badge>
                      )}
                    </Group>
                    <Group gap={8} mt={2}>
                      {resource.worktreePath && (
                        <Text
                          size="xs"
                          c="var(--text-muted)"
                          ff="var(--font-mono)"
                          lineClamp={1}
                          style={{ maxWidth: 300 }}
                        >
                          {resource.worktreePath}
                        </Text>
                      )}
                      {resource.logSize != null && resource.logSize > 0 && (
                        <Badge variant="light" color="gray" size="xs">
                          {formatBytes(resource.logSize)}
                        </Badge>
                      )}
                      {resource.createdAt && (
                        <Text size="xs" c="var(--text-muted)">
                          {timeAgo(resource.createdAt)}
                        </Text>
                      )}
                    </Group>
                  </div>
                </Group>
              </Paper>
            ))}
          </Stack>

          {/* Result summary */}
          {cleanResult && (
            <Alert
              color={cleanResult.errors.length > 0 ? "yellow" : "green"}
              variant="light"
              styles={{ message: { fontSize: 13 } }}
            >
              Cleaned {cleanResult.cleaned} resource{cleanResult.cleaned !== 1 ? "s" : ""}.
              {selectedLogSize > 0 && ` Freed ~${formatBytes(selectedLogSize)}.`}
              {cleanResult.errors.length > 0 && (
                <>
                  {" "}
                  {cleanResult.errors.length} error{cleanResult.errors.length !== 1 ? "s" : ""}:
                  {cleanResult.errors.slice(0, 3).map((e, i) => (
                    <Text key={i} size="xs" c="var(--text-muted)" mt={2}>
                      {e}
                    </Text>
                  ))}
                </>
              )}
            </Alert>
          )}
        </>
      )}

      {/* Confirmation dialog */}
      <ConfirmDialog
        opened={showConfirm}
        onClose={() => setShowConfirm(false)}
        onConfirm={handleCleanup}
        title="Clean Up Resources"
        message={`Remove ${selected.size} orphaned resource${selected.size !== 1 ? "s" : ""}? This will delete worktrees, branches, and log files. This action cannot be undone.`}
        confirmLabel={`Clean Up ${selected.size} Resource${selected.size !== 1 ? "s" : ""}`}
        confirmColor="red"
      />
    </Stack>
  );
}
