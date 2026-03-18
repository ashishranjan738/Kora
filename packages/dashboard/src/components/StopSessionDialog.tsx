import React, { useEffect, useRef } from "react";
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

export interface StopSessionDialogProps {
  session: {
    id: string;
    name: string;
    agentCount?: number;
    activeAgentCount?: number;
  };
  onCancel: () => void;
  onConfirm: () => void;
  stopping: boolean;
  success: boolean;
}

export function StopSessionDialog({
  session,
  onCancel,
  onConfirm,
  stopping,
  success,
}: StopSessionDialogProps) {
  const cancelRef = useRef<HTMLButtonElement>(null);
  const isMobile = useMediaQuery("(max-width: 48em)");

  useEffect(() => {
    if (!stopping && !success && cancelRef.current) {
      cancelRef.current.focus();
    }
  }, [stopping, success]);

  const agentCount =
    typeof session.activeAgentCount === "number"
      ? session.activeAgentCount
      : session.agentCount ?? 0;

  const sessionName = session.name || "Unnamed Session";

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
  if (success) {
    return (
      <Modal opened onClose={() => {}} title="Stop Session" size="sm" fullScreen={isMobile} centered styles={modalStyles} closeOnClickOutside={false} withCloseButton={false}>
        <Stack align="center" py="xl" gap="md">
          <svg width="48" height="48" viewBox="0 0 24 24" fill="none" stroke="var(--accent-green)" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <path d="M22 11.08V12a10 10 0 11-5.93-9.14" />
            <polyline points="22 4 12 14.01 9 11.01" />
          </svg>
          <Text fw={600} size="md">Session stopped successfully</Text>
          <Text size="xs" c="var(--text-muted)">Redirecting...</Text>
        </Stack>
      </Modal>
    );
  }

  // Stopping state
  if (stopping) {
    return (
      <Modal opened onClose={() => {}} title="Stop Session" size="sm" fullScreen={isMobile} centered styles={modalStyles} closeOnClickOutside={false} withCloseButton={false}>
        <Stack align="center" py="xl" gap="md">
          <Loader size="lg" color="var(--accent-red)" />
          <Text fw={600} size="md">
            Stopping session &ldquo;{sessionName}&rdquo;...
          </Text>
          <Text size="xs" c="var(--text-muted)">
            Killing {agentCount} agent{agentCount !== 1 ? "s" : ""} and cleaning up...
          </Text>
        </Stack>
      </Modal>
    );
  }

  // Confirmation state
  return (
    <Modal opened onClose={onCancel} title={`Stop Session: \u201C${sessionName}\u201D`} size="md" fullScreen={isMobile} centered styles={modalStyles}>
      <Stack gap="md">
        <Alert
          color="red"
          variant="light"
          icon={<span style={{ fontSize: 18, lineHeight: 1 }}>&#9888;</span>}
        >
          This will:
        </Alert>

        <List size="sm" c="var(--text-secondary)" spacing="xs">
          <List.Item>
            Kill{" "}
            {agentCount > 0
              ? `all ${agentCount} running agent${agentCount !== 1 ? "s" : ""}`
              : "all running agents"}
          </List.Item>
          <List.Item>Terminate their tmux sessions</List.Item>
          <List.Item>Remove the session from the registry</List.Item>
        </List>

        <Text size="xs" c="var(--accent-green)" fs="italic">
          Agent data and event history will be preserved in the project directory.
        </Text>

        <Group justify="flex-end" mt="md">
          <Button ref={cancelRef} variant="default" onClick={onCancel}
            styles={{ root: { backgroundColor: "var(--bg-tertiary)", borderColor: "var(--border-color)", color: "var(--text-primary)", minHeight: 44 } }}
          >
            Cancel
          </Button>
          <Button color="red" onClick={onConfirm}
            styles={{ root: { minHeight: 44, fontWeight: 600 } }}
          >
            Stop Session
          </Button>
        </Group>
      </Stack>
    </Modal>
  );
}
