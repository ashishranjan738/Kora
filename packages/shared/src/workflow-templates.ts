/**
 * Pre-built pipeline templates for quick session setup.
 */

import type { WorkflowState } from "./types.js";
import { autoGenerateTransitions } from "./workflow-utils.js";

export interface PipelineTemplate {
  id: string;
  name: string;
  description: string;
  icon: string;
  states: WorkflowState[];
}

export const PIPELINE_TEMPLATES: PipelineTemplate[] = [
  {
    id: "simple",
    name: "Simple",
    description: "3 states — quick prototyping",
    icon: "\u26A1",
    states: autoGenerateTransitions([
      { id: "todo", label: "To Do", color: "#6b7280", category: "not-started" },
      { id: "in-progress", label: "In Progress", color: "#3b82f6", category: "active" },
      { id: "done", label: "Done", color: "#22c55e", category: "closed" },
    ]),
  },
  {
    id: "standard",
    name: "Standard",
    description: "4 states — most sessions",
    icon: "\uD83D\uDCCB",
    states: autoGenerateTransitions([
      { id: "pending", label: "Pending", color: "#6b7280", category: "not-started" },
      { id: "in-progress", label: "In Progress", color: "#3b82f6", category: "active" },
      { id: "review", label: "Review", color: "#f59e0b", category: "active" },
      { id: "done", label: "Done", color: "#22c55e", category: "closed" },
    ]),
  },
  {
    id: "full",
    name: "Full Pipeline",
    description: "6 states — with testing & staging",
    icon: "\uD83D\uDE80",
    states: autoGenerateTransitions([
      { id: "backlog", label: "Backlog", color: "#6b7280", category: "not-started" },
      { id: "in-progress", label: "In Progress", color: "#3b82f6", category: "active" },
      { id: "review", label: "Review", color: "#f59e0b", category: "active" },
      { id: "e2e-testing", label: "E2E Testing", color: "#8b5cf6", category: "active", skippable: true },
      { id: "staging", label: "Staging", color: "#06b6d4", category: "active", skippable: true },
      { id: "done", label: "Done", color: "#22c55e", category: "closed" },
    ]),
  },
  {
    id: "custom",
    name: "Custom",
    description: "Start from scratch",
    icon: "\u270F\uFE0F",
    states: [],
  },
];

export function getPipelineTemplate(id: string): PipelineTemplate {
  return PIPELINE_TEMPLATES.find(t => t.id === id) ?? PIPELINE_TEMPLATES[1];
}
