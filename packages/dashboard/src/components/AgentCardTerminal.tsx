import { useEffect, useState, useRef } from "react";
import { useApi } from "../hooks/useApi";

export type AgentActivity =
  | "working"
  | "idle"
  | "reading"
  | "writing"
  | "running-command"
  | "crashed"
  | "stopped";

interface AgentCardTerminalProps {
  sessionId: string;
  agentId: string;
  agentStatus?: string;
  onActivityDetected?: (activity: AgentActivity) => void;
}

function detectActivity(output: string, agentStatus?: string): AgentActivity {
  if (agentStatus === "crashed") return "crashed";
  if (agentStatus === "stopped") return "stopped";

  const lines = output.split("\n").filter((l) => l.trim()).slice(-5);
  const lastLine = lines[lines.length - 1] || "";

  if (
    lastLine.includes("\u276F") ||
    lastLine.includes("> ") ||
    lastLine.endsWith("% ") ||
    lastLine.endsWith("$ ")
  )
    return "idle";
  if (output.includes("Reading") || output.includes("Searching") || output.includes("Grep"))
    return "reading";
  if (output.includes("Writing") || output.includes("Editing") || output.includes("Edit"))
    return "writing";
  if (output.includes("Running") || output.includes("Bash") || output.includes("executing"))
    return "running-command";
  return "working";
}

export function AgentCardTerminal({
  sessionId,
  agentId,
  agentStatus,
  onActivityDetected,
}: AgentCardTerminalProps) {
  const api = useApi();
  const [lines, setLines] = useState<string[]>([]);
  const containerRef = useRef<HTMLDivElement>(null);
  const prevOutputRef = useRef<string>("");

  const isInactive = agentStatus === "crashed" || agentStatus === "stopped";

  useEffect(() => {
    if (isInactive) {
      const activity = agentStatus === "crashed" ? "crashed" : "stopped";
      onActivityDetected?.(activity);
      return;
    }

    let cancelled = false;

    async function poll() {
      try {
        const data = await api.getOutput(sessionId, agentId, 15);
        if (!cancelled) {
          const outputLines: string[] = data.output || [];
          const outputKey = outputLines.join("\n");

          // Only update state if output actually changed
          if (outputKey !== prevOutputRef.current) {
            prevOutputRef.current = outputKey;
            setLines(outputLines);
          }

          const activity = detectActivity(outputKey, agentStatus);
          onActivityDetected?.(activity);
        }
      } catch {
        // ignore polling errors
      }
    }

    poll();
    const interval = setInterval(poll, 5000);

    return () => {
      cancelled = true;
      clearInterval(interval);
    };
  }, [sessionId, agentId, isInactive, agentStatus]);

  // Strip ANSI escape codes for plain text display
  function stripAnsi(text: string): string {
    return text.replace(/\x1b\[[0-9;]*m/g, "");
  }

  return (
    <div
      ref={containerRef}
      className="agent-terminal-preview"
    >
      {isInactive ? (
        <span style={{ color: agentStatus === "crashed" ? "#f85149" : "#484f58" }}>
          Agent is {agentStatus}. Click Restart to revive.
        </span>
      ) : lines.length === 0 ? (
        <span style={{ color: "#484f58" }}>No output yet</span>
      ) : (
        lines.map((line, i) => (
          <div key={i} style={{ whiteSpace: "pre", overflow: "hidden", textOverflow: "ellipsis" }}>
            {stripAnsi(line)}
          </div>
        ))
      )}
    </div>
  );
}
