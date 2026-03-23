import { useEffect, useState } from "react";
import { useApi } from "../hooks/useApi";
import {
  Modal,
  Button,
  TextInput,
  Select,
  Textarea,
  Stack,
  Group,
  Radio,
  Text,
  Badge,
  Alert,
  Autocomplete,
  Slider,
  Divider,
  Paper,
} from "@mantine/core";
import { useMediaQuery } from "@mantine/hooks";
import { AutonomyLevel } from "@kora/shared";
import { PersonaLibrary } from "./PersonaLibrary";
import { DirectoryBrowser } from "./DirectoryBrowser";
import type { Persona } from "../hooks/usePersonas";

const AUTONOMY_LABELS: Record<AutonomyLevel, string> = {
  [AutonomyLevel.SuggestOnly]: "Suggest Only",
  [AutonomyLevel.AutoRead]: "Auto-read",
  [AutonomyLevel.AutoApply]: "Auto-apply",
  [AutonomyLevel.FullAuto]: "Full Auto",
};

const AUTONOMY_DESCRIPTIONS: Record<AutonomyLevel, string> = {
  [AutonomyLevel.SuggestOnly]: "Agent proposes actions and waits for approval before doing anything.",
  [AutonomyLevel.AutoRead]: "Agent can explore the codebase freely, but asks before making edits.",
  [AutonomyLevel.AutoApply]: "Agent edits files freely, but asks before git operations.",
  [AutonomyLevel.FullAuto]: "Agent does everything autonomously including git operations.",
};

/* ── Shared styles ──────────────────────────────────────────── */

const modalStyles = {
  header: { backgroundColor: "var(--bg-secondary)", borderBottom: "1px solid var(--border-color)", padding: "16px 24px" },
  body: { backgroundColor: "var(--bg-secondary)", padding: "24px", overflowY: "auto" as const, maxHeight: "calc(85vh - 80px)" },
  content: { backgroundColor: "var(--bg-secondary)", maxHeight: "85vh", display: "flex" as const, flexDirection: "column" as const, borderRadius: 12 },
  inner: { padding: "20px 0" },
  title: { color: "var(--text-primary)", fontWeight: 700 as const, fontSize: 17 },
  close: { color: "var(--text-secondary)" },
};

const fieldStyles = {
  input: { backgroundColor: "var(--bg-primary)", borderColor: "var(--border-color)", color: "var(--text-primary)", borderRadius: 8, height: 42, fontSize: 14 },
  label: { color: "var(--text-primary)", fontSize: 13, fontWeight: 500 as const, marginBottom: 6 },
  description: { color: "var(--text-muted)", fontSize: 12 },
};

const monoFieldStyles = {
  ...fieldStyles,
  input: { ...fieldStyles.input, fontFamily: "var(--font-mono)", fontSize: 13 },
};

const textareaStyles = {
  input: { backgroundColor: "var(--bg-primary)", borderColor: "var(--border-color)", color: "var(--text-primary)", borderRadius: 8, fontSize: 14 },
  label: { color: "var(--text-primary)", fontSize: 13, fontWeight: 500 as const, marginBottom: 6 },
};

const cancelBtnStyles = { root: { backgroundColor: "var(--bg-tertiary)", borderColor: "var(--border-color)", color: "var(--text-primary)", minHeight: 42, paddingInline: 24, borderRadius: 8, fontWeight: 500 as const } };
const primaryBtnStyles = { root: { backgroundColor: "var(--accent-blue)", borderColor: "var(--accent-blue)", minHeight: 42, paddingInline: 28, borderRadius: 8, fontWeight: 600 as const } };

/* ── Helpers ─────────────────────────────────────────────────── */

interface ProviderModel { id: string; name: string; tier?: string; pricing?: { input?: number; output?: number }; custom?: boolean; discovered?: boolean; }
interface Provider { id: string; name: string; models: ProviderModel[]; }

function getTierBadgeColor(tier: string): string {
  switch (tier) { case "fast": return "blue"; case "balanced": return "yellow"; case "capable": return "grape"; default: return "blue"; }
}

function getCliPlaceholder(provider: string): string {
  switch (provider) { case "claude-code": return "e.g. --dangerously-skip-permissions --verbose"; case "aider": return "e.g. --no-auto-commits --yes --dark-mode"; case "kiro": return "e.g. --verbose --profile default"; default: return "e.g. --verbose"; }
}

/* ── Component ───────────────────────────────────────────────── */

interface SpawnAgentDialogProps {
  sessionId: string;
  onClose: () => void;
  onSpawned: (agent: any) => void;
}

export function SpawnAgentDialog({ sessionId, onClose, onSpawned }: SpawnAgentDialogProps) {
  const api = useApi();
  const isMobile = useMediaQuery("(max-width: 48em)");

  const [name, setName] = useState("");
  const [role, setRole] = useState<"master" | "worker">("worker");
  const [providerId, setProviderId] = useState("");
  const [modelId, setModelId] = useState("");
  const [persona, setPersona] = useState("");
  const [initialTask, setInitialTask] = useState("");
  const [providers, setProviders] = useState<Provider[]>([]);
  const [loadingProviders, setLoadingProviders] = useState(true);
  const [extraCliArgs, setExtraCliArgs] = useState("");
  const [spawning, setSpawning] = useState(false);
  const [error, setError] = useState("");
  const [recentFlags, setRecentFlags] = useState<string[]>([]);
  const [autonomyLevel, setAutonomyLevel] = useState<AutonomyLevel>(AutonomyLevel.AutoRead);
  const [workingDirectory, setWorkingDirectory] = useState("");
  const [directoryBrowserOpen, setDirectoryBrowserOpen] = useState(false);
  const [personaLibraryOpen, setPersonaLibraryOpen] = useState(false);

  const handlePersonaSelect = (selectedPersona: Persona) => { setPersona(selectedPersona.fullText); };

  useEffect(() => {
    let cancelled = false;
    async function load() {
      try { const data = await api.getProviders(); if (!cancelled) setProviders(data.providers || []); } catch {} finally { if (!cancelled) setLoadingProviders(false); }
    }
    async function loadRecentFlags() {
      try { const data = await api.getRecentFlags(10); if (!cancelled) setRecentFlags(data.flags || []); } catch {}
    }
    async function loadRecentConfigs() {
      try {
        const data = await api.getRecentAgentConfigs(5);
        if (!cancelled && data.configs?.length > 0) {
          const lastUsed = data.configs[0];
          if (lastUsed.provider && !providerId) { handleProviderChange(lastUsed.provider); if (lastUsed.model && lastUsed.model !== "default") setModelId(lastUsed.model); }
        }
      } catch {}
    }
    load(); loadRecentFlags(); loadRecentConfigs();
    return () => { cancelled = true; };
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  const selectedProvider = providers.find((p) => p.id === providerId);
  const [sessionModels, setSessionModels] = useState<ProviderModel[]>([]);
  const [discoveredModels, setDiscoveredModels] = useState<ProviderModel[]>([]);
  const [loadingSessionModels, setLoadingSessionModels] = useState(false);

  const staticModels: ProviderModel[] = selectedProvider?.models || [];
  const seenIds = new Set<string>();
  const builtInGroup: ProviderModel[] = [];
  const discoveredGroup: ProviderModel[] = [];
  const customGroup: ProviderModel[] = [];
  for (const m of staticModels) { if (!seenIds.has(m.id)) { seenIds.add(m.id); builtInGroup.push(m); } }
  for (const m of discoveredModels) { if (!seenIds.has(m.id)) { seenIds.add(m.id); discoveredGroup.push(m); } }
  for (const m of sessionModels) { if (!seenIds.has(m.id)) { seenIds.add(m.id); customGroup.push(m); } }
  const models: ProviderModel[] = [...builtInGroup, ...discoveredGroup, ...customGroup];

  function handleProviderChange(id: string) {
    setProviderId(id); setModelId(""); setSessionModels([]); setDiscoveredModels([]);
    if (id) {
      setLoadingSessionModels(true);
      api.getSessionModels(sessionId, id).then((data) => {
        setSessionModels((data.models || []).map((m: any) => ({ id: m.id, name: m.label || m.name || m.id, tier: m.tier, pricing: m.pricing, custom: m.custom ?? true })));
      }).catch(() => {}).finally(() => setLoadingSessionModels(false));
      api.discoverModels(id).then((data) => {
        setDiscoveredModels((data.discoveredModels || []).map((m: any) => ({ id: m.id, name: m.id, discovered: true })));
      }).catch(() => {});
    }
  }

  async function handleSpawn() {
    if (!name.trim()) { setError("Agent name is required."); return; }
    setError(""); setSpawning(true);
    try {
      const payload: Record<string, unknown> = {
        name: name.trim(), role,
        provider: providerId || undefined, model: modelId || undefined,
        persona: persona.trim() || undefined, initialTask: initialTask.trim() || undefined,
        extraCliArgs: extraCliArgs.trim() ? extraCliArgs.trim().split(/\s+/) : undefined,
        autonomyLevel,
        workingDirectory: workingDirectory.trim() || undefined,
      };
      const result = await api.spawnAgent(sessionId, payload);
      onSpawned(result);
    } catch (err: any) { setError(err.message || "Failed to spawn agent"); } finally { setSpawning(false); }
  }

  const providerSelectData = providers.map((p) => ({ value: p.id, label: p.name || p.id }));
  const modelSelectData = models.map((m) => ({ value: m.id, label: m.custom ? `[custom] ${m.name || m.id}` : m.discovered ? `[discovered] ${m.name || m.id}` : m.name || m.id }));
  const selectedModel = models.find((m) => m.id === modelId);

  return (
    <Modal opened onClose={onClose} title="Spawn Agent" size="lg" fullScreen={isMobile} centered styles={modalStyles}>
      <Stack gap="lg">
        {error && <Alert color="red" variant="light" radius="md">{error}</Alert>}

        {/* ── Identity ── */}
        <TextInput
          label="Agent Name"
          value={name}
          onChange={(e) => setName(e.currentTarget.value)}
          placeholder="e.g. css-expert"
          required
          autoFocus
          styles={fieldStyles}
        />

        <Radio.Group label={<Text size="sm" fw={500} c="var(--text-primary)">Role</Text>} value={role} onChange={(v) => setRole(v as "master" | "worker")}>
          <Group mt={6} gap={16}>
            <Radio value="master" label="Master" styles={{ label: { color: "var(--text-primary)", fontSize: 14 }, radio: { borderColor: "var(--border-color)", backgroundColor: "var(--bg-primary)" } }} />
            <Radio value="worker" label="Worker" styles={{ label: { color: "var(--text-primary)", fontSize: 14 }, radio: { borderColor: "var(--border-color)", backgroundColor: "var(--bg-primary)" } }} />
          </Group>
        </Radio.Group>

        <Divider color="var(--border-color)" />

        {/* ── Provider & Model ── */}
        <Text size="sm" fw={600} c="var(--text-primary)">Provider & Model</Text>

        <Group grow gap="md">
          <Select
            label="Provider"
            placeholder={loadingProviders ? "Loading..." : "Select provider..."}
            data={providerSelectData}
            value={providerId || null}
            onChange={(v) => handleProviderChange(v || "")}
            disabled={loadingProviders}
            styles={fieldStyles}
          />
          <Select
            label="Model"
            placeholder={providerId ? (loadingSessionModels ? "Loading..." : models.length === 0 ? "No models" : "Select model...") : "Select provider first"}
            data={modelSelectData}
            value={modelId || null}
            onChange={(v) => setModelId(v || "")}
            disabled={!providerId || (models.length === 0 && !loadingSessionModels)}
            searchable
            styles={fieldStyles}
          />
        </Group>

        {selectedModel && (
          <Group gap={8}>
            {selectedModel.custom && <Badge color="yellow" variant="light" size="sm">custom</Badge>}
            {selectedModel.discovered && <Badge color="blue" variant="light" size="sm">discovered</Badge>}
            {selectedModel.tier && <Badge color={getTierBadgeColor(selectedModel.tier)} variant="light" size="sm">{selectedModel.tier}</Badge>}
            {selectedModel.pricing && <Text size="xs" c="var(--text-muted)">${selectedModel.pricing.input?.toFixed(2) ?? "?"}/1M in · ${selectedModel.pricing.output?.toFixed(2) ?? "?"}/1M out</Text>}
          </Group>
        )}

        <Divider color="var(--border-color)" />

        {/* ── Configuration ── */}
        <Text size="sm" fw={600} c="var(--text-primary)">Configuration</Text>

        <Autocomplete
          label="CLI Flags"
          value={extraCliArgs}
          onChange={setExtraCliArgs}
          data={recentFlags}
          placeholder={getCliPlaceholder(providerId)}
          description="Space-separated flags passed directly to the CLI."
          styles={monoFieldStyles}
        />

        <div>
          <Text size="sm" fw={500} c="var(--text-primary)" mb={6}>Working Directory</Text>
          <Group gap={8}>
            <TextInput
              value={workingDirectory}
              onChange={(e) => setWorkingDirectory(e.currentTarget.value)}
              placeholder="Default: session project path"
              description="Optional. Override the agent's working directory."
              styles={{ ...monoFieldStyles, root: { flex: 1 } }}
            />
            <Button
              variant="light"
              color="blue"
              size="sm"
              onClick={() => setDirectoryBrowserOpen(true)}
              styles={{ root: { flexShrink: 0, alignSelf: "flex-start", marginTop: 1 } }}
            >
              Browse
            </Button>
          </Group>
        </div>

        <Stack gap={6}>
          <Group justify="space-between" align="center">
            <Text size="sm" fw={500} c="var(--text-primary)">Persona</Text>
            <Button variant="subtle" size="compact-xs" onClick={() => setPersonaLibraryOpen(true)} styles={{ root: { color: "var(--accent-blue)", fontSize: 12 } }}>
              Browse Personas
            </Button>
          </Group>
          <Textarea
            value={persona}
            onChange={(e) => setPersona(e.currentTarget.value)}
            placeholder="Describe the agent's persona or system instructions..."
            autosize minRows={2} maxRows={5}
            styles={textareaStyles}
          />
        </Stack>

        <Textarea
          label="Initial Task"
          value={initialTask}
          onChange={(e) => setInitialTask(e.currentTarget.value)}
          placeholder="First message to send after spawning..."
          autosize minRows={2} maxRows={4}
          styles={textareaStyles}
        />

        <Divider color="var(--border-color)" />

        {/* ── Autonomy Level ── */}
        <Paper p="md" radius="md" style={{ backgroundColor: "var(--bg-primary)", border: "1px solid var(--border-color)" }}>
          <Group justify="space-between" mb={12}>
            <Text size="sm" fw={600} c="var(--text-primary)">Autonomy Level</Text>
            <Badge variant="light" color="blue" size="sm">{AUTONOMY_LABELS[autonomyLevel]}</Badge>
          </Group>
          <Slider
            value={autonomyLevel}
            onChange={setAutonomyLevel}
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
              track: { backgroundColor: "var(--bg-tertiary)" },
              bar: { backgroundColor: "var(--accent-blue)" },
              thumb: { borderColor: "var(--accent-blue)", backgroundColor: "var(--bg-secondary)" },
              mark: { borderColor: "var(--border-color)" },
              markLabel: { color: "var(--text-muted)", fontSize: 10, marginTop: 6 },
            }}
          />
          <Text size="xs" c="var(--text-muted)" mt={24} lh={1.5}>
            {AUTONOMY_DESCRIPTIONS[autonomyLevel]}
          </Text>
        </Paper>

        <Divider color="var(--border-color)" />

        {/* ── Actions ── */}
        <Group justify="flex-end" gap={12}>
          <Button variant="default" onClick={onClose} disabled={spawning} styles={cancelBtnStyles}>Cancel</Button>
          <Button onClick={handleSpawn} disabled={spawning} loading={spawning} styles={primaryBtnStyles}>
            Spawn Agent
          </Button>
        </Group>
      </Stack>

      <PersonaLibrary opened={personaLibraryOpen} onClose={() => setPersonaLibraryOpen(false)} onSelect={handlePersonaSelect} />
      <DirectoryBrowser
        opened={directoryBrowserOpen}
        onClose={() => setDirectoryBrowserOpen(false)}
        onSelect={(path) => setWorkingDirectory(path)}
        initialPath={workingDirectory}
      />
    </Modal>
  );
}
