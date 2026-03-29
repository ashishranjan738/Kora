/**
 * SidebarChat — collapsible right panel for chatting with agents.
 * Sends via relay API, receives via WebSocket, persists to #sidebar channel.
 */
import { useCallback, useEffect, useRef, useState } from "react";
import {
  ActionIcon,
  Badge,
  ScrollArea,
  Select,
  Text,
  TextInput,
  Tooltip,
} from "@mantine/core";
import { useApi } from "../hooks/useApi";
import { MarkdownText } from "./MarkdownText";

/* ── Types ────────────────────────────────────────────── */

interface Agent {
  id: string;
  name: string;
  role?: string;
  status?: string;
}

interface ChatMessage {
  id: string;
  from: string;
  fromName?: string;
  content: string;
  timestamp: string;
  channel?: string;
}

interface SidebarChatProps {
  sessionId: string;
  agents: Agent[];
  wsEvents?: any[];
}

const SIDEBAR_CHANNEL = "#sidebar";
const STORAGE_KEY = "kora-sidebar-expanded";

/* ── Helpers ──────────────────────────────────────────── */

function formatTime(ts: string): string {
  const d = new Date(ts);
  return d.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
}

/* ── Component ────────────────────────────────────────── */

export function SidebarChat({ sessionId, agents, wsEvents }: SidebarChatProps) {
  const api = useApi();

  // Expand/collapse persisted to localStorage
  const [expanded, setExpanded] = useState(() => {
    try { return localStorage.getItem(STORAGE_KEY) !== "false"; } catch { return true; }
  });
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [input, setInput] = useState("");
  const [sending, setSending] = useState(false);
  const [selectedAgentId, setSelectedAgentId] = useState<string | null>(null);
  const [loadingHistory, setLoadingHistory] = useState(false);

  const messagesEndRef = useRef<HTMLDivElement>(null);
  const scrollRef = useRef<HTMLDivElement>(null);

  // Find master agent as default target
  const masterAgent = agents.find((a) => a.role === "master" && a.status === "running");
  const targetAgentId = selectedAgentId || masterAgent?.id || agents.find((a) => a.status === "running")?.id;
  const targetAgent = agents.find((a) => a.id === targetAgentId);

  // Persist expand/collapse
  useEffect(() => {
    try { localStorage.setItem(STORAGE_KEY, String(expanded)); } catch { /* ignore */ }
  }, [expanded]);

  // Load chat history from #sidebar channel
  useEffect(() => {
    if (!sessionId || !expanded) return;
    let cancelled = false;
    async function loadHistory() {
      setLoadingHistory(true);
      try {
        const data: any = await api.getChannelMessages(sessionId, SIDEBAR_CHANNEL, 100);
        if (!cancelled) {
          setMessages(data.messages || []);
          setTimeout(scrollToBottom, 50);
        }
      } catch {
        // Channel may not exist yet — that's fine
      } finally {
        if (!cancelled) setLoadingHistory(false);
      }
    }
    loadHistory();
    return () => { cancelled = true; };
  }, [sessionId, expanded]); // eslint-disable-line react-hooks/exhaustive-deps

  // Handle WebSocket events for real-time responses
  useEffect(() => {
    if (!wsEvents || wsEvents.length === 0) return;
    const latest = wsEvents[wsEvents.length - 1];
    if (latest?.type === "channel-message" && latest?.message) {
      const msg = latest.message as ChatMessage;
      if (msg.channel === SIDEBAR_CHANNEL) {
        setMessages((prev) => {
          // Deduplicate by id
          if (prev.some((m) => m.id === msg.id)) return prev;
          return [...prev, msg];
        });
        scrollToBottom();
      }
    }
  }, [wsEvents]);

  const scrollToBottom = useCallback(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: "smooth" });
  }, []);

  async function handleSend() {
    if (!input.trim() || sending || !targetAgentId) return;
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
      channel: SIDEBAR_CHANNEL,
    };
    setMessages((prev) => [...prev, optimisticMsg]);
    setTimeout(scrollToBottom, 50);

    try {
      await api.relayMessage(sessionId, "user", targetAgentId, content, SIDEBAR_CHANNEL);
    } catch {
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

  const agentOptions = agents
    .filter((a) => a.status === "running")
    .map((a) => ({
      value: a.id,
      label: `${a.name}${a.role === "master" ? " (master)" : ""}`,
    }));

  // Collapsed state — just show toggle button
  if (!expanded) {
    return (
      <div style={{
        position: "fixed", right: 0, top: "50%", transform: "translateY(-50%)",
        zIndex: 50,
      }}>
        <Tooltip label="Open chat" position="left">
          <ActionIcon
            onClick={() => setExpanded(true)}
            variant="filled"
            size="lg"
            style={{
              backgroundColor: "var(--accent-blue)",
              borderRadius: "8px 0 0 8px",
              width: 36, height: 48,
            }}
          >
            <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="white" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <path d="M21 15a2 2 0 01-2 2H7l-4 4V5a2 2 0 012-2h14a2 2 0 012 2z" />
            </svg>
          </ActionIcon>
        </Tooltip>
      </div>
    );
  }

  return (
    <div className="sidebar-chat" style={{
      width: 320, height: "100%", display: "flex", flexDirection: "column",
      borderLeft: "1px solid var(--border-color)", background: "var(--bg-secondary)",
      flexShrink: 0,
    }}>
      {/* Header */}
      <div style={{
        padding: "10px 12px", borderBottom: "1px solid var(--border-color)",
        display: "flex", alignItems: "center", gap: 8,
      }}>
        <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="var(--accent-blue)" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
          <path d="M21 15a2 2 0 01-2 2H7l-4 4V5a2 2 0 012-2h14a2 2 0 012 2z" />
        </svg>
        <Text size="sm" fw={600} c="var(--text-primary)" style={{ flex: 1 }}>
          Chat
        </Text>
        {targetAgent && (
          <Badge
            size="xs"
            variant="dot"
            color={targetAgent.status === "running" ? "green" : "gray"}
          >
            {targetAgent.name}
          </Badge>
        )}
        <Tooltip label="Collapse">
          <ActionIcon
            variant="subtle"
            size="sm"
            onClick={() => setExpanded(false)}
            style={{ color: "var(--text-muted)" }}
          >
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <polyline points="9 18 15 12 9 6" />
            </svg>
          </ActionIcon>
        </Tooltip>
      </div>

      {/* Agent selector */}
      <div style={{ padding: "6px 12px", borderBottom: "1px solid var(--border-color)" }}>
        <Select
          size="xs"
          placeholder="Select agent..."
          data={agentOptions}
          value={targetAgentId || null}
          onChange={(v) => setSelectedAgentId(v)}
          styles={{
            input: { background: "var(--bg-primary)", borderColor: "var(--border-color)", color: "var(--text-primary)", fontSize: 11 },
            dropdown: { backgroundColor: "var(--bg-secondary)", borderColor: "var(--border-color)" },
            option: { color: "var(--text-primary)", fontSize: 11 },
          }}
        />
      </div>

      {/* Messages */}
      <ScrollArea style={{ flex: 1 }} viewportRef={scrollRef} offsetScrollbars>
        {loadingHistory ? (
          <Text size="xs" c="dimmed" ta="center" py="xl">Loading...</Text>
        ) : messages.length === 0 ? (
          <Text size="xs" c="dimmed" ta="center" py="xl" px="md">
            Send a message to start chatting with {targetAgent?.name || "an agent"}.
          </Text>
        ) : (
          <div style={{ padding: "8px 12px", display: "flex", flexDirection: "column", gap: 8 }}>
            {messages.map((msg) => {
              const isUser = msg.from === "user";
              return (
                <div
                  key={msg.id}
                  style={{
                    display: "flex", flexDirection: "column",
                    alignItems: isUser ? "flex-end" : "flex-start",
                  }}
                >
                  <div style={{
                    maxWidth: "85%", padding: "6px 10px", borderRadius: 8,
                    background: isUser ? "var(--accent-blue)" : "var(--bg-tertiary)",
                    color: isUser ? "white" : "var(--text-primary)",
                    fontSize: 12, lineHeight: 1.5,
                  }}>
                    {isUser ? (
                      <span>{msg.content}</span>
                    ) : (
                      <MarkdownText>{msg.content}</MarkdownText>
                    )}
                  </div>
                  <div style={{ display: "flex", gap: 4, alignItems: "center", marginTop: 2 }}>
                    <Text size="xs" c="var(--text-muted)" style={{ fontSize: 10 }}>
                      {isUser ? "You" : msg.fromName || msg.from}
                    </Text>
                    <Text size="xs" c="var(--text-muted)" style={{ fontSize: 10 }}>
                      {formatTime(msg.timestamp)}
                    </Text>
                  </div>
                </div>
              );
            })}
            <div ref={messagesEndRef} />
          </div>
        )}
      </ScrollArea>

      {/* Input */}
      <div style={{
        padding: "8px 12px", borderTop: "1px solid var(--border-color)",
        display: "flex", gap: 8, alignItems: "center",
      }}>
        <TextInput
          value={input}
          onChange={(e) => setInput(e.currentTarget.value)}
          onKeyDown={handleKeyDown}
          placeholder={`Message ${targetAgent?.name || "agent"}...`}
          disabled={sending || !targetAgentId}
          style={{ flex: 1 }}
          size="xs"
          styles={{
            input: {
              backgroundColor: "var(--bg-primary)", borderColor: "var(--border-color)",
              color: "var(--text-primary)", borderRadius: 6, fontSize: 12,
            },
          }}
        />
        <ActionIcon
          onClick={handleSend}
          disabled={!input.trim() || sending || !targetAgentId}
          loading={sending}
          variant="filled"
          size="sm"
          style={{ backgroundColor: "var(--accent-blue)", borderRadius: 6 }}
        >
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="white" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <line x1="22" y1="2" x2="11" y2="13" /><polygon points="22 2 15 22 11 13 2 9 22 2" />
          </svg>
        </ActionIcon>
      </div>
    </div>
  );
}
