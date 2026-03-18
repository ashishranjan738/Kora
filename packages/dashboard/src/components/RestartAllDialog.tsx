import { useEffect, useRef } from "react";
import {
  Modal,
  Button,
  Stack,
  Group,
  Text,
  List,
  Loader,
  Alert,
} from "@mantine/core";
import { useMediaQuery } from "@mantine/hooks";

export interface RestartAllDialogProps {
  agentCount: number;
  onCancel: () => void;
  onConfirm: () => void;
  restarting: boolean;
  result: { restarted: number } | null;
  error: string | null;
}

export function RestartAllDialog({
  agentCount,
  onCancel,
  onConfirm,
  restarting,
  result,
  error,
}: RestartAllDialogProps) {
  const cancelRef = useRef<HTMLButtonElement>(null);
  const isMobile = useMediaQuery("(max-width: 48em)");

  useEffect(() => {
    if (!restarting && !result && !error && cancelRef.current) {
      cancelRef.current.focus();
    }
  }, [restarting, result, error]);

  // Auto-close on success after 2.5s
  useEffect(() => {
    if (result && !error) {
      const t = setTimeout(onCancel, 2500);
      return () => clearTimeout(t);
    }
  }, [result, error, onCancel]);

  const modalStyles = {
    header: {
      backgroundColor: "var(--bg-secondary)",
      borderBottom: "1px solid var(--border-color)",
    },
    body: { backgroundColor: "var(--bg-secondary)" },
    content: { backgroundColor: "var(--bg-secondary)" },
    title: { color: "var(--text-primary)", fontWeight: 600 as const, fontSize: 18 },
    close: { color: "var(--text-secondary)" },
  };

  // Success state
  if (result && !error) {
    return (
      <Modal opened onClose={onCancel} title="Restart All Agents" size="sm" fullScreen={isMobile} centered styles={modalStyles} closeOnClickOutside={false}>
        <Stack align="center" py="xl" gap="md">
          <svg width="48" height="48" viewBox="0 0 24 24" fill="none" stroke="var(--accent-green)" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <path d="M22 11.08V12a10 10 0 1 1-5.93-9.14" />
            <polyline points="22 4 12 14.01 9 11.01" />
          </svg>
          <Text fw={600} size="md" c="var(--text-primary)">
            Restarted {result.restarted} agent{result.restarted !== 1 ? "s" : ""} successfully
          </Text>
          <Text size="xs" c="var(--text-muted)">
            Agents are initializing with fresh sessions...
          </Text>
        </Stack>
      </Modal>
    );
  }

  // Error state
  if (error) {
    return (
      <Modal opened onClose={onCancel} title="Restart All Agents" size="sm" fullScreen={isMobile} centered styles={modalStyles}>
        <Stack align="center" py="xl" gap="md">
          <svg width="48" height="48" viewBox="0 0 24 24" fill="none" stroke="var(--accent-red)" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <circle cx="12" cy="12" r="10" />
            <line x1="15" y1="9" x2="9" y2="15" />
            <line x1="9" y1="9" x2="15" y2="15" />
          </svg>
          <Text fw={600} size="md" c="var(--text-primary)">
            Failed to restart agents
          </Text>
          <Text size="xs" c="var(--text-secondary)" ta="center" maw={360}>
            {error}
          </Text>
          <Group justify="flex-end" w="100%" mt="md">
            <Button variant="default" onClick={onCancel}
              styles={{ root: { backgroundColor: "var(--bg-tertiary)", borderColor: "var(--border-color)", color: "var(--text-primary)", minHeight: 44 } }}
            >
              Close
            </Button>
          </Group>
        </Stack>
      </Modal>
    );
  }

  // Restarting state
  if (restarting) {
    return (
      <Modal opened onClose={() => {}} title="Restart All Agents" size="sm" fullScreen={isMobile} centered styles={modalStyles} closeOnClickOutside={false} withCloseButton={false}>
        <Stack align="center" py="xl" gap="md">
          <Loader size="lg" color="var(--accent-yellow)" />
          <Text fw={600} size="md" c="var(--text-primary)">
            Restarting {agentCount} agent{agentCount !== 1 ? "s" : ""}...
          </Text>
          <Text size="xs" c="var(--text-muted)" ta="center" maw={360}>
            Killing old sessions and spawning fresh agents with the latest MCP and persona configuration.
          </Text>
        </Stack>
      </Modal>
    );
  }

  // Confirmation state
  return (
    <Modal opened onClose={onCancel} title="Restart All Agents" size="md" fullScreen={isMobile} centered styles={modalStyles}>
      <Stack gap="md">
        <Text size="xs" c="var(--text-muted)">
          {agentCount} agent{agentCount !== 1 ? "s" : ""} currently running
        </Text>

        <Alert
          color="yellow"
          variant="light"
          icon={
            <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <path d="M10.29 3.86L1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z" />
              <line x1="12" y1="9" x2="12" y2="13" />
              <line x1="12" y1="17" x2="12.01" y2="17" />
            </svg>
          }
        >
          This action will:
        </Alert>

        <List size="sm" c="var(--text-secondary)" spacing="xs">
          <List.Item>
            Kill all {agentCount} running agent{agentCount !== 1 ? "s" : ""} and their tmux sessions
          </List.Item>
          <List.Item>Spawn fresh sessions with the latest MCP and persona config</List.Item>
          <List.Item>Agents will lose their current conversation context</List.Item>
        </List>

        <Text size="xs" c="var(--accent-green)" fs="italic">
          Git worktrees and file changes made by agents will be preserved.
        </Text>

        <Group justify="flex-end" mt="md">
          <Button ref={cancelRef} variant="default" onClick={onCancel}
            styles={{ root: { backgroundColor: "var(--bg-tertiary)", borderColor: "var(--border-color)", color: "var(--text-primary)", minHeight: 44 } }}
          >
            Cancel
          </Button>
          <Button
            onClick={onConfirm}
            styles={{
              root: {
                backgroundColor: "var(--accent-yellow)",
                color: "#0d1117",
                borderColor: "var(--accent-yellow)",
                fontWeight: 600,
                minHeight: 44,
              },
            }}
          >
            Restart All Agents
          </Button>
        </Group>
      </Stack>
    </Modal>
  );
}
