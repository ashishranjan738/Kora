import { Card, Text, Group, Button, Stack, Badge } from "@mantine/core";
import { useState } from "react";
import type { ApprovalRequest } from "../hooks/useApprovalRequests";

interface ApprovalPromptProps {
  request: ApprovalRequest;
  onApprove: () => Promise<void>;
  onReject: () => Promise<void>;
}

export function ApprovalPrompt({ request, onApprove, onReject }: ApprovalPromptProps) {
  const [loading, setLoading] = useState(false);

  const handleApprove = async () => {
    setLoading(true);
    try {
      await onApprove();
    } catch (err) {
      console.error("Failed to approve:", err);
    } finally {
      setLoading(false);
    }
  };

  const handleReject = async () => {
    setLoading(true);
    try {
      await onReject();
    } catch (err) {
      console.error("Failed to reject:", err);
    } finally {
      setLoading(false);
    }
  };

  return (
    <Card
      withBorder
      padding="sm"
      style={{
        backgroundColor: "var(--bg-tertiary)",
        borderColor: "var(--accent-blue)",
        borderWidth: 2,
      }}
    >
      <Stack gap={8}>
        <Group gap={8} justify="space-between">
          <Badge color="blue" variant="light" size="sm">
            Approval Needed
          </Badge>
          <Text size="xs" c="var(--text-muted)">
            {new Date(request.timestamp).toLocaleTimeString()}
          </Text>
        </Group>

        <Text size="sm" fw={500} c="var(--text-primary)">
          {request.action}
        </Text>

        <Text size="sm" c="var(--text-secondary)">
          {request.description}
        </Text>

        <Group gap={8} mt={4}>
          <Button
            size="compact-sm"
            color="green"
            onClick={handleApprove}
            disabled={loading}
            loading={loading}
            styles={{
              root: {
                flex: 1,
              },
            }}
          >
            Approve
          </Button>
          <Button
            size="compact-sm"
            color="red"
            variant="outline"
            onClick={handleReject}
            disabled={loading}
            styles={{
              root: {
                flex: 1,
              },
            }}
          >
            Reject
          </Button>
        </Group>
      </Stack>
    </Card>
  );
}
