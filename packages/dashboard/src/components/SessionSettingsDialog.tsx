import { useEffect, useState, useCallback } from "react";
import { useApi, type WorkflowState } from "../hooks/useApi";
import {
  Modal,
  Button,
  TextInput,
  Select,
  Stack,
  Group,
  Text,
  Table,
  Alert,
  Card,
  Box,
  Slider,
  Divider,
  Badge,
  ActionIcon,
  ColorSwatch,
  Paper,
} from "@mantine/core";
import { useMediaQuery } from "@mantine/hooks";
import { AutonomyLevel } from "@kora/shared";

const AUTONOMY_DESCRIPTIONS: Record<AutonomyLevel, string> = {
  [AutonomyLevel.SuggestOnly]: "Agent proposes actions and waits for approval",
  [AutonomyLevel.AutoRead]: "Agent can explore codebase, asks before editing",
  [AutonomyLevel.AutoApply]: "Agent edits files freely, asks before git operations",
  [AutonomyLevel.FullAuto]: "Agent does everything including git operations",
};

const AUTONOMY_SLIDER_STYLES = {
  track: { backgroundColor: "var(--border-color)" },
  bar: { backgroundColor: "var(--accent-blue)" },
  thumb: { borderColor: "var(--accent-blue)" },
  markLabel: { color: "var(--text-muted)", fontSize: 11 },
};

interface SessionSettingsDialogProps {
  sessionId: string;
  onClose: () => void;
}

interface CustomModel {
  id: string;
  label: string;
  provider: string;
}

interface Provider {
  id: string;
  name: string;
  models: { id: string; name: string }[];
}

export function SessionSettingsDialog({
  sessionId,
  onClose,
}: SessionSettingsDialogProps) {
  const api = useApi();
  const isMobile = useMediaQuery("(max-width: 48em)");

  const [providers, setProviders] = useState<Provider[]>([]);
  const [loadingProviders, setLoadingProviders] = useState(true);
  const [customModels, setCustomModels] = useState<CustomModel[]>([]);
  const [loadingModels, setLoadingModels] = useState(false);

  const [defaultProvider, setDefaultProvider] = useState("");
  const [defaultModel, setDefaultModel] = useState("");
  const [worktreeMode, setWorktreeMode] = useState<string>("");
  // TODO Sprint 5: Wire to session settings API, apply to new agent spawns
  const [defaultAutonomyLevel, setDefaultAutonomyLevel] = useState<AutonomyLevel>(
    AutonomyLevel.AutoRead
  );

  const [newProvider, setNewProvider] = useState("");
  const [newModelId, setNewModelId] = useState("");
  const [newLabel, setNewLabel] = useState("");
  const [adding, setAdding] = useState(false);
  const [error, setError] = useState("");

  // Workflow states
  const DEFAULT_WORKFLOW_STATES: WorkflowState[] = [
    { id: "pending", label: "Pending", color: "#6b7280", category: "not-started" },
    { id: "in-progress", label: "In Progress", color: "#3b82f6", category: "active" },
    { id: "review", label: "Review", color: "#f59e0b", category: "active" },
    { id: "e2e-testing", label: "E2E Testing", color: "#8b5cf6", category: "active" },
    { id: "done", label: "Done", color: "#22c55e", category: "closed" },
  ];
  const AVAILABLE_COLORS = [
    { value: "#6b7280", label: "Gray" },
    { value: "#3b82f6", label: "Blue" },
    { value: "#f59e0b", label: "Yellow" },
    { value: "#22c55e", label: "Green" },
    { value: "#ef4444", label: "Red" },
    { value: "#f97316", label: "Orange" },
    { value: "#8b5cf6", label: "Violet" },
    { value: "#06b6d4", label: "Cyan" },
    { value: "#14b8a6", label: "Teal" },
    { value: "#ec4899", label: "Pink" },
    { value: "#6366f1", label: "Indigo" },
    { value: "#a855f7", label: "Purple" },
  ];
  const [workflowStates, setWorkflowStates] = useState<WorkflowState[]>(DEFAULT_WORKFLOW_STATES);
  const [loadingWorkflow, setLoadingWorkflow] = useState(true);
  const [savingWorkflow, setSavingWorkflow] = useState(false);
  const [newStateName, setNewStateName] = useState("");
  const [newStateColor, setNewStateColor] = useState("#3b82f6");
  const [workflowDirty, setWorkflowDirty] = useState(false);

  useEffect(() => {
    let cancelled = false;
    async function load() {
      try {
        const [providerData, sessionData] = await Promise.all([
          api.getProviders(),
          api.getSession(sessionId) as Promise<any>,
        ]);
        if (!cancelled) {
          setProviders(providerData.providers || []);
          if (sessionData?.worktreeMode) {
            setWorktreeMode(sessionData.worktreeMode);
          }
        }
      } catch {
        // ignore
      } finally {
        if (!cancelled) setLoadingProviders(false);
      }
    }
    load();
    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    if (providers.length === 0) return;
    let cancelled = false;
    async function loadModels() {
      setLoadingModels(true);
      try {
        const allModels: CustomModel[] = [];
        for (const p of providers) {
          try {
            const data = await api.getSessionModels(sessionId, p.id);
            const models = data.models || [];
            for (const m of models) {
              if (m.custom) {
                allModels.push({
                  id: m.id,
                  label: m.label || m.name || m.id,
                  provider: p.id,
                });
              }
            }
          } catch {
            // provider may not support custom models
          }
        }
        if (!cancelled) setCustomModels(allModels);
      } catch {
        // ignore
      } finally {
        if (!cancelled) setLoadingModels(false);
      }
    }
    loadModels();
    return () => {
      cancelled = true;
    };
  }, [providers, sessionId]);

  async function handleAddModel() {
    if (!newProvider || !newModelId.trim()) {
      setError("Provider and Model ID are required.");
      return;
    }
    setError("");
    setAdding(true);
    try {
      await api.addCustomModel(sessionId, {
        id: newModelId.trim(),
        label: newLabel.trim() || newModelId.trim(),
        provider: newProvider,
      });
      setCustomModels((prev) => [
        ...prev,
        {
          id: newModelId.trim(),
          label: newLabel.trim() || newModelId.trim(),
          provider: newProvider,
        },
      ]);
      setNewModelId("");
      setNewLabel("");
    } catch (err: any) {
      setError(err.message || "Failed to add custom model");
    } finally {
      setAdding(false);
    }
  }

  async function handleDeleteModel(modelId: string, provider: string) {
    try {
      await api.removeCustomModel(sessionId, modelId, provider);
      setCustomModels((prev) =>
        prev.filter((m) => !(m.id === modelId && m.provider === provider))
      );
    } catch (err: any) {
      setError(err.message || "Failed to remove custom model");
    }
  }

  // Fetch workflow states
  useEffect(() => {
    let cancelled = false;
    async function loadWorkflow() {
      try {
        const data = await api.getWorkflowStates(sessionId);
        if (!cancelled && data.workflowStates?.length > 0) {
          setWorkflowStates(data.workflowStates);
        }
      } catch {
        // API not available — use defaults
      } finally {
        if (!cancelled) setLoadingWorkflow(false);
      }
    }
    loadWorkflow();
    return () => { cancelled = true; };
  }, [sessionId]);

  const handleSaveWorkflow = useCallback(async () => {
    setSavingWorkflow(true);
    try {
      await api.updateWorkflowStates(sessionId, workflowStates);
      setWorkflowDirty(false);
    } catch (err: any) {
      setError(err.message || "Failed to save workflow states");
    } finally {
      setSavingWorkflow(false);
    }
  }, [sessionId, workflowStates]);

  function handleAddState() {
    if (!newStateName.trim()) return;
    const id = newStateName.trim().toLowerCase().replace(/\s+/g, "-");
    if (workflowStates.some((s) => s.id === id)) {
      setError(`State "${id}" already exists.`);
      return;
    }
    setWorkflowStates((prev) => [...prev, { id, label: newStateName.trim(), color: newStateColor, category: "active" }]);
    setNewStateName("");
    setNewStateColor("#3b82f6");
    setWorkflowDirty(true);
    setError("");
  }

  function handleRemoveState(stateId: string) {
    setWorkflowStates((prev) => prev.filter((s) => s.id !== stateId));
    setWorkflowDirty(true);
  }

  function handleMoveState(index: number, direction: "up" | "down") {
    const newIndex = direction === "up" ? index - 1 : index + 1;
    if (newIndex < 0 || newIndex >= workflowStates.length) return;
    const updated = [...workflowStates];
    [updated[index], updated[newIndex]] = [updated[newIndex], updated[index]];
    setWorkflowStates(updated);
    setWorkflowDirty(true);
  }

  function handleResetWorkflow() {
    setWorkflowStates(DEFAULT_WORKFLOW_STATES);
    setWorkflowDirty(true);
  }

  const providerSelectData = providers.map((p) => ({
    value: p.id,
    label: p.name || p.id,
  }));

  const inputStyles = {
    input: {
      backgroundColor: "var(--bg-tertiary)",
      borderColor: "var(--border-color)",
      color: "var(--text-primary)",
    },
    label: { color: "var(--text-secondary)", fontSize: 13 },
    description: { color: "var(--text-muted)" },
  };

  const selectDropdownStyles = {
    ...inputStyles,
    dropdown: {
      backgroundColor: "var(--bg-secondary)",
      borderColor: "var(--border-color)",
    },
    option: { color: "var(--text-primary)" },
  };

  return (
    <Modal
      opened
      onClose={onClose}
      title="Session Settings"
      size="lg"
      fullScreen={isMobile}
      centered
      styles={{
        header: {
          backgroundColor: "var(--bg-secondary)",
          borderBottom: "1px solid var(--border-color)",
        },
        body: { backgroundColor: "var(--bg-secondary)" },
        content: { backgroundColor: "var(--bg-secondary)" },
        title: { color: "var(--text-primary)", fontWeight: 600, fontSize: 18 },
        close: { color: "var(--text-secondary)" },
      }}
    >
      <Stack gap={24}>
        {error && (
          <Alert color="red" variant="light">
            {error}
          </Alert>
        )}

        {/* Default Provider & Model */}
        <Stack gap="sm">
          <Text fw={600} size="sm" c="var(--text-primary)">
            Defaults
          </Text>
          <Select
            label="Default Provider"
            placeholder={loadingProviders ? "Loading providers..." : "Select provider..."}
            data={providerSelectData}
            value={defaultProvider || null}
            onChange={(v) => setDefaultProvider(v || "")}
            disabled={loadingProviders}
            styles={selectDropdownStyles}
          />
          <TextInput
            label="Default Model"
            value={defaultModel}
            onChange={(e) => setDefaultModel(e.currentTarget.value)}
            placeholder="e.g. gpt-4o, claude-sonnet-4-20250514"
            description="Default model used when spawning new agents."
            styles={inputStyles}
          />
        </Stack>

        <Divider color="var(--border-color)" />

        {/* Worktree Mode */}
        <Box>
          <Text size="xs" c="var(--text-secondary)" mb={4}>
            Worktree Mode
          </Text>
          <Group
            gap={8}
            p="sm"
            style={{
              backgroundColor: "var(--bg-tertiary)",
              borderRadius: 6,
              border: "1px solid var(--border-color)",
            }}
          >
            <svg
              width="14"
              height="14"
              viewBox="0 0 24 24"
              fill="none"
              stroke={
                worktreeMode === "isolated"
                  ? "var(--accent-blue)"
                  : worktreeMode === "shared"
                    ? "var(--accent-purple)"
                    : "var(--text-muted)"
              }
              strokeWidth="2"
              strokeLinecap="round"
              strokeLinejoin="round"
            >
              {worktreeMode === "shared" ? (
                <path d="M22 19a2 2 0 01-2 2H4a2 2 0 01-2-2V5a2 2 0 012-2h5l2 3h9a2 2 0 012 2z" />
              ) : (
                <>
                  <line x1="6" y1="3" x2="6" y2="15" />
                  <circle cx="18" cy="6" r="3" />
                  <circle cx="6" cy="18" r="3" />
                  <path d="M18 9a9 9 0 01-9 9" />
                </>
              )}
            </svg>
            <Text size="sm" fw={500} c="var(--text-primary)">
              {worktreeMode === "isolated"
                ? "Isolated"
                : worktreeMode === "shared"
                  ? "Shared"
                  : "Not set"}
            </Text>
          </Group>
          <Text size="xs" c="var(--text-muted)" mt={4}>
            {worktreeMode === "isolated"
              ? "Each agent has its own git worktree branch. Cannot be changed mid-session."
              : worktreeMode === "shared"
                ? "All agents share the same working directory. Cannot be changed mid-session."
                : "Worktree mode was not configured for this session."}
          </Text>
        </Box>

        <Divider color="var(--border-color)" />

        {/* Default Autonomy Level */}
        <Box>
          <Text size="sm" c="var(--text-primary)" fw={600} mb={12}>
            Default Autonomy Level
          </Text>
          {/* mb={36} reserves space below slider for mark labels + marginTop gap so they don't overlap description text */}
          <Box px="xs" mb={36}>
            <Slider
              value={defaultAutonomyLevel}
              onChange={setDefaultAutonomyLevel}
              min={0}
              max={3}
              step={1}
              marks={[
                { value: 0, label: "Suggest" },
                { value: 1, label: "Auto-read" },
                { value: 2, label: "Auto-apply" },
                { value: 3, label: "Full auto" },
              ]}
              styles={{
                ...AUTONOMY_SLIDER_STYLES,
                markLabel: {
                  ...(AUTONOMY_SLIDER_STYLES.markLabel ?? {}),
                  marginTop: 8,
                },
              }}
            />
          </Box>
          <Text size="xs" c="var(--text-secondary)" fw={500}>
            {AUTONOMY_DESCRIPTIONS[defaultAutonomyLevel]}
          </Text>
          <Text size="xs" c="var(--text-muted)" mt={4}>
            Default for newly spawned agents. Enforcement logic coming in a future sprint.
          </Text>
        </Box>

        <Divider color="var(--border-color)" />

        {/* Workflow States Section */}
        <Box>
          <Group justify="space-between" align="center" mb="sm">
            <Text fw={600} size="sm" c="var(--text-primary)">
              Workflow States
            </Text>
            <Group gap="xs">
              {workflowDirty && (
                <Button
                  size="compact-xs"
                  variant="filled"
                  onClick={handleSaveWorkflow}
                  loading={savingWorkflow}
                  styles={{ root: { backgroundColor: "var(--accent-blue)", borderColor: "var(--accent-blue)" } }}
                >
                  Save
                </Button>
              )}
              <Button
                size="compact-xs"
                variant="subtle"
                color="gray"
                onClick={handleResetWorkflow}
              >
                Reset
              </Button>
            </Group>
          </Group>

          {loadingWorkflow ? (
            <Text size="xs" c="var(--text-muted)" py="sm">Loading workflow states...</Text>
          ) : (
            <Stack gap="xs">
              {/* Current states list */}
              {workflowStates.map((state, idx) => (
                <Paper
                  key={state.id}
                  p="xs"
                  withBorder
                  style={{
                    backgroundColor: "var(--bg-tertiary)",
                    borderColor: "var(--border-color)",
                  }}
                >
                  <Group justify="space-between" align="center" wrap="nowrap">
                    <Group gap="sm" align="center" wrap="nowrap" style={{ flex: 1, minWidth: 0 }}>
                      <ColorSwatch color={state.color || "#6b7280"} size={16} />
                      <Text size="sm" c="var(--text-primary)" fw={500} truncate>
                        {state.label}
                      </Text>
                      <Badge size="xs" variant="outline" color="gray">
                        {state.id}
                      </Badge>
                    </Group>
                    <Group gap={4} wrap="nowrap">
                      <ActionIcon
                        variant="subtle"
                        size="xs"
                        disabled={idx === 0}
                        onClick={() => handleMoveState(idx, "up")}
                        title="Move up"
                        style={{ color: "var(--text-secondary)" }}
                      >
                        <span style={{ fontSize: 12 }}>▲</span>
                      </ActionIcon>
                      <ActionIcon
                        variant="subtle"
                        size="xs"
                        disabled={idx === workflowStates.length - 1}
                        onClick={() => handleMoveState(idx, "down")}
                        title="Move down"
                        style={{ color: "var(--text-secondary)" }}
                      >
                        <span style={{ fontSize: 12 }}>▼</span>
                      </ActionIcon>
                      <ActionIcon
                        variant="subtle"
                        size="xs"
                        color="red"
                        disabled={workflowStates.length <= 2}
                        onClick={() => handleRemoveState(state.id)}
                        title="Remove state"
                      >
                        <span style={{ fontSize: 14 }}>×</span>
                      </ActionIcon>
                    </Group>
                  </Group>
                </Paper>
              ))}

              {/* Add new state form */}
              <Card
                withBorder
                padding="sm"
                radius="md"
                style={{
                  backgroundColor: "var(--bg-tertiary)",
                  borderColor: "var(--border-color)",
                }}
              >
                <Text fw={600} size="xs" c="var(--text-primary)" mb="xs">
                  Add State
                </Text>
                <Group gap="sm" align="end" wrap={isMobile ? "wrap" : "nowrap"}>
                  <TextInput
                    placeholder="e.g. E2E Testing"
                    value={newStateName}
                    onChange={(e) => setNewStateName(e.currentTarget.value)}
                    size="sm"
                    style={{ flex: 1 }}
                    styles={inputStyles}
                    onKeyDown={(e) => { if (e.key === "Enter") handleAddState(); }}
                  />
                  <Select
                    placeholder="Color"
                    data={AVAILABLE_COLORS}
                    value={newStateColor}
                    onChange={(v) => setNewStateColor(v || "#3b82f6")}
                    size="sm"
                    w={isMobile ? "100%" : 120}
                    styles={selectDropdownStyles}
                  />
                  <Button
                    size="sm"
                    onClick={handleAddState}
                    disabled={!newStateName.trim()}
                    styles={{ root: { backgroundColor: "var(--accent-blue)", borderColor: "var(--accent-blue)" } }}
                  >
                    Add
                  </Button>
                </Group>
              </Card>
            </Stack>
          )}

          <Text size="xs" c="var(--text-muted)" mt={8}>
            Workflow states define the columns on the Task Board. Drag tasks between columns to change status.
          </Text>
        </Box>

        <Divider color="var(--border-color)" />

        {/* Custom Models Section */}
        <Box>
          <Text fw={600} size="sm" c="var(--text-primary)" mb="sm">
            Custom Models
          </Text>

          {loadingModels ? (
            <Text size="xs" c="var(--text-muted)" py="sm">
              Loading custom models...
            </Text>
          ) : customModels.length === 0 ? (
            <Text
              size="xs"
              c="var(--text-muted)"
              py="sm"
              style={{
                borderBottom: "1px solid var(--border-color)",
                marginBottom: 12,
              }}
            >
              No custom models configured.
            </Text>
          ) : (
            <Box
              style={{
                border: "1px solid var(--border-color)",
                borderRadius: 6,
                overflow: isMobile ? "auto" : "hidden",
                marginBottom: 16,
              }}
            >
              <Table
                withColumnBorders={false}
                style={{ fontSize: 13 }}
                styles={{
                  th: {
                    backgroundColor: "var(--bg-tertiary)",
                    color: "var(--text-secondary)",
                    fontWeight: 500,
                    padding: "8px 12px",
                  },
                  td: {
                    padding: "8px 12px",
                    borderTop: "1px solid var(--border-color)",
                  },
                }}
              >
                <Table.Thead>
                  <Table.Tr>
                    <Table.Th>Provider</Table.Th>
                    <Table.Th>Model ID</Table.Th>
                    {!isMobile && <Table.Th>Label</Table.Th>}
                    <Table.Th w={60} />
                  </Table.Tr>
                </Table.Thead>
                <Table.Tbody>
                  {customModels.map((m, i) => (
                    <Table.Tr key={`${m.provider}-${m.id}-${i}`}>
                      <Table.Td>
                        <Text c="var(--text-primary)" size="xs">
                          {m.provider}
                        </Text>
                      </Table.Td>
                      <Table.Td>
                        <Text
                          c="var(--text-primary)"
                          size="xs"
                          ff="var(--font-mono)"
                        >
                          {m.id}
                        </Text>
                      </Table.Td>
                      {!isMobile && (
                        <Table.Td>
                          <Text c="var(--text-secondary)" size="xs">
                            {m.label}
                          </Text>
                        </Table.Td>
                      )}
                      <Table.Td>
                        <Button
                          color="red"
                          variant="subtle"
                          size="compact-xs"
                          onClick={() => handleDeleteModel(m.id, m.provider)}
                        >
                          Delete
                        </Button>
                      </Table.Td>
                    </Table.Tr>
                  ))}
                </Table.Tbody>
              </Table>
            </Box>
          )}

          {/* Add Custom Model form */}
          <Card
            withBorder
            padding="md"
            radius="md"
            style={{
              backgroundColor: "var(--bg-tertiary)",
              borderColor: "var(--border-color)",
            }}
          >
            <Text fw={600} size="xs" c="var(--text-primary)" mb="sm">
              Add Custom Model
            </Text>

            <div
              style={{
                display: "grid",
                gridTemplateColumns: isMobile ? "1fr" : "1fr 1fr",
                gap: 12,
              }}
            >
              <Select
                label="Provider"
                size="sm"
                placeholder={loadingProviders ? "Loading..." : "Select provider..."}
                data={providerSelectData}
                value={newProvider || null}
                onChange={(v) => setNewProvider(v || "")}
                disabled={loadingProviders}
                styles={selectDropdownStyles}
              />
              <TextInput
                label="Model ID"
                size="sm"
                value={newModelId}
                onChange={(e) => setNewModelId(e.currentTarget.value)}
                placeholder="ft:gpt-4o:my-org:custom:abc123"
                styles={inputStyles}
              />
            </div>

            <Group mt="sm" gap="sm" align="end" wrap={isMobile ? "wrap" : "nowrap"}>
              <TextInput
                label="Label"
                size="sm"
                value={newLabel}
                onChange={(e) => setNewLabel(e.currentTarget.value)}
                placeholder="My Fine-tuned GPT-4o"
                style={{ flex: 1 }}
                styles={inputStyles}
              />
              <Button
                onClick={handleAddModel}
                disabled={adding || !newProvider || !newModelId.trim()}
                loading={adding}
                styles={{
                  root: {
                    backgroundColor: "var(--accent-blue)",
                    borderColor: "var(--accent-blue)",
                    minHeight: 36,
                  },
                }}
              >
                Add
              </Button>
            </Group>
          </Card>
        </Box>

        <Group justify="flex-end" mt="md">
          <Button
            variant="default"
            onClick={onClose}
            styles={{
              root: {
                backgroundColor: "var(--bg-tertiary)",
                borderColor: "var(--border-color)",
                color: "var(--text-primary)",
                minHeight: 44,
              },
            }}
          >
            Close
          </Button>
        </Group>
      </Stack>
    </Modal>
  );
}
