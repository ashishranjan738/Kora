import { useState, useEffect, useCallback, useRef } from "react";
import Editor from "@monaco-editor/react";
import { createReviewManager } from "monaco-review";
import { useApi } from "../hooks/useApi";
import { useThemeStore } from "../stores/themeStore";
import { showError, showSuccess } from "../utils/notifications";
import { ConfirmDialog } from "./ConfirmDialog";
import { Modal, TextInput, Textarea, Select, SegmentedControl, Button, Group, Stack, Text, Code } from "@mantine/core";

interface EditorTileProps {
  sessionId: string;
}

interface FileItem {
  name: string;
  type: "file" | "directory";
  path: string;
}

interface OpenTab {
  path: string;
  content: string;
  language: string;
  modified: boolean;
}

export function EditorTile({ sessionId }: EditorTileProps) {
  const api = useApi();
  const { resolvedEditorTheme } = useThemeStore();
  const [files, setFiles] = useState<FileItem[]>([]);
  const [currentDir, setCurrentDir] = useState("");
  const [openTabs, setOpenTabs] = useState<OpenTab[]>([]);
  const [activeTabPath, setActiveTabPath] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const openTabsRef = useRef(openTabs);
  const activeTabPathRef = useRef(activeTabPath);

  // Unsaved changes close confirmation state
  const [pendingCloseTab, setPendingCloseTab] = useState<string | null>(null);

  // Code review / inline comments
  const reviewManagerRef = useRef<ReturnType<typeof createReviewManager> | null>(null);
  const editorInstanceRef = useRef<any>(null);
  const [commentEvents, setCommentEvents] = useState<any[]>([]);

  // Create Task from Selection dialog state
  const [taskDialog, setTaskDialog] = useState<{
    open: boolean;
    filePath: string;
    startLine: number;
    endLine: number;
    selectedText: string;
    title: string;
    description: string;
  }>({ open: false, filePath: "", startLine: 0, endLine: 0, selectedText: "", title: "", description: "" });
  const [taskAssignee, setTaskAssignee] = useState("");
  const [taskPriority, setTaskPriority] = useState("P2");
  const [creatingTask, setCreatingTask] = useState(false);
  const [agents, setAgents] = useState<Array<{ id: string; name: string }>>([]);

  // Fetch agents for assignment dropdown
  useEffect(() => {
    async function loadAgents() {
      try {
        const data = await api.getAgents(sessionId);
        setAgents((data.agents || []).map((a: any) => ({ id: a.id, name: a.config?.name || a.name || a.id })));
      } catch { /* ignore */ }
    }
    loadAgents();
  }, [sessionId]); // eslint-disable-line react-hooks/exhaustive-deps

  // Quick-open state
  const [quickOpenVisible, setQuickOpenVisible] = useState(false);
  const [quickOpenQuery, setQuickOpenQuery] = useState("");
  const [allFiles, setAllFiles] = useState<string[]>([]);
  const [quickOpenResults, setQuickOpenResults] = useState<string[]>([]);
  const [quickOpenIndex, setQuickOpenIndex] = useState(0);

  // Keep refs in sync for the keydown handler
  useEffect(() => { openTabsRef.current = openTabs; }, [openTabs]);
  useEffect(() => { activeTabPathRef.current = activeTabPath; }, [activeTabPath]);

  // Derived: active tab object
  const activeTab = openTabs.find(t => t.path === activeTabPath) || null;

  // Load files for current directory
  const loadFiles = useCallback(async () => {
    try {
      const data = await api.listFiles(sessionId, currentDir);
      setFiles(data.items);
    } catch { /* ignore */ }
  }, [sessionId, currentDir]);

  useEffect(() => { loadFiles(); }, [loadFiles]);

  // Fetch all files recursively for quick-open
  const fetchAllFiles = useCallback(async () => {
    const files: string[] = [];
    async function walk(dir: string) {
      try {
        const data = await api.listFiles(sessionId, dir);
        for (const item of data.items) {
          if (item.type === "file") {
            files.push(item.path);
          } else if (item.type === "directory") {
            // Skip common non-code directories and Kora runtime dirs
            const skip = ["node_modules", ".git", "dist", "build", ".next", "target", "__pycache__", "coverage", ".vscode", ".idea", ".kora", ".kora-dev"];
            if (!skip.includes(item.name)) {
              await walk(item.path);
            }
          }
        }
      } catch { /* ignore errors */ }
    }
    await walk("");
    setAllFiles(files);
  }, [sessionId]);

  // Filter results as user types
  useEffect(() => {
    if (!quickOpenQuery) {
      setQuickOpenResults(allFiles.slice(0, 20));
      return;
    }
    const query = quickOpenQuery.toLowerCase();
    const filtered = allFiles.filter(f => {
      const name = f.split("/").pop()?.toLowerCase() || "";
      const path = f.toLowerCase();
      return name.includes(query) || path.includes(query);
    }).slice(0, 20);
    setQuickOpenResults(filtered);
    setQuickOpenIndex(0);
  }, [quickOpenQuery, allFiles]);

  // Open a file (or switch to its tab if already open)
  async function handleOpenFile(filePath: string) {
    const existing = openTabs.find(t => t.path === filePath);
    if (existing) {
      setActiveTabPath(filePath);
      return;
    }
    try {
      const data = await api.readFile(sessionId, filePath);
      const newTab: OpenTab = { path: data.path, content: data.content, language: data.language, modified: false };
      setOpenTabs(prev => [...prev, newTab]);
      setActiveTabPath(data.path);
    } catch (err: any) {
      showError(err.message, "Failed to open file");
    }
  }

  // Close a tab — prompts to save if modified
  function closeTab(tabPath: string) {
    const tab = openTabs.find(t => t.path === tabPath);
    if (tab?.modified) {
      // Show confirmation dialog instead of blocking window.confirm()
      setPendingCloseTab(tabPath);
      return;
    }
    executeCloseTab(tabPath);
  }

  // Actually close the tab (after optional save)
  function executeCloseTab(tabPath: string, saveFirst = false) {
    if (saveFirst) {
      const tab = openTabs.find(t => t.path === tabPath);
      if (tab) {
        api.writeFile(sessionId, tab.path, tab.content).catch(() => {});
      }
    }
    setOpenTabs(prev => {
      const updated = prev.filter(t => t.path !== tabPath);
      if (activeTabPath === tabPath) {
        // Switch to adjacent tab
        const closedIdx = prev.findIndex(t => t.path === tabPath);
        const nextTab = updated[Math.min(closedIdx, updated.length - 1)];
        setActiveTabPath(nextTab ? nextTab.path : null);
      }
      return updated;
    });
    setPendingCloseTab(null);
  }

  // Save the active tab
  const handleSave = useCallback(async () => {
    const tabs = openTabsRef.current;
    const activePath = activeTabPathRef.current;
    const tab = tabs.find(t => t.path === activePath);
    if (!tab || !tab.modified) return;
    setSaving(true);
    try {
      await api.writeFile(sessionId, tab.path, tab.content);
      setOpenTabs(prev => prev.map(t =>
        t.path === activePath ? { ...t, modified: false } : t
      ));
    } catch (err: any) {
      showError(err.message, "Failed to save");
    } finally {
      setSaving(false);
    }
  }, [sessionId]);

  // Ctrl+S to save, Ctrl+W to close active tab, Ctrl+P for quick-open
  useEffect(() => {
    function handleKeyDown(e: KeyboardEvent) {
      if ((e.ctrlKey || e.metaKey) && e.key === "s") {
        e.preventDefault();
        handleSave();
      }
      if ((e.ctrlKey || e.metaKey) && e.key === "w") {
        const activePath = activeTabPathRef.current;
        if (activePath && openTabsRef.current.some(t => t.path === activePath)) {
          e.preventDefault();
          closeTab(activePath);
        }
      }
      if ((e.ctrlKey || e.metaKey) && e.key === "p") {
        e.preventDefault();
        setQuickOpenVisible(true);
        setQuickOpenQuery("");
        setQuickOpenIndex(0);
        // Fetch all files if not cached
        if (allFiles.length === 0) fetchAllFiles();
      }
    }
    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [handleSave, allFiles, fetchAllFiles]);

  // Navigate directory
  function navigateDir(dirPath: string) {
    setCurrentDir(dirPath);
  }

  // Go up one directory
  function goUp() {
    const parts = currentDir.split("/").filter(Boolean);
    parts.pop();
    setCurrentDir(parts.join("/"));
  }

  const activeFilename = activeTab ? (activeTab.path.split("/").pop() || activeTab.path) : "";

  return (
    <div style={{ display: "flex", height: "100%", background: "var(--bg-primary)" }}>
      {/* File tree sidebar */}
      <div style={{
        width: 200, borderRight: "1px solid var(--border-color)", overflowY: "auto",
        fontSize: 12, color: "var(--text-primary)",
      }}>
        {/* Breadcrumb + Search */}
        <div style={{ padding: "4px 8px", borderBottom: "1px solid var(--border-color)", color: "var(--text-secondary)", fontSize: 11, display: "flex", alignItems: "center", justifyContent: "space-between" }}>
          <div>
            <span style={{ cursor: "pointer" }} onClick={() => setCurrentDir("")}>root</span>
            {currentDir && currentDir.split("/").filter(Boolean).map((part, i, arr) => (
              <span key={i}>
                {" / "}
                <span style={{ cursor: "pointer" }} onClick={() => navigateDir(arr.slice(0, i + 1).join("/"))}>
                  {part}
                </span>
              </span>
            ))}
          </div>
          <button
            onClick={() => { setQuickOpenVisible(true); setQuickOpenQuery(""); setQuickOpenIndex(0); if (allFiles.length === 0) fetchAllFiles(); }}
            title="Search files (Ctrl+P)"
            style={{
              background: "none", border: "none", cursor: "pointer", padding: "2px 4px",
              color: "var(--text-muted)", display: "flex", alignItems: "center",
              borderRadius: 4, opacity: 0.6,
            }}
            onMouseEnter={(e) => { e.currentTarget.style.opacity = "1"; e.currentTarget.style.background = "var(--bg-tertiary)"; }}
            onMouseLeave={(e) => { e.currentTarget.style.opacity = "0.6"; e.currentTarget.style.background = "none"; }}
          >
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <circle cx="11" cy="11" r="8"/><line x1="21" y1="21" x2="16.65" y2="16.65"/>
            </svg>
          </button>
        </div>

        {/* Up button */}
        {currentDir && (
          <div onClick={goUp} style={{ padding: "4px 8px", cursor: "pointer", color: "var(--text-secondary)" }}>
            {".. (up)"}
          </div>
        )}

        {/* File list — hide system/runtime files */}
        {files.filter(item => {
          const hidden = [".DS_Store", ".kora", ".kora-dev", "Thumbs.db", ".git"];
          return !hidden.includes(item.name);
        }).map(item => (
          <div
            key={item.path}
            onClick={() => item.type === "directory" ? navigateDir(item.path) : handleOpenFile(item.path)}
            style={{
              padding: "3px 8px", cursor: "pointer",
              background: activeTabPath === item.path ? "var(--bg-tertiary)" : "transparent",
            }}
            onMouseEnter={(e) => (e.currentTarget.style.background = "var(--bg-secondary)")}
            onMouseLeave={(e) => (e.currentTarget.style.background = activeTabPath === item.path ? "var(--bg-tertiary)" : "transparent")}
          >
            <span style={{ marginRight: 4, color: item.type === "directory" ? "var(--text-secondary)" : "var(--accent-blue)" }}>
              {item.type === "directory" ? "\u25B6" : "\u25CB"}
            </span>
            {item.name}
          </div>
        ))}
      </div>

      {/* Editor area */}
      <div style={{ flex: 1, display: "flex", flexDirection: "column", position: "relative" }}>
        {/* Quick-open overlay */}
        {quickOpenVisible && (
          <div style={{
            position: "absolute", top: 0, left: "50%", transform: "translateX(-50%)",
            zIndex: 100, width: "min(500px, 80%)",
            background: "var(--bg-secondary)", border: "1px solid var(--border-color)",
            borderRadius: "0 0 8px 8px", boxShadow: "0 8px 24px rgba(0,0,0,0.3)",
            overflow: "hidden",
          }}>
            <input
              value={quickOpenQuery}
              onChange={(e) => setQuickOpenQuery(e.target.value)}
              placeholder="Search files by name..."
              autoFocus
              onKeyDown={(e) => {
                if (e.key === "Escape") setQuickOpenVisible(false);
                if (e.key === "ArrowDown") {
                  e.preventDefault();
                  setQuickOpenIndex(i => Math.min(i + 1, quickOpenResults.length - 1));
                }
                if (e.key === "ArrowUp") {
                  e.preventDefault();
                  setQuickOpenIndex(i => Math.max(i - 1, 0));
                }
                if (e.key === "Enter" && quickOpenResults[quickOpenIndex]) {
                  handleOpenFile(quickOpenResults[quickOpenIndex]);
                  setQuickOpenVisible(false);
                }
              }}
              style={{
                width: "100%", padding: "10px 14px", border: "none", outline: "none",
                background: "var(--bg-tertiary)", color: "var(--text-primary)", fontSize: 14,
                boxSizing: "border-box",
              }}
            />
            <div style={{ maxHeight: 300, overflowY: "auto" }}>
              {quickOpenResults.map((file, i) => (
                <div
                  key={file}
                  onClick={() => { handleOpenFile(file); setQuickOpenVisible(false); }}
                  style={{
                    padding: "6px 14px", cursor: "pointer", fontSize: 13,
                    display: "flex", alignItems: "center", gap: 8,
                    background: i === quickOpenIndex ? "var(--bg-tertiary)" : "transparent",
                    color: i === quickOpenIndex ? "var(--text-primary)" : "var(--text-secondary)",
                  }}
                  onMouseEnter={() => setQuickOpenIndex(i)}
                >
                  <span style={{ color: "var(--accent-blue)", fontSize: 11 }}>○</span>
                  <span style={{ flex: 1 }}>{file.split("/").pop()}</span>
                  <span style={{ fontSize: 11, color: "var(--text-muted)" }}>{file}</span>
                </div>
              ))}
              {quickOpenResults.length === 0 && quickOpenQuery && (
                <div style={{ padding: "12px 14px", color: "var(--text-muted)", fontSize: 13 }}>
                  No files found
                </div>
              )}
            </div>
          </div>
        )}

        {openTabs.length > 0 ? (
          <>
            {/* Tab bar */}
            <div style={{
              display: "flex", overflowX: "auto", background: "var(--bg-secondary)",
              borderBottom: "1px solid var(--border-color)", fontSize: 12, flexShrink: 0,
            }}>
              {openTabs.map(tab => {
                const filename = tab.path.split("/").pop() || tab.path;
                const isActive = tab.path === activeTabPath;
                return (
                  <div
                    key={tab.path}
                    onClick={() => setActiveTabPath(tab.path)}
                    style={{
                      padding: "6px 12px", cursor: "pointer", display: "flex",
                      alignItems: "center", gap: 6, borderBottom: isActive ? "2px solid var(--accent-blue)" : "2px solid transparent",
                      color: isActive ? "var(--text-primary)" : "var(--text-secondary)", whiteSpace: "nowrap",
                      background: isActive ? "var(--bg-primary)" : "transparent",
                    }}
                    title={tab.path}
                  >
                    {tab.modified && <span style={{ color: "var(--accent-yellow)" }}>{"\u25CF"}</span>}
                    {filename}
                    <span
                      onClick={(e) => { e.stopPropagation(); closeTab(tab.path); }}
                      style={{ opacity: 0.5, cursor: "pointer", fontSize: 10, marginLeft: 4 }}
                      onMouseEnter={(e) => (e.currentTarget.style.opacity = "1")}
                      onMouseLeave={(e) => (e.currentTarget.style.opacity = "0.5")}
                    >{"\u00D7"}</span>
                  </div>
                );
              })}
            </div>
            {/* Save button bar */}
            <div style={{
              display: "flex", alignItems: "center", justifyContent: "flex-end",
              padding: "2px 12px", background: "var(--bg-secondary)",
              borderBottom: "1px solid var(--border-color)", fontSize: 11,
            }}>
              <button
                onClick={handleSave}
                disabled={!activeTab?.modified || saving}
                style={{
                  background: activeTab?.modified ? "var(--accent-green)" : "var(--bg-tertiary)",
                  color: activeTab?.modified ? "white" : "var(--text-muted)",
                  border: "none", borderRadius: 4, padding: "2px 10px",
                  cursor: activeTab?.modified ? "pointer" : "default", fontSize: 11,
                }}
              >
                {saving ? "Saving..." : `Save ${activeFilename}`}
              </button>
            </div>
            {/* Monaco Editor */}
            <div style={{ flex: 1, minHeight: 0 }}>
              {activeTab ? (
                <Editor
                  key={activeTab.path}
                  height="100%"
                  language={activeTab.language}
                  value={activeTab.content}
                  theme={resolvedEditorTheme}
                  onChange={(value) => {
                    if (value !== undefined && activeTabPath) {
                      setOpenTabs(prev => prev.map(tab =>
                        tab.path === activeTabPath ? { ...tab, content: value, modified: true } : tab
                      ));
                    }
                  }}
                  options={{
                    minimap: { enabled: true, scale: 1, showSlider: "mouseover" },
                    fontSize: 13,
                    fontFamily: "'JetBrains Mono', 'Fira Code', 'Cascadia Code', monospace",
                    lineNumbers: "on",
                    scrollBeyondLastLine: false,
                    wordWrap: "on",
                    tabSize: 2,
                    // === VS Code-like features (all enabled) ===
                    // Cursor & selection
                    multiCursorModifier: "alt",           // Alt+Click for multi-cursor
                    cursorBlinking: "smooth",
                    cursorSmoothCaretAnimation: "on",
                    cursorStyle: "line",
                    columnSelection: true,                // Shift+Alt+drag for box/column select
                    // Scrolling
                    smoothScrolling: true,
                    mouseWheelZoom: true,                  // Ctrl+scroll to zoom
                    stickyScroll: { enabled: true },       // Sticky scope headers while scrolling
                    // Brackets & pairs
                    bracketPairColorization: { enabled: true },
                    guides: { bracketPairs: true, bracketPairsHorizontal: true, indentation: true, highlightActiveIndentation: true },
                    matchBrackets: "always",
                    autoClosingBrackets: "always",
                    autoClosingQuotes: "always",
                    autoClosingDelete: "always",
                    autoSurround: "languageDefined",
                    linkedEditing: true,                   // Auto-rename matching HTML tags
                    // Code intelligence
                    suggestOnTriggerCharacters: true,
                    quickSuggestions: { other: true, comments: false, strings: true },
                    acceptSuggestionOnEnter: "on",
                    parameterHints: { enabled: true },
                    hover: { enabled: true, delay: 300 },
                    // Code folding
                    folding: true,
                    foldingStrategy: "indentation",
                    showFoldingControls: "mouseover",
                    foldingImportsByDefault: true,
                    // Rendering
                    renderWhitespace: "selection",
                    renderLineHighlight: "all",
                    renderControlCharacters: true,
                    colorDecorators: true,
                    occurrencesHighlight: "singleFile",    // Highlight all instances of selected word
                    selectionHighlight: true,
                    // Formatting
                    formatOnPaste: true,
                    formatOnType: true,
                    trimAutoWhitespace: true,
                    // Line features
                    lineDecorationsWidth: 10,
                    lineNumbersMinChars: 4,
                    glyphMargin: true,                     // Space for breakpoints/icons
                    // Inline hints
                    inlayHints: { enabled: "on" },
                    // Accessibility
                    accessibilitySupport: "auto",
                    // Built-in shortcuts (no config needed):
                    // Ctrl+F: Find | Ctrl+H: Replace | Ctrl+D: Add selection
                    // Ctrl+Shift+L: Select all occurrences | Ctrl+G: Go to line
                    // F1: Command palette | Ctrl+/: Toggle comment
                    // Ctrl+Shift+K: Delete line | Alt+Up/Down: Move line
                    // Ctrl+Shift+[/]: Fold/unfold | Ctrl+Z/Y: Undo/Redo
                  }}
                  onMount={(editor) => {
                    editorInstanceRef.current = editor;

                    // Keep monaco-review for inline comment display
                    try {
                      const rm = createReviewManager(
                        editor, "User", commentEvents,
                        (newEvents: any[]) => setCommentEvents(newEvents),
                        { showInRuler: true, enableMarkdown: true, editButtonAddText: "Comment", editButtonEnableRemove: true },
                      );
                      reviewManagerRef.current = rm;
                    } catch (err) {
                      console.debug("[editor] monaco-review init failed:", err);
                    }

                    // Add "Create Task from Selection" to right-click context menu
                    editor.addAction({
                      id: "kora-create-task-from-selection",
                      label: "\uD83D\uDCCB Create Task from Selection",
                      contextMenuGroupId: "navigation",
                      contextMenuOrder: 0,
                      run: (ed: any) => {
                        const selection = ed.getSelection();
                        const model = ed.getModel();
                        if (!selection || !model) return;

                        const selectedText = model.getValueInRange(selection);
                        const startLine = selection.startLineNumber;
                        const endLine = selection.endLineNumber;
                        const filePath = activeTabPathRef.current || "";
                        const fileName = filePath.split("/").pop() || filePath;

                        if (!selectedText.trim()) {
                          showError("Select some code first, then right-click to create a task.", "No selection");
                          return;
                        }

                        // Open dialog with pre-filled context
                        const lineRange = startLine === endLine ? `L${startLine}` : `L${startLine}-${endLine}`;
                        setTaskDialog({
                          open: true,
                          filePath,
                          startLine,
                          endLine,
                          selectedText: selectedText.slice(0, 1000),
                          title: `Review ${fileName}:${lineRange}`,
                          description: `**File:** \`${filePath}\`\n**Lines:** ${lineRange}\n\n\`\`\`\n${selectedText.slice(0, 500)}\n\`\`\`\n\n`,
                        });
                        setTaskAssignee("");
                        setTaskPriority("P2");
                      },
                    });
                  }}
                />
              ) : (
                <div style={{
                  flex: 1, display: "flex", alignItems: "center", justifyContent: "center",
                  color: "var(--text-muted)", fontSize: 14, height: "100%",
                }}>
                  Select a tab to view
                </div>
              )}
            </div>
          </>
        ) : (
          <div style={{
            flex: 1, display: "flex", alignItems: "center", justifyContent: "center",
            color: "var(--text-muted)", fontSize: 14,
          }}>
            Select a file from the sidebar to edit
          </div>
        )}
      </div>

      {/* Unsaved changes confirmation dialog */}
      <ConfirmDialog
        opened={!!pendingCloseTab}
        onClose={() => {
          if (pendingCloseTab) executeCloseTab(pendingCloseTab, false);
        }}
        onConfirm={() => {
          if (pendingCloseTab) executeCloseTab(pendingCloseTab, true);
        }}
        title="Unsaved Changes"
        message={`Save changes to ${pendingCloseTab ? (openTabs.find(t => t.path === pendingCloseTab)?.path.split("/").pop() || "this file") : "this file"} before closing?`}
        confirmLabel="Save & Close"
        confirmColor="blue"
        cancelLabel="Discard"
      />

      {/* Create Task from Selection dialog */}
      <Modal
        opened={taskDialog.open}
        onClose={() => setTaskDialog(prev => ({ ...prev, open: false }))}
        title="Create Task from Code"
        size="lg"
        centered
        styles={{
          header: { backgroundColor: "var(--bg-secondary)", borderBottom: "1px solid var(--border-color)" },
          body: { backgroundColor: "var(--bg-secondary)" },
          content: { backgroundColor: "var(--bg-secondary)" },
          title: { color: "var(--text-primary)", fontWeight: 600, fontSize: 16 },
          close: { color: "var(--text-secondary)" },
        }}
      >
        <Stack gap="sm">
          {/* Code context preview */}
          <div style={{ backgroundColor: "var(--bg-tertiary)", borderRadius: 6, padding: "8px 12px", border: "1px solid var(--border-color)" }}>
            <Text size="xs" c="dimmed" mb={4}>
              {taskDialog.filePath} : {taskDialog.startLine === taskDialog.endLine ? `Line ${taskDialog.startLine}` : `Lines ${taskDialog.startLine}-${taskDialog.endLine}`}
            </Text>
            <Code block style={{ maxHeight: 120, overflow: "auto", fontSize: 11 }}>
              {taskDialog.selectedText}
            </Code>
          </div>

          <TextInput
            label="Task Title"
            value={taskDialog.title}
            onChange={(e) => setTaskDialog(prev => ({ ...prev, title: e.currentTarget.value }))}
            styles={{ input: { backgroundColor: "var(--bg-tertiary)", borderColor: "var(--border-color)", color: "var(--text-primary)" }, label: { color: "var(--text-secondary)", fontSize: 13 } }}
          />

          <Textarea
            label="Description"
            value={taskDialog.description}
            onChange={(e) => setTaskDialog(prev => ({ ...prev, description: e.currentTarget.value }))}
            autosize
            minRows={3}
            maxRows={8}
            styles={{ input: { backgroundColor: "var(--bg-tertiary)", borderColor: "var(--border-color)", color: "var(--text-primary)", fontSize: 13 }, label: { color: "var(--text-secondary)", fontSize: 13 } }}
          />

          <Select
            label="Assign to"
            placeholder="Unassigned (auto-assign)"
            data={agents.map(a => ({ value: a.id, label: a.name }))}
            value={taskAssignee || null}
            onChange={(v) => setTaskAssignee(v || "")}
            clearable
            styles={{ input: { backgroundColor: "var(--bg-tertiary)", borderColor: "var(--border-color)", color: "var(--text-primary)" }, label: { color: "var(--text-secondary)", fontSize: 13 }, dropdown: { backgroundColor: "var(--bg-secondary)", borderColor: "var(--border-color)" }, option: { color: "var(--text-primary)" } }}
          />

          <div>
            <Text size="xs" c="var(--text-secondary)" mb={6}>Priority</Text>
            <SegmentedControl
              value={taskPriority}
              onChange={setTaskPriority}
              data={[
                { value: "P0", label: "P0 Critical" },
                { value: "P1", label: "P1 High" },
                { value: "P2", label: "P2 Medium" },
                { value: "P3", label: "P3 Low" },
              ]}
              size="xs"
              fullWidth
              styles={{
                root: { backgroundColor: "var(--bg-tertiary)", border: "1px solid var(--border-color)" },
                label: { color: "var(--text-primary)", fontWeight: 500, fontSize: 12, padding: "6px 12px" },
              }}
            />
          </div>

          <Group justify="flex-end" mt="md">
            <Button
              variant="default"
              onClick={() => setTaskDialog(prev => ({ ...prev, open: false }))}
              styles={{ root: { backgroundColor: "var(--bg-tertiary)", borderColor: "var(--border-color)", color: "var(--text-primary)" } }}
            >
              Cancel
            </Button>
            <Button
              loading={creatingTask}
              disabled={!taskDialog.title.trim()}
              onClick={async () => {
                setCreatingTask(true);
                try {
                  const result = await api.createCodeComment(sessionId, {
                    filePath: taskDialog.filePath,
                    startLine: taskDialog.startLine,
                    endLine: taskDialog.endLine,
                    selectedText: taskDialog.selectedText,
                    comment: taskDialog.description,
                    assignedTo: taskAssignee || undefined,
                    createTask: true,
                  });
                  if (result.task) {
                    showSuccess(`Task created: ${result.task.title || taskDialog.title}`);
                  } else {
                    showSuccess("Comment saved");
                  }
                  setTaskDialog(prev => ({ ...prev, open: false }));
                } catch (err: any) {
                  if (err.message?.includes("404")) {
                    // Fallback: create task directly via task API
                    try {
                      await api.createTask(sessionId, {
                        title: taskDialog.title,
                        description: taskDialog.description,
                        assignedTo: taskAssignee || undefined,
                        priority: taskPriority,
                        labels: ["code-review"],
                      });
                      showSuccess(`Task created: ${taskDialog.title}`);
                      setTaskDialog(prev => ({ ...prev, open: false }));
                    } catch (fallbackErr: any) {
                      showError(fallbackErr.message || "Failed to create task", "Task Error");
                    }
                  } else {
                    showError(err.message || "Failed to create task", "Task Error");
                  }
                } finally {
                  setCreatingTask(false);
                }
              }}
              styles={{ root: { backgroundColor: "var(--accent-blue)", borderColor: "var(--accent-blue)" } }}
            >
              Create Task
            </Button>
          </Group>
        </Stack>
      </Modal>
    </div>
  );
}
