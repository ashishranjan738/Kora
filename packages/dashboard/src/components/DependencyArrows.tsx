/**
 * DependencyArrows — SVG overlay drawing arrows between dependent task cards.
 * Red arrows for incomplete blockers, green for completed ones.
 * Click an arrow to remove the dependency.
 */
import { useCallback, useEffect, useState } from "react";

interface Task {
  id: string;
  title: string;
  status: string;
  dependencies?: string[];
}

interface Arrow {
  fromId: string;
  toId: string;
  fromRect: DOMRect;
  toRect: DOMRect;
  isComplete: boolean;
  fromTitle: string;
  toTitle: string;
}

interface DependencyArrowsProps {
  tasks: Task[];
  containerRef: React.RefObject<HTMLElement | null>;
  closedStatuses: Set<string>;
  onRemoveDependency?: (taskId: string, depId: string) => void;
}

export function DependencyArrows({ tasks, containerRef, closedStatuses, onRemoveDependency }: DependencyArrowsProps) {
  const [arrows, setArrows] = useState<Arrow[]>([]);
  const [hoveredArrow, setHoveredArrow] = useState<string | null>(null);

  const computeArrows = useCallback(() => {
    if (!containerRef.current) return;
    const container = containerRef.current;
    const containerRect = container.getBoundingClientRect();
    const newArrows: Arrow[] = [];

    for (const task of tasks) {
      if (!task.dependencies || task.dependencies.length === 0) continue;
      const toEl = container.querySelector(`[data-task-id="${task.id}"]`);
      if (!toEl) continue;
      const toRect = toEl.getBoundingClientRect();

      for (const depId of task.dependencies) {
        const depTask = tasks.find((t) => t.id === depId);
        if (!depTask) continue;
        const fromEl = container.querySelector(`[data-task-id="${depId}"]`);
        if (!fromEl) continue;
        const fromRect = fromEl.getBoundingClientRect();

        newArrows.push({
          fromId: depId,
          toId: task.id,
          fromRect: new DOMRect(
            fromRect.x - containerRect.x,
            fromRect.y - containerRect.y,
            fromRect.width,
            fromRect.height
          ),
          toRect: new DOMRect(
            toRect.x - containerRect.x,
            toRect.y - containerRect.y,
            toRect.width,
            toRect.height
          ),
          isComplete: closedStatuses.has(depTask.status),
          fromTitle: depTask.title,
          toTitle: task.title,
        });
      }
    }

    setArrows(newArrows);
  }, [tasks, containerRef, closedStatuses]);

  // Recompute on task changes and periodically (cards may move)
  useEffect(() => {
    computeArrows();
    const interval = setInterval(computeArrows, 1000);
    return () => clearInterval(interval);
  }, [computeArrows]);

  if (arrows.length === 0) return null;

  return (
    <svg
      style={{
        position: "absolute",
        top: 0,
        left: 0,
        width: "100%",
        height: "100%",
        pointerEvents: "none",
        zIndex: 5,
        overflow: "visible",
      }}
    >
      <defs>
        <marker id="arrow-red" viewBox="0 0 10 7" refX="10" refY="3.5" markerWidth="8" markerHeight="6" orient="auto-start-reverse">
          <polygon points="0 0, 10 3.5, 0 7" fill="var(--accent-red, #ef4444)" />
        </marker>
        <marker id="arrow-green" viewBox="0 0 10 7" refX="10" refY="3.5" markerWidth="8" markerHeight="6" orient="auto-start-reverse">
          <polygon points="0 0, 10 3.5, 0 7" fill="var(--accent-green, #22c55e)" />
        </marker>
      </defs>
      {arrows.map((arrow) => {
        const key = `${arrow.fromId}->${arrow.toId}`;
        const isHovered = hoveredArrow === key;
        const color = arrow.isComplete ? "var(--accent-green, #22c55e)" : "var(--accent-red, #ef4444)";
        const markerId = arrow.isComplete ? "arrow-green" : "arrow-red";

        // Calculate connection points: right side of source → left side of target
        const fromX = arrow.fromRect.x + arrow.fromRect.width;
        const fromY = arrow.fromRect.y + arrow.fromRect.height / 2;
        const toX = arrow.toRect.x;
        const toY = arrow.toRect.y + arrow.toRect.height / 2;

        // If same column (toX < fromX), route below
        const dx = toX - fromX;
        const cpOffset = Math.max(Math.abs(dx) * 0.4, 40);

        const path = `M ${fromX} ${fromY} C ${fromX + cpOffset} ${fromY}, ${toX - cpOffset} ${toY}, ${toX} ${toY}`;

        return (
          <g key={key}>
            {/* Invisible wider path for easier clicking */}
            <path
              d={path}
              fill="none"
              stroke="transparent"
              strokeWidth={16}
              style={{ pointerEvents: "stroke", cursor: "pointer" }}
              onMouseEnter={() => setHoveredArrow(key)}
              onMouseLeave={() => setHoveredArrow(null)}
              onClick={() => onRemoveDependency?.(arrow.toId, arrow.fromId)}
            />
            {/* Visible arrow */}
            <path
              d={path}
              fill="none"
              stroke={color}
              strokeWidth={isHovered ? 3 : 2}
              strokeDasharray={arrow.isComplete ? "none" : "6 3"}
              opacity={isHovered ? 1 : 0.6}
              markerEnd={`url(#${markerId})`}
              style={{ transition: "opacity 0.15s, stroke-width 0.15s" }}
            />
            {/* Tooltip on hover */}
            {isHovered && (
              <g>
                <rect
                  x={(fromX + toX) / 2 - 80}
                  y={(fromY + toY) / 2 - 24}
                  width={160}
                  height={22}
                  rx={4}
                  fill="var(--bg-secondary, #1a1a1a)"
                  stroke="var(--border-color, #333)"
                  strokeWidth={1}
                />
                <text
                  x={(fromX + toX) / 2}
                  y={(fromY + toY) / 2 - 10}
                  textAnchor="middle"
                  fill="var(--text-secondary, #999)"
                  fontSize={10}
                  style={{ pointerEvents: "none" }}
                >
                  {arrow.isComplete ? "✓ Complete" : "⏳ Blocking"} — click to remove
                </text>
              </g>
            )}
          </g>
        );
      })}
    </svg>
  );
}
