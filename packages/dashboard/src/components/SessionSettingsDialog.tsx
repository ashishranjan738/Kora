import { useEffect, useState } from "react";
import { useApi } from "../hooks/useApi";

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

  const [providers, setProviders] = useState<Provider[]>([]);
  const [loadingProviders, setLoadingProviders] = useState(true);
  const [customModels, setCustomModels] = useState<CustomModel[]>([]);
  const [loadingModels, setLoadingModels] = useState(false);

  const [defaultProvider, setDefaultProvider] = useState("");
  const [defaultModel, setDefaultModel] = useState("");

  // Add custom model form state
  const [newProvider, setNewProvider] = useState("");
  const [newModelId, setNewModelId] = useState("");
  const [newLabel, setNewLabel] = useState("");
  const [adding, setAdding] = useState(false);
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

  // Load custom models for all providers
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

  return (
    <div className="dialog-overlay" onClick={onClose}>
      <div
        className="dialog"
        style={{ maxWidth: 640, minWidth: 480 }}
        onClick={(e) => e.stopPropagation()}
      >
        <h2>Session Settings</h2>

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

        {/* Default Provider */}
        <div className="form-group">
          <label>Default Provider</label>
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
              value={defaultProvider}
              onChange={(e) => setDefaultProvider(e.target.value)}
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

        {/* Default Model */}
        <div className="form-group">
          <label>Default Model</label>
          <input
            value={defaultModel}
            onChange={(e) => setDefaultModel(e.target.value)}
            placeholder="e.g. gpt-4o, claude-sonnet-4-20250514"
          />
          <div
            style={{
              fontSize: 12,
              color: "var(--text-muted)",
              marginTop: 4,
            }}
          >
            Default model used when spawning new agents.
          </div>
        </div>

        {/* Custom Models Section */}
        <div style={{ marginTop: 20 }}>
          <h3
            style={{
              fontSize: 15,
              fontWeight: 600,
              color: "var(--text-primary)",
              marginBottom: 12,
            }}
          >
            Custom Models
          </h3>

          {/* Existing custom models table */}
          {loadingModels ? (
            <div
              style={{
                fontSize: 13,
                color: "var(--text-muted)",
                padding: "12px 0",
              }}
            >
              Loading custom models...
            </div>
          ) : customModels.length === 0 ? (
            <div
              style={{
                fontSize: 13,
                color: "var(--text-muted)",
                padding: "12px 0",
                borderBottom: "1px solid var(--border-color)",
                marginBottom: 12,
              }}
            >
              No custom models configured.
            </div>
          ) : (
            <div
              style={{
                border: "1px solid var(--border-color)",
                borderRadius: 6,
                overflow: "hidden",
                marginBottom: 16,
              }}
            >
              <table
                style={{
                  width: "100%",
                  borderCollapse: "collapse",
                  fontSize: 13,
                }}
              >
                <thead>
                  <tr
                    style={{
                      backgroundColor: "var(--bg-tertiary)",
                      color: "var(--text-secondary)",
                      textAlign: "left",
                    }}
                  >
                    <th style={{ padding: "8px 12px", fontWeight: 500 }}>
                      Provider
                    </th>
                    <th style={{ padding: "8px 12px", fontWeight: 500 }}>
                      Model ID
                    </th>
                    <th style={{ padding: "8px 12px", fontWeight: 500 }}>
                      Label
                    </th>
                    <th
                      style={{
                        padding: "8px 12px",
                        fontWeight: 500,
                        width: 60,
                      }}
                    />
                  </tr>
                </thead>
                <tbody>
                  {customModels.map((m, i) => (
                    <tr
                      key={`${m.provider}-${m.id}-${i}`}
                      style={{
                        borderTop: "1px solid var(--border-color)",
                      }}
                    >
                      <td
                        style={{
                          padding: "8px 12px",
                          color: "var(--text-primary)",
                        }}
                      >
                        {m.provider}
                      </td>
                      <td
                        style={{
                          padding: "8px 12px",
                          fontFamily: "var(--font-mono)",
                          color: "var(--text-primary)",
                          fontSize: 12,
                        }}
                      >
                        {m.id}
                      </td>
                      <td
                        style={{
                          padding: "8px 12px",
                          color: "var(--text-secondary)",
                        }}
                      >
                        {m.label}
                      </td>
                      <td style={{ padding: "8px 12px" }}>
                        <button
                          className="danger"
                          style={{
                            padding: "2px 8px",
                            fontSize: 12,
                          }}
                          onClick={() =>
                            handleDeleteModel(m.id, m.provider)
                          }
                        >
                          Delete
                        </button>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}

          {/* Add Custom Model form */}
          <div
            style={{
              border: "1px solid var(--border-color)",
              borderRadius: 8,
              padding: 16,
              backgroundColor: "var(--bg-secondary)",
            }}
          >
            <h4
              style={{
                fontSize: 13,
                fontWeight: 600,
                color: "var(--text-primary)",
                margin: "0 0 12px 0",
              }}
            >
              Add Custom Model
            </h4>

            <div
              style={{
                display: "grid",
                gridTemplateColumns: "1fr 1fr",
                gap: 12,
              }}
            >
              {/* Provider dropdown */}
              <div className="form-group" style={{ margin: 0 }}>
                <label style={{ fontSize: 12 }}>Provider</label>
                {loadingProviders ? (
                  <div
                    style={{
                      fontSize: 12,
                      color: "var(--text-muted)",
                      padding: "6px 0",
                    }}
                  >
                    Loading...
                  </div>
                ) : (
                  <select
                    value={newProvider}
                    onChange={(e) => setNewProvider(e.target.value)}
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

              {/* Model ID */}
              <div className="form-group" style={{ margin: 0 }}>
                <label style={{ fontSize: 12 }}>Model ID</label>
                <input
                  value={newModelId}
                  onChange={(e) => setNewModelId(e.target.value)}
                  placeholder="ft:gpt-4o:my-org:custom:abc123"
                  style={{ fontSize: 13 }}
                />
              </div>
            </div>

            <div
              style={{
                display: "grid",
                gridTemplateColumns: "1fr auto",
                gap: 12,
                marginTop: 12,
                alignItems: "end",
              }}
            >
              {/* Label */}
              <div className="form-group" style={{ margin: 0 }}>
                <label style={{ fontSize: 12 }}>Label</label>
                <input
                  value={newLabel}
                  onChange={(e) => setNewLabel(e.target.value)}
                  placeholder="My Fine-tuned GPT-4o"
                  style={{ fontSize: 13 }}
                />
              </div>

              <button
                className="primary"
                onClick={handleAddModel}
                disabled={adding || !newProvider || !newModelId.trim()}
                style={{ height: 36, padding: "0 20px", fontSize: 13 }}
              >
                {adding ? "Adding..." : "Add"}
              </button>
            </div>
          </div>
        </div>

        <div className="form-actions" style={{ marginTop: 20 }}>
          <button onClick={onClose}>Close</button>
        </div>
      </div>
    </div>
  );
}
