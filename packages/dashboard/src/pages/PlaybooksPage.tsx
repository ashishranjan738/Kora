import { useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { useApi } from "../hooks/useApi";
import { PlaybookGrid } from "../components/playbook/PlaybookGrid";

export function PlaybooksPage() {
  const api = useApi();
  const [playbooks, setPlaybooks] = useState<any[]>([]);
  const [loading, setLoading] = useState(true);
  const [selected, setSelected] = useState<any>(null);

  useEffect(() => {
    async function load() {
      try {
        const data = await api.getPlaybooks();
        // getPlaybooks returns { playbooks: string[] } (names only)
        // Fetch details for each
        const details = await Promise.all(
          (data.playbooks || []).map(async (name: string) => {
            try {
              const detail = await api.getPlaybook(name);
              return { ...detail, name };
            } catch {
              return { name, agents: [] };
            }
          })
        );
        setPlaybooks(details);
      } catch {
        // ignore
      } finally {
        setLoading(false);
      }
    }
    load();
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  return (
    <div className="page">
      <nav className="breadcrumb">
        <Link to="/">All Sessions</Link>
        <span className="separator">/</span>
        <span style={{ color: "var(--text-primary)" }}>Playbooks</span>
      </nav>

      <h1 style={{ fontSize: 24, fontWeight: 700, marginBottom: 16 }}>Playbooks</h1>

      <PlaybookGrid
        playbooks={playbooks}
        selectedPlaybook={selected}
        onSelectPlaybook={setSelected}
        loading={loading}
      />
    </div>
  );
}
