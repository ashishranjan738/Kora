import { useState } from "react";
import { Modal, SimpleGrid, Card, Text, Button, Stack, Group, Badge, TextInput, Textarea, ActionIcon, Tooltip, Alert } from "@mantine/core";
import { useMediaQuery } from "@mantine/hooks";
import { usePersonas, type Persona } from "../hooks/usePersonas";
import { showError } from "../utils/notifications";

interface PersonaLibraryProps {
  opened: boolean;
  onClose: () => void;
  onSelect: (persona: Persona) => void;
  /** When true, shows "View" instead of "Select" — for browsing from AllSessions */
  browseOnly?: boolean;
}

const PERSONA_ICONS: Record<string, string> = {
  orchestrator: "\uD83C\uDFAF",
  backend: "\u2699\uFE0F",
  frontend: "\uD83C\uDFA8",
  fullstack: "\uD83D\uDD27",
  tester: "\uD83E\uDDEA",
  reviewer: "\uD83D\uDC41\uFE0F",
  devops: "\uD83D\uDE80",
  researcher: "\uD83D\uDD0D",
};

function PersonaCard({
  persona, onSelect, onPreview, onDelete, isCustom, selectLabel,
}: {
  persona: Persona; onSelect?: () => void; onPreview: () => void; onDelete?: () => void; isCustom?: boolean; selectLabel?: string;
}) {
  const icon = PERSONA_ICONS[persona.id] || (isCustom ? "\u270F\uFE0F" : "\uD83E\uDD16");
  return (
    <Card padding="md" radius="md" style={{
      backgroundColor: "var(--bg-tertiary)", border: "1px solid var(--border-color)",
      cursor: "pointer", transition: "all 0.15s", position: "relative",
    }}
      onMouseEnter={(e) => { e.currentTarget.style.borderColor = "var(--accent-blue)"; e.currentTarget.style.transform = "translateY(-2px)"; }}
      onMouseLeave={(e) => { e.currentTarget.style.borderColor = "var(--border-color)"; e.currentTarget.style.transform = "translateY(0)"; }}
    >
      <Stack gap="sm">
        <Group justify="space-between" align="flex-start">
          <Text size="xl" style={{ fontSize: 28 }}>{icon}</Text>
          <Group gap={4}>
            <Badge color={isCustom ? "grape" : "blue"} variant="light" size="sm">
              {isCustom ? "custom" : "pre-built"}
            </Badge>
            {isCustom && onDelete && (
              <Tooltip label="Delete persona">
                <ActionIcon variant="subtle" size="xs" color="red"
                  onClick={(e) => { e.stopPropagation(); onDelete(); }}>
                  <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><line x1="18" y1="6" x2="6" y2="18" /><line x1="6" y1="6" x2="18" y2="18" /></svg>
                </ActionIcon>
              </Tooltip>
            )}
          </Group>
        </Group>
        <Text size="md" fw={600} c="var(--text-primary)" style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
          {persona.name}
        </Text>
        <Text size="sm" c="var(--text-muted)" style={{ minHeight: 36, lineHeight: 1.4 }}>
          {persona.description}
        </Text>
        <Group grow gap={6}>
          <Button variant="default" onClick={onPreview}
            styles={{ root: { backgroundColor: "var(--bg-secondary)", borderColor: "var(--border-color)", color: "var(--text-primary)", minHeight: 34 } }}>
            {onSelect ? "Preview" : "View"}
          </Button>
          {onSelect && (
            <Button variant="light" onClick={onSelect}
              styles={{ root: { backgroundColor: "var(--accent-blue)", color: "white", minHeight: 34 } }}>
              {selectLabel || "Select"}
            </Button>
          )}
        </Group>
      </Stack>
    </Card>
  );
}

export function PersonaLibrary({ opened, onClose, onSelect, browseOnly }: PersonaLibraryProps) {
  const { personas, customPersonas, builtinPersonas, addPersona, deletePersona } = usePersonas();
  const isMobile = useMediaQuery("(max-width: 48em)");
  const isTablet = useMediaQuery("(max-width: 62em)");

  const [showCreate, setShowCreate] = useState(false);
  const [previewPersona, setPreviewPersona] = useState<Persona | null>(null);
  const [newName, setNewName] = useState("");
  const [newDesc, setNewDesc] = useState("");
  const [newText, setNewText] = useState("");
  const [saving, setSaving] = useState(false);

  const handleSelect = (persona: Persona) => {
    onSelect(persona);
    onClose();
    setShowCreate(false);
  };

  const handleCreate = async () => {
    if (!newName.trim() || !newText.trim()) return;
    setSaving(true);
    try {
      const persona = await addPersona({
        name: newName.trim(),
        description: newDesc.trim() || newName.trim(),
        fullText: newText.trim(),
      });
      setNewName(""); setNewDesc(""); setNewText("");
      setShowCreate(false);
      handleSelect(persona);
    } catch {
      // Error handled silently
    } finally {
      setSaving(false);
    }
  };

  const handleDelete = async (id: string) => {
    try {
      await deletePersona(id);
    } catch {
      showError("Failed to delete persona");
    }
  };

  const cols = isMobile ? 1 : isTablet ? 2 : 3;
  const customIds = new Set(customPersonas.map(p => p.id));

  return (
    <Modal
      opened={opened}
      onClose={() => { onClose(); setShowCreate(false); setPreviewPersona(null); }}
      title="Persona Library"
      size="xl"
      fullScreen={isMobile}
      centered
      styles={{
        header: { backgroundColor: "var(--bg-secondary)", borderBottom: "1px solid var(--border-color)" },
        body: { backgroundColor: "var(--bg-secondary)", padding: isMobile ? 12 : 24, maxHeight: "75vh", overflowY: "auto" },
        content: { backgroundColor: "var(--bg-secondary)" },
        title: { color: "var(--text-primary)", fontWeight: 600, fontSize: 18 },
        close: { color: "var(--text-secondary)" },
      }}
    >
      <Stack gap="md">
        {/* Preview view — replaces the grid */}
        {previewPersona ? (
          <Stack gap="md">
            <Group gap={8}>
              <ActionIcon variant="subtle" size="sm" onClick={() => setPreviewPersona(null)}
                style={{ color: "var(--text-secondary)" }}>
                <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                  <line x1="19" y1="12" x2="5" y2="12" /><polyline points="12 19 5 12 12 5" />
                </svg>
              </ActionIcon>
              <Text size="lg" fw={700} c="var(--text-primary)">{previewPersona.name}</Text>
              <Badge color={previewPersona.isCustom ? "grape" : "blue"} variant="light" size="sm">
                {previewPersona.isCustom ? "custom" : "pre-built"}
              </Badge>
            </Group>
            <Text size="sm" c="var(--text-muted)">{previewPersona.description}</Text>
            <div style={{
              padding: 14, backgroundColor: "var(--bg-tertiary)", borderRadius: 8,
              border: "1px solid var(--border-color)", fontSize: 13, lineHeight: 1.7,
              color: "var(--text-secondary)", fontFamily: "ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace",
              whiteSpace: "pre-wrap", wordBreak: "break-word", maxHeight: "50vh", overflowY: "auto",
            }}>
              {previewPersona.fullText}
            </div>
            <Group justify="flex-end" gap={8}>
              <Button variant="default" onClick={() => setPreviewPersona(null)}
                styles={{ root: { backgroundColor: "var(--bg-tertiary)", borderColor: "var(--border-color)", color: "var(--text-primary)" } }}>
                Back
              </Button>
              {!browseOnly && (
                <Button onClick={() => { handleSelect(previewPersona); setPreviewPersona(null); }}
                  styles={{ root: { backgroundColor: "var(--accent-blue)" } }}>
                  Use This Persona
                </Button>
              )}
            </Group>
          </Stack>
        ) : (
        <>
        <Group justify="space-between">
          <Text size="sm" c="var(--text-muted)">
            Select a persona or create your own. Custom personas are saved globally and available across all sessions.
          </Text>
          <Button size="compact-sm" onClick={() => setShowCreate(!showCreate)}
            styles={{ root: { backgroundColor: showCreate ? "var(--bg-tertiary)" : "var(--accent-blue)", color: showCreate ? "var(--text-primary)" : "white", flexShrink: 0 } }}>
            {showCreate ? "Cancel" : "+ Create Custom"}
          </Button>
        </Group>

        {/* Create form */}
        {showCreate && (
          <Card padding="md" radius="md" style={{ backgroundColor: "var(--bg-primary)", border: "1px solid var(--accent-blue)" }}>
            <Stack gap="sm">
              <Text size="sm" fw={600} c="var(--text-primary)">Create Custom Persona</Text>
              <Alert variant="light" color="blue" styles={{ root: { padding: "8px 12px" }, message: { fontSize: 12, lineHeight: 1.5 } }}>
                <strong>Tips for effective personas:</strong> Define the agent's role clearly. Specify what it should and should NOT do. Include the tech stack it works with. Add rules like "always write tests" or "never modify backend files". The more specific, the better the agent performs.
              </Alert>
              <Group grow gap="sm">
                <TextInput placeholder="Name (e.g. Security Expert)" value={newName} onChange={(e) => setNewName(e.currentTarget.value)}
                  styles={{ input: { backgroundColor: "var(--bg-tertiary)", borderColor: "var(--border-color)", color: "var(--text-primary)" } }} />
                <TextInput placeholder="Short description" value={newDesc} onChange={(e) => setNewDesc(e.currentTarget.value)}
                  styles={{ input: { backgroundColor: "var(--bg-tertiary)", borderColor: "var(--border-color)", color: "var(--text-primary)" } }} />
              </Group>
              <Textarea placeholder={"Example:\nYou are a Security Engineer specializing in:\n- OWASP top 10 vulnerability detection\n- Authentication and authorization patterns\n- Input validation and sanitization\n- Dependency audit and supply chain security\n\nRules:\n- Always flag potential SQL injection, XSS, and CSRF\n- Never approve code with hardcoded credentials\n- Suggest fixes, not just findings"}
                value={newText} onChange={(e) => setNewText(e.currentTarget.value)} minRows={6} maxRows={12} autosize
                styles={{ input: { backgroundColor: "var(--bg-tertiary)", borderColor: "var(--border-color)", color: "var(--text-primary)" } }} />
              <Group justify="flex-end">
                <Button onClick={handleCreate} disabled={!newName.trim() || !newText.trim()} loading={saving}
                  styles={{ root: { backgroundColor: "var(--accent-blue)" } }}>
                  Save & Select
                </Button>
              </Group>
            </Stack>
          </Card>
        )}

        {/* Custom personas */}
        {customPersonas.length > 0 && (
          <>
            <Text size="xs" fw={600} c="var(--text-secondary)" style={{ textTransform: "uppercase", letterSpacing: 1 }}>
              Your Custom Personas ({customPersonas.length})
            </Text>
            <SimpleGrid cols={cols} spacing="md">
              {personas.filter(p => customIds.has(p.id)).map((persona) => (
                <PersonaCard key={persona.id} persona={persona}
                  onSelect={browseOnly ? undefined : () => handleSelect(persona)}
                  onPreview={() => setPreviewPersona(persona)}
                  onDelete={() => handleDelete(persona.id)} isCustom />
              ))}
            </SimpleGrid>
          </>
        )}

        {/* Pre-built */}
        <Text size="xs" fw={600} c="var(--text-secondary)" style={{ textTransform: "uppercase", letterSpacing: 1 }}>
          Pre-built Personas ({builtinPersonas.length})
        </Text>
        <SimpleGrid cols={cols} spacing="md">
          {builtinPersonas.map((persona) => (
            <PersonaCard key={persona.id} persona={persona}
              onSelect={browseOnly ? undefined : () => handleSelect(persona)}
              onPreview={() => setPreviewPersona(persona)} />
          ))}
        </SimpleGrid>

        <Group justify="flex-end" mt="md">
          <Button variant="default" onClick={() => { onClose(); setShowCreate(false); setPreviewPersona(null); }}
            styles={{ root: { backgroundColor: "var(--bg-tertiary)", borderColor: "var(--border-color)", color: "var(--text-primary)", minHeight: 40 } }}>
            {browseOnly ? "Close" : "Cancel"}
          </Button>
        </Group>
        </>
        )}
      </Stack>
    </Modal>
  );
}
