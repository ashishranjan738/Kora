import { useEffect, useState, useCallback, useMemo } from "react";
import { Badge, Button, Group, Paper, Text, TextInput, Tooltip, Modal, Stack } from "@mantine/core";
import { useApi } from "../hooks/useApi";

interface KnowledgeEntry {
  text: string;
  source: string;
  timestamp?: string;
}

interface KnowledgeViewerProps {
  sessionId: string;
}

export function KnowledgeViewer({ sessionId }: KnowledgeViewerProps) {
  const api = useApi();
  const [entries, setEntries] = useState<KnowledgeEntry[]>([]);
  const [loading, setLoading] = useState(true);
  const [search, setSearch] = useState("");
  const [showClearConfirm, setShowClearConfirm] = useState(false);
  const [clearing, setClearing] = useState(false);

  const fetchKnowledge = useCallback(async () => {
    try {
      const data = await api.getKnowledge(sessionId);
      setEntries(data.entries || []);
    } catch {
      // ignore
    } finally {
      setLoading(false);
    }
  }, [sessionId]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    fetchKnowledge();
    const interval = setInterval(fetchKnowledge, 10000);
    return () => clearInterval(interval);
  }, [fetchKnowledge]);

  const filteredEntries = useMemo(() => {
    if (!search.trim()) return entries;
    const q = search.toLowerCase();
    return entries.filter(
      (e) => e.text.toLowerCase().includes(q) || e.source.toLowerCase().includes(q)
    );
  }, [entries, search]);

  async function handleClear() {
    setClearing(true);
    try {
      await api.clearKnowledge(sessionId);
      setEntries([]);
      setShowClearConfirm(false);
    } catch {
      // ignore
    } finally {
      setClearing(false);
    }
  }

  // Group by source
  const sourceColors: Record<string, string> = {
    ".kora.yml": "blue",
    "knowledge.md": "grape",
  };

  function getSourceColor(source: string): string {
    return sourceColors[source] || "gray";
  }

  return (
    <div style={{ marginTop: 32 }}>
      <Group justify="space-between" mb={16}>
        <Group gap={8}>
          <Text size="lg" fw={700} c="var(--text-primary)">
            Knowledge Base
          </Text>
          <Badge variant="light" color="blue" size="sm">
            {filteredEntries.length} entr{filteredEntries.length !== 1 ? "ies" : "y"}
          </Badge>
        </Group>
        <Group gap={8}>
          <TextInput
            size="xs"
            placeholder="Search knowledge..."
            value={search}
            onChange={(e) => setSearch(e.currentTarget.value)}
            styles={{
              input: {
                backgroundColor: "var(--bg-primary)",
                borderColor: "var(--border-color)",
                color: "var(--text-primary)",
                minWidth: 180,
              },
            }}
          />
          {entries.length > 0 && (
            <Button
              size="xs"
              variant="light"
              color="red"
              onClick={() => setShowClearConfirm(true)}
            >
              Clear all
            </Button>
          )}
        </Group>
      </Group>

      {loading && (
        <Text size="sm" c="dimmed" ta="center" py={24}>
          Loading knowledge entries...
        </Text>
      )}

      {!loading && entries.length === 0 && (
        <Paper
          p="xl"
          withBorder
          style={{
            backgroundColor: "var(--bg-secondary)",
            borderColor: "var(--border-color)",
            textAlign: "center",
          }}
        >
          <Text size="sm" c="dimmed">
            No knowledge entries yet. Agents can save knowledge using the save_knowledge MCP tool.
          </Text>
        </Paper>
      )}

      {!loading && filteredEntries.length === 0 && entries.length > 0 && (
        <Text size="sm" c="dimmed" ta="center" py={16}>
          No entries matching &ldquo;{search}&rdquo;
        </Text>
      )}

      {filteredEntries.length > 0 && (
        <Stack gap={8}>
          {filteredEntries.map((entry, i) => (
            <Paper
              key={i}
              p="sm"
              withBorder
              style={{
                backgroundColor: "var(--bg-secondary)",
                borderColor: "var(--border-color)",
              }}
            >
              <Group gap={8} mb={4}>
                <Badge variant="light" color={getSourceColor(entry.source)} size="xs">
                  {entry.source}
                </Badge>
                {entry.timestamp && (
                  <Tooltip label={entry.timestamp} withArrow>
                    <Text size="xs" c="dimmed">
                      {new Date(entry.timestamp).toLocaleString()}
                    </Text>
                  </Tooltip>
                )}
              </Group>
              <Text size="sm" c="var(--text-primary)" style={{ lineHeight: 1.5 }}>
                {entry.text}
              </Text>
            </Paper>
          ))}
        </Stack>
      )}

      {/* Clear confirmation modal */}
      <Modal
        opened={showClearConfirm}
        onClose={() => setShowClearConfirm(false)}
        title="Clear Knowledge Base"
        size="sm"
        styles={{
          header: { backgroundColor: "var(--bg-secondary)" },
          body: { backgroundColor: "var(--bg-secondary)" },
        }}
      >
        <Text size="sm" c="var(--text-secondary)" mb={16}>
          This will clear all entries from knowledge.md. Entries from .kora.yml will remain
          (edit the file directly to remove those).
        </Text>
        <Group justify="flex-end" gap={8}>
          <Button variant="default" size="sm" onClick={() => setShowClearConfirm(false)}>
            Cancel
          </Button>
          <Button color="red" size="sm" onClick={handleClear} loading={clearing}>
            Clear Knowledge
          </Button>
        </Group>
      </Modal>
    </div>
  );
}
