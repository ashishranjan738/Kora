import { Badge, Tooltip } from "@mantine/core";
import { useEffect, useState, useCallback } from "react";
import { useWebSocket } from "../hooks/useWebSocket";

interface BufferState {
  /** Number of messages currently buffered for this agent */
  queueSize: number;
  /** Number of messages expired (lost) since last reset */
  expiredCount: number;
  /** Last update timestamp */
  lastUpdate: number;
}

/** Global buffer state keyed by agentId */
const bufferStates = new Map<string, BufferState>();

/** Listeners that want to be notified of buffer state changes */
const listeners = new Set<() => void>();

function notifyListeners() {
  listeners.forEach((fn) => fn());
}

function getBufferState(agentId: string): BufferState {
  return bufferStates.get(agentId) || { queueSize: 0, expiredCount: 0, lastUpdate: 0 };
}

/**
 * Hook to listen for message-buffered and message-expired WebSocket events
 * and maintain per-agent buffer state. Call once at app/session level.
 */
export function useMessageBufferEvents() {
  const handleWsEvent = useCallback((event: any) => {
    if (event.event === "message-buffered" || event.type === "message-buffered") {
      const agentId = event.agentId || event.data?.agentId;
      const queueSize = event.queueSize || event.data?.queueSize || 0;
      if (!agentId) return;

      const prev = getBufferState(agentId);
      bufferStates.set(agentId, {
        ...prev,
        queueSize,
        lastUpdate: Date.now(),
      });
      notifyListeners();
    }

    if (event.event === "message-expired" || event.type === "message-expired") {
      const agentId = event.agentId || event.data?.agentId;
      if (!agentId) return;

      const prev = getBufferState(agentId);
      bufferStates.set(agentId, {
        ...prev,
        expiredCount: prev.expiredCount + 1,
        lastUpdate: Date.now(),
      });
      notifyListeners();
    }
  }, []);

  useWebSocket(handleWsEvent);
}

/**
 * Hook to get buffer state for a specific agent. Re-renders on changes.
 */
export function useAgentBufferState(agentId: string): BufferState {
  const [, setTick] = useState(0);

  useEffect(() => {
    const listener = () => setTick((t) => t + 1);
    listeners.add(listener);
    return () => { listeners.delete(listener); };
  }, []);

  return getBufferState(agentId);
}

/**
 * Badge component showing buffered message count for an agent.
 * Shows nothing when no messages are buffered.
 */
interface MessageBufferBadgeProps {
  agentId: string;
}

export function MessageBufferBadge({ agentId }: MessageBufferBadgeProps) {
  const state = useAgentBufferState(agentId);

  if (state.queueSize === 0 && state.expiredCount === 0) return null;

  // Show warning if messages are expiring
  if (state.expiredCount > 0) {
    return (
      <Tooltip
        label={`${state.expiredCount} message${state.expiredCount !== 1 ? "s" : ""} expired (delivery failed). ${state.queueSize > 0 ? `${state.queueSize} still buffered.` : ""}`}
        withArrow
        position="bottom"
      >
        <Badge
          variant="filled"
          color="red"
          size="xs"
          styles={{ root: { cursor: "default" } }}
        >
          {state.expiredCount} expired
        </Badge>
      </Tooltip>
    );
  }

  // Show buffered count
  return (
    <Tooltip
      label={`${state.queueSize} message${state.queueSize !== 1 ? "s" : ""} buffered (rate limited — will deliver when slot opens)`}
      withArrow
      position="bottom"
    >
      <Badge
        variant="light"
        color="yellow"
        size="xs"
        styles={{ root: { cursor: "default", animation: "tl-pulse 2s infinite" } }}
      >
        {state.queueSize} buffered
      </Badge>
    </Tooltip>
  );
}

/**
 * Toast-style notification component for expired messages.
 * Mount at session level — shows a dismissable warning when messages expire.
 */
interface MessageExpiryToastProps {
  /** Called when user dismisses */
  onDismiss: () => void;
  agentName?: string;
  count: number;
}

export function MessageExpiryToast({ onDismiss, agentName, count }: MessageExpiryToastProps) {
  return (
    <div className="msg-expiry-toast" onClick={onDismiss}>
      <span style={{ fontWeight: 600, color: "var(--accent-red)" }}>
        {count} message{count !== 1 ? "s" : ""} expired
      </span>
      {agentName && (
        <span style={{ color: "var(--text-secondary)", marginLeft: 6 }}>
          for {agentName}
        </span>
      )}
      <span style={{ color: "var(--text-muted)", marginLeft: 8, fontSize: 11 }}>
        Click to dismiss
      </span>
    </div>
  );
}
