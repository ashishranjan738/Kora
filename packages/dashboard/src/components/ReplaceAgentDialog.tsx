import { useState } from "react";
import { useApi } from "../hooks/useApi";
import {
  Modal,
  Button,
  Textarea,
  Stack,
  Group,
  Text,
  Slider,
  Alert,
  Loader,
  Card,
} from "@mantine/core";
import { useMediaQuery } from "@mantine/hooks";

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

  const [contextLines, setContextLines] = useState(50);
  const [extraContext, setExtraContext] = useState("");
  const [replacing, setReplacing] = useState(false);
  const [error, setError] = useState("");

  async function handleReplaceWithContext() {
    setError("");
    setReplacing(true);
    try {
      const result = await api.replaceAgent(sessionId, agentId, {
        contextLines,
        extraContext: extraContext.trim() || undefined,
        freshStart: false,
      });
      onReplaced(result);
      onClose();
    } catch (err: any) {
      setError(err.message || "Failed to replace agent");
    } finally {
      setReplacing(false);
    }
  }

  async function handleFreshRestart() {
    setError("");
    setReplacing(true);
    try {
      const result = await api.replaceAgent(sessionId, agentId, {
        freshStart: true,
      });
      onReplaced(result);
      onClose();
    } catch (err: any) {
      setError(err.message || "Failed to replace agent");
    } finally {
      setReplacing(false);
    }
  }

  return (
    <Modal
      opened
      onClose={onClose}
      title={`Replace Agent: ${agentName}`}
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
      <Stack gap="md">
        <Text size="sm" c="var(--text-secondary)" lh={1.5}>
          The current agent will be killed and a new one will be spawned with
          the same configuration.
        </Text>

        {error && (
          <Alert color="red" variant="light">
            {error}
          </Alert>
        )}

        {replacing ? (
          <Stack align="center" justify="center" py="xl" gap="md">
            <Loader size="md" color="var(--accent-blue)" />
            <Text size="sm" c="var(--text-secondary)">
              Replacing agent...
            </Text>
          </Stack>
        ) : (
          <div style={{ display: "flex", gap: 12, flexDirection: isMobile ? "column" : "row" }}>
            {/* Card 1: Replace with Context */}
            <Card
              withBorder
              padding="md"
              style={{
                flex: 1,
                backgroundColor: "var(--bg-primary)",
                borderColor: "var(--border-color)",
                display: "flex",
                flexDirection: "column",
                gap: 12,
              }}
            >
              <Text size="lg">[refresh]</Text>
              <Text fw={600} size="sm">
                Replace with Context
              </Text>
              <Text size="xs" c="var(--text-secondary)" lh={1.5}>
                Captures the last {contextLines} lines of terminal output and
                passes them to the new agent as recovery context.
              </Text>

              <div>
                <Text size="xs" c="var(--text-muted)" mb={4}>
                  Context lines: {contextLines}
                </Text>
                <Slider
                  min={10}
                  max={200}
                  step={10}
                  value={contextLines}
                  onChange={setContextLines}
                  color="blue"
                  styles={{
                    track: { backgroundColor: "var(--bg-tertiary)" },
                  }}
                />
              </div>

              <Textarea
                label="Additional instructions (optional)"
                value={extraContext}
                onChange={(e) => setExtraContext(e.currentTarget.value)}
                placeholder="e.g. Focus on the header, not the footer"
                rows={3}
                autosize
                minRows={2}
                maxRows={4}
                styles={{
                  input: {
                    backgroundColor: "var(--bg-tertiary)",
                    borderColor: "var(--border-color)",
                    color: "var(--text-primary)",
                  },
                  label: { color: "var(--text-muted)", fontSize: 12 },
                }}
              />

              <Button
                fullWidth
                onClick={handleReplaceWithContext}
                mt="auto"
                styles={{
                  root: {
                    backgroundColor: "var(--accent-blue)",
                    borderColor: "var(--accent-blue)",
                    minHeight: 44,
                  },
                }}
              >
                Replace with Context
              </Button>
            </Card>

            {/* Card 2: Fresh Restart */}
            <Card
              withBorder
              padding="md"
              style={{
                flex: 1,
                backgroundColor: "var(--bg-primary)",
                borderColor: "var(--border-color)",
                display: "flex",
                flexDirection: "column",
                gap: 12,
              }}
            >
              <Text size="lg">[new]</Text>
              <Text fw={600} size="sm">
                Fresh Restart
              </Text>
              <Text size="xs" c="var(--text-secondary)" lh={1.5}>
                Starts a completely clean agent with no memory of the previous
                one. Best when the agent was completely wrong.
              </Text>

              <div style={{ flex: 1 }} />

              <Button
                fullWidth
                variant="outline"
                color="green"
                mt="auto"
                onClick={handleFreshRestart}
                styles={{ root: { minHeight: 44 } }}
              >
                Fresh Restart
              </Button>
            </Card>
          </div>
        )}

        {!replacing && (
          <Group justify="flex-end">
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
              Cancel
            </Button>
          </Group>
        )}
      </Stack>
    </Modal>
  );
}
