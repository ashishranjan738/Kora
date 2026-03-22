/** Shared workload utilities used by WorkloadChart and AgentLoadBadge */

/** Returns a CSS color based on load percentage: green (<70%), yellow (70-100%), red (>100%) */
export function getLoadColor(pct: number): string {
  if (pct > 100) return "var(--accent-red, #f85149)";
  if (pct >= 70) return "var(--accent-yellow, #d29922)";
  return "var(--accent-green, #3fb950)";
}
