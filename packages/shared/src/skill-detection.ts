/**
 * Agent skill auto-detection from persona text and agent name.
 *
 * Skills are flat string tags like ["frontend", "backend", "testing"].
 * Detection uses keyword matching against persona text, with fallback
 * to name inference (e.g. agent named "Tester" gets ["testing"]).
 */

/** Keyword map: skill -> keywords that indicate this skill in persona text */
const SKILL_KEYWORDS: Record<string, string[]> = {
  frontend: ["react", "css", "html", "dashboard", "ui", "ux", "component", "mantine", "tailwind", "vite", "browser", "dom", "tsx", "jsx", "svelte", "vue", "angular", "next.js", "styling"],
  backend: ["api", "express", "node", "server", "database", "sqlite", "sql", "rest", "endpoint", "daemon", "middleware", "route", "websocket", "auth"],
  testing: ["test", "vitest", "jest", "e2e", "coverage", "assertion", "spec", "qa", "quality", "verify", "validation"],
  devops: ["deploy", "ci", "cd", "docker", "kubernetes", "pipeline", "infrastructure", "terraform", "aws", "cloud"],
  review: ["review", "code review", "pr review", "audit", "inspect", "feedback"],
  research: ["research", "investigate", "analyze", "survey", "compare", "evaluate", "architecture", "design"],
  fullstack: ["full-stack", "fullstack", "full stack"],
};

/** Name-based skill inference: patterns in agent name -> skills */
const NAME_SKILL_MAP: Record<string, string[]> = {
  frontend: ["frontend"],
  backend: ["backend"],
  tester: ["testing"],
  test: ["testing"],
  reviewer: ["review"],
  review: ["review"],
  researcher: ["research"],
  research: ["research"],
  devops: ["devops"],
  architect: ["research", "review", "backend", "frontend"],
  dev: ["backend", "frontend"],
  engineer: ["backend", "frontend"],
  product: ["research", "review"],
  pm: ["research", "review"],
  manager: ["research", "review"],
};

/** Default skills by agent role */
const ROLE_DEFAULTS: Record<string, string[]> = {
  master: ["research", "review"],
  worker: ["backend", "frontend"],
};

/**
 * Detect skills from persona text via keyword matching.
 */
export function detectSkillsFromPersona(persona: string): string[] {
  if (!persona) return [];
  const lower = persona.toLowerCase();
  const skills = new Set<string>();

  for (const [skill, keywords] of Object.entries(SKILL_KEYWORDS)) {
    for (const kw of keywords) {
      if (lower.includes(kw)) {
        skills.add(skill);
        break;
      }
    }
  }

  return Array.from(skills);
}

/**
 * Infer skills from agent name.
 */
export function detectSkillsFromName(name: string): string[] {
  if (!name) return [];
  const lower = name.toLowerCase();
  const skills = new Set<string>();

  for (const [pattern, patternSkills] of Object.entries(NAME_SKILL_MAP)) {
    if (lower.includes(pattern)) {
      for (const s of patternSkills) skills.add(s);
    }
  }

  return Array.from(skills);
}

/**
 * Auto-detect agent skills. Priority: explicit > persona > name > role defaults.
 */
export function detectAgentSkills(opts: {
  explicit?: string[];
  persona?: string;
  name?: string;
  role?: string;
}): string[] {
  // If explicit skills provided, use them
  if (opts.explicit && opts.explicit.length > 0) return opts.explicit;

  // Try persona detection — but if persona matches too many skills (4+),
  // it's likely scanning shared context (project rules, protocol, etc.)
  // rather than role-specific content. Fall through to name-based detection.
  const personaSkills = detectSkillsFromPersona(opts.persona || "");
  if (personaSkills.length > 0 && personaSkills.length < 4) return personaSkills;

  // Try name inference
  const nameSkills = detectSkillsFromName(opts.name || "");
  if (nameSkills.length > 0) return nameSkills;

  // If persona had results but was too broad (4+), merge with name for specificity
  if (personaSkills.length >= 4) {
    // Persona was too generic — return name skills if available, else top 2 persona skills
    return personaSkills.slice(0, 2);
  }

  // Fall back to role defaults
  return ROLE_DEFAULTS[opts.role || "worker"] || ["backend", "frontend"];
}

/**
 * Check if an agent's skills match a task's labels.
 * Returns mismatched labels that the agent doesn't have skills for.
 */
export function getSkillMismatches(agentSkills: string[], taskLabels: string[]): string[] {
  const skillSet = new Set(agentSkills);
  return taskLabels.filter(label =>
    Object.keys(SKILL_KEYWORDS).includes(label) && !skillSet.has(label)
  );
}
