import { useEffect, useState, useCallback, useMemo } from "react";
import {
  Badge,
  Button,
  Group,
  Paper,
  Text,
  TextInput,
  Textarea,
  Tooltip,
  Modal,
  Stack,
  Collapse,
  SegmentedControl,
  Table,
} from "@mantine/core";
import { useApi } from "../hooks/useApi";
import { formatLastSeen } from "../utils/formatters";
import { showError, showSuccess } from "../utils/notifications";

interface GlobalKnowledgeEntry {
  id: string;
  text: string;
  source: string;
  timestamp?: string;
  sourceSessionId?: string;
}

type ViewMode = "table" | "cards";

export function GlobalKnowledgePage() {
  const api = useApi();
  const [entries, setEntries] = useState<GlobalKnowledgeEntry[]>([]);
  const [loading, setLoading] = useState(true);
  const [search, setSearch] = useState("");
  const [viewMode, setViewMode] = useState<ViewMode>("table");
  const [expandedId, setExpandedId] = useState<string | null>(null);

  // Sort
  type SortKey = "source" | "sourceSessionId" | "timestamp";
  const [sortKey, setSortKey] = useState<SortKey>("timestamp");
  const [sortAsc, setSortAsc] = useState(false);

  // Pagination
  const PAGE_SIZE = 25;
  const [page, setPage] = useState(0);

  // Add modal
  const [showAddModal, setShowAddModal] = useState(false);
  const [newText, setNewText] = useState("");
  const [adding, setAdding] = useState(false);

  // Edit modal
  const [editEntry, setEditEntry] = useState<GlobalKnowledgeEntry | null>(null);
  const [editText, setEditText] = useState("");
  const [saving, setSaving] = useState(false);

  // Delete modal
  const [deleteEntry, setDeleteEntry] = useState<GlobalKnowledgeEntry | null>(null);
  const [deleting, setDeleting] = useState(false);

  const fetchEntries = useCallback(async () => {
    try {
      const data = await api.getGlobalKnowledge();
      setEntries(data.entries || []);
    } catch {
      // Endpoint may not exist yet
    } finally {
      setLoading(false);
    }
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    fetchEntries();
  }, [fetchEntries]);

  // Filter
  const filtered = useMemo(() => {
    let result = entries;
    if (search.trim()) {
      const q = search.toLowerCase();
      result = result.filter(
        (e) =>
          e.text.toLowerCase().includes(q) ||
          e.source.toLowerCase().includes(q) ||
          (e.sourceSessionId || "").toLowerCase().includes(q)
      );
    }
    // Sort
    result = [...result].sort((a, b) => {
      const aVal = (a[sortKey] || "") as string;
      const bVal = (b[sortKey] || "") as string;
      return sortAsc ? aVal.localeCompare(bVal) : bVal.localeCompare(aVal);
    });
    return result;
  }, [entries, search, sortKey, sortAsc]);

  // Paginate
  const totalPages = Math.ceil(filtered.length / PAGE_SIZE);
  const paginated = filtered.slice(page * PAGE_SIZE, (page + 1) * PAGE_SIZE);

  function handleSort(key: SortKey) {
    if (sortKey === key) {
      setSortAsc(!sortAsc);
    } else {
      setSortKey(key);
      setSortAsc(true);
    }
  }

  function sortIndicator(key: SortKey) {
    if (sortKey !== key) return "";
    return sortAsc ? " \u25B2" : " \u25BC";
  }

  async function handleAdd() {
    if (!newText.trim()) return;
    setAdding(true);
    try {
      await api.addGlobalKnowledge(newText.trim());
      setNewText("");
      setShowAddModal(false);
      showSuccess("Global knowledge entry added");
      fetchEntries();
    } catch (err: any) {
      showError(err.message || "Failed to add entry", "Add Failed");
    } finally {
      setAdding(false);
    }
  }

  async function handleSaveEdit() {
    if (!editEntry || !editText.trim()) return;
    setSaving(true);
    try {
      await api.updateGlobalKnowledge(editEntry.id, editText.trim());
      setEditEntry(null);
      setEditText("");
      showSuccess("Entry updated");
      fetchEntries();
    } catch (err: any) {
      showError(err.message || "Failed to update entry", "Update Failed");
    } finally {
      setSaving(false);
    }
  }

  async function handleDelete() {
    if (!deleteEntry) return;
    setDeleting(true);
    try {
      await api.deleteGlobalKnowledge(deleteEntry.id);
      setDeleteEntry(null);
      showSuccess("Entry deleted");
      fetchEntries();
    } catch (err: any) {
      showError(err.message || "Failed to delete entry", "Delete Failed");
    } finally {
      setDeleting(false);
    }
  }

  function getSourceColor(source: string): string {
    if (source === "dashboard") return "teal";
    if (source.includes("agent") || source.includes("mcp")) return "orange";
    if (source === "promoted") return "grape";
    return "gray";
  }

  const PREVIEW_LENGTH = 150;

  return (
    <div style={{ maxWidth: 1200, margin: "0 auto", padding: "24px 16px" }}>
      {/* Header */}
      <Group justify="space-between" mb={20}>
        <Group gap={12}>
          <Text size="xl" fw={700} c="var(--text-primary)">
            Global Knowledge
          </Text>
          <Badge variant="light" color="grape" size="sm">
            {entries.length} entries
          </Badge>
        </Group>
        <Group gap={8}>
          <TextInput
            size="xs"
            placeholder="Search knowledge..."
            value={search}
            onChange={(e) => { setSearch(e.currentTarget.value); setPage(0); }}
            styles={{
              input: {
                backgroundColor: "var(--bg-primary)",
                borderColor: "var(--border-color)",
                color: "var(--text-primary)",
                minWidth: 200,
              },
            }}
          />
          <SegmentedControl
            value={viewMode}
            onChange={(v) => setViewMode(v as ViewMode)}
            data={[
              { value: "table", label: "Table" },
              { value: "cards", label: "Cards" },
            ]}
            size="xs"
            styles={{
              root: { backgroundColor: "var(--bg-tertiary)", border: "1px solid var(--border-color)" },
              label: { color: "var(--text-primary)", fontWeight: 500, fontSize: 11, padding: "4px 10px" },
            }}
          />
          <Button size="xs" variant="light" color="blue" onClick={() => setShowAddModal(true)}>
            + Add Entry
          </Button>
        </Group>
      </Group>

      {/* Loading */}
      {loading && (
        <Text size="sm" c="dimmed" ta="center" py={40}>
          Loading global knowledge...
        </Text>
      )}

      {/* Empty state */}
      {!loading && entries.length === 0 && (
        <Paper p="xl" withBorder style={{ backgroundColor: "var(--bg-secondary)", borderColor: "var(--border-color)", textAlign: "center" }}>
          <Text size="lg" fw={600} c="var(--text-primary)" mb={8}>
            No Global Knowledge Yet
          </Text>
          <Text size="sm" c="dimmed" mb={16}>
            Global knowledge persists across sessions. Add entries here or promote from session knowledge.
          </Text>
          <Button variant="light" color="blue" onClick={() => setShowAddModal(true)}>
            Add First Entry
          </Button>
        </Paper>
      )}

      {/* No results */}
      {!loading && filtered.length === 0 && entries.length > 0 && (
        <Text size="sm" c="dimmed" ta="center" py={20}>
          No entries matching &ldquo;{search}&rdquo;
        </Text>
      )}

      {/* Table View */}
      {!loading && viewMode === "table" && paginated.length > 0 && (
        <div style={{ border: "1px solid var(--border-color)", borderRadius: 8, overflow: "hidden" }}>
          <Table
            striped
            highlightOnHover
            styles={{
              th: {
                backgroundColor: "var(--bg-tertiary)",
                color: "var(--text-secondary)",
                fontWeight: 500,
                padding: "10px 12px",
                cursor: "pointer",
                userSelect: "none",
                fontSize: 12,
              },
              td: {
                padding: "8px 12px",
                borderTop: "1px solid var(--border-color)",
                fontSize: 13,
              },
            }}
          >
            <Table.Thead>
              <Table.Tr>
                <Table.Th style={{ width: "45%" }}>Value</Table.Th>
                <Table.Th onClick={() => handleSort("source")} style={{ width: "15%" }}>
                  Source{sortIndicator("source")}
                </Table.Th>
                <Table.Th onClick={() => handleSort("sourceSessionId")} style={{ width: "15%" }}>
                  Session{sortIndicator("sourceSessionId")}
                </Table.Th>
                <Table.Th onClick={() => handleSort("timestamp")} style={{ width: "15%" }}>
                  Updated{sortIndicator("timestamp")}
                </Table.Th>
                <Table.Th style={{ width: "10%" }}>Actions</Table.Th>
              </Table.Tr>
            </Table.Thead>
            <Table.Tbody>
              {paginated.map((entry) => (
                <Table.Tr key={entry.id}>
                  <Table.Td>
                    <Text
                      size="sm"
                      c="var(--text-primary)"
                      lineClamp={2}
                      style={{ cursor: "pointer", whiteSpace: "pre-wrap", wordBreak: "break-word" }}
                      onClick={() => setExpandedId(expandedId === entry.id ? null : entry.id)}
                    >
                      {expandedId === entry.id ? entry.text : (entry.text.length > PREVIEW_LENGTH ? entry.text.slice(0, PREVIEW_LENGTH) + "..." : entry.text)}
                    </Text>
                  </Table.Td>
                  <Table.Td>
                    <Badge variant="light" color={getSourceColor(entry.source)} size="xs">
                      {entry.source}
                    </Badge>
                  </Table.Td>
                  <Table.Td>
                    {entry.sourceSessionId ? (
                      <Text size="xs" c="var(--text-secondary)" ff="var(--font-mono)">
                        {entry.sourceSessionId.slice(0, 12)}
                      </Text>
                    ) : (
                      <Text size="xs" c="dimmed">-</Text>
                    )}
                  </Table.Td>
                  <Table.Td>
                    {entry.timestamp ? (
                      <Tooltip label={new Date(entry.timestamp).toLocaleString()} withArrow>
                        <Text size="xs" c="var(--text-secondary)">
                          {formatLastSeen(entry.timestamp)}
                        </Text>
                      </Tooltip>
                    ) : (
                      <Text size="xs" c="dimmed">-</Text>
                    )}
                  </Table.Td>
                  <Table.Td>
                    <Group gap={4}>
                      <Text
                        size="xs"
                        c="teal"
                        fw={500}
                        style={{ cursor: "pointer" }}
                        onClick={() => { setEditEntry(entry); setEditText(entry.text); }}
                      >
                        Edit
                      </Text>
                      <Text size="xs" c="dimmed">|</Text>
                      <Text
                        size="xs"
                        c="red"
                        fw={500}
                        style={{ cursor: "pointer" }}
                        onClick={() => setDeleteEntry(entry)}
                      >
                        Delete
                      </Text>
                    </Group>
                  </Table.Td>
                </Table.Tr>
              ))}
            </Table.Tbody>
          </Table>
        </div>
      )}

      {/* Card View */}
      {!loading && viewMode === "cards" && paginated.length > 0 && (
        <Stack gap={8}>
          {paginated.map((entry) => {
            const isExpanded = expandedId === entry.id;
            return (
              <Paper
                key={entry.id}
                p="sm"
                withBorder
                style={{
                  backgroundColor: isExpanded ? "var(--bg-tertiary)" : "var(--bg-secondary)",
                  borderColor: isExpanded ? "var(--accent-blue)" : "var(--border-color)",
                  cursor: "pointer",
                  transition: "border-color 0.2s, background-color 0.2s",
                }}
                onClick={() => setExpandedId(isExpanded ? null : entry.id)}
              >
                <Group gap={8} mb={4} wrap="wrap">
                  <Badge variant="filled" color="grape" size="xs">Global</Badge>
                  <Badge variant="light" color={getSourceColor(entry.source)} size="xs">{entry.source}</Badge>
                  {entry.sourceSessionId && (
                    <Text size="xs" c="dimmed">from session {entry.sourceSessionId.slice(0, 12)}</Text>
                  )}
                  {entry.timestamp && (
                    <Tooltip label={new Date(entry.timestamp).toLocaleString()} withArrow>
                      <Text size="xs" c="dimmed">{formatLastSeen(entry.timestamp)}</Text>
                    </Tooltip>
                  )}
                  <Group gap={4} style={{ marginLeft: "auto" }}>
                    <Text
                      size="xs"
                      c="teal"
                      fw={500}
                      style={{ cursor: "pointer" }}
                      onClick={(e: React.MouseEvent) => { e.stopPropagation(); setEditEntry(entry); setEditText(entry.text); }}
                    >
                      Edit
                    </Text>
                    <Text size="xs" c="dimmed">|</Text>
                    <Text
                      size="xs"
                      c="red"
                      fw={500}
                      style={{ cursor: "pointer" }}
                      onClick={(e: React.MouseEvent) => { e.stopPropagation(); setDeleteEntry(entry); }}
                    >
                      Delete
                    </Text>
                    <Text size="xs" c="dimmed">|</Text>
                    <Text size="xs" c="blue">
                      {isExpanded ? "\u25BC collapse" : "\u25B6 expand"}
                    </Text>
                  </Group>
                </Group>
                {!isExpanded && (
                  <Text size="sm" c="var(--text-primary)" lineClamp={3} style={{ lineHeight: 1.5, whiteSpace: "pre-wrap", wordBreak: "break-word" }}>
                    {entry.text}
                  </Text>
                )}
                <Collapse in={isExpanded}>
                  <Text size="sm" c="var(--text-primary)" style={{ lineHeight: 1.5, whiteSpace: "pre-wrap", wordBreak: "break-word" }}>
                    {entry.text}
                  </Text>
                </Collapse>
              </Paper>
            );
          })}
        </Stack>
      )}

      {/* Pagination */}
      {!loading && totalPages > 1 && (
        <Group justify="center" mt={16} gap={8}>
          <Button
            size="xs"
            variant="default"
            disabled={page === 0}
            onClick={() => setPage(page - 1)}
            styles={{ root: { backgroundColor: "var(--bg-tertiary)", borderColor: "var(--border-color)", color: "var(--text-primary)" } }}
          >
            Previous
          </Button>
          <Text size="xs" c="var(--text-secondary)">
            Page {page + 1} of {totalPages}
          </Text>
          <Button
            size="xs"
            variant="default"
            disabled={page >= totalPages - 1}
            onClick={() => setPage(page + 1)}
            styles={{ root: { backgroundColor: "var(--bg-tertiary)", borderColor: "var(--border-color)", color: "var(--text-primary)" } }}
          >
            Next
          </Button>
        </Group>
      )}

      {/* Add Entry Modal */}
      <Modal
        opened={showAddModal}
        onClose={() => setShowAddModal(false)}
        title="Add Global Knowledge Entry"
        size="md"
        styles={{
          header: { backgroundColor: "var(--bg-secondary)", borderBottom: "1px solid var(--border-color)" },
          body: { backgroundColor: "var(--bg-secondary)" },
          content: { backgroundColor: "var(--bg-secondary)" },
          title: { color: "var(--text-primary)", fontWeight: 600 },
          close: { color: "var(--text-secondary)" },
        }}
      >
        <Stack gap="sm">
          <Text size="xs" c="dimmed">
            Add a knowledge entry that persists across all sessions. Use this for cross-project conventions, decisions, or context.
          </Text>
          <Textarea
            placeholder="Enter knowledge text..."
            value={newText}
            onChange={(e) => setNewText(e.currentTarget.value)}
            autosize
            minRows={3}
            maxRows={10}
            styles={{
              input: { backgroundColor: "var(--bg-primary)", borderColor: "var(--border-color)", color: "var(--text-primary)" },
            }}
          />
          <Group justify="flex-end" gap={8}>
            <Button variant="default" size="sm" onClick={() => setShowAddModal(false)}>Cancel</Button>
            <Button size="sm" onClick={handleAdd} loading={adding} disabled={!newText.trim()}>Add Entry</Button>
          </Group>
        </Stack>
      </Modal>

      {/* Edit Entry Modal */}
      <Modal
        opened={!!editEntry}
        onClose={() => { setEditEntry(null); setEditText(""); }}
        title="Edit Global Knowledge Entry"
        size="md"
        styles={{
          header: { backgroundColor: "var(--bg-secondary)", borderBottom: "1px solid var(--border-color)" },
          body: { backgroundColor: "var(--bg-secondary)" },
          content: { backgroundColor: "var(--bg-secondary)" },
          title: { color: "var(--text-primary)", fontWeight: 600 },
          close: { color: "var(--text-secondary)" },
        }}
      >
        <Stack gap="sm">
          <Textarea
            value={editText}
            onChange={(e) => setEditText(e.currentTarget.value)}
            autosize
            minRows={3}
            maxRows={15}
            styles={{
              input: { backgroundColor: "var(--bg-primary)", borderColor: "var(--border-color)", color: "var(--text-primary)" },
            }}
          />
          <Group justify="flex-end" gap={8}>
            <Button variant="default" size="sm" onClick={() => { setEditEntry(null); setEditText(""); }}>Cancel</Button>
            <Button size="sm" onClick={handleSaveEdit} loading={saving} disabled={!editText.trim()}>Save Changes</Button>
          </Group>
        </Stack>
      </Modal>

      {/* Delete Confirmation Modal */}
      <Modal
        opened={!!deleteEntry}
        onClose={() => setDeleteEntry(null)}
        title="Delete Global Knowledge Entry"
        size="sm"
        styles={{
          header: { backgroundColor: "var(--bg-secondary)", borderBottom: "1px solid var(--border-color)" },
          body: { backgroundColor: "var(--bg-secondary)" },
          content: { backgroundColor: "var(--bg-secondary)" },
          title: { color: "var(--text-primary)", fontWeight: 600 },
          close: { color: "var(--text-secondary)" },
        }}
      >
        <Text size="sm" c="var(--text-secondary)" mb={16}>
          Are you sure you want to delete this global knowledge entry? This action cannot be undone.
        </Text>
        {deleteEntry && (
          <Paper p="xs" mb={16} withBorder style={{ backgroundColor: "var(--bg-primary)", borderColor: "var(--border-color)" }}>
            <Text size="xs" c="dimmed" lineClamp={3}>{deleteEntry.text}</Text>
          </Paper>
        )}
        <Group justify="flex-end" gap={8}>
          <Button variant="default" size="sm" onClick={() => setDeleteEntry(null)}>Cancel</Button>
          <Button color="red" size="sm" onClick={handleDelete} loading={deleting}>Delete Entry</Button>
        </Group>
      </Modal>
    </div>
  );
}
