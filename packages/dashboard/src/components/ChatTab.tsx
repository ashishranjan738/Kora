import { useCallback, useEffect, useRef, useState } from "react";
import {
  Stack,
  Group,
  Text,
  TextInput,
  Button,
  Badge,
  ScrollArea,
  UnstyledButton,
  Modal,
  Alert,
  ActionIcon,
  Tooltip,
  Loader,
} from "@mantine/core";
import { useMediaQuery } from "@mantine/hooks";
import { useApi } from "../hooks/useApi";
import { MarkdownText } from "./MarkdownText";

/* ── Types ────────────────────────────────────────────────── */

interface Channel {
  id: string;
  name: string;
  description?: string;
  memberCount?: number;
  isDefault?: boolean;
  unread?: number;
}

interface ChatMessage {
  id: string;
  from: string;
  fromName?: string;
  content: string;
  timestamp: string;
  channel?: string;
  role?: string;
}

interface ChatTabProps {
  sessionId: string;
  wsEvents?: any[];
}

/* ── Helpers ──────────────────────────────────────────────── */

function formatTime(ts: string): string {
  const d = new Date(ts);
  return d.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
}

function getRoleBadgeColor(role?: string): string {
  if (role === "master") return "grape";
  if (role === "worker") return "blue";
  return "gray";
}

function getSenderColor(from: string): string {
  if (from === "user") return "var(--accent-green)";
  return "var(--accent-blue)";
}

/* ── Component ────────────────────────────────────────────── */

export function ChatTab({ sessionId, wsEvents }: ChatTabProps) {
  const api = useApi();
  const isMobile = useMediaQuery("(max-width: 48em)");

  // State
  const [channels, setChannels] = useState<Channel[]>([]);
  const [activeChannel, setActiveChannel] = useState<string>("#all");
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [loadingChannels, setLoadingChannels] = useState(true);
  const [loadingMessages, setLoadingMessages] = useState(false);
  const [input, setInput] = useState("");
  const [sending, setSending] = useState(false);
  const [error, setError] = useState("");
  const [showCreateChannel, setShowCreateChannel] = useState(false);
  const [newChannelName, setNewChannelName] = useState("");
  const [newChannelDesc, setNewChannelDesc] = useState("");
  const [creatingChannel, setCreatingChannel] = useState(false);
  const [showSidebar, setShowSidebar] = useState(!isMobile);
  const [unreadCounts, setUnreadCounts] = useState<Record<string, number>>({});

  const scrollRef = useRef<HTMLDivElement>(null);
  const messagesEndRef = useRef<HTMLDivElement>(null);

  // Load channels on mount
  useEffect(() => {
    fetchChannels();
  }, [sessionId]); // eslint-disable-line react-hooks/exhaustive-deps

  // Load messages when active channel changes
  useEffect(() => {
    if (activeChannel) {
      fetchMessages(activeChannel);
    }
  }, [activeChannel, sessionId]); // eslint-disable-line react-hooks/exhaustive-deps

  // Handle WebSocket channel-message events
  useEffect(() => {
    if (!wsEvents || wsEvents.length === 0) return;
    const latest = wsEvents[wsEvents.length - 1];
    if (latest?.type === "channel-message" && latest?.message) {
      const msg = latest.message as ChatMessage;
      if (msg.channel === activeChannel) {
        setMessages((prev) => [...prev, msg]);
        scrollToBottom();
      } else if (msg.channel) {
        // Increment unread for other channels
        setUnreadCounts((prev) => ({
          ...prev,
          [msg.channel!]: (prev[msg.channel!] || 0) + 1,
        }));
      }
    }
  }, [wsEvents, activeChannel]);

  async function fetchChannels() {
    setLoadingChannels(true);
    try {
      const data: any = await api.getChannels(sessionId);
      setChannels(data.channels || []);
      // Auto-select #all if it exists
      if (!data.channels?.find((c: Channel) => c.id === activeChannel)) {
        setActiveChannel(data.channels?.[0]?.id || "#all");
      }
    } catch {
      // Endpoint may not exist yet — show default #all
      setChannels([{ id: "#all", name: "All", isDefault: true }]);
    } finally {
      setLoadingChannels(false);
    }
  }

  async function fetchMessages(channelId: string) {
    setLoadingMessages(true);
    setError("");
    try {
      const data: any = await api.getChannelMessages(sessionId, channelId, 50);
      setMessages(data.messages || []);
      // Clear unread for this channel
      setUnreadCounts((prev) => ({ ...prev, [channelId]: 0 }));
      setTimeout(scrollToBottom, 50);
    } catch {
      setMessages([]);
    } finally {
      setLoadingMessages(false);
    }
  }

  function scrollToBottom() {
    messagesEndRef.current?.scrollIntoView({ behavior: "smooth" });
  }

  async function handleSend() {
    if (!input.trim() || sending) return;
    const content = input.trim();
    setInput("");
    setSending(true);

    // Optimistic update
    const optimisticMsg: ChatMessage = {
      id: `temp-${Date.now()}`,
      from: "user",
      fromName: "You",
      content,
      timestamp: new Date().toISOString(),
      channel: activeChannel,
    };
    setMessages((prev) => [...prev, optimisticMsg]);
    setTimeout(scrollToBottom, 50);

    try {
      await api.relayMessage(sessionId, "user", `channel:${activeChannel}`, content);
    } catch (err: any) {
      setError(err.message || "Failed to send message");
      // Remove optimistic message on failure
      setMessages((prev) => prev.filter((m) => m.id !== optimisticMsg.id));
    } finally {
      setSending(false);
    }
  }

  function handleKeyDown(e: React.KeyboardEvent) {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      handleSend();
    }
  }

  function handleSelectChannel(channelId: string) {
    setActiveChannel(channelId);
    setUnreadCounts((prev) => ({ ...prev, [channelId]: 0 }));
    if (isMobile) setShowSidebar(false);
  }

  async function handleCreateChannel() {
    if (!newChannelName.trim()) return;
    setCreatingChannel(true);
    try {
      const channelId = `#${newChannelName.trim().toLowerCase().replace(/[^a-z0-9-]/g, "-")}`;
      await api.createChannel(sessionId, { id: channelId, name: newChannelName.trim(), description: newChannelDesc.trim() });
      setShowCreateChannel(false);
      setNewChannelName("");
      setNewChannelDesc("");
      await fetchChannels();
      setActiveChannel(channelId);
    } catch (err: any) {
      setError(err.message || "Failed to create channel");
    } finally {
      setCreatingChannel(false);
    }
  }

  async function handleDeleteChannel(channelId: string) {
    try {
      await api.deleteChannel(sessionId, channelId);
      await fetchChannels();
      if (activeChannel === channelId) setActiveChannel("#all");
    } catch {
      // silently fail
    }
  }

  const activeChannelObj = channels.find((c) => c.id === activeChannel);

  return (
    <div className="chat-tab-container">
      {/* ── Channel Sidebar ── */}
      {(showSidebar || !isMobile) && (
        <div className="chat-sidebar">
          <div className="chat-sidebar-header">
            <Text size="sm" fw={600} c="var(--text-primary)">Channels</Text>
            <Tooltip label="New channel" position="right">
              <ActionIcon variant="subtle" size="xs" onClick={() => setShowCreateChannel(true)} style={{ color: "var(--accent-blue)" }}>
                <span style={{ fontSize: 16, fontWeight: 700 }}>+</span>
              </ActionIcon>
            </Tooltip>
          </div>

          <ScrollArea style={{ flex: 1 }}>
            <Stack gap={2} px={8} py={4}>
              {loadingChannels ? (
                <Text size="xs" c="dimmed" ta="center" py="md">Loading...</Text>
              ) : (
                channels.map((ch) => (
                  <UnstyledButton
                    key={ch.id}
                    onClick={() => handleSelectChannel(ch.id)}
                    className={`chat-channel-item ${activeChannel === ch.id ? "active" : ""}`}
                  >
                    <Text size="sm" fw={activeChannel === ch.id ? 600 : 400} c={activeChannel === ch.id ? "var(--text-primary)" : "var(--text-secondary)"} style={{ flex: 1 }}>
                      {ch.id}
                    </Text>
                    {(unreadCounts[ch.id] || 0) > 0 && (
                      <Badge size="xs" variant="filled" color="blue" circle>
                        {unreadCounts[ch.id]}
                      </Badge>
                    )}
                  </UnstyledButton>
                ))
              )}
            </Stack>
          </ScrollArea>
        </div>
      )}

      {/* ── Message Pane ── */}
      <div className="chat-message-pane">
        {/* Channel header */}
        <div className="chat-pane-header">
          {isMobile && (
            <ActionIcon variant="subtle" size="sm" onClick={() => setShowSidebar(!showSidebar)} style={{ color: "var(--text-secondary)", marginRight: 8 }}>
              <span style={{ fontSize: 16 }}>&#9776;</span>
            </ActionIcon>
          )}
          <Text size="sm" fw={600} c="var(--text-primary)" style={{ flex: 1 }}>
            {activeChannelObj?.name || activeChannel}
          </Text>
          {activeChannelObj?.memberCount !== undefined && (
            <Text size="xs" c="var(--text-muted)">{activeChannelObj.memberCount} members</Text>
          )}
        </div>

        {error && (
          <Alert color="red" variant="light" radius={0} styles={{ root: { padding: "6px 12px" } }} withCloseButton onClose={() => setError("")}>
            {error}
          </Alert>
        )}

        {/* Messages */}
        <ScrollArea style={{ flex: 1 }} viewportRef={scrollRef} offsetScrollbars>
          {loadingMessages ? (
            <Stack align="center" justify="center" py="xl">
              <Loader size="sm" color="var(--accent-blue)" />
            </Stack>
          ) : messages.length === 0 ? (
            <Stack align="center" justify="center" py="xl">
              <Text size="sm" c="var(--text-muted)">No messages yet. Start the conversation!</Text>
            </Stack>
          ) : (
            <Stack gap={0} px="md" py="sm">
              {messages.map((msg) => {
                const isUser = msg.from === "user";
                return (
                  <div key={msg.id} className={`chat-message ${isUser ? "chat-message-user" : ""}`}>
                    <Group gap={6} mb={2}>
                      <Text size="xs" fw={600} c={getSenderColor(msg.from)}>
                        {isUser ? "You" : msg.fromName || msg.from}
                      </Text>
                      {!isUser && msg.role && (
                        <Badge size="xs" variant="light" color={getRoleBadgeColor(msg.role)}>
                          {msg.role}
                        </Badge>
                      )}
                      <Text size="xs" c="var(--text-muted)">{formatTime(msg.timestamp)}</Text>
                    </Group>
                    <div className="chat-message-content">
                      <MarkdownText>{msg.content}</MarkdownText>
                    </div>
                  </div>
                );
              })}
              <div ref={messagesEndRef} />
            </Stack>
          )}
        </ScrollArea>

        {/* Input box */}
        <div className="chat-input-bar">
          <TextInput
            value={input}
            onChange={(e) => setInput(e.currentTarget.value)}
            onKeyDown={handleKeyDown}
            placeholder={`Message ${activeChannelObj?.name || activeChannel}...`}
            disabled={sending}
            style={{ flex: 1 }}
            styles={{
              input: { backgroundColor: "var(--bg-primary)", borderColor: "var(--border-color)", color: "var(--text-primary)", borderRadius: 8, fontSize: 13 },
            }}
          />
          <Button
            onClick={handleSend}
            disabled={!input.trim() || sending}
            loading={sending}
            size="sm"
            styles={{ root: { backgroundColor: "var(--accent-blue)", borderRadius: 8, paddingInline: 16 } }}
          >
            Send
          </Button>
        </div>
      </div>

      {/* ── Create Channel Modal ── */}
      <Modal
        opened={showCreateChannel}
        onClose={() => setShowCreateChannel(false)}
        title="New Channel"
        centered
        size="sm"
        styles={{
          header: { backgroundColor: "var(--bg-secondary)", borderBottom: "1px solid var(--border-color)" },
          body: { backgroundColor: "var(--bg-secondary)" },
          content: { backgroundColor: "var(--bg-secondary)" },
          title: { color: "var(--text-primary)", fontWeight: 600 },
          close: { color: "var(--text-secondary)" },
        }}
      >
        <Stack gap="sm">
          <TextInput
            label="Channel Name"
            value={newChannelName}
            onChange={(e) => setNewChannelName(e.currentTarget.value)}
            placeholder="e.g. frontend"
            description="Will be prefixed with #"
            autoFocus
            styles={{
              input: { backgroundColor: "var(--bg-primary)", borderColor: "var(--border-color)", color: "var(--text-primary)" },
              label: { color: "var(--text-primary)" },
              description: { color: "var(--text-muted)" },
            }}
          />
          <TextInput
            label="Description (optional)"
            value={newChannelDesc}
            onChange={(e) => setNewChannelDesc(e.currentTarget.value)}
            placeholder="What's this channel for?"
            styles={{
              input: { backgroundColor: "var(--bg-primary)", borderColor: "var(--border-color)", color: "var(--text-primary)" },
              label: { color: "var(--text-primary)" },
            }}
          />
          <Group justify="flex-end" mt="sm">
            <Button variant="default" onClick={() => setShowCreateChannel(false)} styles={{ root: { backgroundColor: "var(--bg-tertiary)", borderColor: "var(--border-color)", color: "var(--text-primary)" } }}>
              Cancel
            </Button>
            <Button onClick={handleCreateChannel} loading={creatingChannel} disabled={!newChannelName.trim()} styles={{ root: { backgroundColor: "var(--accent-blue)" } }}>
              Create
            </Button>
          </Group>
        </Stack>
      </Modal>
    </div>
  );
}
