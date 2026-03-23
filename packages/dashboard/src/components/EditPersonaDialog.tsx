import { useEffect, useState } from "react";
import {
  Modal,
  Stack,
  Group,
  Text,
  Textarea,
  Button,
  Alert,
  Divider,
  Badge,
} from "@mantine/core";
import { useMediaQuery } from "@mantine/hooks";
import { useApi } from "../hooks/useApi";

/* ── Styles ─────────────────────────────────────────────── */

const modalStyles = {
  header: { backgroundColor: "var(--bg-secondary)", borderBottom: "1px solid var(--border-color)", padding: "16px 24px" },
  body: { backgroundColor: "var(--bg-secondary)", padding: "24px" },
  content: { backgroundColor: "var(--bg-secondary)", borderRadius: 12 },
  title: { color: "var(--text-primary)", fontWeight: 700 as const, fontSize: 17 },
  close: { color: "var(--text-secondary)" },
};

const textareaStyles = {
  input: { backgroundColor: "var(--bg-primary)", borderColor: "var(--border-color)", color: "var(--text-primary)", borderRadius: 8, fontSize: 13, fontFamily: "var(--font-mono)" },
  label: { color: "var(--text-primary)", fontSize: 13, fontWeight: 500 as const, marginBottom: 6 },
};

const cancelBtnStyles = { root: { backgroundColor: "var(--bg-tertiary)", borderColor: "var(--border-color)", color: "var(--text-primary)", minHeight: 40, paddingInline: 20, borderRadius: 8, fontWeight: 500 as const } };
const primaryBtnStyles = { root: { backgroundColor: "var(--accent-blue)", borderColor: "var(--accent-blue)", minHeight: 40, paddingInline: 24, borderRadius: 8, fontWeight: 600 as const } };

/* ── Props ───────────────────────────────────────────────── */

interface EditPersonaDialogProps {
  opened: boolean;
  onClose: () => void;
  sessionId: string;
  agentId: string;
  agentName: string;
  /** Base persona set at spawn time (read-only) */
  basePersona?: string;
}

/* ── Component ───────────────────────────────────────────── */

export function EditPersonaDialog({ opened, onClose, sessionId, agentId, agentName, basePersona }: EditPersonaDialogProps) {
  const api = useApi();
  const isMobile = useMediaQuery("(max-width: 48em)");

  const [personaOverride, setPersonaOverride] = useState("");
  const [loading, setLoading] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");
  const [success, setSuccess] = useState(false);
  const [lastUpdated, setLastUpdated] = useState<string | null>(null);

  // Load current persona override when dialog opens
  useEffect(() => {
    if (!opened) return;
    setError("");
    setSuccess(false);
    let cancelled = false;

    async function load() {
      setLoading(true);
      try {
        const data: any = await api.getAgentPersona(sessionId, agentId);
        if (cancelled) return;
        setPersonaOverride(data.personaOverride || "");
        if (data.lastUpdated) setLastUpdated(data.lastUpdated);
      } catch {
        // If endpoint not available yet, start with empty
        if (!cancelled) setPersonaOverride("");
      } finally {
        if (!cancelled) setLoading(false);
      }
    }
    load();
    return () => { cancelled = true; };
  }, [opened, sessionId, agentId]); // eslint-disable-line react-hooks/exhaustive-deps

  async function handleSave() {
    setSaving(true);
    setError("");
    setSuccess(false);
    try {
      await api.updateAgentPersona(sessionId, agentId, personaOverride);
      setSuccess(true);
      setLastUpdated(new Date().toISOString());
    } catch (err: any) {
      setError(err.message || "Failed to update persona");
    } finally {
      setSaving(false);
    }
  }

  return (
    <Modal
      opened={opened}
      onClose={onClose}
      title={`Edit Persona: ${agentName}`}
      size="lg"
      fullScreen={isMobile}
      centered
      styles={modalStyles}
    >
      <Stack gap="md">
        {error && <Alert color="red" variant="light" radius="md">{error}</Alert>}
        {success && <Alert color="green" variant="light" radius="md">Persona updated. Agent will be notified to refresh context.</Alert>}

        {/* Base persona (read-only) */}
        {basePersona && (
          <div>
            <Group gap={8} mb={6}>
              <Text size="sm" fw={500} c="var(--text-primary)">Base Persona</Text>
              <Badge variant="light" color="gray" size="xs">read-only</Badge>
            </Group>
            <Textarea
              value={basePersona}
              readOnly
              autosize
              minRows={2}
              maxRows={6}
              styles={{
                input: { ...textareaStyles.input, opacity: 0.7, cursor: "default" },
              }}
            />
            <Text size="xs" c="var(--text-muted)" mt={4}>
              Set at spawn time. To change the base persona, replace the agent.
            </Text>
          </div>
        )}

        <Divider color="var(--border-color)" />

        {/* Additional instructions (editable) */}
        <div>
          <Group gap={8} mb={6}>
            <Text size="sm" fw={500} c="var(--text-primary)">Additional Instructions</Text>
            <Badge variant="light" color="blue" size="xs">editable</Badge>
          </Group>
          <Textarea
            value={personaOverride}
            onChange={(e) => setPersonaOverride(e.currentTarget.value)}
            placeholder="Add specific instructions for this agent... e.g., Focus on the auth module this sprint."
            autosize
            minRows={4}
            maxRows={12}
            disabled={loading}
            styles={textareaStyles}
          />
          <Group justify="space-between" mt={4}>
            <Text size="xs" c="var(--text-muted)">
              These instructions are appended to the agent's persona.
            </Text>
            {lastUpdated && (
              <Text size="xs" c="var(--text-muted)">
                Last updated: {new Date(lastUpdated).toLocaleString()}
              </Text>
            )}
          </Group>
        </div>

        <Divider color="var(--border-color)" />

        {/* Actions */}
        <Group justify="flex-end" gap={10}>
          <Button variant="default" onClick={onClose} disabled={saving} styles={cancelBtnStyles} size="sm">
            Cancel
          </Button>
          <Button
            onClick={handleSave}
            loading={saving}
            disabled={loading}
            styles={primaryBtnStyles}
            size="sm"
          >
            Save & Notify Agent
          </Button>
        </Group>
      </Stack>
    </Modal>
  );
}
