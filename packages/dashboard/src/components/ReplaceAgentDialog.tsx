import { useState } from "react";
import { useApi } from "../hooks/useApi";
import { PROVIDERS } from "../constants/providers";
import {
  Modal,
  Button,
  Stack,
  Group,
  Text,
  TextInput,
  Select,
  Textarea,
  Radio,
  Alert,
  Loader,
  ThemeIcon,
  Divider,
  Paper,
  Slider,
} from "@mantine/core";
import { useMediaQuery } from "@mantine/hooks";

/* ------------------------------------------------------------------ */
/*  Shared                                                             */
/* ------------------------------------------------------------------ */

const modalStyles = {
  header: {
    backgroundColor: "var(--bg-secondary)",
    borderBottom: "1px solid var(--border-color)",
    padding: "16px 24px",
  },
  body: { backgroundColor: "var(--bg-secondary)", padding: "24px" },
  content: { backgroundColor: "var(--bg-secondary)", borderRadius: 12 },
  title: { color: "var(--text-primary)", fontWeight: 700 as const, fontSize: 17 },
  close: { color: "var(--text-secondary)" },
};

const fieldStyles = {
  input: {
    backgroundColor: "var(--bg-primary)",
    borderColor: "var(--border-color)",
    color: "var(--text-primary)",
    borderRadius: 8,
    height: 42,
    fontSize: 14,
  },
  label: {
    color: "var(--text-primary)",
    fontSize: 13,
    fontWeight: 500 as const,
    marginBottom: 6,
  },
};

const textareaStyles = {
  input: {
    backgroundColor: "var(--bg-primary)",
    borderColor: "var(--border-color)",
    color: "var(--text-primary)",
    borderRadius: 8,
    fontSize: 14,
  },
  label: {
    color: "var(--text-primary)",
    fontSize: 13,
    fontWeight: 500 as const,
    marginBottom: 6,
  },
};

const cancelBtnStyles = {
  root: {
    backgroundColor: "var(--bg-tertiary)",
    borderColor: "var(--border-color)",
    color: "var(--text-primary)",
    minHeight: 42,
    paddingInline: 24,
    borderRadius: 8,
    fontWeight: 500 as const,
  },
};

const primaryBtnBase = {
  minHeight: 42,
  paddingInline: 28,
  borderRadius: 8,
  fontWeight: 600 as const,
};

const radioStyles = {
  label: { color: "var(--text-primary)", fontSize: 14, fontWeight: 500 as const },
  description: { color: "var(--text-muted)", fontSize: 12, marginTop: 2 },
  radio: { borderColor: "var(--border-color)", backgroundColor: "var(--bg-primary)" },
};

/* ------------------------------------------------------------------ */
/*  Restart Agent Dialog                                               */
/* ------------------------------------------------------------------ */

interface RestartAgentDialogProps {
  sessionId: string;
  agentId: string;
  agentName: string;
  onClose: () => void;
  onRestarted: (newAgent: any) => void;
}

export function RestartAgentDialog({
  sessionId,
  agentId,
  agentName,
  onClose,
  onRestarted,
}: RestartAgentDialogProps) {
  const api = useApi();
  const isMobile = useMediaQuery("(max-width: 48em)");
  const [contextMode, setContextMode] = useState<"fresh" | "with-context" | "with-summary">("fresh");
  const [contextLines, setContextLines] = useState(50);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");

  async function handleSubmit() {
    setError("");
    setLoading(true);
    try {
      const result = await api.restartAgent(sessionId, agentId, {
        carryContext: contextMode === "with-context",
        contextLines: contextMode === "with-context" ? contextLines : undefined,
        summaryMode: contextMode === "with-summary",
      });
      onRestarted(result);
      onClose();
    } catch (err: any) {
      setError(err.message || "Failed to restart agent");
    } finally {
      setLoading(false);
    }
  }

  return (
    <Modal
      opened
      onClose={onClose}
      title={`Restart Agent: ${agentName}`}
      size="md"
      fullScreen={isMobile}
      centered
      styles={modalStyles}
    >
      {error && <Alert color="red" variant="light" mb="md" radius="md">{error}</Alert>}

      {loading ? (
        <Stack align="center" justify="center" py={48} gap="md">
          <Loader size="md" color="var(--accent-blue)" />
          <Text size="sm" c="var(--text-secondary)">Restarting agent...</Text>
        </Stack>
      ) : (
        <Stack gap="lg">
          <Text size="sm" c="var(--text-secondary)" lh={1.6}>
            Restart this agent with the same identity. Same code, same history.
          </Text>

          <Paper
            p="md"
            radius="md"
            style={{
              backgroundColor: "rgba(88,166,255,0.06)",
              border: "1px solid rgba(88,166,255,0.15)",
            }}
          >
            <Group gap={10} wrap="nowrap" align="flex-start">
              <ThemeIcon variant="light" color="blue" size={28} radius="xl" style={{ flexShrink: 0, marginTop: 1 }}>
                <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                  <circle cx="12" cy="12" r="10" />
                  <line x1="12" y1="16" x2="12" y2="12" />
                  <line x1="12" y1="8" x2="12.01" y2="8" />
                </svg>
              </ThemeIcon>
              <Text size="xs" c="var(--text-secondary)" lh={1.5}>
                Preserves agent ID, git worktree, task assignments, and message inbox.
              </Text>
            </Group>
          </Paper>

          <Divider color="var(--border-color)" />

          <Radio.Group
            value={contextMode}
            onChange={(v) => setContextMode(v as "fresh" | "with-context" | "with-summary")}
            label={<Text size="sm" fw={600} c="var(--text-primary)">Terminal context</Text>}
          >
            <Stack gap={12} mt={10}>
              <Radio value="fresh" label="Fresh restart (no context)" description="Agent starts with a clean terminal" styles={radioStyles} />
              <Radio value="with-context" label="With context (carry terminal history)" description="Passes recent terminal output to the new session" styles={radioStyles} />
              <Radio value="with-summary" label="With summary (recommended)" description="Generates a structured summary of completed tasks, recent messages, and terminal activity" styles={radioStyles} />
            </Stack>
          </Radio.Group>

          {contextMode === "with-context" && (
            <Paper
              p="md"
              radius="md"
              style={{ backgroundColor: "var(--bg-primary)", border: "1px solid var(--border-color)" }}
            >
              <Group justify="space-between" mb={10}>
                <Text size="xs" fw={500} c="var(--text-primary)">Context window</Text>
                <Text size="xs" fw={600} c="var(--accent-blue)">{contextLines} lines</Text>
              </Group>
              <Slider
                value={contextLines}
                onChange={setContextLines}
                min={10}
                max={500}
                step={10}
                marks={[
                  { value: 10, label: "10" },
                  { value: 100, label: "100" },
                  { value: 250, label: "250" },
                  { value: 500, label: "500" },
                ]}
                styles={{
                  track: { backgroundColor: "var(--bg-tertiary)" },
                  bar: { backgroundColor: "var(--accent-blue)" },
                  thumb: { borderColor: "var(--accent-blue)", backgroundColor: "var(--bg-secondary)" },
                  mark: { borderColor: "var(--border-color)", backgroundColor: "var(--bg-tertiary)" },
                  markLabel: { color: "var(--text-muted)", fontSize: 10 },
                }}
              />
              <Text size="xs" c="var(--text-muted)" mt={28}>
                Number of recent terminal output lines to pass as context to the new session.
              </Text>
            </Paper>
          )}

          {contextMode === "with-summary" && (
            <Paper
              p="md"
              radius="md"
              style={{ backgroundColor: "rgba(88,166,255,0.04)", border: "1px solid rgba(88,166,255,0.12)" }}
            >
              <Text size="xs" fw={500} c="var(--text-primary)" mb={8}>Summary includes:</Text>
              <Stack gap={4}>
                <Text size="xs" c="var(--text-muted)" lh={1.5}>
                  {"\u2022"} Completed and active tasks assigned to this agent
                </Text>
                <Text size="xs" c="var(--text-muted)" lh={1.5}>
                  {"\u2022"} Terminal activity (last 200 lines of output)
                </Text>
                <Text size="xs" c="var(--text-muted)" lh={1.5}>
                  {"\u2022"} Agent role, provider, and current task
                </Text>
                <Text size="xs" c="var(--text-muted)" lh={1.5}>
                  {"\u2022"} Instructions to check messages and continue work
                </Text>
              </Stack>
            </Paper>
          )}

          <Divider color="var(--border-color)" />

          <Group justify="flex-end" gap={12}>
            <Button variant="default" onClick={onClose} styles={cancelBtnStyles}>Cancel</Button>
            <Button onClick={handleSubmit} styles={{ root: { ...primaryBtnBase, backgroundColor: "var(--accent-blue)", borderColor: "var(--accent-blue)" } }}>
              Restart
            </Button>
          </Group>
        </Stack>
      )}
    </Modal>
  );
}

/* ------------------------------------------------------------------ */
/*  Replace Agent Dialog                                               */
/* ------------------------------------------------------------------ */

interface ReplaceAgentDialogProps {
  sessionId: string;
  agentId: string;
  agentName: string;
  onClose: () => void;
  onReplaced: (newAgent: any) => void;
}

export function ReplaceAgentDialog({
  sessionId,
  agentId,
  agentName,
  onClose,
  onReplaced,
}: ReplaceAgentDialogProps) {
  const api = useApi();
  const isMobile = useMediaQuery("(max-width: 48em)");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");

  const [replaceName, setReplaceName] = useState(agentName);
  const [replaceModel, setReplaceModel] = useState("");
  const [replaceProvider, setReplaceProvider] = useState("");
  const [replacePersona, setReplacePersona] = useState("");

  async function handleSubmit() {
    setError("");
    setLoading(true);
    try {
      const result = await api.replaceAgent(sessionId, agentId, {
        name: replaceName.trim() || undefined,
        model: replaceModel.trim() || undefined,
        cliProvider: replaceProvider || undefined,
        persona: replacePersona.trim() || undefined,
      });
      onReplaced(result);
      onClose();
    } catch (err: any) {
      setError(err.message || "Failed to replace agent");
    } finally {
      setLoading(false);
    }
  }

  return (
    <Modal
      opened
      onClose={onClose}
      title={`Replace Agent: ${agentName}`}
      size="md"
      fullScreen={isMobile}
      centered
      styles={modalStyles}
    >
      {error && <Alert color="red" variant="light" mb="md" radius="md">{error}</Alert>}

      {loading ? (
        <Stack align="center" justify="center" py={48} gap="md">
          <Loader size="md" color="red" />
          <Text size="sm" c="var(--text-secondary)">Replacing agent...</Text>
        </Stack>
      ) : (
        <Stack gap="lg">
          <Text size="sm" c="var(--text-secondary)" lh={1.6}>
            Replace with a fresh agent. New identity, clean slate.
          </Text>

          <Paper
            p="md"
            radius="md"
            style={{
              backgroundColor: "rgba(248,81,73,0.06)",
              border: "1px solid rgba(248,81,73,0.15)",
            }}
          >
            <Group gap={10} wrap="nowrap" align="flex-start">
              <ThemeIcon variant="light" color="red" size={28} radius="xl" style={{ flexShrink: 0, marginTop: 1 }}>
                <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                  <path d="M10.29 3.86L1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z" />
                  <line x1="12" y1="9" x2="12" y2="13" />
                  <line x1="12" y1="17" x2="12.01" y2="17" />
                </svg>
              </ThemeIcon>
              <Text size="xs" c="var(--text-secondary)" lh={1.5}>
                Creates a new agent ID. Old worktree, task assignments, and messages will be removed.
              </Text>
            </Group>
          </Paper>

          <Divider color="var(--border-color)" />

          <Text size="sm" fw={600} c="var(--text-primary)">Configuration</Text>

          <Stack gap="md">
            <TextInput
              label="Agent name"
              placeholder={agentName}
              value={replaceName}
              onChange={(e) => setReplaceName(e.currentTarget.value)}
              styles={fieldStyles}
            />

            <Group grow gap="md">
              <Select
                label="Provider"
                placeholder="Same as before"
                data={PROVIDERS}
                value={replaceProvider || null}
                onChange={(v) => setReplaceProvider(v || "")}
                clearable
                styles={fieldStyles}
              />
              <TextInput
                label="Model"
                placeholder="Same as before"
                value={replaceModel}
                onChange={(e) => setReplaceModel(e.currentTarget.value)}
                styles={fieldStyles}
              />
            </Group>

            <Textarea
              label="Persona (optional)"
              placeholder="Override persona instructions..."
              value={replacePersona}
              onChange={(e) => setReplacePersona(e.currentTarget.value)}
              minRows={3}
              maxRows={5}
              autosize
              styles={textareaStyles}
            />
          </Stack>

          <Divider color="var(--border-color)" />

          <Group justify="flex-end" gap={12}>
            <Button variant="default" onClick={onClose} styles={cancelBtnStyles}>Cancel</Button>
            <Button color="red" onClick={handleSubmit} styles={{ root: primaryBtnBase }}>
              Replace Agent
            </Button>
          </Group>
        </Stack>
      )}
    </Modal>
  );
}
