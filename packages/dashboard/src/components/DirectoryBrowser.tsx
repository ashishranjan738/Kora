import { useCallback, useEffect, useMemo, useState } from "react";
import {
  Modal,
  Stack,
  Group,
  Text,
  ActionIcon,
  Breadcrumbs,
  Anchor,
  TextInput,
  Button,
  Loader,
  Alert,
  ScrollArea,
  UnstyledButton,
  Badge,
  Divider,
  Tooltip,
} from "@mantine/core";
import { useMediaQuery } from "@mantine/hooks";
import { useApi } from "../hooks/useApi";

/* ── Styles (matches SpawnAgentDialog conventions) ─────────── */

const modalStyles = {
  header: { backgroundColor: "var(--bg-secondary)", borderBottom: "1px solid var(--border-color)", padding: "16px 24px" },
  body: { backgroundColor: "var(--bg-secondary)", padding: "0", overflowY: "hidden" as const, maxHeight: "calc(85vh - 80px)" },
  content: { backgroundColor: "var(--bg-secondary)", maxHeight: "85vh", display: "flex" as const, flexDirection: "column" as const, borderRadius: 12 },
  inner: { padding: "20px 0" },
  title: { color: "var(--text-primary)", fontWeight: 700 as const, fontSize: 17 },
  close: { color: "var(--text-secondary)" },
};

const fieldStyles = {
  input: { backgroundColor: "var(--bg-primary)", borderColor: "var(--border-color)", color: "var(--text-primary)", borderRadius: 8, height: 38, fontSize: 13, fontFamily: "var(--font-mono)" },
};

const cancelBtnStyles = { root: { backgroundColor: "var(--bg-tertiary)", borderColor: "var(--border-color)", color: "var(--text-primary)", minHeight: 40, paddingInline: 20, borderRadius: 8, fontWeight: 500 as const } };
const primaryBtnStyles = { root: { backgroundColor: "var(--accent-blue)", borderColor: "var(--accent-blue)", minHeight: 40, paddingInline: 24, borderRadius: 8, fontWeight: 600 as const } };

/* ── Types ────────────────────────────────────────────────── */

interface DirectoryEntry {
  name: string;
  path: string;
  isGitRepo?: boolean;
}

interface BrowseResponse {
  path: string;
  parent: string | null;
  directories: DirectoryEntry[];
  homeDir: string;
}

/* ── Props ────────────────────────────────────────────────── */

interface DirectoryBrowserProps {
  opened: boolean;
  onClose: () => void;
  onSelect: (path: string) => void;
  initialPath?: string;
}

/* ── Component ────────────────────────────────────────────── */

export function DirectoryBrowser({ opened, onClose, onSelect, initialPath }: DirectoryBrowserProps) {
  const api = useApi();
  const isMobile = useMediaQuery("(max-width: 48em)");

  const [currentPath, setCurrentPath] = useState(initialPath || "");
  const [directories, setDirectories] = useState<DirectoryEntry[]>([]);
  const [parentPath, setParentPath] = useState<string | null>(null);
  const [homeDir, setHomeDir] = useState("");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const [filter, setFilter] = useState("");
  const [recentPaths, setRecentPaths] = useState<string[]>([]);
  const [loadingRecent, setLoadingRecent] = useState(false);

  // Reset state when modal opens
  useEffect(() => {
    if (opened) {
      setFilter("");
      setError("");
      setCurrentPath(initialPath || "");
      loadRecentPaths();
    }
  }, [opened]); // eslint-disable-line react-hooks/exhaustive-deps

  // Fetch directories whenever currentPath changes (and modal is open)
  useEffect(() => {
    if (opened) {
      fetchDirectories(currentPath);
    }
  }, [currentPath, opened]); // eslint-disable-line react-hooks/exhaustive-deps

  async function loadRecentPaths() {
    setLoadingRecent(true);
    try {
      const data = await api.getRecentPaths(8);
      setRecentPaths(data.paths || []);
    } catch {
      // Silently fail — recent paths are optional
    } finally {
      setLoadingRecent(false);
    }
  }

  const fetchDirectories = useCallback(async (dirPath: string) => {
    setLoading(true);
    setError("");
    try {
      const data: BrowseResponse = await (api as any).browseDirectories(dirPath);
      setDirectories(data.directories || []);
      setParentPath(data.parent);
      setCurrentPath(data.path);
      if (data.homeDir) setHomeDir(data.homeDir);
    } catch (err: any) {
      const msg = err?.message || "Failed to browse directory";
      // Extract meaningful message from API error
      if (msg.includes("ENOENT") || msg.includes("not found")) {
        setError("Directory not found. Check the path and try again.");
      } else if (msg.includes("EACCES") || msg.includes("permission")) {
        setError("Permission denied. Cannot access this directory.");
      } else {
        setError(msg);
      }
      setDirectories([]);
    } finally {
      setLoading(false);
    }
  }, [api]); // eslint-disable-line react-hooks/exhaustive-deps

  // Filter directories by typed text
  const filteredDirs = useMemo(() => {
    if (!filter.trim()) return directories;
    const lower = filter.toLowerCase();
    return directories.filter((d) => d.name.toLowerCase().includes(lower));
  }, [directories, filter]);

  // Build breadcrumb segments from currentPath
  const breadcrumbs = useMemo(() => {
    if (!currentPath) return [];
    const parts = currentPath.split("/").filter(Boolean);
    const segments: { label: string; path: string }[] = [];

    // Root
    segments.push({ label: "/", path: "/" });

    let accumulated = "";
    for (const part of parts) {
      accumulated += "/" + part;
      // Replace home directory prefix with ~
      if (homeDir && accumulated === homeDir) {
        segments.length = 0; // Clear previous segments
        segments.push({ label: "~", path: homeDir });
      } else {
        segments.push({ label: part, path: accumulated });
      }
    }
    return segments;
  }, [currentPath, homeDir]);

  function handleDrillIn(dir: DirectoryEntry) {
    setFilter("");
    setCurrentPath(dir.path);
  }

  function handleGoUp() {
    if (parentPath !== null) {
      setFilter("");
      setCurrentPath(parentPath);
    }
  }

  function handleGoHome() {
    if (homeDir) {
      setFilter("");
      setCurrentPath(homeDir);
    }
  }

  function handleSelectCurrent() {
    onSelect(currentPath);
    onClose();
  }

  function handleSelectRecent(path: string) {
    onSelect(path);
    onClose();
  }

  function handleBreadcrumbClick(path: string) {
    setFilter("");
    setCurrentPath(path);
  }

  const showRecentPaths = recentPaths.length > 0 && !loading;

  return (
    <Modal
      opened={opened}
      onClose={onClose}
      title="Browse Directory"
      size="lg"
      fullScreen={isMobile}
      centered
      styles={modalStyles}
    >
      <Stack gap={0} style={{ height: isMobile ? "calc(100vh - 80px)" : "min(520px, calc(85vh - 100px))" }}>
        {/* ── Navigation bar ── */}
        <Group gap={8} px="md" py="sm" style={{ borderBottom: "1px solid var(--border-color)", flexShrink: 0 }}>
          <Tooltip label="Go to parent directory" position="bottom" withArrow>
            <ActionIcon
              variant="subtle"
              size="sm"
              onClick={handleGoUp}
              disabled={parentPath === null}
              style={{ color: "var(--text-secondary)" }}
              aria-label="Go up"
            >
              <span style={{ fontSize: 16 }}>&#8593;</span>
            </ActionIcon>
          </Tooltip>
          <Tooltip label="Go to home directory" position="bottom" withArrow>
            <ActionIcon
              variant="subtle"
              size="sm"
              onClick={handleGoHome}
              disabled={!homeDir}
              style={{ color: "var(--text-secondary)" }}
              aria-label="Go home"
            >
              <span style={{ fontSize: 14 }}>&#8962;</span>
            </ActionIcon>
          </Tooltip>

          <Divider orientation="vertical" color="var(--border-color)" />

          {/* ── Breadcrumbs ── */}
          <div style={{ flex: 1, overflow: "hidden" }}>
            <Breadcrumbs
              separator="/"
              separatorMargin={4}
              styles={{
                root: { flexWrap: "nowrap", overflow: "hidden" },
                separator: { color: "var(--text-muted)", fontSize: 12 },
                breadcrumb: { fontSize: 13, whiteSpace: "nowrap" },
              }}
            >
              {breadcrumbs.map((seg, i) => (
                i === breadcrumbs.length - 1 ? (
                  <Text key={seg.path} size="sm" fw={600} c="var(--text-primary)" style={{ whiteSpace: "nowrap" }}>
                    {seg.label}
                  </Text>
                ) : (
                  <Anchor
                    key={seg.path}
                    size="sm"
                    c="var(--accent-blue)"
                    onClick={() => handleBreadcrumbClick(seg.path)}
                    style={{ cursor: "pointer", whiteSpace: "nowrap" }}
                  >
                    {seg.label}
                  </Anchor>
                )
              ))}
            </Breadcrumbs>
          </div>
        </Group>

        {/* ── Recent paths section ── */}
        {showRecentPaths && (
          <div style={{ borderBottom: "1px solid var(--border-color)", flexShrink: 0 }}>
            <Group gap={6} px="md" py={8}>
              <Text size="xs" c="var(--text-muted)" fw={500}>Recent:</Text>
              <div style={{ display: "flex", gap: 6, flexWrap: "wrap", flex: 1, overflow: "hidden" }}>
                {recentPaths.slice(0, 5).map((p) => {
                  // Show abbreviated path: last 2 segments
                  const parts = p.split("/").filter(Boolean);
                  const shortLabel = parts.length > 2 ? ".../" + parts.slice(-2).join("/") : p;
                  return (
                    <Badge
                      key={p}
                      variant="light"
                      color="gray"
                      size="sm"
                      style={{ cursor: "pointer", maxWidth: 180, textTransform: "none", fontFamily: "var(--font-mono)", fontSize: 11 }}
                      onClick={() => handleSelectRecent(p)}
                      title={p}
                    >
                      {shortLabel}
                    </Badge>
                  );
                })}
              </div>
            </Group>
          </div>
        )}

        {/* ── Filter input ── */}
        <div style={{ padding: "8px 16px", borderBottom: "1px solid var(--border-color)", flexShrink: 0 }}>
          <TextInput
            placeholder="Type to filter..."
            value={filter}
            onChange={(e) => setFilter(e.currentTarget.value)}
            size="xs"
            styles={fieldStyles}
            leftSection={<span style={{ fontSize: 13, color: "var(--text-muted)" }}>&#128269;</span>}
          />
        </div>

        {/* ── Error ── */}
        {error && (
          <div style={{ padding: "8px 16px", flexShrink: 0 }}>
            <Alert color="red" variant="light" radius="md" styles={{ root: { padding: "8px 12px" } }}>
              {error}
            </Alert>
          </div>
        )}

        {/* ── Directory listing ── */}
        <ScrollArea style={{ flex: 1 }} offsetScrollbars>
          {loading ? (
            <Stack align="center" justify="center" py="xl">
              <Loader size="sm" color="var(--accent-blue)" />
              <Text size="sm" c="var(--text-muted)">Loading directories...</Text>
            </Stack>
          ) : filteredDirs.length === 0 ? (
            <Stack align="center" justify="center" py="xl">
              <Text size="sm" c="var(--text-muted)">
                {filter ? "No matching directories" : "No subdirectories"}
              </Text>
            </Stack>
          ) : (
            <Stack gap={0} px={0}>
              {filteredDirs.map((dir) => (
                <UnstyledButton
                  key={dir.path}
                  onClick={() => handleDrillIn(dir)}
                  onDoubleClick={() => {
                    onSelect(dir.path);
                    onClose();
                  }}
                  style={{
                    display: "flex",
                    alignItems: "center",
                    gap: 10,
                    padding: "8px 16px",
                    borderBottom: "1px solid var(--border-color-subtle, var(--border-color))",
                    cursor: "pointer",
                    transition: "background-color 0.1s ease",
                  }}
                  className="directory-browser-item"
                >
                  {/* Folder icon — git repos get special indicator */}
                  <span style={{ fontSize: 16, flexShrink: 0, width: 20, textAlign: "center" }}>
                    {dir.isGitRepo ? (
                      <Tooltip label="Git repository" position="right" withArrow>
                        <span style={{ color: "#f78166" }}>&#9673;</span>
                      </Tooltip>
                    ) : (
                      <span style={{ color: "var(--accent-blue)" }}>&#128193;</span>
                    )}
                  </span>

                  <Text size="sm" c="var(--text-primary)" style={{ flex: 1, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                    {dir.name}
                  </Text>

                  {dir.isGitRepo && (
                    <Badge variant="light" color="orange" size="xs" style={{ flexShrink: 0 }}>
                      git
                    </Badge>
                  )}

                  <span style={{ color: "var(--text-muted)", fontSize: 14, flexShrink: 0 }}>&#8250;</span>
                </UnstyledButton>
              ))}
            </Stack>
          )}
        </ScrollArea>

        {/* ── Footer: current path + actions ── */}
        <div style={{ borderTop: "1px solid var(--border-color)", padding: "12px 16px", flexShrink: 0, backgroundColor: "var(--bg-secondary)" }}>
          <Group gap={6} mb={8}>
            <Text size="xs" c="var(--text-muted)" fw={500}>Selected:</Text>
            <Text size="xs" c="var(--text-primary)" ff="var(--font-mono)" style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", flex: 1 }}>
              {currentPath || "..."}
            </Text>
          </Group>
          <Group justify="flex-end" gap={10}>
            <Button variant="default" onClick={onClose} styles={cancelBtnStyles} size="sm">
              Cancel
            </Button>
            <Button
              onClick={handleSelectCurrent}
              disabled={!currentPath || loading}
              styles={primaryBtnStyles}
              size="sm"
            >
              Select This Directory
            </Button>
          </Group>
        </div>
      </Stack>
    </Modal>
  );
}
