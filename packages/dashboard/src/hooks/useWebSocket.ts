import { useEffect, useRef, useState } from "react";

export function useWebSocket(onEvent: (event: any) => void) {
  const [connected, setConnected] = useState(false);
  const [reconnecting, setReconnecting] = useState(false);
  const wsRef = useRef<WebSocket | null>(null);
  const retriesRef = useRef(0);
  const onEventRef = useRef(onEvent);
  onEventRef.current = onEvent;

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
      const url = `${protocol}//${host}/?token=${encodeURIComponent(token)}`;

      const ws = new WebSocket(url);
      wsRef.current = ws;

      ws.onopen = () => {
        if (unmounted) return;
        setConnected(true);
        setReconnecting(false);
        retriesRef.current = 0;
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
        setConnected(false);
        scheduleReconnect();
      };

      ws.onerror = () => {
        if (unmounted) return;
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

  return { connected, reconnecting };
}
