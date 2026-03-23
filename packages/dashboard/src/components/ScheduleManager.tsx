import { useState, useEffect, useCallback } from "react";
import { useApi } from "../hooks/useApi";
import { Modal, Button, TextInput, Stack, Group, Text, Badge, Paper, ActionIcon, Switch, Tooltip, Box } from "@mantine/core";
import { DirectoryBrowser } from "./DirectoryBrowser";

interface Schedule {
  id: string;
  name: string;
  cronExpression: string;
  timezone?: string;
  enabled: boolean;
  nextRunAt?: string;
  lastRunAt?: string;
  runCount: number;
  playbookId?: string;
}

/** Simple cron description (avoids adding cronstrue dependency) */
function describeCron(expr: string): string {
  const parts = expr.trim().split(/\s+/);
  if (parts.length < 5) return expr;
  const [min, hour, dom, mon, dow] = parts;
  if (min === "0" && hour === "*") return "Every hour";
  if (min === "*/5") return "Every 5 minutes";
  if (min === "*/10") return "Every 10 minutes";
  if (min === "*/15") return "Every 15 minutes";
  if (min === "*/30") return "Every 30 minutes";
  if (min === "0" && hour !== "*" && dom === "*" && mon === "*" && dow === "*") return `Daily at ${hour}:00`;
  if (dow !== "*" && dom === "*") return `Weekdays at ${hour}:${min.padStart(2, "0")}`;
  return expr;
}

function timeAgo(dateStr: string): string {
  const s = Math.floor((Date.now() - new Date(dateStr).getTime()) / 1000);
  if (s < 60) return `${s}s ago`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ago`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h ago`;
  return `${Math.floor(h / 24)}d ago`;
}

function timeUntil(dateStr: string): string {
  const s = Math.floor((new Date(dateStr).getTime() - Date.now()) / 1000);
  if (s < 0) return "overdue";
  if (s < 60) return `in ${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `in ${m}m`;
  const h = Math.floor(m / 60);
  return `in ${h}h ${m % 60}m`;
}

export function ScheduleManager() {
  const api = useApi();
  const [schedules, setSchedules] = useState<Schedule[]>([]);
  const [loading, setLoading] = useState(true);
  const [showCreate, setShowCreate] = useState(false);
  const [name, setName] = useState("");
  const [cronExpr, setCronExpr] = useState("0 */6 * * *");
  const [projectPath, setProjectPath] = useState("");
  const [browserOpen, setBrowserOpen] = useState(false);
  const [creating, setCreating] = useState(false);

  const fetchSchedules = useCallback(async () => {
    try {
      const data = await api.getSchedules();
      setSchedules(data.schedules || []);
    } catch {} finally { setLoading(false); }
  }, []);

  useEffect(() => { fetchSchedules(); const i = setInterval(fetchSchedules, 30000); return () => clearInterval(i); }, [fetchSchedules]);

  const handleCreate = async () => {
    if (!name.trim() || !cronExpr.trim() || !projectPath.trim()) return;
    setCreating(true);
    try {
      await api.createSchedule({ name: name.trim(), cronExpression: cronExpr.trim(), sessionConfig: { name: name.trim(), projectPath: projectPath.trim() } });
      setName(""); setCronExpr("0 */6 * * *"); setProjectPath(""); setShowCreate(false); fetchSchedules();
    } catch {} finally { setCreating(false); }
  };

  const handleToggle = async (id: string, enabled: boolean) => {
    try { await api.updateSchedule(id, { enabled }); fetchSchedules(); } catch {}
  };

  const handleDelete = async (id: string) => {
    try { await api.deleteSchedule(id); fetchSchedules(); } catch {}
  };

  const handleTrigger = async (id: string) => {
    try { await api.triggerSchedule(id); fetchSchedules(); } catch {}
  };

  const inputStyles = { input: { backgroundColor: "var(--bg-tertiary)", borderColor: "var(--border-color)", color: "var(--text-primary)" }, label: { color: "var(--text-secondary)", fontSize: 13 } };
  const modalStyles = { header: { backgroundColor: "var(--bg-secondary)", borderBottom: "1px solid var(--border-color)" }, body: { backgroundColor: "var(--bg-secondary)" }, content: { backgroundColor: "var(--bg-secondary)" }, title: { color: "var(--text-primary)", fontWeight: 600 as const, fontSize: 18 }, close: { color: "var(--text-secondary)" } };

  return (
    <Box>
      <Group justify="space-between" mb="md">
        <Text fw={600} size="lg" c="var(--text-primary)">Scheduled Sessions</Text>
        <Button size="xs" variant="light" color="blue" onClick={() => setShowCreate(true)}>+ New Schedule</Button>
      </Group>

      {loading ? (
        <Text size="sm" c="dimmed">Loading schedules...</Text>
      ) : schedules.length === 0 ? (
        <Paper p="lg" withBorder style={{ backgroundColor: "var(--bg-secondary)", borderColor: "var(--border-color)", textAlign: "center" }}>
          <Text c="var(--text-muted)" mb="sm">No scheduled sessions</Text>
          <Text size="xs" c="dimmed" mb="md">Create a schedule to automatically launch sessions on a recurring basis.</Text>
          <Button size="sm" variant="light" color="blue" onClick={() => setShowCreate(true)}>Create Schedule</Button>
        </Paper>
      ) : (
        <Stack gap="xs">
          {schedules.map((s) => (
            <Paper key={s.id} p="sm" withBorder style={{ backgroundColor: "var(--bg-secondary)", borderColor: "var(--border-color)" }}>
              <Group justify="space-between" wrap="nowrap">
                <Box style={{ flex: 1, minWidth: 0 }}>
                  <Group gap={8} mb={4}>
                    <Text fw={600} size="sm" c="var(--text-primary)">{s.name}</Text>
                    <Badge size="xs" variant="light" color={s.enabled ? "green" : "gray"}>{s.enabled ? "Active" : "Paused"}</Badge>
                    {s.runCount > 0 && <Badge size="xs" variant="light" color="blue">{s.runCount} runs</Badge>}
                  </Group>
                  <Group gap={12}>
                    <Text size="xs" c="dimmed" ff="monospace">{s.cronExpression}</Text>
                    <Text size="xs" c="var(--text-secondary)">{describeCron(s.cronExpression)}</Text>
                  </Group>
                  <Group gap={12} mt={4}>
                    {s.nextRunAt && <Text size="xs" c="dimmed">Next: {timeUntil(s.nextRunAt)}</Text>}
                    {s.lastRunAt && <Text size="xs" c="dimmed">Last: {timeAgo(s.lastRunAt)}</Text>}
                  </Group>
                </Box>
                <Group gap={6} style={{ flexShrink: 0 }}>
                  <Switch checked={s.enabled} onChange={(e) => handleToggle(s.id, e.currentTarget.checked)} size="sm" />
                  <Tooltip label="Run now"><Button size="xs" variant="light" color="blue" onClick={() => handleTrigger(s.id)}>Run</Button></Tooltip>
                  <ActionIcon variant="subtle" color="red" size="sm" onClick={() => handleDelete(s.id)}><span style={{ fontSize: 16 }}>&times;</span></ActionIcon>
                </Group>
              </Group>
            </Paper>
          ))}
        </Stack>
      )}

      <Modal opened={showCreate} onClose={() => setShowCreate(false)} title="New Schedule" centered styles={modalStyles}>
        <Stack gap="sm">
          <TextInput label="Schedule Name" value={name} onChange={(e) => setName(e.currentTarget.value)} placeholder="Nightly build" autoFocus styles={inputStyles} />
          <div>
            <Text size="sm" fw={500} c="var(--text-secondary)" mb={6}>Project Path</Text>
            <Group gap={8}>
              <TextInput
                value={projectPath}
                onChange={(e) => setProjectPath(e.currentTarget.value)}
                placeholder="/path/to/project"
                styles={{ ...inputStyles, root: { flex: 1 } }}
              />
              <Button
                variant="light"
                color="blue"
                size="sm"
                onClick={() => setBrowserOpen(true)}
                style={{ flexShrink: 0 }}
              >
                Browse
              </Button>
            </Group>
          </div>
          <TextInput label="Cron Expression" value={cronExpr} onChange={(e) => setCronExpr(e.currentTarget.value)} placeholder="0 */6 * * *" styles={inputStyles} description={describeCron(cronExpr)} />
          <Text size="xs" c="dimmed">Common: "0 * * * *" (hourly), "0 */6 * * *" (every 6h), "0 9 * * 1-5" (weekdays 9am)</Text>
          <Group justify="flex-end" mt="md">
            <Button variant="default" onClick={() => setShowCreate(false)} styles={{ root: { backgroundColor: "var(--bg-tertiary)", borderColor: "var(--border-color)", color: "var(--text-primary)" } }}>Cancel</Button>
            <Button onClick={handleCreate} loading={creating} disabled={!name.trim() || !cronExpr.trim() || !projectPath.trim()} styles={{ root: { backgroundColor: "var(--accent-blue)", borderColor: "var(--accent-blue)" } }}>Create</Button>
          </Group>
        </Stack>
      </Modal>

      <DirectoryBrowser
        opened={browserOpen}
        onClose={() => setBrowserOpen(false)}
        onSelect={(path) => setProjectPath(path)}
        initialPath={projectPath}
      />
    </Box>
  );
}
