import { useEffect, useState, useCallback, useMemo } from "react";
import { Badge, Button, Group, Paper, Text, TextInput, Textarea, Tooltip, Modal, Stack, Collapse, SegmentedControl, ActionIcon } from "@mantine/core";
import { useApi } from "../hooks/useApi";
import { formatLastSeen } from "../utils/formatters";
import { showError, showSuccess } from "../utils/notifications";

interface KnowledgeEntry {
  text: string;
  source: string;
  timestamp?: string;
  savedBy?: string; // agent name/ID that saved this entry
}

interface GlobalKnowledgeEntry {
  id: string;
  text: string;
  source: string;
  timestamp?: string;
  sourceSessionId?: string;
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
  const [editIndex, setEditIndex] = useState<number | null>(null);
  const [editText, setEditText] = useState("");
  const [saving, setSaving] = useState(false);
  const [deleteIndex, setDeleteIndex] = useState<number | null>(null);
  const [deleting, setDeleting] = useState(false);
  const [viewMode, setViewMode] = useState<"session" | "global">("session");
  const [globalEntries, setGlobalEntries] = useState<GlobalKnowledgeEntry[]>([]);
  const [loadingGlobal, setLoadingGlobal] = useState(false);
  const [globalSearch, setGlobalSearch] = useState("");
  const [promotingIndex, setPromotingIndex] = useState<number | null>(null);
  const [deletingGlobalId, setDeletingGlobalId] = useState<string | null>(null);

  const fetchGlobalKnowledge = useCallback(async () => {
    setLoadingGlobal(true);
    try {
      const data = await api.getGlobalKnowledge();
      setGlobalEntries(data.entries || []);
    } catch {
      // Endpoint may not exist yet
    } finally {
      setLoadingGlobal(false);
    }
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  async function handlePromoteToGlobal(index: number) {
    setPromotingIndex(index);
    try {
      await api.promoteToGlobal(sessionId, index);
      showSuccess("Entry promoted to global knowledge");
      fetchGlobalKnowledge();
    } catch (err: any) {
      showError(err.message || "Failed to promote entry", "Promote Failed");
    } finally {
      setPromotingIndex(null);
    }
  }

  async function handleDeleteGlobal(entryId: string) {
    setDeletingGlobalId(entryId);
    try {
      await api.deleteGlobalKnowledge(entryId);
      setGlobalEntries(prev => prev.filter(e => e.id !== entryId));
    } catch (err: any) {
      showError(err.message || "Failed to delete global entry", "Delete Failed");
    } finally {
      setDeletingGlobalId(null);
    }
  }

  const filteredGlobalEntries = useMemo(() => {
    if (!globalSearch.trim()) return globalEntries;
    const q = globalSearch.toLowerCase();
    return globalEntries.filter(e => e.text.toLowerCase().includes(q) || e.source.toLowerCase().includes(q));
  }, [globalEntries, globalSearch]);

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
    fetchGlobalKnowledge();
    const interval = setInterval(fetchKnowledge, 10000);
    return () => clearInterval(interval);
  }, [fetchKnowledge, fetchGlobalKnowledge]);

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

  function isEditable(entry: KnowledgeEntry): boolean {
    // Only knowledge-db entries are editable — .kora.yml config is read-only
    return entry.source !== ".kora.yml";
  }

  function openEditModal(index: number, entry: KnowledgeEntry) {
    setEditIndex(index);
    setEditText(entry.text);
  }

  async function handleSaveEdit() {
    if (editIndex === null || !editText.trim()) return;
    setSaving(true);
    try {
      await api.updateKnowledgeEntry(sessionId, editIndex, editText.trim());
      setEditIndex(null);
      setEditText("");
      fetchKnowledge();
    } catch (err: any) {
      showError(err.message || "Failed to update knowledge entry", "Update Failed");
    } finally {
      setSaving(false);
    }
  }

  async function handleDelete() {
    if (deleteIndex === null) return;
    setDeleting(true);
    try {
      await api.deleteKnowledgeEntry(sessionId, deleteIndex);
      setDeleteIndex(null);
      fetchKnowledge();
    } catch (err: any) {
      showError(err.message || "Failed to delete knowledge entry", "Delete Failed");
    } finally {
      setDeleting(false);
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
          <SegmentedControl
            value={viewMode}
            onChange={(v) => { setViewMode(v as "session" | "global"); if (v === "global") fetchGlobalKnowledge(); }}
            data={[
              { value: "session", label: `Session (${entries.length})` },
              { value: "global", label: `Global (${globalEntries.length})` },
            ]}
            size="xs"
            styles={{
              root: { backgroundColor: "var(--bg-tertiary)", border: "1px solid var(--border-color)" },
              label: { color: "var(--text-primary)", fontWeight: 500, fontSize: 11, padding: "4px 10px" },
            }}
          />
        </Group>
        <Group gap={8}>
          <TextInput
            size="xs"
            placeholder={viewMode === "session" ? "Search session knowledge..." : "Search global knowledge..."}
            value={viewMode === "session" ? search : globalSearch}
            onChange={(e) => viewMode === "session" ? setSearch(e.currentTarget.value) : setGlobalSearch(e.currentTarget.value)}
            styles={{
              input: {
                backgroundColor: "var(--bg-primary)",
                borderColor: "var(--border-color)",
                color: "var(--text-primary)",
                minWidth: 180,
              },
            }}
          />
          {viewMode === "session" && (
            <>
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
            </>
          )}
        </Group>
      </Group>

      {viewMode === "session" && loading && (
        <Text size="sm" c="dimmed" ta="center" py={24}>
          Loading knowledge entries...
        </Text>
      )}

      {viewMode === "session" && !loading && entries.length === 0 && (
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

      {viewMode === "session" && !loading && filteredEntries.length === 0 && entries.length > 0 && (
        <Text size="sm" c="dimmed" ta="center" py={16}>
          No entries matching &ldquo;{search}&rdquo;
        </Text>
      )}

      {viewMode === "session" && filteredEntries.length > 0 && (
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
                  {authorLabel ? (
                    <Badge variant="light" color={getSourceColor(entry.source)} size="xs">
                      {authorLabel}
                    </Badge>
                  ) : (
                    <Badge variant="light" color={getSourceColor(entry.source)} size="xs">
                      {entry.source}
                    </Badge>
                  )}
                  {entry.timestamp && (
                    <Tooltip label={new Date(entry.timestamp).toLocaleString()} withArrow>
                      <Text size="xs" c="dimmed">
                        {formatLastSeen(entry.timestamp)}
                      </Text>
                    </Tooltip>
                  )}
                  <Group gap={4} style={{ marginLeft: "auto" }}>
                    {isEditable(entry) && (
                      <>
                        <Text
                          size="xs"
                          c="grape"
                          fw={500}
                          style={{ cursor: "pointer" }}
                          onClick={(e: React.MouseEvent) => { e.stopPropagation(); handlePromoteToGlobal(i); }}
                        >
                          {promotingIndex === i ? "Promoting..." : "Promote to Global"}
                        </Text>
                        <Text size="xs" c="dimmed">|</Text>
                        <Text
                          size="xs"
                          c="teal"
                          style={{ cursor: "pointer" }}
                          onClick={(e: React.MouseEvent) => { e.stopPropagation(); openEditModal(i, entry); }}
                        >
                          Edit
                        </Text>
                        <Text size="xs" c="dimmed">|</Text>
                        <Text
                          size="xs"
                          c="red"
                          style={{ cursor: "pointer" }}
                          onClick={(e: React.MouseEvent) => { e.stopPropagation(); setDeleteIndex(i); }}
                        >
                          Delete
                        </Text>
                        <Text size="xs" c="dimmed">|</Text>
                      </>
                    )}
                    <Text size="xs" c="blue">
                      {isExpanded ? "\u25BC collapse" : "\u25B6 expand"}
                    </Text>
                  </Group>
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

      {/* Global Knowledge View */}
      {viewMode === "global" && (
        <>
          {loadingGlobal && (
            <Text size="sm" c="dimmed" ta="center" py={24}>Loading global knowledge...</Text>
          )}
          {!loadingGlobal && globalEntries.length === 0 && (
            <Paper p="xl" withBorder style={{ backgroundColor: "var(--bg-secondary)", borderColor: "var(--border-color)", textAlign: "center" }}>
              <Text size="sm" c="dimmed">
                No global knowledge entries yet. Promote session entries using the &ldquo;Promote to Global&rdquo; button.
              </Text>
            </Paper>
          )}
          {!loadingGlobal && filteredGlobalEntries.length === 0 && globalEntries.length > 0 && (
            <Text size="sm" c="dimmed" ta="center" py={16}>No entries matching &ldquo;{globalSearch}&rdquo;</Text>
          )}
          {filteredGlobalEntries.length > 0 && (
            <Stack gap={8}>
              {filteredGlobalEntries.map((entry) => (
                <Paper key={entry.id} p="sm" withBorder style={{ backgroundColor: "var(--bg-secondary)", borderColor: "var(--border-color)" }}>
                  <Group gap={8} mb={4} wrap="wrap">
                    <Badge variant="filled" color="grape" size="xs">Global</Badge>
                    <Badge variant="light" color={getSourceColor(entry.source)} size="xs">{entry.source}</Badge>
                    {entry.sourceSessionId && (
                      <Text size="xs" c="dimmed">from session {entry.sourceSessionId.slice(0, 8)}</Text>
                    )}
                    {entry.timestamp && (
                      <Tooltip label={new Date(entry.timestamp).toLocaleString()} withArrow>
                        <Text size="xs" c="dimmed">{formatLastSeen(entry.timestamp)}</Text>
                      </Tooltip>
                    )}
                    <Group gap={4} style={{ marginLeft: "auto" }}>
                      <Text size="xs" c="red" style={{ cursor: "pointer" }}
                        onClick={() => handleDeleteGlobal(entry.id)}>
                        {deletingGlobalId === entry.id ? "Deleting..." : "Delete"}
                      </Text>
                    </Group>
                  </Group>
                  <Text size="sm" c="var(--text-primary)" style={{ lineHeight: 1.5, whiteSpace: "pre-wrap", wordBreak: "break-word" }} lineClamp={5}>
                    {entry.text}
                  </Text>
                </Paper>
              ))}
            </Stack>
          )}
        </>
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

      {/* Edit Entry Modal */}
      <Modal
        opened={editIndex !== null}
        onClose={() => { setEditIndex(null); setEditText(""); }}
        title="Edit Knowledge Entry"
        size="md"
        styles={{
          header: { backgroundColor: "var(--bg-secondary)" },
          body: { backgroundColor: "var(--bg-secondary)" },
        }}
      >
        <Stack gap="sm">
          <Text size="xs" c="dimmed">
            Edit this knowledge entry. Changes will be visible to all agents.
          </Text>
          <Textarea
            value={editText}
            onChange={(e) => setEditText(e.currentTarget.value)}
            autosize
            minRows={3}
            maxRows={15}
            styles={{
              input: {
                backgroundColor: "var(--bg-primary)",
                borderColor: "var(--border-color)",
                color: "var(--text-primary)",
              },
            }}
          />
          <Group justify="flex-end" gap={8}>
            <Button variant="default" size="sm" onClick={() => { setEditIndex(null); setEditText(""); }}>
              Cancel
            </Button>
            <Button
              size="sm"
              onClick={handleSaveEdit}
              loading={saving}
              disabled={!editText.trim()}
            >
              Save Changes
            </Button>
          </Group>
        </Stack>
      </Modal>

      {/* Delete Confirmation Modal */}
      <Modal
        opened={deleteIndex !== null}
        onClose={() => setDeleteIndex(null)}
        title="Delete Knowledge Entry"
        size="sm"
        styles={{
          header: { backgroundColor: "var(--bg-secondary)" },
          body: { backgroundColor: "var(--bg-secondary)" },
        }}
      >
        <Text size="sm" c="var(--text-secondary)" mb={16}>
          Are you sure you want to delete this knowledge entry? This action cannot be undone.
        </Text>
        {deleteIndex !== null && entries[deleteIndex] && (
          <Paper p="xs" mb={16} withBorder style={{ backgroundColor: "var(--bg-primary)", borderColor: "var(--border-color)" }}>
            <Text size="xs" c="dimmed" lineClamp={3}>
              {entries[deleteIndex].text}
            </Text>
          </Paper>
        )}
        <Group justify="flex-end" gap={8}>
          <Button variant="default" size="sm" onClick={() => setDeleteIndex(null)}>
            Cancel
          </Button>
          <Button color="red" size="sm" onClick={handleDelete} loading={deleting}>
            Delete Entry
          </Button>
        </Group>
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
