/**
 * AgentTopology — visual graph of agent relationships using React Flow.
 * Shows master → worker hierarchy with status colors.
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

interface Agent {
  id: string;
  config?: { name?: string; role?: string; cliProvider?: string; model?: string };
  name?: string;
  role?: string;
  status?: string;
  activity?: string;
  cost?: { totalCostUsd?: number };
}

interface AgentTopologyProps {
  agents: Agent[];
  onAgentClick?: (agentId: string) => void;
}

const STATUS_COLORS: Record<string, string> = {
  running: "#3fb950",
  idle: "#d29922",
  crashed: "#f85149",
  error: "#f85149",
  stopped: "#8b949e",
};

const ROLE_COLORS: Record<string, string> = {
  master: "#bc8cff",
  worker: "#58a6ff",
};

export function AgentTopology({ agents, onAgentClick }: AgentTopologyProps) {
  const { nodes, edges } = useMemo(() => {
    if (agents.length === 0) return { nodes: [], edges: [] };

    const masters = agents.filter(a => (a.config?.role || a.role) === "master");
    const workers = agents.filter(a => (a.config?.role || a.role) !== "master");

    const X_CENTER = 300;
    const Y_MASTER = 30;
    const Y_WORKER = 160;
    const WORKER_GAP = 180;

    const nodes: Node[] = [];
    const edges: Edge[] = [];

    // Position masters at top center
    masters.forEach((agent, i) => {
      const name = agent.config?.name || agent.name || agent.id;
      const status = agent.status || "unknown";
      const activity = agent.activity || "";
      const isIdle = activity === "idle";
      const statusColor = STATUS_COLORS[status] || "#8b949e";

      nodes.push({
        id: agent.id,
        position: { x: X_CENTER + i * 220 - (masters.length - 1) * 110, y: Y_MASTER },
        data: {
          label: (
            <div style={{ textAlign: "center" }}>
              <div style={{ fontWeight: 700, fontSize: 13 }}>{name}</div>
              <div style={{ fontSize: 10, opacity: 0.7, marginTop: 2 }}>
                {isIdle ? "idle" : status}
              </div>
            </div>
          ),
        },
        style: {
          background: `${ROLE_COLORS.master}18`,
          border: `2px solid ${statusColor}`,
          borderRadius: 10,
          padding: "8px 16px",
          color: "var(--text-primary, #e6edf3)",
          minWidth: 120,
        },
        sourcePosition: Position.Bottom,
        targetPosition: Position.Top,
        draggable: true,
        connectable: false,
      });
    });

    // Position workers in a row below
    const workerStartX = X_CENTER - ((workers.length - 1) * WORKER_GAP) / 2;
    workers.forEach((agent, i) => {
      const name = agent.config?.name || agent.name || agent.id;
      const status = agent.status || "unknown";
      const activity = agent.activity || "";
      const isIdle = activity === "idle";
      const statusColor = STATUS_COLORS[status] || "#8b949e";

      nodes.push({
        id: agent.id,
        position: { x: workerStartX + i * WORKER_GAP, y: Y_WORKER },
        data: {
          label: (
            <div style={{ textAlign: "center" }}>
              <div style={{ fontWeight: 600, fontSize: 12 }}>{name}</div>
              <div style={{ fontSize: 10, opacity: 0.7, marginTop: 2 }}>
                {isIdle ? "idle" : status}
              </div>
            </div>
          ),
        },
        style: {
          background: `${ROLE_COLORS.worker}18`,
          border: `2px solid ${statusColor}`,
          borderRadius: 10,
          padding: "6px 14px",
          color: "var(--text-primary, #e6edf3)",
          minWidth: 100,
        },
        sourcePosition: Position.Top,
        targetPosition: Position.Top,
        draggable: true,
        connectable: false,
      });

      // Edge from each master to each worker
      masters.forEach(master => {
        edges.push({
          id: `${master.id}-${agent.id}`,
          source: master.id,
          target: agent.id,
          type: "smoothstep",
          style: { stroke: "#8b949e", strokeWidth: 1.5 },
          markerEnd: { type: MarkerType.ArrowClosed, color: "#8b949e", width: 14, height: 14 },
          animated: status === "running" && !isIdle,
        });
      });
    });

    // If no masters, just lay agents in a row
    if (masters.length === 0) {
      agents.forEach((agent, i) => {
        const existing = nodes.find(n => n.id === agent.id);
        if (existing) {
          existing.position = { x: 50 + i * WORKER_GAP, y: 50 };
        }
      });
    }

    return { nodes, edges };
  }, [agents]);

  if (agents.length === 0) return null;

  const height = agents.some(a => (a.config?.role || a.role) === "master") ? 280 : 150;

  return (
    <div style={{
      height,
      border: "1px solid var(--border-color)",
      borderRadius: 8,
      overflow: "hidden",
      background: "var(--bg-secondary)",
      marginBottom: 16,
    }}>
      <ReactFlow
        nodes={nodes}
        edges={edges}
        fitView
        fitViewOptions={{ padding: 0.3 }}
        nodesConnectable={false}
        elementsSelectable={true}
        panOnDrag={true}
        zoomOnScroll={false}
        zoomOnPinch={true}
        preventScrolling={false}
        onNodeClick={(_, node) => onAgentClick?.(node.id)}
        proOptions={{ hideAttribution: true }}
        style={{ background: "transparent" }}
      >
        <Background color="var(--border-color)" gap={24} size={1} style={{ opacity: 0.2 }} />
      </ReactFlow>
    </div>
  );
}
