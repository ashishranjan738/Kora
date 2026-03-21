/**
 * PipelinePreview — visual flow diagram showing states and transitions.
 * CSS-based with SVG arrows. No external dependencies.
 */
import type { WorkflowState } from "@kora/shared";

interface PipelinePreviewProps {
  states: WorkflowState[];
}

export function PipelinePreview({ states }: PipelinePreviewProps) {
  if (states.length === 0) return null;

  // Build adjacency: which states can each state go to?
  const forwardEdges: Array<{ from: number; to: number; type: "forward" | "skip" | "backward" }> = [];

  states.forEach((state, i) => {
    if (!state.transitions?.length) return;
    state.transitions.forEach(targetId => {
      const targetIdx = states.findIndex(s => s.id === targetId);
      if (targetIdx < 0) return;
      if (targetIdx === i + 1) {
        forwardEdges.push({ from: i, to: targetIdx, type: "forward" });
      } else if (targetIdx > i + 1) {
        forwardEdges.push({ from: i, to: targetIdx, type: "skip" });
      } else if (targetIdx < i) {
        forwardEdges.push({ from: i, to: targetIdx, type: "backward" });
      }
    });
  });

  return (
    <div style={{ marginTop: 8, padding: "8px 0" }}>
      {/* Main flow — horizontal boxes with arrows */}
      <div style={{ display: "flex", alignItems: "center", gap: 0, overflowX: "auto", paddingBottom: 8 }}>
        {states.map((state, i) => (
          <div key={state.id} style={{ display: "flex", alignItems: "center", flexShrink: 0 }}>
            {/* State box */}
            <div style={{
              padding: "4px 10px", borderRadius: 6, fontSize: 11, fontWeight: 600,
              border: `2px solid ${state.color}`,
              background: `${state.color}22`,
              color: "var(--text-primary)",
              whiteSpace: "nowrap",
              position: "relative",
            }}>
              {state.label}
              {state.skippable && (
                <span style={{ fontSize: 9, color: "var(--text-muted)", marginLeft: 2 }}>?</span>
              )}
            </div>
            {/* Arrow to next state */}
            {i < states.length - 1 && (
              <svg width="24" height="12" viewBox="0 0 24 12" style={{ flexShrink: 0 }}>
                <line x1="0" y1="6" x2="18" y2="6" stroke="var(--text-muted)" strokeWidth="1.5" />
                <polygon points="18,2 24,6 18,10" fill="var(--text-muted)" />
              </svg>
            )}
          </div>
        ))}
      </div>

      {/* Transition summary — show non-linear transitions */}
      {(forwardEdges.filter(e => e.type !== "forward").length > 0) && (
        <div style={{ fontSize: 10, color: "var(--text-muted)", marginTop: 4, display: "flex", flexDirection: "column", gap: 2 }}>
          {forwardEdges.filter(e => e.type === "skip").map((edge, i) => (
            <span key={`skip-${i}`} style={{ color: "var(--accent-purple)" }}>
              ↷ {states[edge.from].label} can skip to {states[edge.to].label}
            </span>
          ))}
          {forwardEdges.filter(e => e.type === "backward").map((edge, i) => (
            <span key={`back-${i}`} style={{ color: "var(--accent-yellow)" }}>
              ↶ {states[edge.from].label} can return to {states[edge.to].label}
            </span>
          ))}
        </div>
      )}
    </div>
  );
}
