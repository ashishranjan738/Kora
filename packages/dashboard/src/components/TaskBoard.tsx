import { useState, useEffect, useCallback } from "react";
import { useApi } from "../hooks/useApi";
import {
  Modal,
  Button,
  TextInput,
  Textarea,
  Select,
  Stack,
  Group,
  Text,
  Badge,
  Card,
  Paper,
  SimpleGrid,
  ActionIcon,
  ScrollArea,
  Checkbox,
  Alert,
  Box,
  Tooltip,
  Divider,
} from "@mantine/core";
import { useMediaQuery } from "@mantine/hooks";
import { MarkdownText } from "./MarkdownText";

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

const COLUMNS = ["pending", "in-progress", "review", "done"] as const;
type ColumnId = (typeof COLUMNS)[number];

const COLUMN_LABELS: Record<string, string> = {
  pending: "Pending",
  "in-progress": "In Progress",
  review: "Review",
  done: "Done",
};

const COLUMN_COLORS: Record<string, string> = {
  pending: "gray",
  "in-progress": "blue",
  review: "yellow",
  done: "green",
};

const COLUMN_CSS_COLORS: Record<string, string> = {
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

/* ------------------------------------------------------------------ */
/* Task Card                                                           */
/* ------------------------------------------------------------------ */
function TaskCard({
  task,
  agents,
  isDragging,
  onDragStart,
  onClick,
  onDelete,
}: {
  task: Task;
  agents: { id: string; name: string }[];
  isDragging: boolean;
  onDragStart: () => void;
  onClick: () => void;
  onDelete: () => void;
}) {
  const assigneeName = task.assignedTo
    ? agents.find((a) => a.id === task.assignedTo)?.name || task.assignedTo
    : null;

  return (
    <Card
      draggable
      onDragStart={onDragStart}
      onClick={(e) => {
        if (!(e.target as HTMLElement).closest("button")) onClick();
      }}
      withBorder
      padding="sm"
      style={{
        cursor: "pointer",
        opacity: isDragging ? 0.5 : task.blocked ? 0.7 : 1,
        borderColor: isDragging
          ? "var(--accent-blue)"
          : "var(--border-color)",
        backgroundColor: "var(--bg-primary)",
        transition: "border-color 0.15s, box-shadow 0.15s, opacity 0.15s",
      }}
      className="task-card-hover"
    >
      {/* Title + delete */}
      <Group justify="space-between" align="flex-start" gap={4} wrap="nowrap">
        <Text
          fw={600}
          size="sm"
          c="var(--text-primary)"
          lineClamp={2}
          style={{ flex: 1 }}
        >
          {task.title}
        </Text>
        <ActionIcon
          variant="subtle"
          color="red"
          size="xs"
          onClick={(e) => {
            e.stopPropagation();
            onDelete();
          }}
          title="Delete task"
          style={{ opacity: 0.4, flexShrink: 0 }}
          className="task-delete-btn"
        >
          <span style={{ fontSize: 14, lineHeight: 1 }}>&times;</span>
        </ActionIcon>
      </Group>

      {/* Blocked badge */}
      {task.blocked && (
        <Badge
          color="yellow"
          variant="light"
          size="xs"
          mt={4}
          leftSection={<span style={{ fontSize: 10 }}>&#128274;</span>}
        >
          Blocked
        </Badge>
      )}

      {/* Description — consistent 2-line clamp */}
      {task.description && (
        <Text size="xs" c="var(--text-secondary)" lineClamp={2} mt={4} lh={1.4}>
          {task.description}
        </Text>
      )}

      {/* Footer: assignee, comments, time */}
      <Group justify="space-between" align="center" mt="xs" gap={4}>
        {assigneeName ? (
          <Badge variant="light" color="blue" size="xs">
            {assigneeName}
          </Badge>
        ) : (
          <Text size="xs" c="var(--text-muted)">
            Unassigned
          </Text>
        )}
        <Group gap={6}>
          {task.comments && task.comments.length > 0 && (
            <Badge variant="light" color="blue" size="xs">
              {task.comments.length}
            </Badge>
          )}
          <Text size="xs" c="var(--text-muted)">
            {timeAgo(task.createdAt)}
          </Text>
        </Group>
      </Group>

      {/* Task ID — show on hover via CSS */}
      <Tooltip label={`#${task.id}`} position="bottom">
        <Text
          size="xs"
          ff="var(--font-mono)"
          c="var(--text-muted)"
          mt={4}
          className="task-id-text"
          style={{ fontSize: 10, opacity: 0 }}
          onClick={(e) => {
            e.stopPropagation();
            navigator.clipboard.writeText(task.id);
          }}
        >
          #{task.id.slice(0, 8)}
        </Text>
      </Tooltip>
    </Card>
  );
}

/* ------------------------------------------------------------------ */
/* Column                                                              */
/* ------------------------------------------------------------------ */
function TaskColumn({
  column,
  tasks,
  agents,
  draggedTaskId,
  dragOverColumn,
  onDragStart,
  onDragOver,
  onDragLeave,
  onDrop,
  onTaskClick,
  onTaskDelete,
  onAddClick,
}: {
  column: string;
  tasks: Task[];
  agents: { id: string; name: string }[];
  draggedTaskId: string | null;
  dragOverColumn: string | null;
  onDragStart: (id: string) => void;
  onDragOver: (e: React.DragEvent, col: string) => void;
  onDragLeave: () => void;
  onDrop: (e: React.DragEvent, col: string) => void;
  onTaskClick: (id: string) => void;
  onTaskDelete: (id: string) => void;
  onAddClick: () => void;
}) {
  const isDragOver = dragOverColumn === column;

  return (
    <Paper
      withBorder
      p="sm"
      style={{
        backgroundColor: isDragOver
          ? "rgba(88,166,255,0.06)"
          : "var(--bg-secondary)",
        borderColor: isDragOver ? "var(--accent-blue)" : "var(--border-color)",
        borderStyle: isDragOver ? "dashed" : "solid",
        borderWidth: isDragOver ? 2 : 1,
        minHeight: 400,
        display: "flex",
        flexDirection: "column",
        transition: "border-color 0.15s, background-color 0.15s",
      }}
      onDragOver={(e) => onDragOver(e, column)}
      onDragLeave={onDragLeave}
      onDrop={(e) => onDrop(e, column)}
    >
      {/* Column header */}
      <Group
        justify="space-between"
        align="center"
        mb="sm"
        pb="xs"
        style={{
          borderBottom: `2px solid ${COLUMN_CSS_COLORS[column]}`,
        }}
      >
        <Group gap={8} align="center">
          <Box
            style={{
              width: 10,
              height: 10,
              borderRadius: "50%",
              background: COLUMN_CSS_COLORS[column],
              flexShrink: 0,
            }}
          />
          <Text fw={600} size="sm" c="var(--text-primary)">
            {COLUMN_LABELS[column]}
          </Text>
          <Badge
            size="sm"
            variant="light"
            color={COLUMN_COLORS[column]}
          >
            {tasks.length}
          </Badge>
        </Group>
        {column === "pending" && (
          <ActionIcon
            variant="subtle"
            size="sm"
            onClick={onAddClick}
            title="Add task"
            style={{ color: "var(--text-secondary)" }}
          >
            <span style={{ fontSize: 16 }}>+</span>
          </ActionIcon>
        )}
      </Group>

      {/* Cards */}
      <Stack gap="xs" style={{ flex: 1 }}>
        {tasks.map((task) => (
          <TaskCard
            key={task.id}
            task={task}
            agents={agents}
            isDragging={draggedTaskId === task.id}
            onDragStart={() => onDragStart(task.id)}
            onClick={() => onTaskClick(task.id)}
            onDelete={() => onTaskDelete(task.id)}
          />
        ))}
        {tasks.length === 0 && (
          <Text size="xs" c="var(--text-muted)" ta="center" py="xl" fs="italic">
            No tasks
          </Text>
        )}
      </Stack>
    </Paper>
  );
}

/* ------------------------------------------------------------------ */
/* Main TaskBoard                                                      */
/* ------------------------------------------------------------------ */
export function TaskBoard({ sessionId }: TaskBoardProps) {
  const api = useApi();
  const isMobile = useMediaQuery("(max-width: 48em)");
  const isTablet = useMediaQuery("(max-width: 62em)");

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
  const [activeCol, setActiveCol] = useState<ColumnId>("pending");

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
        (data.agents || []).map((a: any) => ({
          id: a.id,
          name: a.config?.name || a.name || a.id,
        }))
      );
    } catch {}
  }, [sessionId]);

  useEffect(() => {
    fetchTasks();
    fetchAgents();
  }, [fetchTasks, fetchAgents]);

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
    if (!task || task.status === column) {
      setDraggedTaskId(null);
      return;
    }

    if (task.blocked && column === "in-progress") {
      alert(
        `Cannot start: ${task.blockedReason || "This task has incomplete dependencies"}`
      );
      setDraggedTaskId(null);
      return;
    }

    setTasks((prev) =>
      prev.map((t) =>
        t.id === draggedTaskId ? { ...t, status: column } : t
      )
    );
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
        dependencies:
          newDependencies.length > 0 ? newDependencies : undefined,
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
      alert(
        `Cannot start: ${task.blockedReason || "This task has incomplete dependencies"}`
      );
      return;
    }
    setTasks((prev) =>
      prev.map((t) =>
        t.id === taskId ? { ...t, status: newStatus } : t
      )
    );
    try {
      await api.updateTask(sessionId, taskId, { status: newStatus });
    } catch {
      fetchTasks();
    }
  };

  const tasksByColumn = (column: string) =>
    tasks.filter((t) => t.status === column);
  const expandedTask = expandedTaskId
    ? tasks.find((t) => t.id === expandedTaskId)
    : null;

  const agentSelectData = agents.map((a) => ({
    value: a.id,
    label: a.name,
  }));

  const inputStyles = {
    input: {
      backgroundColor: "var(--bg-tertiary)",
      borderColor: "var(--border-color)",
      color: "var(--text-primary)",
    },
    label: { color: "var(--text-secondary)", fontSize: 13 },
    description: { color: "var(--text-muted)" },
  };

  const selectDropdownStyles = {
    ...inputStyles,
    dropdown: {
      backgroundColor: "var(--bg-secondary)",
      borderColor: "var(--border-color)",
    },
    option: { color: "var(--text-primary)" },
  };

  const modalStyles = {
    header: {
      backgroundColor: "var(--bg-secondary)",
      borderBottom: "1px solid var(--border-color)",
    },
    body: { backgroundColor: "var(--bg-secondary)" },
    content: { backgroundColor: "var(--bg-secondary)" },
    title: {
      color: "var(--text-primary)",
      fontWeight: 600 as const,
      fontSize: 18,
    },
    close: { color: "var(--text-secondary)" },
  };

  /* ---- Empty state ---- */
  if (tasks.length === 0 && !showAddDialog) {
    return (
      <Stack align="center" justify="center" py={60} gap="md">
        <Text size="xl" c="var(--text-muted)">
          No tasks yet
        </Text>
        <Text size="sm" c="var(--text-muted)" ta="center" maw={400}>
          Create your first task to start organizing work for your agents.
        </Text>
        <Button
          onClick={() => setShowAddDialog(true)}
          styles={{
            root: {
              backgroundColor: "var(--accent-blue)",
              borderColor: "var(--accent-blue)",
              minHeight: 44,
            },
          }}
        >
          + Add Task
        </Button>

        {/* Add Task Dialog (for empty state) */}
        <AddTaskModal
          opened={showAddDialog}
          onClose={() => {
            setShowAddDialog(false);
            setNewTitle("");
            setNewDescription("");
            setNewAssignee("");
            setNewDependencies([]);
          }}
          isMobile={!!isMobile}
          modalStyles={modalStyles}
          inputStyles={inputStyles}
          selectDropdownStyles={selectDropdownStyles}
          newTitle={newTitle}
          setNewTitle={setNewTitle}
          newDescription={newDescription}
          setNewDescription={setNewDescription}
          newAssignee={newAssignee}
          setNewAssignee={setNewAssignee}
          agentSelectData={agentSelectData}
          tasks={tasks}
          newDependencies={newDependencies}
          setNewDependencies={setNewDependencies}
          onSubmit={handleAddTask}
        />
      </Stack>
    );
  }

  /* ---- Board ---- */
  return (
    <div style={{ position: "relative" }}>
      {/* Mobile: column selector + single column */}
      {isMobile ? (
        <Stack gap="sm">
          {/* Column tabs */}
          <ScrollArea type="never">
            <Group gap="xs" wrap="nowrap">
              {COLUMNS.map((col) => (
                <Badge
                  key={col}
                  variant={activeCol === col ? "filled" : "outline"}
                  color={COLUMN_COLORS[col]}
                  size="lg"
                  onClick={() => setActiveCol(col)}
                  style={{
                    cursor: "pointer",
                    minHeight: 36,
                    flexShrink: 0,
                  }}
                >
                  {COLUMN_LABELS[col]} ({tasksByColumn(col).length})
                </Badge>
              ))}
              <ActionIcon
                variant="light"
                color="blue"
                size="lg"
                onClick={() => setShowAddDialog(true)}
                style={{ flexShrink: 0 }}
              >
                <span style={{ fontSize: 18 }}>+</span>
              </ActionIcon>
            </Group>
          </ScrollArea>

          {/* Active column's cards */}
          <Stack gap="xs">
            {tasksByColumn(activeCol).map((task) => (
              <TaskCard
                key={task.id}
                task={task}
                agents={agents}
                isDragging={false}
                onDragStart={() => {}}
                onClick={() => setExpandedTaskId(task.id)}
                onDelete={() => handleDeleteTask(task.id)}
              />
            ))}
            {tasksByColumn(activeCol).length === 0 && (
              <Text
                size="sm"
                c="var(--text-muted)"
                ta="center"
                py="xl"
                fs="italic"
              >
                No {COLUMN_LABELS[activeCol].toLowerCase()} tasks
              </Text>
            )}
          </Stack>
        </Stack>
      ) : (
        /* Desktop / Tablet: grid columns */
        <SimpleGrid cols={isTablet ? 2 : 4} spacing="md">
          {COLUMNS.map((col) => (
            <TaskColumn
              key={col}
              column={col}
              tasks={tasksByColumn(col)}
              agents={agents}
              draggedTaskId={draggedTaskId}
              dragOverColumn={dragOverColumn}
              onDragStart={handleDragStart}
              onDragOver={handleDragOver}
              onDragLeave={() => setDragOverColumn(null)}
              onDrop={handleDrop}
              onTaskClick={setExpandedTaskId}
              onTaskDelete={handleDeleteTask}
              onAddClick={() => setShowAddDialog(true)}
            />
          ))}
        </SimpleGrid>
      )}

      {/* Add Task Modal */}
      <AddTaskModal
        opened={showAddDialog}
        onClose={() => {
          setShowAddDialog(false);
          setNewTitle("");
          setNewDescription("");
          setNewAssignee("");
          setNewDependencies([]);
        }}
        isMobile={!!isMobile}
        modalStyles={modalStyles}
        inputStyles={inputStyles}
        selectDropdownStyles={selectDropdownStyles}
        newTitle={newTitle}
        setNewTitle={setNewTitle}
        newDescription={newDescription}
        setNewDescription={setNewDescription}
        newAssignee={newAssignee}
        setNewAssignee={setNewAssignee}
        agentSelectData={agentSelectData}
        tasks={tasks}
        newDependencies={newDependencies}
        setNewDependencies={setNewDependencies}
        onSubmit={handleAddTask}
      />

      {/* Task Detail Modal */}
      {expandedTask && (
        <TaskDetailModal
          task={expandedTask}
          tasks={tasks}
          agents={agents}
          isMobile={!!isMobile}
          modalStyles={modalStyles}
          commentText={commentText}
          setCommentText={setCommentText}
          onClose={() => {
            setExpandedTaskId(null);
            setCommentText("");
          }}
          onChangeStatus={handleChangeStatus}
          onAddComment={handleAddComment}
          onNavigateTask={setExpandedTaskId}
          inputStyles={inputStyles}
        />
      )}
    </div>
  );
}

/* ------------------------------------------------------------------ */
/* Add Task Modal                                                      */
/* ------------------------------------------------------------------ */
function AddTaskModal({
  opened,
  onClose,
  isMobile,
  modalStyles,
  inputStyles,
  selectDropdownStyles,
  newTitle,
  setNewTitle,
  newDescription,
  setNewDescription,
  newAssignee,
  setNewAssignee,
  agentSelectData,
  tasks,
  newDependencies,
  setNewDependencies,
  onSubmit,
}: {
  opened: boolean;
  onClose: () => void;
  isMobile: boolean;
  modalStyles: any;
  inputStyles: any;
  selectDropdownStyles: any;
  newTitle: string;
  setNewTitle: (v: string) => void;
  newDescription: string;
  setNewDescription: (v: string) => void;
  newAssignee: string;
  setNewAssignee: (v: string) => void;
  agentSelectData: { value: string; label: string }[];
  tasks: Task[];
  newDependencies: string[];
  setNewDependencies: (v: string[]) => void;
  onSubmit: () => void;
}) {
  if (!opened) return null;

  const incompleteTasks = tasks.filter((t) => t.status !== "done");

  return (
    <Modal
      opened
      onClose={onClose}
      title="Add New Task"
      size="md"
      fullScreen={isMobile}
      centered
      styles={modalStyles}
    >
      <Stack gap="sm">
        <TextInput
          label="Title *"
          value={newTitle}
          onChange={(e) => setNewTitle(e.currentTarget.value)}
          placeholder="Task title"
          autoFocus
          onKeyDown={(e) => {
            if (e.key === "Enter" && newTitle.trim()) onSubmit();
          }}
          styles={inputStyles}
        />

        <Textarea
          label="Description"
          value={newDescription}
          onChange={(e) => setNewDescription(e.currentTarget.value)}
          placeholder="Optional description"
          rows={3}
          autosize
          minRows={2}
          maxRows={5}
          styles={inputStyles}
        />

        <Select
          label="Assign to Agent"
          placeholder="Unassigned"
          data={agentSelectData}
          value={newAssignee || null}
          onChange={(v) => setNewAssignee(v || "")}
          clearable
          styles={selectDropdownStyles}
        />

        {incompleteTasks.length > 0 && (
          <Box>
            <Text size="xs" c="var(--text-secondary)" mb={4}>
              Dependencies (blocks this task)
            </Text>
            <ScrollArea
              mah={150}
              style={{
                border: "1px solid var(--border-color)",
                borderRadius: 6,
                backgroundColor: "var(--bg-tertiary)",
              }}
            >
              {incompleteTasks.map((t) => (
                <Group
                  key={t.id}
                  gap={8}
                  p="xs"
                  style={{
                    borderBottom: "1px solid var(--border-color)",
                    cursor: "pointer",
                    minHeight: 44,
                  }}
                  onClick={() => {
                    if (newDependencies.includes(t.id)) {
                      setNewDependencies(
                        newDependencies.filter((d) => d !== t.id)
                      );
                    } else {
                      setNewDependencies([...newDependencies, t.id]);
                    }
                  }}
                >
                  <Checkbox
                    checked={newDependencies.includes(t.id)}
                    onChange={() => {}}
                    size="sm"
                    styles={{
                      input: {
                        backgroundColor: "var(--bg-primary)",
                        borderColor: "var(--border-color)",
                      },
                    }}
                  />
                  <Text size="xs" c="var(--text-primary)" style={{ flex: 1 }}>
                    {t.title}
                  </Text>
                  <Text
                    size="xs"
                    fw={500}
                    c={COLUMN_CSS_COLORS[t.status] || "var(--text-muted)"}
                  >
                    {COLUMN_LABELS[t.status] || t.status}
                  </Text>
                </Group>
              ))}
            </ScrollArea>
          </Box>
        )}

        <Group justify="flex-end" mt="md">
          <Button
            variant="default"
            onClick={onClose}
            styles={{
              root: {
                backgroundColor: "var(--bg-tertiary)",
                borderColor: "var(--border-color)",
                color: "var(--text-primary)",
                minHeight: 44,
              },
            }}
          >
            Cancel
          </Button>
          <Button
            onClick={onSubmit}
            disabled={!newTitle.trim()}
            styles={{
              root: {
                backgroundColor: "var(--accent-blue)",
                borderColor: "var(--accent-blue)",
                minHeight: 44,
              },
            }}
          >
            Create Task
          </Button>
        </Group>
      </Stack>
    </Modal>
  );
}

/* ------------------------------------------------------------------ */
/* Task Detail Modal                                                   */
/* ------------------------------------------------------------------ */
function TaskDetailModal({
  task,
  tasks,
  agents,
  isMobile,
  modalStyles,
  commentText,
  setCommentText,
  onClose,
  onChangeStatus,
  onAddComment,
  onNavigateTask,
  inputStyles,
}: {
  task: Task;
  tasks: Task[];
  agents: { id: string; name: string }[];
  isMobile: boolean;
  modalStyles: any;
  commentText: string;
  setCommentText: (v: string) => void;
  onClose: () => void;
  onChangeStatus: (taskId: string, status: string) => void;
  onAddComment: (taskId: string) => void;
  onNavigateTask: (taskId: string) => void;
  inputStyles: any;
}) {
  const assigneeName = task.assignedTo
    ? agents.find((a) => a.id === task.assignedTo)?.name || task.assignedTo
    : "Unassigned";

  return (
    <Modal
      opened
      onClose={onClose}
      title={task.title}
      size="lg"
      fullScreen={isMobile}
      centered
      styles={modalStyles}
      scrollAreaComponent={ScrollArea.Autosize}
    >
      <Stack gap="md">
        {/* Meta row */}
        <Group gap={8} wrap="wrap">
          <Tooltip label="Click to copy task ID">
            <Badge
              variant="light"
              color="blue"
              size="sm"
              style={{ cursor: "pointer", fontFamily: "var(--font-mono)" }}
              onClick={() => navigator.clipboard.writeText(task.id)}
            >
              #{task.id.slice(0, 8)}
            </Badge>
          </Tooltip>
          <Text size="xs" c="var(--text-muted)">
            Created {timeAgo(task.createdAt)} by {task.createdBy}
          </Text>
        </Group>

        {/* Task details card */}
        <Paper
          p="sm"
          style={{
            backgroundColor: "var(--bg-tertiary)",
            borderRadius: 8,
          }}
        >
          <Stack gap={8}>
            <Group gap={8}>
              <Text size="xs" fw={600} c="var(--text-secondary)" w={80}>
                Status:
              </Text>
              <Text
                size="xs"
                fw={600}
                c={COLUMN_CSS_COLORS[task.status] || "var(--text-primary)"}
              >
                {COLUMN_LABELS[task.status] || task.status}
              </Text>
            </Group>
            <Group gap={8}>
              <Text size="xs" fw={600} c="var(--text-secondary)" w={80}>
                Assigned to:
              </Text>
              <Text size="xs" c="var(--text-primary)">
                {assigneeName}
              </Text>
            </Group>
            {task.description && (
              <Box>
                <Text size="xs" fw={600} c="var(--text-secondary)">
                  Description:
                </Text>
                <Box mt={4} style={{ fontSize: 13, lineHeight: 1.5 }}>
                  <MarkdownText>{task.description}</MarkdownText>
                </Box>
              </Box>
            )}
          </Stack>
        </Paper>

        {/* Change status */}
        <Box>
          <Text size="xs" fw={600} mb={8}>
            Change Status
          </Text>
          <Group gap={8} wrap="wrap">
            {COLUMNS.map((col) => (
              <Button
                key={col}
                size="xs"
                variant={task.status === col ? "filled" : "outline"}
                color={COLUMN_COLORS[col]}
                onClick={() => onChangeStatus(task.id, col)}
                disabled={task.status === col}
                styles={{
                  root: {
                    minHeight: 36,
                    fontWeight: 600,
                  },
                }}
              >
                {COLUMN_LABELS[col]}
              </Button>
            ))}
          </Group>
        </Box>

        {/* Dependencies */}
        {task.dependencies && task.dependencies.length > 0 && (
          <Box>
            <Text size="xs" fw={600} mb={8}>
              Dependencies ({task.dependencies.length})
            </Text>
            <Stack gap={6}>
              {task.dependencies.map((depId) => {
                const depTask = tasks.find((t) => t.id === depId);
                const isDone = depTask?.status === "done";
                return (
                  <Paper
                    key={depId}
                    p="xs"
                    style={{
                      backgroundColor: "var(--bg-tertiary)",
                      borderRadius: 6,
                      cursor: depTask ? "pointer" : "default",
                      minHeight: 44,
                      display: "flex",
                      alignItems: "center",
                    }}
                    onClick={() => {
                      if (depTask) onNavigateTask(depId);
                    }}
                  >
                    <Group gap={8} style={{ flex: 1 }}>
                      <Text size="sm">{isDone ? "\u2705" : "\u23F3"}</Text>
                      <Text
                        size="xs"
                        c={
                          isDone
                            ? "var(--accent-green)"
                            : "var(--text-primary)"
                        }
                        td={isDone ? "line-through" : undefined}
                        style={{ flex: 1 }}
                      >
                        {depTask?.title || depId}
                      </Text>
                      <Text
                        size="xs"
                        fw={500}
                        c={
                          isDone
                            ? "var(--accent-green)"
                            : "var(--text-muted)"
                        }
                      >
                        {isDone
                          ? "Done"
                          : depTask
                            ? COLUMN_LABELS[depTask.status] ||
                              depTask.status
                            : "Unknown"}
                      </Text>
                    </Group>
                  </Paper>
                );
              })}
            </Stack>
          </Box>
        )}

        {/* Blocked */}
        {task.blocked && (
          <Alert
            color="yellow"
            variant="light"
            icon={<span style={{ fontSize: 16 }}>&#128274;</span>}
          >
            {task.blockedReason ||
              "This task is blocked by incomplete dependencies"}
          </Alert>
        )}

        <Divider />

        {/* Comments */}
        <Box>
          <Text size="sm" fw={600} mb="sm">
            Comments{" "}
            {task.comments && task.comments.length > 0
              ? `(${task.comments.length})`
              : ""}
          </Text>

          <ScrollArea mah={300} mb="sm">
            {task.comments && task.comments.length > 0 ? (
              <Stack gap="xs">
                {task.comments.map((comment) => (
                  <Paper
                    key={comment.id}
                    p="xs"
                    style={{
                      backgroundColor: "var(--bg-tertiary)",
                      borderRadius: 6,
                    }}
                  >
                    <Group justify="space-between" mb={4}>
                      <Text size="xs" fw={600} c="var(--accent-blue)">
                        {comment.authorName || comment.author}
                      </Text>
                      <Text size="xs" c="var(--text-muted)">
                        {timeAgo(comment.createdAt)}
                      </Text>
                    </Group>
                    <Box style={{ fontSize: 13 }}>
                      <MarkdownText>{comment.text}</MarkdownText>
                    </Box>
                  </Paper>
                ))}
              </Stack>
            ) : (
              <Text
                size="xs"
                c="var(--text-muted)"
                fs="italic"
                ta="center"
                py="lg"
              >
                No comments yet. Be the first to add one!
              </Text>
            )}
          </ScrollArea>

          <Stack gap="xs">
            <Textarea
              value={commentText}
              onChange={(e) => setCommentText(e.currentTarget.value)}
              placeholder="Add a comment..."
              rows={2}
              autosize
              minRows={2}
              maxRows={4}
              styles={inputStyles}
            />
            <Button
              fullWidth
              onClick={() => onAddComment(task.id)}
              disabled={!commentText.trim()}
              styles={{
                root: {
                  backgroundColor: "var(--accent-blue)",
                  borderColor: "var(--accent-blue)",
                  minHeight: 44,
                },
              }}
            >
              Add Comment
            </Button>
          </Stack>
        </Box>
      </Stack>
    </Modal>
  );
}
