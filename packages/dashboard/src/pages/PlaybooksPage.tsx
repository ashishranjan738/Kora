import { useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { useApi } from "../hooks/useApi";
import { usePersonas, type Persona } from "../hooks/usePersonas";
import { PlaybookGrid } from "../components/playbook/PlaybookGrid";
import { PlaybookUploadModal } from "../components/playbook/PlaybookUploadModal";
import { PersonaLibrary } from "../components/PersonaLibrary";
import {
  Modal, Button, Group, Stack, Text, TextInput, Badge, Paper,
  ActionIcon, Tooltip, Alert, Code,
} from "@mantine/core";

interface PlaybookAgent {
  name: string;
  role: string;
  provider?: string;
  model?: string;
  persona?: string;
}

const inputStyle = {
  fontSize: 12, padding: "6px 10px", backgroundColor: "var(--bg-tertiary)",
  border: "1px solid var(--border-color)", borderRadius: 6, color: "var(--text-primary)",
  width: "100%", height: 32, boxSizing: "border-box" as const,
};

export function PlaybooksPage() {
  const api = useApi();
  const { personas } = usePersonas();
  const [playbooks, setPlaybooks] = useState<any[]>([]);
  const [loading, setLoading] = useState(true);
  const [selected, setSelected] = useState<any>(null);
  const [showUpload, setShowUpload] = useState(false);
  const [showCreate, setShowCreate] = useState(false);
  const [showPersonaLibrary, setShowPersonaLibrary] = useState(false);
  const [personaTargetIdx, setPersonaTargetIdx] = useState<number | null>(null);

  // Create form state
  const [newName, setNewName] = useState("");
  const [newDesc, setNewDesc] = useState("");
  const [newAgents, setNewAgents] = useState<PlaybookAgent[]>([
    { name: "", role: "master", persona: "" },
  ]);
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState("");

  async function loadPlaybooks() {
    setLoading(true);
    try {
      const data = await api.getPlaybooks();
      const details = await Promise.all(
        (data.playbooks || []).map(async (name: string) => {
          try {
            const detail = await api.getPlaybook(name);
            return { ...detail, name };
          } catch {
            return { name, agents: [] };
          }
        })
      );
      setPlaybooks(details);
    } catch { /* ignore */ }
    finally { setLoading(false); }
  }

  useEffect(() => { loadPlaybooks(); }, []); // eslint-disable-line react-hooks/exhaustive-deps

  function addAgent() {
    setNewAgents(prev => [...prev, { name: "", role: "worker", persona: "" }]);
  }

  function removeAgent(idx: number) {
    setNewAgents(prev => prev.filter((_, i) => i !== idx));
  }

  function updateAgent(idx: number, field: keyof PlaybookAgent, value: string) {
    setNewAgents(prev => prev.map((a, i) => i === idx ? { ...a, [field]: value } : a));
  }

  async function handleSavePlaybook() {
    if (!newName.trim()) { setSaveError("Playbook name is required"); return; }
    if (newAgents.filter(a => a.name.trim()).length === 0) { setSaveError("At least one agent with a name is required"); return; }

    setSaving(true);
    setSaveError("");
    try {
      // Build YAML and upload — quote all string values to prevent YAML injection
      const yamlQuote = (s: string) => `"${s.replace(/\\/g, "\\\\").replace(/"/g, '\\"').replace(/\n/g, "\\n")}"`;
      const agents = newAgents.filter(a => a.name.trim());
      const yamlLines = [
        `name: ${yamlQuote(newName.trim())}`,
        `description: ${yamlQuote(newDesc.trim() || newName.trim())}`,
        `defaults:`,
        `  provider: claude-code`,
        `  model: default`,
        `agents:`,
      ];
      for (const a of agents) {
        yamlLines.push(`  - name: ${yamlQuote(a.name.trim())}`);
        yamlLines.push(`    role: ${a.role}`);
        if (a.provider) yamlLines.push(`    provider: ${a.provider}`);
        if (a.model) yamlLines.push(`    model: ${yamlQuote(a.model)}`);
        if (a.persona) yamlLines.push(`    persona: ${yamlQuote(a.persona)}`);
      }

      await api.uploadPlaybook(newName.trim(), yamlLines.join("\n"));
      setShowCreate(false);
      setNewName(""); setNewDesc("");
      setNewAgents([{ name: "", role: "master", persona: "" }]);
      loadPlaybooks();
    } catch (err: any) {
      setSaveError(err?.message || "Failed to save playbook");
    } finally {
      setSaving(false);
    }
  }

  function handlePersonaSelect(persona: Persona) {
    if (personaTargetIdx !== null) {
      updateAgent(personaTargetIdx, "persona", persona.fullText);
      setPersonaTargetIdx(null);
    }
    setShowPersonaLibrary(false);
  }

  return (
    <div className="page">
      <nav className="breadcrumb">
        <Link to="/">All Sessions</Link>
        <span className="separator">/</span>
        <span style={{ color: "var(--text-primary)" }}>Playbooks</span>
      </nav>

      <Group justify="space-between" align="center" mb={16}>
        <h1 style={{ fontSize: 24, fontWeight: 700, margin: 0 }}>Playbooks</h1>
        <Group gap={8}>
          <Button size="compact-sm" onClick={() => setShowCreate(true)}
            styles={{ root: { backgroundColor: "var(--accent-blue)" } }}>
            + Create Playbook
          </Button>
          <Button size="compact-sm" variant="default" onClick={() => setShowUpload(true)}
            styles={{ root: { backgroundColor: "var(--bg-tertiary)", borderColor: "var(--border-color)", color: "var(--text-primary)" } }}>
            Upload YAML
          </Button>
        </Group>
      </Group>

      {!loading && playbooks.length === 0 ? (
        <Stack align="center" justify="center" style={{ minHeight: 300, padding: 40 }}>
          <Text size="lg" c="var(--text-secondary)" fw={500}>No playbooks available</Text>
          <Text size="sm" c="var(--text-muted)" ta="center" maw={400}>
            Create a custom playbook or upload a YAML file to get started.
          </Text>
        </Stack>
      ) : (
        <PlaybookGrid
          playbooks={playbooks}
          selectedPlaybook={selected}
          onSelectPlaybook={setSelected}
          loading={loading}
        />
      )}

      {/* Upload Modal */}
      <PlaybookUploadModal
        opened={showUpload}
        onClose={() => setShowUpload(false)}
        onSuccess={() => { setShowUpload(false); loadPlaybooks(); }}
      />

      {/* Create Playbook Modal */}
      <Modal
        opened={showCreate}
        onClose={() => { setShowCreate(false); setSaveError(""); }}
        title="Create Custom Playbook"
        size="lg"
        centered
        styles={{
          header: { backgroundColor: "var(--bg-secondary)", borderBottom: "1px solid var(--border-color)" },
          body: { backgroundColor: "var(--bg-secondary)", maxHeight: "80vh", overflowY: "auto" },
          content: { backgroundColor: "var(--bg-secondary)" },
          title: { color: "var(--text-primary)", fontWeight: 600, fontSize: 18 },
          close: { color: "var(--text-secondary)" },
        }}
      >
        <Stack gap="md">
          <Alert variant="light" color="blue" styles={{ root: { padding: "10px 14px" }, message: { fontSize: 12, lineHeight: 1.5 } }}>
            <strong>Building effective playbooks:</strong> A playbook defines a team of agents that work together.
            Assign one <strong>master</strong> agent to coordinate, and <strong>workers</strong> for specialized tasks.
            Each agent can have a persona — use the <strong>Persona Library</strong> to pick pre-built roles or create custom ones.
            Tip: Keep teams focused — 3-5 agents is a sweet spot. Too many agents create coordination overhead.
          </Alert>

          {saveError && (
            <Alert variant="light" color="red" styles={{ root: { padding: "8px 12px" } }}>
              {saveError}
            </Alert>
          )}

          <Group grow gap="sm">
            <TextInput label="Playbook Name" placeholder="e.g. API Migration Team" value={newName}
              onChange={(e) => setNewName(e.currentTarget.value)} required
              styles={{ input: { ...inputStyle }, label: { color: "var(--text-secondary)", fontSize: 13 } }} />
            <TextInput label="Description" placeholder="Short description of the team" value={newDesc}
              onChange={(e) => setNewDesc(e.currentTarget.value)}
              styles={{ input: { ...inputStyle }, label: { color: "var(--text-secondary)", fontSize: 13 } }} />
          </Group>

          {/* Agents */}
          <div>
            <Group justify="space-between" mb={8}>
              <Text size="sm" fw={600} c="var(--text-primary)">Agents ({newAgents.length})</Text>
              <Button size="compact-xs" onClick={addAgent}
                styles={{ root: { backgroundColor: "var(--accent-blue)", fontSize: 11 } }}>
                + Add Agent
              </Button>
            </Group>

            <Stack gap={8}>
              {newAgents.map((agent, i) => (
                <Paper key={i} p="sm" withBorder style={{ backgroundColor: "var(--bg-primary)", borderColor: "var(--border-color)" }}>
                  <Group gap={8} mb={6} align="center">
                    <input
                      value={agent.name}
                      onChange={(e) => updateAgent(i, "name", e.target.value)}
                      placeholder="Agent name"
                      style={{ ...inputStyle, flex: 1, fontWeight: 600 }}
                    />
                    <select
                      value={agent.role}
                      onChange={(e) => updateAgent(i, "role", e.target.value)}
                      style={{ ...inputStyle, width: 100, flex: "none", cursor: "pointer" }}
                    >
                      <option value="master">master</option>
                      <option value="worker">worker</option>
                    </select>
                    {newAgents.length > 1 && (
                      <Tooltip label="Remove agent">
                        <ActionIcon variant="subtle" size="xs" color="red" onClick={() => removeAgent(i)}>
                          <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                            <line x1="18" y1="6" x2="6" y2="18" /><line x1="6" y1="6" x2="18" y2="18" />
                          </svg>
                        </ActionIcon>
                      </Tooltip>
                    )}
                  </Group>

                  {/* Persona row */}
                  <Group gap={6} align="center">
                    <Text size="xs" c="var(--text-muted)" style={{
                      flex: 1, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap",
                      fontStyle: agent.persona ? "normal" : "italic",
                    }}>
                      {agent.persona
                        ? (agent.persona.length > 60 ? agent.persona.slice(0, 60) + "..." : agent.persona)
                        : "(no persona — click Library to assign one)"}
                    </Text>
                    <Button variant="subtle" size="compact-xs" onClick={() => {
                      setPersonaTargetIdx(i);
                      setShowPersonaLibrary(true);
                    }} styles={{ root: { color: "var(--accent-purple)", fontSize: 11, height: 22, padding: "0 8px" } }}>
                      Library
                    </Button>
                    {agent.persona && (
                      <Button variant="subtle" size="compact-xs" onClick={() => updateAgent(i, "persona", "")}
                        styles={{ root: { color: "var(--text-muted)", fontSize: 11, height: 22, padding: "0 6px" } }}>
                        Clear
                      </Button>
                    )}
                  </Group>
                </Paper>
              ))}
            </Stack>
          </div>

          <Group justify="flex-end" mt="sm">
            <Button variant="default" onClick={() => { setShowCreate(false); setSaveError(""); }}
              styles={{ root: { backgroundColor: "var(--bg-tertiary)", borderColor: "var(--border-color)", color: "var(--text-primary)" } }}>
              Cancel
            </Button>
            <Button onClick={handleSavePlaybook} loading={saving} disabled={!newName.trim()}
              styles={{ root: { backgroundColor: "var(--accent-blue)" } }}>
              Save Playbook
            </Button>
          </Group>
        </Stack>
      </Modal>

      {/* Persona Library for agent persona selection */}
      <PersonaLibrary
        opened={showPersonaLibrary}
        onClose={() => { setShowPersonaLibrary(false); setPersonaTargetIdx(null); }}
        onSelect={handlePersonaSelect}
      />
    </div>
  );
}
