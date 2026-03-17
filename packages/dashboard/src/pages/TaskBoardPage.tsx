import { useParams } from "react-router-dom";
import { TaskBoard } from "../components/TaskBoard";

export function TaskBoardPage() {
  const { sessionId } = useParams();
  if (!sessionId) return <div>Session not found</div>;
  return (
    <div style={{ padding: 24 }}>
      <h2 style={{ color: "#e6edf3", margin: "0 0 16px 0" }}>Task Board</h2>
      <TaskBoard sessionId={sessionId} />
    </div>
  );
}
