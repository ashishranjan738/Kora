import { useState, useEffect, useCallback } from "react";
import { useApi } from "../hooks/useApi";
import {
  Modal,
  Button,
  TextInput,
  Textarea,
  Select,
  MultiSelect,
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
  SegmentedControl,
  TagsInput,
} from "@mantine/core";
import { DateInput } from "@mantine/dates";
import { useMediaQuery } from "@mantine/hooks";
import { MarkdownText } from "./MarkdownText";

// Type wrapper to handle DateInput's onChange type
const handleDateChange = (setter: (v: string | null) => void) => (value: Date | string | null) => {
  if (value instanceof Date) {
    setter(value.toISOString().split("T")[0]);
  } else {
    setter(value);
  }
};

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
  priority: string;
  labels?: string[];
  dueDate?: string;
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
  pending: "Backlog",
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

const PRIORITY_COLORS: Record<string, string> = {
  P0: "red",
  P1: "orange",
  P2: "blue",
  P3: "gray",
};

// Hash label string to deterministic color
function getLabelColor(label: string): string {
  const colors = ["blue", "cyan", "teal", "green", "lime", "yellow", "orange", "red", "pink", "grape", "violet", "indigo"];
  let hash = 0;
  for (let i = 0; i < label.length; i++) {
    hash = label.charCodeAt(i) + ((hash << 5) - hash);
  }
  return colors[Math.abs(hash) % colors.length];
}

// Calculate due date status
function getDueDateStatus(dueDate: string): { label: string; color: string } | null {
  if (!dueDate) return null;
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  const due = new Date(dueDate);
  due.setHours(0, 0, 0, 0);
  const diffDays = Math.floor((due.getTime() - today.getTime()) / (1000 * 60 * 60 * 24));

  if (diffDays < 0) return { label: "Overdue", color: "red" };
  if (diffDays === 0) return { label: "Due today", color: "yellow" };
  if (diffDays <= 2) return { label: "Due soon", color: "yellow" };
  return { label: dueDate, color: "gray" };
}

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

// Calculate task age in hours
function getTaskAge(createdAt: string): number {
  const now = Date.now();
  const then = new Date(createdAt).getTime();
  return (now - then) / (1000 * 60 * 60); // hours
}

// Get task age badge with color coding
function getTaskAgeBadge(createdAt: string): { label: string; color: string } | null {
  const ageHours = getTaskAge(createdAt);
  const ageText = timeAgo(createdAt);

  if (ageHours >= 4) {
    return { label: ageText, color: "red" };
  } else if (ageHours >= 2) {
    return { label: ageText, color: "orange" };
  }
  return null; // Don't show badge for tasks < 2 hours old
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

  // Check if task is overdue
  const dueDateStatus = task.dueDate ? getDueDateStatus(task.dueDate) : null;
  const isOverdue = dueDateStatus?.label === "Overdue";

  // Get task age badge
  const ageBadge = getTaskAgeBadge(task.createdAt);

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
          : isOverdue
          ? "var(--accent-red)"
          : "var(--border-color)",
        borderWidth: isOverdue ? 2 : 1,
        backgroundColor: task.blocked ? "var(--bg-tertiary)" : "var(--bg-primary)",
        boxShadow: isOverdue ? "0 0 0 1px var(--accent-red), 0 0 8px rgba(255, 100, 100, 0.3)" : undefined,
        transition: "border-color 0.15s, box-shadow 0.15s, opacity 0.15s",
        filter: task.blocked ? "grayscale(0.3)" : undefined,
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
          leftSection={<span style={{ fontSize: 10 }}>&#128279;</span>}
        >
          Blocked
        </Badge>
      )}

      {/* Priority + Age badges */}
      <Group gap={4} mt={4}>
        <Badge
          color={PRIORITY_COLORS[task.priority]}
          variant="filled"
          size="xs"
        >
          {task.priority}
        </Badge>
        {ageBadge && (
          <Badge
            color={ageBadge.color}
            variant="light"
            size="xs"
            leftSection={<span style={{ fontSize: 10 }}>&#8987;</span>}
          >
            {ageBadge.label}
          </Badge>
        )}
      </Group>

      {/* Labels */}
      {task.labels && task.labels.length > 0 && (
        <Group gap={4} mt={4}>
          {task.labels.map((label) => (
            <Badge
              key={label}
              color={getLabelColor(label)}
              variant="outline"
              size="xs"
            >
              {label}
            </Badge>
          ))}
        </Group>
      )}

      {/* Due date badge */}
      {task.dueDate && (() => {
        const dueDateStatus = getDueDateStatus(task.dueDate);
        return dueDateStatus ? (
          <Badge
            color={dueDateStatus.color}
            variant="light"
            size="xs"
            mt={4}
            leftSection={<span style={{ fontSize: 10 }}>📅</span>}
          >
            {dueDateStatus.label}
          </Badge>
        ) : null;
      })()}

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
  const [newPriority, setNewPriority] = useState("P2");
  const [newLabels, setNewLabels] = useState<string[]>([]);
  const [newDueDate, setNewDueDate] = useState<string | null>(null);
  const [expandedTaskId, setExpandedTaskId] = useState<string | null>(null);
  const [commentText, setCommentText] = useState("");
  const [newDependencies, setNewDependencies] = useState<string[]>([]);
  const [activeCol, setActiveCol] = useState<ColumnId>("pending");

  // Filters
  const [filterAgent, setFilterAgent] = useState<string | null>(null);
  const [filterPriorities, setFilterPriorities] = useState<string[]>([]);
  const [filterLabels, setFilterLabels] = useState<string[]>([]);

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
        priority: newPriority,
        labels: newLabels.length > 0 ? newLabels : undefined,
        dueDate: newDueDate || undefined,
        dependencies:
          newDependencies.length > 0 ? newDependencies : undefined,
      });
      setNewTitle("");
      setNewDescription("");
      setNewAssignee("");
      setNewPriority("P2");
      setNewLabels([]);
      setNewDueDate(null);
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

  const tasksByColumn = (column: string) => {
    const priOrder: Record<string, number> = { P0: 0, P1: 1, P2: 2, P3: 3 };
    return tasks
      .filter((t) => {
        // Column filter
        if (t.status !== column) return false;

        // Agent filter
        if (filterAgent && t.assignedTo !== filterAgent) return false;

        // Priority filter
        if (filterPriorities.length > 0 && !filterPriorities.includes(t.priority)) return false;

        // Label filter (task must have at least one of the selected labels)
        if (filterLabels.length > 0) {
          const hasMatchingLabel = t.labels?.some(label => filterLabels.includes(label));
          if (!hasMatchingLabel) return false;
        }

        return true;
      })
      .sort((a, b) => {
        const aPri = priOrder[a.priority] ?? 2;
        const bPri = priOrder[b.priority] ?? 2;
        if (aPri !== bPri) return aPri - bPri;
        return new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime();
      });
  };
  const expandedTask = expandedTaskId
    ? tasks.find((t) => t.id === expandedTaskId)
    : null;

  // Calculate agent workloads
  const agentWorkloads = agents.reduce<Record<string, number>>((acc, agent) => {
    acc[agent.id] = tasks.filter(t => t.assignedTo === agent.id && t.status !== "done").length;
    return acc;
  }, {});

  const maxWorkload = Math.max(...Object.values(agentWorkloads), 1);

  const agentSelectData = agents.map((a) => ({
    value: a.id,
    label: a.name,
  }));

  // Extract all unique labels from tasks
  const allLabels = Array.from(
    new Set(tasks.flatMap((t) => t.labels || []))
  ).sort();

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
            setNewPriority("P2");
            setNewLabels([]);
            setNewDueDate(null);
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
          newPriority={newPriority}
          setNewPriority={setNewPriority}
          newLabels={newLabels}
          setNewLabels={setNewLabels}
          newDueDate={newDueDate}
          setNewDueDate={setNewDueDate}
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
      {/* Filters */}
      <Group gap="md" mb="md" wrap="wrap">
        <Select
          placeholder="All agents"
          data={[
            { value: "", label: "All agents" },
            ...agentSelectData,
          ]}
          value={filterAgent || ""}
          onChange={(v) => setFilterAgent(v || null)}
          clearable
          searchable
          styles={selectDropdownStyles}
          style={{ minWidth: 200 }}
          renderOption={({ option }) => {
            if (option.value === "") {
              return <div style={{ padding: 4 }}>{option.label}</div>;
            }
            const agentId = option.value;
            const workload = agentWorkloads[agentId] || 0;
            const workloadPercent = maxWorkload > 0 ? (workload / maxWorkload) * 100 : 0;
            return (
              <div style={{ padding: "4px 0" }}>
                <Group justify="space-between" gap={8} wrap="nowrap">
                  <Text size="sm" style={{ flex: 1 }}>{option.label}</Text>
                  <Text size="xs" c="dimmed" style={{ minWidth: 30, textAlign: "right" }}>
                    {workload}
                  </Text>
                </Group>
                <div style={{
                  height: 3,
                  backgroundColor: "var(--bg-tertiary)",
                  borderRadius: 2,
                  marginTop: 4,
                  overflow: "hidden",
                }}>
                  <div style={{
                    width: `${workloadPercent}%`,
                    height: "100%",
                    backgroundColor: workload > 5 ? "var(--accent-red)" : workload > 2 ? "var(--accent-yellow)" : "var(--accent-blue)",
                    transition: "width 0.2s ease",
                  }} />
                </div>
              </div>
            );
          }}
        />

        <MultiSelect
          placeholder="All priorities"
          data={[
            { value: "P0", label: "P0 Critical" },
            { value: "P1", label: "P1 High" },
            { value: "P2", label: "P2 Medium" },
            { value: "P3", label: "P3 Low" },
          ]}
          value={filterPriorities}
          onChange={setFilterPriorities}
          clearable
          styles={selectDropdownStyles}
          style={{ minWidth: 180 }}
        />

        {allLabels.length > 0 && (
          <MultiSelect
            placeholder="All labels"
            data={allLabels}
            value={filterLabels}
            onChange={setFilterLabels}
            clearable
            searchable
            styles={selectDropdownStyles}
            style={{ minWidth: 180 }}
          />
        )}

        {(filterAgent || filterPriorities.length > 0 || filterLabels.length > 0) && (
          <Button
            variant="subtle"
            size="xs"
            color="gray"
            onClick={() => {
              setFilterAgent(null);
              setFilterPriorities([]);
              setFilterLabels([]);
            }}
          >
            Clear filters
          </Button>
        )}
      </Group>

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
          setNewPriority("P2");
          setNewLabels([]);
          setNewDueDate(null);
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
        newPriority={newPriority}
        setNewPriority={setNewPriority}
        newLabels={newLabels}
        setNewLabels={setNewLabels}
        newDueDate={newDueDate}
        setNewDueDate={setNewDueDate}
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
          sessionId={sessionId}
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
          fetchTasks={fetchTasks}
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
  newPriority,
  setNewPriority,
  newLabels,
  setNewLabels,
  newDueDate,
  setNewDueDate,
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
  newPriority: string;
  setNewPriority: (v: string) => void;
  newLabels: string[];
  setNewLabels: (v: string[]) => void;
  newDueDate: string | null;
  setNewDueDate: (v: string | null) => void;
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

        <Box>
          <Text size="xs" c="var(--text-secondary)" mb={6}>
            Priority
          </Text>
          <SegmentedControl
            value={newPriority}
            onChange={setNewPriority}
            data={[
              { value: "P0", label: "P0 Critical" },
              { value: "P1", label: "P1 High" },
              { value: "P2", label: "P2 Medium" },
              { value: "P3", label: "P3 Low" },
            ]}
            size="sm"
            styles={{
              root: {
                backgroundColor: "var(--bg-tertiary)",
                border: "1px solid var(--border-color)",
              },
              label: {
                color: "var(--text-primary)",
                fontWeight: 500,
                fontSize: 12,
                padding: "6px 12px",
              },
              indicator: {
                backgroundColor: PRIORITY_COLORS[newPriority] === "red" ? "var(--mantine-color-red-6)" :
                                 PRIORITY_COLORS[newPriority] === "orange" ? "var(--mantine-color-orange-6)" :
                                 PRIORITY_COLORS[newPriority] === "blue" ? "var(--accent-blue)" :
                                 "var(--text-muted)",
                boxShadow: "none",
              },
            }}
          />
        </Box>

        <TagsInput
          label="Labels"
          placeholder="Add label (press Enter)"
          value={newLabels}
          onChange={setNewLabels}
          styles={inputStyles}
        />

        <DateInput
          label="Due Date"
          placeholder="Select due date"
          value={newDueDate ? new Date(newDueDate) : null}
          onChange={handleDateChange(setNewDueDate)}
          clearable
          popoverProps={{
            styles: {
              dropdown: {
                backgroundColor: "var(--bg-secondary)",
                borderColor: "var(--border-color)",
              },
            },
          }}
          styles={{
            ...inputStyles,
            calendarHeader: { backgroundColor: "var(--bg-secondary)" },
            calendarHeaderControl: { color: "var(--text-primary)" },
            calendarHeaderLevel: { color: "var(--text-primary)" },
            weekday: { color: "var(--text-muted)" },
            day: { color: "var(--text-primary)" },
          }}
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
  sessionId,
  isMobile,
  modalStyles,
  commentText,
  setCommentText,
  onClose,
  onChangeStatus,
  onAddComment,
  onNavigateTask,
  inputStyles,
  fetchTasks,
}: {
  task: Task;
  tasks: Task[];
  agents: { id: string; name: string }[];
  sessionId: string;
  isMobile: boolean;
  modalStyles: any;
  commentText: string;
  setCommentText: (v: string) => void;
  onClose: () => void;
  onChangeStatus: (taskId: string, status: string) => void;
  onAddComment: (taskId: string) => void;
  onNavigateTask: (taskId: string) => void;
  inputStyles: any;
  fetchTasks: () => void;
}) {
  const api = useApi();
  const [editingTitle, setEditingTitle] = useState(false);
  const [editingDesc, setEditingDesc] = useState(false);
  const [editTitle, setEditTitle] = useState(task.title);
  const [editDesc, setEditDesc] = useState(task.description || "");
  const [editAssignee, setEditAssignee] = useState(task.assignedTo || "");
  const [editLabels, setEditLabels] = useState(task.labels || []);
  const [editDueDate, setEditDueDate] = useState<string | null>(task.dueDate || null);
  const [saving, setSaving] = useState(false);

  // Sync local state when task changes
  useEffect(() => {
    setEditTitle(task.title);
    setEditDesc(task.description || "");
    setEditAssignee(task.assignedTo || "");
    setEditLabels(task.labels || []);
    setEditDueDate(task.dueDate || null);
  }, [task.id, task.title, task.description, task.assignedTo, task.labels, task.dueDate]);

  const agentSelectData = agents.map((a) => ({
    value: a.id,
    label: a.name,
  }));

  const saveField = async (field: string, value: string) => {
    setSaving(true);
    try {
      await api.updateTask(sessionId, task.id, { [field]: value || undefined });
      fetchTasks();
    } catch {
      // revert on failure
    } finally {
      setSaving(false);
    }
  };

  const handleTitleSave = () => {
    if (editTitle.trim() && editTitle !== task.title) {
      saveField("title", editTitle.trim());
    }
    setEditingTitle(false);
  };

  const handleDescSave = () => {
    if (editDesc !== (task.description || "")) {
      saveField("description", editDesc.trim());
    }
    setEditingDesc(false);
  };

  const handleAssigneeChange = (value: string | null) => {
    const newVal = value || "";
    setEditAssignee(newVal);
    saveField("assignedTo", newVal);
  };

  const handleLabelsChange = async (newLabels: string[]) => {
    setEditLabels(newLabels);
    setSaving(true);
    try {
      await api.updateTask(sessionId, task.id, { labels: newLabels });
      fetchTasks();
    } catch {
      // revert on failure
    } finally {
      setSaving(false);
    }
  };

  const handleDueDateChange = async (newDate: string | null) => {
    setEditDueDate(newDate);
    setSaving(true);
    try {
      await api.updateTask(sessionId, task.id, {
        dueDate: newDate || undefined
      });
      fetchTasks();
    } catch {
      // revert on failure
    } finally {
      setSaving(false);
    }
  };

  const selectDropdownStyles = {
    input: {
      backgroundColor: "var(--bg-tertiary)",
      borderColor: "var(--border-color)",
      color: "var(--text-primary)",
    },
    dropdown: {
      backgroundColor: "var(--bg-secondary)",
      borderColor: "var(--border-color)",
    },
    option: { color: "var(--text-primary)" },
  };

  const SEGMENTED_DATA = COLUMNS.map((col) => ({
    value: col,
    label: COLUMN_LABELS[col],
  }));

  return (
    <Modal
      opened
      onClose={onClose}
      size="lg"
      fullScreen={isMobile}
      centered
      styles={{
        ...modalStyles,
        title: { display: "none" },
        header: {
          ...modalStyles.header,
          padding: "12px 16px",
          minHeight: "unset",
        },
        body: {
          ...modalStyles.body,
          padding: isMobile ? 16 : 24,
          display: "flex",
          flexDirection: "column" as const,
        },
        content: {
          ...modalStyles.content,
          display: "flex",
          flexDirection: "column" as const,
          maxHeight: isMobile ? "100vh" : "85vh",
        },
      }}
      title=" "
    >
      <Stack gap="md" style={{ flex: 1, minHeight: 0, display: "flex", flexDirection: "column" }}>
        {/* ---- Header: Editable title ---- */}
        <Box>
          {editingTitle ? (
            <TextInput
              value={editTitle}
              onChange={(e) => setEditTitle(e.currentTarget.value)}
              onBlur={handleTitleSave}
              onKeyDown={(e) => {
                if (e.key === "Enter") handleTitleSave();
                if (e.key === "Escape") {
                  setEditTitle(task.title);
                  setEditingTitle(false);
                }
              }}
              autoFocus
              size="lg"
              styles={{
                input: {
                  backgroundColor: "var(--bg-tertiary)",
                  borderColor: "var(--accent-blue)",
                  color: "var(--text-primary)",
                  fontWeight: 700,
                  fontSize: 18,
                },
              }}
            />
          ) : (
            <Group gap={8} align="flex-start" wrap="nowrap" style={{ cursor: "pointer" }} onClick={() => setEditingTitle(true)}>
              <Text fw={700} size="lg" c="var(--text-primary)" style={{ flex: 1, lineHeight: 1.3 }}>
                {task.title}
              </Text>
              <Tooltip label="Edit title">
                <ActionIcon variant="subtle" size="sm" color="gray" style={{ flexShrink: 0, marginTop: 2 }}>
                  <span style={{ fontSize: 13 }}>&#9998;</span>
                </ActionIcon>
              </Tooltip>
            </Group>
          )}
        </Box>

        {/* ---- Metadata row ---- */}
        <Group gap="sm" wrap="wrap">
          <Tooltip label="Click to copy task ID">
            <Badge
              variant="light"
              color="gray"
              size="sm"
              style={{ cursor: "pointer", fontFamily: "var(--font-mono)", letterSpacing: "0.02em" }}
              onClick={() => navigator.clipboard.writeText(task.id)}
            >
              #{task.id.slice(0, 8)}
            </Badge>
          </Tooltip>
          <Text size="xs" c="dimmed">
            Created {timeAgo(task.createdAt)} by {task.createdBy}
          </Text>
          {saving && (
            <Badge variant="light" color="blue" size="xs">
              Saving...
            </Badge>
          )}
        </Group>

        <Divider color="var(--border-color)" />

        {/* ---- Details grid ---- */}
        <Stack gap="md">
          {/* Status */}
          <Box>
            <Text size="sm" fw={500} c="dimmed" mb={6}>
              Status
            </Text>
            <SegmentedControl
              value={task.status}
              onChange={(val) => onChangeStatus(task.id, val)}
              data={SEGMENTED_DATA}
              size="xs"
              fullWidth
              styles={{
                root: {
                  backgroundColor: "var(--bg-tertiary)",
                  border: "1px solid var(--border-color)",
                },
                label: {
                  color: "var(--text-primary)",
                  fontWeight: 500,
                  fontSize: 12,
                  padding: "6px 12px",
                },
                indicator: {
                  backgroundColor: COLUMN_CSS_COLORS[task.status] || "var(--accent-blue)",
                  boxShadow: "none",
                },
              }}
            />
          </Box>

          {/* Assignee */}
          <Box>
            <Text size="sm" fw={500} c="dimmed" mb={6}>
              Assignee
            </Text>
            <Select
              placeholder="Unassigned"
              data={agentSelectData}
              value={editAssignee || null}
              onChange={handleAssigneeChange}
              clearable
              size="sm"
              styles={selectDropdownStyles}
            />
          </Box>

          {/* Priority */}
          <Box>
            <Text size="sm" fw={500} c="dimmed" mb={6}>
              Priority
            </Text>
            <SegmentedControl
              value={task.priority}
              onChange={(val) => saveField("priority", val)}
              data={[
                { value: "P0", label: "P0 Critical" },
                { value: "P1", label: "P1 High" },
                { value: "P2", label: "P2 Medium" },
                { value: "P3", label: "P3 Low" },
              ]}
              size="xs"
              fullWidth
              styles={{
                root: {
                  backgroundColor: "var(--bg-tertiary)",
                  border: "1px solid var(--border-color)",
                },
                label: {
                  color: "var(--text-primary)",
                  fontWeight: 500,
                  fontSize: 12,
                  padding: "6px 12px",
                },
                indicator: {
                  backgroundColor: PRIORITY_COLORS[task.priority] === "red" ? "var(--mantine-color-red-6)" :
                                   PRIORITY_COLORS[task.priority] === "orange" ? "var(--mantine-color-orange-6)" :
                                   PRIORITY_COLORS[task.priority] === "blue" ? "var(--accent-blue)" :
                                   "var(--text-muted)",
                  boxShadow: "none",
                },
              }}
            />
          </Box>

          {/* Labels */}
          <Box>
            <Text size="sm" fw={500} c="dimmed" mb={6}>
              Labels
            </Text>
            <TagsInput
              placeholder="Add label"
              value={editLabels}
              onChange={handleLabelsChange}
              size="sm"
              styles={{
                input: {
                  backgroundColor: "var(--bg-tertiary)",
                  borderColor: "var(--border-color)",
                  color: "var(--text-primary)",
                },
              }}
            />
          </Box>

          {/* Due Date */}
          <Box>
            <Text size="sm" fw={500} c="dimmed" mb={6}>
              Due Date
            </Text>
            <DateInput
              placeholder="Select due date"
              value={editDueDate ? new Date(editDueDate) : null}
              onChange={handleDateChange((v) => handleDueDateChange(v))}
              clearable
              size="sm"
              popoverProps={{
                styles: {
                  dropdown: {
                    backgroundColor: "var(--bg-secondary)",
                    borderColor: "var(--border-color)",
                  },
                },
              }}
              styles={{
                input: {
                  backgroundColor: "var(--bg-tertiary)",
                  borderColor: "var(--border-color)",
                  color: "var(--text-primary)",
                },
                calendarHeader: { backgroundColor: "var(--bg-secondary)" },
                calendarHeaderControl: { color: "var(--text-primary)" },
                calendarHeaderLevel: { color: "var(--text-primary)" },
                weekday: { color: "var(--text-muted)" },
                day: { color: "var(--text-primary)" },
              }}
            />
          </Box>
        </Stack>

        {/* ---- Description ---- */}
        <Box>
          <Group gap={6} mb={6}>
            <Text size="sm" fw={500} c="dimmed">
              Description
            </Text>
            {!editingDesc && (
              <Tooltip label="Edit description">
                <ActionIcon variant="subtle" size="xs" color="gray" onClick={() => setEditingDesc(true)}>
                  <span style={{ fontSize: 11 }}>&#9998;</span>
                </ActionIcon>
              </Tooltip>
            )}
          </Group>
          {editingDesc ? (
            <Stack gap="xs">
              <Textarea
                value={editDesc}
                onChange={(e) => setEditDesc(e.currentTarget.value)}
                autoFocus
                autosize
                minRows={3}
                maxRows={8}
                onKeyDown={(e) => {
                  if (e.key === "Escape") {
                    setEditDesc(task.description || "");
                    setEditingDesc(false);
                  }
                }}
                styles={{
                  input: {
                    backgroundColor: "var(--bg-tertiary)",
                    borderColor: "var(--accent-blue)",
                    color: "var(--text-primary)",
                    fontSize: 13,
                  },
                }}
              />
              <Group gap="xs">
                <Button size="xs" variant="filled" color="blue" onClick={handleDescSave}>
                  Save
                </Button>
                <Button
                  size="xs"
                  variant="subtle"
                  color="gray"
                  onClick={() => {
                    setEditDesc(task.description || "");
                    setEditingDesc(false);
                  }}
                >
                  Cancel
                </Button>
              </Group>
            </Stack>
          ) : task.description ? (
            <Paper
              p="sm"
              style={{
                backgroundColor: "var(--bg-tertiary)",
                borderRadius: 8,
                cursor: "pointer",
                fontSize: 13,
                lineHeight: 1.6,
              }}
              onClick={() => setEditingDesc(true)}
            >
              <MarkdownText>{task.description}</MarkdownText>
            </Paper>
          ) : (
            <Text
              size="sm"
              c="dimmed"
              fs="italic"
              style={{ cursor: "pointer" }}
              onClick={() => setEditingDesc(true)}
            >
              Click to add a description...
            </Text>
          )}
        </Box>

        {/* ---- Dependencies ---- */}
        {task.dependencies && task.dependencies.length > 0 && (
          <Box>
            <Text size="sm" fw={500} c="dimmed" mb={8}>
              Dependencies ({task.dependencies.length})
            </Text>
            <Stack gap={4}>
              {task.dependencies.map((depId) => {
                const depTask = tasks.find((t) => t.id === depId);
                const isDone = depTask?.status === "done";
                return (
                  <Paper
                    key={depId}
                    px="sm"
                    py={8}
                    style={{
                      backgroundColor: "var(--bg-tertiary)",
                      borderRadius: 6,
                      cursor: depTask ? "pointer" : "default",
                    }}
                    onClick={() => {
                      if (depTask) onNavigateTask(depId);
                    }}
                  >
                    <Group gap={8}>
                      <Text size="sm" style={{ lineHeight: 1 }}>{isDone ? "\u2705" : "\u23F3"}</Text>
                      <Text
                        size="xs"
                        c={isDone ? "var(--accent-green)" : "var(--text-primary)"}
                        td={isDone ? "line-through" : undefined}
                        style={{ flex: 1 }}
                      >
                        {depTask?.title || depId}
                      </Text>
                      <Badge
                        size="xs"
                        variant="light"
                        color={isDone ? "green" : COLUMN_COLORS[depTask?.status || "pending"] || "gray"}
                      >
                        {isDone ? "Done" : depTask ? (COLUMN_LABELS[depTask.status] || depTask.status) : "Unknown"}
                      </Badge>
                    </Group>
                  </Paper>
                );
              })}
            </Stack>
          </Box>
        )}

        {/* ---- Blocked alert ---- */}
        {task.blocked && (
          <Alert
            color="yellow"
            variant="light"
            icon={<span style={{ fontSize: 14 }}>&#128274;</span>}
            styles={{ message: { fontSize: 13 } }}
          >
            {task.blockedReason || "This task is blocked by incomplete dependencies"}
          </Alert>
        )}

        <Divider color="var(--border-color)" />

        {/* ---- Comments section ---- */}
        <Box style={{ flex: 1, minHeight: 0, display: "flex", flexDirection: "column" }}>
          <Group gap={8} mb="sm">
            <Text size="sm" fw={600} c="var(--text-primary)">
              Comments
            </Text>
            {task.comments && task.comments.length > 0 && (
              <Badge variant="light" color="blue" size="xs" circle>
                {task.comments.length}
              </Badge>
            )}
          </Group>

          {/* Scrollable comments container */}
          <ScrollArea
            mah={300}
            mb="sm"
            type="auto"
            offsetScrollbars
            style={{
              flex: 1,
              minHeight: task.comments && task.comments.length > 0 ? 100 : 40,
            }}
          >
            {task.comments && task.comments.length > 0 ? (
              <Stack gap={8}>
                {task.comments.map((comment) => (
                  <Paper
                    key={comment.id}
                    p="sm"
                    radius="md"
                    style={{
                      backgroundColor: "var(--bg-tertiary)",
                      border: "1px solid var(--border-color)",
                    }}
                  >
                    <Group justify="space-between" mb={4} wrap="nowrap">
                      <Group gap={6} wrap="nowrap">
                        {/* Avatar circle */}
                        <Box
                          style={{
                            width: 22,
                            height: 22,
                            borderRadius: "50%",
                            backgroundColor: "var(--accent-blue)",
                            display: "flex",
                            alignItems: "center",
                            justifyContent: "center",
                            flexShrink: 0,
                          }}
                        >
                          <Text size="xs" fw={700} c="white" style={{ fontSize: 10, lineHeight: 1 }}>
                            {(comment.authorName || comment.author || "?").charAt(0).toUpperCase()}
                          </Text>
                        </Box>
                        <Text size="xs" fw={600} c="var(--text-primary)">
                          {comment.authorName || comment.author}
                        </Text>
                      </Group>
                      <Text size="xs" c="dimmed" style={{ flexShrink: 0 }}>
                        {timeAgo(comment.createdAt)}
                      </Text>
                    </Group>
                    <Box ml={28} style={{ fontSize: 13, lineHeight: 1.5 }}>
                      <MarkdownText>{comment.text}</MarkdownText>
                    </Box>
                  </Paper>
                ))}
              </Stack>
            ) : (
              <Text size="xs" c="dimmed" fs="italic" ta="center" py="md">
                No comments yet
              </Text>
            )}
          </ScrollArea>

          {/* Compact comment input */}
          <Group gap={8} align="flex-end" wrap="nowrap">
            <Textarea
              value={commentText}
              onChange={(e) => setCommentText(e.currentTarget.value)}
              placeholder="Add a comment..."
              autosize
              minRows={1}
              maxRows={3}
              style={{ flex: 1 }}
              onKeyDown={(e) => {
                if (e.key === "Enter" && (e.metaKey || e.ctrlKey) && commentText.trim()) {
                  onAddComment(task.id);
                }
              }}
              styles={{
                input: {
                  backgroundColor: "var(--bg-tertiary)",
                  borderColor: "var(--border-color)",
                  color: "var(--text-primary)",
                  fontSize: 13,
                },
              }}
            />
            <Tooltip label="Send (Cmd+Enter)">
              <ActionIcon
                variant="filled"
                color="blue"
                size="lg"
                onClick={() => onAddComment(task.id)}
                disabled={!commentText.trim()}
                style={{ flexShrink: 0 }}
              >
                <span style={{ fontSize: 16, lineHeight: 1 }}>&#10148;</span>
              </ActionIcon>
            </Tooltip>
          </Group>
        </Box>
      </Stack>
    </Modal>
  );
}
