import { useEffect, useState } from "react";
import { useApi } from "../hooks/useApi";

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

function getTierBadgeClass(tier: string): string {
  switch (tier) {
    case "fast":
      return "badge-blue";
    case "balanced":
      return "badge-yellow";
    case "capable":
      return "badge-purple";
    default:
      return "badge-blue";
  }
}

function getCliPlaceholder(provider: string): string {
  switch (provider) {
    case "claude-code": return "e.g. --dangerously-skip-permissions --verbose";
    case "aider": return "e.g. --no-auto-commits --yes --dark-mode";
    case "kiro": return "e.g. --verbose --profile default";
    default: return "e.g. --verbose";
  }
}

export function SpawnAgentDialog({
  sessionId,
  onClose,
  onSpawned,
}: SpawnAgentDialogProps) {
  const api = useApi();

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
  // Merge static (built-in), discovered, and session (custom) models, avoiding duplicates
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

  const models: ProviderModel[] = [...builtInGroup, ...discoveredGroup, ...customGroup];

  function handleProviderChange(id: string) {
    setProviderId(id);
    setModelId("");
    setSessionModels([]);
    setDiscoveredModels([]);
    if (id) {
      setLoadingSessionModels(true);

      // Fetch session (custom) models
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
        .catch(() => {
          // session models endpoint may not be available
        })
        .finally(() => setLoadingSessionModels(false));

      // Discover models from CLI tools / env / config files
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
        .catch(() => {
          // discovery endpoint may not be available
        });
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
        extraCliArgs: extraCliArgs.trim() ? extraCliArgs.trim().split(/\s+/) : undefined,
      };
      const result = await api.spawnAgent(sessionId, payload);
      onSpawned(result);
    } catch (err: any) {
      setError(err.message || "Failed to spawn agent");
    } finally {
      setSpawning(false);
    }
  }

  return (
    <div className="dialog-overlay" onClick={onClose}>
      <div
        className="dialog"
        style={{ maxWidth: 520, minWidth: 440 }}
        onClick={(e) => e.stopPropagation()}
      >
        <h2>Spawn Agent</h2>

        {error && (
          <div
            style={{
              padding: "8px 12px",
              marginBottom: 12,
              borderRadius: 6,
              backgroundColor: "rgba(248, 81, 73, 0.1)",
              border: "1px solid var(--accent-red)",
              color: "var(--accent-red)",
              fontSize: 13,
            }}
          >
            {error}
          </div>
        )}

        {/* Name */}
        <div className="form-group">
          <label>Agent Name *</label>
          <input
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder="e.g. css-expert"
            autoFocus
          />
        </div>

        {/* Role */}
        <div className="form-group">
          <label>Role</label>
          <div style={{ display: "flex", gap: 16, marginTop: 4 }}>
            <label
              style={{
                display: "flex",
                alignItems: "center",
                gap: 6,
                fontSize: 14,
                color: "var(--text-primary)",
                cursor: "pointer",
              }}
            >
              <input
                type="radio"
                name="role"
                value="master"
                checked={role === "master"}
                onChange={() => setRole("master")}
              />
              Master
            </label>
            <label
              style={{
                display: "flex",
                alignItems: "center",
                gap: 6,
                fontSize: 14,
                color: "var(--text-primary)",
                cursor: "pointer",
              }}
            >
              <input
                type="radio"
                name="role"
                value="worker"
                checked={role === "worker"}
                onChange={() => setRole("worker")}
              />
              Worker
            </label>
          </div>
        </div>

        {/* Provider */}
        <div className="form-group">
          <label>Provider</label>
          {loadingProviders ? (
            <div
              style={{
                fontSize: 13,
                color: "var(--text-muted)",
                padding: "6px 0",
              }}
            >
              Loading providers...
            </div>
          ) : (
            <select
              value={providerId}
              onChange={(e) => handleProviderChange(e.target.value)}
            >
              <option value="">Select provider...</option>
              {providers.map((p) => (
                <option key={p.id} value={p.id}>
                  {p.name || p.id}
                </option>
              ))}
            </select>
          )}
        </div>

        {/* Model */}
        <div className="form-group">
          <label>Model</label>
          <select
            value={modelId}
            onChange={(e) => setModelId(e.target.value)}
            disabled={!providerId || (models.length === 0 && !loadingSessionModels)}
          >
            <option value="">
              {providerId
                ? loadingSessionModels
                  ? "Loading models..."
                  : models.length === 0
                    ? "No models available"
                    : "Select model..."
                : "Select a provider first"}
            </option>
            {models.map((m) => (
              <option key={m.id} value={m.id}>
                {m.custom ? `[custom] ${m.name || m.id}` : m.discovered ? `[discovered] ${m.name || m.id}` : (m.name || m.id)}
              </option>
            ))}
          </select>

          {/* Model details */}
          {modelId && (
            <div style={{ marginTop: 8 }}>
              {(() => {
                const model = models.find((m) => m.id === modelId);
                if (!model) return null;
                return (
                  <div
                    style={{
                      display: "flex",
                      alignItems: "center",
                      gap: 8,
                      flexWrap: "wrap",
                    }}
                  >
                    {model.custom && (
                      <span
                        className="badge"
                        style={{
                          background: "rgba(210, 153, 34, 0.15)",
                          color: "var(--accent-orange, #d29922)",
                          fontSize: 11,
                          padding: "2px 6px",
                        }}
                      >
                        custom
                      </span>
                    )}
                    {model.discovered && (
                      <span
                        className="badge"
                        style={{
                          background: "rgba(56, 139, 253, 0.15)",
                          color: "var(--accent-blue, #388bfd)",
                          fontSize: 11,
                          padding: "2px 6px",
                        }}
                      >
                        discovered
                      </span>
                    )}
                    {model.tier && (
                      <span
                        className={`badge ${getTierBadgeClass(model.tier)}`}
                      >
                        {model.tier}
                      </span>
                    )}
                    {model.pricing && (
                      <span
                        style={{
                          fontSize: 12,
                          color: "var(--text-muted)",
                        }}
                      >
                        ${model.pricing.input?.toFixed(2) ?? "?"}/1M in
                        {" / "}${model.pricing.output?.toFixed(2) ?? "?"}/1M out
                      </span>
                    )}
                  </div>
                );
              })()}
            </div>
          )}
        </div>

        {/* CLI Flags */}
        <div className="form-group">
          <label>CLI Flags (optional)</label>
          <input
            value={extraCliArgs}
            onChange={(e) => setExtraCliArgs(e.target.value)}
            placeholder={getCliPlaceholder(providerId)}
            style={{ fontFamily: "var(--font-mono)", fontSize: 13 }}
          />
          <div style={{ fontSize: 11, color: "var(--text-muted)", marginTop: 4 }}>
            Space-separated flags passed directly to the CLI. Example: --dangerously-skip-permissions --verbose
          </div>
        </div>

        {/* Persona */}
        <div className="form-group">
          <label>Persona (optional)</label>
          <textarea
            value={persona}
            onChange={(e) => setPersona(e.target.value)}
            placeholder="Describe the agent's persona or system instructions..."
            rows={3}
            style={{
              width: "100%",
              fontFamily: "inherit",
              fontSize: 14,
              padding: "6px 12px",
              border: "1px solid var(--border-color)",
              borderRadius: 6,
              backgroundColor: "var(--bg-tertiary)",
              color: "var(--text-primary)",
              outline: "none",
              resize: "vertical",
            }}
          />
        </div>

        {/* Initial Task */}
        <div className="form-group">
          <label>Initial Task (optional)</label>
          <textarea
            value={initialTask}
            onChange={(e) => setInitialTask(e.target.value)}
            placeholder="First message to send after spawning..."
            rows={2}
            style={{
              width: "100%",
              fontFamily: "inherit",
              fontSize: 14,
              padding: "6px 12px",
              border: "1px solid var(--border-color)",
              borderRadius: 6,
              backgroundColor: "var(--bg-tertiary)",
              color: "var(--text-primary)",
              outline: "none",
              resize: "vertical",
            }}
          />
        </div>

        <div className="form-actions">
          <button onClick={onClose} disabled={spawning}>
            Cancel
          </button>
          <button className="primary" onClick={handleSpawn} disabled={spawning}>
            {spawning ? "Spawning..." : "Spawn Agent"}
          </button>
        </div>
      </div>
    </div>
  );
}
