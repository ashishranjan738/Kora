import { useState, useCallback, useEffect } from "react";
import { useWebSocket } from "./useWebSocket";

export interface Notification {
  id: string;
  type: string;
  title: string;
  body: string;
  agentId?: string;
  timestamp: number;
  read?: boolean;
}

export function useNotifications(sessionId: string | undefined) {
  const [notifications, setNotifications] = useState<Notification[]>([]);

  const handleEvent = useCallback((event: any) => {
    if (event.event === "notification" && event.notification) {
      setNotifications((prev) => {
        const newNotif = { ...event.notification, read: false };

        // Prevent duplicates: check if notification with same ID already exists
        if (prev.some((n) => n.id === newNotif.id)) {
          return prev;
        }

        // Add to beginning, keep only last 20
        const updated = [newNotif, ...prev].slice(0, 20);
        return updated;
      });
    }
  }, []);

  const { subscribe, unsubscribe } = useWebSocket(handleEvent);

  useEffect(() => {
    if (sessionId) {
      subscribe(sessionId);
      return () => unsubscribe(sessionId);
    }
  }, [sessionId, subscribe, unsubscribe]);

  const markAsRead = useCallback((id: string) => {
    setNotifications((prev) =>
      prev.map((n) => (n.id === id ? { ...n, read: true } : n))
    );
  }, []);

  const markAllAsRead = useCallback(() => {
    setNotifications((prev) => prev.map((n) => ({ ...n, read: true })));
  }, []);

  const clearAll = useCallback(() => {
    setNotifications([]);
  }, []);

  const unreadCount = notifications.filter((n) => !n.read).length;

  return {
    notifications,
    unreadCount,
    markAsRead,
    markAllAsRead,
    clearAll,
  };
}
