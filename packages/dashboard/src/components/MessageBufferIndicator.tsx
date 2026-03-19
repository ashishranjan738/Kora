import { Badge, Tooltip } from "@mantine/core";
import { useCallback } from "react";
import { useWebSocket } from "../hooks/useWebSocket";
import { useMessageBufferStore, type BufferState } from "../stores/messageBufferStore";

// ── Typed WebSocket events ──────────────────────────────────

interface MessageBufferedEvent {
  event: "message-buffered";
  agentId: string;
  queueSize: number;
}

interface MessageExpiredEvent {
  event: "message-expired";
  agentId: string;
  priority: string;
}

type BufferEvent = MessageBufferedEvent | MessageExpiredEvent;

function isBufferEvent(event: unknown): event is BufferEvent {
  if (!event || typeof event !== "object") return false;
  const e = event as Record<string, unknown>;
  return e.event === "message-buffered" || e.event === "message-expired";
}

// ── Hook: listen for buffer/expiry WebSocket events ─────────

/**
 * Listens for message-buffered and message-expired WebSocket events
 * and updates the Zustand messageBufferStore. Call once at session level.
 */
export function useMessageBufferEvents() {
  const setBuffered = useMessageBufferStore((s) => s.setBuffered);
  const addExpired = useMessageBufferStore((s) => s.addExpired);

  const handleWsEvent = useCallback(
    (raw: unknown) => {
      if (!isBufferEvent(raw)) return;

      if (raw.event === "message-buffered") {
        setBuffered(raw.agentId, raw.queueSize);
      } else if (raw.event === "message-expired") {
        addExpired(raw.agentId);
      }
    },
    [setBuffered, addExpired]
  );

  useWebSocket(handleWsEvent);
}

// ── Component: badge on agent cards ──────────────────────────

interface MessageBufferBadgeProps {
  agentId: string;
}

/**
 * Badge showing buffered/expired message count for an agent.
 * Uses agent-specific Zustand selector to avoid over-rendering.
 * Shows nothing when no messages are buffered or expired.
 */
export function MessageBufferBadge({ agentId }: MessageBufferBadgeProps) {
  const state: BufferState | undefined = useMessageBufferStore(
    (s) => s.buffers.get(agentId)
  );

  if (!state || (state.queueSize === 0 && state.expiredCount === 0)) return null;

  if (state.expiredCount > 0) {
    return (
      <Tooltip
        label={`${state.expiredCount} message${state.expiredCount !== 1 ? "s" : ""} expired (delivery failed).${state.queueSize > 0 ? ` ${state.queueSize} still buffered.` : ""}`}
        withArrow
        position="bottom"
      >
        <Badge variant="filled" color="red" size="xs" style={{ cursor: "default" }}>
          {state.expiredCount} expired
        </Badge>
      </Tooltip>
    );
  }

  return (
    <Tooltip
      label={`${state.queueSize} message${state.queueSize !== 1 ? "s" : ""} buffered (rate limited)`}
      withArrow
      position="bottom"
    >
      <Badge
        variant="light"
        color="yellow"
        size="xs"
        style={{ cursor: "default", animation: "tl-pulse 2s infinite" }}
      >
        {state.queueSize} buffered
      </Badge>
    </Tooltip>
  );
}
