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
    description: "3 states \u2014 quick prototyping",
    icon: "\u26A1",
    states: autoGenerateTransitions([
      { id: "todo", label: "To Do", color: "#6b7280", category: "not-started", instructions: "Task is waiting to be started." },
      { id: "in-progress", label: "In Progress", color: "#3b82f6", category: "active", instructions: "Actively being worked on. Write code, tests, and documentation." },
      { id: "done", label: "Done", color: "#22c55e", category: "closed", instructions: "Task is complete. All work finished and verified." },
    ]),
  },
  {
    id: "standard",
    name: "Standard",
    description: "4 states \u2014 most sessions",
    icon: "\uD83D\uDCCB",
    states: autoGenerateTransitions([
      { id: "pending", label: "Pending", color: "#6b7280", category: "not-started", instructions: "Task is in the backlog, waiting to be picked up." },
      { id: "in-progress", label: "In Progress", color: "#3b82f6", category: "active", instructions: "Actively being implemented. Write code and unit tests. Move to Review when implementation is ready." },
      { id: "review", label: "Review", color: "#f59e0b", category: "active", instructions: "Code review \u2014 check for bugs, style issues, test coverage, and architectural concerns. Move to Done if approved, or back to In Progress if changes are needed." },
      { id: "done", label: "Done", color: "#22c55e", category: "closed", instructions: "Task is complete. Code reviewed and approved." },
    ]),
  },
  {
    id: "full",
    name: "Full Pipeline",
    description: "6 states \u2014 with testing & staging",
    icon: "\uD83D\uDE80",
    states: autoGenerateTransitions([
      { id: "backlog", label: "Backlog", color: "#6b7280", category: "not-started", instructions: "Task is in the backlog, not yet scheduled for work." },
      { id: "in-progress", label: "In Progress", color: "#3b82f6", category: "active", instructions: "Actively being implemented. Write code and unit tests." },
      { id: "review", label: "Review", color: "#f59e0b", category: "active", instructions: "Code review \u2014 check for bugs, style, test coverage, and architecture. Approve or request changes." },
      { id: "e2e-testing", label: "E2E Testing", color: "#8b5cf6", category: "active", skippable: true, instructions: "Run end-to-end and integration tests. Verify the feature works across the full stack. Move back to In Progress if tests fail." },
      { id: "staging", label: "Staging", color: "#06b6d4", category: "active", skippable: true, instructions: "Deploy to the staging environment. Verify the feature works in a production-like setting. Run smoke tests and check for regressions." },
      { id: "done", label: "Done", color: "#22c55e", category: "closed", instructions: "Task is complete. Code reviewed, tested, and deployed." },
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
