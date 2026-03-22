/**
 * Derive a human-readable role summary from an agent's skills array.
 * Used in Command Center headers for compact display.
 * Full skill badges remain in the hover panel for detail.
 */
export function getSkillRoleSummary(skills: string[]): string | null {
  if (!skills || skills.length === 0) return null;

  const s = new Set(skills.map(sk => sk.toLowerCase()));

  // Specific combinations first
  if (s.has("fullstack") || (s.has("frontend") && s.has("backend"))) return "Full-stack Dev";
  if (s.has("testing") && s.size === 1) return "Test Specialist";
  if (s.has("review") && s.size === 1) return "Code Reviewer";
  if (s.has("research") && s.size === 1) return "Researcher";
  if (s.has("devops") && s.size === 1) return "DevOps Engineer";
  if (s.has("frontend") && s.size === 1) return "UI Developer";
  if (s.has("backend") && s.size === 1) return "Backend Dev";

  // Multi-skill combinations
  if (s.has("testing") && s.has("review")) return "QA & Review";
  if (s.has("research") && s.has("review")) return "Architect";
  if (s.has("frontend") && s.has("testing")) return "Frontend + Testing";
  if (s.has("backend") && s.has("testing")) return "Backend + Testing";

  // Fallback: if many skills, likely a generalist
  if (s.size >= 4) return "Generalist";
  if (s.size >= 2) {
    // Pick the most distinctive skill
    const priority = ["testing", "review", "research", "devops", "frontend", "backend"];
    for (const p of priority) {
      if (s.has(p)) {
        const label: Record<string, string> = {
          testing: "Test Specialist",
          review: "Code Reviewer",
          research: "Researcher",
          devops: "DevOps Engineer",
          frontend: "UI Developer",
          backend: "Backend Dev",
        };
        return label[p] || null;
      }
    }
  }

  return null;
}
