import { useParams } from "react-router-dom";
import { useState, useEffect } from "react";
import { Loader } from "@mantine/core";
import { TaskBoard } from "../components/TaskBoard";

export function TaskBoardPage() {
  const { sessionId } = useParams();
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    // Simulate initial load delay to show loading state
    const timer = setTimeout(() => setLoading(false), 100);
    return () => clearTimeout(timer);
  }, [sessionId]);

  if (!sessionId) return <div>Session not found</div>;

  if (loading) {
    return (
      <div style={{ display: "flex", justifyContent: "center", alignItems: "center", padding: 60 }}>
        <Loader size="lg" />
      </div>
    );
  }

  return (
    <div style={{ padding: 24 }}>
      <h2 style={{ color: "#e6edf3", margin: "0 0 16px 0" }}>Task Board</h2>
      <TaskBoard sessionId={sessionId} />
    </div>
  );
}
