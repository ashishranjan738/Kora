import { useEffect, useState, useCallback, useMemo } from "react";
import { Badge, Button, Group, Paper, Text, TextInput, Textarea, Tooltip, Modal, Stack, Collapse } from "@mantine/core";
import { useApi } from "../hooks/useApi";
import { formatLastSeen } from "../utils/formatters";
import { showError } from "../utils/notifications";

interface KnowledgeEntry {
  text: string;
  source: string;
  timestamp?: string;
  savedBy?: string; // agent name/ID that saved this entry
}

interface KnowledgeViewerProps {
  sessionId: string;
}

export function KnowledgeViewer({ sessionId }: KnowledgeViewerProps) {
  const api = useApi();
  const [entries, setEntries] = useState<KnowledgeEntry[]>([]);
  const [loading, setLoading] = useState(true);
  const [search, setSearch] = useState("");
  const [expandedIndex, setExpandedIndex] = useState<number | null>(null);
  const [showClearConfirm, setShowClearConfirm] = useState(false);
  const [clearing, setClearing] = useState(false);
  const [showAddModal, setShowAddModal] = useState(false);
  const [newEntryText, setNewEntryText] = useState("");
  const [adding, setAdding] = useState(false);

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
      (e) => e.text.toLowerCase().includes(q) || e.source.toLowerCase().includes(q) || (e.savedBy || "").toLowerCase().includes(q)
    );
  }, [entries, search]);

  async function handleClear() {
    setClearing(true);
    try {
      await api.clearKnowledge(sessionId);
      setEntries([]);
      setShowClearConfirm(false);
    } catch (err: any) {
      showError(err.message || "Failed to clear knowledge base", "Clear Failed");
    } finally {
      setClearing(false);
    }
  }

  async function handleAddEntry() {
    if (!newEntryText.trim()) return;
    setAdding(true);
    try {
      await api.addKnowledge(sessionId, newEntryText.trim());
      setNewEntryText("");
      setShowAddModal(false);
      fetchKnowledge();
    } catch (err: any) {
      showError(err.message || "Failed to add knowledge entry", "Add Entry Failed");
    } finally {
      setAdding(false);
    }
  }

  // Source colors
  function getSourceColor(source: string): string {
    if (source === ".kora.yml") return "blue";
    if (source === "knowledge.md") return "grape";
    if (source === "dashboard") return "teal";
    // Agent sources
    if (source.includes("agent") || source.includes("mcp")) return "orange";
    return "gray";
  }

  const PREVIEW_LENGTH = 200;

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
          <Button
            size="xs"
            variant="light"
            color="blue"
            onClick={() => setShowAddModal(true)}
          >
            + Add Entry
          </Button>
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
            No knowledge entries yet. Agents can save knowledge using the save_knowledge MCP tool,
            or add entries manually with the "+ Add Entry" button.
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
          {filteredEntries.map((entry, i) => {
            const isLong = entry.text.length > PREVIEW_LENGTH;
            const isExpanded = expandedIndex === i;
            const displayText = isLong && !isExpanded
              ? entry.text.slice(0, PREVIEW_LENGTH) + "..."
              : entry.text;
            // Author from savedBy or source (API stores agent name in source for knowledge.md entries)
            const rawAuthor = entry.savedBy || (entry.source !== ".kora.yml" && entry.source !== "knowledge.md" ? entry.source : null);
            const authorLabel = rawAuthor
              ? (rawAuthor.toLowerCase() === "unknown" || rawAuthor.toLowerCase() === "dashboard" ? "User" : rawAuthor)
              : null;

            return (
              <Paper
                key={i}
                p="sm"
                withBorder
                style={{
                  backgroundColor: isExpanded ? "var(--bg-tertiary)" : "var(--bg-secondary)",
                  borderColor: isExpanded ? "var(--accent-blue)" : "var(--border-color)",
                  cursor: "pointer",
                  transition: "border-color 0.2s, background-color 0.2s",
                }}
                onClick={() => setExpandedIndex(isExpanded ? null : i)}
              >
                <Group gap={8} mb={4} wrap="wrap">
                  <Badge variant="light" color={getSourceColor(entry.source)} size="xs">
                    {entry.source}
                  </Badge>
                  {authorLabel && (
                    <Badge variant="dot" color="orange" size="xs">
                      {authorLabel}
                    </Badge>
                  )}
                  {entry.timestamp && (
                    <Tooltip label={new Date(entry.timestamp).toLocaleString()} withArrow>
                      <Text size="xs" c="dimmed">
                        {formatLastSeen(entry.timestamp)}
                      </Text>
                    </Tooltip>
                  )}
                  <Text size="xs" c="blue" style={{ marginLeft: "auto" }}>
                    {isExpanded ? "\u25BC collapse" : "\u25B6 expand"}
                  </Text>
                </Group>
                {/* Collapsed: truncated preview */}
                {!isExpanded && (
                  <Text
                    size="sm"
                    c="var(--text-primary)"
                    lineClamp={3}
                    style={{ lineHeight: 1.5, whiteSpace: "pre-wrap", wordBreak: "break-word" }}
                  >
                    {entry.text}
                  </Text>
                )}
                {/* Expanded: full content with Collapse animation */}
                <Collapse in={isExpanded}>
                  <Text
                    size="sm"
                    c="var(--text-primary)"
                    style={{ lineHeight: 1.5, whiteSpace: "pre-wrap", wordBreak: "break-word" }}
                  >
                    {entry.text}
                  </Text>
                </Collapse>
              </Paper>
            );
          })}
        </Stack>
      )}

      {/* Add Entry Modal */}
      <Modal
        opened={showAddModal}
        onClose={() => setShowAddModal(false)}
        title="Add Knowledge Entry"
        size="md"
        styles={{
          header: { backgroundColor: "var(--bg-secondary)" },
          body: { backgroundColor: "var(--bg-secondary)" },
        }}
      >
        <Stack gap="sm">
          <Text size="xs" c="dimmed">
            Add a knowledge entry that all agents can access. Use this for project context,
            conventions, or important decisions.
          </Text>
          <Textarea
            placeholder="Enter knowledge text..."
            value={newEntryText}
            onChange={(e) => setNewEntryText(e.currentTarget.value)}
            rows={4}
            autosize
            minRows={3}
            maxRows={10}
            styles={{
              input: {
                backgroundColor: "var(--bg-primary)",
                borderColor: "var(--border-color)",
                color: "var(--text-primary)",
              },
            }}
          />
          <Group justify="flex-end" gap={8}>
            <Button variant="default" size="sm" onClick={() => setShowAddModal(false)}>
              Cancel
            </Button>
            <Button
              size="sm"
              onClick={handleAddEntry}
              loading={adding}
              disabled={!newEntryText.trim()}
            >
              Add Entry
            </Button>
          </Group>
        </Stack>
      </Modal>

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
