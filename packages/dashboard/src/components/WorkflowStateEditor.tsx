/**
 * WorkflowStateEditor — drag-to-reorder pipeline state configurator
 * with templates, per-state transition config, and validation.
 */
import { useState } from "react";
import { MultiSelect } from "@mantine/core";
import {
  DndContext, closestCenter, KeyboardSensor, PointerSensor,
  useSensor, useSensors, type DragEndEvent,
} from "@dnd-kit/core";
import {
  arrayMove, SortableContext, sortableKeyboardCoordinates,
  useSortable, verticalListSortingStrategy,
} from "@dnd-kit/sortable";
import { CSS } from "@dnd-kit/utilities";
import {
  PIPELINE_TEMPLATES,
  autoGenerateTransitions,
  validatePipeline,
  type WorkflowState,
} from "@kora/shared";

interface WorkflowStateEditorProps {
  states: WorkflowState[];
  onChange: (states: any[]) => void;
  compact?: boolean;
}

/* ─── Sortable State Row ─────────────────────────────── */

function SortableStateRow({
  state, index, total, onUpdate, onRemove, compact, onToggleExpand, isExpanded,
}: {
  state: WorkflowState; index: number; total: number;
  onUpdate: (u: Partial<WorkflowState>) => void; onRemove: () => void;
  compact?: boolean; onToggleExpand: () => void; isExpanded: boolean;
}) {
  const { attributes, listeners, setNodeRef, transform, transition, isDragging } = useSortable({ id: state.id });
  const style = { transform: CSS.Transform.toString(transform), transition, opacity: isDragging ? 0.5 : 1, zIndex: isDragging ? 10 : 0 };
  const isFirst = index === 0;
  const isLast = index === total - 1;
  const isMiddle = !isFirst && !isLast;
  const hasCustomTransitions = state.transitions && state.transitions.length > 0;

  return (
    <div ref={setNodeRef} style={{
      ...style, display: "flex", alignItems: "center", gap: compact ? 4 : 6,
      padding: compact ? "4px 8px" : "6px 10px",
      borderRadius: isExpanded ? "6px 6px 0 0" : 6,
      background: "var(--bg-tertiary)", border: `1px solid ${isDragging ? "var(--accent-blue)" : "var(--border-color)"}`,
    }}>
      {/* Drag handle */}
      <button {...attributes} {...listeners} style={{
        cursor: "grab", background: "none", border: "none", padding: "2px",
        color: "var(--text-muted)", display: "flex", flexShrink: 0, touchAction: "none",
      }} title="Drag to reorder">
        <svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor">
          <circle cx="9" cy="5" r="1.5" /><circle cx="15" cy="5" r="1.5" />
          <circle cx="9" cy="12" r="1.5" /><circle cx="15" cy="12" r="1.5" />
          <circle cx="9" cy="19" r="1.5" /><circle cx="15" cy="19" r="1.5" />
        </svg>
      </button>

      {/* Color */}
      <input type="color" value={state.color} onChange={(e) => onUpdate({ color: e.target.value })}
        style={{ width: compact ? 20 : 24, height: compact ? 20 : 24, border: "none", background: "none", cursor: "pointer", padding: 0, flexShrink: 0 }} />

      {/* Name */}
      <input value={state.label} onChange={(e) => {
        const newId = e.target.value.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
        onUpdate({ label: e.target.value, id: newId || state.id });
      }} placeholder="State name" style={{
        flex: 1, fontSize: compact ? 11 : 12, padding: compact ? "3px 6px" : "4px 8px", fontWeight: 600,
        background: "var(--bg-primary)", border: "1px solid var(--border-color)", borderRadius: 4,
        color: "var(--text-primary)", minWidth: 0,
      }} />

      {/* Category */}
      {!compact && (
        <select value={state.category} onChange={(e) => onUpdate({ category: e.target.value as any })}
          style={{ fontSize: 11, padding: "4px 6px", background: "var(--bg-secondary)", border: "1px solid var(--border-color)", borderRadius: 4, color: "var(--text-secondary)", cursor: "pointer" }}>
          <option value="not-started">Not Started</option>
          <option value="active">Active</option>
          <option value="closed">Closed</option>
        </select>
      )}

      {/* Skippable — only middle states */}
      {isMiddle ? (
        <label style={{ fontSize: compact ? 10 : 11, color: "var(--text-muted)", display: "flex", alignItems: "center", gap: 3, whiteSpace: "nowrap", flexShrink: 0 }}>
          <input type="checkbox" checked={state.skippable || false} onChange={(e) => onUpdate({ skippable: e.target.checked })} />
          Skippable
        </label>
      ) : <span style={{ width: compact ? 60 : 70, flexShrink: 0 }} />}

      {/* Expand transitions chevron */}
      <button type="button" onClick={(e) => { e.stopPropagation(); onToggleExpand(); }}
        style={{
          background: "none", border: "none", cursor: "pointer", fontSize: 10, padding: "2px 4px", flexShrink: 0,
          color: isExpanded ? "var(--accent-blue)" : hasCustomTransitions ? "var(--accent-green)" : "var(--text-muted)",
          transform: isExpanded ? "rotate(90deg)" : "rotate(0deg)", transition: "transform 0.15s",
        }} title="Configure transitions">
        &#9654;
      </button>

      {/* Delete — only middle states */}
      {isMiddle && total > 2 ? (
        <button type="button" onClick={onRemove}
          style={{ background: "none", border: "none", color: "var(--accent-red)", cursor: "pointer", fontSize: 14, padding: "0 4px", flexShrink: 0 }}>×</button>
      ) : <span style={{ width: 18, flexShrink: 0 }} />}
    </div>
  );
}

/* ─── Transition Configurator (expandable panel) ─────── */

function TransitionConfigurator({ state, stateIndex, allStates, onUpdate }: {
  state: WorkflowState; stateIndex: number; allStates: WorkflowState[];
  onUpdate: (u: Partial<WorkflowState>) => void;
}) {
  const isLast = stateIndex === allStates.length - 1;
  const options = allStates.filter(s => s.id !== state.id).map(s => ({ value: s.id, label: s.label }));
  const currentTransitions = state.transitions ?? [];

  // What auto-generate would produce
  const autoTransitions = autoGenerateTransitions(allStates)[stateIndex]?.transitions ?? [];
  const isAuto = JSON.stringify([...currentTransitions].sort()) === JSON.stringify([...autoTransitions].sort());

  if (isLast) {
    return (
      <div style={{ padding: "8px 12px 8px 32px", background: "var(--bg-secondary)", borderRadius: "0 0 6px 6px", borderTop: "1px dashed var(--border-color)", fontSize: 12, color: "var(--text-muted)", fontStyle: "italic" }}>
        Terminal state — no outgoing transitions.
      </div>
    );
  }

  return (
    <div style={{ padding: "10px 12px 10px 32px", background: "var(--bg-secondary)", borderRadius: "0 0 6px 6px", borderTop: "1px dashed var(--border-color)", display: "flex", flexDirection: "column", gap: 8 }}>
      <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
        <span style={{ fontSize: 12, fontWeight: 600, color: "var(--text-secondary)" }}>Allowed next states</span>
        <span style={{
          fontSize: 10, padding: "1px 6px", borderRadius: 3, fontWeight: 600,
          background: isAuto ? "rgba(63,185,80,0.15)" : "rgba(210,153,34,0.15)",
          color: isAuto ? "var(--accent-green)" : "var(--accent-yellow)",
        }}>
          {isAuto ? "Auto" : "Custom"}
        </span>
        {!isAuto && (
          <button type="button" onClick={() => onUpdate({ transitions: [...autoTransitions] })}
            style={{ fontSize: 11, color: "var(--accent-blue)", background: "none", border: "none", cursor: "pointer", textDecoration: "underline", padding: 0 }}>
            Reset to auto
          </button>
        )}
      </div>
      <MultiSelect
        data={options} value={currentTransitions}
        onChange={(value) => onUpdate({ transitions: value })}
        placeholder="Select allowed transitions..." searchable size="xs"
        styles={{
          input: { background: "var(--bg-primary)", borderColor: "var(--border-color)", color: "var(--text-primary)", minHeight: 32 },
          pill: { background: "var(--bg-tertiary)", color: "var(--text-primary)" },
        }}
      />
      <div style={{ fontSize: 11, color: "var(--text-muted)" }}>
        {currentTransitions.length === 0
          ? "No transitions = free movement to any state."
          : `${state.label} → ${currentTransitions.map(id => allStates.find(s => s.id === id)?.label ?? id).join(", ")}`}
      </div>
    </div>
  );
}

/* ─── Main Editor ─────────────────────────────────────── */

export function WorkflowStateEditor({ states, onChange, compact }: WorkflowStateEditorProps) {
  const [expandedStateId, setExpandedStateId] = useState<string | null>(null);

  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 5 } }),
    useSensor(KeyboardSensor, { coordinateGetter: sortableKeyboardCoordinates }),
  );

  function handleDragEnd(event: DragEndEvent) {
    const { active, over } = event;
    if (!over || active.id === over.id) return;
    const oldIndex = states.findIndex(s => s.id === active.id);
    const newIndex = states.findIndex(s => s.id === over.id);
    onChange(arrayMove(states, oldIndex, newIndex));
  }

  function updateState(index: number, updates: Partial<WorkflowState>) {
    const updated = [...states];
    updated[index] = { ...updated[index], ...updates };
    onChange(updated);
  }

  function removeState(index: number) { onChange(states.filter((_, i) => i !== index)); }

  function addState() {
    const id = `state-${Date.now()}`;
    const insertIdx = states.length > 0 ? states.length - 1 : 0;
    const updated = [...states];
    updated.splice(insertIdx, 0, { id, label: "New State", color: "#8b5cf6", category: "active" as const, transitions: [], skippable: false });
    onChange(updated);
  }

  const validation = validatePipeline(states);

  return (
    <div>
      {/* Template selector */}
      <div style={{ display: "flex", gap: 6, marginBottom: 10, flexWrap: "wrap" }}>
        {PIPELINE_TEMPLATES.map(t => (
          <button key={t.id} type="button" onClick={() => {
            if (t.id === "custom") {
              onChange([
                { id: "pending", label: "Pending", color: "#6b7280", category: "not-started" as const },
                { id: "done", label: "Done", color: "#22c55e", category: "closed" as const },
              ]);
            } else { onChange(t.states); }
            setExpandedStateId(null);
          }} style={{
            fontSize: 11, padding: "5px 12px", borderRadius: 6,
            border: "1px solid var(--border-color)", background: "var(--bg-tertiary)",
            color: "var(--text-secondary)", cursor: "pointer", display: "flex", alignItems: "center", gap: 4,
          }} title={t.description}>
            <span>{t.icon}</span> {t.name}
          </button>
        ))}
      </div>

      {/* Header */}
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 6 }}>
        <span style={{ fontSize: compact ? 12 : 13, fontWeight: 600, color: "var(--text-primary)" }}>Task Pipeline</span>
        <button type="button" onClick={addState} style={{
          fontSize: 11, padding: "3px 10px", background: "var(--accent-blue)",
          border: "none", borderRadius: 4, color: "white", cursor: "pointer",
        }}>+ Add State</button>
      </div>
      <div style={{ fontSize: 11, color: "var(--text-muted)", marginBottom: 8 }}>
        Drag to reorder. Click &#9654; to configure transitions. States are frozen after session creation.
      </div>

      {/* Sortable state list */}
      <DndContext sensors={sensors} collisionDetection={closestCenter} onDragEnd={handleDragEnd}>
        <SortableContext items={states.map(s => s.id)} strategy={verticalListSortingStrategy}>
          <div style={{ display: "flex", flexDirection: "column", gap: compact ? 0 : 0 }}>
            {states.map((state, i) => (
              <div key={state.id} style={{ marginBottom: expandedStateId === state.id ? 0 : (compact ? 4 : 6) }}>
                <SortableStateRow
                  state={state} index={i} total={states.length}
                  onUpdate={(u) => updateState(i, u)} onRemove={() => removeState(i)}
                  compact={compact}
                  onToggleExpand={() => setExpandedStateId(expandedStateId === state.id ? null : state.id)}
                  isExpanded={expandedStateId === state.id}
                />
                {expandedStateId === state.id && (
                  <TransitionConfigurator state={state} stateIndex={i} allStates={states} onUpdate={(u) => updateState(i, u)} />
                )}
              </div>
            ))}
          </div>
        </SortableContext>
      </DndContext>

      {/* Pipeline preview */}
      <div style={{ fontSize: 11, color: "var(--text-muted)", marginTop: 8 }}>
        Pipeline: {states.map(s => s.skippable ? `${s.label}?` : s.label).join(" → ")}
      </div>

      {/* Validation */}
      {!validation.valid && (
        <div style={{ marginTop: 6, padding: "6px 10px", background: "rgba(248,81,73,0.1)", border: "1px solid rgba(248,81,73,0.3)", borderRadius: 4, fontSize: 11, color: "var(--accent-red)" }}>
          {validation.errors.map((e, i) => <div key={i}>{"\u26A0"} {e}</div>)}
        </div>
      )}
      {validation.warnings.length > 0 && (
        <div style={{ marginTop: 4, fontSize: 11, color: "var(--accent-yellow)" }}>
          {validation.warnings.map((w, i) => <div key={i}>{"\u26A0"} {w}</div>)}
        </div>
      )}

      {/* Hint */}
      <div style={{ fontSize: 10, color: "var(--text-muted)", marginTop: 4, fontStyle: "italic" }}>
        Skippable: Tasks can skip this state. Click &#9654; on any state to customize its allowed transitions.
      </div>
    </div>
  );
}
