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
} from "@mantine/core";
import { useMediaQuery } from "@mantine/hooks";

interface SpawnAgentDialogProps {
  sessionId: string;
  onClose: () => void;
  onSpawned: (agent: any) => void;
}

interface ProviderModel {
  id: string;
  name: string;
  tier?: string;
  pricing?: { input?: number; output?: number };
  custom?: boolean;
  discovered?: boolean;
}

interface Provider {
  id: string;
  name: string;
  models: ProviderModel[];
}

function getTierBadgeColor(tier: string): string {
  switch (tier) {
    case "fast":
      return "blue";
    case "balanced":
      return "yellow";
    case "capable":
      return "grape";
    default:
      return "blue";
  }
}

function getCliPlaceholder(provider: string): string {
  switch (provider) {
    case "claude-code":
      return "e.g. --dangerously-skip-permissions --verbose";
    case "aider":
      return "e.g. --no-auto-commits --yes --dark-mode";
    case "kiro":
      return "e.g. --verbose --profile default";
    default:
      return "e.g. --verbose";
  }
}

export function SpawnAgentDialog({
  sessionId,
  onClose,
  onSpawned,
}: SpawnAgentDialogProps) {
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

  useEffect(() => {
    let cancelled = false;
    async function load() {
      try {
        const data = await api.getProviders();
        if (!cancelled) {
          setProviders(data.providers || []);
        }
      } catch {
        // providers may not be available
      } finally {
        if (!cancelled) setLoadingProviders(false);
      }
    }
    load();
    return () => {
      cancelled = true;
    };
  }, []);

  const selectedProvider = providers.find((p) => p.id === providerId);
  const [sessionModels, setSessionModels] = useState<ProviderModel[]>([]);
  const [discoveredModels, setDiscoveredModels] = useState<ProviderModel[]>([]);
  const [loadingSessionModels, setLoadingSessionModels] = useState(false);

  const staticModels: ProviderModel[] = selectedProvider?.models || [];
  const seenIds = new Set<string>();
  const builtInGroup: ProviderModel[] = [];
  const discoveredGroup: ProviderModel[] = [];
  const customGroup: ProviderModel[] = [];

  for (const m of staticModels) {
    if (!seenIds.has(m.id)) {
      seenIds.add(m.id);
      builtInGroup.push(m);
    }
  }
  for (const m of discoveredModels) {
    if (!seenIds.has(m.id)) {
      seenIds.add(m.id);
      discoveredGroup.push(m);
    }
  }
  for (const m of sessionModels) {
    if (!seenIds.has(m.id)) {
      seenIds.add(m.id);
      customGroup.push(m);
    }
  }

  const models: ProviderModel[] = [
    ...builtInGroup,
    ...discoveredGroup,
    ...customGroup,
  ];

  function handleProviderChange(id: string) {
    setProviderId(id);
    setModelId("");
    setSessionModels([]);
    setDiscoveredModels([]);
    if (id) {
      setLoadingSessionModels(true);

      api
        .getSessionModels(sessionId, id)
        .then((data) => {
          const fetched: ProviderModel[] = (data.models || []).map(
            (m: any) => ({
              id: m.id,
              name: m.label || m.name || m.id,
              tier: m.tier,
              pricing: m.pricing,
              custom: m.custom ?? true,
            })
          );
          setSessionModels(fetched);
        })
        .catch(() => {})
        .finally(() => setLoadingSessionModels(false));

      api
        .discoverModels(id)
        .then((data) => {
          const fetched: ProviderModel[] = (data.discoveredModels || []).map(
            (m: any) => ({
              id: m.id,
              name: m.id,
              discovered: true,
            })
          );
          setDiscoveredModels(fetched);
        })
        .catch(() => {});
    }
  }

  async function handleSpawn() {
    if (!name.trim()) {
      setError("Agent name is required.");
      return;
    }
    setError("");
    setSpawning(true);
    try {
      const payload: Record<string, unknown> = {
        name: name.trim(),
        role,
        provider: providerId || undefined,
        model: modelId || undefined,
        persona: persona.trim() || undefined,
        initialTask: initialTask.trim() || undefined,
        extraCliArgs: extraCliArgs.trim()
          ? extraCliArgs.trim().split(/\s+/)
          : undefined,
      };
      const result = await api.spawnAgent(sessionId, payload);
      onSpawned(result);
    } catch (err: any) {
      setError(err.message || "Failed to spawn agent");
    } finally {
      setSpawning(false);
    }
  }

  const providerSelectData = providers.map((p) => ({
    value: p.id,
    label: p.name || p.id,
  }));

  const modelSelectData = models.map((m) => ({
    value: m.id,
    label: m.custom
      ? `[custom] ${m.name || m.id}`
      : m.discovered
        ? `[discovered] ${m.name || m.id}`
        : m.name || m.id,
  }));

  const selectedModel = models.find((m) => m.id === modelId);

  return (
    <Modal
      opened
      onClose={onClose}
      title="Spawn Agent"
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
      <Stack gap="sm">
        {error && (
          <Alert color="red" variant="light">
            {error}
          </Alert>
        )}

        <TextInput
          label="Agent Name *"
          value={name}
          onChange={(e) => setName(e.currentTarget.value)}
          placeholder="e.g. css-expert"
          autoFocus
          styles={{
            input: {
              backgroundColor: "var(--bg-tertiary)",
              borderColor: "var(--border-color)",
              color: "var(--text-primary)",
            },
            label: { color: "var(--text-secondary)", fontSize: 13 },
          }}
        />

        <Radio.Group label="Role" value={role} onChange={(v) => setRole(v as "master" | "worker")}>
          <Group mt={4}>
            <Radio value="master" label="Master" styles={{ label: { color: "var(--text-primary)" } }} />
            <Radio value="worker" label="Worker" styles={{ label: { color: "var(--text-primary)" } }} />
          </Group>
        </Radio.Group>

        <Select
          label="Provider"
          placeholder={loadingProviders ? "Loading providers..." : "Select provider..."}
          data={providerSelectData}
          value={providerId || null}
          onChange={(v) => handleProviderChange(v || "")}
          disabled={loadingProviders}
          styles={{
            input: {
              backgroundColor: "var(--bg-tertiary)",
              borderColor: "var(--border-color)",
              color: "var(--text-primary)",
            },
            label: { color: "var(--text-secondary)", fontSize: 13 },
            dropdown: {
              backgroundColor: "var(--bg-secondary)",
              borderColor: "var(--border-color)",
            },
            option: { color: "var(--text-primary)" },
          }}
        />

        <Select
          label="Model"
          placeholder={
            providerId
              ? loadingSessionModels
                ? "Loading models..."
                : models.length === 0
                  ? "No models available"
                  : "Select model..."
              : "Select a provider first"
          }
          data={modelSelectData}
          value={modelId || null}
          onChange={(v) => setModelId(v || "")}
          disabled={!providerId || (models.length === 0 && !loadingSessionModels)}
          searchable
          styles={{
            input: {
              backgroundColor: "var(--bg-tertiary)",
              borderColor: "var(--border-color)",
              color: "var(--text-primary)",
            },
            label: { color: "var(--text-secondary)", fontSize: 13 },
            dropdown: {
              backgroundColor: "var(--bg-secondary)",
              borderColor: "var(--border-color)",
            },
            option: { color: "var(--text-primary)" },
          }}
        />

        {selectedModel && (
          <Group gap={8}>
            {selectedModel.custom && (
              <Badge color="yellow" variant="light" size="sm">
                custom
              </Badge>
            )}
            {selectedModel.discovered && (
              <Badge color="blue" variant="light" size="sm">
                discovered
              </Badge>
            )}
            {selectedModel.tier && (
              <Badge color={getTierBadgeColor(selectedModel.tier)} variant="light" size="sm">
                {selectedModel.tier}
              </Badge>
            )}
            {selectedModel.pricing && (
              <Text size="xs" c="var(--text-muted)">
                ${selectedModel.pricing.input?.toFixed(2) ?? "?"}/1M in /{" "}
                ${selectedModel.pricing.output?.toFixed(2) ?? "?"}/1M out
              </Text>
            )}
          </Group>
        )}

        <TextInput
          label="CLI Flags (optional)"
          value={extraCliArgs}
          onChange={(e) => setExtraCliArgs(e.currentTarget.value)}
          placeholder={getCliPlaceholder(providerId)}
          description="Space-separated flags passed directly to the CLI."
          styles={{
            input: {
              backgroundColor: "var(--bg-tertiary)",
              borderColor: "var(--border-color)",
              color: "var(--text-primary)",
              fontFamily: "var(--font-mono)",
              fontSize: 13,
            },
            label: { color: "var(--text-secondary)", fontSize: 13 },
            description: { color: "var(--text-muted)" },
          }}
        />

        <Textarea
          label="Persona (optional)"
          value={persona}
          onChange={(e) => setPersona(e.currentTarget.value)}
          placeholder="Describe the agent's persona or system instructions..."
          rows={3}
          autosize
          minRows={2}
          maxRows={5}
          styles={{
            input: {
              backgroundColor: "var(--bg-tertiary)",
              borderColor: "var(--border-color)",
              color: "var(--text-primary)",
            },
            label: { color: "var(--text-secondary)", fontSize: 13 },
          }}
        />

        <Textarea
          label="Initial Task (optional)"
          value={initialTask}
          onChange={(e) => setInitialTask(e.currentTarget.value)}
          placeholder="First message to send after spawning..."
          rows={2}
          autosize
          minRows={2}
          maxRows={4}
          styles={{
            input: {
              backgroundColor: "var(--bg-tertiary)",
              borderColor: "var(--border-color)",
              color: "var(--text-primary)",
            },
            label: { color: "var(--text-secondary)", fontSize: 13 },
          }}
        />

        <Group justify="flex-end" mt="md">
          <Button variant="default" onClick={onClose} disabled={spawning}
            styles={{
              root: {
                backgroundColor: "var(--bg-tertiary)",
                borderColor: "var(--border-color)",
                color: "var(--text-primary)",
                minHeight: 44,
              },
            }}
          >
            Cancel
          </Button>
          <Button onClick={handleSpawn} disabled={spawning} loading={spawning}
            styles={{
              root: {
                backgroundColor: "var(--accent-blue)",
                borderColor: "var(--accent-blue)",
                minHeight: 44,
              },
            }}
          >
            {spawning ? "Spawning..." : "Spawn Agent"}
          </Button>
        </Group>
      </Stack>
    </Modal>
  );
}
