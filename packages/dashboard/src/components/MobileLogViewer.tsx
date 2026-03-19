import { useEffect, useState, useRef } from "react";
import { useApi } from "../hooks/useApi";

interface MobileLogViewerProps {
  sessionId: string;
  agentId: string;
  maxLines?: number;
}

/**
 * Read-only log viewer for mobile (<768px). Replaces xterm.js terminal
 * with a simple scrollable text view showing last N lines of agent output.
 * Polls agent terminal output every 3 seconds.
 */
export function MobileLogViewer({ sessionId, agentId, maxLines = 100 }: MobileLogViewerProps) {
  const api = useApi();
  const [lines, setLines] = useState<string[]>([]);
  const [loading, setLoading] = useState(true);
  const containerRef = useRef<HTMLDivElement>(null);
  const autoScrollRef = useRef(true);

  useEffect(() => {
    let cancelled = false;

    async function fetchOutput() {
      try {
        const data = await api.getAgentOutput(sessionId, agentId, maxLines);
        if (!cancelled && data?.output) {
          setLines(data.output.slice(-maxLines));
        }
      } catch {
        // Silently ignore — agent may not be running
      } finally {
        if (!cancelled) setLoading(false);
      }
    }

    fetchOutput();
    const interval = setInterval(fetchOutput, 3000);
    return () => { cancelled = true; clearInterval(interval); };
  }, [sessionId, agentId, maxLines, api]);

  // Auto-scroll to bottom when new lines arrive
  useEffect(() => {
    if (autoScrollRef.current && containerRef.current) {
      containerRef.current.scrollTop = containerRef.current.scrollHeight;
    }
  }, [lines]);

  // Detect if user scrolled up (disable auto-scroll)
  function handleScroll() {
    if (!containerRef.current) return;
    const { scrollTop, scrollHeight, clientHeight } = containerRef.current;
    autoScrollRef.current = scrollHeight - scrollTop - clientHeight < 50;
  }

  // Strip ANSI escape codes for clean display
  function stripAnsi(text: string): string {
    return text.replace(/\x1b\[[0-9;]*[a-zA-Z]/g, "").replace(/\x1b\][^\x07]*\x07/g, "");
  }

  return (
    <div className="mobile-log-viewer" ref={containerRef} onScroll={handleScroll}>
      {loading && (
        <div className="mobile-log-loading">Loading output...</div>
      )}
      {!loading && lines.length === 0 && (
        <div className="mobile-log-empty">No output yet</div>
      )}
      {lines.map((line, i) => (
        <div key={i} className="mobile-log-line">
          {stripAnsi(line) || "\u00A0"}
        </div>
      ))}
    </div>
  );
}
