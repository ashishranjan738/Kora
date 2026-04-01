import { Link, useNavigate, useLocation } from "react-router-dom";
import { useSessionStore } from "../stores/sessionStore";
import { useThemeStore } from "../stores/themeStore";
import { useEffect, useCallback } from "react";
import { useWebSocket } from "../hooks/useWebSocket";
import {
  Group,
  Burger,
  Drawer,
  Stack,
  Select,
  ActionIcon,
  Text,
  Box,
} from "@mantine/core";
import { useDisclosure, useMediaQuery } from "@mantine/hooks";
import { NotificationDropdown } from "./NotificationDropdown";

export function Navbar() {
  const { sessions, fetchSessions } = useSessionStore();
  const { resolved, setMode, mode } = useThemeStore();
  const navigate = useNavigate();
  const location = useLocation();
  const [drawerOpened, { toggle: toggleDrawer, close: closeDrawer }] =
    useDisclosure(false);
  const isMobile = useMediaQuery("(max-width: 48em)");

  // Derive selected session from URL path
  const pathMatch = location.pathname.match(/^\/session\/([^/]+)/);
  const selectedSession = pathMatch ? pathMatch[1] : "";

  const handleWsEvent = useCallback(
    (event: any) => {
      if (
        event.type === "session_created" ||
        event.type === "session_removed"
      ) {
        fetchSessions();
      }
    },
    [fetchSessions]
  );

  const { connected } = useWebSocket(handleWsEvent);

  useEffect(() => {
    fetchSessions();
  }, [fetchSessions]);

  function onSessionChange(val: string | null) {
    if (val) {
      navigate(`/session/${val}`);
    } else {
      navigate("/");
    }
    closeDrawer();
  }

  function cycleTheme() {
    const next =
      mode === "system" ? "dark" : mode === "dark" ? "light" : "system";
    setMode(next);
  }

  const sessionSelectData = sessions.map((s) => ({
    value: s.id,
    label: s.name || s.id,
  }));

  // Connection status indicator
  const connectionStatus = (
    <Group gap={6}>
      <span className={`status-dot ${connected ? "green" : "red"}`} />
      <Text size="xs" c="var(--text-secondary)">
        {connected ? "Connected" : "Disconnected"}
      </Text>
    </Group>
  );

  // Theme toggle button
  const themeToggle = (
    <ActionIcon
      variant="default"
      onClick={cycleTheme}
      title={`Theme: ${mode} (${resolved})`}
      aria-label="Toggle theme"
      size="lg"
      style={{
        border: "1px solid var(--border-color)",
        backgroundColor: "var(--bg-tertiary)",
        color: "var(--text-secondary)",
      }}
    >
      {resolved === "dark" ? "\u263E" : "\u2600"}
    </ActionIcon>
  );

  // Session selector
  const sessionSelector = (
    <Select
      placeholder="Select session..."
      data={sessionSelectData}
      value={selectedSession || null}
      onChange={onSessionChange}
      clearable
      searchable
      size={isMobile ? "md" : "sm"}
      style={{ minWidth: isMobile ? "100%" : 200 }}
      styles={{
        input: {
          backgroundColor: "var(--bg-tertiary)",
          borderColor: "var(--border-color)",
          color: "var(--text-primary)",
        },
        dropdown: {
          backgroundColor: "var(--bg-secondary)",
          borderColor: "var(--border-color)",
        },
        option: {
          color: "var(--text-primary)",
        },
      }}
    />
  );

  // Knowledge link
  const knowledgeLink = (
    <Link
      to="/knowledge"
      onClick={closeDrawer}
      style={{ color: "var(--accent-blue)", textDecoration: "none" }}
    >
      Knowledge
    </Link>
  );

  // Settings link
  const settingsLink = (
    <Link
      to="/settings"
      onClick={closeDrawer}
      style={{ color: "var(--accent-blue)", textDecoration: "none" }}
    >
      Settings
    </Link>
  );

  return (
    <>
      <nav
        style={{
          display: "flex",
          alignItems: "center",
          justifyContent: "space-between",
          padding: isMobile ? "10px 12px" : "12px 24px",
          backgroundColor: "var(--bg-secondary)",
          borderBottom: "1px solid var(--border-color)",
          minHeight: 52,
        }}
      >
        {/* Left side: Logo + session selector (desktop) */}
        <Group gap={isMobile ? 8 : 16} align="center">
          <Link
            to="/"
            style={{
              fontSize: 18,
              fontWeight: 600,
              color: "var(--text-primary)",
              textDecoration: "none",
            }}
          >
            Kora
          </Link>

          {!isMobile && sessionSelector}
        </Group>

        {/* Right side: desktop nav items or mobile burger */}
        {isMobile ? (
          <Group gap={8} align="center">
            {/* Show connection dot on mobile too */}
            <span
              className={`status-dot ${connected ? "green" : "red"}`}
            />
            {themeToggle}
            <Burger
              opened={drawerOpened}
              onClick={toggleDrawer}
              size="sm"
              color="var(--text-primary)"
            />
          </Group>
        ) : (
          <Group gap={16} align="center">
            {connectionStatus}
            <NotificationDropdown sessionId={selectedSession || undefined} />
            {themeToggle}
            {knowledgeLink}
            {settingsLink}
          </Group>
        )}
      </nav>

      {/* Mobile drawer */}
      <Drawer
        opened={drawerOpened}
        onClose={closeDrawer}
        title="Kora"
        position="right"
        size="280"
        padding="md"
        styles={{
          header: {
            backgroundColor: "var(--bg-secondary)",
            borderBottom: "1px solid var(--border-color)",
          },
          body: {
            backgroundColor: "var(--bg-primary)",
          },
          content: {
            backgroundColor: "var(--bg-primary)",
          },
          title: {
            color: "var(--text-primary)",
            fontWeight: 600,
          },
          close: {
            color: "var(--text-secondary)",
          },
        }}
      >
        <Stack gap="md">
          <Box>
            <Text size="xs" c="var(--text-muted)" mb={4}>
              Session
            </Text>
            {sessionSelector}
          </Box>

          <Box>
            <Text size="xs" c="var(--text-muted)" mb={4}>
              Status
            </Text>
            {connectionStatus}
          </Box>

          <Box>
            <Text size="xs" c="var(--text-muted)" mb={4}>
              Notifications
            </Text>
            <NotificationDropdown sessionId={selectedSession || undefined} />
          </Box>

          <Box>
            <Text size="xs" c="var(--text-muted)" mb={4}>
              Theme
            </Text>
            <Group gap={8}>
              {themeToggle}
              <Text size="sm" c="var(--text-secondary)">
                {mode === "system"
                  ? "System"
                  : mode === "dark"
                    ? "Dark"
                    : "Light"}
              </Text>
            </Group>
          </Box>

          <Box pt="sm" style={{ borderTop: "1px solid var(--border-color)" }}>
            <Stack gap="sm">
              {knowledgeLink}
              {settingsLink}
            </Stack>
          </Box>
        </Stack>
      </Drawer>
    </>
  );
}
