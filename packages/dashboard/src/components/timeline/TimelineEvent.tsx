import { useState } from "react";
import { Badge, ActionIcon, Tooltip } from "@mantine/core";
import type { DensityMode } from "./TimelineFilters";

export interface TimelineEventData {
  id: string;
  type: string;
  description?: string;
  timestamp: string;
  data?: Record<string, unknown>;
}

interface TimelineEventProps {
  event: TimelineEventData;
  density: DensityMode;
  onJumpToTerminal?: (agentId: string) => void;
  onJumpToTaskBoard?: (taskId?: string) => void;
  onRestart?: (agentId: string) => void;
}

// Color + label mapping per event type
const EVENT_CONFIG: Record<string, { color: string; bulletClass: string; label: string }> = {
  "agent-spawned": { color: "green", bulletClass: "green", label: "Spawned" },
  "agent-removed": { color: "gray", bulletClass: "gray", label: "Removed" },
  "agent-crashed": { color: "red", bulletClass: "red", label: "Crashed" },
  "agent-restarted": { color: "yellow", bulletClass: "yellow", label: "Restarted" },
  "agent-status-changed": { color: "gray", bulletClass: "gray", label: "Status Changed" },
  "message-sent": { color: "blue", bulletClass: "blue", label: "Message" },
  "message-received": { color: "blue", bulletClass: "blue", label: "Message" },
  "session-created": { color: "green", bulletClass: "green", label: "Session Created" },
  "session-paused": { color: "yellow", bulletClass: "yellow", label: "Paused" },
  "session-resumed": { color: "green", bulletClass: "green", label: "Resumed" },
  "session-stopped": { color: "red", bulletClass: "red", label: "Stopped" },
  "task-created": { color: "grape", bulletClass: "purple", label: "Task Created" },
  "task-updated": { color: "grape", bulletClass: "purple", label: "Task Updated" },
  "task-deleted": { color: "gray", bulletClass: "gray", label: "Task Deleted" },
  "user-interaction": { color: "yellow", bulletClass: "yellow", label: "User Input" },
  "cost-threshold-reached": { color: "yellow", bulletClass: "yellow", label: "Cost Alert" },
};

// Message subtype styling
const MSG_TYPE_CONFIG: Record<string, { label: string; icon: string; color: string }> = {
  "task-assignment": { label: "Task Assignment", icon: "\uD83D\uDCCB", color: "blue" },
  question: { label: "Question", icon: "\u2753", color: "yellow" },
  completion: { label: "Completion", icon: "\u2705", color: "green" },
  stop: { label: "Stop", icon: "\uD83D\uDED1", color: "red" },
  ack: { label: "Ack", icon: "\uD83D\uDC4D", color: "gray" },
  broadcast: { label: "Broadcast", icon: "\uD83D\uDCE2", color: "grape" },
  text: { label: "Message", icon: "\uD83D\uDCAC", color: "blue" },
};

const AGENT_COLORS = ["#58a6ff", "#bc8cff", "#3fb950", "#d29922", "#f78166", "#39d2c0"];

function getAgentColor(agentId: string): string {
  let hash = 0;
  for (let i = 0; i < agentId.length; i++) hash = (hash * 31 + agentId.charCodeAt(i)) | 0;
  return AGENT_COLORS[Math.abs(hash) % AGENT_COLORS.length];
}

function formatTime(timestamp: string): string {
  const d = new Date(timestamp);
  return d.toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit", hour12: true });
}

function getTitle(event: TimelineEventData): string {
  const data = (event.data || {}) as Record<string, string | undefined>;
  switch (event.type) {
    case "agent-spawned":
      return `${data.name || data.agentId || "Agent"} spawned`;
    case "agent-crashed":
      return `${data.name || data.agentId || "Agent"} crashed`;
    case "agent-removed":
      return `${data.name || data.agentId || "Agent"} removed`;
    case "agent-restarted":
      return `${data.name || data.agentId || "Agent"} restarted`;
    case "agent-status-changed":
      return `${data.name || data.agentId || "Agent"} → ${data.newStatus || data.status || "unknown"}`;
    case "message-sent":
    case "message-received": {
      const from = data.fromName || data.from || "?";
      const to = data.toName || data.to || "?";
      const msgType = data.messageType || "text";
      if (msgType === "broadcast" || data.broadcast === "true") {
        return `${from} broadcast`;
      }
      return `${from} \u2192 ${to}`;
    }
    case "user-interaction":
      return `User → ${data.agentName || data.agentId || "Agent"}`;
    case "cost-threshold-reached":
      return `Cost alert: $${data.amount || data.cost || "0.00"}`;
    case "task-created":
    case "task-updated":
    case "task-deleted":
      return `Task: "${data.title || data.taskId || "unknown"}"`;
    case "session-created":
      return `Session "${data.name || ""}" created`;
    case "session-paused":
      return `Session paused`;
    case "session-resumed":
      return `Session resumed`;
    case "session-stopped":
      return `Session stopped`;
    default:
      return event.description || event.type;
  }
}

function getSubtitle(event: TimelineEventData): string | null {
  const data = (event.data || {}) as Record<string, string | undefined>;
  switch (event.type) {
    case "agent-spawned":
      return data.provider && data.model ? `${data.provider}/${data.model}` : null;
    case "agent-crashed":
      return data.exitCode ? `Exit code: ${data.exitCode}` : null;
    default:
      return null;
  }
}

function getMessageContent(event: TimelineEventData): string | null {
  if (event.type !== "message-sent" && event.type !== "message-received" && event.type !== "user-interaction") return null;
  return ((event.data as any)?.content as string) || ((event.data as any)?.message as string) || null;
}

export function TimelineEvent({
  event,
  density,
  onJumpToTerminal,
  onJumpToTaskBoard,
  onRestart,
}: TimelineEventProps) {
  const [expanded, setExpanded] = useState(false);

  const config = EVENT_CONFIG[event.type] || { color: "gray", bulletClass: "gray", label: event.type };
  const data = (event.data || {}) as Record<string, string | undefined>;
  const agentId = data.agentId || data.from || "";
  const agentColor = agentId ? getAgentColor(agentId) : undefined;

  // Message sub-type
  const msgType = event.type === "message-sent" ? (data.messageType || "text") : null;
  const msgConfig = msgType ? MSG_TYPE_CONFIG[msgType] || MSG_TYPE_CONFIG.text : null;

  const title = getTitle(event);
  const subtitle = getSubtitle(event);
  const messageContent = getMessageContent(event);
  const isCrash = event.type === "agent-crashed";

  const bulletClass = `tl-event ${config.bulletClass}${isCrash ? " crash" : ""}`;

  return (
    <div className={bulletClass}>
      <div className="tl-event-header">
        <Tooltip label={new Date(event.timestamp).toLocaleString()} position="top" withArrow>
          <span className="tl-event-time">{formatTime(event.timestamp)}</span>
        </Tooltip>

        {agentColor && <span className="tl-agent-dot" style={{ background: agentColor }} />}

        <span className="tl-event-title">{title}</span>

        {/* Role badge for agent events */}
        {data.role && (
          <Badge
            variant="light"
            color={data.role === "master" ? "grape" : "blue"}
            size="xs"
            styles={{ root: { textTransform: "lowercase" } }}
          >
            {data.role}
          </Badge>
        )}

        {/* Message type badge */}
        {msgConfig && (
          <Badge variant="light" color={msgConfig.color} size="xs">
            {msgConfig.icon} {msgConfig.label}
          </Badge>
        )}

        {/* Event type badge (non-message) */}
        {!msgConfig && (
          <Badge variant="light" color={config.color} size="xs">
            {config.label}
          </Badge>
        )}

        {/* Status badge for task events */}
        {data.status && event.type.startsWith("task-") && (
          <Badge variant="outline" color="gray" size="xs">
            {data.status}
          </Badge>
        )}

        {/* Action buttons */}
        <div className="tl-event-actions">
          {(event.type === "agent-spawned" || event.type === "agent-crashed") && agentId && onJumpToTerminal && (
            <Tooltip label="Open terminal">
              <ActionIcon variant="subtle" size="xs" onClick={() => onJumpToTerminal(agentId)}>
                <span style={{ fontSize: 11 }}>{"\u2192"} Terminal</span>
              </ActionIcon>
            </Tooltip>
          )}
          {isCrash && agentId && onRestart && (
            <Tooltip label="Restart agent">
              <ActionIcon variant="subtle" size="xs" color="yellow" onClick={() => onRestart(agentId)}>
                <span style={{ fontSize: 11 }}>Restart</span>
              </ActionIcon>
            </Tooltip>
          )}
          {event.type.startsWith("task-") && onJumpToTaskBoard && (
            <Tooltip label="Go to task board">
              <ActionIcon
                variant="subtle"
                size="xs"
                onClick={() => {
                  const taskId = data.taskId || data.id;
                  onJumpToTaskBoard(taskId);
                }}
              >
                <span style={{ fontSize: 11 }}>{"\u2192"} Task Board</span>
              </ActionIcon>
            </Tooltip>
          )}
        </div>
      </div>

      {/* Subtitle */}
      {density !== "compact" && subtitle && (
        <div className="tl-event-subtitle">
          {agentColor && <span className="tl-agent-dot" style={{ background: agentColor }} />}
          {subtitle}
        </div>
      )}

      {/* Message preview */}
      {density !== "compact" && messageContent && (
        <div className={expanded || density === "detailed" ? "tl-msg-full" : "tl-msg-preview"}>
          {messageContent}
        </div>
      )}

      {/* Crash alert box */}
      {density !== "compact" && isCrash && (
        <div className="tl-alert-box">
          {data.exitCode && <div>Exit code: {data.exitCode}</div>}
          {data.signal && <div>Signal: {data.signal}</div>}
          {data.restartCount && <div>Restart attempts: {data.restartCount}</div>}
        </div>
      )}

      {/* Expand/collapse toggle */}
      {density !== "compact" && messageContent && messageContent.length > 200 && density !== "detailed" && (
        <button className="tl-expand-btn" onClick={() => setExpanded(!expanded)}>
          {expanded ? "Show less" : "Show more"}
        </button>
      )}

      {/* Expanded detail */}
      {expanded && density !== "compact" && (
        <div className="tl-term-output">
          {JSON.stringify(event.data, null, 2)}
        </div>
      )}
    </div>
  );
}
