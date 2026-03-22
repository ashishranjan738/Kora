import { useEffect, useState, useCallback } from "react";
import {
  Stack, Group, Text, Paper, Button, TextInput, Select, Switch,
  Modal, Badge, Table, CopyButton, Tooltip, ActionIcon, Collapse,
} from "@mantine/core";
import { formatLastSeen } from "../utils/formatters";
import { showSuccess, showError } from "../utils/notifications";

// ---------- Types ----------

interface Webhook {
  id: string;
  name: string;
  url: string;
  secret: string;
  playbook?: string;
  enabled: boolean;
  eventCount: number;
  lastTriggeredAt?: string;
  createdAt: string;
}

interface WebhookEvent {
  id: string;
  webhookId: string;
  timestamp: string;
  payloadPreview: string;
  sessionId?: string;
  status: "success" | "error";
}

interface WebhookManagerProps {
  /** If provided, shows webhook list for this context */
  context?: string;
}

// ---------- Helpers ----------

function maskSecret(secret: string): string {
  if (secret.length <= 8) return "****";
  return secret.slice(0, 4) + "****" + secret.slice(-4);
}

const TOKEN = () => (window as any).__KORA_TOKEN__ || "";

async function apiFetch(path: string, opts?: RequestInit) {
  const res = await fetch(`/api/v1${path}`, {
    ...opts,
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${TOKEN()}`, ...opts?.headers },
  });
  if (!res.ok) throw new Error(`API ${res.status}: ${await res.text()}`);
  if (res.status === 204) return undefined;
  return res.json();
}

// ---------- Component ----------

export function WebhookManager({ context }: WebhookManagerProps) {
  const [webhooks, setWebhooks] = useState<Webhook[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [showCreate, setShowCreate] = useState(false);
  const [expandedId, setExpandedId] = useState<string | null>(null);
  const [events, setEvents] = useState<Record<string, WebhookEvent[]>>({});

  const loadWebhooks = useCallback(async () => {
    try {
      const data = await apiFetch("/webhooks");
      setWebhooks(data?.webhooks || []);
      setError(null);
    } catch (err: any) {
      if (err.message?.includes("404")) {
        setError("Webhooks API not available yet.");
      } else {
        setError(err.message);
      }
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { loadWebhooks(); }, [loadWebhooks]);

  const loadEvents = async (webhookId: string) => {
    try {
      const data = await apiFetch(`/webhooks/${webhookId}/events?limit=5`);
      setEvents((prev) => ({ ...prev, [webhookId]: data?.events || [] }));
    } catch { /* ignore */ }
  };

  const toggleWebhook = async (id: string, enabled: boolean) => {
    try {
      await apiFetch(`/webhooks/${id}`, { method: "PUT", body: JSON.stringify({ enabled }) });
      setWebhooks((prev) => prev.map((w) => w.id === id ? { ...w, enabled } : w));
    } catch (err: any) {
      showError(err.message, "Failed to update webhook");
    }
  };

  const deleteWebhook = async (id: string) => {
    try {
      await apiFetch(`/webhooks/${id}`, { method: "DELETE" });
      setWebhooks((prev) => prev.filter((w) => w.id !== id));
      showSuccess("Webhook deleted");
    } catch (err: any) {
      showError(err.message, "Failed to delete");
    }
  };

  if (loading) {
    return <Text size="sm" c="dimmed" ta="center" py="xl">Loading webhooks...</Text>;
  }

  if (error) {
    return (
      <Paper p="md" withBorder>
        <Text size="sm" c="dimmed" ta="center">{error}</Text>
      </Paper>
    );
  }

  return (
    <Stack gap="md">
      <Group justify="space-between">
        <Group gap="xs">
          <Text size="lg" fw={700}>Webhooks</Text>
          <Badge variant="light" color="blue" size="sm">{webhooks.length}</Badge>
        </Group>
        <Button size="xs" onClick={() => setShowCreate(true)}>+ Create Webhook</Button>
      </Group>

      {webhooks.length === 0 ? (
        <Paper p="xl" withBorder style={{ textAlign: "center" }}>
          <Text size="sm" c="dimmed">No webhooks configured. Create one to trigger sessions from external events.</Text>
        </Paper>
      ) : (
        <Stack gap="xs">
          {webhooks.map((wh) => (
            <Paper key={wh.id} p="sm" withBorder style={{ borderColor: wh.enabled ? "var(--border-color)" : "var(--text-muted)", opacity: wh.enabled ? 1 : 0.6 }}>
              <Group justify="space-between" wrap="nowrap">
                <div style={{ flex: 1, minWidth: 0 }}>
                  <Group gap="xs" mb={4}>
                    <Text size="sm" fw={600}>{wh.name}</Text>
                    <Switch size="xs" checked={wh.enabled} onChange={(e) => toggleWebhook(wh.id, e.currentTarget.checked)} />
                    {wh.playbook && <Badge size="xs" variant="light" color="grape">{wh.playbook}</Badge>}
                  </Group>
                  <Group gap="xs">
                    <Text size="xs" c="dimmed" style={{ fontFamily: "monospace" }}>{wh.url}</Text>
                    <CopyButton value={wh.url}>
                      {({ copied, copy }) => (
                        <Tooltip label={copied ? "Copied!" : "Copy URL"}>
                          <ActionIcon size="xs" variant="subtle" onClick={copy}>
                            <Text size="xs">{copied ? "\u2713" : "\u{1F4CB}"}</Text>
                          </ActionIcon>
                        </Tooltip>
                      )}
                    </CopyButton>
                  </Group>
                  <Group gap="sm" mt={4}>
                    <Text size="xs" c="dimmed">Secret: {maskSecret(wh.secret)}</Text>
                    <CopyButton value={wh.secret}>
                      {({ copied, copy }) => (
                        <Tooltip label={copied ? "Copied!" : "Copy secret"}>
                          <ActionIcon size="xs" variant="subtle" onClick={copy}>
                            <Text size="xs">{copied ? "\u2713" : "\u{1F511}"}</Text>
                          </ActionIcon>
                        </Tooltip>
                      )}
                    </CopyButton>
                    <Text size="xs" c="dimmed">{wh.eventCount} events</Text>
                    {wh.lastTriggeredAt && <Text size="xs" c="dimmed">Last: {formatLastSeen(wh.lastTriggeredAt)}</Text>}
                  </Group>
                </div>
                <Group gap={4}>
                  <Button size="compact-xs" variant="light" onClick={() => {
                    setExpandedId(expandedId === wh.id ? null : wh.id);
                    if (expandedId !== wh.id) loadEvents(wh.id);
                  }}>
                    History
                  </Button>
                  <Button size="compact-xs" variant="light" color="red" onClick={() => deleteWebhook(wh.id)}>
                    Delete
                  </Button>
                </Group>
              </Group>

              {/* Event history */}
              <Collapse in={expandedId === wh.id}>
                <div style={{ marginTop: 8 }}>
                  {(events[wh.id] || []).length === 0 ? (
                    <Text size="xs" c="dimmed" py="xs">No events yet.</Text>
                  ) : (
                    <Table fz="xs" striped>
                      <Table.Thead>
                        <Table.Tr>
                          <Table.Th>Time</Table.Th>
                          <Table.Th>Status</Table.Th>
                          <Table.Th>Payload</Table.Th>
                          <Table.Th>Session</Table.Th>
                        </Table.Tr>
                      </Table.Thead>
                      <Table.Tbody>
                        {(events[wh.id] || []).map((ev) => (
                          <Table.Tr key={ev.id}>
                            <Table.Td>{formatLastSeen(ev.timestamp)}</Table.Td>
                            <Table.Td>
                              <Badge size="xs" color={ev.status === "success" ? "green" : "red"} variant="light">
                                {ev.status}
                              </Badge>
                            </Table.Td>
                            <Table.Td><Text size="xs" lineClamp={1}>{ev.payloadPreview}</Text></Table.Td>
                            <Table.Td>{ev.sessionId || "—"}</Table.Td>
                          </Table.Tr>
                        ))}
                      </Table.Tbody>
                    </Table>
                  )}
                </div>
              </Collapse>
            </Paper>
          ))}
        </Stack>
      )}

      {/* Create Dialog */}
      <CreateWebhookModal
        opened={showCreate}
        onClose={() => setShowCreate(false)}
        onCreated={() => { setShowCreate(false); loadWebhooks(); }}
      />
    </Stack>
  );
}

// ---------- Create Modal ----------

function CreateWebhookModal({ opened, onClose, onCreated }: { opened: boolean; onClose: () => void; onCreated: () => void }) {
  const [name, setName] = useState("");
  const [playbook, setPlaybook] = useState("");
  const [creating, setCreating] = useState(false);

  const handleCreate = async () => {
    if (!name.trim()) return;
    setCreating(true);
    try {
      await apiFetch("/webhooks", {
        method: "POST",
        body: JSON.stringify({ name: name.trim(), playbook: playbook.trim() || undefined }),
      });
      showSuccess("Webhook created");
      setName("");
      setPlaybook("");
      onCreated();
    } catch (err: any) {
      showError(err.message, "Failed to create webhook");
    } finally {
      setCreating(false);
    }
  };

  return (
    <Modal opened={opened} onClose={onClose} title="Create Webhook" size="sm">
      <Stack gap="sm">
        <TextInput
          label="Name"
          placeholder="e.g. GitHub PR webhook"
          value={name}
          onChange={(e) => setName(e.currentTarget.value)}
          autoFocus
        />
        <TextInput
          label="Playbook (optional)"
          placeholder="e.g. master-workers"
          value={playbook}
          onChange={(e) => setPlaybook(e.currentTarget.value)}
        />
        <Text size="xs" c="dimmed">A unique URL and secret will be generated automatically.</Text>
        <Group justify="flex-end" mt="sm">
          <Button variant="default" size="xs" onClick={onClose}>Cancel</Button>
          <Button size="xs" onClick={handleCreate} loading={creating} disabled={!name.trim()}>
            Create
          </Button>
        </Group>
      </Stack>
    </Modal>
  );
}
