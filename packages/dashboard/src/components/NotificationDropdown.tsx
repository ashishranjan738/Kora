import { Menu, Indicator, ActionIcon, Stack, Text, Group, Badge, Button, ScrollArea } from "@mantine/core";
import { useNotifications, type Notification } from "../hooks/useNotifications";
import { useNavigate, useParams } from "react-router-dom";

// Simple SVG icons
const BellIcon = ({ size = 20 }: { size?: number }) => (
  <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
    <path d="M18 8A6 6 0 0 0 6 8c0 7-3 9-3 9h18s-3-2-3-9" />
    <path d="M13.73 21a2 2 0 0 1-3.46 0" />
  </svg>
);

const CheckIcon = ({ size = 14 }: { size?: number }) => (
  <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
    <polyline points="20 6 9 17 4 12" />
  </svg>
);

const TrashIcon = ({ size = 14 }: { size?: number }) => (
  <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
    <polyline points="3 6 5 6 21 6" />
    <path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2" />
  </svg>
);

interface NotificationDropdownProps {
  sessionId?: string;
}

function getNotificationColor(type: string): string {
  switch (type) {
    case "agent-crashed":
      return "red";
    case "agent-idle":
      return "yellow";
    case "task-complete":
      return "green";
    case "pr-ready":
      return "blue";
    case "budget-exceeded":
      return "orange";
    default:
      return "gray";
  }
}

function NotificationItem({ notification, onRead }: { notification: Notification; onRead: () => void }) {
  const navigate = useNavigate();
  const { sessionId } = useParams();

  const handleClick = () => {
    onRead();
    // Navigate to agent if agentId is present
    if (notification.agentId && sessionId) {
      navigate(`/session/${sessionId}/agent/${notification.agentId}`);
    }
  };

  return (
    <Menu.Item
      onClick={handleClick}
      style={{
        backgroundColor: notification.read
          ? "transparent"
          : "var(--bg-tertiary)",
        padding: "12px",
        borderBottom: "1px solid var(--border-color)",
      }}
    >
      <Group gap={8} wrap="nowrap">
        <Badge
          size="xs"
          color={getNotificationColor(notification.type)}
          variant="dot"
          style={{ flexShrink: 0 }}
        />
        <Stack gap={2} style={{ flex: 1, minWidth: 0 }}>
          <Text size="sm" fw={notification.read ? 400 : 600} c="var(--text-primary)" truncate>
            {notification.title}
          </Text>
          <Text size="xs" c="var(--text-muted)" lineClamp={2}>
            {notification.body}
          </Text>
          <Text size="xs" c="var(--text-muted)">
            {new Date(notification.timestamp).toLocaleTimeString()}
          </Text>
        </Stack>
      </Group>
    </Menu.Item>
  );
}

export function NotificationDropdown({ sessionId }: NotificationDropdownProps) {
  const { notifications, unreadCount, markAsRead, markAllAsRead, clearAll } = useNotifications(sessionId);

  return (
    <Menu
      position="bottom-end"
      width={360}
      shadow="md"
      styles={{
        dropdown: {
          backgroundColor: "var(--bg-secondary)",
          borderColor: "var(--border-color)",
          maxHeight: "500px",
        },
      }}
    >
      <Menu.Target>
        <Indicator
          inline
          label={unreadCount > 0 ? (unreadCount >= 10 ? "9+" : unreadCount) : undefined}
          size={16}
          disabled={unreadCount === 0}
          color="red"
        >
          <ActionIcon
            variant="subtle"
            size="lg"
            color="gray"
            aria-label="Notifications"
            styles={{
              root: {
                color: "var(--text-secondary)",
                "&:hover": {
                  backgroundColor: "var(--bg-tertiary)",
                },
              },
            }}
          >
            <BellIcon size={20} />
          </ActionIcon>
        </Indicator>
      </Menu.Target>

      <Menu.Dropdown>
        <Group
          justify="space-between"
          px={12}
          py={8}
          style={{
            borderBottom: "1px solid var(--border-color)",
          }}
        >
          <Text size="sm" fw={600} c="var(--text-primary)">
            Notifications
          </Text>
          {notifications.length > 0 && (
            <Group gap={4}>
              {unreadCount > 0 && (
                <Button
                  size="compact-xs"
                  variant="subtle"
                  leftSection={<CheckIcon size={14} />}
                  onClick={(e) => {
                    e.stopPropagation();
                    markAllAsRead();
                  }}
                  styles={{
                    root: {
                      color: "var(--text-secondary)",
                      fontSize: 11,
                    },
                  }}
                >
                  Mark all read
                </Button>
              )}
              <Button
                size="compact-xs"
                variant="subtle"
                color="red"
                leftSection={<TrashIcon size={14} />}
                onClick={(e) => {
                  e.stopPropagation();
                  clearAll();
                }}
                styles={{
                  root: {
                    fontSize: 11,
                  },
                }}
              >
                Clear
              </Button>
            </Group>
          )}
        </Group>

        {notifications.length === 0 ? (
          <Stack align="center" py={32} px={16}>
            <div style={{ color: "var(--text-muted)", opacity: 0.5 }}>
              <BellIcon size={48} />
            </div>
            <Text size="sm" c="var(--text-muted)">
              No notifications
            </Text>
          </Stack>
        ) : (
          <ScrollArea style={{ maxHeight: "400px" }}>
            {notifications.map((notification) => (
              <NotificationItem
                key={notification.id}
                notification={notification}
                onRead={() => markAsRead(notification.id)}
              />
            ))}
          </ScrollArea>
        )}
      </Menu.Dropdown>
    </Menu>
  );
}
