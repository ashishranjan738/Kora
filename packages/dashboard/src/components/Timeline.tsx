import { useEffect, useState, useCallback, useRef } from "react";
import { useApi } from "../hooks/useApi";
import { useWebSocket } from "../hooks/useWebSocket";
import {
  Select,
  MultiSelect,
  TextInput,
  Text,
  Badge,
  Stack,
  Group,
  Box,
  Loader,
} from "@mantine/core";
import { useDebouncedValue, useMediaQuery } from "@mantine/hooks";
import { Virtuoso, VirtuosoHandle } from "react-virtuoso";

interface TimelineProps {
  sessionId: string;
}

interface TimelineEvent {
  id: string;
  type: string;
  description: string;
  timestamp: string;
  data?: Record<string, unknown>;
  agent_id?: string;
  [key: string]: unknown;
}

type EventFilter = "all" | "agents" | "messages" | "session";

const EVENT_STYLES: Record<
  string,
  { color: string; label: string; icon: string }
> = {
  "agent-spawned": { color: "green", label: "Spawned", icon: "+" },
  "agent-removed": { color: "gray", label: "Removed", icon: "-" },
  "agent-crashed": { color: "red", label: "Crashed", icon: "!" },
  "agent-restarted": { color: "yellow", label: "Restarted", icon: "~" },
  "message-sent": { color: "blue", label: "Message", icon: ">" },
  "session-created": { color: "green", label: "Created", icon: "+" },
  "session-paused": { color: "yellow", label: "Paused", icon: "||" },
  "session-resumed": { color: "green", label: "Resumed", icon: ">" },
  "session-stopped": { color: "red", label: "Stopped", icon: "x" },
  "task-updated": { color: "grape", label: "Task", icon: "#" },
  "task-created": { color: "grape", label: "Task", icon: "+" },
};

const MESSAGE_TYPE_STYLES: Record<
  string,
  { borderColor: string; icon: string; label: string }
> = {
  "task-assignment": {
    borderColor: "var(--accent-blue)",
    icon: "\uD83D\uDCCB",
    label: "Task Assignment",
  },
  question: {
    borderColor: "var(--accent-yellow)",
    icon: "\u2753",
    label: "Question",
  },
  completion: {
    borderColor: "var(--accent-green)",
    icon: "\u2705",
    label: "Completion",
  },
  stop: {
    borderColor: "var(--accent-red)",
    icon: "\uD83D\uDED1",
    label: "Stop",
  },
  ack: {
    borderColor: "var(--border-color)",
    icon: "\uD83D\uDC4D",
    label: "Ack",
  },
  text: { borderColor: "none", icon: "\uD83D\uDCAC", label: "Text" },
};

const FILTER_GROUPS: Record<EventFilter, string[] | null> = {
  all: null,
  agents: [
    "agent-spawned",
    "agent-removed",
    "agent-crashed",
    "agent-restarted",
  ],
  messages: ["message-sent"],
  session: [
    "session-created",
    "session-paused",
    "session-resumed",
    "session-stopped",
  ],
};

function getEventStyle(type: string) {
  return EVENT_STYLES[type] || { color: "blue", label: type, icon: "?" };
}

function getMessageTypeStyle(messageType?: string) {
  return MESSAGE_TYPE_STYLES[messageType || "text"] || MESSAGE_TYPE_STYLES.text;
}

function formatEventDetail(event: TimelineEvent): string {
  const data = (event.data || {}) as Record<
    string,
    string | number | undefined
  >;
  switch (event.type) {
    case "agent-spawned":
      return `Agent "${data.name || data.agentId || "unknown"}" spawned${
        data.provider ? ` (${data.provider}/${data.model})` : ""
      }`;
    case "agent-removed":
      return `Agent "${data.agentId || "unknown"}" removed${
        data.reason ? ` \u2014 ${data.reason}` : ""
      }`;
    case "agent-crashed":
      return `Agent "${data.agentId || "unknown"}" crashed${
        data.restartCount !== undefined
          ? ` (restart count: ${data.restartCount})`
          : ""
      }`;
    case "agent-restarted":
      return `Agent replaced: "${data.oldAgentId || "?"}" \u2192 new ID: ${
        data.newAgentId || "?"
      }${data.reason ? ` (${data.reason})` : ""}`;
    case "message-sent": {
      const from = data.fromName || data.from || "?";
      const to = data.toName || data.to || "?";
      return `${from} \u2192 ${to}`;
    }
    case "session-created":
      return `Session "${data.name || "unknown"}" created${
        data.projectPath ? ` at ${data.projectPath}` : ""
      }`;
    case "session-paused":
      return `Session "${data.name || ""}" paused`;
    case "session-resumed":
      return `Session "${data.name || ""}" resumed`;
    case "session-stopped":
      return `Session "${data.name || ""}" stopped`;
    default:
      return JSON.stringify(data).substring(0, 150);
  }
}

function formatEventFullDetail(event: TimelineEvent): string {
  const data = (event.data || {}) as Record<string, unknown>;
  const lines: string[] = [];
  lines.push(`Event: ${event.type}`);
  lines.push(`Time: ${event.timestamp}`);
  lines.push(`ID: ${event.id}`);
  lines.push("");
  for (const [key, value] of Object.entries(data)) {
    if (typeof value === "string" && value.length > 200) {
      lines.push(`${key}:`);
      lines.push(`  ${value}`);
    } else {
      lines.push(`${key}: ${JSON.stringify(value)}`);
    }
  }
  return lines.join("\n");
}

function getMessageContent(event: TimelineEvent): string | null {
  if (event.type !== "message-sent") return null;
  const data = (event.data || {}) as Record<string, string | undefined>;
  const content = data.content;
  if (!content) return null;
  return content.length > 100 ? `${content.substring(0, 100)}...` : content;
}

function relativeTime(timestamp: string): string {
  const now = Date.now();
  const then = new Date(timestamp).getTime();
  const diffMs = now - then;
  if (isNaN(then)) return timestamp;
  const seconds = Math.floor(diffMs / 1000);
  if (seconds < 5) return "just now";
  if (seconds < 60) return `${seconds}s ago`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes} min ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  return `${days}d ago`;
}

// Extract unique agent names from events
function extractAgentNames(events: TimelineEvent[]): string[] {
  const names = new Set<string>();
  for (const evt of events) {
    const data = (evt.data || {}) as Record<string, string | undefined>;
    if (data.name) names.add(data.name);
    if (data.fromName) names.add(data.fromName);
    if (data.toName) names.add(data.toName);
    if (data.agentId) names.add(data.agentId);
  }
  return Array.from(names).sort();
}

const selectStyles = {
  input: {
    backgroundColor: "var(--bg-tertiary)",
    borderColor: "var(--border-color)",
    color: "var(--text-primary)",
    fontSize: 13,
  },
  dropdown: {
    backgroundColor: "var(--bg-secondary)",
    borderColor: "var(--border-color)",
  },
  option: { color: "var(--text-primary)", fontSize: 13 },
  label: { color: "var(--text-secondary)", fontSize: 12 },
};

export function Timeline({ sessionId }: TimelineProps) {
  const api = useApi();
  const isMobile = useMediaQuery("(max-width: 48em)");
  const virtuosoRef = useRef<VirtuosoHandle>(null);

  const [events, setEvents] = useState<TimelineEvent[]>([]);
  const [loading, setLoading] = useState(true);
  const [filter, setFilter] = useState<EventFilter>("all");
  const [agentFilter, setAgentFilter] = useState<string[]>([]);
  const [search, setSearch] = useState("");
  const [debouncedSearch] = useDebouncedValue(search, 300);
  const [expandedEvents, setExpandedEvents] = useState<Set<string>>(
    new Set()
  );
  const [hasMore, setHasMore] = useState(true);
  const loadingMoreRef = useRef(false);

  const agentNames = extractAgentNames(events);

  // Toggle event expand
  function toggleExpand(eventId: string) {
    setExpandedEvents((prev) => {
      const next = new Set(prev);
      if (next.has(eventId)) next.delete(eventId);
      else next.add(eventId);
      return next;
    });
  }

  // Build API query options from filters
  const buildQueryOptions = useCallback(
    (opts?: { before?: string }) => {
      const types = FILTER_GROUPS[filter];
      return {
        limit: 50,
        types: types || undefined,
        search: debouncedSearch || undefined,
        agentId: agentFilter.length === 1 ? agentFilter[0] : undefined,
        before: opts?.before,
      };
    },
    [filter, debouncedSearch, agentFilter]
  );

  // Initial fetch + refetch when filters change
  useEffect(() => {
    let cancelled = false;
    setLoading(true);

    async function fetchEvents() {
      try {
        const data = await api.getEvents(sessionId, buildQueryOptions());
        if (!cancelled) {
          const sorted = (data.events || []).sort(
            (a: TimelineEvent, b: TimelineEvent) =>
              new Date(b.timestamp).getTime() -
              new Date(a.timestamp).getTime()
          );
          setEvents(sorted);
          setHasMore(sorted.length >= 50);
        }
      } catch {
        // ignore
      } finally {
        if (!cancelled) setLoading(false);
      }
    }

    fetchEvents();
    return () => {
      cancelled = true;
    };
  }, [sessionId, filter, debouncedSearch, agentFilter]);

  // WebSocket live mode — prepend new events instead of polling
  const handleWsEvent = useCallback(
    (wsEvent: any) => {
      // Only handle timeline-relevant event types
      if (wsEvent.type === "event" && wsEvent.event) {
        const newEvent = wsEvent.event as TimelineEvent;
        // Check if it passes current filters
        const allowedTypes = FILTER_GROUPS[filter];
        if (allowedTypes && !allowedTypes.includes(newEvent.type)) return;

        // Check search filter
        if (debouncedSearch) {
          const detail = formatEventDetail(newEvent).toLowerCase();
          if (!detail.includes(debouncedSearch.toLowerCase())) return;
        }

        setEvents((prev) => {
          // Deduplicate
          if (prev.some((e) => e.id === newEvent.id)) return prev;
          return [newEvent, ...prev];
        });
      }
    },
    [filter, debouncedSearch]
  );

  const { subscribe, unsubscribe } = useWebSocket(handleWsEvent);

  useEffect(() => {
    subscribe(sessionId);
    return () => unsubscribe(sessionId);
  }, [sessionId, subscribe, unsubscribe]);

  // Load more events (infinite scroll)
  const loadMore = useCallback(async () => {
    if (loadingMoreRef.current || !hasMore || events.length === 0) return;
    loadingMoreRef.current = true;
    try {
      const lastEvent = events[events.length - 1];
      const data = await api.getEvents(
        sessionId,
        buildQueryOptions({ before: lastEvent.timestamp })
      );
      const newEvents = (data.events || []).sort(
        (a: TimelineEvent, b: TimelineEvent) =>
          new Date(b.timestamp).getTime() - new Date(a.timestamp).getTime()
      );
      if (newEvents.length === 0) {
        setHasMore(false);
      } else {
        setEvents((prev) => {
          const existingIds = new Set(prev.map((e) => e.id));
          const unique = newEvents.filter(
            (e: TimelineEvent) => !existingIds.has(e.id)
          );
          return [...prev, ...unique];
        });
        setHasMore(newEvents.length >= 50);
      }
    } catch {
      // ignore
    } finally {
      loadingMoreRef.current = false;
    }
  }, [events, hasMore, sessionId, buildQueryOptions]);

  // Client-side agent filter for multi-agent (API only supports single agentId)
  let filteredEvents = events;
  if (agentFilter.length > 1) {
    filteredEvents = events.filter((evt) => {
      const data = (evt.data || {}) as Record<string, string | undefined>;
      return (
        agentFilter.includes(data.name || "") ||
        agentFilter.includes(data.fromName || "") ||
        agentFilter.includes(data.toName || "") ||
        agentFilter.includes(data.agentId || "") ||
        agentFilter.includes(evt.agent_id || "")
      );
    });
  }

  return (
    <Stack gap="md" style={{ marginTop: 32 }}>
      {/* Header */}
      <Group justify="space-between" align="flex-start" wrap="wrap">
        <Text size="lg" fw={600} c="var(--text-primary)">
          Timeline
        </Text>
        <Badge
          size="sm"
          variant="light"
          color="gray"
          style={{ fontVariantNumeric: "tabular-nums" }}
        >
          {filteredEvents.length} event{filteredEvents.length !== 1 ? "s" : ""}
        </Badge>
      </Group>

      {/* Filters row */}
      <div
        style={{
          display: "grid",
          gridTemplateColumns: isMobile ? "1fr" : "1fr 1fr 1fr 1fr",
          gap: 8,
        }}
      >
        <Select
          size="xs"
          placeholder="Filter events"
          value={filter}
          onChange={(v) => setFilter((v as EventFilter) || "all")}
          data={[
            { value: "all", label: "All Events" },
            { value: "agents", label: "Agents Only" },
            { value: "messages", label: "Messages Only" },
            { value: "session", label: "Session Only" },
          ]}
          styles={selectStyles}
          allowDeselect={false}
        />

        <MultiSelect
          size="xs"
          placeholder="Filter by agent"
          value={agentFilter}
          onChange={setAgentFilter}
          data={agentNames.map((n) => ({ value: n, label: n }))}
          clearable
          searchable
          maxDropdownHeight={200}
          styles={selectStyles}
        />

        <TextInput
          size="xs"
          placeholder="Search events..."
          value={search}
          onChange={(e) => setSearch(e.currentTarget.value)}
          rightSection={
            search ? (
              <Text
                size="xs"
                c="var(--text-muted)"
                style={{ cursor: "pointer" }}
                onClick={() => setSearch("")}
              >
                x
              </Text>
            ) : null
          }
          styles={{
            input: {
              backgroundColor: "var(--bg-tertiary)",
              borderColor: "var(--border-color)",
              color: "var(--text-primary)",
              fontSize: 13,
            },
          }}
        />

        {/* Event count on mobile */}
        {isMobile && (
          <Text size="xs" c="var(--text-muted)">
            {filteredEvents.length} events
          </Text>
        )}
      </div>

      {/* Loading state */}
      {loading && (
        <Group justify="center" py="xl">
          <Loader size="sm" color="var(--accent-blue)" />
          <Text size="sm" c="var(--text-secondary)">
            Loading events...
          </Text>
        </Group>
      )}

      {/* Empty state */}
      {!loading && filteredEvents.length === 0 && (
        <Text c="var(--text-muted)" size="sm" ta="center" py="xl">
          {search || agentFilter.length > 0
            ? "No events match your filters."
            : "No events recorded yet."}
        </Text>
      )}

      {/* Virtualized event list */}
      {!loading && filteredEvents.length > 0 && (
        <Box
          style={{
            height: Math.min(filteredEvents.length * 72, 600),
            minHeight: 200,
          }}
        >
          <Virtuoso
            ref={virtuosoRef}
            data={filteredEvents}
            endReached={loadMore}
            overscan={200}
            itemContent={(idx, evt) => (
              <TimelineEventRow
                key={evt.id || idx}
                event={evt}
                isExpanded={expandedEvents.has(evt.id || String(idx))}
                onToggle={() => toggleExpand(evt.id || String(idx))}
              />
            )}
            components={{
              Footer: () =>
                hasMore ? (
                  <Group justify="center" py="sm">
                    <Loader size="xs" color="var(--accent-blue)" />
                  </Group>
                ) : null,
            }}
          />
        </Box>
      )}
    </Stack>
  );
}

// Extracted event row for virtualization
function TimelineEventRow({
  event: evt,
  isExpanded,
  onToggle,
}: {
  event: TimelineEvent;
  isExpanded: boolean;
  onToggle: () => void;
}) {
  const style = getEventStyle(evt.type);
  const detail = formatEventDetail(evt);
  const messageContent = getMessageContent(evt);

  const msgType =
    evt.type === "message-sent"
      ? ((evt.data?.messageType as string) || "text")
      : null;
  const msgStyle = msgType ? getMessageTypeStyle(msgType) : null;

  let borderColor = msgStyle?.borderColor !== "none" ? msgStyle?.borderColor : undefined;
  if (!borderColor && style.color) {
    // Map Mantine colors to CSS vars
    const colorMap: Record<string, string> = {
      green: "var(--accent-green)",
      red: "var(--accent-red)",
      yellow: "var(--accent-yellow)",
      blue: "var(--accent-blue)",
      grape: "var(--accent-purple)",
      gray: "var(--text-muted)",
    };
    borderColor = colorMap[style.color] || "var(--border-color)";
  }

  const isAck = msgType === "ack";

  return (
    <div style={{ paddingBottom: 6 }}>
      <div
        className="card"
        style={{
          padding: "10px 14px",
          borderLeft: borderColor ? `3px solid ${borderColor}` : undefined,
          opacity: isAck ? 0.7 : 1,
        }}
      >
        <div
          onClick={onToggle}
          style={{
            display: "flex",
            alignItems: "flex-start",
            gap: 10,
            cursor: "pointer",
            userSelect: "none",
          }}
        >
          {/* Expand toggle */}
          <span
            style={{
              fontSize: 10,
              color: "var(--text-muted)",
              flexShrink: 0,
              paddingTop: 2,
              transition: "transform 0.15s",
              transform: isExpanded ? "rotate(90deg)" : "rotate(0deg)",
              display: "inline-block",
            }}
          >
            {"\u25B6"}
          </span>

          {/* Timestamp */}
          <span
            style={{
              fontSize: 12,
              color: "var(--text-muted)",
              minWidth: 68,
              flexShrink: 0,
              paddingTop: 1,
            }}
          >
            {relativeTime(evt.timestamp)}
          </span>

          {/* Type badge */}
          <Badge
            size="xs"
            variant="light"
            color={style.color}
            style={{ flexShrink: 0 }}
          >
            {msgStyle ? `${msgStyle.icon} ${msgStyle.label}` : style.label}
          </Badge>

          {/* Detail text */}
          <div style={{ flex: 1, overflow: "hidden", minWidth: 0 }}>
            <span
              style={{
                fontSize: 13,
                color: "var(--text-secondary)",
                display: "block",
                overflow: "hidden",
                textOverflow: "ellipsis",
                whiteSpace: "nowrap",
                fontWeight:
                  msgType === "task-assignment" || msgType === "stop"
                    ? 600
                    : "normal",
                fontStyle: isAck ? "italic" : "normal",
              }}
            >
              {detail}
            </span>

            {messageContent && (
              <span
                style={{
                  fontSize: 12,
                  color: "var(--text-muted)",
                  fontStyle: "italic",
                  display: "block",
                  marginTop: 3,
                  overflow: "hidden",
                  textOverflow: "ellipsis",
                  whiteSpace: "nowrap",
                }}
              >
                &ldquo;{messageContent}&rdquo;
              </span>
            )}
          </div>
        </div>

        {isExpanded && (
          <div
            style={{
              marginTop: 8,
              padding: "10px 14px",
              background: "var(--bg-tertiary)",
              borderRadius: 6,
              border: "1px solid var(--border-color)",
              fontSize: 12,
              fontFamily: "'JetBrains Mono', monospace",
              color: "var(--text-muted)",
              whiteSpace: "pre-wrap",
              wordBreak: "break-word",
              animation: "slideDown 0.15s ease",
            }}
          >
            {formatEventFullDetail(evt)}
          </div>
        )}
      </div>
    </div>
  );
}
