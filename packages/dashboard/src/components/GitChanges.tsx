import { useState, useEffect, useCallback } from "react";
import { DiffEditor } from "@monaco-editor/react";
import { useApi } from "../hooks/useApi";
import { useThemeStore } from "../stores/themeStore";

interface GitChangesProps {
  sessionId: string;
}

interface Change {
  status: string;
  file: string;
  statusLabel: string;
  repo: string;
}

interface RepoInfo {
  name: string;
  branch: string;
  changes: Change[];
}

function detectLanguage(filePath: string): string {
  const ext = filePath.split(".").pop()?.toLowerCase() || "";
  const map: Record<string, string> = {
    ts: "typescript",
    tsx: "typescript",
    js: "javascript",
    jsx: "javascript",
    json: "json",
    md: "markdown",
    css: "css",
    html: "html",
    rs: "rust",
    py: "python",
    go: "go",
    yaml: "yaml",
    yml: "yaml",
    toml: "toml",
    sh: "shell",
    bash: "shell",
    swift: "swift",
  };
  return map[ext] || "plaintext";
}

export function GitChanges({ sessionId }: GitChangesProps) {
  const api = useApi();
  const { resolvedEditorTheme } = useThemeStore();
  const [repos, setRepos] = useState<RepoInfo[]>([]);
  const [selectedFile, setSelectedFile] = useState<string | null>(null);
  const [selectedRepo, setSelectedRepo] = useState<string>(".");
  const [originalContent, setOriginalContent] = useState("");
  const [modifiedContent, setModifiedContent] = useState("");
  const [loading, setLoading] = useState(true);
  const [collapsedRepos, setCollapsedRepos] = useState<Set<string>>(new Set());

  const totalChanges = repos.reduce((sum, r) => sum + r.changes.length, 0);
  const isMultiRepo = repos.length > 1;

  const loadStatus = useCallback(async () => {
    try {
      const data = await api.getGitStatus(sessionId);
      if (data.repos && data.repos.length > 0) {
        setRepos(data.repos);
      } else {
        // Fallback: wrap single-repo response
        setRepos([{ name: ".", branch: data.branch, changes: data.changes.map((c: any) => ({ ...c, repo: "." })) }]);
      }
    } catch {
      // ignore
    } finally {
      setLoading(false);
    }
  }, [sessionId]);

  useEffect(() => {
    loadStatus();
  }, [loadStatus]);

  useEffect(() => {
    const interval = setInterval(loadStatus, 10000);
    return () => clearInterval(interval);
  }, [loadStatus]);

  async function handleSelectFile(filePath: string, repo: string) {
    setSelectedFile(filePath);
    setSelectedRepo(repo);
    try {
      const data = await api.getGitDiff(sessionId, filePath, repo);
      setOriginalContent(data.original || "");
      setModifiedContent(data.modified || "");
    } catch {
      setOriginalContent("");
      setModifiedContent("Could not load file content");
    }
  }

  function toggleRepoCollapse(repoName: string) {
    setCollapsedRepos(prev => {
      const next = new Set(prev);
      if (next.has(repoName)) next.delete(repoName);
      else next.add(repoName);
      return next;
    });
  }

  const statusColors: Record<string, string> = {
    M: "var(--accent-yellow)",
    A: "var(--accent-green)",
    D: "var(--accent-red)",
    "??": "var(--text-muted)",
    R: "var(--accent-purple)",
  };

  function renderChangeItem(change: Change) {
    const isSelected = selectedFile === change.file && selectedRepo === change.repo;
    return (
      <div
        key={`${change.repo}:${change.file}`}
        onClick={() => handleSelectFile(change.file, change.repo)}
        style={{
          padding: "4px 12px",
          paddingLeft: isMultiRepo ? 24 : 12,
          cursor: "pointer",
          fontSize: 12,
          display: "flex",
          alignItems: "center",
          gap: 8,
          background: isSelected ? "var(--bg-tertiary)" : "transparent",
          color: "var(--text-primary)",
        }}
        onMouseEnter={(e) => { if (!isSelected) e.currentTarget.style.background = "var(--bg-secondary)"; }}
        onMouseLeave={(e) => { if (!isSelected) e.currentTarget.style.background = "transparent"; }}
      >
        <span
          style={{
            color: statusColors[change.status] || "var(--text-muted)",
            fontWeight: 600,
            fontSize: 11,
            minWidth: 14,
            textAlign: "center",
          }}
        >
          {change.status}
        </span>
        <span style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
          {isMultiRepo ? change.file.replace(`${change.repo}/`, "") : change.file}
        </span>
      </div>
    );
  }

  return (
    <div style={{ display: "flex", height: "100%", background: "var(--bg-primary)" }}>
      {/* Changed files sidebar */}
      <div style={{ width: 280, borderRight: "1px solid var(--border-color)", overflowY: "auto" }}>
        {/* Summary header */}
        <div style={{ padding: "8px 12px", borderBottom: "1px solid var(--border-color)", fontSize: 12 }}>
          <span style={{ color: "var(--text-secondary)" }}>
            {isMultiRepo ? `${repos.length} repos` : `Branch: `}
          </span>
          {!isMultiRepo && repos[0] && (
            <span style={{ color: "var(--accent-blue)", fontWeight: 600 }}>{repos[0].branch || "unknown"}</span>
          )}
          <span style={{ color: "var(--text-secondary)", marginLeft: 8 }}>{totalChanges} changes</span>
        </div>

        {loading ? (
          <div style={{ padding: 16, color: "var(--text-muted)" }}>Loading...</div>
        ) : totalChanges === 0 ? (
          <div style={{ padding: 16, color: "var(--text-muted)", textAlign: "center" }}>
            No changes detected
          </div>
        ) : isMultiRepo ? (
          // Multi-repo: group by repo with collapsible headers
          repos.map((repo) => {
            if (repo.changes.length === 0) return null;
            const isCollapsed = collapsedRepos.has(repo.name);
            return (
              <div key={repo.name}>
                <div
                  onClick={() => toggleRepoCollapse(repo.name)}
                  style={{
                    padding: "6px 12px",
                    fontSize: 12,
                    fontWeight: 600,
                    cursor: "pointer",
                    display: "flex",
                    alignItems: "center",
                    gap: 6,
                    background: "var(--bg-secondary)",
                    borderBottom: "1px solid var(--border-color)",
                    color: "var(--text-primary)",
                  }}
                >
                  <span style={{ fontSize: 10, color: "var(--text-muted)" }}>
                    {isCollapsed ? "\u25B6" : "\u25BC"}
                  </span>
                  <span style={{ flex: 1, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                    {repo.name === "." ? "Root" : repo.name}
                  </span>
                  <span style={{ color: "var(--accent-blue)", fontWeight: 500, fontSize: 11 }}>
                    {repo.branch}
                  </span>
                  <span style={{
                    background: "var(--bg-tertiary)",
                    borderRadius: 10,
                    padding: "0 6px",
                    fontSize: 10,
                    color: "var(--text-muted)",
                  }}>
                    {repo.changes.length}
                  </span>
                </div>
                {!isCollapsed && repo.changes.map(renderChangeItem)}
              </div>
            );
          })
        ) : (
          // Single repo: flat list
          repos[0]?.changes.map(renderChangeItem)
        )}
      </div>

      {/* Diff viewer */}
      <div style={{ flex: 1, display: "flex", flexDirection: "column" }}>
        {selectedFile ? (
          <>
            <div
              style={{
                padding: "6px 12px",
                background: "var(--bg-secondary)",
                borderBottom: "1px solid var(--border-color)",
                fontSize: 12,
                color: "var(--text-primary)",
                display: "flex",
                gap: 8,
                alignItems: "center",
              }}
            >
              {isMultiRepo && selectedRepo !== "." && (
                <span style={{
                  background: "var(--bg-tertiary)",
                  borderRadius: 4,
                  padding: "1px 6px",
                  fontSize: 10,
                  color: "var(--accent-blue)",
                  fontWeight: 600,
                }}>
                  {selectedRepo}
                </span>
              )}
              <span>{selectedFile}</span>
            </div>
            <div style={{ flex: 1, minHeight: 0 }}>
              <DiffEditor
                height="100%"
                original={originalContent}
                modified={modifiedContent}
                language={detectLanguage(selectedFile)}
                theme={resolvedEditorTheme}
                options={{
                  readOnly: true,
                  renderSideBySide: true,
                  minimap: { enabled: false },
                  fontSize: 13,
                  scrollBeyondLastLine: false,
                  fontFamily: "'JetBrains Mono', 'Fira Code', monospace",
                }}
              />
            </div>
          </>
        ) : (
          <div
            style={{
              flex: 1,
              display: "flex",
              alignItems: "center",
              justifyContent: "center",
              color: "var(--text-muted)",
            }}
          >
            Select a file to view changes
          </div>
        )}
      </div>
    </div>
  );
}
