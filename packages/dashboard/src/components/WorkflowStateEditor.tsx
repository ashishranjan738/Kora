/**
 * WorkflowStateEditor — drag-to-reorder pipeline state configurator
 * with templates, per-state transition config, and validation.
 */
import { useState } from "react";
import { MultiSelect, Select } from "@mantine/core";
import { PipelinePreview } from "./PipelinePreview";
import { MarkdownText } from "./MarkdownText";
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

interface AgentOption {
  id: string;
  name: string;
}

interface WorkflowStateEditorProps {
  states: WorkflowState[];
  onChange: (states: any[]) => void;
  compact?: boolean;
  agents?: AgentOption[];
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

      {/* Name — ID only updates on blur to prevent transition reference breakage while typing */}
      <input value={state.label}
        onChange={(e) => onUpdate({ label: e.target.value })}
        onBlur={(e) => {
          const newId = e.target.value.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
          if (newId && newId !== state.id) onUpdate({ id: newId });
        }}
        placeholder="State name" style={{
        flex: 1, fontSize: compact ? 11 : 12, padding: compact ? "3px 6px" : "4px 8px", fontWeight: 600,
        background: "var(--bg-primary)", border: "1px solid var(--border-color)", borderRadius: 4,
        color: "var(--text-primary)", minWidth: 0,
      }} />
      {/* Instructions preview or warning */}
      {!isExpanded && !compact && (
        state.instructions ? (
          <span style={{ fontSize: 10, color: "var(--text-muted)", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", maxWidth: 150, flexShrink: 1 }}
            title={state.instructions}>
            {state.instructions.slice(0, 30)}{state.instructions.length > 30 ? "..." : ""}
          </span>
        ) : state.category === "active" ? (
          <span style={{ fontSize: 10, color: "var(--accent-yellow)", display: "inline-flex", alignItems: "center", gap: 3 }}
            title="No runbook instructions — agents won't get guidance for this state">
            &#9888; No instructions
          </span>
        ) : null
      )}

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

/* ─── Runbook Editor ───────────────────────────────────── */

const RUNBOOK_PLACEHOLDER = `1. Review the code changes for correctness
2. Check test coverage — ensure new code has unit tests
3. Verify no regressions in existing tests
4. Approve or request changes with specific feedback`;

const RUNBOOK_VARIABLES = [
  { name: "{agent.name}", desc: "Name of the assigned agent" },
  { name: "{task.title}", desc: "Title of the current task" },
  { name: "{task.id}", desc: "ID of the current task" },
  { name: "{newState.label}", desc: "Current workflow state name" },
  { name: "{oldState.label}", desc: "Previous workflow state" },
  { name: "{baseBranch}", desc: "Base git branch (e.g. main)" },
];

function RunbookEditor({ value, onChange, stateLabel, routeTo, onRouteToChange, agents }: {
  value: string;
  onChange: (v: string) => void;
  stateLabel: string;
  routeTo?: string;
  onRouteToChange: (v: string | undefined) => void;
  agents?: AgentOption[];
}) {
  const [previewMode, setPreviewMode] = useState<"edit" | "preview" | "split">("edit");
  const [showVarHints, setShowVarHints] = useState(false);

  const charCount = value.length;
  const lineCount = value ? value.split("\n").length : 0;

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between" }}>
        <span style={{ fontSize: 12, fontWeight: 600, color: "var(--text-secondary)" }}>
          Runbook for &ldquo;{stateLabel}&rdquo;
        </span>
        <div style={{ display: "flex", gap: 2 }}>
          {(["edit", "preview", "split"] as const).map((mode) => (
            <button
              key={mode}
              type="button"
              onClick={() => setPreviewMode(mode)}
              style={{
                fontSize: 10, padding: "2px 8px", borderRadius: 3,
                border: "1px solid var(--border-color)", cursor: "pointer",
                background: previewMode === mode ? "var(--accent-blue)" : "var(--bg-primary)",
                color: previewMode === mode ? "white" : "var(--text-secondary)",
              }}
            >
              {mode === "edit" ? "Edit" : mode === "preview" ? "Preview" : "Split"}
            </button>
          ))}
        </div>
      </div>

      {/* Editor / Preview area */}
      <div style={{
        display: "flex", gap: 8,
        minHeight: previewMode === "preview" ? undefined : 160,
      }}>
        {/* Textarea */}
        {previewMode !== "preview" && (
          <textarea
            value={value}
            onChange={(e) => onChange(e.target.value)}
            placeholder={RUNBOOK_PLACEHOLDER}
            rows={8}
            style={{
              flex: 1, fontSize: 12, padding: "8px 10px", lineHeight: 1.6,
              background: "var(--bg-primary)", border: "1px solid var(--border-color)",
              borderRadius: 4, color: "var(--text-primary)", resize: "vertical",
              fontFamily: "inherit", minHeight: 160,
            }}
          />
        )}

        {/* Markdown preview */}
        {previewMode !== "edit" && (
          <div style={{
            flex: 1, padding: "8px 10px", fontSize: 12, lineHeight: 1.6,
            background: "var(--bg-primary)", border: "1px solid var(--border-color)",
            borderRadius: 4, overflowY: "auto", minHeight: 160, maxHeight: 300,
          }}>
            {value ? (
              <MarkdownText>{value}</MarkdownText>
            ) : (
              <span style={{ color: "var(--text-muted)", fontStyle: "italic" }}>
                No instructions yet. Write markdown in the editor.
              </span>
            )}
          </div>
        )}
      </div>

      {/* Footer: guidance + variable hints */}
      <div style={{ display: "flex", alignItems: "flex-start", justifyContent: "space-between", gap: 8 }}>
        <div style={{ fontSize: 10, color: "var(--text-muted)" }}>
          <span style={{ fontStyle: "italic" }}>
            Recommended: 3-8 numbered steps per state.
          </span>
          {" "}
          <span>{charCount} chars, {lineCount} line{lineCount !== 1 ? "s" : ""}</span>
        </div>
        <button
          type="button"
          onClick={() => setShowVarHints(!showVarHints)}
          style={{
            fontSize: 10, color: "var(--accent-blue)", background: "none",
            border: "none", cursor: "pointer", textDecoration: "underline", padding: 0,
            flexShrink: 0,
          }}
        >
          {showVarHints ? "Hide variables" : "Show variables"}
        </button>
      </div>

      {/* Variable hints */}
      {showVarHints && (
        <div style={{
          padding: "6px 10px", background: "var(--bg-tertiary)",
          border: "1px solid var(--border-color)", borderRadius: 4,
          display: "flex", flexWrap: "wrap", gap: 8,
        }}>
          {RUNBOOK_VARIABLES.map((v) => (
            <span key={v.name} style={{ fontSize: 10, color: "var(--text-secondary)" }}>
              <code style={{ color: "var(--accent-blue)", fontSize: 10 }}>{v.name}</code>
              {" — "}{v.desc}
            </span>
          ))}
        </div>
      )}

      {/* Route-to agent dropdown */}
      {agents && agents.length > 0 && (
        <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
          <span style={{ fontSize: 11, color: "var(--text-secondary)", flexShrink: 0 }}>
            Route to agent:
          </span>
          <Select
            size="xs"
            placeholder="Auto (any available)"
            data={agents.map((a) => ({ value: a.id, label: a.name }))}
            value={routeTo || null}
            onChange={(v) => onRouteToChange(v || undefined)}
            clearable
            styles={{
              input: { background: "var(--bg-primary)", borderColor: "var(--border-color)", color: "var(--text-primary)", minHeight: 28, fontSize: 11 },
              dropdown: { backgroundColor: "var(--bg-secondary)", borderColor: "var(--border-color)" },
              option: { color: "var(--text-primary)", fontSize: 11 },
            }}
            style={{ flex: 1, maxWidth: 200 }}
          />
        </div>
      )}

      <span style={{ fontSize: 10, color: "var(--text-muted)", fontStyle: "italic" }}>
        This runbook is included in every agent&apos;s prompt so they know what to do in this state.
      </span>
    </div>
  );
}

/* ─── Transition Configurator (expandable panel) ─────── */

function TransitionConfigurator({ state, stateIndex, allStates, onUpdate, agents }: {
  state: WorkflowState; stateIndex: number; allStates: WorkflowState[];
  onUpdate: (u: Partial<WorkflowState>) => void;
  agents?: AgentOption[];
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

      {/* Runbook Editor — instructions for agents */}
      <RunbookEditor
        value={state.instructions || ""}
        onChange={(v) => onUpdate({ instructions: v })}
        stateLabel={state.label}
        routeTo={(state as any).routeTo}
        onRouteToChange={(v) => onUpdate({ routeTo: v } as any)}
        agents={agents}
      />
    </div>
  );
}

/* ─── Main Editor ─────────────────────────────────────── */

export function WorkflowStateEditor({ states, onChange, compact, agents }: WorkflowStateEditorProps) {
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
                  <TransitionConfigurator state={state} stateIndex={i} allStates={states} onUpdate={(u) => updateState(i, u)} agents={agents} />
                )}
              </div>
            ))}
          </div>
        </SortableContext>
      </DndContext>

      {/* Pipeline preview */}
      <div style={{ fontSize: 11, color: "var(--text-muted)", marginTop: 8 }}>
      </div>

      {/* Visual pipeline flow */}
      <PipelinePreview states={states} />

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
