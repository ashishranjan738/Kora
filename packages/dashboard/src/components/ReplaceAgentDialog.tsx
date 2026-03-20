import { useState } from "react";
import { useApi } from "../hooks/useApi";
import {
  Modal,
  Button,
  Stack,
  Group,
  Text,
  SegmentedControl,
  Radio,
  Alert,
  Loader,
  ThemeIcon,
} from "@mantine/core";
import { useMediaQuery } from "@mantine/hooks";

interface ReplaceAgentDialogProps {
  sessionId: string;
  agentId: string;
  agentName: string;
  onClose: () => void;
  onReplaced: (newAgent: any) => void;
}

type Mode = "restart" | "replace";
type ContextMode = "fresh" | "with-context";

export function ReplaceAgentDialog({
  sessionId,
  agentId,
  agentName,
  onClose,
  onReplaced,
}: ReplaceAgentDialogProps) {
  const api = useApi();
  const isMobile = useMediaQuery("(max-width: 48em)");

  const [mode, setMode] = useState<Mode>("restart");
  const [contextMode, setContextMode] = useState<ContextMode>("fresh");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");

  async function handleSubmit() {
    setError("");
    setLoading(true);
    try {
      let result;
      if (mode === "restart") {
        result = await api.restartAgent(sessionId, agentId, {
          carryContext: contextMode === "with-context",
        });
      } else {
        result = await api.replaceAgent(sessionId, agentId);
      }
      onReplaced(result);
      onClose();
    } catch (err: any) {
      setError(err.message || `Failed to ${mode} agent`);
    } finally {
      setLoading(false);
    }
  }

  const modalStyles = {
    header: {
      backgroundColor: "var(--bg-secondary)",
      borderBottom: "1px solid var(--border-color)",
    },
    body: { backgroundColor: "var(--bg-secondary)" },
    content: { backgroundColor: "var(--bg-secondary)" },
    title: {
      color: "var(--text-primary)",
      fontWeight: 600 as const,
      fontSize: 18,
    },
    close: { color: "var(--text-secondary)" },
  };

  return (
    <Modal
      opened
      onClose={onClose}
      title={`${mode === "restart" ? "Restart" : "Replace"} Agent: ${agentName}`}
      size="md"
      fullScreen={isMobile}
      centered
      styles={modalStyles}
    >
      <Stack gap="md">
        {/* Mode selector */}
        <SegmentedControl
          value={mode}
          onChange={(v) => setMode(v as Mode)}
          fullWidth
          data={[
            { label: "Restart", value: "restart" },
            { label: "Replace", value: "replace" },
          ]}
          styles={{
            root: {
              backgroundColor: "var(--bg-tertiary)",
              border: "1px solid var(--border-color)",
            },
            label: {
              color: "var(--text-primary)",
              fontWeight: 500,
              fontSize: 14,
            },
            indicator: {
              backgroundColor:
                mode === "replace"
                  ? "var(--accent-red)"
                  : "var(--accent-blue)",
            },
          }}
        />

        {error && (
          <Alert color="red" variant="light">
            {error}
          </Alert>
        )}

        {loading ? (
          <Stack align="center" justify="center" py="xl" gap="md">
            <Loader
              size="md"
              color={
                mode === "replace"
                  ? "var(--accent-red)"
                  : "var(--accent-blue)"
              }
            />
            <Text size="sm" c="var(--text-secondary)">
              {mode === "restart" ? "Restarting" : "Replacing"} agent...
            </Text>
          </Stack>
        ) : mode === "restart" ? (
          /* Restart Mode */
          <Stack gap="md">
            <Text size="sm" c="var(--text-secondary)" lh={1.5}>
              Restart this agent with the same identity. Same code, same
              history.
            </Text>

            <Alert
              variant="light"
              color="blue"
              icon={
                <ThemeIcon
                  variant="light"
                  color="blue"
                  size="sm"
                  radius="xl"
                >
                  <svg
                    width="14"
                    height="14"
                    viewBox="0 0 24 24"
                    fill="none"
                    stroke="currentColor"
                    strokeWidth="2"
                    strokeLinecap="round"
                    strokeLinejoin="round"
                  >
                    <circle cx="12" cy="12" r="10" />
                    <line x1="12" y1="16" x2="12" y2="12" />
                    <line x1="12" y1="8" x2="12.01" y2="8" />
                  </svg>
                </ThemeIcon>
              }
            >
              <Text size="xs" fw={500}>
                Preserves: agent ID, git worktree, task assignments, message
                inbox
              </Text>
            </Alert>

            <Radio.Group
              value={contextMode}
              onChange={(v) => setContextMode(v as ContextMode)}
              label={
                <Text size="sm" fw={500} c="var(--text-primary)">
                  Terminal context
                </Text>
              }
            >
              <Stack gap="xs" mt={8}>
                <Radio
                  value="fresh"
                  label="Fresh restart (no context)"
                  description="Agent starts with a clean terminal"
                  styles={{
                    label: { color: "var(--text-primary)", fontSize: 14 },
                    description: {
                      color: "var(--text-muted)",
                      fontSize: 12,
                    },
                    radio: {
                      borderColor: "var(--border-color)",
                      backgroundColor: "var(--bg-primary)",
                    },
                  }}
                />
                <Radio
                  value="with-context"
                  label="With context (carry terminal history)"
                  description="Passes recent terminal output to the new session"
                  styles={{
                    label: { color: "var(--text-primary)", fontSize: 14 },
                    description: {
                      color: "var(--text-muted)",
                      fontSize: 12,
                    },
                    radio: {
                      borderColor: "var(--border-color)",
                      backgroundColor: "var(--bg-primary)",
                    },
                  }}
                />
              </Stack>
            </Radio.Group>

            <Group justify="flex-end" mt="xs">
              <Button
                variant="default"
                onClick={onClose}
                styles={{
                  root: {
                    backgroundColor: "var(--bg-tertiary)",
                    borderColor: "var(--border-color)",
                    color: "var(--text-primary)",
                    minHeight: 40,
                  },
                }}
              >
                Cancel
              </Button>
              <Button
                onClick={handleSubmit}
                styles={{
                  root: {
                    backgroundColor: "var(--accent-blue)",
                    borderColor: "var(--accent-blue)",
                    minHeight: 40,
                  },
                }}
              >
                Restart
              </Button>
            </Group>
          </Stack>
        ) : (
          /* Replace Mode */
          <Stack gap="md">
            <Text size="sm" c="var(--text-secondary)" lh={1.5}>
              Replace with a completely fresh agent. New identity, clean slate.
            </Text>

            <Alert
              variant="light"
              color="red"
              icon={
                <ThemeIcon
                  variant="light"
                  color="red"
                  size="sm"
                  radius="xl"
                >
                  <svg
                    width="14"
                    height="14"
                    viewBox="0 0 24 24"
                    fill="none"
                    stroke="currentColor"
                    strokeWidth="2"
                    strokeLinecap="round"
                    strokeLinejoin="round"
                  >
                    <path d="M10.29 3.86L1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z" />
                    <line x1="12" y1="9" x2="12" y2="13" />
                    <line x1="12" y1="17" x2="12.01" y2="17" />
                  </svg>
                </ThemeIcon>
              }
            >
              <Text size="xs" fw={500}>
                Creates new agent ID. Old worktree, task assignments, and
                messages are removed.
              </Text>
            </Alert>

            <Group justify="flex-end" mt="xs">
              <Button
                variant="default"
                onClick={onClose}
                styles={{
                  root: {
                    backgroundColor: "var(--bg-tertiary)",
                    borderColor: "var(--border-color)",
                    color: "var(--text-primary)",
                    minHeight: 40,
                  },
                }}
              >
                Cancel
              </Button>
              <Button
                color="red"
                onClick={handleSubmit}
                styles={{
                  root: {
                    minHeight: 40,
                  },
                }}
              >
                Replace
              </Button>
            </Group>
          </Stack>
        )}
      </Stack>
    </Modal>
  );
}
