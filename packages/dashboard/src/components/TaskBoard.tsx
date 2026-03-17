import { useState, useEffect, useCallback } from "react";
import { useApi } from "../hooks/useApi";

interface TaskComment {
  id: string;
  text: string;
  author: string;
  authorName?: string;
  createdAt: string;
}

interface Task {
  id: string;
  title: string;
  description: string;
  status: string;
  assignedTo?: string;
  createdBy: string;
  createdAt: string;
  comments?: TaskComment[];
  dependencies?: string[];
  blocked?: boolean;
  blockedReason?: string;
}

interface TaskBoardProps {
  sessionId: string;
}

const COLUMNS = ["pending", "in-progress", "review", "done"];
const COLUMN_LABELS: Record<string, string> = {
  pending: "Pending",
  "in-progress": "In Progress",
  review: "Review",
  done: "Done",
};
const COLUMN_COLORS: Record<string, string> = {
  pending: "var(--text-muted)",
  "in-progress": "var(--accent-blue)",
  review: "var(--accent-yellow)",
  done: "var(--accent-green)",
};

function timeAgo(dateStr: string): string {
  const now = Date.now();
  const then = new Date(dateStr).getTime();
  const seconds = Math.floor((now - then) / 1000);
  if (seconds < 60) return `${seconds}s ago`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  return `${days}d ago`;
}

export function TaskBoard({ sessionId }: TaskBoardProps) {
  const api = useApi();
  const [tasks, setTasks] = useState<Task[]>([]);
  const [agents, setAgents] = useState<{ id: string; name: string }[]>([]);
  const [dragOverColumn, setDragOverColumn] = useState<string | null>(null);
  const [draggedTaskId, setDraggedTaskId] = useState<string | null>(null);
  const [showAddDialog, setShowAddDialog] = useState(false);
  const [newTitle, setNewTitle] = useState("");
  const [newDescription, setNewDescription] = useState("");
  const [newAssignee, setNewAssignee] = useState("");
  const [expandedTaskId, setExpandedTaskId] = useState<string | null>(null);
  const [commentText, setCommentText] = useState("");
  const [newDependencies, setNewDependencies] = useState<string[]>([]);

  const fetchTasks = useCallback(async () => {
    try {
      const data = await api.getTasks(sessionId);
      setTasks(data.tasks || []);
    } catch {
      // API may not have tasks yet
    }
  }, [sessionId]);

  const fetchAgents = useCallback(async () => {
    try {
      const data = await api.getAgents(sessionId);
      setAgents(
        (data.agents || []).map((a: any) => ({ id: a.id, name: a.config?.name || a.name || a.id }))
      );
    } catch {}
  }, [sessionId]);

  useEffect(() => {
    fetchTasks();
    fetchAgents();
  }, [fetchTasks, fetchAgents]);

  // Auto-refresh every 5s
  useEffect(() => {
    const interval = setInterval(fetchTasks, 5000);
    return () => clearInterval(interval);
  }, [fetchTasks]);

  const handleDragStart = (taskId: string) => setDraggedTaskId(taskId);

  const handleDragOver = (e: React.DragEvent, column: string) => {
    e.preventDefault();
    setDragOverColumn(column);
  };

  const handleDrop = async (e: React.DragEvent, column: string) => {
    e.preventDefault();
    setDragOverColumn(null);
    if (!draggedTaskId) return;
    const task = tasks.find((t) => t.id === draggedTaskId);
    if (!task || task.status === column) { setDraggedTaskId(null); return; }

    if (task.blocked && column === "in-progress") {
      alert(`Cannot start: ${task.blockedReason || "This task has incomplete dependencies"}`);
      setDraggedTaskId(null);
      return;
    }

    setTasks((prev) => prev.map((t) => (t.id === draggedTaskId ? { ...t, status: column } : t)));
    try {
      await api.updateTask(sessionId, draggedTaskId, { status: column });
    } catch {
      fetchTasks();
    }
    setDraggedTaskId(null);
  };

  const handleAddTask = async () => {
    if (!newTitle.trim()) return;
    try {
      await api.createTask(sessionId, {
        title: newTitle.trim(),
        description: newDescription.trim(),
        assignedTo: newAssignee || undefined,
        dependencies: newDependencies.length > 0 ? newDependencies : undefined,
      });
      setNewTitle("");
      setNewDescription("");
      setNewAssignee("");
      setNewDependencies([]);
      setShowAddDialog(false);
      fetchTasks();
    } catch {}
  };

  const handleDeleteTask = async (taskId: string) => {
    if (!confirm("Delete this task?")) return;
    setTasks((prev) => prev.filter((t) => t.id !== taskId));
    try {
      await api.deleteTask(sessionId, taskId);
    } catch {
      fetchTasks();
    }
  };

  const handleAddComment = async (taskId: string) => {
    if (!commentText.trim()) return;
    try {
      await api.addTaskComment(sessionId, taskId, commentText.trim());
      setCommentText("");
      fetchTasks();
    } catch {}
  };

  const handleChangeStatus = async (taskId: string, newStatus: string) => {
    const task = tasks.find((t) => t.id === taskId);
    if (!task || task.status === newStatus) return;
    if (task.blocked && newStatus === "in-progress") {
      alert(`Cannot start: ${task.blockedReason || "This task has incomplete dependencies"}`);
      return;
    }
    setTasks((prev) => prev.map((t) => (t.id === taskId ? { ...t, status: newStatus } : t)));
    try {
      await api.updateTask(sessionId, taskId, { status: newStatus });
    } catch {
      fetchTasks();
    }
  };

  const tasksByColumn = (column: string) => tasks.filter((t) => t.status === column);
  const expandedTask = expandedTaskId ? tasks.find((t) => t.id === expandedTaskId) : null;

  return (
    <div style={{ position: "relative" }}>
      {tasks.length === 0 && !showAddDialog && (
        <div style={{ textAlign: "center", padding: "60px 20px", color: "var(--text-muted)" }}>
          <div style={{ fontSize: 48, marginBottom: 16 }}>-- No tasks yet --</div>
          <p style={{ fontSize: 16, marginBottom: 24 }}>
            Create your first task to start organizing work for your agents.
          </p>
          <button className="primary" onClick={() => setShowAddDialog(true)}>
            + Add Task
          </button>
        </div>
      )}

      {(tasks.length > 0 || showAddDialog) && (
        <div style={{ display: "grid", gridTemplateColumns: `repeat(${COLUMNS.length}, 1fr)`, gap: 16, minHeight: 400 }}>
          {COLUMNS.map((col) => (
            <div
              key={col}
              onDragOver={(e) => handleDragOver(e, col)}
              onDragLeave={() => setDragOverColumn(null)}
              onDrop={(e) => handleDrop(e, col)}
              style={{
                background: dragOverColumn === col ? "rgba(88,166,255,0.06)" : "var(--bg-secondary)",
                borderRadius: 8,
                border: dragOverColumn === col ? "2px dashed var(--accent-blue)" : "1px solid var(--border-color)",
                padding: 12,
                minHeight: 300,
                transition: "border 0.15s, background 0.15s",
              }}
            >
              {/* Column Header */}
              <div style={{
                display: "flex", alignItems: "center", justifyContent: "space-between",
                marginBottom: 12, paddingBottom: 8,
                borderBottom: `2px solid ${COLUMN_COLORS[col]}`,
              }}>
                <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
                  <span style={{ width: 10, height: 10, borderRadius: "50%", background: COLUMN_COLORS[col], display: "inline-block" }} />
                  <span style={{ fontWeight: 600, color: "var(--text-primary)", fontSize: 14 }}>{COLUMN_LABELS[col]}</span>
                  <span style={{ background: "var(--bg-tertiary)", color: "var(--text-muted)", borderRadius: 10, padding: "1px 8px", fontSize: 12 }}>
                    {tasksByColumn(col).length}
                  </span>
                </div>
                {col === "pending" && (
                  <button
                    onClick={() => setShowAddDialog(true)}
                    style={{
                      background: "none", border: "1px solid var(--border-color)", color: "var(--text-secondary)",
                      borderRadius: 4, padding: "2px 8px", fontSize: 12, cursor: "pointer",
                    }}
                  >
                    + Add
                  </button>
                )}
              </div>

              {/* Task Cards */}
              {tasksByColumn(col).map((task) => (
                <div
                  key={task.id}
                  draggable
                  onDragStart={() => handleDragStart(task.id)}
                  onClick={(e) => { if (!(e.target as HTMLElement).closest("button")) setExpandedTaskId(task.id); }}
                  style={{
                    background: "var(--bg-primary)",
                    border: draggedTaskId === task.id ? "1px solid var(--accent-blue)" : "1px solid var(--border-color)",
                    borderRadius: 8,
                    padding: 12,
                    marginBottom: 8,
                    cursor: "pointer",
                    opacity: draggedTaskId === task.id ? 0.5 : task.blocked ? 0.7 : 1,
                    transition: "border 0.15s, box-shadow 0.15s",
                  }}
                >
                  <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start", marginBottom: 2 }}>
                    <div style={{ fontWeight: 600, color: "var(--text-primary)", fontSize: 13, flex: 1 }}>{task.title}</div>
                    <button
                      onClick={(e) => { e.stopPropagation(); handleDeleteTask(task.id); }}
                      style={{
                        background: "none", border: "none", color: "var(--text-muted)", cursor: "pointer",
                        padding: "0 2px", fontSize: 12, opacity: 0.4, lineHeight: 1,
                      }}
                      onMouseEnter={(e) => { e.currentTarget.style.opacity = "1"; e.currentTarget.style.color = "var(--accent-red)"; }}
                      onMouseLeave={(e) => { e.currentTarget.style.opacity = "0.4"; e.currentTarget.style.color = "var(--text-muted)"; }}
                      title="Delete task"
                    >
                      ×
                    </button>
                  </div>
                  <div style={{ fontSize: 10, color: "var(--text-muted)", fontFamily: "var(--font-mono)", marginBottom: 4 }}>
                    #{task.id}
                  </div>
                  {task.blocked && (
                    <div
                      title={task.blockedReason || "This task has incomplete dependencies"}
                      style={{
                        display: "inline-flex",
                        alignItems: "center",
                        gap: 4,
                        fontSize: 11,
                        color: "var(--accent-yellow)",
                        backgroundColor: "rgba(210, 153, 34, 0.1)",
                        borderRadius: 4,
                        padding: "2px 8px",
                        marginBottom: 6,
                      }}
                    >
                      <span style={{ fontSize: 12 }}>&#128274;</span> Blocked
                    </div>
                  )}
                  {task.description && (
                    <div style={{ color: "var(--text-secondary)", fontSize: 12, marginBottom: 8, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                      {task.description.length > 80 ? task.description.slice(0, 80) + "..." : task.description}
                    </div>
                  )}
                  <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", fontSize: 11, color: "var(--text-muted)" }}>
                    <span>
                      {task.assignedTo
                        ? agents.find((a) => a.id === task.assignedTo)?.name || task.assignedTo
                        : "Unassigned"}
                    </span>
                    <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
                      {task.comments && task.comments.length > 0 && (
                        <span style={{ color: "var(--accent-blue)" }}>💬 {task.comments.length}</span>
                      )}
                      <span>{timeAgo(task.createdAt)}</span>
                    </div>
                  </div>
                </div>
              ))}
            </div>
          ))}
        </div>
      )}

      {/* Add Task Dialog */}
      {showAddDialog && (
        <div className="dialog-overlay" onClick={() => setShowAddDialog(false)}>
          <div className="dialog" onClick={(e) => e.stopPropagation()}>
            <h2>Add New Task</h2>
            <div className="form-group">
              <label>Title *</label>
              <input
                type="text"
                value={newTitle}
                onChange={(e) => setNewTitle(e.target.value)}
                placeholder="Task title"
                autoFocus
                onKeyDown={(e) => { if (e.key === "Enter" && newTitle.trim()) handleAddTask(); }}
              />
            </div>
            <div className="form-group">
              <label>Description</label>
              <textarea
                value={newDescription}
                onChange={(e) => setNewDescription(e.target.value)}
                placeholder="Optional description"
                rows={3}
                style={{
                  width: "100%", background: "var(--bg-tertiary)", border: "1px solid var(--border-color)",
                  borderRadius: 6, padding: "8px 12px", color: "var(--text-primary)", fontSize: 14,
                  outline: "none", resize: "vertical", fontFamily: "inherit", boxSizing: "border-box",
                }}
              />
            </div>
            <div className="form-group">
              <label>Assign to Agent</label>
              <select value={newAssignee} onChange={(e) => setNewAssignee(e.target.value)}>
                <option value="">Unassigned</option>
                {agents.map((a) => (
                  <option key={a.id} value={a.id}>{a.name}</option>
                ))}
              </select>
            </div>
            {tasks.length > 0 && (
              <div className="form-group">
                <label>Dependencies (blocks this task)</label>
                <div style={{
                  maxHeight: 150,
                  overflowY: "auto",
                  border: "1px solid var(--border-color)",
                  borderRadius: 6,
                  background: "var(--bg-tertiary)",
                }}>
                  {tasks.filter((t) => t.status !== "done").map((t) => (
                    <label
                      key={t.id}
                      style={{
                        display: "flex",
                        alignItems: "center",
                        gap: 8,
                        padding: "8px 12px",
                        fontSize: 13,
                        cursor: "pointer",
                        minHeight: 44,
                        borderBottom: "1px solid var(--border-color)",
                        color: "var(--text-primary)",
                      }}
                    >
                      <input
                        type="checkbox"
                        checked={newDependencies.includes(t.id)}
                        onChange={(e) => {
                          if (e.target.checked) {
                            setNewDependencies((prev) => [...prev, t.id]);
                          } else {
                            setNewDependencies((prev) => prev.filter((d) => d !== t.id));
                          }
                        }}
                      />
                      <span style={{ flex: 1 }}>{t.title}</span>
                      <span style={{
                        fontSize: 11,
                        color: COLUMN_COLORS[t.status] || "var(--text-muted)",
                        fontWeight: 500,
                      }}>
                        {COLUMN_LABELS[t.status] || t.status}
                      </span>
                    </label>
                  ))}
                  {tasks.filter((t) => t.status !== "done").length === 0 && (
                    <div style={{ padding: "12px", fontSize: 12, color: "var(--text-muted)", fontStyle: "italic" }}>
                      No incomplete tasks to depend on.
                    </div>
                  )}
                </div>
              </div>
            )}
            <div className="form-actions">
              <button onClick={() => { setShowAddDialog(false); setNewTitle(""); setNewDescription(""); setNewAssignee(""); setNewDependencies([]); }}>
                Cancel
              </button>
              <button className="primary" onClick={handleAddTask} disabled={!newTitle.trim()}>
                Create Task
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Task Detail Dialog */}
      {expandedTask && (
        <div className="dialog-overlay" onClick={() => { setExpandedTaskId(null); setCommentText(""); }}>
          <div className="dialog" onClick={(e) => e.stopPropagation()} style={{ maxWidth: 600, width: "90%" }}>
            {/* Header with title + ID */}
            <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start", marginBottom: 4 }}>
              <h2 style={{ margin: 0, flex: 1 }}>{expandedTask.title}</h2>
              <button
                onClick={() => { setExpandedTaskId(null); setCommentText(""); }}
                style={{
                  background: "none", border: "none", color: "var(--text-muted)", cursor: "pointer",
                  padding: "0 4px", fontSize: 20, lineHeight: 1,
                }}
              >
                ×
              </button>
            </div>
            <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 16 }}>
              <span
                style={{
                  fontFamily: "var(--font-mono)", fontSize: 12, color: "var(--accent-blue)",
                  background: "var(--bg-tertiary)", padding: "2px 8px", borderRadius: 4, cursor: "pointer",
                  userSelect: "all",
                }}
                title="Click to copy task ID"
                onClick={() => { navigator.clipboard.writeText(expandedTask.id); }}
              >
                #{expandedTask.id}
              </span>
              <span style={{ fontSize: 11, color: "var(--text-muted)" }}>
                Created {timeAgo(expandedTask.createdAt)} by {expandedTask.createdBy}
              </span>
            </div>

            {/* Task Details */}
            <div style={{ marginBottom: 16, padding: 12, background: "var(--bg-tertiary)", borderRadius: 8, display: "flex", flexDirection: "column", gap: 8 }}>
              <div style={{ display: "flex", alignItems: "center", gap: 8, fontSize: 13 }}>
                <strong style={{ color: "var(--text-secondary)", minWidth: 80 }}>Status:</strong>
                <span style={{ color: COLUMN_COLORS[expandedTask.status] || "var(--text-primary)", fontWeight: 600 }}>
                  {COLUMN_LABELS[expandedTask.status] || expandedTask.status}
                </span>
              </div>
              <div style={{ display: "flex", alignItems: "center", gap: 8, fontSize: 13 }}>
                <strong style={{ color: "var(--text-secondary)", minWidth: 80 }}>Assigned to:</strong>
                <span style={{ color: "var(--text-primary)" }}>
                  {expandedTask.assignedTo
                    ? agents.find((a) => a.id === expandedTask.assignedTo)?.name || expandedTask.assignedTo
                    : "Unassigned"}
                </span>
              </div>
              {expandedTask.description && (
                <div style={{ fontSize: 13 }}>
                  <strong style={{ color: "var(--text-secondary)" }}>Description:</strong>
                  <div style={{ marginTop: 4, color: "var(--text-primary)", lineHeight: 1.5 }}>{expandedTask.description}</div>
                </div>
              )}
            </div>

            {/* Change Status */}
            <div style={{ marginBottom: 16 }}>
              <label style={{ display: "block", marginBottom: 8, fontSize: 13, fontWeight: 600 }}>Change Status</label>
              <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
                {COLUMNS.map((col) => (
                  <button
                    key={col}
                    onClick={() => handleChangeStatus(expandedTask.id, col)}
                    disabled={expandedTask.status === col}
                    style={{
                      padding: "6px 12px",
                      fontSize: 12,
                      borderRadius: 6,
                      border: `1px solid ${COLUMN_COLORS[col]}`,
                      background: expandedTask.status === col ? COLUMN_COLORS[col] : "var(--bg-secondary)",
                      color: expandedTask.status === col ? "var(--bg-primary)" : COLUMN_COLORS[col],
                      cursor: expandedTask.status === col ? "default" : "pointer",
                      fontWeight: 600,
                      opacity: expandedTask.status === col ? 1 : 0.8,
                    }}
                  >
                    {COLUMN_LABELS[col]}
                  </button>
                ))}
              </div>
            </div>

            {/* Dependencies Section */}
            {expandedTask.dependencies && expandedTask.dependencies.length > 0 && (
              <div style={{ marginBottom: 16 }}>
                <label style={{ display: "block", marginBottom: 8, fontSize: 13, fontWeight: 600 }}>
                  Dependencies ({expandedTask.dependencies.length})
                </label>
                <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
                  {expandedTask.dependencies.map((depId) => {
                    const depTask = tasks.find((t) => t.id === depId);
                    const isDone = depTask?.status === "done";
                    return (
                      <div
                        key={depId}
                        style={{
                          display: "flex",
                          alignItems: "center",
                          gap: 8,
                          padding: "6px 10px",
                          background: "var(--bg-tertiary)",
                          borderRadius: 6,
                          fontSize: 13,
                          minHeight: 44,
                          cursor: depTask ? "pointer" : "default",
                        }}
                        onClick={() => {
                          if (depTask) setExpandedTaskId(depId);
                        }}
                      >
                        <span style={{ fontSize: 14 }}>{isDone ? "\u2705" : "\u23F3"}</span>
                        <span style={{
                          color: isDone ? "var(--accent-green)" : "var(--text-primary)",
                          textDecoration: isDone ? "line-through" : "none",
                          flex: 1,
                        }}>
                          {depTask?.title || depId}
                        </span>
                        <span style={{
                          fontSize: 11,
                          color: isDone ? "var(--accent-green)" : "var(--text-muted)",
                          fontWeight: 500,
                        }}>
                          {isDone ? "Done" : depTask ? COLUMN_LABELS[depTask.status] || depTask.status : "Unknown"}
                        </span>
                      </div>
                    );
                  })}
                </div>
              </div>
            )}

            {/* Blocked indicator in detail */}
            {expandedTask.blocked && (
              <div style={{
                marginBottom: 16,
                padding: "10px 12px",
                borderRadius: 6,
                backgroundColor: "rgba(210, 153, 34, 0.1)",
                border: "1px solid var(--accent-yellow)",
                color: "var(--accent-yellow)",
                fontSize: 13,
                display: "flex",
                alignItems: "center",
                gap: 8,
              }}>
                <span style={{ fontSize: 16 }}>&#128274;</span>
                <span>{expandedTask.blockedReason || "This task is blocked by incomplete dependencies"}</span>
              </div>
            )}

            {/* Comments Section */}
            <div style={{ borderTop: "1px solid var(--border-color)", paddingTop: 16 }}>
              <h3 style={{ margin: "0 0 12px 0", fontSize: 15, fontWeight: 600 }}>
                Comments {expandedTask.comments && expandedTask.comments.length > 0 && `(${expandedTask.comments.length})`}
              </h3>

              {/* Comments List */}
              <div style={{ maxHeight: 300, overflowY: "auto", marginBottom: 12 }}>
                {expandedTask.comments && expandedTask.comments.length > 0 ? (
                  expandedTask.comments.map((comment) => (
                    <div
                      key={comment.id}
                      style={{
                        padding: 10,
                        background: "var(--bg-tertiary)",
                        borderRadius: 6,
                        marginBottom: 8,
                        fontSize: 13,
                      }}
                    >
                      <div style={{ display: "flex", justifyContent: "space-between", marginBottom: 6 }}>
                        <strong style={{ color: "var(--accent-blue)" }}>{comment.authorName || comment.author}</strong>
                        <span style={{ color: "var(--text-muted)", fontSize: 11 }}>{timeAgo(comment.createdAt)}</span>
                      </div>
                      <div style={{ color: "var(--text-primary)" }}>{comment.text}</div>
                    </div>
                  ))
                ) : (
                  <div style={{ color: "var(--text-muted)", fontSize: 13, fontStyle: "italic", padding: "20px 0" }}>
                    No comments yet. Be the first to add one!
                  </div>
                )}
              </div>

              {/* Add Comment */}
              <div>
                <textarea
                  value={commentText}
                  onChange={(e) => setCommentText(e.target.value)}
                  placeholder="Add a comment..."
                  rows={2}
                  style={{
                    width: "100%", background: "var(--bg-tertiary)", border: "1px solid var(--border-color)",
                    borderRadius: 6, padding: "8px 12px", color: "var(--text-primary)", fontSize: 13,
                    outline: "none", resize: "vertical", fontFamily: "inherit", boxSizing: "border-box",
                    marginBottom: 8,
                  }}
                />
                <button
                  className="primary"
                  onClick={() => handleAddComment(expandedTask.id)}
                  disabled={!commentText.trim()}
                  style={{ width: "100%" }}
                >
                  Add Comment
                </button>
              </div>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
