import { useEffect, useState } from "react";
import { useApi } from "../hooks/useApi";

interface TimelineProps {
  sessionId: string;
}

interface TimelineEvent {
  id: string;
  type: string;
  description: string;
  timestamp: string;
  data?: Record<string, unknown>;
  [key: string]: unknown;
}

type EventFilter = "all" | "agents" | "messages" | "session";
type MessageTypeFilter = "all" | "text" | "task-assignment" | "question" | "completion" | "stop" | "ack";

const MESSAGE_TYPE_STYLES: Record<string, { borderColor: string; icon: string; label: string }> = {
  "task-assignment": { borderColor: "var(--accent-blue)", icon: "\uD83D\uDCCB", label: "Task Assignment" },
  question: { borderColor: "var(--accent-yellow)", icon: "\u2753", label: "Question" },
  completion: { borderColor: "var(--accent-green)", icon: "\u2705", label: "Completion" },
  stop: { borderColor: "var(--accent-red)", icon: "\uD83D\uDED1", label: "Stop" },
  ack: { borderColor: "var(--border-color)", icon: "\uD83D\uDC4D", label: "Ack" },
  text: { borderColor: "none", icon: "\uD83D\uDCAC", label: "Text" },
};

const MESSAGE_TYPE_FILTER_LABELS: Record<MessageTypeFilter, string> = {
  all: "All Messages",
  text: "\uD83D\uDCAC Text",
  "task-assignment": "\uD83D\uDCCB Task Assignments",
  question: "\u2753 Questions",
  completion: "\u2705 Completions",
  stop: "\uD83D\uDED1 Stop",
  ack: "\uD83D\uDC4D Acknowledgements",
};

function getMessageTypeStyle(messageType?: string) {
  return MESSAGE_TYPE_STYLES[messageType || "text"] || MESSAGE_TYPE_STYLES.text;
}

const EVENT_STYLES: Record<
  string,
  { badge: string; label: string; icon?: string; borderColor?: string }
> = {
  "agent-spawned": {
    badge: "badge-green",
    label: "Spawned",
    borderColor: "var(--accent-green, #22c55e)",
  },
  "agent-removed": {
    badge: "badge-red",
    label: "Removed",
    borderColor: "var(--text-muted, #888)",
  },
  "agent-crashed": {
    badge: "badge-red",
    label: "Crashed",
    icon: "!",
    borderColor: "var(--accent-red, #ef4444)",
  },
  "agent-restarted": {
    badge: "badge-yellow",
    label: "Restarted",
    borderColor: "var(--accent-yellow, #eab308)",
  },
  "message-sent": { badge: "badge-blue", label: "Message" },
  "session-created": { badge: "badge-green", label: "Created" },
  "session-paused": { badge: "badge-yellow", label: "Paused" },
  "session-resumed": { badge: "badge-green", label: "Resumed" },
  "session-stopped": { badge: "badge-red", label: "Stopped" },
  "task-updated": { badge: "badge-purple", label: "Task" },
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
  return EVENT_STYLES[type] || { badge: "badge-blue", label: type };
}

function formatEventDetail(event: TimelineEvent): string {
  const data = (event.data || {}) as Record<string, string | number | undefined>;
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

  // Show all data fields
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
  return content.length > 100
    ? `${content.substring(0, 100)}...`
    : content;
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

export function Timeline({ sessionId }: TimelineProps) {
  const api = useApi();
  const [events, setEvents] = useState<TimelineEvent[]>([]);
  const [loading, setLoading] = useState(true);
  const [filter, setFilter] = useState<EventFilter>("all");
  const [messageTypeFilter, setMessageTypeFilter] = useState<MessageTypeFilter>("all");
  const [expandedEvents, setExpandedEvents] = useState<Set<string>>(new Set());

  function toggleExpand(eventId: string) {
    setExpandedEvents((prev) => {
      const next = new Set(prev);
      if (next.has(eventId)) next.delete(eventId);
      else next.add(eventId);
      return next;
    });
  }

  useEffect(() => {
    let cancelled = false;

    async function fetchEvents() {
      try {
        const data = await api.getEvents(sessionId, 50);
        if (!cancelled) {
          const sorted = (data.events || []).sort(
            (a: TimelineEvent, b: TimelineEvent) =>
              new Date(b.timestamp).getTime() - new Date(a.timestamp).getTime()
          );
          setEvents(sorted);
        }
      } catch {
        // ignore fetch errors
      } finally {
        if (!cancelled) setLoading(false);
      }
    }

    fetchEvents();
    const interval = setInterval(fetchEvents, 5000);
    return () => {
      cancelled = true;
      clearInterval(interval);
    };
  }, [sessionId]);

  const allowedTypes = FILTER_GROUPS[filter];
  let filteredEvents = allowedTypes
    ? events.filter((evt) => allowedTypes.includes(evt.type))
    : events;

  // Apply message type sub-filter
  if (messageTypeFilter !== "all") {
    filteredEvents = filteredEvents.filter((evt) => {
      if (evt.type !== "message-sent") return true; // non-message events pass through
      const msgType = (evt.data?.messageType as string) || "text";
      return msgType === messageTypeFilter;
    });
  }

  return (
    <div style={{ marginTop: 32 }}>
      <div
        style={{
          display: "flex",
          alignItems: "center",
          justifyContent: "space-between",
          marginBottom: 16,
        }}
      >
        <h2
          style={{
            fontSize: 18,
            fontWeight: 600,
            color: "var(--text-primary)",
            margin: 0,
          }}
        >
          Timeline
        </h2>

        <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
          <select
            value={filter}
            onChange={(e) => setFilter(e.target.value as EventFilter)}
            style={{
              fontSize: 12,
              padding: "4px 8px",
              minHeight: 44,
              borderRadius: 6,
              border: "1px solid var(--border-color, #333)",
              background: "var(--bg-secondary, #1e1e1e)",
              color: "var(--text-secondary, #ccc)",
              cursor: "pointer",
            }}
          >
            <option value="all">All Events</option>
            <option value="agents">Agents Only</option>
            <option value="messages">Messages Only</option>
            <option value="session">Session Only</option>
          </select>
          <select
            value={messageTypeFilter}
            onChange={(e) => setMessageTypeFilter(e.target.value as MessageTypeFilter)}
            style={{
              fontSize: 12,
              padding: "4px 8px",
              minHeight: 44,
              borderRadius: 6,
              border: "1px solid var(--border-color, #333)",
              background: "var(--bg-secondary, #1e1e1e)",
              color: "var(--text-secondary, #ccc)",
              cursor: "pointer",
            }}
          >
            {(Object.entries(MESSAGE_TYPE_FILTER_LABELS) as [MessageTypeFilter, string][]).map(([value, label]) => (
              <option key={value} value={value}>{label}</option>
            ))}
          </select>
        </div>
      </div>

      {loading && (
        <p style={{ color: "var(--text-secondary)", fontSize: 13 }}>
          Loading events...
        </p>
      )}

      {!loading && filteredEvents.length === 0 && (
        <p style={{ color: "var(--text-muted)", fontSize: 13 }}>
          No events recorded yet.
        </p>
      )}

      <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
        {filteredEvents.map((evt, idx) => {
          const style = getEventStyle(evt.type);
          const detail = formatEventDetail(evt);
          const messageContent = getMessageContent(evt);
          let borderColor = style.borderColor;

          // Apply message-type-specific styling for message events
          const msgType = evt.type === "message-sent" ? ((evt.data?.messageType as string) || "text") : null;
          const msgStyle = msgType ? getMessageTypeStyle(msgType) : null;
          if (msgStyle && msgStyle.borderColor !== "none") {
            borderColor = msgStyle.borderColor;
          }
          const isAck = msgType === "ack";

          const eventKey = evt.id || String(idx);
          const isExpanded = expandedEvents.has(eventKey);

          return (
            <div
              key={eventKey}
              className="card"
              style={{
                padding: "10px 14px",
                borderLeft: borderColor
                  ? `3px solid ${borderColor}`
                  : undefined,
                opacity: isAck ? 0.7 : 1,
              }}
            >
              <div
                onClick={() => toggleExpand(eventKey)}
                style={{
                  display: "flex",
                  alignItems: "flex-start",
                  gap: 12,
                  cursor: "pointer",
                  userSelect: "none",
                }}
              >
                {/* Expand toggle */}
                <span
                  className="timeline-expand-toggle"
                  style={{
                    fontSize: 10,
                    color: "#484f58",
                    flexShrink: 0,
                    paddingTop: 2,
                    transition: "color 0.15s",
                  }}
                >
                  {isExpanded ? "\u25BC" : "\u25B6"}
                </span>

                {/* Timestamp */}
                <span
                  style={{
                    fontSize: 12,
                    color: "var(--text-muted)",
                    minWidth: 72,
                    flexShrink: 0,
                    paddingTop: 1,
                  }}
                >
                  {relativeTime(evt.timestamp)}
                </span>

                {/* Type badge */}
                <span
                  className={`badge ${style.badge}`}
                  style={{ flexShrink: 0 }}
                >
                  {msgStyle ? (
                    <span style={{ marginRight: 4 }}>{msgStyle.icon}</span>
                  ) : style.icon ? (
                    <span
                      style={{
                        marginRight: 4,
                        fontWeight: 700,
                        color: "var(--accent-red)",
                      }}
                    >
                      {style.icon}
                    </span>
                  ) : null}
                  {msgStyle ? msgStyle.label : style.label}
                </span>

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
                      fontWeight: msgType === "task-assignment" || msgType === "stop" ? 600 : "normal",
                      fontStyle: isAck ? "italic" : "normal",
                    }}
                  >
                    {detail}
                  </span>

                  {messageContent && (
                    <span
                      style={{
                        fontSize: 12,
                        color: isAck ? "var(--text-muted)" : "var(--text-muted)",
                        fontStyle: "italic",
                        display: "block",
                        marginTop: 4,
                        overflow: "hidden",
                        textOverflow: "ellipsis",
                        whiteSpace: "nowrap",
                      }}
                    >
                      &ldquo;{messageContent}&rdquo;
                    </span>
                  )}

                  {/* Show files changed for completion messages */}
                  {msgType === "completion" && (evt.data as any)?.filesChanged && (
                    <span
                      style={{
                        fontSize: 11,
                        color: "var(--accent-green)",
                        display: "block",
                        marginTop: 4,
                      }}
                    >
                      {Array.isArray((evt.data as any).filesChanged)
                        ? `${((evt.data as any).filesChanged as string[]).length} file(s) changed`
                        : String((evt.data as any).filesChanged)}
                    </span>
                  )}

                  {/* Show urgency for questions */}
                  {msgType === "question" && (evt.data as any)?.urgency === "high" && (
                    <span
                      style={{
                        fontSize: 11,
                        color: "var(--accent-red)",
                        fontWeight: 600,
                        display: "block",
                        marginTop: 4,
                      }}
                    >
                      ⚠ High urgency
                    </span>
                  )}

                  {/* Show reason for stop messages */}
                  {msgType === "stop" && (evt.data as any)?.reason && (
                    <span
                      style={{
                        fontSize: 11,
                        color: "var(--accent-red)",
                        fontWeight: 600,
                        display: "block",
                        marginTop: 4,
                      }}
                    >
                      Reason: {String((evt.data as any).reason)}
                    </span>
                  )}
                </div>
              </div>

              {isExpanded && (
                <div
                  className="timeline-event-detail"
                  style={{
                    marginTop: 8,
                    padding: "10px 14px",
                    background: "#161b22",
                    borderRadius: 6,
                    border: "1px solid #30363d",
                    fontSize: 12,
                    fontFamily: "'JetBrains Mono', monospace",
                    color: "#8b949e",
                    whiteSpace: "pre-wrap",
                    wordBreak: "break-word",
                    animation: "slideDown 0.15s ease",
                  }}
                >
                  {formatEventFullDetail(evt)}
                </div>
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
}
