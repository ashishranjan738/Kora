import { Modal, Button, Group, Text, Stack } from "@mantine/core";

interface ConfirmDialogProps {
  opened: boolean;
  onClose: () => void;
  onConfirm: () => void;
  title: string;
  message: string;
  confirmLabel?: string;
  cancelLabel?: string;
  confirmColor?: string;
  loading?: boolean;
}

export function ConfirmDialog({
  opened,
  onClose,
  onConfirm,
  title,
  message,
  confirmLabel = "Confirm",
  cancelLabel = "Cancel",
  confirmColor = "red",
  loading = false,
}: ConfirmDialogProps) {
  return (
    <Modal
      opened={opened}
      onClose={onClose}
      title={title}
      centered
      size="sm"
      styles={{
        header: {
          backgroundColor: "var(--bg-secondary)",
          borderBottom: "1px solid var(--border-color)",
        },
        body: { backgroundColor: "var(--bg-secondary)" },
        content: { backgroundColor: "var(--bg-secondary)" },
        title: {
          color: "var(--text-primary)",
          fontWeight: 600,
          fontSize: 16,
        },
        close: { color: "var(--text-secondary)" },
      }}
    >
      <Stack gap="md">
        <Text size="sm" c="var(--text-secondary)">
          {message}
        </Text>
        <Group justify="flex-end" gap="sm">
          <Button
            variant="default"
            onClick={onClose}
            disabled={loading}
            styles={{
              root: {
                backgroundColor: "var(--bg-tertiary)",
                borderColor: "var(--border-color)",
                color: "var(--text-primary)",
              },
            }}
          >
            {cancelLabel}
          </Button>
          <Button
            color={confirmColor}
            onClick={onConfirm}
            loading={loading}
          >
            {confirmLabel}
          </Button>
        </Group>
      </Stack>
    </Modal>
  );
}
