import { useEffect, useState } from "react";
import { useApi } from "../hooks/useApi";
import { useThemeStore } from "../stores/themeStore";
import { formatUptimeSeconds } from "../utils/formatters";

export function SettingsPage() {
  const api = useApi();
  const [status, setStatus] = useState<any>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const { mode, setMode, editorTheme, setEditorTheme, terminalTheme, setTerminalTheme } = useThemeStore();

  useEffect(() => {
    loadStatus();
  }, []);

  async function loadStatus() {
    setLoading(true);
    try {
      const data = await api.getStatus();
      setStatus(data);
      setError(null);
    } catch (err: any) {
      setError(err.message);
    } finally {
      setLoading(false);
    }
  }

  return (
    <div className="page">
      <div className="page-header">
        <h1>Settings</h1>
        <button onClick={loadStatus}>Refresh</button>
      </div>

      <div className="card" style={{ marginBottom: 20 }}>
        <h2 style={{ fontSize: 18, marginBottom: 16 }}>Theme</h2>
        <div style={{ display: "flex", flexDirection: "column", gap: 16 }}>
          <div style={{ display: "flex", alignItems: "center", gap: 12 }}>
            <label style={{ color: "var(--text-secondary)", fontSize: 14, minWidth: 100 }}>
              Appearance:
            </label>
            <select
              value={mode}
              onChange={(e) => setMode(e.target.value as "light" | "dark" | "system")}
              style={{
                minWidth: 200,
                padding: "6px 8px",
                borderRadius: 4,
                border: "1px solid var(--border-color)",
                backgroundColor: "var(--bg-secondary)",
                color: "var(--text-primary)",
              }}
            >
              <option value="system">System (auto)</option>
              <option value="dark">Dark</option>
              <option value="light">Light</option>
            </select>
          </div>
          <div style={{ display: "flex", alignItems: "center", gap: 12 }}>
            <label style={{ color: "var(--text-secondary)", fontSize: 14, minWidth: 100 }}>
              Editor Theme:
            </label>
            <select
              value={editorTheme}
              onChange={(e) => setEditorTheme(e.target.value as "auto" | "vs-dark" | "vs" | "hc-black")}
              style={{
                minWidth: 200,
                padding: "6px 8px",
                borderRadius: 4,
                border: "1px solid var(--border-color)",
                backgroundColor: "var(--bg-secondary)",
                color: "var(--text-primary)",
              }}
            >
              <option value="auto">Auto (follows app theme)</option>
              <option value="vs-dark">Dark (vs-dark)</option>
              <option value="vs">Light (vs)</option>
              <option value="hc-black">High Contrast</option>
            </select>
          </div>
          <div style={{ display: "flex", alignItems: "center", gap: 12 }}>
            <label style={{ color: "var(--text-secondary)", fontSize: 14, minWidth: 100 }}>
              Terminal Theme:
            </label>
            <select
              value={terminalTheme}
              onChange={(e) => setTerminalTheme(e.target.value as "auto" | "dark" | "light")}
              style={{
                minWidth: 200,
                padding: "6px 8px",
                borderRadius: 4,
                border: "1px solid var(--border-color)",
                backgroundColor: "var(--bg-secondary)",
                color: "var(--text-primary)",
              }}
            >
              <option value="auto">Auto (follows app theme)</option>
              <option value="dark">Dark</option>
              <option value="light">Light</option>
            </select>
          </div>
        </div>
      </div>

      {loading && (
        <p style={{ color: "var(--text-secondary)" }}>Loading status...</p>
      )}

      {error && (
        <div className="card" style={{ borderColor: "var(--accent-red)" }}>
          <p style={{ color: "var(--accent-red)" }}>
            Failed to connect to daemon: {error}
          </p>
        </div>
      )}

      {status && (
        <div className="card">
          <h2 style={{ fontSize: 18, marginBottom: 16 }}>Daemon Status</h2>
          <table style={{ width: "100%", borderCollapse: "collapse" }}>
            <tbody>
              {[
                ["Version", status.version || "N/A"],
                [
                  "Uptime",
                  status.uptime ? formatUptimeSeconds(status.uptime) : "N/A",
                ],
                ["Port", status.port || "N/A"],
                ["Status", status.status || "running"],
              ].map(([label, value]) => (
                <tr
                  key={label}
                  style={{ borderBottom: "1px solid var(--border-color)" }}
                >
                  <td
                    style={{
                      padding: "8px 0",
                      color: "var(--text-secondary)",
                      width: 150,
                    }}
                  >
                    {label}
                  </td>
                  <td style={{ padding: "8px 0" }}>{value}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
