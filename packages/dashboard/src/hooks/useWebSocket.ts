import { useEffect, useRef, useState, useCallback } from "react";

export function useWebSocket(onEvent: (event: any) => void) {
  const [connected, setConnected] = useState(false);
  const [reconnecting, setReconnecting] = useState(false);
  const wsRef = useRef<WebSocket | null>(null);
  const retriesRef = useRef(0);
  const onEventRef = useRef(onEvent);
  const subscribedSessionsRef = useRef<Set<string>>(new Set());
  onEventRef.current = onEvent;

  const subscribe = useCallback((sessionId: string) => {
    if (!sessionId) return;
    if (subscribedSessionsRef.current.has(sessionId)) return;

    if (wsRef.current?.readyState === WebSocket.OPEN) {
      wsRef.current.send(JSON.stringify({ type: "subscribe", sessionId }));
      subscribedSessionsRef.current.add(sessionId);
      console.debug('[ws] subscribed to session', sessionId);
    } else {
      // Queue for when connection opens
      subscribedSessionsRef.current.add(sessionId);
    }
  }, []);

  const unsubscribe = useCallback((sessionId: string) => {
    if (!sessionId) return;
    if (!subscribedSessionsRef.current.has(sessionId)) return;

    if (wsRef.current?.readyState === WebSocket.OPEN) {
      wsRef.current.send(JSON.stringify({ type: "unsubscribe", sessionId }));
      subscribedSessionsRef.current.delete(sessionId);
      console.debug('[ws] unsubscribed from session', sessionId);
    } else {
      subscribedSessionsRef.current.delete(sessionId);
    }
  }, []);

  useEffect(() => {
    let unmounted = false;
    let reconnectTimer: ReturnType<typeof setTimeout>;

    function getToken(): string {
      const injected = (window as any).__KORA_TOKEN__ as string | undefined;
      if (injected) return injected;
      const params = new URLSearchParams(window.location.search);
      return params.get("token") || localStorage.getItem("kora_token") || "";
    }

    function connect() {
      if (unmounted) return;

      const protocol = window.location.protocol === "https:" ? "wss:" : "ws:";
      const host = window.location.host;
      const token = getToken();
      const url = `${protocol}//${host}/ws/events?token=${encodeURIComponent(token)}`;

      console.debug('[ws] connecting to', url);
      const ws = new WebSocket(url);
      wsRef.current = ws;

      ws.onopen = () => {
        if (unmounted) return;
        console.debug('[ws] connected');
        setConnected(true);
        setReconnecting(false);
        retriesRef.current = 0;

        // Re-subscribe to any sessions that were subscribed before disconnect
        for (const sessionId of subscribedSessionsRef.current) {
          ws.send(JSON.stringify({ type: "subscribe", sessionId }));
          console.debug('[ws] re-subscribed to session', sessionId);
        }
      };

      ws.onmessage = (event) => {
        if (unmounted) return;
        try {
          const data = JSON.parse(event.data);
          onEventRef.current(data);
        } catch {
          // ignore non-JSON messages
        }
      };

      ws.onclose = () => {
        if (unmounted) return;
        console.debug('[ws] disconnected, scheduling reconnect');
        setConnected(false);
        scheduleReconnect();
      };

      ws.onerror = () => {
        if (unmounted) return;
        console.warn('[ws] connection error');
        ws.close();
      };
    }

    function scheduleReconnect() {
      setReconnecting(true);
      const delay = Math.min(1000 * Math.pow(2, retriesRef.current), 30000);
      retriesRef.current += 1;
      reconnectTimer = setTimeout(connect, delay);
    }

    connect();

    return () => {
      unmounted = true;
      clearTimeout(reconnectTimer);
      if (wsRef.current) {
        wsRef.current.close();
      }
    };
  }, []);

  return { connected, reconnecting, subscribe, unsubscribe };
}
