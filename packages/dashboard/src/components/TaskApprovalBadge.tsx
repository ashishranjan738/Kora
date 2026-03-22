import { useState } from "react";
import { Badge, Button, Group, Tooltip, Alert, Text } from "@mantine/core";
import { useApi } from "../hooks/useApi";
import { showSuccess, showError } from "../utils/notifications";

// ---------- Task Approval Badge (for task cards) ----------

interface TaskApprovalBadgeProps {
  taskId: string;
  sessionId: string;
  pendingApproval?: boolean;
  approvalStatus?: "pending" | "approved" | "rejected";
}

export function TaskApprovalBadge({ pendingApproval, approvalStatus }: TaskApprovalBadgeProps) {
  if (!pendingApproval && approvalStatus !== "pending") return null;

  return (
    <Tooltip label="This task requires approval before proceeding">
      <Badge
        size="xs"
        color="blue"
        variant="light"
        leftSection={<span style={{ fontSize: 10 }}>{"\u{1F512}"}</span>}
      >
        Needs Approval
      </Badge>
    </Tooltip>
  );
}

// ---------- Task Approval Actions (for task detail modal) ----------

interface TaskApprovalActionsProps {
  taskId: string;
  sessionId: string;
  agentId?: string;
  taskTitle: string;
  onApproved?: () => void;
  onRejected?: () => void;
}

export function TaskApprovalActions({
  taskId,
  sessionId,
  agentId,
  taskTitle,
  onApproved,
  onRejected,
}: TaskApprovalActionsProps) {
  const api = useApi();
  const [loading, setLoading] = useState(false);

  const handleApprove = async () => {
    if (!agentId) return;
    setLoading(true);
    try {
      await api.approveRequest(sessionId, agentId, taskId);
      showSuccess(`Approved: ${taskTitle}`);
      onApproved?.();
    } catch (err: any) {
      showError(err.message, "Failed to approve");
    } finally {
      setLoading(false);
    }
  };

  const handleReject = async () => {
    if (!agentId) return;
    setLoading(true);
    try {
      await api.rejectRequest(sessionId, agentId, taskId);
      showSuccess(`Rejected: ${taskTitle}`);
      onRejected?.();
    } catch (err: any) {
      showError(err.message, "Failed to reject");
    } finally {
      setLoading(false);
    }
  };

  return (
    <Alert color="blue" variant="light" title="Approval Required" mb="sm">
      <Text size="sm" mb="xs">This task requires your approval before the agent can proceed.</Text>
      <Group gap="sm">
        <Button size="xs" color="green" onClick={handleApprove} loading={loading}>
          Approve
        </Button>
        <Button size="xs" color="red" variant="outline" onClick={handleReject} loading={loading}>
          Reject
        </Button>
      </Group>
    </Alert>
  );
}

// ---------- Approval Notification Banner ----------

interface ApprovalNotificationBannerProps {
  pendingCount: number;
  onClick?: () => void;
}

export function ApprovalNotificationBanner({ pendingCount, onClick }: ApprovalNotificationBannerProps) {
  if (pendingCount === 0) return null;

  return (
    <div
      onClick={onClick}
      style={{
        padding: "6px 12px",
        background: "rgba(59, 130, 246, 0.1)",
        borderBottom: "1px solid var(--accent-blue)",
        display: "flex",
        alignItems: "center",
        gap: 8,
        cursor: onClick ? "pointer" : "default",
      }}
    >
      <Badge color="blue" variant="filled" size="sm">
        {pendingCount} pending
      </Badge>
      <Text size="xs" c="var(--accent-blue)">
        {pendingCount} approval{pendingCount !== 1 ? "s" : ""} waiting for your review
      </Text>
    </div>
  );
}
