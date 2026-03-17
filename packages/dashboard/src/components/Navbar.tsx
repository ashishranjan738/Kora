import { Link, useNavigate, useLocation } from "react-router-dom";
import { useSessionStore } from "../stores/sessionStore";
import { useThemeStore } from "../stores/themeStore";
import { useEffect, useCallback } from "react";
import { useWebSocket } from "../hooks/useWebSocket";

export function Navbar() {
  const { sessions, fetchSessions } = useSessionStore();
  const { resolved, setMode, mode } = useThemeStore();
  const navigate = useNavigate();
  const location = useLocation();

  // Derive selected session from URL path
  const pathMatch = location.pathname.match(/^\/session\/([^/]+)/);
  const selectedSession = pathMatch ? pathMatch[1] : "";

  const handleWsEvent = useCallback((event: any) => {
    // Handle real-time updates if needed
    if (event.type === "session_created" || event.type === "session_removed") {
      fetchSessions();
    }
  }, [fetchSessions]);

  const { connected } = useWebSocket(handleWsEvent);

  useEffect(() => {
    fetchSessions();
  }, [fetchSessions]);

  function onSessionChange(e: React.ChangeEvent<HTMLSelectElement>) {
    const val = e.target.value;
    if (val) {
      navigate(`/session/${val}`);
    } else {
      navigate("/");
    }
  }

  return (
    <nav
      style={{
        display: "flex",
        alignItems: "center",
        justifyContent: "space-between",
        padding: "12px 24px",
        backgroundColor: "var(--bg-secondary)",
        borderBottom: "1px solid var(--border-color)",
      }}
    >
      <div style={{ display: "flex", alignItems: "center", gap: 16 }}>
        <Link
          to="/"
          style={{
            fontSize: 18,
            fontWeight: 600,
            color: "var(--text-primary)",
            textDecoration: "none",
          }}
        >
          Kora
        </Link>

        <select
          value={selectedSession}
          onChange={onSessionChange}
          style={{ minWidth: 180 }}
        >
          <option value="">Select session...</option>
          {sessions.map((s) => (
            <option key={s.id} value={s.id}>
              {s.name || s.id}
            </option>
          ))}
        </select>
      </div>

      <div style={{ display: "flex", alignItems: "center", gap: 16 }}>
        <span style={{ display: "flex", alignItems: "center", gap: 6, fontSize: 13 }}>
          <span
            className={`status-dot ${connected ? "green" : "red"}`}
          />
          {connected ? "Connected" : "Disconnected"}
        </span>
        <button
          onClick={() => {
            // Cycle: system -> dark -> light -> system
            const next = mode === "system" ? "dark" : mode === "dark" ? "light" : "system";
            setMode(next);
          }}
          title={`Theme: ${mode} (${resolved})`}
          style={{
            background: "none",
            border: "1px solid var(--border-color)",
            borderRadius: 6,
            padding: "4px 8px",
            cursor: "pointer",
            fontSize: 16,
            lineHeight: 1,
            color: "var(--text-secondary)",
          }}
        >
          {resolved === "dark" ? "\u263E" : "\u2600"}
        </button>
        <Link to="/settings">Settings</Link>
      </div>
    </nav>
  );
}
