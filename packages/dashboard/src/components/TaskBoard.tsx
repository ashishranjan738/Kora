import { useState, useEffect, useCallback, useRef } from "react";
import { useApi } from "../hooks/useApi";
import { showError, showInfo, showSuccess } from "../utils/notifications";
import { ConfirmDialog } from "./ConfirmDialog";
import { DependencyArrows } from "./DependencyArrows";
import {
  Modal, Button, TextInput, Textarea, Select, MultiSelect, Stack, Group, Text, Badge, Card, Paper,
  ActionIcon, ScrollArea, Checkbox, Alert, Box, Tooltip, Divider, SegmentedControl, TagsInput,
} from "@mantine/core";
import { DateInput } from "@mantine/dates";
import { useMediaQuery } from "@mantine/hooks";
import { Virtuoso } from "react-virtuoso";
import { MarkdownText } from "./MarkdownText";

const handleDateChange = (setter: (v: string | null) => void) => (value: Date | string | null) => {
  if (value instanceof Date) { setter(value.toISOString().split("T")[0]); } else { setter(value); }
};

interface TaskComment { id: string; text: string; author: string; authorName?: string; createdAt: string; }
interface Task {
  id: string; title: string; description: string; status: string; priority: string;
  labels?: string[]; dueDate?: string; assignedTo?: string; createdBy: string; createdAt: string;
  comments?: TaskComment[]; dependencies?: string[]; blocked?: boolean; blockedReason?: string;
}
interface WorkflowState { id: string; label: string; color: string; category?: string; transitions?: string[]; skippable?: boolean; }
interface TaskBoardProps { sessionId: string; initialTaskId?: string; workflowStates?: WorkflowState[]; }

const DEFAULT_COLUMNS = ["pending", "in-progress", "review", "done"];
const DEFAULT_COLUMN_LABELS: Record<string, string> = { pending: "Backlog", "in-progress": "In Progress", review: "Review", done: "Done" };
const DEFAULT_COLUMN_COLORS: Record<string, string> = { pending: "gray", "in-progress": "blue", review: "yellow", done: "green" };
const DEFAULT_COLUMN_CSS_COLORS: Record<string, string> = { pending: "var(--text-muted)", "in-progress": "var(--accent-blue)", review: "var(--accent-yellow)", done: "var(--accent-green)" };

function hexToMantineColor(hex: string): string {
  const map: Record<string, string> = { "#6b7280": "gray", "#9ca3af": "gray", "#3b82f6": "blue", "#2563eb": "blue", "#f59e0b": "yellow", "#d97706": "yellow", "#22c55e": "green", "#16a34a": "green", "#8b5cf6": "grape", "#7c3aed": "grape", "#06b6d4": "cyan", "#0891b2": "cyan", "#ef4444": "red", "#f85149": "red", "#f97316": "orange" };
  return map[hex?.toLowerCase()] || "blue";
}
const PRIORITY_COLORS: Record<string, string> = { P0: "red", P1: "orange", P2: "blue", P3: "gray" };
function getLabelColor(label: string): string { const colors = ["blue","cyan","teal","green","lime","yellow","orange","red","pink","grape","violet","indigo"]; let hash = 0; for (let i = 0; i < label.length; i++) { hash = label.charCodeAt(i) + ((hash << 5) - hash); } return colors[Math.abs(hash) % colors.length]; }
function extractNameFromAgentId(agentId: string): string { const m = agentId.match(/^(.+)-[0-9a-f]{6,}$/); return m ? m[1].charAt(0).toUpperCase() + m[1].slice(1) : agentId; }
function resolveAssignee(assignedTo: string | undefined, agents: { id: string; name: string }[]): { name: string; isRemoved: boolean } | null { if (!assignedTo) return null; const a = agents.find((a) => a.id === assignedTo || a.name === assignedTo || a.name.toLowerCase() === assignedTo.toLowerCase()); return a ? { name: a.name, isRemoved: false } : { name: extractNameFromAgentId(assignedTo), isRemoved: true }; }
function getDueDateStatus(dueDate: string): { label: string; color: string } | null { if (!dueDate) return null; const today = new Date(); today.setHours(0,0,0,0); const due = new Date(dueDate); due.setHours(0,0,0,0); const d = Math.floor((due.getTime() - today.getTime()) / 86400000); if (d < 0) return { label: "Overdue", color: "red" }; if (d === 0) return { label: "Due today", color: "yellow" }; if (d <= 2) return { label: "Due soon", color: "yellow" }; return { label: dueDate, color: "gray" }; }
function timeAgo(dateStr: string): string { const s = Math.floor((Date.now() - new Date(dateStr).getTime()) / 1000); if (s < 60) return `${s}s ago`; const m = Math.floor(s / 60); if (m < 60) return `${m}m ago`; const h = Math.floor(m / 60); if (h < 24) return `${h}h ago`; return `${Math.floor(h / 24)}d ago`; }
function getTaskAge(c: string): number { return (Date.now() - new Date(c).getTime()) / 3600000; }
function getTaskAgeBadge(c: string): { label: string; color: string } | null { const h = getTaskAge(c); const t = timeAgo(c); if (h >= 4) return { label: t, color: "red" }; if (h >= 2) return { label: t, color: "orange" }; return null; }

function TaskCard({ task, agents, isDragging, onDragStart, onClick, onDelete, onShiftDragStart, onShiftDragEnd }: { task: Task; agents: { id: string; name: string }[]; isDragging: boolean; onDragStart: () => void; onClick: () => void; onDelete: () => void; onShiftDragStart?: (taskId: string) => void; onShiftDragEnd?: (taskId: string) => void; }) {
  const assignee = resolveAssignee(task.assignedTo, agents); const ds = task.dueDate ? getDueDateStatus(task.dueDate) : null; const isOverdue = ds?.label === "Overdue"; const ab = getTaskAgeBadge(task.createdAt);
  return (<Card data-task-id={task.id} draggable onDragStart={(e) => { if (e.shiftKey && onShiftDragStart) { onShiftDragStart(task.id); } else { onDragStart(); } }} onDragOver={(e) => { if (e.shiftKey) e.preventDefault(); }} onDrop={(e) => { if (e.shiftKey && onShiftDragEnd) { e.stopPropagation(); onShiftDragEnd(task.id); } }} onClick={(e) => { if (!(e.target as HTMLElement).closest("button")) onClick(); }} withBorder padding="sm" style={{ cursor: "pointer", opacity: isDragging ? 0.5 : task.blocked ? 0.7 : 1, borderColor: isDragging ? "var(--accent-blue)" : isOverdue ? "var(--accent-red)" : "var(--border-color)", borderWidth: isOverdue ? 2 : 1, backgroundColor: task.blocked ? "var(--bg-tertiary)" : "var(--bg-primary)", boxShadow: isOverdue ? "0 0 0 1px var(--accent-red), 0 0 8px rgba(255,100,100,0.3)" : undefined, transition: "border-color 0.15s, box-shadow 0.15s, opacity 0.15s", filter: task.blocked ? "grayscale(0.3)" : undefined }} className="task-card-hover">
    <Group justify="space-between" align="flex-start" gap={4} wrap="nowrap"><Text fw={600} size="sm" c="var(--text-primary)" lineClamp={2} style={{ flex: 1 }}>{task.title}</Text><ActionIcon variant="subtle" color="red" size="xs" onClick={(e) => { e.stopPropagation(); onDelete(); }} title="Delete task" style={{ opacity: 0.4, flexShrink: 0 }} className="task-delete-btn"><span style={{ fontSize: 14, lineHeight: 1 }}>&times;</span></ActionIcon></Group>
    {task.blocked && <Badge color="yellow" variant="light" size="xs" mt={4} leftSection={<span style={{ fontSize: 10 }}>&#128279;</span>}>Blocked</Badge>}
    <Group gap={4} mt={4}><Badge color={PRIORITY_COLORS[task.priority]} variant="filled" size="xs">{task.priority}</Badge>{ab && <Badge color={ab.color} variant="light" size="xs" leftSection={<span style={{ fontSize: 10 }}>&#8987;</span>}>{ab.label}</Badge>}</Group>
    {task.labels && task.labels.length > 0 && <Group gap={4} mt={4}>{task.labels.map((l) => <Badge key={l} color={getLabelColor(l)} variant="outline" size="xs">{l}</Badge>)}</Group>}
    {task.dueDate && (() => { const s = getDueDateStatus(task.dueDate); return s ? <Badge color={s.color} variant="light" size="xs" mt={4} leftSection={<span style={{ fontSize: 10 }}>&#x1F4C5;</span>}>{s.label}</Badge> : null; })()}
    {task.description && <Text size="xs" c="var(--text-secondary)" lineClamp={2} mt={4} lh={1.4}>{task.description}</Text>}
    <Group justify="space-between" align="center" mt="xs" gap={4}>{assignee ? <Badge variant="light" color={assignee.isRemoved ? "gray" : "blue"} size="xs" styles={assignee.isRemoved ? { label: { fontStyle: "italic", opacity: 0.7 } } : undefined}>{assignee.name}{assignee.isRemoved ? " (removed)" : ""}</Badge> : <Text size="xs" c="var(--text-muted)">Unassigned</Text>}<Group gap={6}>{task.comments && task.comments.length > 0 && <Badge variant="light" color="blue" size="xs">{task.comments.length}</Badge>}<Text size="xs" c="var(--text-muted)">{timeAgo(task.createdAt)}</Text></Group></Group>
    <Tooltip label={`#${task.id}`} position="bottom"><Text size="xs" ff="var(--font-mono)" c="var(--text-muted)" mt={4} className="task-id-text" style={{ fontSize: 10, opacity: 0 }} onClick={(e) => { e.stopPropagation(); navigator.clipboard.writeText(task.id); }}>#{task.id.slice(0, 8)}</Text></Tooltip>
  </Card>);
}

const COLLAPSE_THRESHOLD = 20; // Auto-collapse columns with more than this many tasks

function TaskColumn({ column, tasks, agents, draggedTaskId, dragOverColumn, onDragStart, onDragOver, onDragLeave, onDrop, onTaskClick, onTaskDelete, onAddClick, showAddButton, columnLabels, columnColors, columnCssColors, onShiftDragStart, onShiftDragEnd }: { column: string; tasks: Task[]; agents: { id: string; name: string }[]; draggedTaskId: string | null; dragOverColumn: string | null; onDragStart: (id: string) => void; onDragOver: (e: React.DragEvent, col: string) => void; onDragLeave: () => void; onDrop: (e: React.DragEvent, col: string) => void; onTaskClick: (id: string) => void; onTaskDelete: (id: string) => void; onAddClick: () => void; showAddButton?: boolean; columnLabels: Record<string, string>; columnColors: Record<string, string>; columnCssColors: Record<string, string>; onShiftDragStart?: (id: string) => void; onShiftDragEnd?: (id: string) => void; }) {
  const isDO = dragOverColumn === column;
  const css = columnCssColors[column] || "var(--text-muted)";
  const bc = columnColors[column] || "gray";
  const lb = columnLabels[column] || column;
  const [collapsed, setCollapsed] = useState(tasks.length > COLLAPSE_THRESHOLD);

  // Auto-collapse when task count crosses threshold
  useEffect(() => {
    if (tasks.length > COLLAPSE_THRESHOLD) setCollapsed(true);
  }, [tasks.length > COLLAPSE_THRESHOLD]);

  return (
    <Paper withBorder p="sm" style={{
      backgroundColor: isDO ? "rgba(88,166,255,0.06)" : "var(--bg-secondary)",
      borderColor: isDO ? "var(--accent-blue)" : "var(--border-color)",
      borderStyle: isDO ? "dashed" : "solid", borderWidth: isDO ? 2 : 1,
      minHeight: collapsed ? "auto" : 400, display: "flex", flexDirection: "column",
      transition: "border-color 0.15s, background-color 0.15s",
    }} onDragOver={(e) => onDragOver(e, column)} onDragLeave={onDragLeave} onDrop={(e) => onDrop(e, column)}>
      {/* Column header */}
      <Group justify="space-between" align="center" mb="sm" pb="xs" style={{ borderBottom: `2px solid ${css}` }}>
        <Group gap={8} align="center" style={{ cursor: tasks.length > COLLAPSE_THRESHOLD ? "pointer" : undefined }} onClick={() => { if (tasks.length > COLLAPSE_THRESHOLD) setCollapsed(!collapsed); }}>
          <Box style={{ width: 10, height: 10, borderRadius: "50%", background: css, flexShrink: 0 }} />
          <Text fw={600} size="sm" c="var(--text-primary)">{lb}</Text>
          <Badge size="sm" variant="light" color={bc}>{tasks.length}</Badge>
          {tasks.length > COLLAPSE_THRESHOLD && (
            <Text size="xs" c="var(--text-muted)" style={{ cursor: "pointer" }}>
              {collapsed ? "\u25B6" : "\u25BC"}
            </Text>
          )}
        </Group>
        {showAddButton && <ActionIcon variant="subtle" size="sm" onClick={onAddClick} title="Add task" style={{ color: "var(--text-secondary)" }}><span style={{ fontSize: 16 }}>+</span></ActionIcon>}
      </Group>

      {/* Collapsed state: just show count */}
      {collapsed ? (
        <Box ta="center" py="md">
          <Text size="sm" c="var(--text-muted)" style={{ cursor: "pointer" }} onClick={() => setCollapsed(false)}>
            {tasks.length} tasks (click to expand)
          </Text>
        </Box>
      ) : (
        /* Expanded: use Virtuoso for large lists, Stack for small */
        <div style={{ flex: 1, minHeight: 0 }}>
          {tasks.length === 0 ? (
            <Text size="xs" c="var(--text-muted)" ta="center" py="xl" fs="italic">No tasks</Text>
          ) : tasks.length > 50 ? (
            <Virtuoso
              style={{ height: "100%", minHeight: 300 }}
              totalCount={tasks.length}
              itemContent={(index) => {
                const t = tasks[index];
                return (
                  <div style={{ paddingBottom: 8 }}>
                    <TaskCard key={t.id} task={t} agents={agents} isDragging={draggedTaskId === t.id}
                      onDragStart={() => onDragStart(t.id)} onClick={() => onTaskClick(t.id)} onDelete={() => onTaskDelete(t.id)}
                      onShiftDragStart={onShiftDragStart} onShiftDragEnd={onShiftDragEnd} />
                  </div>
                );
              }}
            />
          ) : (
            <Stack gap="xs">
              {tasks.map((t) => <TaskCard key={t.id} task={t} agents={agents} isDragging={draggedTaskId === t.id}
                onDragStart={() => onDragStart(t.id)} onClick={() => onTaskClick(t.id)} onDelete={() => onTaskDelete(t.id)}
                onShiftDragStart={onShiftDragStart} onShiftDragEnd={onShiftDragEnd} />)}
            </Stack>
          )}
        </div>
      )}
    </Paper>
  );
}

export function TaskBoard({ sessionId, initialTaskId, workflowStates }: TaskBoardProps) {
  const COLUMNS: string[] = workflowStates?.length ? workflowStates.map(s => s.id) : DEFAULT_COLUMNS;
  const COLUMN_LABELS: Record<string, string> = workflowStates?.length ? Object.fromEntries(workflowStates.map(s => [s.id, s.label])) : DEFAULT_COLUMN_LABELS;
  const COLUMN_COLORS: Record<string, string> = workflowStates?.length ? Object.fromEntries(workflowStates.map(s => [s.id, hexToMantineColor(s.color)])) : DEFAULT_COLUMN_COLORS;
  const COLUMN_CSS_COLORS: Record<string, string> = workflowStates?.length ? Object.fromEntries(workflowStates.map(s => [s.id, s.color])) : DEFAULT_COLUMN_CSS_COLORS;
  const transitionMap: Record<string, string[] | undefined> = workflowStates?.length ? Object.fromEntries(workflowStates.map(s => [s.id, s.transitions])) : {};
  const hasWorkflowStates = !!(workflowStates?.length);
  const firstCol = COLUMNS[0] || "pending";
  const api = useApi(); const isMobile = useMediaQuery("(max-width: 48em)"); const isTablet = useMediaQuery("(max-width: 62em)");
  const [tasks, setTasks] = useState<Task[]>([]); const [agents, setAgents] = useState<{ id: string; name: string }[]>([]);
  const [dragOverColumn, setDragOverColumn] = useState<string | null>(null); const [draggedTaskId, setDraggedTaskId] = useState<string | null>(null);
  const [showAddDialog, setShowAddDialog] = useState(false); const [newTitle, setNewTitle] = useState(""); const [newDescription, setNewDescription] = useState("");
  const [newAssignee, setNewAssignee] = useState(""); const [newPriority, setNewPriority] = useState("P2"); const [newLabels, setNewLabels] = useState<string[]>([]);
  const [newDueDate, setNewDueDate] = useState<string | null>(null); const [expandedTaskId, setExpandedTaskId] = useState<string | null>(null);
  const [commentText, setCommentText] = useState(""); const [newDependencies, setNewDependencies] = useState<string[]>([]);
  const [confirmDeleteTaskId, setConfirmDeleteTaskId] = useState<string | null>(null); const [activeCol, setActiveCol] = useState<string>(firstCol);
  const [mobileView, setMobileView] = useState<"kanban" | "list">("list");
  const [filterAgent, setFilterAgent] = useState<string | null>(null); const [filterPriorities, setFilterPriorities] = useState<string[]>([]); const [filterLabels, setFilterLabels] = useState<string[]>([]);
  const [showArchived, setShowArchived] = useState(false);
  const [shiftDragSourceId, setShiftDragSourceId] = useState<string | null>(null);
  const boardRef = useRef<HTMLDivElement>(null);
  const closedStatuses = new Set(workflowStates?.filter(s => s.category === "closed").map(s => s.id) || ["done"]);
  const [archivedCount, setArchivedCount] = useState(0);
  const [archiving, setArchiving] = useState(false);
  const fetchTasks = useCallback(async () => { try { const data = await api.getTasks(sessionId, showArchived); setTasks(data.tasks || []); if (data.archivedCount !== undefined) setArchivedCount(data.archivedCount); } catch (err: any) { showError(err.message || "Failed to fetch tasks", "Error"); } }, [sessionId, showArchived]);
  const fetchAgents = useCallback(async () => { try { setAgents(((await api.getAgents(sessionId)).agents || []).map((a: any) => ({ id: a.id, name: a.config?.name || a.name || a.id }))); } catch (err: any) { showError(err.message || "Failed to fetch agents", "Error"); } }, [sessionId]);
  useEffect(() => { fetchTasks(); fetchAgents(); }, [fetchTasks, fetchAgents]);
  useEffect(() => { const i = setInterval(fetchTasks, 5000); return () => clearInterval(i); }, [fetchTasks]);
  useEffect(() => { if (initialTaskId && tasks.length > 0 && tasks.find(t => t.id === initialTaskId)) setExpandedTaskId(initialTaskId); }, [initialTaskId, tasks]);
  const handleDrop = async (e: React.DragEvent, column: string) => {
    e.preventDefault(); setDragOverColumn(null); if (!draggedTaskId) return;
    const task = tasks.find(t => t.id === draggedTaskId); if (!task || task.status === column) { setDraggedTaskId(null); return; }
    if (task.blocked && column === "in-progress") { showInfo(task.blockedReason || "This task has incomplete dependencies", "Cannot start task"); setDraggedTaskId(null); return; }
    const allowed = transitionMap[task.status];
    if (hasWorkflowStates && allowed !== undefined && allowed.length > 0 && !allowed.includes(column)) { showError(`Cannot move from "${COLUMN_LABELS[task.status] || task.status}" to "${COLUMN_LABELS[column] || column}". Valid: ${allowed.map(t => COLUMN_LABELS[t] || t).join(", ")}`, "Invalid transition"); setDraggedTaskId(null); return; }
    if (hasWorkflowStates && allowed !== undefined && allowed.length === 0) { showError(`"${COLUMN_LABELS[task.status] || task.status}" is a terminal state with no allowed transitions.`, "Invalid transition"); setDraggedTaskId(null); return; }
    setTasks(p => p.map(t => t.id === draggedTaskId ? { ...t, status: column } : t)); try { await api.updateTask(sessionId, draggedTaskId, { status: column }); } catch (err: any) { showError(err.message || "Failed to update task status", "Error"); fetchTasks(); } setDraggedTaskId(null);
  };
  const handleAddTask = async () => { if (!newTitle.trim()) return; try { await api.createTask(sessionId, { title: newTitle.trim(), description: newDescription.trim(), assignedTo: newAssignee || undefined, priority: newPriority, labels: newLabels.length > 0 ? newLabels : undefined, dueDate: newDueDate || undefined, dependencies: newDependencies.length > 0 ? newDependencies : undefined }); setNewTitle(""); setNewDescription(""); setNewAssignee(""); setNewPriority("P2"); setNewLabels([]); setNewDueDate(null); setNewDependencies([]); setShowAddDialog(false); fetchTasks(); } catch (err: any) { showError(err.message || "Failed to create task", "Error"); } };
  const executeDeleteTask = async () => { if (!confirmDeleteTaskId) return; setTasks(p => p.filter(t => t.id !== confirmDeleteTaskId)); setConfirmDeleteTaskId(null); try { await api.deleteTask(sessionId, confirmDeleteTaskId); } catch (err: any) { showError(err.message || "Failed to delete task", "Error"); fetchTasks(); } };
  const handleShiftDragStart = (taskId: string) => { setShiftDragSourceId(taskId); };
  const handleShiftDragEnd = async (targetId: string) => {
    if (!shiftDragSourceId || shiftDragSourceId === targetId) { setShiftDragSourceId(null); return; }
    // Source becomes a dependency of target (source blocks target)
    const target = tasks.find(t => t.id === targetId);
    const existingDeps = target?.dependencies || [];
    if (existingDeps.includes(shiftDragSourceId)) { setShiftDragSourceId(null); return; }
    const newDeps = [...existingDeps, shiftDragSourceId];
    setTasks(p => p.map(t => t.id === targetId ? { ...t, dependencies: newDeps } : t));
    try { await api.updateTask(sessionId, targetId, { dependencies: newDeps }); showSuccess(`Linked: "${tasks.find(t => t.id === shiftDragSourceId)?.title}" blocks "${target?.title}"`); fetchTasks(); } catch (err: any) { showError(err.message || "Failed to link dependency", "Error"); fetchTasks(); }
    setShiftDragSourceId(null);
  };
  const handleRemoveDependency = async (taskId: string, depId: string) => {
    const task = tasks.find(t => t.id === taskId);
    if (!task) return;
    const newDeps = (task.dependencies || []).filter(d => d !== depId);
    setTasks(p => p.map(t => t.id === taskId ? { ...t, dependencies: newDeps } : t));
    try { await api.updateTask(sessionId, taskId, { dependencies: newDeps }); fetchTasks(); } catch (err: any) { showError(err.message || "Failed to remove dependency", "Error"); fetchTasks(); }
  };
  const handleAddComment = async (taskId: string) => { if (!commentText.trim()) return; try { await api.addTaskComment(sessionId, taskId, commentText.trim()); setCommentText(""); fetchTasks(); } catch (err: any) { showError(err.message || "Failed to add comment", "Error"); } };
  const handleChangeStatus = async (taskId: string, newStatus: string) => {
    const task = tasks.find(t => t.id === taskId); if (!task || task.status === newStatus) return;
    if (task.blocked && newStatus === "in-progress") { showInfo(task.blockedReason || "This task has incomplete dependencies", "Cannot start task"); return; }
    const allowed = transitionMap[task.status];
    if (hasWorkflowStates && allowed !== undefined && allowed.length > 0 && !allowed.includes(newStatus)) { showError(`Cannot move from "${COLUMN_LABELS[task.status] || task.status}" to "${COLUMN_LABELS[newStatus] || newStatus}". Valid: ${allowed.map(t => COLUMN_LABELS[t] || t).join(", ")}`, "Invalid transition"); return; }
    if (hasWorkflowStates && allowed !== undefined && allowed.length === 0) { showError(`"${COLUMN_LABELS[task.status] || task.status}" is a terminal state with no allowed transitions.`, "Invalid transition"); return; }
    setTasks(p => p.map(t => t.id === taskId ? { ...t, status: newStatus } : t)); try { await api.updateTask(sessionId, taskId, { status: newStatus }); } catch (err: any) { showError(err.message || "Failed to change task status", "Error"); fetchTasks(); }
  };
  const tasksByColumn = (col: string) => { const po: Record<string, number> = { P0: 0, P1: 1, P2: 2, P3: 3 }; return tasks.filter(t => t.status === col && (!filterAgent || t.assignedTo === filterAgent) && (filterPriorities.length === 0 || filterPriorities.includes(t.priority)) && (filterLabels.length === 0 || t.labels?.some(l => filterLabels.includes(l)))).sort((a, b) => { const d = (po[a.priority] ?? 2) - (po[b.priority] ?? 2); return d !== 0 ? d : new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime(); }); };
  const expandedTask = expandedTaskId ? tasks.find(t => t.id === expandedTaskId) : null;
  const agentWorkloads = agents.reduce<Record<string, number>>((acc, a) => { acc[a.id] = tasks.filter(t => t.assignedTo === a.id && t.status !== "done").length; return acc; }, {});
  const maxWorkload = Math.max(...Object.values(agentWorkloads), 1);
  const aIds = new Set(agents.map(a => a.id)); const aNms = new Set(agents.map(a => a.name));
  const staleIds = Array.from(new Set(tasks.map(t => t.assignedTo).filter((id): id is string => !!id && !aIds.has(id) && !aNms.has(id))));
  const agentSelectData = [...agents.map(a => ({ value: a.id, label: a.name })), ...staleIds.map(id => ({ value: id, label: `${extractNameFromAgentId(id)} (removed)` }))];
  const allLabels = Array.from(new Set(tasks.flatMap(t => t.labels || []))).sort();
  const inputStyles = { input: { backgroundColor: "var(--bg-tertiary)", borderColor: "var(--border-color)", color: "var(--text-primary)" }, label: { color: "var(--text-secondary)", fontSize: 13 }, description: { color: "var(--text-muted)" } };
  const selectDropdownStyles = { ...inputStyles, dropdown: { backgroundColor: "var(--bg-secondary)", borderColor: "var(--border-color)" }, option: { color: "var(--text-primary)" } };
  const modalStyles = { header: { backgroundColor: "var(--bg-secondary)", borderBottom: "1px solid var(--border-color)" }, body: { backgroundColor: "var(--bg-secondary)" }, content: { backgroundColor: "var(--bg-secondary)" }, title: { color: "var(--text-primary)", fontWeight: 600 as const, fontSize: 18 }, close: { color: "var(--text-secondary)" } };
  // Desktop: all columns in one row with horizontal scroll (no column cap)
  const addProps = { opened: showAddDialog, onClose: () => { setShowAddDialog(false); setNewTitle(""); setNewDescription(""); setNewAssignee(""); setNewPriority("P2"); setNewLabels([]); setNewDueDate(null); setNewDependencies([]); }, isMobile: !!isMobile, modalStyles, inputStyles, selectDropdownStyles, newTitle, setNewTitle, newDescription, setNewDescription, newAssignee, setNewAssignee, newPriority, setNewPriority, newLabels, setNewLabels, newDueDate, setNewDueDate, agentSelectData, tasks, newDependencies, setNewDependencies, onSubmit: handleAddTask, columnLabels: COLUMN_LABELS, columnCssColors: COLUMN_CSS_COLORS };
  if (tasks.length === 0 && !showAddDialog) return (<Stack align="center" justify="center" py={60} gap="md"><Text size="xl" c="var(--text-muted)">No tasks yet</Text><Text size="sm" c="var(--text-muted)" ta="center" maw={400}>Create your first task to start organizing work for your agents.</Text><Button onClick={() => setShowAddDialog(true)} styles={{ root: { backgroundColor: "var(--accent-blue)", borderColor: "var(--accent-blue)", minHeight: 44 } }}>+ Add Task</Button><AddTaskModal {...addProps} /></Stack>);
  return (<div style={{ position: "relative" }}>
    <ConfirmDialog opened={!!confirmDeleteTaskId} onClose={() => setConfirmDeleteTaskId(null)} onConfirm={executeDeleteTask} title="Delete Task" message={`Delete task "${tasks.find(t => t.id === confirmDeleteTaskId)?.title || "this task"}"? This cannot be undone.`} confirmLabel="Delete" confirmColor="red" />
    <Group gap="md" mb="md" wrap="wrap">
      <Select placeholder="All agents" data={[{ value: "", label: "All agents" }, ...agentSelectData]} value={filterAgent || ""} onChange={v => setFilterAgent(v || null)} clearable searchable styles={selectDropdownStyles} style={{ minWidth: 200 }} renderOption={({ option }) => { if (option.value === "") return <div style={{ padding: 4 }}>{option.label}</div>; const w = agentWorkloads[option.value] || 0; const p = maxWorkload > 0 ? (w / maxWorkload) * 100 : 0; return (<div style={{ padding: "4px 0" }}><Group justify="space-between" gap={8} wrap="nowrap"><Text size="sm" style={{ flex: 1 }}>{option.label}</Text><Text size="xs" c="dimmed" style={{ minWidth: 30, textAlign: "right" }}>{w}</Text></Group><div style={{ height: 3, backgroundColor: "var(--bg-tertiary)", borderRadius: 2, marginTop: 4, overflow: "hidden" }}><div style={{ width: `${p}%`, height: "100%", backgroundColor: w > 5 ? "var(--accent-red)" : w > 2 ? "var(--accent-yellow)" : "var(--accent-blue)", transition: "width 0.2s ease" }} /></div></div>); }} />
      <MultiSelect placeholder="All priorities" data={[{ value: "P0", label: "P0 Critical" }, { value: "P1", label: "P1 High" }, { value: "P2", label: "P2 Medium" }, { value: "P3", label: "P3 Low" }]} value={filterPriorities} onChange={setFilterPriorities} clearable styles={selectDropdownStyles} style={{ minWidth: 180 }} />
      {allLabels.length > 0 && <MultiSelect placeholder="All labels" data={allLabels} value={filterLabels} onChange={setFilterLabels} clearable searchable styles={selectDropdownStyles} style={{ minWidth: 180 }} />}
      {(filterAgent || filterPriorities.length > 0 || filterLabels.length > 0) && <Button variant="subtle" size="xs" color="gray" onClick={() => { setFilterAgent(null); setFilterPriorities([]); setFilterLabels([]); }}>Clear filters</Button>}
      <div style={{ flex: 1 }} />
      {archivedCount > 0 && (
        <Tooltip label={showArchived ? "Hide archived tasks" : `${archivedCount} archived tasks`}>
          <Badge variant={showArchived ? "filled" : "light"} color="gray" size="lg" style={{ cursor: "pointer" }}
            onClick={() => setShowArchived(!showArchived)}>
            &#x1F4E6; {archivedCount} archived
          </Badge>
        </Tooltip>
      )}
      <Tooltip label="Archive done tasks older than 7 days">
        <Button variant="light" size="xs" color="gray" loading={archiving}
          onClick={async () => { setArchiving(true); try { const r = await api.archiveTasks(sessionId); setArchivedCount(r.totalArchived); fetchTasks(); } catch (err: any) { showError(err.message || "Failed to archive tasks", "Error"); } finally { setArchiving(false); } }}>
          Archive old
        </Button>
      </Tooltip>
    </Group>
    {isMobile ? (<Stack gap="sm">
      <Group justify="space-between" align="center"><SegmentedControl value={mobileView} onChange={v => setMobileView(v as "kanban" | "list")} data={[{ value: "list", label: "List" }, { value: "kanban", label: "Board" }]} size="xs" styles={{ root: { backgroundColor: "var(--bg-tertiary)", border: "1px solid var(--border-color)" }, label: { color: "var(--text-primary)", fontWeight: 500, fontSize: 12, padding: "4px 12px" }, indicator: { backgroundColor: "var(--accent-blue)", boxShadow: "none" } }} /><ActionIcon variant="light" color="blue" size="lg" onClick={() => setShowAddDialog(true)}><span style={{ fontSize: 18 }}>+</span></ActionIcon></Group>
      {mobileView === "kanban" ? (<><ScrollArea type="never"><Group gap="xs" wrap="nowrap">{COLUMNS.map(c => <Badge key={c} variant={activeCol === c ? "filled" : "outline"} color={COLUMN_COLORS[c] || "gray"} size="lg" onClick={() => setActiveCol(c)} style={{ cursor: "pointer", minHeight: 36, flexShrink: 0 }}>{COLUMN_LABELS[c] || c} ({tasksByColumn(c).length})</Badge>)}</Group></ScrollArea><Stack gap="xs">{tasksByColumn(activeCol).map(t => <TaskCard key={t.id} task={t} agents={agents} isDragging={false} onDragStart={() => {}} onClick={() => setExpandedTaskId(t.id)} onDelete={() => setConfirmDeleteTaskId(t.id)} />)}{tasksByColumn(activeCol).length === 0 && <Text size="sm" c="var(--text-muted)" ta="center" py="xl" fs="italic">No {(COLUMN_LABELS[activeCol] || activeCol).toLowerCase()} tasks</Text>}</Stack></>) : (<Stack gap="md">{COLUMNS.map(c => { const ct = tasksByColumn(c); const cc = COLUMN_CSS_COLORS[c] || "var(--text-muted)"; return (<Box key={c}><Group gap={8} align="center" mb="xs" pb={6} style={{ borderBottom: `2px solid ${cc}` }}><Box style={{ width: 8, height: 8, borderRadius: "50%", background: cc, flexShrink: 0 }} /><Text fw={600} size="sm" c="var(--text-primary)">{COLUMN_LABELS[c] || c}</Text><Badge size="xs" variant="light" color={COLUMN_COLORS[c] || "gray"}>{ct.length}</Badge></Group>{ct.length > 0 ? <Stack gap={4}>{ct.map(t => { const ta = resolveAssignee(t.assignedTo, agents); return (<Paper key={t.id} withBorder px="sm" py={8} style={{ backgroundColor: t.blocked ? "var(--bg-tertiary)" : "var(--bg-primary)", borderColor: "var(--border-color)", cursor: "pointer", opacity: t.blocked ? 0.7 : 1 }} onClick={() => setExpandedTaskId(t.id)}><Group gap={8} wrap="nowrap" align="center"><Badge color={PRIORITY_COLORS[t.priority]} variant="filled" size="xs" style={{ flexShrink: 0 }}>{t.priority}</Badge><Text size="sm" fw={500} c="var(--text-primary)" lineClamp={1} style={{ flex: 1 }}>{t.title}</Text>{ta && <Badge variant="light" color={ta.isRemoved ? "gray" : "blue"} size="xs" style={{ flexShrink: 0 }}>{ta.name}</Badge>}<ActionIcon variant="subtle" color="red" size="xs" onClick={e => { e.stopPropagation(); setConfirmDeleteTaskId(t.id); }} style={{ opacity: 0.4, flexShrink: 0 }}><span style={{ fontSize: 14, lineHeight: 1 }}>&times;</span></ActionIcon></Group></Paper>); })}</Stack> : <Text size="xs" c="var(--text-muted)" ta="center" py="sm" fs="italic">No tasks</Text>}</Box>); })}</Stack>)}
    </Stack>) : (<div ref={boardRef} style={{ display: "flex", flexWrap: "nowrap", gap: 16, overflowX: "auto", overflowY: "hidden", paddingBottom: 8, position: "relative" }}>
      <DependencyArrows tasks={tasks} containerRef={boardRef} closedStatuses={closedStatuses} onRemoveDependency={handleRemoveDependency} />
      {shiftDragSourceId && <div style={{ position: "fixed", top: 8, left: "50%", transform: "translateX(-50%)", zIndex: 100, padding: "4px 12px", borderRadius: 6, background: "var(--accent-blue)", color: "white", fontSize: 11, fontWeight: 600 }}>Drop on a task to create dependency</div>}
      {COLUMNS.map(c => <div key={c} style={{ minWidth: 280, flex: "1 0 0" }}><TaskColumn column={c} tasks={tasksByColumn(c)} agents={agents} draggedTaskId={draggedTaskId} dragOverColumn={dragOverColumn} onDragStart={id => setDraggedTaskId(id)} onDragOver={(e, col) => { e.preventDefault(); setDragOverColumn(col); }} onDragLeave={() => setDragOverColumn(null)} onDrop={handleDrop} onTaskClick={setExpandedTaskId} onTaskDelete={id => setConfirmDeleteTaskId(id)} onAddClick={() => setShowAddDialog(true)} showAddButton={c === firstCol} columnLabels={COLUMN_LABELS} columnColors={COLUMN_COLORS} columnCssColors={COLUMN_CSS_COLORS} onShiftDragStart={handleShiftDragStart} onShiftDragEnd={handleShiftDragEnd} /></div>)}</div>)}
    <AddTaskModal {...addProps} />
    {expandedTask && <TaskDetailModal task={expandedTask} tasks={tasks} agents={agents} sessionId={sessionId} isMobile={!!isMobile} modalStyles={modalStyles} commentText={commentText} setCommentText={setCommentText} onClose={() => { setExpandedTaskId(null); setCommentText(""); }} onChangeStatus={handleChangeStatus} onAddComment={handleAddComment} onNavigateTask={setExpandedTaskId} inputStyles={inputStyles} fetchTasks={fetchTasks} columns={COLUMNS} columnLabels={COLUMN_LABELS} columnColors={COLUMN_COLORS} columnCssColors={COLUMN_CSS_COLORS} />}
  </div>);
}

/** Simple similarity check: normalized substring + word overlap */
function findSimilarTasks(title: string, tasks: Task[], threshold = 0.6): Task[] {
  if (!title.trim() || title.trim().length < 5) return [];
  const normalize = (s: string) => s.toLowerCase().replace(/[^a-z0-9\s]/g, "").trim();
  const inputNorm = normalize(title);
  const inputWords = new Set(inputNorm.split(/\s+/).filter(w => w.length > 2));
  if (inputWords.size === 0) return [];

  return tasks.filter(t => {
    const tNorm = normalize(t.title);
    // Exact substring match
    if (tNorm.includes(inputNorm) || inputNorm.includes(tNorm)) return true;
    // Word overlap similarity
    const tWords = new Set(tNorm.split(/\s+/).filter(w => w.length > 2));
    if (tWords.size === 0) return false;
    const overlap = [...inputWords].filter(w => tWords.has(w)).length;
    const similarity = overlap / Math.max(inputWords.size, tWords.size);
    return similarity >= threshold;
  });
}

function AddTaskModal({ opened, onClose, isMobile, modalStyles, inputStyles, selectDropdownStyles, newTitle, setNewTitle, newDescription, setNewDescription, newAssignee, setNewAssignee, newPriority, setNewPriority, newLabels, setNewLabels, newDueDate, setNewDueDate, agentSelectData, tasks, newDependencies, setNewDependencies, onSubmit, columnLabels, columnCssColors }: { opened: boolean; onClose: () => void; isMobile: boolean; modalStyles: any; inputStyles: any; selectDropdownStyles: any; newTitle: string; setNewTitle: (v: string) => void; newDescription: string; setNewDescription: (v: string) => void; newAssignee: string; setNewAssignee: (v: string) => void; newPriority: string; setNewPriority: (v: string) => void; newLabels: string[]; setNewLabels: (v: string[]) => void; newDueDate: string | null; setNewDueDate: (v: string | null) => void; agentSelectData: { value: string; label: string }[]; tasks: Task[]; newDependencies: string[]; setNewDependencies: (v: string[]) => void; onSubmit: () => void; columnLabels: Record<string, string>; columnCssColors: Record<string, string>; }) {
  const [duplicateWarning, setDuplicateWarning] = useState<Task[]>([]);
  const [showDuplicateModal, setShowDuplicateModal] = useState(false);

  if (!opened) return null;
  const incomplete = tasks.filter(t => t.status !== "done");

  const handleSubmitWithCheck = () => {
    if (!newTitle.trim()) return;
    const similar = findSimilarTasks(newTitle.trim(), tasks);
    if (similar.length > 0) {
      setDuplicateWarning(similar);
      setShowDuplicateModal(true);
    } else {
      onSubmit();
    }
  };

  const handleCreateAnyway = () => {
    setShowDuplicateModal(false);
    setDuplicateWarning([]);
    onSubmit();
  };

  return (<>
    <Modal opened onClose={onClose} title="Add New Task" size="md" fullScreen={isMobile} centered styles={modalStyles}><Stack gap="sm">
    <TextInput label="Title *" value={newTitle} onChange={e => setNewTitle(e.currentTarget.value)} placeholder="Task title" autoFocus onKeyDown={e => { if (e.key === "Enter" && newTitle.trim()) handleSubmitWithCheck(); }} styles={inputStyles} />
    <Textarea label="Description" value={newDescription} onChange={e => setNewDescription(e.currentTarget.value)} placeholder="Optional description" rows={3} autosize minRows={2} maxRows={5} styles={inputStyles} />
    <Select label="Assign to Agent" placeholder="Unassigned" data={agentSelectData} value={newAssignee || null} onChange={v => setNewAssignee(v || "")} clearable styles={selectDropdownStyles} />
    <Box><Text size="xs" c="var(--text-secondary)" mb={6}>Priority</Text><SegmentedControl value={newPriority} onChange={setNewPriority} data={[{ value: "P0", label: "P0 Critical" }, { value: "P1", label: "P1 High" }, { value: "P2", label: "P2 Medium" }, { value: "P3", label: "P3 Low" }]} size="sm" styles={{ root: { backgroundColor: "var(--bg-tertiary)", border: "1px solid var(--border-color)" }, label: { color: "var(--text-primary)", fontWeight: 500, fontSize: 12, padding: "6px 12px" }, indicator: { backgroundColor: PRIORITY_COLORS[newPriority] === "red" ? "var(--mantine-color-red-6)" : PRIORITY_COLORS[newPriority] === "orange" ? "var(--mantine-color-orange-6)" : PRIORITY_COLORS[newPriority] === "blue" ? "var(--accent-blue)" : "var(--text-muted)", boxShadow: "none" } }} /></Box>
    <TagsInput label="Labels" placeholder="Add label (press Enter)" value={newLabels} onChange={setNewLabels} styles={inputStyles} />
    <DateInput label="Due Date" placeholder="Select due date" value={newDueDate ? new Date(newDueDate) : null} onChange={handleDateChange(setNewDueDate)} clearable popoverProps={{ styles: { dropdown: { backgroundColor: "var(--bg-secondary)", borderColor: "var(--border-color)" } } }} styles={{ ...inputStyles, calendarHeader: { backgroundColor: "var(--bg-secondary)" }, calendarHeaderControl: { color: "var(--text-primary)" }, calendarHeaderLevel: { color: "var(--text-primary)" }, weekday: { color: "var(--text-muted)" }, day: { color: "var(--text-primary)" } }} />
    {incomplete.length > 0 && <Box><Text size="xs" c="var(--text-secondary)" mb={4}>Dependencies (blocks this task)</Text><ScrollArea mah={150} style={{ border: "1px solid var(--border-color)", borderRadius: 6, backgroundColor: "var(--bg-tertiary)" }}>{incomplete.map(t => <Group key={t.id} gap={8} p="xs" style={{ borderBottom: "1px solid var(--border-color)", cursor: "pointer", minHeight: 44 }} onClick={() => { newDependencies.includes(t.id) ? setNewDependencies(newDependencies.filter(d => d !== t.id)) : setNewDependencies([...newDependencies, t.id]); }}><Checkbox checked={newDependencies.includes(t.id)} onChange={() => {}} size="sm" styles={{ input: { backgroundColor: "var(--bg-primary)", borderColor: "var(--border-color)" } }} /><Text size="xs" c="var(--text-primary)" style={{ flex: 1 }}>{t.title}</Text><Text size="xs" fw={500} c={columnCssColors[t.status] || "var(--text-muted)"}>{columnLabels[t.status] || t.status}</Text></Group>)}</ScrollArea></Box>}
    <Group justify="flex-end" mt="md"><Button variant="default" onClick={onClose} styles={{ root: { backgroundColor: "var(--bg-tertiary)", borderColor: "var(--border-color)", color: "var(--text-primary)", minHeight: 44 } }}>Cancel</Button><Button onClick={handleSubmitWithCheck} disabled={!newTitle.trim()} styles={{ root: { backgroundColor: "var(--accent-blue)", borderColor: "var(--accent-blue)", minHeight: 44 } }}>Create Task</Button></Group>
  </Stack></Modal>

    {/* Duplicate Warning Modal */}
    <Modal opened={showDuplicateModal} onClose={() => setShowDuplicateModal(false)} title={"\u26A0\uFE0F Similar task found"} size="sm" centered styles={modalStyles}>
      <Stack gap="sm">
        <Text size="sm">A task with a similar title already exists:</Text>
        {duplicateWarning.map(t => (
          <Paper key={t.id} p="xs" withBorder>
            <Text size="sm" fw={500} lineClamp={2}>{t.title}</Text>
            <Group gap="xs" mt={4}>
              <Badge size="xs" color={columnCssColors[t.status] || "gray"} variant="light">{columnLabels[t.status] || t.status}</Badge>
              <Text size="xs" c="dimmed">ID: {t.id.slice(0, 8)}</Text>
            </Group>
          </Paper>
        ))}
        <Group justify="flex-end" mt="sm">
          <Button variant="default" size="xs" onClick={() => setShowDuplicateModal(false)} styles={{ root: { backgroundColor: "var(--bg-tertiary)", borderColor: "var(--border-color)", color: "var(--text-primary)" } }}>Cancel</Button>
          <Button size="xs" color="orange" onClick={handleCreateAnyway}>Create Anyway</Button>
        </Group>
      </Stack>
    </Modal>
  </>);
}

function TaskDetailModal({ task, tasks, agents, sessionId, isMobile, modalStyles, commentText, setCommentText, onClose, onChangeStatus, onAddComment, onNavigateTask, inputStyles, fetchTasks, columns, columnLabels, columnColors, columnCssColors }: { task: Task; tasks: Task[]; agents: { id: string; name: string }[]; sessionId: string; isMobile: boolean; modalStyles: any; commentText: string; setCommentText: (v: string) => void; onClose: () => void; onChangeStatus: (taskId: string, status: string) => void; onAddComment: (taskId: string) => void; onNavigateTask: (taskId: string) => void; inputStyles: any; fetchTasks: () => void; columns: string[]; columnLabels: Record<string, string>; columnColors: Record<string, string>; columnCssColors: Record<string, string>; }) {
  const api = useApi();
  const [editingTitle, setEditingTitle] = useState(false); const [editingDesc, setEditingDesc] = useState(false);
  const [editTitle, setEditTitle] = useState(task.title); const [editDesc, setEditDesc] = useState(task.description || "");
  const [editAssignee, setEditAssignee] = useState(task.assignedTo || ""); const [editLabels, setEditLabels] = useState(task.labels || []);
  const [editDueDate, setEditDueDate] = useState<string | null>(task.dueDate || null); const [saving, setSaving] = useState(false);
  useEffect(() => { setEditTitle(task.title); setEditDesc(task.description || ""); setEditAssignee(task.assignedTo || ""); setEditLabels(task.labels || []); setEditDueDate(task.dueDate || null); }, [task.id, task.title, task.description, task.assignedTo, task.labels, task.dueDate]);
  const assignee = resolveAssignee(task.assignedTo, agents);
  const agentSelectData = [...agents.map(a => ({ value: a.id, label: a.name })), ...(assignee?.isRemoved && task.assignedTo ? [{ value: task.assignedTo, label: `${assignee.name} (removed)` }] : [])];
  const saveField = async (f: string, v: string) => { setSaving(true); try { await api.updateTask(sessionId, task.id, { [f]: v || undefined }); fetchTasks(); } catch (err: any) { showError(err.message || "Failed to save field", "Error"); } finally { setSaving(false); } };
  const handleTitleSave = () => { if (editTitle.trim() && editTitle !== task.title) saveField("title", editTitle.trim()); setEditingTitle(false); };
  const handleDescSave = () => { if (editDesc !== (task.description || "")) saveField("description", editDesc.trim()); setEditingDesc(false); };
  const selectDropdownStyles = { input: { backgroundColor: "var(--bg-tertiary)", borderColor: "var(--border-color)", color: "var(--text-primary)" }, dropdown: { backgroundColor: "var(--bg-secondary)", borderColor: "var(--border-color)" }, option: { color: "var(--text-primary)" } };
  const SEGMENTED_DATA = columns.map(c => ({ value: c, label: columnLabels[c] || c }));
  return (<Modal opened onClose={onClose} size="lg" fullScreen={isMobile} centered styles={{ ...modalStyles, title: { display: "none" }, header: { ...modalStyles.header, padding: "12px 16px", minHeight: "unset" }, body: { ...modalStyles.body, padding: isMobile ? 16 : 24, display: "flex", flexDirection: "column" as const }, content: { ...modalStyles.content, display: "flex", flexDirection: "column" as const, maxHeight: isMobile ? "100vh" : "85vh" } }} title=" ">
    <Stack gap="md" style={{ flex: 1, minHeight: 0, display: "flex", flexDirection: "column" }}>
      <Box>{editingTitle ? <TextInput value={editTitle} onChange={e => setEditTitle(e.currentTarget.value)} onBlur={handleTitleSave} onKeyDown={e => { if (e.key === "Enter") handleTitleSave(); if (e.key === "Escape") { setEditTitle(task.title); setEditingTitle(false); } }} autoFocus size="lg" styles={{ input: { backgroundColor: "var(--bg-tertiary)", borderColor: "var(--accent-blue)", color: "var(--text-primary)", fontWeight: 700, fontSize: 18 } }} /> : <Group gap={8} align="flex-start" wrap="nowrap" style={{ cursor: "pointer" }} onClick={() => setEditingTitle(true)}><Text fw={700} size="lg" c="var(--text-primary)" style={{ flex: 1, lineHeight: 1.3 }}>{task.title}</Text><Tooltip label="Edit title"><ActionIcon variant="subtle" size="sm" color="gray" style={{ flexShrink: 0, marginTop: 2 }}><span style={{ fontSize: 13 }}>&#9998;</span></ActionIcon></Tooltip></Group>}</Box>
      <Group gap="sm" wrap="wrap"><Tooltip label="Click to copy task ID"><Badge variant="light" color="gray" size="sm" style={{ cursor: "pointer", fontFamily: "var(--font-mono)" }} onClick={() => navigator.clipboard.writeText(task.id)}>#{task.id.slice(0, 8)}</Badge></Tooltip><Text size="xs" c="dimmed">Created {timeAgo(task.createdAt)} by {task.createdBy}</Text>{saving && <Badge variant="light" color="blue" size="xs">Saving...</Badge>}</Group>
      <Divider color="var(--border-color)" />
      <Stack gap="md">
        <Box><Text size="sm" fw={500} c="dimmed" mb={6}>Status</Text><ScrollArea type="auto" offsetScrollbars><SegmentedControl value={task.status} onChange={v => onChangeStatus(task.id, v)} data={SEGMENTED_DATA} size="xs" fullWidth styles={{ root: { backgroundColor: "var(--bg-tertiary)", border: "1px solid var(--border-color)" }, label: { color: "var(--text-primary)", fontWeight: 500, fontSize: 12, padding: "6px 12px" }, indicator: { backgroundColor: columnCssColors[task.status] || "var(--accent-blue)", boxShadow: "none" } }} /></ScrollArea></Box>
        <Box><Text size="sm" fw={500} c="dimmed" mb={6}>Assignee</Text><Select placeholder="Unassigned" data={agentSelectData} value={editAssignee || null} onChange={v => { setEditAssignee(v || ""); saveField("assignedTo", v || ""); }} clearable size="sm" styles={selectDropdownStyles} /></Box>
        <Box><Text size="sm" fw={500} c="dimmed" mb={6}>Priority</Text><SegmentedControl value={task.priority} onChange={v => saveField("priority", v)} data={[{ value: "P0", label: "P0 Critical" }, { value: "P1", label: "P1 High" }, { value: "P2", label: "P2 Medium" }, { value: "P3", label: "P3 Low" }]} size="xs" fullWidth styles={{ root: { backgroundColor: "var(--bg-tertiary)", border: "1px solid var(--border-color)" }, label: { color: "var(--text-primary)", fontWeight: 500, fontSize: 12, padding: "6px 12px" }, indicator: { backgroundColor: PRIORITY_COLORS[task.priority] === "red" ? "var(--mantine-color-red-6)" : PRIORITY_COLORS[task.priority] === "orange" ? "var(--mantine-color-orange-6)" : PRIORITY_COLORS[task.priority] === "blue" ? "var(--accent-blue)" : "var(--text-muted)", boxShadow: "none" } }} /></Box>
        <Box><Text size="sm" fw={500} c="dimmed" mb={6}>Labels</Text><TagsInput placeholder="Add label" value={editLabels} onChange={async nl => { setEditLabels(nl); setSaving(true); try { await api.updateTask(sessionId, task.id, { labels: nl }); fetchTasks(); } catch (err: any) { showError(err.message || "Failed to update labels", "Error"); } finally { setSaving(false); } }} size="sm" styles={{ input: { backgroundColor: "var(--bg-tertiary)", borderColor: "var(--border-color)", color: "var(--text-primary)" } }} /></Box>
        <Box><Text size="sm" fw={500} c="dimmed" mb={6}>Due Date</Text><DateInput placeholder="Select due date" value={editDueDate ? new Date(editDueDate) : null} onChange={handleDateChange(async (v) => { setEditDueDate(v); setSaving(true); try { await api.updateTask(sessionId, task.id, { dueDate: v || undefined }); fetchTasks(); } catch (err: any) { showError(err.message || "Failed to update due date", "Error"); } finally { setSaving(false); } })} clearable size="sm" popoverProps={{ styles: { dropdown: { backgroundColor: "var(--bg-secondary)", borderColor: "var(--border-color)" } } }} styles={{ input: { backgroundColor: "var(--bg-tertiary)", borderColor: "var(--border-color)", color: "var(--text-primary)" }, calendarHeader: { backgroundColor: "var(--bg-secondary)" }, calendarHeaderControl: { color: "var(--text-primary)" }, calendarHeaderLevel: { color: "var(--text-primary)" }, weekday: { color: "var(--text-muted)" }, day: { color: "var(--text-primary)" } }} /></Box>
      </Stack>
      <Box><Group gap={6} mb={6}><Text size="sm" fw={500} c="dimmed">Description</Text>{!editingDesc && <Tooltip label="Edit description"><ActionIcon variant="subtle" size="xs" color="gray" onClick={() => setEditingDesc(true)}><span style={{ fontSize: 11 }}>&#9998;</span></ActionIcon></Tooltip>}</Group>
        {editingDesc ? <Stack gap="xs"><Textarea value={editDesc} onChange={e => setEditDesc(e.currentTarget.value)} autoFocus autosize minRows={3} maxRows={8} onKeyDown={e => { if (e.key === "Escape") { setEditDesc(task.description || ""); setEditingDesc(false); } }} styles={{ input: { backgroundColor: "var(--bg-tertiary)", borderColor: "var(--accent-blue)", color: "var(--text-primary)", fontSize: 13 } }} /><Group gap="xs"><Button size="xs" variant="filled" color="blue" onClick={handleDescSave}>Save</Button><Button size="xs" variant="subtle" color="gray" onClick={() => { setEditDesc(task.description || ""); setEditingDesc(false); }}>Cancel</Button></Group></Stack> : task.description ? <Paper p="sm" style={{ backgroundColor: "var(--bg-tertiary)", borderRadius: 8, cursor: "pointer", fontSize: 13, lineHeight: 1.6 }} onClick={() => setEditingDesc(true)}><MarkdownText>{task.description}</MarkdownText></Paper> : <Text size="sm" c="dimmed" fs="italic" style={{ cursor: "pointer" }} onClick={() => setEditingDesc(true)}>Click to add a description...</Text>}
      </Box>
      {task.dependencies && task.dependencies.length > 0 && <Box><Text size="sm" fw={500} c="dimmed" mb={8}>Dependencies ({task.dependencies.length})</Text><Stack gap={4}>{task.dependencies.map(depId => { const dt = tasks.find(t => t.id === depId); const done = dt?.status === "done"; return <Paper key={depId} px="sm" py={8} style={{ backgroundColor: "var(--bg-tertiary)", borderRadius: 6, cursor: dt ? "pointer" : "default" }} onClick={() => { if (dt) onNavigateTask(depId); }}><Group gap={8}><Text size="sm" style={{ lineHeight: 1 }}>{done ? "\u2705" : "\u23F3"}</Text><Text size="xs" c={done ? "var(--accent-green)" : "var(--text-primary)"} td={done ? "line-through" : undefined} style={{ flex: 1 }}>{dt?.title || depId}</Text><Badge size="xs" variant="light" color={done ? "green" : columnColors[dt?.status || "pending"] || "gray"}>{done ? "Done" : dt ? (columnLabels[dt.status] || dt.status) : "Unknown"}</Badge></Group></Paper>; })}</Stack></Box>}
      {task.blocked && <Alert color="yellow" variant="light" icon={<span style={{ fontSize: 14 }}>&#128274;</span>} styles={{ message: { fontSize: 13 } }}>{task.blockedReason || "This task is blocked by incomplete dependencies"}</Alert>}
      <Divider color="var(--border-color)" />
      <Box style={{ flex: 1, minHeight: 0, display: "flex", flexDirection: "column", overflow: "hidden" }}>
        <Group gap={8} mb="sm" style={{ flexShrink: 0 }}><Text size="sm" fw={600} c="var(--text-primary)">Comments</Text>{task.comments && task.comments.length > 0 && <Badge variant="light" color="blue" size="xs" circle>{task.comments.length}</Badge>}</Group>
        <ScrollArea mb="sm" type="auto" offsetScrollbars style={{ flex: 1, minHeight: 60, overflowY: "auto" }}>
          {task.comments?.length ? <Stack gap={8}>{task.comments.map(c => <Paper key={c.id} p="sm" radius="md" style={{ backgroundColor: "var(--bg-tertiary)", border: "1px solid var(--border-color)" }}><Group justify="space-between" mb={4} wrap="nowrap"><Group gap={6} wrap="nowrap"><Box style={{ width: 22, height: 22, borderRadius: "50%", backgroundColor: "var(--accent-blue)", display: "flex", alignItems: "center", justifyContent: "center", flexShrink: 0 }}><Text size="xs" fw={700} c="white" style={{ fontSize: 10, lineHeight: 1 }}>{(c.authorName || c.author || "?").charAt(0).toUpperCase()}</Text></Box><Text size="xs" fw={600} c="var(--text-primary)">{c.authorName || c.author}</Text></Group><Text size="xs" c="dimmed" style={{ flexShrink: 0 }}>{timeAgo(c.createdAt)}</Text></Group><Box ml={28} style={{ fontSize: 13, lineHeight: 1.5 }}><MarkdownText>{c.text}</MarkdownText></Box></Paper>)}</Stack> : <Text size="xs" c="dimmed" fs="italic" ta="center" py="md">No comments yet</Text>}
        </ScrollArea>
        <Group gap={8} align="flex-end" wrap="nowrap" style={{ flexShrink: 0 }}><Textarea value={commentText} onChange={e => setCommentText(e.currentTarget.value)} placeholder="Add a comment..." autosize minRows={1} maxRows={3} style={{ flex: 1 }} onKeyDown={e => { if (e.key === "Enter" && (e.metaKey || e.ctrlKey) && commentText.trim()) onAddComment(task.id); }} styles={{ input: { backgroundColor: "var(--bg-tertiary)", borderColor: "var(--border-color)", color: "var(--text-primary)", fontSize: 13 } }} /><Tooltip label="Send (Cmd+Enter)"><ActionIcon variant="filled" color="blue" size="lg" onClick={() => onAddComment(task.id)} disabled={!commentText.trim()} style={{ flexShrink: 0 }}><span style={{ fontSize: 16, lineHeight: 1 }}>&#10148;</span></ActionIcon></Tooltip></Group>
      </Box>
    </Stack>
  </Modal>);
}
