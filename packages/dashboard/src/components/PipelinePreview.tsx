/**
 * PipelinePreview — visual flow diagram using React Flow.
 * Shows workflow states as nodes and transitions as edges.
 */
import { useMemo } from "react";
import {
  ReactFlow,
  Background,
  type Node,
  type Edge,
  Position,
  MarkerType,
} from "@xyflow/react";
import "@xyflow/react/dist/style.css";
import type { WorkflowState } from "@kora/shared";

interface PipelinePreviewProps {
  states: WorkflowState[];
}

export function PipelinePreview({ states }: PipelinePreviewProps) {
  const { nodes, edges } = useMemo(() => {
    if (states.length === 0) return { nodes: [], edges: [] };

    const X_GAP = 200;
    const Y_BASE = 50;

    const nodes: Node[] = states.map((state, i) => ({
      id: state.id,
      position: { x: i * X_GAP, y: Y_BASE },
      data: {
        label: (
          <div style={{ textAlign: "center" }}>
            <div style={{ fontWeight: 700, fontSize: 13 }}>{state.label}</div>
            {state.skippable && (
              <div style={{ fontSize: 9, opacity: 0.6, marginTop: 1 }}>skippable</div>
            )}
          </div>
        ),
      },
      style: {
        background: `${state.color}22`,
        border: `2px solid ${state.color}`,
        borderRadius: 8,
        padding: "6px 12px",
        fontSize: 12,
        color: "var(--text-primary, #e6edf3)",
        minWidth: 80,
      },
      sourcePosition: Position.Right,
      targetPosition: Position.Left,
      draggable: false,
      connectable: false,
    }));

    const edges: Edge[] = [];
    const edgeSet = new Set<string>();

    states.forEach((state, i) => {
      if (!state.transitions?.length) return;
      state.transitions.forEach(targetId => {
        const targetIdx = states.findIndex(s => s.id === targetId);
        if (targetIdx < 0) return;
        const key = `${state.id}-${targetId}`;
        if (edgeSet.has(key)) return;
        edgeSet.add(key);

        const isForward = targetIdx === i + 1;
        const isSkip = targetIdx > i + 1;
        const isBackward = targetIdx < i;

        edges.push({
          id: key,
          source: state.id,
          target: targetId,
          type: isForward ? "straight" : "smoothstep",
          animated: isSkip,
          style: {
            stroke: isBackward ? "#d29922" : isSkip ? "#bc8cff" : "#8b949e",
            strokeWidth: isForward ? 2 : 1.5,
            strokeDasharray: isBackward ? "5,3" : undefined,
          },
          markerEnd: {
            type: MarkerType.ArrowClosed,
            color: isBackward ? "#d29922" : isSkip ? "#bc8cff" : "#8b949e",
            width: 16,
            height: 16,
          },
          label: isSkip ? "skip" : isBackward ? "rework" : undefined,
          labelStyle: {
            fontSize: 9,
            fill: isBackward ? "#d29922" : "#bc8cff",
          },
          labelBgStyle: {
            fill: "var(--bg-primary, #0d1117)",
            fillOpacity: 0.9,
          },
        });
      });
    });

    return { nodes, edges };
  }, [states]);

  if (states.length === 0) return null;

  const width = states.length * 200 + 50;
  const height = 160;

  return (
    <div style={{
      marginTop: 8,
      height,
      border: "1px solid var(--border-color)",
      borderRadius: 8,
      overflow: "hidden",
      background: "var(--bg-primary)",
    }}>
      <ReactFlow
        nodes={nodes}
        edges={edges}
        fitView
        fitViewOptions={{ padding: 0.3 }}
        nodesDraggable={false}
        nodesConnectable={false}
        elementsSelectable={false}
        panOnDrag={true}
        zoomOnScroll={false}
        zoomOnPinch={true}
        preventScrolling={false}
        proOptions={{ hideAttribution: true }}
        style={{ background: "transparent" }}
      >
        <Background color="var(--border-color)" gap={20} size={1} style={{ opacity: 0.3 }} />
      </ReactFlow>
    </div>
  );
}
