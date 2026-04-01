import { useEffect, useState, useRef } from "react";
import { useApi } from "../hooks/useApi";
import {
  Modal,
  Button,
  TextInput,
  Textarea,
  Select,
  Stack,
  Group,
  Text,
  Table,
  Alert,
  Card,
  Box,
  Slider,
  Switch,
  Divider,
} from "@mantine/core";
import { useMediaQuery } from "@mantine/hooks";
import { AutonomyLevel } from "@kora/shared";
import { NudgePolicyEditor } from "./NudgePolicyEditor";
import { CleanupPanel } from "./CleanupPanel";

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
  const [autoAssign, setAutoAssign] = useState(true);
  const [allowMasterForceTransition, setAllowMasterForceTransition] = useState(false);
  const [budgetLimit, setBudgetLimit] = useState<string>("");
  const budgetSaveTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  // TODO Sprint 5: Wire to session settings API, apply to new agent spawns
  const [defaultAutonomyLevel, setDefaultAutonomyLevel] = useState<AutonomyLevel>(
    AutonomyLevel.AutoRead
  );

  const [newProvider, setNewProvider] = useState("");
  const [newModelId, setNewModelId] = useState("");
  const [newLabel, setNewLabel] = useState("");
  const [adding, setAdding] = useState(false);
  const [error, setError] = useState("");

  // Session instructions
  const [sessionInstructions, setSessionInstructions] = useState("");
  const [instructionsLastUpdated, setInstructionsLastUpdated] = useState<string | null>(null);
  const [savingInstructions, setSavingInstructions] = useState(false);
  const [instructionsSaved, setInstructionsSaved] = useState(false);

  // Per-state workflow instructions
  interface WorkflowStateEntry { id: string; label: string; instructions?: string; color: string; category: string }
  const [workflowStates, setWorkflowStates] = useState<WorkflowStateEntry[]>([]);
  const [stateInstructionsDraft, setStateInstructionsDraft] = useState<Record<string, string>>({});
  const [savingStateInstructions, setSavingStateInstructions] = useState(false);
  const [stateInstructionsSaved, setStateInstructionsSaved] = useState(false);
  const [expandedState, setExpandedState] = useState<string | null>(null);

  // Watchdog delivery config
  type DeliveryMode = "immediate" | "idle-only" | "custom";
  const [deliveryMode, setDeliveryMode] = useState<DeliveryMode>("custom");
  const [staleTaskMode, setStaleTaskMode] = useState<DeliveryMode>("immediate");
  const [contextRefreshMode, setContextRefreshMode] = useState<DeliveryMode>("idle-only");
  const [contextEventOverrides, setContextEventOverrides] = useState<Record<string, DeliveryMode>>({
    taskAssignment: "immediate",
    personaUpdate: "immediate",
    instructionsUpdate: "immediate",
    teamChange: "idle-only",
    knowledgeUpdate: "idle-only",
  });
  const [savingDelivery, setSavingDelivery] = useState(false);
  const [deliverySaved, setDeliverySaved] = useState(false);

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
          if (sessionData?.autoAssign !== undefined) {
            setAutoAssign(sessionData.autoAssign);
          }
          if (sessionData?.allowMasterForceTransition !== undefined) {
            setAllowMasterForceTransition(sessionData.allowMasterForceTransition);
          }
          if (sessionData?.budgetLimit) {
            setBudgetLimit(String(sessionData.budgetLimit));
          }
        }
      } catch {
        // ignore
      } finally {
        if (!cancelled) setLoadingProviders(false);
      }
    }
    async function loadInstructions() {
      try {
        const data = await api.getSessionInstructions(sessionId);
        if (!cancelled) {
          setSessionInstructions(data.instructions || "");
          if (data.lastUpdated) setInstructionsLastUpdated(data.lastUpdated);
        }
      } catch {
        // Endpoint may not exist yet
      }
    }
    async function loadDeliveryConfig() {
      try {
        const data: any = await api.getSession(sessionId);
        if (!cancelled && data?.watchdogDelivery) {
          const cfg = data.watchdogDelivery;
          if (cfg.mode) setDeliveryMode(cfg.mode);
          if (cfg.overrides?.staleTask?.mode) setStaleTaskMode(cfg.overrides.staleTask.mode);
          if (cfg.overrides?.contextRefresh?.mode) setContextRefreshMode(cfg.overrides.contextRefresh.mode);
          if (cfg.overrides?.contextRefresh?.perEvent) {
            setContextEventOverrides((prev) => ({ ...prev, ...cfg.overrides.contextRefresh.perEvent }));
          }
        }
      } catch {
        // Config may not exist yet
      }
    }
    async function loadWorkflowStates() {
      try {
        const data = await api.getWorkflowStates(sessionId);
        if (!cancelled && data?.states) {
          setWorkflowStates(data.states);
          const draft: Record<string, string> = {};
          for (const s of data.states) {
            draft[s.id] = s.instructions || "";
          }
          setStateInstructionsDraft(draft);
        }
      } catch {
        // Endpoint may not exist yet
      }
    }
    load();
    loadInstructions();
    loadDeliveryConfig();
    loadWorkflowStates();
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

        {/* Budget Limit */}
        <Divider my="md" />
        <Stack gap="xs">
          <Text size="sm" fw={600}>Session Budget</Text>
          <Text size="xs" c="dimmed">Set a maximum cost limit. Agents will be auto-paused when exceeded.</Text>
          <Group gap="sm">
            <TextInput
              size="xs"
              placeholder="e.g. 5.00"
              leftSection={<Text size="xs" c="dimmed">$</Text>}
              style={{ width: 120 }}
              styles={{
                input: {
                  backgroundColor: "var(--bg-primary)",
                  borderColor: "var(--border-color)",
                  color: "var(--text-primary)",
                },
              }}
              value={budgetLimit}
              onChange={(e) => {
                const raw = e.currentTarget.value;
                setBudgetLimit(raw);
                // Debounce save — 800ms after last keystroke
                if (budgetSaveTimer.current) clearTimeout(budgetSaveTimer.current);
                budgetSaveTimer.current = setTimeout(async () => {
                  const val = parseFloat(raw);
                  if (!isNaN(val) && val > 0) {
                    try {
                      await api.updateSessionConfig(sessionId, { budgetLimit: val });
                    } catch {}
                  }
                }, 800);
              }}
            />
            <Text size="xs" c="dimmed">Leave empty for no limit</Text>
          </Group>
        </Stack>

        {/* Auto-assign tasks to idle agents */}
        <Divider my="md" />
        <Group justify="space-between" align="center">
          <div>
            <Text size="sm" fw={600}>Auto-assign tasks to idle agents</Text>
            <Text size="xs" c="dimmed">When enabled, unassigned tasks are automatically assigned to idle agents</Text>
          </div>
          <Switch
            checked={autoAssign}
            onChange={async (e) => {
              const newVal = e.currentTarget.checked;
              setAutoAssign(newVal);
              try {
                await api.updateSessionConfig(sessionId, { autoAssign: newVal });
              } catch {
                // Revert on failure
                setAutoAssign(!newVal);
              }
            }}
            size="md"
          />
        </Group>

        {/* Allow master force transitions */}
        <Divider my="md" />
        <Group justify="space-between" align="center">
          <div>
            <Text size="sm" fw={600}>Allow master agents to force task transitions</Text>
            <Text size="xs" c="dimmed">When enabled, master/orchestrator agents can bypass pipeline transitions. When disabled (default), only humans can.</Text>
          </div>
          <Switch
            aria-label="Allow master agents to force task transitions"
            checked={allowMasterForceTransition}
            onChange={async (e) => {
              const newVal = e.currentTarget.checked;
              setAllowMasterForceTransition(newVal);
              try {
                await api.updateSessionConfig(sessionId, { allowMasterForceTransition: newVal });
              } catch {
                setAllowMasterForceTransition(!newVal);
              }
            }}
            size="md"
          />
        </Group>

        {/* Notification Delivery */}
        <Divider my="md" />
        <Stack gap="xs">
          <Text size="sm" fw={600} c="var(--text-primary)">Notification Delivery</Text>
          <Text size="xs" c="dimmed">
            Control when watchdog notifications (stale tasks, context updates) are delivered to agents.
          </Text>

          {/* Top-level mode */}
          <div style={{ display: "flex", flexDirection: "column", gap: 6, marginTop: 4 }}>
            {(["immediate", "idle-only", "custom"] as DeliveryMode[]).map((mode) => (
              <label key={mode} style={{ display: "flex", alignItems: "flex-start", gap: 8, cursor: "pointer" }}>
                <input
                  type="radio"
                  name="delivery-mode"
                  checked={deliveryMode === mode}
                  onChange={() => { setDeliveryMode(mode); setDeliverySaved(false); }}
                  style={{ marginTop: 3 }}
                />
                <span>
                  <strong style={{ color: "var(--text-primary)", fontSize: 13 }}>
                    {mode === "immediate" ? "Immediate" : mode === "idle-only" ? "When Agents Are Idle" : "Custom"}
                  </strong>
                  <span style={{ display: "block", fontSize: 11, color: "var(--text-muted)" }}>
                    {mode === "immediate"
                      ? "All notifications delivered instantly, even if agent is working."
                      : mode === "idle-only"
                      ? "Queue notifications and deliver when agent becomes idle."
                      : "Configure per-watchdog delivery rules."}
                  </span>
                </span>
              </label>
            ))}
          </div>

          {/* Custom per-watchdog overrides */}
          {deliveryMode === "custom" && (
            <Card withBorder padding="sm" radius="md" mt={4} style={{ backgroundColor: "var(--bg-tertiary)", borderColor: "var(--border-color)" }}>
              <Stack gap="sm">
                <Group justify="space-between" align="center">
                  <Text size="xs" fw={600} c="var(--text-primary)">Stale Task Nudges</Text>
                  <select
                    value={staleTaskMode}
                    onChange={(e) => { setStaleTaskMode(e.target.value as DeliveryMode); setDeliverySaved(false); }}
                    style={{ fontSize: 12, padding: "3px 8px", borderRadius: 4, border: "1px solid var(--border-color)", backgroundColor: "var(--bg-primary)", color: "var(--text-primary)" }}
                  >
                    <option value="immediate">Immediate</option>
                    <option value="idle-only">When Idle</option>
                  </select>
                </Group>

                <Divider color="var(--border-color)" />

                <div>
                  <Group justify="space-between" align="center" mb={6}>
                    <Text size="xs" fw={600} c="var(--text-primary)">Context Refresh</Text>
                    <select
                      value={contextRefreshMode}
                      onChange={(e) => { setContextRefreshMode(e.target.value as DeliveryMode); setDeliverySaved(false); }}
                      style={{ fontSize: 12, padding: "3px 8px", borderRadius: 4, border: "1px solid var(--border-color)", backgroundColor: "var(--bg-primary)", color: "var(--text-primary)" }}
                    >
                      <option value="immediate">Immediate</option>
                      <option value="idle-only">When Idle</option>
                    </select>
                  </Group>

                  {/* Per-event toggles */}
                  <Stack gap={4} pl={12}>
                    {[
                      { key: "taskAssignment", label: "Task assignment" },
                      { key: "personaUpdate", label: "Persona update" },
                      { key: "instructionsUpdate", label: "Instructions update" },
                      { key: "teamChange", label: "Team change" },
                      { key: "knowledgeUpdate", label: "Knowledge update" },
                    ].map(({ key, label }) => (
                      <Group key={key} justify="space-between" align="center">
                        <Text size="xs" c="var(--text-secondary)">{label}</Text>
                        <select
                          value={contextEventOverrides[key] || contextRefreshMode}
                          onChange={(e) => {
                            setContextEventOverrides((prev) => ({ ...prev, [key]: e.target.value as DeliveryMode }));
                            setDeliverySaved(false);
                          }}
                          style={{ fontSize: 11, padding: "2px 6px", borderRadius: 4, border: "1px solid var(--border-color)", backgroundColor: "var(--bg-primary)", color: "var(--text-primary)" }}
                        >
                          <option value="immediate">Immediate</option>
                          <option value="idle-only">When Idle</option>
                        </select>
                      </Group>
                    ))}
                  </Stack>
                </div>
              </Stack>
            </Card>
          )}

          <Group justify="space-between">
            <div>
              {deliverySaved && <Text size="xs" c="green">Saved. Takes effect immediately.</Text>}
            </div>
            <Button
              size="xs"
              variant="light"
              color="blue"
              loading={savingDelivery}
              onClick={async () => {
                setSavingDelivery(true);
                try {
                  const config = deliveryMode === "custom"
                    ? {
                        mode: "custom" as const,
                        overrides: {
                          staleTask: { mode: staleTaskMode },
                          contextRefresh: { mode: contextRefreshMode, perEvent: contextEventOverrides },
                        },
                      }
                    : { mode: deliveryMode };
                  await api.updateSessionConfig(sessionId, { watchdogDelivery: config });
                  setDeliverySaved(true);
                } catch (err: any) {
                  setError(err.message || "Failed to save delivery config");
                } finally {
                  setSavingDelivery(false);
                }
              }}
            >
              Save Delivery Config
            </Button>
          </Group>
        </Stack>

        {/* Session Instructions */}
        <Divider my="md" />
        <Stack gap="xs">
          <Text size="sm" fw={600} c="var(--text-primary)">Session Instructions</Text>
          <Text size="xs" c="dimmed">
            These instructions are appended to every agent's persona. All agents will be notified on save.
          </Text>
          <Textarea
            value={sessionInstructions}
            onChange={(e) => { setSessionInstructions(e.currentTarget.value); setInstructionsSaved(false); }}
            placeholder="e.g., Use TypeScript strict mode. All PRs must have tests. Prefix commits with feat:/fix:."
            autosize
            minRows={3}
            maxRows={8}
            styles={{
              input: { backgroundColor: "var(--bg-primary)", borderColor: "var(--border-color)", color: "var(--text-primary)", borderRadius: 8, fontSize: 13 },
            }}
          />
          <Group justify="space-between">
            <div>
              {instructionsSaved && <Text size="xs" c="green">Saved. All agents notified.</Text>}
              {instructionsLastUpdated && !instructionsSaved && (
                <Text size="xs" c="var(--text-muted)">Last updated: {new Date(instructionsLastUpdated).toLocaleString()}</Text>
              )}
            </div>
            <Button
              size="xs"
              variant="light"
              color="blue"
              loading={savingInstructions}
              onClick={async () => {
                setSavingInstructions(true);
                try {
                  await api.updateSessionInstructions(sessionId, sessionInstructions);
                  setInstructionsSaved(true);
                  setInstructionsLastUpdated(new Date().toISOString());
                } catch {
                  // silently fail
                } finally {
                  setSavingInstructions(false);
                }
              }}
            >
              Save Instructions
            </Button>
          </Group>
        </Stack>

        {/* Per-State Pipeline Instructions */}
        {workflowStates.length > 0 && (
          <>
            <Divider my="md" />
            <Stack gap="xs">
              <Text size="sm" fw={600} c="var(--text-primary)">Pipeline State Instructions</Text>
              <Text size="xs" c="dimmed">
                Customize instructions for each pipeline state. Agents see these when a task enters the state.
              </Text>
              {workflowStates.filter(s => s.category === "active").map((state) => (
                <Card
                  key={state.id}
                  padding="xs"
                  radius="sm"
                  style={{
                    backgroundColor: "var(--bg-secondary)",
                    border: "1px solid var(--border-color)",
                    cursor: "pointer",
                  }}
                >
                  <Group
                    justify="space-between"
                    onClick={() => setExpandedState(expandedState === state.id ? null : state.id)}
                    style={{ cursor: "pointer" }}
                  >
                    <Group gap="xs">
                      <Box
                        style={{
                          width: 10,
                          height: 10,
                          borderRadius: "50%",
                          backgroundColor: state.color,
                          flexShrink: 0,
                        }}
                      />
                      <Text size="sm" fw={500} c="var(--text-primary)">{state.label}</Text>
                      {stateInstructionsDraft[state.id] ? (
                        <Text size="xs" c="dimmed" truncate="end" style={{ maxWidth: 200 }}>
                          {stateInstructionsDraft[state.id].length > 40
                            ? stateInstructionsDraft[state.id].slice(0, 40) + "..."
                            : stateInstructionsDraft[state.id]}
                        </Text>
                      ) : (
                        <Text size="xs" c="yellow" fs="italic">No custom instructions</Text>
                      )}
                    </Group>
                    <Text size="xs" c="dimmed">{expandedState === state.id ? "▼" : "▶"}</Text>
                  </Group>
                  {expandedState === state.id && (
                    <Textarea
                      mt="xs"
                      value={stateInstructionsDraft[state.id] || ""}
                      onChange={(e) => {
                        setStateInstructionsDraft(prev => ({ ...prev, [state.id]: e.currentTarget.value }));
                        setStateInstructionsSaved(false);
                      }}
                      placeholder={`Instructions for agents when a task enters "${state.label}"...`}
                      autosize
                      minRows={3}
                      maxRows={10}
                      styles={{
                        input: {
                          backgroundColor: "var(--bg-primary)",
                          borderColor: "var(--border-color)",
                          color: "var(--text-primary)",
                          borderRadius: 8,
                          fontSize: 13,
                        },
                      }}
                    />
                  )}
                </Card>
              ))}
              <Group justify="space-between">
                <div>
                  {stateInstructionsSaved && <Text size="xs" c="green">Saved. Agents will see updated instructions on next task transition.</Text>}
                </div>
                <Button
                  size="xs"
                  variant="light"
                  color="blue"
                  loading={savingStateInstructions}
                  onClick={async () => {
                    setSavingStateInstructions(true);
                    try {
                      const payload = Object.entries(stateInstructionsDraft).map(([stateId, instructions]) => ({
                        stateId,
                        instructions,
                      }));
                      await api.updateWorkflowInstructions(sessionId, payload);
                      setStateInstructionsSaved(true);
                    } catch (err: any) {
                      setError(err.message || "Failed to save state instructions");
                    } finally {
                      setSavingStateInstructions(false);
                    }
                  }}
                >
                  Save State Instructions
                </Button>
              </Group>
            </Stack>
          </>
        )}

        {/* Board Cleanup */}
        <Divider my="md" />
        <BoardCleanup sessionId={sessionId} />

        {/* Stale Task Nudge Policies */}
        <Divider my="md" />
        <NudgePolicyEditor sessionId={sessionId} />

        {/* Maintenance: Orphaned Resource Cleanup */}
        <Divider my="md" />
        <Text fw={600} size="sm" c="var(--text-primary)" mb="xs">
          Maintenance
        </Text>
        <CleanupPanel sessionId={sessionId} />

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

/** Board cleanup section — archive done tasks */
function BoardCleanup({ sessionId }: { sessionId: string }) {
  const api = useApi();
  const [archiving, setArchiving] = useState(false);
  const [result, setResult] = useState<{ archived: number; totalArchived: number } | null>(null);

  const handleArchive = async (daysOld: number) => {
    setArchiving(true);
    try {
      const data = await api.archiveDoneTasks(sessionId, daysOld);
      setResult(data);
    } catch {
      // silently fail
    } finally {
      setArchiving(false);
    }
  };

  return (
    <Stack gap="xs">
      <Text size="sm" fw={600}>Board Cleanup</Text>
      <Text size="xs" c="dimmed">Archive completed tasks to keep your board focused on active work.</Text>
      <Group gap="sm" wrap="wrap">
        <Button
          size="xs"
          variant="light"
          color="blue"
          loading={archiving}
          onClick={() => handleArchive(0)}
        >
          Archive all done tasks
        </Button>
        <Button
          size="xs"
          variant="light"
          color="gray"
          loading={archiving}
          onClick={() => handleArchive(1)}
        >
          Archive done &gt; 1 day
        </Button>
        <Button
          size="xs"
          variant="light"
          color="gray"
          loading={archiving}
          onClick={() => handleArchive(7)}
        >
          Archive done &gt; 7 days
        </Button>
      </Group>
      {result && (
        <Text size="xs" c="green">
          Archived {result.archived} task{result.archived !== 1 ? "s" : ""}. Total archived: {result.totalArchived}.
        </Text>
      )}
    </Stack>
  );
}
