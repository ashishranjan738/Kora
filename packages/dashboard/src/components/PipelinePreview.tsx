/**
 * PipelinePreview — visual flow diagram using React Flow.
 * Shows workflow states as nodes and transitions as edges.
 * Skip edges arc above, rework edges arc below, forward edges go straight.
 */
import { useMemo, useCallback, type CSSProperties } from "react";
import {
  ReactFlow,
  Background,
  Handle,
  type Node,
  type Edge,
  type NodeProps,
  Position,
  MarkerType,
} from "@xyflow/react";
import "@xyflow/react/dist/style.css";
import type { WorkflowState } from "@kora/shared";

/* ------------------------------------------------------------------ */
/*  Custom node with 4 handles (top, bottom, left, right)             */
/* ------------------------------------------------------------------ */

const HANDLE_STYLE: CSSProperties = {
  width: 6,
  height: 6,
  background: "transparent",
  border: "none",
};

function PipelineNode({ data }: NodeProps) {
  return (
    <>
      <Handle type="target" position={Position.Left} id="left" style={HANDLE_STYLE} />
      <Handle type="target" position={Position.Top} id="top" style={HANDLE_STYLE} />
      <Handle type="target" position={Position.Bottom} id="bottom" style={HANDLE_STYLE} />
      <Handle type="source" position={Position.Right} id="right" style={HANDLE_STYLE} />
      <Handle type="source" position={Position.Top} id="top-src" style={HANDLE_STYLE} />
      <Handle type="source" position={Position.Bottom} id="bottom-src" style={HANDLE_STYLE} />
      {data.label}
    </>
  );
}

const nodeTypes = { pipeline: PipelineNode };

/* ------------------------------------------------------------------ */
/*  Component                                                          */
/* ------------------------------------------------------------------ */

interface PipelinePreviewProps {
  states: WorkflowState[];
}

export function PipelinePreview({ states }: PipelinePreviewProps) {
  const { nodes, edges } = useMemo(() => {
    if (states.length === 0) return { nodes: [], edges: [] };

    const X_GAP = 200;
    const Y_BASE = 80;

    const nodes: Node[] = states.map((state, i) => ({
      id: state.id,
      type: "pipeline",
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

        if (isForward) {
          edges.push({
            id: key,
            source: state.id,
            sourceHandle: "right",
            target: targetId,
            targetHandle: "left",
            type: "straight",
            style: { stroke: "#8b949e", strokeWidth: 2 },
            markerEnd: {
              type: MarkerType.ArrowClosed,
              color: "#8b949e",
              width: 16,
              height: 16,
            },
          });
        } else if (isSkip) {
          // Skip edges: source top → target top, routed above
          edges.push({
            id: key,
            source: state.id,
            sourceHandle: "top-src",
            target: targetId,
            targetHandle: "top",
            type: "smoothstep",
            animated: true,
            style: { stroke: "#bc8cff", strokeWidth: 1.5 },
            markerEnd: {
              type: MarkerType.ArrowClosed,
              color: "#bc8cff",
              width: 14,
              height: 14,
            },
            label: "skip",
            labelStyle: { fontSize: 9, fill: "#bc8cff" },
            labelBgStyle: { fill: "var(--bg-primary, #0d1117)", fillOpacity: 0.9 },
          });
        } else if (isBackward) {
          // Backward edges: source bottom → target bottom, routed below
          edges.push({
            id: key,
            source: state.id,
            sourceHandle: "bottom-src",
            target: targetId,
            targetHandle: "bottom",
            type: "smoothstep",
            style: {
              stroke: "#d29922",
              strokeWidth: 1.5,
              strokeDasharray: "5,3",
            },
            markerEnd: {
              type: MarkerType.ArrowClosed,
              color: "#d29922",
              width: 14,
              height: 14,
            },
            label: "rework",
            labelStyle: { fontSize: 9, fill: "#d29922" },
            labelBgStyle: { fill: "var(--bg-primary, #0d1117)", fillOpacity: 0.9 },
          });
        }
      });
    });

    return { nodes, edges };
  }, [states]);

  if (states.length === 0) return null;

  // Taller to accommodate skip arcs above and rework arcs below
  const height = 240;

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
        nodeTypes={nodeTypes}
        fitView
        fitViewOptions={{ padding: 0.35 }}
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
