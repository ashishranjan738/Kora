import { Stack, Text, Card, Group, Badge } from "@mantine/core";
import type { ApprovalRequest } from "../hooks/useApprovalRequests";

interface ApprovalHistoryProps {
  requests: ApprovalRequest[];
}

function getStatusColor(status: ApprovalRequest["status"]): string {
  switch (status) {
    case "approved":
      return "green";
    case "rejected":
      return "red";
    case "pending":
      return "blue";
    default:
      return "gray";
  }
}

export function ApprovalHistory({ requests }: ApprovalHistoryProps) {
  if (requests.length === 0) {
    return (
      <Card
        withBorder
        padding="md"
        style={{
          backgroundColor: "var(--bg-tertiary)",
          borderColor: "var(--border-color)",
        }}
      >
        <Text size="sm" c="var(--text-muted)" ta="center">
          No approval requests yet
        </Text>
      </Card>
    );
  }

  return (
    <Stack gap={8}>
      {requests.map((request) => (
        <Card
          key={request.id}
          withBorder
          padding="sm"
          style={{
            backgroundColor: "var(--bg-tertiary)",
            borderColor: "var(--border-color)",
          }}
        >
          <Stack gap={6}>
            <Group gap={8} justify="space-between">
              <Badge
                color={getStatusColor(request.status)}
                variant="light"
                size="sm"
              >
                {request.status}
              </Badge>
              <Text size="xs" c="var(--text-muted)">
                {new Date(request.timestamp).toLocaleString()}
              </Text>
            </Group>

            <Text size="sm" fw={500} c="var(--text-primary)">
              {request.action}
            </Text>

            <Text size="xs" c="var(--text-secondary)">
              {request.description}
            </Text>
          </Stack>
        </Card>
      ))}
    </Stack>
  );
}
