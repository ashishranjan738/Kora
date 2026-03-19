import { useState, useCallback, useEffect } from "react";
import { useWebSocket } from "./useWebSocket";
import { useApi } from "./useApi";

export interface ApprovalRequest {
  id: string;
  agentId: string;
  action: string;
  description: string;
  timestamp: number;
  status: "pending" | "approved" | "rejected";
}

export function useApprovalRequests(sessionId: string | undefined) {
  const [requests, setRequests] = useState<ApprovalRequest[]>([]);
  const api = useApi();

  const handleEvent = useCallback((event: any) => {
    if (event.event === "approval-request" && event.request) {
      setRequests((prev) => {
        // Check if request already exists
        const exists = prev.some((r) => r.id === event.request.id);
        if (exists) return prev;

        // Add new request at the beginning
        return [event.request, ...prev];
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

  const approve = useCallback(
    async (agentId: string, requestId: string) => {
      if (!sessionId) return;

      try {
        await api.approveRequest(sessionId, agentId, requestId);

        // Update local state
        setRequests((prev) =>
          prev.map((r) =>
            r.id === requestId ? { ...r, status: "approved" as const } : r
          )
        );
      } catch (err) {
        console.error("Failed to approve request:", err);
        throw err;
      }
    },
    [sessionId, api]
  );

  const reject = useCallback(
    async (agentId: string, requestId: string) => {
      if (!sessionId) return;

      try {
        await api.rejectRequest(sessionId, agentId, requestId);

        // Update local state
        setRequests((prev) =>
          prev.map((r) =>
            r.id === requestId ? { ...r, status: "rejected" as const } : r
          )
        );
      } catch (err) {
        console.error("Failed to reject request:", err);
        throw err;
      }
    },
    [sessionId, api]
  );

  const getPendingForAgent = useCallback(
    (agentId: string) => {
      return requests.filter((r) => r.agentId === agentId && r.status === "pending");
    },
    [requests]
  );

  const getHistoryForAgent = useCallback(
    (agentId: string) => {
      return requests.filter((r) => r.agentId === agentId);
    },
    [requests]
  );

  const pendingCount = requests.filter((r) => r.status === "pending").length;

  return {
    requests,
    pendingCount,
    approve,
    reject,
    getPendingForAgent,
    getHistoryForAgent,
  };
}
